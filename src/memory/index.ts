import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { AppConfig } from "../config/schema.js";
import { MemoryDb } from "./db.js";
import { OpenCodeMemoryExtractor, type MemoryExtractor } from "./extractor.js";

type LearnTask = {
  userId: string;
  userMessage: string;
  assistantMessage: string;
};

export class MemoryService {
  private readonly db: MemoryDb;
  private readonly extractor: MemoryExtractor;
  private readonly queue: LearnTask[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private processing = false;
  private closed = false;
  private closeWhenIdle = false;

  constructor(
    private readonly config: AppConfig["memory"],
    client: OpenCodeClient,
    private readonly logger: Logger,
    extractor?: MemoryExtractor,
  ) {
    this.db = new MemoryDb(config.dbPath, config.maxMemoriesPerUser, config.sourcePreviewLength);
    this.extractor = extractor ?? new OpenCodeMemoryExtractor(client, logger);
  }

  buildRecallBlock(userId: string, query: string): string {
    const facts = this.db.search(userId, query, this.config.searchLimit);
    this.logger.log("memory/recall", facts.length > 0 ? "hit" : "miss", { userId, count: facts.length });
    return formatRecallBlock(facts);
  }

  enqueueLearn(userId: string, userMessage: string, assistantMessage: string): void {
    if (this.closed) {
      this.logger.log("memory/learn", "dropped", { userId, reason: "closed" }, "warn");
      return;
    }

    if (this.queue.length >= this.config.extractQueueLimit) {
      this.logger.log("memory/learn", "dropped", { userId, reason: "queue-full", queueSize: this.queue.length }, "warn");
      return;
    }

    this.queue.push({ userId, userMessage, assistantMessage });
    this.logger.log("memory/learn", "queued", { userId, queueSize: this.queue.length });
    this.ensureWorker();
  }

  async drain(timeoutMs = this.config.shutdownDrainTimeoutMs): Promise<void> {
    if (!this.processing && this.queue.length === 0) {
      return;
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    if (!this.processing) {
      this.db.close();
      return;
    }
    this.closeWhenIdle = true;
  }

  private ensureWorker(): void {
    if (this.processing) {
      return;
    }

    this.processing = true;
    void this.processQueue().finally(() => {
      this.processing = false;
      this.notifyIdle();
    });
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        continue;
      }

      try {
        const facts = await this.extractor.extract(task.userMessage, task.assistantMessage);
        if (this.closed) {
          this.logger.log("memory/learn", "dropped", { userId: task.userId, reason: "closing" }, "warn");
          continue;
        }
        const result = this.db.add(task.userId, facts, task.userMessage);
        this.logger.log("memory/learn", "saved", { userId: task.userId, facts: result.saved });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.log("memory/learn", "failed", {
          userId: task.userId,
          detail,
          sourcePreview: createSourcePreview(task.userMessage, this.config.sourcePreviewLength),
        }, "warn");
      }
    }
  }

  private notifyIdle(): void {
    if (this.processing || this.queue.length > 0) {
      return;
    }

    for (const waiter of this.idleWaiters) {
      waiter();
    }
    this.idleWaiters.clear();
    if (this.closeWhenIdle) {
      this.db.close();
      this.closeWhenIdle = false;
    }
  }
}

export function formatRecallBlock(facts: string[]): string {
  if (facts.length === 0) {
    return "";
  }

  return ["[Memory Recall]", ...facts.map((fact) => `- ${fact}`)].join("\n");
}

export function appendSystemBlock(systemPrompt: string | undefined, block: string): string | undefined {
  const normalizedBlock = block.trim();
  if (!normalizedBlock) {
    return systemPrompt;
  }

  const normalizedSystem = systemPrompt?.trim();
  return normalizedSystem ? `${normalizedSystem}\n\n${normalizedBlock}` : normalizedBlock;
}

function createSourcePreview(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}
