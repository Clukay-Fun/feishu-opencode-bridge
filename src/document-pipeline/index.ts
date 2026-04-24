/**
 * 职责: 提供统一的“文件 -> Markdown / 纯文本 / sections”解析入口。
 * 关注点:
 * - 收口 PDF、DOCX、TXT/MD、HTML 等常见文件的文本提取路径。
 * - 统一返回工具、质量、fallback 链路与告警信息。
 * - 为知识库、合同材料和证据抽取复用同一套解析结果模型。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnPythonTool } from "../utils/python-tool.js";
import {
  decodePlainTextBuffer,
  normalizeExtension,
  normalizePageText,
  normalizePlainMarkdown,
  normalizeSectionsFromMarkdown,
  type ParsedDocumentSection,
} from "./normalize.js";

export type { ParsedDocumentSection } from "./normalize.js";

export type DocumentParserUsed =
  | "plain-text"
  | "html-text"
  | "doc-to-text"
  | "mammoth"
  | "pymupdf4llm"
  | "docling"
  | "pdf-parse"
  | "mineru-agent"
  | "paddleocr-vl"
  | "tesseract";

export type DocumentParseQuality = "high" | "medium" | "low";

export type ParsedDocument = {
  markdown: string;
  plainText: string;
  sourceFormat: string;
  parserUsed: DocumentParserUsed;
  quality: DocumentParseQuality;
  fallbackChain: string[];
  warnings: string[];
  sections: ParsedDocumentSection[];
};

type PythonDocumentParseResult = {
  markdown?: string;
  plainText?: string;
  sourceFormat?: string;
  tool?: "doc-to-text" | "pymupdf4llm" | "docling" | "mineru-agent" | "paddleocr-vl" | "tesseract";
  quality?: DocumentParseQuality;
  fallbackChain?: string[];
  warnings?: string[];
};

export type DocumentParserProvider =
  | "mineru-agent"
  | "paddleocr-vl"
  | "pymupdf4llm"
  | "docling"
  | "pdf-parse"
  | "tesseract";

export type DocumentParserOptions = {
  externalApiEnabled?: boolean | undefined;
  pdfProviderOrder?: DocumentParserProvider[] | undefined;
  imageProviderOrder?: DocumentParserProvider[] | undefined;
  ocrLang?: string | undefined;
  timeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  maxPollMs?: number | undefined;
  mineru?: {
    enabled?: boolean | undefined;
    endpoint?: string | undefined;
  } | undefined;
  paddleocr?: {
    enabled?: boolean | undefined;
    apiKey?: string | undefined;
    secretKey?: string | undefined;
  } | undefined;
};

/** 解析一个常见文档文件，并产出统一中间结果。 */
export async function parseDocument(fileName: string, buffer: Buffer, options?: DocumentParserOptions): Promise<ParsedDocument> {
  const extension = normalizeExtension(fileName);

  if (extension === ".txt" || extension === ".md") {
    return buildParsedDocument({
      markdown: normalizePlainMarkdown(decodePlainTextBuffer(buffer)),
      plainText: normalizePlainMarkdown(decodePlainTextBuffer(buffer)),
      sourceFormat: extension.slice(1),
      parserUsed: "plain-text",
      quality: "high",
      fallbackChain: ["plain-text"],
      sectionPrefix: "文本",
    });
  }

  if (extension === ".html" || extension === ".htm") {
    const text = normalizePlainMarkdown(extractHtmlText(decodePlainTextBuffer(buffer)));
    return buildParsedDocument({
      markdown: text,
      plainText: text,
      sourceFormat: "html",
      parserUsed: "html-text",
      quality: text.length > 80 ? "medium" : "low",
      fallbackChain: ["html-text"],
      sectionPrefix: "HTML",
    });
  }

  if ([".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const pythonParsed = await parseWithPython(fileName, buffer, options).catch((error) => {
      if (extension === ".pdf" || extension === ".docx") {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    });

    if (pythonParsed && "parsed" in pythonParsed) {
      return pythonParsed.parsed;
    }

    if (extension === ".docx") {
      const fallback = await parseDocxWithMammoth(buffer);
      return {
        ...fallback,
        fallbackChain: ["convert_document", ...fallback.fallbackChain],
        warnings: combineWarnings(pythonParsed?.error, fallback.warnings),
      };
    }

    if (extension === ".pdf") {
      const fallback = await parsePdfWithPdfParse(buffer);
      return {
        ...fallback,
        fallbackChain: ["convert_document", ...fallback.fallbackChain],
        warnings: combineWarnings(pythonParsed?.error, fallback.warnings),
      };
    }
  }

  throw new Error(`暂不支持的文件格式：${extension || "unknown"}`);
}

