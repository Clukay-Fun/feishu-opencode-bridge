/**
 * 职责: 覆盖 Document Operation Journal 扩展查询。
 * 关注点: 按状态/类型/文件名/时间范围查询。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DocumentOperationJournal } from "../src/workspace/journal-db.js";

describe("DocumentOperationJournal extended queries", () => {
  it("queries by operation type", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-query-type-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      journal.append({ operationType: "parse", sourceType: "local", fileName: "a.txt", extension: ".txt", status: "success", elapsedMs: 10 });
      journal.append({ operationType: "create", sourceType: "local", fileName: "b.md", extension: ".md", status: "success", elapsedMs: 20 });
      journal.append({ operationType: "parse", sourceType: "upload", fileName: "c.pdf", extension: ".pdf", status: "failed", elapsedMs: 5 });

      const parses = journal.query({ operationType: "parse" });
      expect(parses.length).toBe(2);

      const creates = journal.query({ operationType: "create" });
      expect(creates.length).toBe(1);

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queries by fileName pattern", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-query-name-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      journal.append({ operationType: "parse", sourceType: "local", fileName: "合同.pdf", extension: ".pdf", status: "success", elapsedMs: 10 });
      journal.append({ operationType: "parse", sourceType: "local", fileName: "发票.png", extension: ".png", status: "success", elapsedMs: 15 });

      const contracts = journal.query({ fileName: "合同" });
      expect(contracts.length).toBe(1);
      expect(contracts[0]!.fileName).toBe("合同.pdf");

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queries by time range", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-query-time-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      const now = Date.now();
      journal.append({ operationType: "parse", sourceType: "local", fileName: "old.txt", extension: ".txt", status: "success", elapsedMs: 10 });
      // 模拟旧记录
      const raw = (journal as any).db;
      raw.prepare("UPDATE document_operations SET created_at = ? WHERE file_name = ?").run(now - 8 * 24 * 60 * 60 * 1000, "old.txt");

      const recent = journal.query({ since: now - 24 * 60 * 60 * 1000 });
      expect(recent.length).toBe(0);

      const all = journal.query({ since: now - 10 * 24 * 60 * 60 * 1000 });
      expect(all.length).toBe(1);

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects limit parameter", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-query-limit-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      for (let i = 0; i < 10; i++) {
        journal.append({ operationType: "parse", sourceType: "local", fileName: `f${i}.txt`, extension: ".txt", status: "success", elapsedMs: 1 });
      }

      const limited = journal.query({ limit: 3 });
      expect(limited.length).toBe(3);

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queryByStatus delegates to query", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-wrapper-status-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      journal.append({ operationType: "parse", sourceType: "local", fileName: "a.txt", extension: ".txt", status: "success", elapsedMs: 10 });
      journal.append({ operationType: "parse", sourceType: "local", fileName: "b.txt", extension: ".txt", status: "failed", elapsedMs: 5 });

      const result = journal.queryByStatus("failed");
      expect(result.length).toBe(1);
      expect(result[0]!.status).toBe("failed");

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queryByType delegates to query", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-wrapper-type-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      journal.append({ operationType: "parse", sourceType: "local", fileName: "a.txt", extension: ".txt", status: "success", elapsedMs: 10 });
      journal.append({ operationType: "create", sourceType: "local", fileName: "b.md", extension: ".md", status: "success", elapsedMs: 20 });

      const result = journal.queryByType("create");
      expect(result.length).toBe(1);

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queryByFileName delegates to query", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-wrapper-name-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      journal.append({ operationType: "parse", sourceType: "local", fileName: "合同.pdf", extension: ".pdf", status: "success", elapsedMs: 10 });

      const result = journal.queryByFileName("合同");
      expect(result.length).toBe(1);
      expect(result[0]!.fileName).toBe("合同.pdf");

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queryByTimeRange delegates to query", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "journal-wrapper-time-"));
    try {
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      journal.append({ operationType: "parse", sourceType: "local", fileName: "a.txt", extension: ".txt", status: "success", elapsedMs: 10 });

      const now = Date.now();
      const result = journal.queryByTimeRange(now - 60_000, now + 60_000);
      expect(result.length).toBe(1);

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
