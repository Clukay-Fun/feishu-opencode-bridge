/**
 * 职责: 覆盖 Memory v2 隐私控制命令。
 * 关注点: 查看、删除（真删）、暂停/恢复、导出。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MemoryDb } from "../src/memory/db.js";
import { TaskDb } from "../src/memory/task-db.js";
import { LedgerDb } from "../src/memory/ledger-db.js";
import { V2Commands } from "../src/memory/v2-commands.js";

function createLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };
}

describe("V2Commands", () => {
  it("lists memories for a user", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-cmd-list-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const commands = new V2Commands(memoryDb, taskDb, ledgerDb, createLogger() as never);

      memoryDb.saveFacts("u1", [
        { fact: "用户偏好中文", sourceMessage: "msg1" },
        { fact: "用户住深圳", sourceMessage: "msg2" },
      ]);

      const result = commands.listMemories("u1");
      expect(result.ok).toBe(true);
      expect((result.data as any[]).length).toBe(2);

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes a memory by id (real DELETE)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-cmd-delete-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const commands = new V2Commands(memoryDb, taskDb, ledgerDb, createLogger() as never);

      memoryDb.saveFacts("u1", [{ fact: "要删除的记忆", sourceMessage: "msg" }]);
      const memories = memoryDb.listFactsForUser("u1");
      const id = memories[0]!.id;

      const result = commands.deleteMemory("u1", id);
      expect(result.ok).toBe(true);
      expect(memoryDb.listFactsForUser("u1").length).toBe(0);

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pauses and resumes learning", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-cmd-pause-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const commands = new V2Commands(memoryDb, taskDb, ledgerDb, createLogger() as never);

      expect(commands.isLearningPaused("u1")).toBe(false);

      commands.pauseLearning("u1");
      expect(commands.isLearningPaused("u1")).toBe(true);

      commands.resumeLearning("u1");
      expect(commands.isLearningPaused("u1")).toBe(false);

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exports user data with memories, tasks, and ledger", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-cmd-export-"));
    try {
      const memoryDb = new MemoryDb(path.join(dir, "memory.db"), 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const commands = new V2Commands(memoryDb, taskDb, ledgerDb, createLogger() as never);

      memoryDb.saveFacts("u1", [{ fact: "测试记忆", sourceMessage: "msg" }]);
      taskDb.createTask({ userId: "u1", title: "测试任务" });
      ledgerDb.appendEvent({ userId: "u1", type: "created", summary: "创建测试" });

      const result = commands.exportUserData("u1");
      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.memories.length).toBe(1);
      expect(data.tasks.length).toBe(1);
      expect(data.ledger.length).toBe(1);
      expect(data.exportedAt).toBeDefined();

      memoryDb.close();
      taskDb.close();
      ledgerDb.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists pause state across restarts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "v2-cmd-persist-"));
    try {
      const dbPath = path.join(dir, "memory.db");
      const memoryDb = new MemoryDb(dbPath, 50, 100);
      const taskDb = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb = new LedgerDb(path.join(dir, "ledger.db"));
      const commands = new V2Commands(memoryDb, taskDb, ledgerDb, createLogger() as never);

      commands.pauseLearning("u1");
      memoryDb.close();
      taskDb.close();
      ledgerDb.close();

      // 重新打开
      const memoryDb2 = new MemoryDb(dbPath, 50, 100);
      const taskDb2 = new TaskDb(path.join(dir, "tasks.db"));
      const ledgerDb2 = new LedgerDb(path.join(dir, "ledger.db"));
      const commands2 = new V2Commands(memoryDb2, taskDb2, ledgerDb2, createLogger() as never);

      expect(commands2.isLearningPaused("u1")).toBe(true);

      memoryDb2.close();
      taskDb2.close();
      ledgerDb2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
