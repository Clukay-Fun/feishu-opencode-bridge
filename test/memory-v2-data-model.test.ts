/**
 * 职责: 覆盖 Memory v2 数据模型层。
 * 关注点: v1 兼容性、新字段默认值、TaskDb / LedgerDb CRUD、迁移幂等性。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { MemoryDb } from "../src/memory/db.js";
import { TaskDb } from "../src/memory/task-db.js";
import { LedgerDb } from "../src/memory/ledger-db.js";

describe("MemoryDb v2 data model", () => {
  it("reads v1 data with new fields taking default values", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "memory-v2-compat-"));
    try {
      const dbPath = path.join(dir, "memory.db");

      // 模拟 v1 schema：只有原始 6 列 + embedding 列
      const v1Db = new Database(dbPath);
      v1Db.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          fact TEXT NOT NULL,
          source_message TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO memories (user_id, fact, source_message, created_at, accessed_at)
        VALUES ('u1', '用户偏好中文', 'msg1', 1000, 2000);
      `);
      v1Db.close();

      // 用 v2 MemoryDb 打开
      const db = new MemoryDb(dbPath, 50, 100);
      const facts = db.listFactsForUser("u1");
      expect(facts.length).toBe(1);
      const fact = facts[0]!;
      expect(fact.fact).toBe("用户偏好中文");
      expect(fact.scope).toBe("user");
      expect(fact.kind).toBe("fact");
      expect(fact.confidence).toBe(0.8);
      expect(fact.status).toBe("active");

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists new fields when saving facts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "memory-v2-fields-"));
    try {
      const dbPath = path.join(dir, "memory.db");
      const db = new MemoryDb(dbPath, 50, 100);

      db.saveFacts("u1", [{ fact: "用户是独立开发者", sourceMessage: "msg1" }]);

      const raw = new Database(dbPath, { readonly: true });
      const row = raw.prepare("SELECT scope, kind, confidence, status, expires_at, superseded_by FROM memories WHERE fact = ?").get("用户是独立开发者") as {
        scope: string; kind: string; confidence: number; status: string; expires_at: number | null; superseded_by: number | null;
      };
      expect(row.scope).toBe("user");
      expect(row.kind).toBe("fact");
      expect(row.confidence).toBe(0.8);
      expect(row.status).toBe("active");
      expect(row.expires_at).toBeNull();
      expect(row.superseded_by).toBeNull();
      raw.close();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migration is idempotent: opening twice does not error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "memory-v2-idempotent-"));
    try {
      const dbPath = path.join(dir, "memory.db");

      const db1 = new MemoryDb(dbPath, 50, 100);
      db1.saveFacts("u1", [{ fact: "test fact", sourceMessage: "msg" }]);
      db1.close();

      const db2 = new MemoryDb(dbPath, 50, 100);
      const facts = db2.listFactsForUser("u1");
      expect(facts.length).toBe(1);
      expect(facts[0]!.fact).toBe("test fact");
      db2.close();

      const db3 = new MemoryDb(dbPath, 50, 100);
      const facts3 = db3.listFactsForUser("u1");
      expect(facts3.length).toBe(1);
      db3.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TaskDb", () => {
  it("creates, gets, lists, updates, and deletes tasks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "task-db-crud-"));
    try {
      const db = new TaskDb(path.join(dir, "tasks.db"));

      const id1 = db.createTask({ userId: "u1", title: "发布 v0.3", dueAt: Date.now() + 86400_000 });
      const id2 = db.createTask({ userId: "u1", title: "审查 PR #72", status: "doing" });
      db.createTask({ userId: "u2", title: "其他用户的任务" });

      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(0);

      const task = db.getTask(id1);
      expect(task).toBeDefined();
      expect(task!.title).toBe("发布 v0.3");
      expect(task!.status).toBe("todo");
      expect(task!.scope).toBe("user");

      const tasks = db.listTasks("u1");
      expect(tasks.length).toBe(2);

      const doingTasks = db.listTasks("u1", { status: "doing" });
      expect(doingTasks.length).toBe(1);
      expect(doingTasks[0]!.title).toBe("审查 PR #72");

      db.updateTask(id1, { status: "done" });
      const updated = db.getTask(id1);
      expect(updated!.status).toBe("done");

      expect(db.deleteTask(id2)).toBe(true);
      expect(db.getTask(id2)).toBeUndefined();

      db.deleteUserTasks("u1");
      expect(db.listTasks("u1").length).toBe(0);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LedgerDb", () => {
  it("appends events and queries by time and type", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-db-crud-"));
    try {
      const db = new LedgerDb(path.join(dir, "ledger.db"));

      const id1 = db.appendEvent({ userId: "u1", type: "created", summary: "创建 issue #72" });
      db.appendEvent({ userId: "u1", type: "completed", summary: "完成 PR #72", relatedIssueUrl: "https://github.com/xxx/72" });
      db.appendEvent({ userId: "u1", type: "created", summary: "创建 issue #73" });
      db.appendEvent({ userId: "u2", type: "created", summary: "其他用户的事件" });

      expect(id1).toBeGreaterThan(0);

      const allEvents = db.queryByTime("u1");
      expect(allEvents.length).toBe(3);

      const createdEvents = db.queryByType("u1", "created");
      expect(createdEvents.length).toBe(2);

      const completedEvents = db.queryByType("u1", "completed");
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0]!.relatedIssueUrl).toBe("https://github.com/xxx/72");

      db.deleteUserEvents("u1");
      expect(db.queryByTime("u1").length).toBe(0);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TaskDb checklists", () => {
  it("creates, gets, lists, updates, and deletes checklists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "checklist-db-crud-"));
    try {
      const db = new TaskDb(path.join(dir, "tasks.db"));

      const id = db.createChecklist({
        userId: "u1",
        name: "发布前检查",
        reusable: true,
        items: [{ text: "运行测试" }, { text: "更新 changelog" }],
      });

      expect(id).toBeGreaterThan(0);

      const checklist = db.getChecklist(id);
      expect(checklist).toBeDefined();
      expect(checklist!.name).toBe("发布前检查");
      expect(checklist!.reusable).toBe(1);
      const items = JSON.parse(checklist!.items) as Array<{ text: string; checked: boolean }>;
      expect(items.length).toBe(2);

      db.updateChecklist(id, { items: [{ text: "运行测试", checked: true }, { text: "更新 changelog" }] });
      const updated = db.getChecklist(id);
      const updatedItems = JSON.parse(updated!.items) as Array<{ text: string; checked: boolean }>;
      expect(updatedItems[0]!.checked).toBe(true);

      expect(db.deleteChecklist(id)).toBe(true);
      expect(db.getChecklist(id)).toBeUndefined();

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
