import type { Logger } from "../logging/logger.js";
import type { BridgeTurn, QueueNotice } from "./turn.js";

type EnqueueResult = {
  accepted: boolean;
  notice?: QueueNotice;
};

class ChatQueue {
  private readonly pending: BridgeTurn[] = [];
  private active: BridgeTurn | null = null;

  constructor(private readonly queueLimit: number, private readonly logger: Logger) {}

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

  peek(): BridgeTurn | null {
    return this.active;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  replaceActive(turn: BridgeTurn): void {
    this.active = turn;
  }

  finishActive(): void {
    this.active = null;
    if (this.pending.length > 0) {
      this.active = this.pending.shift() ?? null;
    }
  }
}

export class QueueRegistry {
  private readonly queues = new Map<string, ChatQueue>();

  constructor(private readonly queueLimit: number, private readonly logger: Logger) {}

  get(chatId: string): ChatQueue {
    const existing = this.queues.get(chatId);
    if (existing) {
      return existing;
    }

    const queue = new ChatQueue(this.queueLimit, this.logger);
    this.queues.set(chatId, queue);
    return queue;
  }
}

export type { EnqueueResult };
