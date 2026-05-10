/**
 * 职责: 提供知识库的本地存储层，管理文档与条目数据。
 * 关注点:
 * - 持久化文档元数据与问答条目。
 * - 提供写入、检索、摘要统计等数据库接口。
 * - 支撑基于 embedding 的相似度搜索。
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { cosineSimilarity } from "../memory/embedding-retriever.js";
import {
  DEFAULT_ENTRY_CONFIDENCE,
  DEFAULT_ENTRY_REVIEW_REQUIRED,
  type KnowledgeEntryType,
} from "./entry-types.js";
import { normalizeLawName, toChineseArticleNumber, type StatuteReference } from "./statute-ref.js";

export type KnowledgeDocumentRecord = {
  id: number;
  sourceType: string;
  title: string;
  fileName: string;
  checksum: string;
  status: string;
  bitableRecordId?: string | undefined;
  createdAt: number;
};

export type KnowledgeDocumentSummary = KnowledgeDocumentRecord & {
  entryCount: number;
  extractChunkCount: number;
  lastEntryCreatedAt?: number | undefined;
};

export type KnowledgeEntryRecord = {
  id: number;
  documentId: number;
  question: string;
  answer: string;
  tags: string[];
  statute?: string | undefined;
  sourceFile: string;
  pageSection?: string | undefined;
  sourceUrl?: string | undefined;
  statuteUrl?: string | undefined;
  bitableRecordId?: string | undefined;
  embeddingModel?: string | undefined;
  embedding?: number[] | undefined;
  createdAt: number;
  entryType?: KnowledgeEntryType | undefined;
  confidence?: number | undefined;
  reviewRequired?: boolean | undefined;
  migrated?: boolean | undefined;
  effectiveStatus?: string | undefined;
  dedupKey?: string | undefined;
  fieldsJson?: string | undefined;
};

export type KnowledgeEntryCandidate = KnowledgeEntryRecord & {
  score: number;
  source?: "exact_article" | "embedding" | "keyword" | undefined;
  reranked?: boolean | undefined;
};

export type KnowledgeExtractChunkRecord = {
  id: number;
  documentId: number;
  chunkIndex: number;
  chunkHash: string;
  pageSection: string;
  extractedJson: string;
  createdAt: number;
};

type KnowledgeEntryRow = {
  id: number;
  document_id: number;
  question: string;
  answer: string;
  tags_json: string | null;
  statute: string | null;
  source_file: string;
  page_section: string | null;
  source_url: string | null;
  statute_url: string | null;
  bitable_record_id: string | null;
  embedding_model: string | null;
  embedding_json: string | null;
  created_at: number;
  entry_type: string | null;
  confidence: number | null;
  review_required: number | null;
  migrated: number | null;
  effective_status: string | null;
  dedup_key: string | null;
  fields_json: string | null;
};

type KnowledgeDocumentRow = {
  id: number;
  source_type: string;
  title: string;
  file_name: string;
  checksum: string;
  status: string;
  bitable_record_id: string | null;
  created_at: number;
};

type KnowledgeDocumentSummaryRow = KnowledgeDocumentRow & {
  entry_count: number;
  extract_chunk_count: number;
  last_entry_created_at: number | null;
};

type KnowledgeExtractChunkRow = {
  id: number;
  document_id: number;
  chunk_index: number;
  chunk_hash: string;
  page_section: string;
  extracted_json: string;
  created_at: number;
};

export class KnowledgeDb {
  private readonly db: Database.Database;

  // Open the local SQLite database and initialize required tables and indexes.
  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

  //#region Document and entry writes
  // Upsert one source document record and return the canonical stored row.
  saveDocument(input: {
    sourceType: string;
    title: string;
    fileName: string;
    checksum: string;
    status: string;
    bitableRecordId?: string | undefined;
  }): KnowledgeDocumentRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO knowledge_documents (
        source_type,
        title,
        file_name,
        checksum,
        status,
        bitable_record_id,
        created_at
      )
      VALUES (
        @sourceType,
        @title,
        @fileName,
        @checksum,
        @status,
        @bitableRecordId,
        @createdAt
      )
      ON CONFLICT(checksum) DO UPDATE SET
        title = excluded.title,
        file_name = excluded.file_name,
        status = excluded.status,
        bitable_record_id = COALESCE(excluded.bitable_record_id, knowledge_documents.bitable_record_id)
    `).run({
      sourceType: input.sourceType,
      title: input.title,
      fileName: input.fileName,
      checksum: input.checksum,
      status: input.status,
      bitableRecordId: input.bitableRecordId ?? null,
      createdAt: now,
    });

    return this.db.prepare(`
      SELECT
        id,
        source_type AS sourceType,
        title,
        file_name AS fileName,
        checksum,
        status,
        bitable_record_id AS bitableRecordId,
        created_at AS createdAt
      FROM knowledge_documents
      WHERE checksum = @checksum
    `).get({ checksum: input.checksum }) as KnowledgeDocumentRecord;
  }

  // Upsert one extracted knowledge entry under its parent document.
  saveEntry(input: {
    documentId: number;
    question: string;
    answer: string;
    tags: string[];
    statute?: string | undefined;
    sourceFile: string;
    pageSection?: string | undefined;
    sourceUrl?: string | undefined;
    statuteUrl?: string | undefined;
    bitableRecordId?: string | undefined;
    embedding?: number[] | undefined;
    embeddingModel?: string | undefined;
    entryType?: KnowledgeEntryType | undefined;
    confidence?: number | undefined;
    reviewRequired?: boolean | undefined;
    migrated?: boolean | undefined;
    effectiveStatus?: string | undefined;
    dedupKey?: string | undefined;
    fieldsJson?: string | undefined;
  }): number {
    const now = Date.now();
    const metadata = normalizeEntryMetadata(input);
    this.db.prepare(`
      INSERT INTO knowledge_entries (
        document_id,
        question,
        answer,
        tags_json,
        statute,
        source_file,
        page_section,
        source_url,
        statute_url,
        bitable_record_id,
        embedding_model,
        embedding_json,
        created_at,
        entry_type,
        confidence,
        review_required,
        migrated,
        effective_status,
        dedup_key,
        fields_json
      )
      VALUES (
        @documentId,
        @question,
        @answer,
        @tagsJson,
        @statute,
        @sourceFile,
        @pageSection,
        @sourceUrl,
        @statuteUrl,
        @bitableRecordId,
        @embeddingModel,
        @embeddingJson,
        @createdAt,
        @entryType,
        @confidence,
        @reviewRequired,
        @migrated,
        @effectiveStatus,
        @dedupKey,
        @fieldsJson
      )
      ON CONFLICT(document_id, question, answer, COALESCE(page_section, '')) DO UPDATE SET
        tags_json = excluded.tags_json,
        statute = excluded.statute,
        source_file = excluded.source_file,
        source_url = COALESCE(excluded.source_url, knowledge_entries.source_url),
        statute_url = COALESCE(excluded.statute_url, knowledge_entries.statute_url),
        bitable_record_id = COALESCE(excluded.bitable_record_id, knowledge_entries.bitable_record_id),
        embedding_model = COALESCE(excluded.embedding_model, knowledge_entries.embedding_model),
        embedding_json = COALESCE(excluded.embedding_json, knowledge_entries.embedding_json),
        entry_type = COALESCE(excluded.entry_type, knowledge_entries.entry_type),
        confidence = COALESCE(excluded.confidence, knowledge_entries.confidence),
        review_required = COALESCE(excluded.review_required, knowledge_entries.review_required),
        migrated = excluded.migrated,
        effective_status = COALESCE(excluded.effective_status, knowledge_entries.effective_status),
        dedup_key = COALESCE(excluded.dedup_key, knowledge_entries.dedup_key),
        fields_json = COALESCE(excluded.fields_json, knowledge_entries.fields_json)
    `).run({
      documentId: input.documentId,
      question: input.question,
      answer: input.answer,
      tagsJson: JSON.stringify(input.tags),
      statute: input.statute ?? null,
      sourceFile: input.sourceFile,
      pageSection: input.pageSection ?? null,
      sourceUrl: input.sourceUrl ?? null,
      statuteUrl: input.statuteUrl ?? null,
      bitableRecordId: input.bitableRecordId ?? null,
      embeddingModel: input.embeddingModel ?? null,
      embeddingJson: input.embedding ? JSON.stringify(input.embedding) : null,
      createdAt: now,
      entryType: metadata.entryType,
      confidence: metadata.confidence,
      reviewRequired: metadata.reviewRequired ? 1 : 0,
      migrated: metadata.migrated ? 1 : 0,
      effectiveStatus: metadata.effectiveStatus,
      dedupKey: input.dedupKey ?? null,
      fieldsJson: input.fieldsJson ?? null,
    });

    const row = this.db.prepare(`
      SELECT id
      FROM knowledge_entries
      WHERE document_id = @documentId
        AND question = @question
        AND answer = @answer
        AND COALESCE(page_section, '') = COALESCE(@pageSection, '')
    `).get({
      documentId: input.documentId,
      question: input.question,
      answer: input.answer,
      pageSection: input.pageSection ?? null,
    }) as { id: number };

    return row.id;
  }

  /** 通过 dedupKey 查找已有条目 */
  findByDedupKey(dedupKey: string): KnowledgeEntryRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM knowledge_entries WHERE dedup_key = @dedupKey LIMIT 1
    `).get({ dedupKey }) as KnowledgeEntryRow | undefined;
    return row ? toEntryRecord(row) : undefined;
  }

  // Mark a document's ingestion lifecycle status.
  updateDocumentStatus(id: number, status: string): void {
    this.db.prepare(`
      UPDATE knowledge_documents
      SET status = @status
      WHERE id = @id
    `).run({ id, status });
  }

  // List all mirrored Bitable record ids that already exist in the local entry table.
  listEntryBitableRecordIds(): string[] {
    const rows = this.db.prepare(`
      SELECT bitable_record_id
      FROM knowledge_entries
      WHERE bitable_record_id IS NOT NULL
    `).all() as Array<{ bitable_record_id: string | null }>;
    return rows
      .map((row) => row.bitable_record_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  // Delete mirrored entries that no longer exist in Bitable by record id.
  deleteEntriesByBitableRecordIds(recordIds: string[]): number {
    const normalized = [...new Set(recordIds.filter((value) => value.length > 0))];
    if (normalized.length === 0) {
      return 0;
    }
    const placeholders = normalized.map((_, index) => `@recordId${index}`).join(", ");
    const params = Object.fromEntries(normalized.map((recordId, index) => [`recordId${index}`, recordId]));
    const result = this.db.prepare(`
      DELETE FROM knowledge_entries
      WHERE bitable_record_id IN (${placeholders})
    `).run(params);
    return result.changes;
  }

  // Remove mirrored documents left empty after entry cleanup.
  deleteOrphanSyncedDocuments(): number {
    const result = this.db.prepare(`
      DELETE FROM knowledge_documents
      WHERE source_type = 'bitable-sync'
        AND NOT EXISTS (
          SELECT 1
          FROM knowledge_entries e
          WHERE e.document_id = knowledge_documents.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM knowledge_extract_chunks c
          WHERE c.document_id = knowledge_documents.id
        )
    `).run();
    return result.changes;
  }
  //#endregion

  //#region Document and chunk reads
  // List recent documents with aggregate entry and chunk counts.
  listDocuments(options?: {
    limit?: number | undefined;
    statuses?: string[] | undefined;
  }): KnowledgeDocumentSummary[] {
    const filters = options?.statuses?.filter(Boolean) ?? [];
    const whereClause = filters.length > 0
      ? `WHERE d.status IN (${filters.map((_, index) => `@status${index}`).join(", ")})`
      : "";
    const params = Object.fromEntries(filters.map((status, index) => [`status${index}`, status]));
    const limit = options?.limit ?? 20;
    const rows = this.db.prepare(`
      SELECT
        d.*,
        COUNT(DISTINCT e.id) AS entry_count,
        COUNT(DISTINCT c.id) AS extract_chunk_count,
        MAX(e.created_at) AS last_entry_created_at
      FROM knowledge_documents d
      LEFT JOIN knowledge_entries e ON e.document_id = d.id
      LEFT JOIN knowledge_extract_chunks c ON c.document_id = d.id
      ${whereClause}
      GROUP BY d.id
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT @limit
    `).all({ ...params, limit }) as KnowledgeDocumentSummaryRow[];
    return rows.map((row) => toDocumentSummary(row));
  }

  // Read one document summary by id.
  getDocumentById(id: number): KnowledgeDocumentSummary | null {
    const row = this.db.prepare(`
      SELECT
        d.*,
        COUNT(DISTINCT e.id) AS entry_count,
        COUNT(DISTINCT c.id) AS extract_chunk_count,
        MAX(e.created_at) AS last_entry_created_at
      FROM knowledge_documents d
      LEFT JOIN knowledge_entries e ON e.document_id = d.id
      LEFT JOIN knowledge_extract_chunks c ON c.document_id = d.id
      WHERE d.id = @id
      GROUP BY d.id
    `).get({ id }) as KnowledgeDocumentSummaryRow | undefined;
    return row ? toDocumentSummary(row) : null;
  }

  // List all extracted chunk records for one document.
  listExtractedChunks(documentId: number): KnowledgeExtractChunkRecord[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        document_id AS documentId,
        chunk_index AS chunkIndex,
        chunk_hash AS chunkHash,
        page_section AS pageSection,
        extracted_json AS extractedJson,
        created_at AS createdAt
      FROM knowledge_extract_chunks
      WHERE document_id = @documentId
      ORDER BY chunk_index ASC
    `).all({ documentId }) as Array<KnowledgeExtractChunkRow & {
      documentId: number;
      chunkIndex: number;
      chunkHash: string;
      pageSection: string;
      extractedJson: string;
      createdAt: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      chunkIndex: row.chunkIndex,
      chunkHash: row.chunkHash,
      pageSection: row.pageSection,
      extractedJson: row.extractedJson,
      createdAt: row.createdAt,
    }));
  }

  // Upsert one extracted chunk snapshot for resumable ingestion.
  saveExtractedChunk(input: {
    documentId: number;
    chunkIndex: number;
    chunkHash: string;
    pageSection: string;
    extractedJson: string;
  }): void {
    this.db.prepare(`
      INSERT INTO knowledge_extract_chunks (
        document_id,
        chunk_index,
        chunk_hash,
        page_section,
        extracted_json,
        created_at
      )
      VALUES (
        @documentId,
        @chunkIndex,
        @chunkHash,
        @pageSection,
        @extractedJson,
        @createdAt
      )
      ON CONFLICT(document_id, chunk_index) DO UPDATE SET
        chunk_hash = excluded.chunk_hash,
        page_section = excluded.page_section,
        extracted_json = excluded.extracted_json
    `).run({
      documentId: input.documentId,
      chunkIndex: input.chunkIndex,
      chunkHash: input.chunkHash,
      pageSection: input.pageSection,
      extractedJson: input.extractedJson,
      createdAt: Date.now(),
    });
  }

  // Remove all extracted chunks associated with one document.
  clearExtractedChunks(documentId: number): void {
    this.db.prepare(`
      DELETE FROM knowledge_extract_chunks
      WHERE document_id = @documentId
    `).run({ documentId });
  }
  //#endregion

  //#region Search and retrieval
  // Store the embedding generated for one knowledge entry.
  updateEntryEmbedding(id: number, model: string, embedding: number[]): void {
    this.db.prepare(`
      UPDATE knowledge_entries
      SET embedding_model = @model,
          embedding_json = @embedding
      WHERE id = @id
    `).run({
      id,
      model,
      embedding: JSON.stringify(embedding),
    });
  }

  // Score all embedded entries against a query embedding and keep the top matches.
  searchByEmbedding(queryEmbedding: number[], model: string, limit: number): KnowledgeEntryCandidate[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM knowledge_entries
      WHERE embedding_model = @model
        AND embedding_json IS NOT NULL
      ORDER BY id DESC
    `).all({ model }) as KnowledgeEntryRow[];

    return rows
      .flatMap((row): KnowledgeEntryCandidate[] => {
        const record = toEntryRecord(row);
        if (!record.embedding) {
          return [];
        }
        const score = cosineSimilarity(queryEmbedding, record.embedding);
        if (!Number.isFinite(score)) {
          return [];
        }
        return [{ ...record, score, source: "embedding" as const, reranked: false }];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  // Search entries through the FTS index and convert BM25 scores into a simple confidence score.
  searchByKeyword(query: string, limit: number): KnowledgeEntryCandidate[] {
    const tokens = sanitizeSearchQuery(query);
    if (!tokens) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT
        e.*,
        bm25(knowledge_entries_fts) AS score
      FROM knowledge_entries_fts
      JOIN knowledge_entries e ON e.id = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH @query
      ORDER BY bm25(knowledge_entries_fts), e.id DESC
      LIMIT @limit
    `).all({ query: tokens, limit }) as Array<KnowledgeEntryRow & { score: number }>;

    return rows.map((row) => ({
      ...toEntryRecord(row),
      score: Number.isFinite(row.score) ? 1 / (1 + Math.max(0, row.score)) : 0,
      source: "keyword",
      reranked: false,
    }));
  }

  // Deterministically match explicit statute references before semantic retrieval.
  searchByStatuteReferences(refs: StatuteReference[], limit: number): KnowledgeEntryCandidate[] {
    if (refs.length === 0) {
      return [];
    }
    const rows = this.db.prepare(`
      SELECT *
      FROM knowledge_entries
      ORDER BY created_at DESC, id DESC
    `).all() as KnowledgeEntryRow[];

    const records = rows.map((row) => toEntryRecord(row));
    const selected = new Map<number, KnowledgeEntryCandidate>();
    for (const ref of refs) {
      const matches = records
        .map((record) => scoreStatuteReferenceMatch(record, ref))
        .filter((candidate): candidate is KnowledgeEntryCandidate => candidate !== null)
        .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt || right.id - left.id);
      for (const match of matches) {
        if (!selected.has(match.id)) {
          selected.set(match.id, match);
        }
        if (selected.size >= limit) {
          return [...selected.values()];
        }
      }
    }
    return [...selected.values()];
  }

  // List every stored entry, primarily for diagnostics or export paths.
  listAllEntries(): KnowledgeEntryRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM knowledge_entries
      ORDER BY id DESC
    `).all() as KnowledgeEntryRow[];
    return rows.map((row) => toEntryRecord(row));
  }

  // List entries that belong to one document, optionally with a limit.
  listEntriesByDocument(documentId: number, limit?: number): KnowledgeEntryRecord[] {
    const sql = limit === undefined
      ? `
        SELECT *
        FROM knowledge_entries
        WHERE document_id = @documentId
        ORDER BY id DESC
      `
      : `
        SELECT *
        FROM knowledge_entries
        WHERE document_id = @documentId
        ORDER BY id DESC
        LIMIT @limit
      `;
    const rows = this.db.prepare(sql).all(limit === undefined ? { documentId } : { documentId, limit }) as KnowledgeEntryRow[];
    return rows.map((row) => toEntryRecord(row));
  }

  // List all stored documents without summary aggregation.
  listAllDocuments(): KnowledgeDocumentRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM knowledge_documents
      ORDER BY id DESC
    `).all() as KnowledgeDocumentRow[];
    return rows.map((row) => toDocumentRecord(row));
  }

  // Close the underlying SQLite handle.
  close(): void {
    this.db.close();
  }
  //#endregion

  // Create database tables, indexes, and FTS structures if they do not exist yet.
  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        checksum TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        bitable_record_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        statute TEXT,
        source_file TEXT NOT NULL,
        page_section TEXT,
        source_url TEXT,
        statute_url TEXT,
        bitable_record_id TEXT,
        embedding_model TEXT,
        embedding_json TEXT,
        created_at INTEGER NOT NULL,
        entry_type TEXT DEFAULT 'practice_note',
        confidence REAL DEFAULT 0.7,
        review_required INTEGER DEFAULT 1,
        migrated INTEGER DEFAULT 0,
        effective_status TEXT DEFAULT 'current',
        dedup_key TEXT,
        fields_json TEXT,
        FOREIGN KEY(document_id) REFERENCES knowledge_documents(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_entries_identity
        ON knowledge_entries(document_id, question, answer, COALESCE(page_section, ''));

      CREATE TABLE IF NOT EXISTS knowledge_extract_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_hash TEXT NOT NULL,
        page_section TEXT NOT NULL,
        extracted_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(document_id) REFERENCES knowledge_documents(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_extract_chunks_identity
        ON knowledge_extract_chunks(document_id, chunk_index);

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entries_fts USING fts5(
        question,
        answer,
        statute,
        source_file,
        page_section,
        content='knowledge_entries',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS knowledge_entries_ai AFTER INSERT ON knowledge_entries BEGIN
        INSERT INTO knowledge_entries_fts(rowid, question, answer, statute, source_file, page_section)
        VALUES (new.id, new.question, new.answer, new.statute, new.source_file, new.page_section);
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_entries_au AFTER UPDATE OF question, answer, statute, source_file, page_section ON knowledge_entries BEGIN
        INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, question, answer, statute, source_file, page_section)
        VALUES ('delete', old.id, old.question, old.answer, old.statute, old.source_file, old.page_section);
        INSERT INTO knowledge_entries_fts(rowid, question, answer, statute, source_file, page_section)
        VALUES (new.id, new.question, new.answer, new.statute, new.source_file, new.page_section);
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_entries_ad AFTER DELETE ON knowledge_entries BEGIN
        INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, question, answer, statute, source_file, page_section)
        VALUES ('delete', old.id, old.question, old.answer, old.statute, old.source_file, old.page_section);
      END;
    `);
    this.migrateKnowledgeEntriesSchema();
  }

  private migrateKnowledgeEntriesSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(knowledge_entries)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const addColumn = (name: string, ddl: string): void => {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE knowledge_entries ADD COLUMN ${ddl}`);
        columns.add(name);
      }
    };

    // 旧库补列时不能把存量条目批量标黄；历史条目统一标记 migrated=true、reviewRequired=false。
    addColumn("entry_type", "entry_type TEXT DEFAULT 'practice_note'");
    addColumn("confidence", "confidence REAL DEFAULT 0.7");
    addColumn("review_required", "review_required INTEGER DEFAULT 0");
    addColumn("migrated", "migrated INTEGER DEFAULT 1");
    addColumn("effective_status", "effective_status TEXT DEFAULT 'unknown'");
    addColumn("dedup_key", "dedup_key TEXT");
    addColumn("fields_json", "fields_json TEXT");
    addColumn("source_url", "source_url TEXT");
    addColumn("statute_url", "statute_url TEXT");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_entries_dedup_key
        ON knowledge_entries(dedup_key)
        WHERE dedup_key IS NOT NULL;
    `);
  }
}

function toEntryRecord(row: KnowledgeEntryRow): KnowledgeEntryRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    question: row.question,
    answer: row.answer,
    tags: parseStringArray(row.tags_json),
    statute: row.statute ?? undefined,
    sourceFile: row.source_file,
    pageSection: row.page_section ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    statuteUrl: row.statute_url ?? undefined,
    bitableRecordId: row.bitable_record_id ?? undefined,
    embeddingModel: row.embedding_model ?? undefined,
    embedding: parseNumericArray(row.embedding_json),
    createdAt: row.created_at,
    entryType: normalizeEntryType(row.entry_type),
    confidence: row.confidence ?? undefined,
    reviewRequired: row.review_required === 1,
    migrated: row.migrated === 1,
    effectiveStatus: row.effective_status ?? undefined,
    dedupKey: row.dedup_key ?? undefined,
    fieldsJson: row.fields_json ?? undefined,
  };
}

function normalizeEntryMetadata(input: {
  entryType?: KnowledgeEntryType | undefined;
  confidence?: number | undefined;
  reviewRequired?: boolean | undefined;
  migrated?: boolean | undefined;
  effectiveStatus?: string | undefined;
}): {
  entryType: KnowledgeEntryType;
  confidence: number;
  reviewRequired: boolean;
  migrated: boolean;
  effectiveStatus: string;
} {
  const entryType = input.entryType ?? "practice_note";
  return {
    entryType,
    confidence: input.confidence ?? DEFAULT_ENTRY_CONFIDENCE[entryType],
    reviewRequired: input.reviewRequired ?? DEFAULT_ENTRY_REVIEW_REQUIRED[entryType],
    migrated: input.migrated ?? false,
    effectiveStatus: input.effectiveStatus ?? (entryType === "article" ? "current" : "unknown"),
  };
}

function normalizeEntryType(value: string | null): KnowledgeEntryType {
  switch (value) {
    case "article":
    case "case_digest":
    case "case_reflow":
    case "practice_note":
      return value;
    default:
      return "practice_note";
  }
}

function scoreStatuteReferenceMatch(record: KnowledgeEntryRecord, ref: StatuteReference): KnowledgeEntryCandidate | null {
  const articleArabic = `第${ref.articleNumber}条`;
  const articleChinese = `第${toChineseArticleNumber(ref.articleNumber)}条`;
  const lawName = normalizeLawName(ref.lawName);
  const fields = [
    { value: record.statute, weight: 1 },
    { value: `${record.question}\n${record.answer}`, weight: 0.82 },
    { value: `${record.pageSection ?? ""}\n${record.sourceFile}`, weight: 0.64 },
  ];

  for (const field of fields) {
    const normalized = normalizeSearchableText(field.value);
    if (!normalized) {
      continue;
    }
    if (!normalized.includes(articleArabic) && !normalized.includes(articleChinese)) {
      continue;
    }
    if (lawName && !normalized.includes(lawName)) {
      continue;
    }
    return {
      ...record,
      score: field.weight,
      source: "exact_article",
      reranked: false,
    };
  }
  return null;
}

function normalizeSearchableText(value: string | undefined): string {
  return value
    ? value.replace(/[《》\s]/g, "").replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    : "";
}

function toDocumentRecord(row: KnowledgeDocumentRow): KnowledgeDocumentRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    title: row.title,
    fileName: row.file_name,
    checksum: row.checksum,
    status: row.status,
    bitableRecordId: row.bitable_record_id ?? undefined,
    createdAt: row.created_at,
  };
}

function toDocumentSummary(row: KnowledgeDocumentSummaryRow): KnowledgeDocumentSummary {
  return {
    ...toDocumentRecord(row),
    entryCount: Number(row.entry_count ?? 0),
    extractChunkCount: Number(row.extract_chunk_count ?? 0),
    lastEntryCreatedAt: row.last_entry_created_at ?? undefined,
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseNumericArray(value: string | null): number[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "number")) {
      return undefined;
    }
    return parsed as number[];
  } catch {
    return undefined;
  }
}

function sanitizeSearchQuery(query: string): string {
  return [...query.matchAll(/[\p{L}\p{N}_]+/gu)]
    .map((match) => match[0])
    .filter((token) => token.length > 0)
    .slice(0, 20)
    .map((token) => `"${token.replace(/"/g, "\"\"")}"`)
    .join(" OR ");
}
