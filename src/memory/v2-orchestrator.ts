/**
 * 职责: 实现 Memory v2 Context Orchestrator。
 * 关注点:
 * - 每轮 turn 前决定注入哪些 Memory / Task / Checklist。
 * - 到期 task 自动参与召回。
 * - 提醒频率控制：同一 task 24h 内不重复提醒。
 * - 上下文超长时按优先级裁剪。
 * - Orchestrator 不持有自己的 DB 表。
 */
import type { MemoryDb } from "./db.js";
import type { TaskDb, WorkTaskRow, ChecklistRow } from "./task-db.js";
import type { LedgerDb } from "./ledger-db.js";
import type { MemoryRetriever } from "./retriever.js";

export type OrchestratorInput = {
  userId: string;
  query: string;
  maxContextChars?: number;
  scope?: string;
};

export type OrchestratorOutput = {
  memories: string[];
  tasks: WorkTaskRow[];
  checklists: ChecklistRow[];
  ledgerSummary?: string;
  totalChars: number;
};

const DEFAULT_MAX_CONTEXT_CHARS = 2000;
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

export class V2Orchestrator {
  constructor(
    private readonly memoryDb: MemoryDb,
    private readonly taskDb: TaskDb,
    private readonly ledgerDb: LedgerDb,
    private readonly retriever: MemoryRetriever,
  ) {}

  /**
   * 编排当前 turn 的上下文注入。
   * 返回 memories / tasks / checklists / ledgerSummary。
   */
  async orchestrate(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const maxChars = input.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
    const now = Date.now();

    // 1. 召回相关 memories
    const scopeOptions = input.scope ? { scope: input.scope } : undefined;
    const memories = await this.retriever.recall(input.userId, input.query, 10, scopeOptions);

    // 2. 查询到期 tasks（due_at <= now + 24h）
    const dueTasks = this.getDueTasks(input.userId, now, input.scope);

    // 3. 查询 active checklists
    const checklists = this.taskDb.listChecklists(input.userId, 5, scopeOptions);

    // 4. 最近 ledger 摘要
    const recentLedger = this.ledgerDb.queryByTime(input.userId, {
      since: now - 7 * 24 * 60 * 60 * 1000,
      limit: 5,
      ...(input.scope ? { scope: input.scope } : {}),
    });
    const ledgerSummary = recentLedger.length > 0
      ? recentLedger.map((e) => `- ${e.summary}`).join("\n")
      : undefined;

    // 5. 按优先级裁剪
    return this.trimToBudget({
      memories,
      tasks: dueTasks,
      checklists,
      ledgerSummary,
    }, maxChars);
  }

  /** 查询到期任务，控制提醒频率。 */
  private getDueTasks(userId: string, now: number, scope?: string): WorkTaskRow[] {
    const allTasks = this.taskDb.listTasks(userId, {
      status: "todo",
      ...(scope ? { scope } : {}),
    });
    const doingTasks = this.taskDb.listTasks(userId, {
      status: "doing",
      ...(scope ? { scope } : {}),
    });
    const candidates = [...allTasks, ...doingTasks];

    return candidates.filter((task) => {
      if (!task.dueAt) return false;
      if (task.dueAt > now + 24 * 60 * 60 * 1000) return false;
      return !this.wasRecentlyReminded(userId, task.id, now, scope);
    });
  }

  /** 检查是否在 24h 内已提醒过该 task。 */
  private wasRecentlyReminded(userId: string, taskId: number, now: number, scope?: string): boolean {
    const events = this.ledgerDb.queryByType(userId, "reminded", 20, scope ? { scope } : undefined);
    return events.some((e) =>
      e.relatedTaskId === taskId && e.createdAt >= now - REMINDER_COOLDOWN_MS
    );
  }

  /** 按优先级裁剪到预算内。优先级：到期 task > 高 confidence memory > checklist > 历史 memory。 */
  private trimToBudget(
    data: { memories: string[]; tasks: WorkTaskRow[]; checklists: ChecklistRow[]; ledgerSummary?: string | undefined },
    maxChars: number,
  ): OrchestratorOutput {
    let remaining = maxChars;
    const result: OrchestratorOutput = {
      memories: [],
      tasks: [],
      checklists: [],
      totalChars: 0,
    };

    // 到期 tasks（最高优先级）
    for (const task of data.tasks) {
      const text = `[待办] ${task.title}${task.dueAt ? ` (截止: ${new Date(task.dueAt).toLocaleDateString()})` : ""}`;
      if (remaining >= text.length) {
        result.tasks.push(task);
        remaining -= text.length;
      }
    }

    // Memories
    for (const memory of data.memories) {
      if (remaining >= memory.length) {
        result.memories.push(memory);
        remaining -= memory.length;
      }
    }

    // Checklists
    for (const checklist of data.checklists) {
      const text = `[清单] ${checklist.name}`;
      if (remaining >= text.length) {
        result.checklists.push(checklist);
        remaining -= text.length;
      }
    }

    // Ledger summary（最低优先级）
    if (data.ledgerSummary && remaining >= data.ledgerSummary.length) {
      result.ledgerSummary = data.ledgerSummary;
      remaining -= data.ledgerSummary.length;
    }

    result.totalChars = maxChars - remaining;
    return result;
  }
}
