import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import type { FeishuPostPayload } from "../src/feishu/formatter.js";
import type { OpenCodeMessage } from "../src/opencode/client.js";
import type { OpenCodeEvent } from "../src/opencode/events.js";
import { BridgeApp, type IncomingChatMessage } from "../src/runtime/app.js";
import type { SessionWindowRecord } from "../src/store/mappings.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";

describe("BridgeApp runtime card updates", () => {
  it("updates final output and completed header in one card payload", async () => {
    const { app, appAny, outbound, opencode } = await createRuntimeApp({
      messages: [
        assistantMessage("msg_assistant", "最终回答"),
      ],
    });

    const running = app.handleIncomingMessage(incomingMessage("请回答"));
    await vi.waitFor(() => expect(opencode.promptAsync).toHaveBeenCalled());
    await appAny.eventStream.emit(openCodeEvent("message.updated", {
      sessionID: "ses_1",
      info: { id: "msg_assistant", role: "assistant", sessionID: "ses_1" },
    }));
    await appAny.eventStream.emit(openCodeEvent("session.idle", { sessionID: "ses_1" }));
    await running;

    const updatesWithFinalText = getUpdatedCards(outbound)
      .filter((card) => JSON.stringify(card.body?.elements ?? []).includes("最终回答"));
    expect(updatesWithFinalText).toHaveLength(1);
    expect(updatesWithFinalText[0]?.header?.title?.content).toBe("已完成");
    expect(updatesWithFinalText[0]?.header?.template).toBe("green");
  });

  it("buffers text deltas until an assistant message is confirmed", async () => {
    const { app, appAny, outbound, opencode } = await createRuntimeApp({ messages: [] });

    const running = app.handleIncomingMessage(incomingMessage("用户问题内容"));
    await vi.waitFor(() => expect(opencode.promptAsync).toHaveBeenCalled());
    await appAny.eventStream.emit(openCodeEvent("message.part.delta", {
      sessionID: "ses_1",
      messageID: "msg_user",
      field: "text",
      delta: "用户问题内容",
    }));
    await appAny.eventStream.emit(openCodeEvent("message.updated", {
      sessionID: "ses_1",
      info: { id: "msg_assistant", role: "assistant", sessionID: "ses_1" },
    }));
    await appAny.eventStream.emit(openCodeEvent("message.part.delta", {
      sessionID: "ses_1",
      messageID: "msg_assistant",
      field: "text",
      delta: "助手回答",
    }));
    await appAny.eventStream.emit(openCodeEvent("session.idle", { sessionID: "ses_1" }));
    await running;

    const serializedUpdates = JSON.stringify(getUpdatedCards(outbound));
    expect(serializedUpdates).not.toContain("用户问题内容");
    expect(serializedUpdates).toContain("助手回答");
  });
});

async function createRuntimeApp(options: { messages: OpenCodeMessage[] }): Promise<{
  app: BridgeApp;
  appAny: {
    eventStream: { emit(event: OpenCodeEvent): Promise<void> };
    opencode: unknown;
    sessionMap: Record<string, SessionWindowRecord>;
  };
  outbound: ReturnType<typeof createOutbound>;
  opencode: ReturnType<typeof createOpenCodeMock>;
}> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "bridge-runtime-"));
  const outbound = createOutbound();
  const opencode = createOpenCodeMock(options.messages);
  const eventStream = createEventStreamMock();
  const app = new BridgeApp(baseConfig(dataDir), outbound, logger(), createWhitelist(), {
    opencode: opencode as unknown as ConstructorParameters<typeof BridgeApp>[4] extends { opencode?: infer T } ? T : never,
    eventStream,
    memory: null,
  });
  const appAny = app as unknown as {
    eventStream: { emit(event: OpenCodeEvent): Promise<void> };
    opencode: typeof opencode;
    sessionMap: Record<string, SessionWindowRecord>;
  };
  appAny.sessionMap = {
    oc_p2p_1: {
      mode: "multi",
      activeSessionId: "ses_1",
      sessions: [
        { sessionId: "ses_1", label: "已有会话", createdAt: 1, lastUsedAt: 1 },
      ],
    },
  };
  return { app, appAny, outbound, opencode };
}

