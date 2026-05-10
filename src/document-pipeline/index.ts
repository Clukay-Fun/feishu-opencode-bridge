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
import * as XLSX from "xlsx";

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
  | "spreadsheet"
  | "doc-to-text"
  | "mammoth"
  | "pymupdf4llm"
  | "docling"
  | "pdf-parse"
  | "mineru-agent"
  | "paddleocr-vl"
  | "paddleocr-vl-aistudio"
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
  tool?: "doc-to-text" | "pymupdf4llm" | "docling" | "mineru-agent" | "paddleocr-vl" | "paddleocr-vl-aistudio" | "tesseract";
  quality?: DocumentParseQuality;
  fallbackChain?: string[];
  warnings?: string[];
};

export type DocumentParserProvider =
  | "mineru-agent"
  | "paddleocr-vl"
  | "paddleocr-vl-aistudio"
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
    apiKey?: string | undefined;
  } | undefined;
  paddleocr?: {
    enabled?: boolean | undefined;
    apiKey?: string | undefined;
    secretKey?: string | undefined;
  } | undefined;
  paddleocrAiStudio?: {
    enabled?: boolean | undefined;
    endpoint?: string | undefined;
    token?: string | undefined;
    useDocOrientationClassify?: boolean | undefined;
    useDocUnwarping?: boolean | undefined;
    useChartRecognition?: boolean | undefined;
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

  if ([".xls", ".xlsx", ".csv"].includes(extension)) {
    const markdown = normalizePlainMarkdown(parseSpreadsheetFile(fileName, buffer));
    return buildParsedDocument({
      markdown,
      plainText: markdown,
      sourceFormat: extension.slice(1),
      parserUsed: "spreadsheet",
      quality: markdown.length > 80 ? "high" : "medium",
      fallbackChain: ["spreadsheet"],
      sectionPrefix: "表格",
    });
  }

  if ([".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    if (extension === ".pdf" && needsNodePdfProviderOrder(options)) {
      return await parsePdfWithProviderOrder(fileName, buffer, options);
    }

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

async function parsePdfWithProviderOrder(
  fileName: string,
  buffer: Buffer,
  options: DocumentParserOptions | undefined,
): Promise<ParsedDocument> {
  const order = options?.pdfProviderOrder?.filter((provider) => provider.trim()) ?? [];
  const warnings: string[] = [];
  const attempted: string[] = [];

  for (const provider of order) {
    attempted.push(provider);
    try {
      const parsed = provider === "pdf-parse"
        ? await parsePdfWithPdfParse(buffer)
        : (await parseWithPython(fileName, buffer, {
          ...options,
          pdfProviderOrder: [provider],
        })).parsed;
      if (provider === "pdf-parse" && !parsed.plainText.trim() && !parsed.markdown.trim()) {
        throw new Error("pdf-parse produced empty text");
      }
      return {
        ...parsed,
        fallbackChain: mergeFallbackChain(attempted, parsed.fallbackChain),
        warnings: [...warnings, ...parsed.warnings],
      };
    } catch (error) {
      warnings.push(`${provider} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(warnings.join("; ") || "no parser provider available");
}

function needsNodePdfProviderOrder(options?: DocumentParserOptions): boolean {
  const order = options?.pdfProviderOrder?.filter((provider) => provider.trim()) ?? [];
  const pdfParseIndex = order.indexOf("pdf-parse");
  return pdfParseIndex >= 0 && (order.length === 1 || pdfParseIndex < order.length - 1);
}

function mergeFallbackChain(attempted: string[], fallbackChain: string[]): string[] {
  return [
    ...attempted,
    ...fallbackChain.filter((provider) => !attempted.includes(provider)),
  ];
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

function parseSpreadsheetFile(fileName: string, buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sections: string[] = [`文件：${fileName}`];
  for (const sheetName of workbook.SheetNames.slice(0, 5)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    if (rows.length === 0) {
      continue;
    }
    sections.push(`\n## 工作表：${sheetName}`);
    const previewRows = rows.slice(0, 80).map((row) => row.map((cell) => String(cell ?? "").replace(/\s+/g, " ").trim()));
    const width = Math.max(...previewRows.map((row) => row.length), 1);
    const normalized = previewRows.map((row) => Array.from({ length: width }, (_value, index) => row[index] ?? ""));
    const header = normalized[0] ?? Array.from({ length: width }, () => "");
    sections.push(`| ${header.map(escapeTableCell).join(" | ")} |`);
    sections.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of normalized.slice(1)) {
      sections.push(`| ${row.map(escapeTableCell).join(" | ")} |`);
    }
  }
  return sections.join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
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