async function parseWithPython(fileName: string, buffer: Buffer, options?: DocumentParserOptions): Promise<{ parsed: ParsedDocument }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "bridge-document-pipeline-"));
  const inputPath = path.join(tempDir, sanitizeFileName(fileName));
  try {
    await writeFile(inputPath, buffer);
    const result = await spawnPythonTool<PythonDocumentParseResult>("convert_document", {
      inputPath,
      ...(options ? { parser: options } : {}),
      ...(options?.ocrLang ? { ocrLang: options.ocrLang } : {}),
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const sourceFormat = result.data.sourceFormat?.trim() || normalizeExtension(fileName).slice(1) || "unknown";
    const markdown = normalizePlainMarkdown(result.data.markdown ?? result.data.plainText ?? "");
    const plainText = normalizePlainMarkdown(result.data.plainText ?? result.data.markdown ?? "");
    if (!markdown && !plainText) {
      throw new Error("统一文档转换未生成可用内容");
    }
    const parserUsed = result.data.tool ?? "plain-text";
    return {
      parsed: buildParsedDocument({
        markdown: markdown || plainText,
        plainText: plainText || markdown,
        sourceFormat,
        parserUsed,
        quality: result.data.quality ?? inferQuality(plainText || markdown),
        fallbackChain: result.data.fallbackChain?.length ? result.data.fallbackChain : [parserUsed],
        warnings: result.data.warnings ?? [],
        sectionPrefix: detectSectionPrefix(sourceFormat),
      }),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function parseDocxWithMammoth(buffer: Buffer): Promise<ParsedDocument> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  const normalized = normalizePlainMarkdown(result.value);
  return buildParsedDocument({
    markdown: normalized,
    plainText: normalized,
    sourceFormat: "docx",
    parserUsed: "mammoth",
    quality: inferQuality(normalized),
    fallbackChain: ["mammoth"],
    sectionPrefix: "段落",
  });
}

async function parsePdfWithPdfParse(buffer: Buffer): Promise<ParsedDocument> {
  const pdfModule = await import("pdf-parse");
  const parser = new pdfModule.PDFParse({ data: buffer });
  const result = await parser.getText({});
  await parser.destroy().catch(() => undefined);
  const pages = result.pages.map((page) => normalizePageText(page.text)).filter(Boolean);
  const markdown = pages.join("\n\n---\n\n");
  const plainText = normalizePlainMarkdown(result.text);
  return {
    markdown,
    plainText,
    sourceFormat: "pdf",
    parserUsed: "pdf-parse",
    quality: inferQuality(plainText || markdown),
    fallbackChain: ["pdf-parse"],
    warnings: [],
    sections: pages.length > 0
      ? pages.map((text, index) => ({ location: `第 ${index + 1} 页`, text }))
      : normalizeSectionsFromMarkdown(markdown || plainText, "页"),
  };
}

function buildParsedDocument(input: {
  markdown: string;
  plainText: string;
  sourceFormat: string;
  parserUsed: DocumentParserUsed;
  quality: DocumentParseQuality;
  fallbackChain: string[];
  sectionPrefix: string;
  warnings?: string[];
}): ParsedDocument {
  const markdown = normalizePlainMarkdown(input.markdown);
  const plainText = normalizePlainMarkdown(input.plainText);
  const sectionSource = markdown || plainText;
  return {
    markdown,
    plainText,
    sourceFormat: input.sourceFormat,
    parserUsed: input.parserUsed,
    quality: input.quality,
    fallbackChain: input.fallbackChain,
    warnings: input.warnings ?? [],
    sections: normalizeSectionsFromMarkdown(sectionSource, input.sectionPrefix),
  };
}

function inferQuality(text: string): DocumentParseQuality {
  if (text.length >= 200) {
    return "high";
  }
  if (text.length >= 40) {
    return "medium";
  }
  return "low";
}

function detectSectionPrefix(sourceFormat: string): string {
  switch (sourceFormat) {
    case "pdf":
      return "段落";
    case "docx":
      return "段落";
    case "html":
      return "HTML";
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
      return "OCR";
    default:
      return "文本";
  }
}

function combineWarnings(primary: string | undefined, warnings: string[]): string[] {
  return [
    ...(primary ? [primary] : []),
    ...warnings,
  ];
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[\\/:"*?<>|]+/g, "_");
}

function extractHtmlText(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n+/g, "\n\n");
}