function createEventStreamMock() {
  const listeners = new Set<(event: OpenCodeEvent) => Promise<void>>();
  return {
    async start() {},
    async stop() {},
    subscribe(listener: (event: OpenCodeEvent) => Promise<void>) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getConnectionState() {
      return "connected" as const;
    },
    async emit(event: OpenCodeEvent) {
      for (const listener of listeners) {
        await listener(event);
      }
    },
  };
}

function createOpenCodeMock(messages: OpenCodeMessage[]) {
  return {
    health: vi.fn(async () => ({ healthy: true as const, version: "test" })),
    listSessions: vi.fn(async () => ([
      { id: "ses_1", title: "已有会话", time: { updated: 1 } },
    ])),
    getSessionMessages: vi.fn(async () => messages),
    promptAsync: vi.fn(async () => ({ accepted: true })),
  };
}

function assistantMessage(id: string, text: string): OpenCodeMessage {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "ses_1",
      finish: "stop",
      time: { created: 1, updated: 2, completed: 2 },
    },
    parts: [
      { id: "part_1", type: "text", text, messageID: id, sessionID: "ses_1" },
    ],
  };
}

function openCodeEvent(type: string, properties: Record<string, unknown>): OpenCodeEvent {
  return {
    type,
    properties,
    sessionId: null,
    receivedAt: Date.now(),
    streamEndpoint: "/event",
    raw: { type, properties },
  };
}

function incomingMessage(plainText: string): IncomingChatMessage {
  return {
    chatId: "oc_p2p_1",
    chatType: "p2p",
    senderOpenId: "ou_123",
    messageId: "om_1",
    messageType: "text",
    rawContent: JSON.stringify({ text: plainText }),
    plainText,
    threadKey: "om_1",
    conversationKey: "oc_p2p_1",
  };
}

function baseConfig(dataDir: string): AppConfig {
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
      dataDir,
      mappingsFile: "mappings.json",
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: new URL("http://127.0.0.1:3000/"),
    },
    whitelist: {
      storePath: path.join(dataDir, "whitelist.json"),
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
    logging: {
      dir: dataDir,
      level: "info",
      enableTranscript: true,
      enableConsole: true,
      enableColor: true,
      rotateDaily: true,
    },
    memory: {
      enabled: false,
      dbPath: path.join(dataDir, "memory.sqlite"),
      maxMemoriesPerUser: 500,
      searchLimit: 5,
      extractQueueLimit: 100,
      sourcePreviewLength: 50,
      shutdownDrainTimeoutMs: 5_000,
      retriever: "recent",
      embeddingSimilarityThreshold: 0.75,
      obsidian: {
        enabled: false,
        syncCron: "0 2 * * *",
        enableWikiLinks: false,
      },
    },
  };
}

function createOutbound() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "om_send" })),
    replyMessage: vi.fn(async () => ({ messageId: "om_reply" })),
    updateMessage: vi.fn(async () => ({ messageId: "om_update" })),
  };
}

function createWhitelist(): ChatWhitelist {
  return {
    isBound() {
      return false;
    },
    async bind() {},
    async unbind() {
      return false;
    },
    count() {
      return 0;
    },
  };
}

function logger() {
  return {
    log() {},
    logTranscript() {},
  };
}

function getUpdatedCards(outbound: ReturnType<typeof createOutbound>): Array<{
  header?: { title?: { content?: string }; template?: string };
  body?: { elements?: unknown[] };
}> {
  return (outbound.updateMessage.mock.calls as unknown[][]).map((call) => {
    const payload = call[1] as FeishuPostPayload;
    return JSON.parse(payload.content) as {
      header?: { title?: { content?: string }; template?: string };
      body?: { elements?: unknown[] };
    };
  });
}
