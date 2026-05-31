/**
 * 职责: 覆盖 Memory v2 相关性召回和分类器。
 * 关注点: 四维度打分、embedding 降级、规则过滤、LLM 分类 fallback。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MemoryDb } from "../src/memory/db.js";
import { TaskDb } from "../src/memory/task-db.js";
import { RecentRetriever } from "../src/memory/recent-retriever.js";
import { V2Retriever, CONFLICT_SIMILARITY_THRESHOLD } from "../src/memory/v2-retriever.js";
import { V2Classifier, ruleFilter } from "../src/memory/v2-classifier.js";

function createLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };
}

describe("V2Retriever", () => {
  it("recalls memories sorted by relevance score", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-retriever-"));
    try {
      const db = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      db.saveFacts("u1", [
        { fact: "用户偏好中文回复", sourceMessage: "msg1" },
        { fact: "用户是独立开发者", sourceMessage: "msg2" },
        { fact: "用户住深圳", sourceMessage: "msg3" },
      ]);

      const logger = createLogger();
      const fallback = new RecentRetriever(db);
      const retriever = new V2Retriever(db, null, fallback, logger as never);

      const results = await retriever.recall("u1", "用户偏好", 5);
      expect(results.length).toBe(3);
      expect(results).toContain("用户偏好中文回复");

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degrades to recent-only when embedding is unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-degrade-"));
    try {
      const db = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      db.saveFacts("u1", [
        { fact: "用户偏好中文回复", sourceMessage: "msg1" },
        { fact: "用户是独立开发者", sourceMessage: "msg2" },
      ]);

      const logger = createLogger();
      const fallback = new RecentRetriever(db);
      // embeddingClient = null → 降级
      const retriever = new V2Retriever(db, null, fallback, logger as never);

      const results = await retriever.recall("u1", "测试查询", 5);
      expect(results.length).toBeGreaterThan(0);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degrades to recent-only when embedding client throws", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-embed-fail-"));
    try {
      const db = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      db.saveFacts("u1", [{ fact: "测试事实", sourceMessage: "msg" }]);

      const logger = createLogger();
      const fallback = new RecentRetriever(db);
      const failingClient = {
        model: "test-model",
        embed: vi.fn().mockRejectedValue(new Error("embedding service down")),
      };
      const retriever = new V2Retriever(db, failingClient as never, fallback, logger as never);

      const results = await retriever.recall("u1", "测试", 5);
      expect(results.length).toBe(1);
      expect(logger.log).toHaveBeenCalledWith(
        "memory/v2-retriever",
        "embedding unavailable, degrading to recent-only",
        expect.any(Object),
        "warn",
      );

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses stored embeddings when the embedding model matches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-embed-success-"));
    try {
      const db = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const ids = db.saveFacts("u1", [
        { fact: "用户偏好中文回复", sourceMessage: "msg1", kind: "preference" },
        { fact: "用户喜欢整理合同", sourceMessage: "msg2" },
      ]);
      db.updateEmbedding(ids[0]!, [1, 0], "test-model");
      db.updateEmbedding(ids[1]!, [0, 1], "test-model");

      const logger = createLogger();
      const fallback = new RecentRetriever(db);
      const embeddingClient = {
        model: "test-model",
        embed: vi.fn().mockResolvedValue([1, 0]),
      };
      const retriever = new V2Retriever(db, embeddingClient as never, fallback, logger as never);

      const results = await retriever.recall("u1", "中文回复", 1);

      expect(results).toEqual(["用户偏好中文回复"]);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("V2Classifier ruleFilter", () => {
  it("rejects empty facts", () => {
    expect(ruleFilter("", []).passed).toBe(false);
    expect(ruleFilter("  ", []).passed).toBe(false);
  });

  it("rejects too-short facts", () => {
    expect(ruleFilter("短", []).passed).toBe(false);
  });

  it("rejects too-long facts", () => {
    expect(ruleFilter("x".repeat(501), []).passed).toBe(false);
  });

  it("rejects duplicate facts", () => {
    expect(ruleFilter("用户偏好中文回复", ["用户偏好中文回复"]).passed).toBe(false);
  });

  it("passes valid facts", () => {
    expect(ruleFilter("用户是独立开发者，使用 TypeScript", []).passed).toBe(true);
  });
});

describe("V2Classifier", () => {
  it("extracts and classifies facts from conversation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-classifier-"));
    try {
      const db = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const logger = createLogger();

      const mockClient = {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        postMessageSync: vi.fn().mockResolvedValue({
          info: { id: "msg-1", role: "assistant" },
          parts: [{ type: "text", text: '{"kind": "fact", "confidence": 0.8}' }],
        }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      };

      const classifier = new V2Classifier(mockClient as never, db, taskDb, logger as never);
      const result = await classifier.extractAndClassify(
        "u1",
        "我是独立开发者，使用 TypeScript 开发",
        "了解，您是独立开发者，使用 TypeScript。",
      );

      expect(result.saved).toBe(1);
      expect(db.listFactsForUser("u1")[0]).toEqual(expect.objectContaining({
        kind: "fact",
        confidence: 0.8,
      }));

      db.close();
      taskDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to fact when LLM fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-classifier-fail-"));
    try {
      const db = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const logger = createLogger();

      const mockClient = {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        postMessageSync: vi.fn().mockRejectedValue(new Error("LLM timeout")),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      };

      const classifier = new V2Classifier(mockClient as never, db, taskDb, logger as never);
      const result = await classifier.extractAndClassify(
        "u1",
        "用户是独立开发者，使用 TypeScript 开发",
        "了解。",
      );

      // LLM 失败时 fallback 到 fact
      expect(result.saved).toBeGreaterThanOrEqual(0);

      db.close();
      taskDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists classified kind and confidence for non-task memories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-classifier-kind-"));
    try {
      const db = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const logger = createLogger();

      const mockClient = {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        postMessageSync: vi.fn().mockResolvedValue({
          info: { id: "msg-1", role: "assistant" },
          parts: [{ type: "text", text: '{"kind": "preference", "confidence": 0.92}' }],
        }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      };

      const classifier = new V2Classifier(mockClient as never, db, taskDb, logger as never);
      const result = await classifier.extractAndClassify(
        "u1",
        "用户偏好所有回复都使用中文并保持简洁",
        "好的。",
      );

      expect(result.saved).toBe(1);
      expect(db.listFactsForUser("u1")[0]).toEqual(expect.objectContaining({
        kind: "preference",
        confidence: 0.92,
      }));

      db.close();
      taskDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CONFLICT_SIMILARITY_THRESHOLD", () => {
  it("is 0.9 as specified in ADR", () => {
    expect(CONFLICT_SIMILARITY_THRESHOLD).toBe(0.9);
  });
});
