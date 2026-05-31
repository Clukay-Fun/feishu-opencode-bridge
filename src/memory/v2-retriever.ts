/**
 * 职责: 实现 Memory v2 相关性召回。
 * 关注点:
 * - 组合 recency / scope / kind / embedding 四维度打分。
 * - embedding 不可用时自动降级到 recent-only + scope/kind 过滤。
 * - 不删除 v1 的 retriever，保留作为 fallback。
 */
import type { Logger } from "../logging/logger.js";
import type { MemoryDb } from "./db.js";
import type { EmbeddingProviderClient } from "./embedding-retriever.js";
import { cosineSimilarity } from "./embedding-retriever.js";
import type { MemoryRetriever } from "./retriever.js";

/** v2 召回候选，包含各维度打分。 */
type ScoredCandidate = {
  id: number;
  fact: string;
  score: number;
  recencyScore: number;
  scopeScore: number;
  kindScore: number;
  embeddingScore: number;
};

/** kind 权重：profile / preference / constraint 高于普通 fact。 */
const KIND_WEIGHTS: Record<string, number> = {
  profile: 1.0,
  project: 0.9,
  preference: 1.0,
  constraint: 1.0,
  fact: 0.6,
  task_candidate: 0.3,
};

/** status 权重。 */
const STATUS_WEIGHTS: Record<string, number> = {
  active: 1.0,
  superseded: 0.1,
  archived: 0.05,
};

/** recency 衰减半衰期（毫秒）。 */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/** 冲突检测相似度阈值。 */
export const CONFLICT_SIMILARITY_THRESHOLD = 0.9;

export class V2Retriever implements MemoryRetriever {
  constructor(
    private readonly db: MemoryDb,
    private readonly embeddingClient: EmbeddingProviderClient | null,
    private readonly fallback: MemoryRetriever,
    private readonly logger: Logger,
  ) {}

  async recall(userId: string, query: string, limit: number, options?: { scope?: string }): Promise<string[]> {
    const now = Date.now();

    // 获取用户所有 active memories
    const allMemories = this.db.listFactsForUser(userId, options?.scope)
      .filter((m) => m.status !== "archived");

    if (allMemories.length === 0) {
      return [];
    }

    // 尝试获取 query embedding
    let queryEmbedding: number[] | null = null;
    if (this.embeddingClient) {
      try {
        queryEmbedding = await this.embeddingClient.embed(query);
      } catch (error) {
        this.logger.log("memory/v2-retriever", "embedding unavailable, degrading to recent-only", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      }
    }

    // 获取 embedding candidates（如果有 embedding client）
    const embeddingMap = new Map<number, number[]>();
    if (this.embeddingClient && queryEmbedding) {
      const candidates = this.db.listEmbeddingCandidates(userId, this.embeddingClient.model, options?.scope);
      for (const c of candidates) {
        embeddingMap.set(c.id, c.embedding);
      }
    }

    // 打分
    const scored = allMemories.map((memory) => {
      const recencyScore = computeRecencyScore(memory.accessedAt, now);
      const scopeScore = computeScopeScore(memory.scope, options?.scope);
      const kindScore = KIND_WEIGHTS[memory.kind] ?? 0.6;
      const statusScore = STATUS_WEIGHTS[memory.status] ?? 1.0;

      let embeddingScore = 0;
      if (queryEmbedding) {
        const memoryEmbedding = embeddingMap.get(memory.id);
        if (memoryEmbedding) {
          const sim = cosineSimilarity(queryEmbedding, memoryEmbedding);
          embeddingScore = Number.isFinite(sim) ? Math.max(0, sim) : 0;
        }
      }

      // 组合打分：embedding 可用时权重 0.4，否则 recency 主导
      const hasEmbedding = queryEmbedding && embeddingMap.has(memory.id);
      const score = hasEmbedding
        ? (recencyScore * 0.25 + scopeScore * 0.1 + kindScore * 0.25 + embeddingScore * 0.4) * statusScore
        : (recencyScore * 0.5 + scopeScore * 0.15 + kindScore * 0.35) * statusScore;

      return {
        id: memory.id,
        fact: memory.fact,
        score,
        recencyScore,
        scopeScore,
        kindScore,
        embeddingScore,
      } satisfies ScoredCandidate;
    });

    // 排序 + 截断
    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (top.length === 0) {
      return this.fallback.recall(userId, query, limit, options);
    }

    this.db.touch(top.map((m) => m.id));
    return top.map((m) => m.fact);
  }
}

function computeScopeScore(memoryScope: string, requestedScope: string | undefined): number {
  if (!requestedScope || requestedScope === "user") {
    return memoryScope === "user" ? 1.0 : 0.75;
  }
  if (memoryScope === requestedScope) {
    return 1.0;
  }
  return memoryScope === "user" ? 0.8 : 0.2;
}

/** 计算 recency 分数：指数衰减。 */
function computeRecencyScore(accessedAt: number, now: number): number {
  const ageMs = Math.max(0, now - accessedAt);
  return Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);
}
