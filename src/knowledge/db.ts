import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { cosineSimilarity } from "../memory/embedding-retriever.js";

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
  bitableRecordId?: string | undefined;
  embeddingModel?: string | undefined;
  embedding?: number[] | undefined;
  createdAt: number;
};

export type KnowledgeEntryCandidate = KnowledgeEntryRecord & {
  score: number;
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
  bitable_record_id: string | null;
  embedding_model: string | null;
  embedding_json: string | null;
  created_at: number;
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

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

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

  saveEntry(input: {
    documentId: number;
    question: string;
    answer: string;
    tags: string[];
    statute?: string | undefined;
    sourceFile: string;
    pageSection?: string | undefined;
    bitableRecordId?: string | undefined;
    embedding?: number[] | undefined;
    embeddingModel?: string | undefined;
  }): number {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO knowledge_entries (
        document_id,
        question,
        answer,
        tags_json,
        statute,
        source_file,
        page_section,
        bitable_record_id,
        embedding_model,
        embedding_json,
        created_at
      )
      VALUES (
        @documentId,
        @question,
        @answer,
        @tagsJson,
        @statute,
        @sourceFile,
        @pageSection,
        @bitableRecordId,
        @embeddingModel,
        @embeddingJson,
        @createdAt
      )
      ON CONFLICT(document_id, question, answer, COALESCE(page_section, '')) DO UPDATE SET
        tags_json = excluded.tags_json,
        statute = excluded.statute,
        source_file = excluded.source_file,
        bitable_record_id = COALESCE(excluded.bitable_record_id, knowledge_entries.bitable_record_id),
        embedding_model = COALESCE(excluded.embedding_model, knowledge_entries.embedding_model),
        embedding_json = COALESCE(excluded.embedding_json, knowledge_entries.embedding_json)
    `).run({
      documentId: input.documentId,
      question: input.question,
      answer: input.answer,
      tagsJson: JSON.stringify(input.tags),
      statute: input.statute ?? null,
      sourceFile: input.sourceFile,
      pageSection: input.pageSection ?? null,
      bitableRecordId: input.bitableRecordId ?? null,
      embeddingModel: input.embeddingModel ?? null,
      embeddingJson: input.embedding ? JSON.stringify(input.embedding) : null,
      createdAt: now,
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

  updateDocumentStatus(id: number, status: string): void {
    this.db.prepare(`
      UPDATE knowledge_documents
      SET status = @status
      WHERE id = @id
    `).run({ id, status });
  }

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

  clearExtractedChunks(documentId: number): void {
    this.db.prepare(`
      DELETE FROM knowledge_extract_chunks
      WHERE document_id = @documentId
    `).run({ documentId });
  }

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

  searchByEmbedding(queryEmbedding: number[], model: string, limit: number): KnowledgeEntryCandidate[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM knowledge_entries
      WHERE embedding_model = @model
        AND embedding_json IS NOT NULL
      ORDER BY id DESC
    `).all({ model }) as KnowledgeEntryRow[];

    return rows
      .map((row) => {
        const record = toEntryRecord(row);
        if (!record.embedding) {
          return null;
        }
        const score = cosineSimilarity(queryEmbedding, record.embedding);
        if (!Number.isFinite(score)) {
          return null;
        }
        return { ...record, score };
      })
      .filter((record): record is KnowledgeEntryCandidate => record !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

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
    }));
  }

  listAllEntries(): KnowledgeEntryRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM knowledge_entries
      ORDER BY id DESC
    `).all() as KnowledgeEntryRow[];
    return rows.map((row) => toEntryRecord(row));
  }

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

  listAllDocuments(): KnowledgeDocumentRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM knowledge_documents
      ORDER BY id DESC
    `).all() as KnowledgeDocumentRow[];
    return rows.map((row) => toDocumentRecord(row));
  }

  close(): void {
    this.db.close();
  }

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
        bitable_record_id TEXT,
        embedding_model TEXT,
        embedding_json TEXT,
        created_at INTEGER NOT NULL,
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
    bitableRecordId: row.bitable_record_id ?? undefined,
    embeddingModel: row.embedding_model ?? undefined,
    embedding: parseNumericArray(row.embedding_json),
    createdAt: row.created_at,
  };
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
