/**
 * 职责: 提供 Document Operation Journal 的本地存储层。
 * 关注点:
 * - 记录每次文件读取/解析/编辑操作。
 * - 写入失败不阻塞主流程（调用方 catch + logger.warn）。
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { DocumentOperationRecord } from "./types.js";

export class DocumentOperationJournal {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

  append(entry: {
    operationType: string;
    inputPath?: string | undefined;
    outputPath?: string | undefined;
    sourceType: string;
    fileName: string;
    extension: string;
    status: string;
    usedParser?: string | undefined;
    quality?: string | undefined;
    fallbackChain?: string[] | undefined;
    warnings?: string[] | undefined;
    elapsedMs: number;
    detail?: string | undefined;
  }): number {
    const now = Date.now();
    const operationId = crypto.randomUUID();
    const result = this.db.prepare(`
      INSERT INTO document_operations (
        operation_id, operation_type, input_path, output_path, source_type,
        file_name, extension, status, used_parser, quality,
        fallback_chain, warnings, elapsed_ms, detail, created_at
      ) VALUES (
        @operationId, @operationType, @inputPath, @outputPath, @sourceType,
        @fileName, @extension, @status, @usedParser, @quality,
        @fallbackChain, @warnings, @elapsedMs, @detail, @now
      )
    `).run({
      operationId,
      operationType: entry.operationType,
      inputPath: entry.inputPath ?? null,
      outputPath: entry.outputPath ?? null,
      sourceType: entry.sourceType,
      fileName: entry.fileName,
      extension: entry.extension,
      status: entry.status,
      usedParser: entry.usedParser ?? null,
      quality: entry.quality ?? null,
      fallbackChain: entry.fallbackChain ? JSON.stringify(entry.fallbackChain) : null,
      warnings: entry.warnings ? JSON.stringify(entry.warnings) : null,
      elapsedMs: entry.elapsedMs,
      detail: entry.detail ?? null,
      now,
    });
    return Number(result.lastInsertRowid);
  }

  query(options?: { status?: string; operationType?: string; fileName?: string; since?: number; until?: number; limit?: number }): DocumentOperationRecord[] {
    const limit = Math.min(options?.limit ?? 50, 500);
    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit };

    if (options?.status) {
      conditions.push("status = @status");
      params.status = options.status;
    }
    if (options?.operationType) {
      conditions.push("operation_type = @operationType");
      params.operationType = options.operationType;
    }
    if (options?.fileName) {
      conditions.push("file_name LIKE @fileName");
      params.fileName = `%${options.fileName}%`;
    }
    if (options?.since) {
      conditions.push("created_at >= @since");
      params.since = options.since;
    }
    if (options?.until) {
      conditions.push("created_at <= @until");
      params.until = options.until;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT id, operation_id AS operationId, operation_type AS operationType,
             input_path AS inputPath, output_path AS outputPath, source_type AS sourceType,
             file_name AS fileName, extension, status, used_parser AS usedParser,
             quality, fallback_chain AS fallbackChain, warnings,
             elapsed_ms AS elapsedMs, detail, created_at AS createdAt
      FROM document_operations
      ${where}
      ORDER BY created_at DESC
      LIMIT @limit
    `).all(params) as DocumentOperationRecord[];
  }

  /** 安全写入：失败时只记日志，不抛错。 */
  appendSafe(logger: { log(scope: string, message: string, data?: Record<string, unknown>, level?: string): void }, entry: {
    operationType: string;
    inputPath?: string | undefined;
    outputPath?: string | undefined;
    sourceType: string;
    fileName: string;
    extension: string;
    status: string;
    usedParser?: string | undefined;
    quality?: string | undefined;
    fallbackChain?: string[] | undefined;
    warnings?: string[] | undefined;
    elapsedMs: number;
    detail?: string | undefined;
  }): void {
    try {
      this.append(entry);
    } catch (error) {
      logger.log("workspace/journal", "journal write failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  /** 按状态查询(wrapper)。 */
  queryByStatus(status: string, options?: { limit?: number }): DocumentOperationRecord[] {
    return this.query({ status, ...(options?.limit !== undefined ? { limit: options.limit } : {}) });
  }

  /** 按操作类型查询(wrapper)。 */
  queryByType(operationType: string, options?: { limit?: number }): DocumentOperationRecord[] {
    return this.query({ operationType, ...(options?.limit !== undefined ? { limit: options.limit } : {}) });
  }

  /** 按文件名 pattern 查询(wrapper)。 */
  queryByFileName(fileName: string, options?: { limit?: number }): DocumentOperationRecord[] {
    return this.query({ fileName, ...(options?.limit !== undefined ? { limit: options.limit } : {}) });
  }

  /** 按时间范围查询(wrapper)。 */
  queryByTimeRange(from: number, to: number, options?: { limit?: number }): DocumentOperationRecord[] {
    return this.query({ since: from, until: to, ...(options?.limit !== undefined ? { limit: options.limit } : {}) });
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        operation_type TEXT NOT NULL,
        input_path TEXT,
        output_path TEXT,
        source_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        extension TEXT NOT NULL,
        status TEXT NOT NULL,
        used_parser TEXT,
        quality TEXT,
        fallback_chain TEXT,
        warnings TEXT,
        elapsed_ms INTEGER NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_doc_ops_time
        ON document_operations(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_doc_ops_status
        ON document_operations(status);
    `);
  }
}
