import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MemoryDb } from "../src/memory/db.js";
import { cosineSimilarity, EmbeddingRetriever, type EmbeddingProviderClient } from "../src/memory/embedding-retriever.js";
import { RecentRetriever } from "../src/memory/recent-retriever.js";

describe("memory retrievers", () => {
  it("recent retriever returns most recently accessed facts", async () => {
    const db = new MemoryDb(await tempDbPath(), 500, 50);
    db.saveFacts("ou_1", [{ fact: "用户喜欢 TypeScript", sourceMessage: "消息 1" }]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    db.saveFacts("ou_1", [{ fact: "用户维护 bridge", sourceMessage: "消息 2" }]);

    const retriever = new RecentRetriever(db);
    const facts = await retriever.recall("ou_1", "随便", 2);
    db.close();

    expect(facts).toEqual(["用户维护 bridge", "用户喜欢 TypeScript"]);
  });

  it("embedding retriever returns semantic hits for the current model", async () => {
    const db = new MemoryDb(await tempDbPath(), 500, 50);
    const ids = db.saveFacts("ou_1", [
      { fact: "用户喜欢 AI 科技新闻", sourceMessage: "科技新闻" },
      { fact: "用户关注 TypeScript", sourceMessage: "ts" },
    ]);
    db.updateEmbedding(ids[0]!, [1, 0], "model-a");
    db.updateEmbedding(ids[1]!, [0, 1], "model-a");

    const retriever = new EmbeddingRetriever(
      db,
      fixedEmbeddingClient("model-a", [1, 0]),
      new RecentRetriever(db),
      0.75,
      logger(),
    );
    const facts = await retriever.recall("ou_1", "新闻偏好", 2);
    db.close();

    expect(facts).toEqual(["用户喜欢 AI 科技新闻"]);
  });

  it("embedding retriever falls back to recent when query embedding fails", async () => {
    const db = new MemoryDb(await tempDbPath(), 500, 50);
    db.saveFacts("ou_1", [{ fact: "用户喜欢 AI 科技新闻", sourceMessage: "科技新闻" }]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    db.saveFacts("ou_1", [{ fact: "用户关注 TypeScript", sourceMessage: "ts" }]);

    const retriever = new EmbeddingRetriever(
      db,
      {
        model: "model-a",
        async embed(): Promise<number[]> {
          throw new Error("boom");
        },
      },
      new RecentRetriever(db),
      0.75,
      logger(),
    );
    const facts = await retriever.recall("ou_1", "新闻偏好", 1);
    db.close();

    expect(facts).toEqual(["用户关注 TypeScript"]);
  });

  it("calculates cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-memory-retriever-"));
  return path.join(dir, "memory.db");
}

function fixedEmbeddingClient(model: string, embedding: number[]): EmbeddingProviderClient {
  return {
    model,
    async embed(): Promise<number[]> {
      return embedding;
    },
  };
}

function logger() {
  return {
    log: vi.fn(),
    logTranscript: vi.fn(),
  };
}
