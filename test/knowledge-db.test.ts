/**
 * 职责: 覆盖知识库类型化 entry 的数据库兼容与回流检索行为。
 * 关注点:
 * - 验证新 entry 的默认 confidence / reviewRequired 语义。
 * - 验证旧 SQLite schema 自动迁移且不污染存量条目展示状态。
 * - 验证 case_reflow 的兼容字段和 dedupKey 可被现有检索路径消费。
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { KnowledgeDb } from "../src/knowledge/db.js";
import {
  deriveReflowCompatFields,
  generateReflowDedupKey,
  type CaseReflowDraft,
} from "../src/knowledge/entry-types.js";

describe("KnowledgeDb typed entries", () => {
  it("applies typed entry defaults on new writes", async () => {
    const db = new KnowledgeDb(await tempDbPath());
    const document = db.saveDocument({
      sourceType: "manual",
      title: "劳动合同法",
      fileName: "labor.md",
      checksum: "typed-defaults",
      status: "ready",
    });

    const articleId = db.saveEntry({
      documentId: document.id,
      question: "《劳动合同法》第三十九条是什么？",
      answer: "用人单位可以单方解除劳动合同的法定情形。",
      tags: ["劳动法"],
      sourceFile: "labor.md",
      entryType: "article",
    });
    const noteId = db.saveEntry({
      documentId: document.id,
      question: "违法解除案件的办案经验是什么？",
      answer: "先核查解除通知、规章制度和送达证据。",
      tags: ["劳动法", "经验"],
      sourceFile: "labor.md",
    });

    const entries = db.listAllEntries();
    expect(entries.find((entry) => entry.id === articleId)).toMatchObject({
      entryType: "article",
      confidence: 1,
      reviewRequired: false,
      migrated: false,
      effectiveStatus: "current",
    });
    expect(entries.find((entry) => entry.id === noteId)).toMatchObject({
      entryType: "practice_note",
      confidence: 0.7,
      reviewRequired: true,
      migrated: false,
      effectiveStatus: "unknown",
    });
    db.close();
  });

  it("migrates legacy entries without marking them as newly review-required", async () => {
    const dbPath = await tempDbPath();
    seedLegacyKnowledgeDb(dbPath);

    const db = new KnowledgeDb(dbPath);
    const [entry] = db.listAllEntries();

    expect(entry).toMatchObject({
      entryType: "practice_note",
      confidence: 0.7,
      reviewRequired: false,
      migrated: true,
      effectiveStatus: "unknown",
    });
    db.close();
  });

  it("keeps case_reflow entries searchable through compatible question and answer fields", async () => {
    const db = new KnowledgeDb(await tempDbPath());
    const document = db.saveDocument({
      sourceType: "case_reflow",
      title: "违法解除回流",
      fileName: "case-reflow.md",
      checksum: "case-reflow-searchable",
      status: "ready",
    });
    const draft = createReflowDraft();
    const compat = deriveReflowCompatFields(draft);
    const dedupKey = generateReflowDedupKey(draft);

    const entryId = db.saveEntry({
      documentId: document.id,
      ...compat,
      tags: ["劳动法", "案件回流"],
      sourceFile: "case-reflow.md",
      entryType: "case_reflow",
      dedupKey,
      fieldsJson: JSON.stringify(draft),
    });

    expect(db.findByDedupKey(dedupKey)?.id).toBe(entryId);
    expect(db.searchByKeyword("违法解除 规章制度", 5)[0]).toMatchObject({
      id: entryId,
      entryType: "case_reflow",
      reviewRequired: true,
      source: "keyword",
    });
    db.close();
  });
});

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-knowledge-db-"));
  return path.join(dir, "knowledge.db");
}

function createReflowDraft(): CaseReflowDraft {
  return {
    caseId: "case_demo",
    title: "违法解除劳动合同回流",
    issues: ["解除依据是否充分", "赔偿金是否支持"],
    claimBasis: [{
      claim: "违法解除赔偿金",
      basis: "《劳动合同法》第八十七条",
      evidenceSummary: ["解除通知", "规章制度"],
    }],
    legalSupports: [{
      issue: "解除依据是否充分",
      rule: "《劳动合同法》第三十九条",
      sourceType: "authority",
    }],
    reviewFindings: ["仅有软参考时不得直接通过二审。"],
    draftSummary: "用人单位解除依据不足，需补强规章制度民主程序和送达证据。",
    redactionCandidates: [],
    dedupKey: "ignored-by-generator",
  };
}

function seedLegacyKnowledgeDb(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      checksum TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      bitable_record_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE knowledge_entries (
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
  `);
  raw.prepare(`
    INSERT INTO knowledge_documents (source_type, title, file_name, checksum, status, created_at)
    VALUES ('file', '旧知识', 'legacy.md', 'legacy-checksum', 'ready', 1)
  `).run();
  raw.prepare(`
    INSERT INTO knowledge_entries (document_id, question, answer, tags_json, source_file, created_at)
    VALUES (1, '旧条目问题', '旧条目答案', '["历史"]', 'legacy.md', 1)
  `).run();
  raw.close();
}
