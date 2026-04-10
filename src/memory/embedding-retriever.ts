import type { Logger } from "../logging/logger.js";
import type { MemoryDb } from "./db.js";
import type { MemoryRetriever } from "./retriever.js";

export interface EmbeddingProviderClient {
  readonly model: string;
  embed(text: string): Promise<number[]>;
}

type OpenAIEmbeddingResponse = {
  data?: Array<{
    embedding?: unknown;
  }>;
};

export class OpenAICompatibleEmbeddingClient implements EmbeddingProviderClient {
  readonly model: string;

  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
    model: string,
  ) {
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const url = new URL("embeddings", ensureTrailingSlash(this.baseUrl));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as OpenAIEmbeddingResponse;
    const embedding = payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
      throw new Error("embedding response missing numeric vector");
    }
    return embedding as number[];
  }
}

export class EmbeddingRetriever implements MemoryRetriever {
  constructor(
    private readonly db: MemoryDb,
    private readonly embeddingClient: EmbeddingProviderClient,
    private readonly fallback: MemoryRetriever,
    private readonly similarityThreshold: number,
    private readonly logger: Logger,
  ) {}

  async recall(userId: string, query: string, limit: number): Promise<string[]> {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingClient.embed(query);
    } catch (error) {
      this.logger.log("memory/recall", "embedding query failed, fallback to recent", {
        userId,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return this.fallback.recall(userId, query, limit);
    }

    const candidates = this.db.listEmbeddingCandidates(userId, this.embeddingClient.model);
    if (candidates.length === 0) {
      return this.fallback.recall(userId, query, limit);
    }

    const matches = candidates
      .map((candidate) => ({
        id: candidate.id,
        fact: candidate.fact,
        score: cosineSimilarity(queryEmbedding, candidate.embedding),
      }))
      .filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= this.similarityThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (matches.length === 0) {
      return this.fallback.recall(userId, query, limit);
    }

    this.db.touch(matches.map((match) => match.id));
    return matches.map((match) => match.fact);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return Number.NaN;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return Number.NaN;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`);
}
