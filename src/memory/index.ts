import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { AppConfig } from "../config/schema.js";
import { MemoryDb } from "./db.js";
import { OpenCodeMemoryExtractor, type MemoryExtractor } from "./extractor.js";
import {
  EmbeddingRetriever,
  OpenAICompatibleEmbeddingClient,
  type EmbeddingProviderClient,
} from "./embedding-retriever.js";
import { ObsidianSyncService } from "./obsidian-sync.js";
import { RecentRetriever } from "./recent-retriever.js";
import type { MemoryRetriever } from "./retriever.js";

type LearnTask = {
  userId: string;
  userMessage: string;
  assistantMessage: string;
};

type MemoryServiceConfig = AppConfig["memory"];
type EmbeddingsConfig = NonNullable<AppConfig["embeddings"]>;

export class MemoryService {
  private readonly db: MemoryDb;
  private readonly extractor: MemoryExtractor;
  private readonly retriever: MemoryRetriever;
  private readonly embeddingClient: EmbeddingProviderClient | null;
  private readonly obsidianSync: ObsidianSyncService | null;
  private readonly queue: LearnTask[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private processing = false;
  private accepting = true;
  private closed = false;

  constructor(
    private readonly config: MemoryServiceConfig,
    private readonly embeddingsConfig: EmbeddingsConfig,
    client: OpenCodeClient,
    private readonly logger: Logger,
    extractor?: MemoryExtractor,
  ) {
    this.db = new MemoryDb(config.dbPath, config.maxMemoriesPerUser, config.sourcePreviewLength);
    this.extractor = extractor ?? new OpenCodeMemoryExtractor(client, logger);

    const recentRetriever = new RecentRetriever(this.db);
    if (config.retriever === "embedding" && embeddingsConfig.provider) {
      this.embeddingClient = new OpenAICompatibleEmbeddingClient(
        embeddingsConfig.provider.baseUrl,
        embeddingsConfig.provider.apiKey,
        embeddingsConfig.provider.model,
      );
      this.retriever = new EmbeddingRetriever(
        this.db,
        this.embeddingClient,
        recentRetriever,
        embeddingsConfig.similarityThreshold,
        logger,
      );
    } else {
      this.embeddingClient = null;
      this.retriever = recentRetriever;
    }

    this.obsidianSync = config.obsidian.enabled
      ? new ObsidianSyncService(config.obsidian, this.db, logger)
      : null;
  }

  async start(): Promise<void> {
    await this.obsidianSync?.start();
  }

  async stop(): Promise<void> {
    this.accepting = false;
    await this.drain(this.config.shutdownDrainTimeoutMs);
    this.closed = true;
    await this.obsidianSync?.stop();
    this.db.close();
  }

  async buildRecallBlock(userId: string, query: string): Promise<string> {
    const facts = await this.retriever.recall(userId, query, this.config.searchLimit);
    this.logger.log("memory/recall", facts.length > 0 ? "hit" : "miss", {
      userId,
      count: facts.length,
      retriever: this.config.retriever,
    });
    return formatRecallBlock(facts);
  }

  enqueueLearn(userId: string, userMessage: string, assistantMessage: string): void {
    if (!this.accepting) {
      this.logger.log("memory/learn", "dropped", { userId, reason: "closed" }, "warn");
      return;
    }

    if (this.queue.length >= this.config.extractQueueLimit) {
      this.logger.log("memory/learn", "dropped", {
        userId,
        reason: "queue-full",
        queueSize: this.queue.length,
      }, "warn");
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
        const extractedFacts = await this.extractor.extract(task.userMessage, task.assistantMessage);
        const normalizedFacts = dedupeFacts(extractedFacts);
        if (this.closed) {
          this.logger.log("memory/learn", "dropped", { userId: task.userId, reason: "closed" }, "warn");
          continue;
        }
        const ids = this.db.saveFacts(
          task.userId,
          normalizedFacts.map((fact) => ({ fact, sourceMessage: task.userMessage })),
        );
        await this.updateEmbeddings(ids, normalizedFacts);
        this.logger.log("memory/learn", "saved", { userId: task.userId, facts: ids.length });
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

  private async updateEmbeddings(ids: number[], facts: string[]): Promise<void> {
    if (!this.embeddingClient) {
      return;
    }

    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const fact = facts[index];
      if (!id || !fact) {
        continue;
      }
      try {
        const embedding = await this.embeddingClient.embed(fact);
        this.db.updateEmbedding(id, embedding, this.embeddingClient.model);
      } catch (error) {
        this.logger.log("memory/learn", "embedding failed", {
          id,
          detail: error instanceof Error ? error.message : String(error),
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

function dedupeFacts(facts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fact of facts.map((value) => value.trim()).filter(Boolean)) {
    if (seen.has(fact)) {
      continue;
    }
    seen.add(fact);
    result.push(fact);
  }
  return result;
}
