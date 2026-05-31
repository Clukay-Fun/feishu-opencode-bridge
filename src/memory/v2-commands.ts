/**
 * 职责: 实现 Memory v2 用户可见的隐私控制命令。
 * 关注点:
 * - 查看、删除、暂停、恢复、导出。
 * - 删除是 SQL DELETE，不是软删。
 * - 暂停状态持久化跨重启。
 * - 命令实现不直接耦合 command-handler。
 */
import type Database from "better-sqlite3";
import type { Logger } from "../logging/logger.js";
import type { MemoryDb, MemoryFactRecord } from "./db.js";
import type { TaskDb, WorkTaskRow } from "./task-db.js";
import type { LedgerDb, LedgerEventRow } from "./ledger-db.js";

export type MemoryCommandResult = {
  ok: boolean;
  message: string;
  data?: unknown;
};

export type MemoryExportData = {
  memories: MemoryFactRecord[];
  tasks: WorkTaskRow[];
  ledger: LedgerEventRow[];
  exportedAt: string;
};

export class V2Commands {
  constructor(
    private readonly memoryDb: MemoryDb,
    private readonly taskDb: TaskDb,
    private readonly ledgerDb: LedgerDb,
    private readonly logger: Logger,
  ) {}

  // #region 查看

  /** /memory：列出最近 20 条 active memories。 */
  listMemories(userId: string, limit = 20): MemoryCommandResult {
    const memories = this.memoryDb.listFactsForUser(userId)
      .filter((m) => m.status === "active")
      .slice(0, limit);
    return {
      ok: true,
      message: `找到 ${memories.length} 条记忆`,
      data: memories,
    };
  }

  /** /tasks：列出未完成 tasks。 */
  listTasks(userId: string): MemoryCommandResult {
    const todoTasks = this.taskDb.listTasks(userId, { status: "todo" });
    const doingTasks = this.taskDb.listTasks(userId, { status: "doing" });
    return {
      ok: true,
      message: `待办 ${todoTasks.length} 条，进行中 ${doingTasks.length} 条`,
      data: { todo: todoTasks, doing: doingTasks },
    };
  }

  /** /ledger：列出最近 30 天 ledger events。 */
  listLedger(userId: string, days = 30): MemoryCommandResult {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const events = this.ledgerDb.queryByTime(userId, { since, limit: 50 });
    return {
      ok: true,
      message: `最近 ${days} 天有 ${events.length} 条记录`,
      data: events,
    };
  }

  // #endregion

  // #region 删除

  /** /memory delete <id>：删除指定 memory。真删。 */
  deleteMemory(userId: string, id: number): MemoryCommandResult {
    const memories = this.memoryDb.listFactsForUser(userId);
    const target = memories.find((m) => m.id === id);
    if (!target) {
      return { ok: false, message: `记忆 #${id} 不存在` };
    }
    // 真删：直接 DELETE
    const rawDb = (this.memoryDb as unknown as { db: Database.Database }).db;
    const result = rawDb.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").run(id, userId);
    if (result.changes === 0) {
      return { ok: false, message: `删除失败` };
    }
    return { ok: true, message: `已删除记忆 #${id}：${target.fact}` };
  }

  /** /memory delete kind:<kind>：删除指定 kind 的全部 memories。 */
  deleteMemoriesByKind(userId: string, kind: string): MemoryCommandResult {
    const memories = this.memoryDb.listFactsForUser(userId).filter((m) => m.kind === kind);
    if (memories.length === 0) {
      return { ok: false, message: `没有 kind=${kind} 的记忆` };
    }
    const rawDb = (this.memoryDb as unknown as { db: Database.Database }).db;
    const result = rawDb.prepare("DELETE FROM memories WHERE user_id = ? AND kind = ?").run(userId, kind);
    return { ok: true, message: `已删除 ${result.changes} 条 kind=${kind} 的记忆` };
  }

  /** /task delete <id>：删除指定 task。真删。 */
  deleteTask(userId: string, id: number): MemoryCommandResult {
    const task = this.taskDb.getTask(id);
    if (!task || task.userId !== userId) {
      return { ok: false, message: `任务 #${id} 不存在` };
    }
    this.taskDb.deleteTask(id);
    return { ok: true, message: `已删除任务 #${id}：${task.title}` };
  }

  // #endregion

  // #region 暂停/恢复

  /** /memory pause：暂停自动学习。 */
  pauseLearning(userId: string): MemoryCommandResult {
    this.setSetting(userId, "learning_paused", "true");
    return { ok: true, message: "已暂停自动学习。已有记忆保留，新对话不再提取。" };
  }

  /** /memory resume：恢复自动学习。 */
  resumeLearning(userId: string): MemoryCommandResult {
    this.setSetting(userId, "learning_paused", "false");
    return { ok: true, message: "已恢复自动学习。" };
  }

  /** 检查用户是否暂停了学习。 */
  isLearningPaused(userId: string): boolean {
    return this.getSetting(userId, "learning_paused") === "true";
  }

  // #endregion

  // #region 导出

  /** /memory export：导出当前用户的 memories + tasks + ledger。 */
  exportUserData(userId: string): MemoryCommandResult {
    const memories = this.memoryDb.listFactsForUser(userId);
    const tasks = this.taskDb.listTasks(userId, { limit: 500 });
    const events = this.ledgerDb.queryByTime(userId, { limit: 500 });
    const data: MemoryExportData = {
      memories,
      tasks,
      ledger: events,
      exportedAt: new Date().toISOString(),
    };
    return {
      ok: true,
      message: `导出完成：${memories.length} 条记忆、${tasks.length} 条任务、${events.length} 条记录`,
      data,
    };
  }

  // #endregion

  // #region 持久化设置

  private setSetting(userId: string, key: string, value: string): void {
    const rawDb = (this.memoryDb as unknown as { db: Database.Database }).db;
    rawDb.prepare(`
      INSERT INTO memory_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(userId, key, value, Date.now());
  }

  private getSetting(userId: string, key: string): string | null {
    const rawDb = (this.memoryDb as unknown as { db: Database.Database }).db;
    const row = rawDb.prepare("SELECT value FROM memory_settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  // #endregion
}
