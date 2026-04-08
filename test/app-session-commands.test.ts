import { describe, expect, it, vi } from "vitest";

import { BridgeApp } from "../src/runtime/app.js";
import type { AppConfig } from "../src/config/schema.js";
import type { MappingRecord } from "../src/store/mappings.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";

describe("BridgeApp session commands", () => {
  it("renames the active session", async () => {
    const outbound = createOutbound();
    const app = createApp(outbound);
    setSessionMap(app, {
      oc_p2p_1: {
        mode: "multi",
        activeSessionId: "ses_2",
        sessions: [
          { sessionId: "ses_2", label: "帮我写个单测", createdAt: 2, lastUsedAt: 20 },
          { sessionId: "ses_1", label: "代码审查", createdAt: 1, lastUsedAt: 10 },
        ],
      },
    });

    await invokeCommand(app, {
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, { kind: "rename", label: "新的会话名" });

    expect(getSessionMap(app).oc_p2p_1?.sessions[0]?.label).toBe("新的会话名");
    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("已重命名会话");
    expect(text).toContain("新的会话名");
  });

  it("closes the active session and switches to the next one", async () => {
    const outbound = createOutbound();
    const app = createApp(outbound);
    setSessionMap(app, {
      oc_p2p_1: {
        mode: "multi",
        activeSessionId: "ses_2",
        sessions: [
          { sessionId: "ses_2", label: "帮我写个单测", createdAt: 2, lastUsedAt: 20 },
          { sessionId: "ses_1", label: "代码审查", createdAt: 1, lastUsedAt: 10 },
        ],
      },
    });

    await invokeCommand(app, {
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, { kind: "close" });

    expect(getSessionMap(app).oc_p2p_1?.activeSessionId).toBe("ses_1");
    expect(getSessionMap(app).oc_p2p_1?.sessions).toHaveLength(1);
    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("已关闭会话");
    expect(text).toContain("代码审查");
  });

  it("rejects indexed close in single-session mode", async () => {
    const outbound = createOutbound();
    const app = createApp(outbound);
    setSessionMap(app, {
      "oc_group_1:om_1": {
        mode: "single",
        activeSessionId: "ses_1",
        sessions: [
          { sessionId: "ses_1", label: "群聊会话", createdAt: 1, lastUsedAt: 1 },
        ],
      },
    });

    await invokeCommand(app, {
      chatId: "oc_group_1",
      chatType: "group",
      messageId: "om_1",
      conversationKey: "oc_group_1:om_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, { kind: "close", index: 1 });

    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("当前窗口为单会话模式，不支持按编号关闭");
  });

  it("stores a window model override via /model use", async () => {
    const outbound = createOutbound();
    const app = createApp(outbound);
    setSessionMap(app, {
      oc_p2p_1: {
        mode: "multi",
        model: null,
        activeSessionId: "ses_2",
        sessions: [
          { sessionId: "ses_2", label: "帮我写个单测", createdAt: 2, lastUsedAt: 20 },
        ],
      },
    });
    setProviders(app, {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.4": { id: "gpt-5.4", name: "GPT-5.4" },
          },
        },
      ],
      default: { openai: "gpt-5.4-mini" },
    });

    await invokeCommand(app, {
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, { kind: "model-use", model: "openai/gpt-5.4" });

    expect(getSessionMap(app).oc_p2p_1?.model).toBe("openai/gpt-5.4");
    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("当前窗口模型已切换为");
    expect(text).toContain("openai/gpt-5.4");
  });

  it("renders a model card for /model", async () => {
    const outbound = createOutbound();
    const app = createApp(outbound);
    setProviders(app, {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.4-mini": { id: "gpt-5.4-mini", name: "GPT-5.4 mini", release_date: "2026-03-17" },
            "gpt-5.4": { id: "gpt-5.4", name: "GPT-5.4", release_date: "2026-03-05" },
            "gpt-5.3-codex": { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", release_date: "2026-02-05" },
            "gpt-5.2": { id: "gpt-5.2", name: "GPT-5.2", release_date: "2025-12-11" },
            "gpt-5.1-codex": { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", release_date: "2025-11-13" },
            "gpt-5-codex": { id: "gpt-5-codex", name: "GPT-5-Codex", release_date: "2025-09-15" },
          },
        },
      ],
      default: { openai: "gpt-5.4-mini" },
    });
    setSessionMap(app, {
      oc_p2p_1: {
        mode: "multi",
        model: "openai/gpt-5.4-mini",
        activeSessionId: "ses_2",
        sessions: [
          { sessionId: "ses_2", label: "帮我写个单测", createdAt: 2, lastUsedAt: 20 },
        ],
      },
    });

    await invokeCommand(app, {
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, { kind: "models" });

    const payload = getReplyPayloads(outbound)[0];
    const parsed = payload ? JSON.parse(payload.content) as { msg_type?: string; header?: { title?: { content?: string } }; body?: { elements?: unknown[] } } : null;
    expect(parsed?.header?.title?.content).toBe("可用模型");
    expect(JSON.stringify(parsed?.body?.elements ?? [])).toContain("最近 5 个模型");
    expect(JSON.stringify(parsed?.body?.elements ?? [])).toContain("gpt-5.4-mini");
    expect(JSON.stringify(parsed?.body?.elements ?? [])).not.toContain("gpt-5-codex");
  });
});

function createApp(outbound: ReturnType<typeof createOutbound>): BridgeApp {
  const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
  (app as unknown as { mappings: { save: ReturnType<typeof vi.fn> } }).mappings = {
    save: vi.fn(async () => undefined),
  };
  setProviders(app, { providers: [], default: {} });
  return app;
}

function setProviders(app: BridgeApp, providers: { providers: Array<Record<string, unknown>>; default: Record<string, string> }): void {
  (app as unknown as { opencode: { listProviders: ReturnType<typeof vi.fn> } }).opencode = {
    ...((app as unknown as { opencode: Record<string, unknown> }).opencode),
    listProviders: vi.fn(async () => providers),
  };
}

function setSessionMap(app: BridgeApp, value: MappingRecord): void {
  (app as unknown as { sessionMap: MappingRecord }).sessionMap = value;
}

function getSessionMap(app: BridgeApp): MappingRecord {
  return (app as unknown as { sessionMap: MappingRecord }).sessionMap;
}

async function invokeCommand(
  app: BridgeApp,
  message: {
    chatId: string;
    chatType: string;
    messageId: string;
    conversationKey: string;
    threadKey: string;
    senderOpenId: string;
  },
  command:
    | { kind: "rename"; label: string }
    | { kind: "close"; index?: number | undefined }
    | { kind: "model-use"; model: string }
    | { kind: "models"; provider?: string | undefined },
): Promise<void> {
  await (app as unknown as {
    handleCommand(
      nextMessage: typeof message,
      routed: { kind: "command"; command: typeof command },
    ): Promise<void>;
  }).handleCommand(message, { kind: "command", command });
}

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
    },
    opencode: {
      baseUrl: new URL("http://127.0.0.1:4096/"),
      directory: process.cwd(),
    },
    storage: {
      dataDir: process.cwd(),
      mappingsFile: "mappings.json",
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

function extractInteractiveText(payload: { content: string } | undefined): string {
  if (!payload) {
    return "";
  }
  const parsed = JSON.parse(payload.content) as { header?: { title?: { content?: string } }; body?: { elements?: unknown[] } };
  return `${parsed.header?.title?.content ?? ""} ${JSON.stringify(parsed.body?.elements ?? [])}`;
}

function getReplyPayloads(outbound: ReturnType<typeof createOutbound>): Array<{ content: string } | undefined> {
  return (outbound.replyMessage.mock.calls as unknown[][]).map((call) => call[1] as { content: string } | undefined);
}
