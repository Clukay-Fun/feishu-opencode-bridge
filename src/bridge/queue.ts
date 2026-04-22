/**
 * 职责: 提供 turn 队列与多队列注册表。
 * 关注点:
 * - 维护单队列中的 active turn 与 pending turns。
 * - 按窗口或 execution key 管理队列实例。
 */
import type { Logger } from "../logging/logger.js";
import type { BridgeTurn, QueueNotice } from "./turn.js";

type EnqueueResult = {
  accepted: boolean;
  notice?: QueueNotice;
};

/** 管理单个会话窗口或执行键下的 turn 队列。 */
class ChatQueue {
  private readonly pending: BridgeTurn[] = [];
  private active: BridgeTurn | null = null;

  constructor(private readonly queueLimit: number, private readonly logger: Logger) {}

  /** 把新 turn 放入队列；若队列已满则拒绝。 */
  enqueue(turn: BridgeTurn): EnqueueResult {
    if (this.active || this.pending.length > 0) {
      if (this.pending.length >= this.queueLimit) {
        return { accepted: false, notice: { message: "当前排队已满，请稍后再试。" } };
      }

      this.pending.push({ ...turn, state: "queued" });
      return {
        accepted: true,
        notice: { message: `⏳ 排在第${this.pending.length}位，前面还有${this.pending.length}轮在处理。` },
      };
    }

    this.active = { ...turn, state: "queued" };
    return { accepted: true };
  }

  /** 返回当前可执行 turn；必要时从 pending 中提升。 */
  current(): BridgeTurn | null {
    if (this.active) {
      return this.active;
    }

    if (this.pending.length === 0) {
      return null;
    }

    this.active = this.pending.shift() ?? null;
    return this.active;
  }

  /** 仅查看当前 active turn，不推进队列。 */
  peek(): BridgeTurn | null {
    return this.active;
  }

  /** 返回尚未执行的排队数量。 */
  pendingCount(): number {
    return this.pending.length;
  }

  /** 用新状态替换当前 active turn。 */
  replaceActive(turn: BridgeTurn): void {
    this.active = turn;
  }

  /** 结束当前 active turn，并把下一个 pending 提升为 active。 */
  finishActive(): void {
    this.active = null;
    if (this.pending.length > 0) {
      this.active = this.pending.shift() ?? null;
    }
  }
}

/** 以 key 为单位管理多个 ChatQueue。 */
export class QueueRegistry {
  private readonly queues = new Map<string, ChatQueue>();

  constructor(private readonly queueLimit: number, private readonly logger: Logger) {}

  /** 获取指定 key 的队列；不存在时自动创建。 */
  get(chatId: string): ChatQueue {
    const existing = this.queues.get(chatId);
    if (existing) {
      return existing;
    }

    const queue = new ChatQueue(this.queueLimit, this.logger);
    this.queues.set(chatId, queue);
    return queue;
  }

  /** 返回已存在的队列；若不存在则返回 null。 */
  getIfExists(key: string): ChatQueue | null {
    return this.queues.get(key) ?? null;
  }

  /** 列出指定前缀下的所有相关队列。 */
  listByPrefix(prefix: string): ChatQueue[] {
    const scopedPrefix = `${prefix}::`;
    return [...this.queues.entries()]
      .filter(([key]) => key === prefix || key.startsWith(scopedPrefix))
      .map(([, queue]) => queue);
  }
}

export type { EnqueueResult };
