/**
 * 职责: 提供 File/Document Workspace 能力层的统一解析入口。
 * 关注点:
 * - 包装 document-pipeline 的 parseDocument()，返回标准化 WorkspaceParseResult。
 * - 复用 material-support.ts 的扩展名白名单和大小限制。
 * - 写 Document Operation Journal，失败不阻塞主流程。
 * - 纯包装层，不修改 document-pipeline 底层逻辑。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { parseDocument, type DocumentParserOptions } from "../document-pipeline/index.js";
import { SUPPORTED_MATERIAL_EXTENSIONS } from "../document-pipeline/material-support.js";
import { expandArchiveMaterialEntries, isArchiveFileName } from "../document-pipeline/archive.js";
import type { Logger } from "../logging/logger.js";
import type { WorkspaceParseResult, WorkspaceSource } from "./types.js";
import { DocumentOperationJournal } from "./journal-db.js";

type WorkspaceServiceConfig = {
  dataDir: string;
  logger: Logger;
  allowedExtensions?: string[];
  maxFileSizeMb?: number;
  parserOptions?: DocumentParserOptions;
};

export class WorkspaceService {
  private readonly journal: DocumentOperationJournal;
  private readonly allowedExtensions: Set<string>;
  private readonly maxFileSizeBytes: number;
  private readonly logger: Logger;
  private readonly parserOptions: DocumentParserOptions | undefined;
  private readonly dataDir: string;

  constructor(config: WorkspaceServiceConfig) {
    this.dataDir = config.dataDir;
    this.journal = new DocumentOperationJournal(path.join(config.dataDir, "document-operations.db"));
    this.allowedExtensions = new Set(
      (config.allowedExtensions ?? [...SUPPORTED_MATERIAL_EXTENSIONS])
        .map((ext) => ext.trim().toLowerCase())
        .map((ext) => ext.startsWith(".") ? ext : `.${ext}`),
    );
    this.maxFileSizeBytes = (config.maxFileSizeMb ?? 20) * 1024 * 1024;
    this.logger = config.logger;
    this.parserOptions = config.parserOptions ?? undefined;
  }

  /**
   * 解析文件并返回标准化结果。
   * 支持本地路径、buffer 输入和 zip 压缩包。
   */
  async parse(input: {
    path?: string;
    buffer?: Buffer;
    fileName: string;
    source: WorkspaceSource;
    sourceUrl?: string;
  }): Promise<WorkspaceParseResult | WorkspaceParseResult[]> {
    const startTime = Date.now();
    const extension = normalizeExtension(input.fileName);

    // 白名单校验
    if (!this.allowedExtensions.has(extension)) {
      const detail = `不支持的文件类型 ${extension}`;
      this.journal.appendSafe(this.logger, {
        operationType: "parse",
        inputPath: input.path,
        sourceType: input.source,
        fileName: input.fileName,
        extension,
        status: "failed",
        elapsedMs: Date.now() - startTime,
        detail,
      });
      throw new Error(detail);
    }

    // 获取 buffer
    let buffer = input.buffer;
    if (!buffer && input.path) {
      const stat = await fs.stat(input.path).catch(() => null);
      if (!stat) {
        const detail = `文件不存在：${input.path}`;
        this.journal.appendSafe(this.logger, {
          operationType: "parse",
          inputPath: input.path,
          sourceType: input.source,
          fileName: input.fileName,
          extension,
          status: "failed",
          elapsedMs: Date.now() - startTime,
          detail,
        });
        throw new Error(detail);
      }
      if (stat.size > this.maxFileSizeBytes) {
        const detail = `文件大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过限制 ${this.maxFileSizeBytes / 1024 / 1024}MB`;
        this.journal.appendSafe(this.logger, {
          operationType: "parse",
          inputPath: input.path,
          sourceType: input.source,
          fileName: input.fileName,
          extension,
          status: "failed",
          elapsedMs: Date.now() - startTime,
          detail,
        });
        throw new Error(detail);
      }
      buffer = await fs.readFile(input.path);
    }

    if (!buffer) {
      throw new Error("必须提供 path 或 buffer");
    }

    if (buffer.length > this.maxFileSizeBytes) {
      const detail = `文件大小 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过限制`;
      this.journal.appendSafe(this.logger, {
        operationType: "parse",
        inputPath: input.path,
        sourceType: input.source,
        fileName: input.fileName,
        extension,
        status: "failed",
        elapsedMs: Date.now() - startTime,
        detail,
      });
      throw new Error(detail);
    }

    // zip 处理
    if (isArchiveFileName(input.fileName)) {
      return this.parseZipArchive(input, buffer, startTime);
    }

    // 普通文件解析
    return this.parseSingleFile(input, buffer, startTime);
  }

  private async parseSingleFile(
    input: { path?: string; fileName: string; source: WorkspaceSource; sourceUrl?: string },
    buffer: Buffer,
    startTime: number,
  ): Promise<WorkspaceParseResult> {
    const extension = normalizeExtension(input.fileName);
    try {
      const parsed = await parseDocument(input.fileName, buffer, this.parserOptions);
      const elapsedMs = Date.now() - startTime;

      this.journal.appendSafe(this.logger, {
        operationType: "parse",
        inputPath: input.path,
        sourceType: input.source,
        fileName: input.fileName,
        extension,
        status: parsed.warnings.length > 0 ? "partial" : "success",
        usedParser: parsed.parserUsed,
        quality: parsed.quality,
        fallbackChain: parsed.fallbackChain,
        warnings: parsed.warnings,
        elapsedMs,
      });

      return {
        meta: {
          fileName: input.fileName,
          extension,
          size: buffer.length,
          source: input.source,
          sourceUrl: input.sourceUrl,
        },
        content: {
          rawText: parsed.plainText,
          markdown: parsed.markdown,
          sections: parsed.sections,
          ocrText: isOcrParser(parsed.parserUsed) ? parsed.plainText : undefined,
        },
        parse: {
          used: parsed.parserUsed,
          quality: parsed.quality,
          fallbackChain: parsed.fallbackChain,
          warnings: parsed.warnings,
          elapsedMs,
        },
      };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const detail = error instanceof Error ? error.message : String(error);
      this.journal.appendSafe(this.logger, {
        operationType: "parse",
        inputPath: input.path,
        sourceType: input.source,
        fileName: input.fileName,
        extension,
        status: "failed",
        elapsedMs,
        detail,
      });
      throw error;
    }
  }

  private async parseZipArchive(
    input: { path?: string; fileName: string; source: WorkspaceSource; sourceUrl?: string },
    buffer: Buffer,
    startTime: number,
  ): Promise<WorkspaceParseResult[]> {
    const entries = expandArchiveMaterialEntries(input.fileName, buffer, [...this.allowedExtensions]);
    const results: WorkspaceParseResult[] = [];
    for (const entry of entries) {
      try {
        const result = await this.parseSingleFile(
          { fileName: entry.fileName, source: "zip-entry" as WorkspaceSource },
          entry.buffer,
          startTime,
        );
        results.push(result);
      } catch {
        // 跳过解析失败的 zip 内文件
      }
    }
    return results;
  }

  /**
   * 基于模板创建本地文档。
   * 返回输出路径和缺口清单。
   */
  async create(input: {
    type: "docx" | "md";
    templatePath?: string;
    data: Record<string, string>;
    outputFileName: string;
  }): Promise<{ outputPath: string; missingFields: string[] }> {
    const startTime = Date.now();
    const outputDir = path.join(this.dataDir, "workspace-output");
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, sanitizeFileName(input.outputFileName));

    // 路径越界检查
    if (!outputPath.startsWith(outputDir)) {
      const detail = "输出路径越界";
      this.journal.appendSafe(this.logger, {
        operationType: "create",
        sourceType: "local",
        fileName: input.outputFileName,
        extension: `.${input.type}`,
        status: "failed",
        elapsedMs: Date.now() - startTime,
        detail,
      });
      throw new Error(detail);
    }

    try {
      let missingFields: string[] = [];

      if (input.type === "docx" && input.templatePath) {
        // docx 模板：用 docxtemplater 填充
        const { fillDocxTemplate } = await import("./docx-template.js");
        const result = await fillDocxTemplate(input.templatePath, input.data, outputPath);
        missingFields = result.missingFields;
      } else if (input.templatePath) {
        // 文本模板：用 {{xxx}} 占位符填充
        const { fillTemplate } = await import("./template.js");
        const templateText = await fs.readFile(input.templatePath, "utf-8");
        const result = fillTemplate(templateText, input.data);
        await fs.writeFile(outputPath, result.filledText, "utf-8");
        missingFields = result.missingFields;
      } else {
        // 无模板：直接写 key-value
        const filledText = Object.entries(input.data).map(([k, v]) => `${k}: ${v}`).join("\n");
        await fs.writeFile(outputPath, filledText, "utf-8");
      }

      this.journal.appendSafe(this.logger, {
        operationType: "create",
        inputPath: input.templatePath,
        outputPath,
        sourceType: "local",
        fileName: input.outputFileName,
        extension: `.${input.type}`,
        status: missingFields.length > 0 ? "partial" : "success",
        elapsedMs: Date.now() - startTime,
        detail: missingFields.length > 0 ? `缺少字段：${missingFields.join(", ")}` : undefined,
      });

      return { outputPath, missingFields };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const detail = error instanceof Error ? error.message : String(error);
      this.journal.appendSafe(this.logger, {
        operationType: "create",
        inputPath: input.templatePath,
        sourceType: "local",
        fileName: input.outputFileName,
        extension: `.${input.type}`,
        status: "failed",
        elapsedMs,
        detail,
      });
      throw error;
    }
  }

  /**
   * 编辑本地文档。
   * 支持命令：append、replace、delete-section、insert-table、insert-image。
   */
  async edit(input: {
    inputPath: string;
    command: "append" | "replace" | "delete-section" | "insert-table" | "insert-image";
    content?: string;
    target?: string;
  }): Promise<{ outputPath: string }> {
    const startTime = Date.now();
    const fileName = path.basename(input.inputPath);
    const extension = normalizeExtension(fileName);

    // 路径检查：不允许编辑配置文件或源码
    const forbiddenPatterns = [/config\.json$/, /\.ts$/, /\.js$/, /\.mjs$/];
    if (forbiddenPatterns.some((p) => p.test(input.inputPath))) {
      const detail = "不允许编辑此文件类型";
      this.journal.appendSafe(this.logger, {
        operationType: "edit",
        inputPath: input.inputPath,
        sourceType: "local",
        fileName,
        extension,
        status: "failed",
        elapsedMs: Date.now() - startTime,
        detail,
      });
      throw new Error(detail);
    }

    const outputDir = path.join(this.dataDir, "workspace-output");
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, sanitizeFileName(fileName));

    try {
      const original = await fs.readFile(input.inputPath, "utf-8");
      let result: string;

      if (input.command === "append") {
        result = original + "\n" + (input.content ?? "");
      } else if (input.command === "replace" && input.target) {
        result = original.replace(input.target, input.content ?? "");
      } else if (input.command === "delete-section" && input.target) {
        result = deleteSection(original, input.target);
      } else if (input.command === "insert-table" && input.target && input.content) {
        const tableData = JSON.parse(input.content) as { headers: string[]; rows: string[][] };
        result = insertTableAfter(original, input.target, tableData);
      } else if (input.command === "insert-image" && input.target && input.content) {
        result = insertImageAfter(original, input.target, input.content);
      } else {
        throw new Error(`${input.command} 命令需要 target 参数`);
      }

      await fs.writeFile(outputPath, result, "utf-8");

      this.journal.appendSafe(this.logger, {
        operationType: "edit",
        inputPath: input.inputPath,
        outputPath,
        sourceType: "local",
        fileName,
        extension,
        status: "success",
        elapsedMs: Date.now() - startTime,
      });

      return { outputPath };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const detail = error instanceof Error ? error.message : String(error);
      this.journal.appendSafe(this.logger, {
        operationType: "edit",
        inputPath: input.inputPath,
        sourceType: "local",
        fileName,
        extension,
        status: "failed",
        elapsedMs,
        detail,
      });
      throw error;
    }
  }

  close(): void {
    this.journal.close();
  }
}

