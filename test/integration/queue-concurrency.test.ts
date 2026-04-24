/**
 * 职责: 覆盖队列并发和 turn 串行执行集成路径。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config/schema.js";
import { BridgeApp, type IncomingChatMessage } from "../../src/runtime/app.js";
import { createLogger, createOutbound, createWhitelist, FakeOpenCodeClient, FakeOpenCodeEventStream } from "./fakes.js";

const tempDirs: string[] = [];

describe("integration/queue-concurrency", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues concurrent messages and processes in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-queue-integration-"));
    tempDirs.push(dir);

    const stream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(stream, {
      kind: "queue-flow",
      finalTexts: ["第一条回复", "第二条回复", "第三条回复"],
    });
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(dir), outbound, createLogger(), createWhitelist(), {
      opencode,
      eventStream: stream,
      memory: null,
    });

    const runs = [
      app.handleIncomingMessage(createDirectMessage("第一条消息", "om_1")),
      app.handleIncomingMessage(createDirectMessage("第二条消息", "om_2")),
      app.handleIncomingMessage(createDirectMessage("第三条消息", "om_3")),
    ];

    await Promise.all(runs);

    await vi.waitFor(() => {
      const updated = JSON.stringify(outbound.updateMessage.mock.calls.map((call) => call[1]));
      expect(updated).toContain("第一条回复");
      expect(updated).toContain("第二条回复");
      expect(updated).toContain("第三条回复");
    });

    const replyPayloads = outbound.replyMessage.mock.calls.map((call) => call[1]);
    const repliesText = JSON.stringify(replyPayloads);
    expect(repliesText).toContain("正在忙");

    const updated = JSON.stringify(outbound.updateMessage.mock.calls.map((call) => call[1]));
    expect(updated.indexOf("第一条回复")).toBeLessThan(updated.indexOf("第二条回复"));
    expect(updated.indexOf("第二条回复")).toBeLessThan(updated.indexOf("第三条回复"));

    const appAny = app as unknown as {
      queues: { listByPrefix(prefix: string): Array<{ current(): unknown; pendingCount(): number }> };
    };
    for (const queue of appAny.queues.listByPrefix("oc_p2p_1")) {
      expect(queue.current()).toBeNull();
      expect(queue.pendingCount()).toBe(0);
    }
  });
});

function baseConfig(dir: string): AppConfig {
  return {
    feishu: {
      appId: "app",
      appSecret: "secret",
      botOpenIds: new Set(["ou_bot"]),
      botMentionNames: new Set(["opencode"]),
      selfBotOpenIds: new Set(["ou_bot"]),
      wsUrl: new URL("wss://open.feishu.cn/open-apis/ws/v2"),
      allowedOpenIds: new Set(),
      behavior: {
        enableP2p: true,
        enableGroup: true,
        requireBotMentionInGroup: true,
        strictBotMention: true,
        ignoreNonUserSenders: true,
        replyInThread: true,
      },
      cardActions: {
        enabled: false,
        path: "/webhook/card",
        verificationToken: "",
        encryptKey: "",
      },
    },
    opencode: {
      baseUrl: new URL("http://127.0.0.1:4096/"),
      directory: process.cwd(),
    },
    storage: {
      dataDir: dir,
      mappingsFile: "mappings.json",
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: new URL("http://127.0.0.1:3000/"),
    },
    whitelist: {
      storePath: "whitelist.json",
    },
    bridge: {
      queueLimit: 3,
      sessionModes: {
        p2p: "multi",
        group: "single",
        topicGroup: "single",
      },
      maxSessionsPerWindow: 20,
      sessionListLimit: 10,
      injectSystemState: true,
      firstEventTimeoutMs: 30_000,
      eventGapTimeoutMs: 120_000,
      totalTimeoutMs: 300_000,
    },
    memory: {
      enabled: false,
      dbPath: join(dir, "memory.db"),
      maxMemoriesPerUser: 500,
      searchLimit: 5,
      extractQueueLimit: 100,
      sourcePreviewLength: 50,
      shutdownDrainTimeoutMs: 5_000,
      retriever: "recent",
      embeddingProvider: undefined,
      obsidian: {
        enabled: false,
        vaultPath: undefined,
        syncCron: "0 2 * * *",
        enableWikiLinks: false,
      },
    },
    knowledgeBase: {
      enabled: false,
      autoDetect: { enabled: false, minConfidence: 0.75 },
      query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
      storage: {
        sqlitePath: join(dir, "knowledge-base.db"),
        bitable: { appToken: "", tableId: "", documentTableId: undefined },
      },
      embeddingProvider: undefined,
      models: {},
      ingest: { allowedExtensions: [".pdf", ".docx", ".txt"], maxFileSizeMb: 20, pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500 },
    },
    logging: {
      dir: dir,
      level: "info",
      enableTranscript: true,
      enableConsole: false,
      enableColor: false,
      rotateDaily: true,
    },
  };
}

function createDirectMessage(text: string, messageId: string): IncomingChatMessage {
  return {
    chatId: "oc_p2p_1",
    chatType: "p2p",
    senderOpenId: "ou_123",
    messageId,
    messageType: "text",
    rawContent: text,
    plainText: text,
    threadKey: messageId,
    conversationKey: "oc_p2p_1",
  };
}
