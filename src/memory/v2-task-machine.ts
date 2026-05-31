/**
 * 职责: 实现 Memory v2 任务状态机。
 * 关注点:
 * - 合法转移：todo → doing / canceled，doing → done / canceled。
 * - 非法转移抛错。
 * - 状态变化自动写 ledger。
 */
import type { TaskDb } from "./task-db.js";
import type { LedgerDb } from "./ledger-db.js";

export type TaskStatus = "todo" | "doing" | "done" | "canceled";

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "canceled"],
  doing: ["done", "canceled"],
  done: [],
  canceled: [],
};

const LEDGER_TYPE_MAP: Record<string, string> = {
  "todo→doing": "started",
  "todo→canceled": "canceled",
  "doing→done": "completed",
  "doing→canceled": "canceled",
};

export class TaskStateMachine {
  constructor(
    private readonly taskDb: TaskDb,
    private readonly ledgerDb: LedgerDb,
  ) {}

  /**
   * 尝试转移任务状态。
   * 成功时写 ledger 并返回 true；非法转移抛错。
   */
  transition(userId: string, taskId: number, nextStatus: TaskStatus): boolean {
    const task = this.taskDb.getTask(taskId);
    if (!task) {
      throw new Error(`任务 ${taskId} 不存在`);
    }
    if (task.userId !== userId) {
      throw new Error(`任务 ${taskId} 不属于用户 ${userId}`);
    }

    const currentStatus = task.status as TaskStatus;
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed.includes(nextStatus)) {
      throw new Error(`非法状态转移：${currentStatus} → ${nextStatus}`);
    }

    this.taskDb.updateTask(taskId, { status: nextStatus });

    const ledgerType = LEDGER_TYPE_MAP[`${currentStatus}→${nextStatus}`] ?? "updated";
    this.ledgerDb.appendEvent({
      userId,
      type: ledgerType,
      summary: `任务「${task.title}」状态从 ${currentStatus} 变为 ${nextStatus}`,
      relatedTaskId: taskId,
    });

    return true;
  }

  /** 获取任务当前状态。 */
  getStatus(taskId: number): TaskStatus | null {
    const task = this.taskDb.getTask(taskId);
    return task ? (task.status as TaskStatus) : null;
  }
}