function normalizeExtension(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ext || path.basename(fileName).toLowerCase();
}

const OCR_PARSERS = new Set([
  "paddleocr-vl",
  "paddleocr-vl-aistudio",
  "mineru-agent",
  "tesseract",
]);

function isOcrParser(parserUsed: string): boolean {
  return OCR_PARSERS.has(parserUsed);
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, "_").slice(0, 200);
}

/** 删除 Markdown 中指定标题下的整个章节。 */
function deleteSection(markdown: string, headingTitle: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inSection = false;
  let sectionLevel = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      if (title === headingTitle) {
        inSection = true;
        sectionLevel = level;
        continue;
      }
      if (inSection && level <= sectionLevel) {
        inSection = false;
      }
    }
    if (!inSection) {
      result.push(line);
    }
  }
  return result.join("\n");
}

/** 在指定标题之后插入 Markdown 表格。 */
function insertTableAfter(markdown: string, anchor: string, table: { headers: string[]; rows: string[][] }): string {
  const headerLine = `| ${table.headers.join(" | ")} |`;
  const separatorLine = `| ${table.headers.map(() => "---").join(" | ")} |`;
  const bodyLines = table.rows.map((row) => `| ${row.join(" | ")} |`);
  const tableBlock = [headerLine, separatorLine, ...bodyLines].join("\n");

  const lines = markdown.split("\n");
  const result: string[] = [];
  let inserted = false;

  for (const line of lines) {
    result.push(line);
    if (!inserted && line.trim() === anchor.trim()) {
      result.push("", tableBlock);
      inserted = true;
    }
  }
  if (!inserted) {
    result.push("", tableBlock);
  }
  return result.join("\n");
}

/** 在指定标题之后插入 Markdown 图片。 */
function insertImageAfter(markdown: string, anchor: string, imagePath: string): string {
  const imageMd = `![图片](${imagePath})`;
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inserted = false;

  for (const line of lines) {
    result.push(line);
    if (!inserted && line.trim() === anchor.trim()) {
      result.push("", imageMd);
      inserted = true;
    }
  }
  if (!inserted) {
    result.push("", imageMd);
  }
  return result.join("\n");
}
