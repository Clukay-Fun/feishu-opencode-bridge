/**
 * 职责: 覆盖 Memory v2 Task 状态机和 Orchestrator。
 * 关注点: 合法/非法状态转移、到期检测、Orchestrator 输出结构、提醒频率控制。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryDb } from "../src/memory/db.js";
import { TaskDb } from "../src/memory/task-db.js";
import { LedgerDb } from "../src/memory/ledger-db.js";
import { TaskStateMachine } from "../src/memory/v2-task-machine.js";
import { V2Orchestrator } from "../src/memory/v2-orchestrator.js";
import { RecentRetriever } from "../src/memory/recent-retriever.js";

describe("TaskStateMachine", () => {
  it("allows valid transitions and writes ledger", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "task-machine-"));
    try {
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const machine = new TaskStateMachine(taskDb, ledgerDb);

      const taskId = taskDb.createTask({ userId: "u1", title: "发布 v0.3" });

      expect(machine.transition("u1", taskId, "doing")).toBe(true);
      expect(machine.getStatus(taskId)).toBe("doing");

      expect(machine.transition("u1", taskId, "done")).toBe(true);
      expect(machine.getStatus(taskId)).toBe("done");

      // 检查 ledger
      const events = ledgerDb.queryByTime("u1");
      expect(events.length).toBe(2);
      expect(events[1]!.type).toBe("started");
      expect(events[0]!.type).toBe("completed");

      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid transitions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "task-machine-invalid-"));
    try {
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const machine = new TaskStateMachine(taskDb, ledgerDb);

      const taskId = taskDb.createTask({ userId: "u1", title: "测试任务" });

      // done → todo 是非法的
      machine.transition("u1", taskId, "doing");
      machine.transition("u1", taskId, "done");
      expect(() => machine.transition("u1", taskId, "todo")).toThrow("非法状态转移");

      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects transitions for non-existent tasks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "task-machine-noexist-"));
    try {
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const machine = new TaskStateMachine(taskDb, ledgerDb);

      expect(() => machine.transition("u1", 999, "doing")).toThrow("不存在");

      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("V2Orchestrator", () => {
  it("returns memories, due tasks, and checklists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const retriever = new RecentRetriever(memoryDb);

      memoryDb.saveFacts("u1", [{ fact: "用户偏好中文", sourceMessage: "msg" }]);

      // 创建到期任务
      taskDb.createTask({ userId: "u1", title: "发布 v0.3", dueAt: Date.now() - 1000 });
      // 创建未到期任务
      taskDb.createTask({ userId: "u1", title: "审查 PR", dueAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });

      const orchestrator = new V2Orchestrator(memoryDb, taskDb, ledgerDb, retriever);
      const result = await orchestrator.orchestrate({ userId: "u1", query: "测试" });

      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0]!.title).toBe("发布 v0.3");
      expect(result.totalChars).toBeGreaterThan(0);

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not repeat reminders within 24h", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-reminder-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const retriever = new RecentRetriever(memoryDb);

      const taskId = taskDb.createTask({ userId: "u1", title: "到期任务", dueAt: Date.now() - 1000 });
      // 模拟已提醒
      ledgerDb.appendEvent({ userId: "u1", type: "reminded", summary: "提醒", relatedTaskId: taskId });

      const orchestrator = new V2Orchestrator(memoryDb, taskDb, ledgerDb, retriever);
      const result = await orchestrator.orchestrate({ userId: "u1", query: "测试" });

      // 已提醒过的任务不再出现
      expect(result.tasks.length).toBe(0);

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters project scoped tasks, checklists, ledger, and memories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-scope-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const retriever = new RecentRetriever(memoryDb);

      memoryDb.saveFacts("u1", [
        { fact: "全局偏好中文", sourceMessage: "msg", scope: "user" },
        { fact: "A 项目使用 SQLite", sourceMessage: "msg", scope: "project:a" },
        { fact: "B 项目使用 Postgres", sourceMessage: "msg", scope: "project:b" },
      ]);
      taskDb.createTask({ userId: "u1", title: "A 到期任务", scope: "project:a", dueAt: Date.now() - 1000 });
      taskDb.createTask({ userId: "u1", title: "B 到期任务", scope: "project:b", dueAt: Date.now() - 1000 });
      taskDb.createChecklist({
        userId: "u1",
        scope: "project:a",
        name: "A 检查清单",
        items: [{ text: "确认范围" }],
      });
      taskDb.createChecklist({
        userId: "u1",
        scope: "project:b",
        name: "B 检查清单",
        items: [{ text: "确认范围" }],
      });
      ledgerDb.appendEvent({ userId: "u1", scope: "project:a", type: "note", summary: "A 最近进展" });
      ledgerDb.appendEvent({ userId: "u1", scope: "project:b", type: "note", summary: "B 最近进展" });

      const orchestrator = new V2Orchestrator(memoryDb, taskDb, ledgerDb, retriever);
      const result = await orchestrator.orchestrate({ userId: "u1", query: "项目", scope: "project:a" });

      expect(result.memories).toContain("全局偏好中文");
      expect(result.memories).toContain("A 项目使用 SQLite");
      expect(result.memories).not.toContain("B 项目使用 Postgres");
      expect(result.tasks.map((task) => task.title)).toEqual(["A 到期任务"]);
      expect(result.checklists.map((checklist) => checklist.name)).toEqual(["A 检查清单"]);
      expect(result.ledgerSummary).toContain("A 最近进展");
      expect(result.ledgerSummary).not.toContain("B 最近进展");

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trims output to fit budget", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-trim-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const retriever = new RecentRetriever(memoryDb);

      // 添加多条 memories
      for (let i = 0; i < 20; i++) {
        memoryDb.saveFacts("u1", [{ fact: `记忆项 ${i}：${"x".repeat(50)}`, sourceMessage: "msg" }]);
      }

      const orchestrator = new V2Orchestrator(memoryDb, taskDb, ledgerDb, retriever);
      const result = await orchestrator.orchestrate({ userId: "u1", query: "测试", maxContextChars: 200 });

      expect(result.totalChars).toBeLessThanOrEqual(200);

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
