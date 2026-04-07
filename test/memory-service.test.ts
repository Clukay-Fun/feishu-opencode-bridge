import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryService, appendSystemBlock, formatRecallBlock } from "../src/memory/index.js";
import type { MemoryExtractor } from "../src/memory/extractor.js";
import { OpenCodeClient } from "../src/opencode/client.js";

const logger = { log() {}, logTranscript() {} };

function makeConfig(dbPath: string, overrides: Partial<{
  maxMemoriesPerUser: number;
  searchLimit: number;
  extractQueueLimit: number;
  sourcePreviewLength: number;
  shutdownDrainTimeoutMs: number;
}> = {}) {
  return {
    enabled: true,
    dbPath,
    maxMemoriesPerUser: overrides.maxMemoriesPerUser ?? 10,
    searchLimit: overrides.searchLimit ?? 5,
    extractQueueLimit: overrides.extractQueueLimit ?? 10,
    sourcePreviewLength: overrides.sourcePreviewLength ?? 50,
    shutdownDrainTimeoutMs: overrides.shutdownDrainTimeoutMs ?? 1_000,
    retriever: "recent" as const,
    embeddingSimilarityThreshold: 0.75,
    obsidian: {
      enabled: false,
      syncCron: "0 2 * * *",
      enableWikiLinks: false,
    },
  };
}

describe("MemoryService", () => {
  it("formats recall blocks and appends them to existing system prompts", () => {
    expect(formatRecallBlock(["用户偏好 TypeScript", "用户使用 Vitest"])).toBe([
      "[Memory Recall]",
      "- 用户偏好 TypeScript",
      "- 用户使用 Vitest",
    ].join("\n"));
    expect(appendSystemBlock("[Bridge State]\nhello", "[Memory Recall]\n- 用户偏好 TypeScript")).toBe([
      "[Bridge State]",
      "hello",
      "",
      "[Memory Recall]",
      "- 用户偏好 TypeScript",
    ].join("\n"));
  });

  it("processes learn tasks sequentially and recalls saved facts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-memory-service-"));
    const events: string[] = [];
    const extractor: MemoryExtractor = {
      async extract(userMessage) {
        events.push(`start:${userMessage}`);
        await sleep(10);
        events.push(`end:${userMessage}`);
        return [`用户记录 ${userMessage}`];
      },
    };
    const service = new MemoryService(
      makeConfig(path.join(dir, "memory.db")),
      new OpenCodeClient(new URL("http://127.0.0.1:4096/")),
      logger as any,
      extractor,
    );

    service.enqueueLearn("u1", "first", "reply 1");
    service.enqueueLearn("u1", "second", "reply 2");
    await service.drain(1_000);

    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    await expect(service.buildRecallBlock("u1", "second")).resolves.toContain("用户记录 second");

    await service.stop();
  });

  it("drops new learn tasks when the queue is full", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-memory-service-"));
    const seen: string[] = [];
    const extractor: MemoryExtractor = {
      async extract(userMessage) {
        seen.push(userMessage);
        await sleep(20);
        return [`用户记录 ${userMessage}`];
      },
    };
    const service = new MemoryService(
      makeConfig(path.join(dir, "memory.db"), { extractQueueLimit: 1 }),
      new OpenCodeClient(new URL("http://127.0.0.1:4096/")),
      logger as any,
      extractor,
    );

    service.enqueueLearn("u1", "first", "reply 1");
    service.enqueueLearn("u1", "second", "reply 2");
    service.enqueueLearn("u1", "third", "reply 3");
    await service.drain(1_000);

    expect(seen).toEqual(["first", "second"]);
    await expect(service.buildRecallBlock("u1", "third")).resolves.not.toContain("用户记录 third");

    await service.stop();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
