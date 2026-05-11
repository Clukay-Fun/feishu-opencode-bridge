/**
 * 职责: 处理证据材料的预处理与文本提取工作流。
 * 关注点:
 * - 下载附件、落盘并准备后续分析所需的临时文件。
 * - 按文件类型调用对应解析路径，统一产出可分析文本。
 * - 作为 contract-assistant 与 labor-skill 之间已经落地的 shared workflow。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

import { parseKnowledgeFile } from "../knowledge/parser.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeMessage, OpenCodeModelRef, OpenCodePromptRequest } from "../opencode/client.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import type { DocumentParserOptions } from "../document-pipeline/index.js";
import { SUPPORTED_DOCUMENT_EXTENSIONS, normalizeAllowedExtensions } from "../document-pipeline/material-support.js";

type OpenCodePort = Pick<OpenCodeClient, "createSession" | "postMessageSync" | "deleteSession">;
const DEFAULT_PARSE_TEXT_EXTENSIONS = [...SUPPORTED_DOCUMENT_EXTENSIONS];

export type EvidenceFileRef = {
  messageId: string;
  fileKey: string;
  fileName: string;
  size?: number | undefined;
  resourceType?: "file" | "image" | "folder" | undefined;
};

export type LocalEvidenceFileRef = {
  localPath: string;
  fileName?: string | undefined;
  size?: number | undefined;
};

export type BufferEvidenceFileRef = {
  buffer: Buffer;
  fileName: string;
  mimeType?: string | undefined;
  size?: number | undefined;
};

export type EvidenceExtractResourcePort = {
  downloadMessageResource(messageId: string, fileKey: string, type: "file" | "image" | "folder"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
};

export type PreparedEvidenceFile = {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  extension: string;
  localPath: string;
  extractedText: string;
};

export type EvidenceMaterialInput = EvidenceFileRef | LocalEvidenceFileRef | BufferEvidenceFileRef;

export type EvidenceExtractRequest = {
  file: EvidenceMaterialInput;
  allowedExtensions: string[];
  maxFileSizeMb: number;
  maxExtractedTextLength?: number | undefined;
  parseTextExtensions?: string[] | undefined;
  model?: OpenCodeModelRef | undefined;
  createSessionTitle?: string | undefined;
  includeExtractedText?: boolean | undefined;
  buildPrompt(input: { fileName: string; localPath: string; extractedText?: string }): string;
};

export type PreparedEvidenceExtractRequest = {
  model?: OpenCodeModelRef | undefined;
  createSessionTitle?: string | undefined;
  includeExtractedText?: boolean | undefined;
  buildPrompt(input: { fileName: string; localPath: string; extractedText?: string }): string;
};

export type PreparedEvidenceJsonResult = {
  result: Record<string, unknown>;
  preparedFile: PreparedEvidenceFile;
};

export class EvidenceExtractService {
  constructor(
    private readonly resources: EvidenceExtractResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
    private readonly parserOptions?: DocumentParserOptions | undefined,
  ) {}

  async prepareFile(
    file: EvidenceMaterialInput,
    options: {
      allowedExtensions: string[];
      maxFileSizeMb: number;
      maxExtractedTextLength?: number | undefined;
      parseTextExtensions?: string[] | undefined;
    },
  ): Promise<PreparedEvidenceFile> {
    const downloaded = isBufferEvidenceFileRef(file)
      ? readBufferEvidenceFile(file)
      : isLocalEvidenceFileRef(file)
        ? await readLocalEvidenceFile(file)
        : await this.resources.downloadMessageResource(file.messageId, file.fileKey, file.resourceType ?? "file");
    validateEvidenceFile(downloaded.fileName, downloaded.buffer, options.allowedExtensions, options.maxFileSizeMb);
    const extension = path.extname(downloaded.fileName).toLowerCase();
    const localPath = await saveEvidenceTempFile(downloaded.fileName, downloaded.buffer);

    let extractedText = "";
    const parseTextExtensions = normalizeAllowedExtensions(options.parseTextExtensions ?? DEFAULT_PARSE_TEXT_EXTENSIONS);
    if (parseTextExtensions.includes(extension)) {
      try {
        extractedText = isSpreadsheetExtension(extension)
          ? parseSpreadsheetFile(downloaded.fileName, downloaded.buffer).slice(0, options.maxExtractedTextLength ?? 12_000)
          : (await parseKnowledgeFile(downloaded.fileName, downloaded.buffer, this.parserOptions)).normalizedMarkdown.slice(0, options.maxExtractedTextLength ?? 12_000);
      } catch (error) {
        this.logger.log("evidence-extract", "parse text skipped", {
          fileName: downloaded.fileName,
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      }
    }

    return {
      fileName: downloaded.fileName,
      mimeType: downloaded.mimeType,
      buffer: downloaded.buffer,
      extension,
      localPath,
      extractedText,
    };
  }

  async extractJson(request: EvidenceExtractRequest): Promise<PreparedEvidenceJsonResult> {
    const preparedFile = await this.prepareFile(request.file, {
      allowedExtensions: request.allowedExtensions,
      maxFileSizeMb: request.maxFileSizeMb,
      maxExtractedTextLength: request.maxExtractedTextLength,
      parseTextExtensions: request.parseTextExtensions,
    });
    const result = await this.extractPreparedJson(preparedFile, request);
    return { result, preparedFile };
  }

  async extractPreparedJson(
    preparedFile: PreparedEvidenceFile,
    request: PreparedEvidenceExtractRequest,
  ): Promise<Record<string, unknown>> {
    const promptInput = request.includeExtractedText !== false && preparedFile.extractedText
      ? {
        fileName: preparedFile.fileName,
        localPath: preparedFile.localPath,
        extractedText: preparedFile.extractedText,
      }
      : {
        fileName: preparedFile.fileName,
        localPath: preparedFile.localPath,
      };
    const prompt = request.buildPrompt(promptInput);
    const result = await this.askForJson(prompt, preparedFile, request.model, request.createSessionTitle);
    return result;
  }

  private async askForJson(
    prompt: string,
    preparedFile: PreparedEvidenceFile,
    model?: OpenCodeModelRef,
    title = "[bridge] evidence-extract",
  ): Promise<Record<string, unknown>> {
    const session = await this.opencode.createSession(title);
    try {
      const response = await this.opencode.postMessageSync(session.id, buildPromptRequest(prompt, preparedFile, model));
      return parseJsonObject(response);
    } finally {
      await this.opencode.deleteSession(session.id).catch((error) => {
        this.logger.log("evidence-extract", "delete temp session failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }
  }
}

function isLocalEvidenceFileRef(file: EvidenceMaterialInput): file is LocalEvidenceFileRef {
  return "localPath" in file;
}

function isBufferEvidenceFileRef(file: EvidenceMaterialInput): file is BufferEvidenceFileRef {
  return "buffer" in file;
}

function readBufferEvidenceFile(file: BufferEvidenceFileRef): {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
} {
  return {
    fileName: file.fileName,
    mimeType: file.mimeType ?? extensionToMimeType(path.extname(file.fileName).toLowerCase()),
    buffer: file.buffer,
  };
}

async function readLocalEvidenceFile(file: LocalEvidenceFileRef): Promise<{
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}> {
  const buffer = await readFile(file.localPath);
  return {
    fileName: file.fileName?.trim() || path.basename(file.localPath),
    mimeType: extensionToMimeType(path.extname(file.localPath).toLowerCase()),
    buffer,
  };
}

function buildPromptRequest(prompt: string, preparedFile: PreparedEvidenceFile, model?: OpenCodeModelRef): OpenCodePromptRequest {
  const parts: OpenCodePromptRequest["parts"] = [{ type: "text", text: prompt }];
  if (isImageMimeType(preparedFile.mimeType) || isImageExtension(preparedFile.extension)) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${preparedFile.mimeType || extensionToMimeType(preparedFile.extension)};base64,${preparedFile.buffer.toString("base64")}`,
      },
    });
  }
  return model
    ? { model, parts }
    : { parts };
}

function parseJsonObject(message: OpenCodeMessage): Record<string, unknown> {
  const text = extractAssistantText(message);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function validateEvidenceFile(fileName: string, buffer: Buffer, allowedExtensions: string[], maxFileSizeMb: number): void {
  const extension = path.extname(fileName).toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    throw new Error(`仅支持 ${allowedExtensions.join(" / ")} 文件`);
  }
  if (extension === ".pdf" && looksLikeHtmlPayload(buffer)) {
    throw new Error("文件内容不像有效 PDF，请确认文件类型后重新上传");
  }
  if (buffer.byteLength > maxFileSizeMb * 1024 * 1024) {
    throw new Error(`文件过大，请控制在 ${maxFileSizeMb}MB 以内`);
  }
}

export async function saveEvidenceTempFile(fileName: string, buffer: Buffer): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "evidence-extract-"));
  const targetPath = path.join(tempDir, fileName.replace(/[\\/:"*?<>|]+/g, "_"));
  await writeFile(targetPath, buffer);
  return targetPath;
}

function isSpreadsheetExtension(extension: string): boolean {
  return [".xls", ".xlsx", ".csv"].includes(extension);
}

function isImageExtension(extension: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extension);
}

function looksLikeHtmlPayload(buffer: Buffer): boolean {
  const prefix = buffer.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html")
    || prefix.startsWith("<html")
    || prefix.includes("<title>")
    || prefix.includes("<body");
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

function extensionToMimeType(extension: string): string {
  switch (extension) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
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
    const previewRows = rows.slice(0, 50).map((row) => row.map((cell) => String(cell ?? "").replace(/\s+/g, " ").trim()));
    const width = Math.max(...previewRows.map((row) => row.length), 1);
    const normalized = previewRows.map((row) => Array.from({ length: width }, (_v, index) => row[index] ?? ""));
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
