import { describe, expect, it, vi } from "vitest";

import { BridgeApp } from "../src/runtime/app.js";
import type { AppConfig } from "../src/config/schema.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";
import type { PendingInteraction } from "../src/bridge/state.js";
import type { SessionWindowRecord } from "../src/store/mappings.js";

describe("BridgeApp command surface", () => {
  it("returns a no-task notice for /abort when no turn is running", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const abort = vi.fn(async () => true);
    (app as unknown as { opencode: { abort: typeof abort } }).opencode = { abort };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "abort" },
    });

    expect(abort).not.toHaveBeenCalled();
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("当前没有正在执行的任务");
  });

  it("aborts the active turn and returns a terminal notice card", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const abort = vi.fn(async () => true);
    const appAny = app as unknown as {
      opencode: { abort: typeof abort };
      queues: {
        get(key: string): {
          enqueue: (turn: Record<string, unknown>) => { accepted: boolean };
          peek: () => { sessionId?: string };
        };
      };
    };
    appAny.opencode = { abort };
    appAny.queues.get("oc_p2p_1").enqueue({
      turnId: "turn_1",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
      inboundMessageId: "om_1",
      plainText: "hello",
      text: "hello",
      sessionId: "ses_running",
    });

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "abort" },
    });

    expect(abort).toHaveBeenCalledWith("ses_running");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("当前任务已中止");
  });

  it("rejects /switch 999 when the pending session selection does not include that index", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_1",
      sessions: [
        { sessionId: "ses_1", label: "当前会话", createdAt: 1, lastUsedAt: 2 },
        { sessionId: "ses_2", label: "另一个会话", createdAt: 1, lastUsedAt: 1 },
      ],
    };
    appAny.pendingInteractions.set("oc_p2p_1", {
      kind: "session-select",
      expiresAt: Date.now() + 30_000,
      options: [
        { index: 1, sessionId: "ses_1", title: "当前会话", current: true },
        { index: 2, sessionId: "ses_2", title: "另一个会话" },
      ],
    });

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-select", index: 999 },
    });

    expect(extractMarkdown(getReplyPayloads(outbound)[0])).toContain("无效的会话编号");
  });
});

async function callHandleCommand(
  app: BridgeApp,
  routed: AppCommandSurfaceTestRoute,
): Promise<void> {
  await (app as unknown as {
    handleCommand(
      message: {
        chatId: string;
        chatType: string;
        messageId: string;
        conversationKey: string;
        threadKey: string;
        senderOpenId: string;
      },
      routed: AppCommandSurfaceTestRoute,
    ): Promise<void>;
  }).handleCommand({
    chatId: "oc_p2p_1",
    chatType: "p2p",
    messageId: "om_1",
    conversationKey: "oc_p2p_1",
    threadKey: "om_1",
    senderOpenId: "ou_123",
  }, routed);
}

type AppCommandSurfaceTestRoute = {
  kind: "command";
  command:
    | { kind: "abort" }
    | { kind: "sessions-select"; index: number };
};

function baseConfig(): AppConfig {
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
      dataDir: process.cwd(),
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
    logging: {
      dir: process.cwd(),
      level: "info",
      enableTranscript: true,
      enableConsole: true,
      enableColor: true,
      rotateDaily: true,
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

function extractMarkdown(payload: { content: string } | undefined): string {
  if (!payload) {
    return "";
  }
  const parsed = JSON.parse(payload.content) as {
    zh_cn?: {
      content?: Array<Array<{ text?: string }>>;
    };
  };
  return parsed.zh_cn?.content?.[0]?.[0]?.text ?? "";
}

function extractInteractiveText(payload: { content: string } | undefined): string {
  if (!payload) {
    return "";
  }
  const parsed = JSON.parse(payload.content) as { body?: { elements?: unknown[] } };
  return JSON.stringify(parsed.body?.elements ?? []);
}

function getReplyPayloads(outbound: ReturnType<typeof createOutbound>): Array<{ content: string } | undefined> {
  return (outbound.replyMessage.mock.calls as unknown[][]).map((call) => call[1] as { content: string } | undefined);
}
