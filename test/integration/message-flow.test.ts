import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config/schema.js";
import { BridgeApp, type IncomingChatMessage } from "../../src/runtime/app.js";
import { createLogger, createOutbound, createWhitelist, FakeOpenCodeClient, FakeOpenCodeEventStream } from "./fakes.js";

const tempDirs: string[] = [];

describe("integration/message-flow", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("processes a direct message end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-integration-"));
    tempDirs.push(dir);

    const stream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(stream, { kind: "message-flow", finalText: "集成测试回复" });
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(dir), outbound, createLogger(), createWhitelist(), {
      opencode,
      eventStream: stream,
      memory: null,
    });

    await app.handleIncomingMessage(createDirectMessage("帮我写个函数"));

    await vi.waitFor(() => {
      expect(opencode.sessions.size).toBe(1);
      expect(outbound.replyMessage).toHaveBeenCalled();
      expect(outbound.updateMessage).toHaveBeenCalled();
    });

    const replyPayloads = outbound.replyMessage.mock.calls.map((call) => call[1]);
    const updatePayloads = outbound.updateMessage.mock.calls.map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("ses_1");
    expect(JSON.stringify(replyPayloads)).toContain("处理中");
    expect(JSON.stringify(updatePayloads)).toContain("集成测试回复");

    const appAny = app as unknown as {
      sessionMap: Record<string, { activeSessionId: string | null; sessions: Array<{ sessionId: string }> }>;
      queues: { get(key: string): { current(): unknown } };
    };
    expect(appAny.sessionMap["oc_p2p_1"]?.activeSessionId).toBeTruthy();
    expect(appAny.queues.get("oc_p2p_1").current()).toBeNull();
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
      embeddingSimilarityThreshold: 0.75,
      embeddingProvider: undefined,
      obsidian: {
        enabled: false,
        vaultPath: undefined,
        syncCron: "0 2 * * *",
        enableWikiLinks: false,
      },
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

function createDirectMessage(text: string): IncomingChatMessage {
  return {
    chatId: "oc_p2p_1",
    chatType: "p2p",
    senderOpenId: "ou_123",
    messageId: "om_1",
    messageType: "text",
    rawContent: text,
    plainText: text,
    threadKey: "om_1",
    conversationKey: "oc_p2p_1",
  };
}
