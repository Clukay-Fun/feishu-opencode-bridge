/**
 * 职责: 覆盖BridgeApp 群聊白名单命令流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it, vi } from "vitest";

import { BridgeApp } from "../src/runtime/app.js";
import type { AppConfig } from "../src/config/schema.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";

describe("BridgeApp whitelist commands", () => {
  it("handles /leave for bound and unbound group users", async () => {
    const outbound = createOutbound();
    const whitelist = createWhitelist([["oc_group_1", new Set(["ou_123"])]]);
    const app = new BridgeApp(baseConfig(), outbound, logger(), whitelist);

    await (app as unknown as {
      handleCommand(message: {
        chatId: string;
        chatType: string;
        messageId: string;
        conversationKey: string;
        threadKey: string;
        senderOpenId: string;
      }, routed: { kind: "command"; command: { kind: "leave" } }): Promise<void>;
    }).handleCommand({
      chatId: "oc_group_1",
      chatType: "group",
      messageId: "om_1",
      conversationKey: "oc_group_1:om_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, {
      kind: "command",
      command: { kind: "leave" },
    });

    await (app as unknown as {
      handleCommand(message: {
        chatId: string;
        chatType: string;
        messageId: string;
        conversationKey: string;
        threadKey: string;
        senderOpenId: string;
      }, routed: { kind: "command"; command: { kind: "leave" } }): Promise<void>;
    }).handleCommand({
      chatId: "oc_group_1",
      chatType: "group",
      messageId: "om_2",
      conversationKey: "oc_group_1:om_2",
      threadKey: "om_2",
      senderOpenId: "ou_123",
    }, {
      kind: "command",
      command: { kind: "leave" },
    });

    const texts = getReplyPayloads(outbound).map((payload) => extractInteractiveText(payload));
    expect(texts[0]).toContain("后续消息不再响应");
    expect(texts[1]).toContain("尚未绑定");
  });

  it("reports group binding status for /who", async () => {
    const outbound = createOutbound();
    const whitelist = createWhitelist([["oc_group_1", new Set(["ou_123", "ou_456"])]]);
    const app = new BridgeApp(baseConfig(), outbound, logger(), whitelist);

    await (app as unknown as {
      handleCommand(message: {
        chatId: string;
        chatType: string;
        messageId: string;
        conversationKey: string;
        threadKey: string;
        senderOpenId: string;
      }, routed: { kind: "command"; command: { kind: "who" } }): Promise<void>;
    }).handleCommand({
      chatId: "oc_group_1",
      chatType: "group",
      messageId: "om_1",
      conversationKey: "oc_group_1:om_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, {
      kind: "command",
      command: { kind: "who" },
    });

    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("**2 人**");
    expect(text).toContain("**已绑定**");
  });

  it("rejects /who outside group chats", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());

    await (app as unknown as {
      handleCommand(message: {
        chatId: string;
        chatType: string;
        messageId: string;
        conversationKey: string;
        threadKey: string;
        senderOpenId: string;
      }, routed: { kind: "command"; command: { kind: "who" } }): Promise<void>;
    }).handleCommand({
      chatId: "oc_p2p_1",
      chatType: "p2p",
      messageId: "om_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
    }, {
      kind: "command",
      command: { kind: "who" },
    });

    expect(extractMarkdown(getReplyPayloads(outbound)[0])).toBe("该命令仅支持群聊使用");
  });
});

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
    memory: {
      enabled: false,
      dbPath: "memory.db",
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
        sqlitePath: "knowledge-base.db",
        bitable: { appToken: "", tableId: "", documentTableId: undefined },
      },
      embeddingProvider: undefined,
      models: {},
      ingest: { allowedExtensions: [".pdf", ".docx", ".txt"], maxFileSizeMb: 20, pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500 },
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

function createWhitelist(entries: Array<[string, Set<string>]> = []): ChatWhitelist {
  const bindings = new Map(entries);
  return {
    isBound(chatId, senderOpenId) {
      return bindings.get(chatId)?.has(senderOpenId) ?? false;
    },
    async bind(chatId, senderOpenId) {
      const members = bindings.get(chatId) ?? new Set<string>();
      members.add(senderOpenId);
      bindings.set(chatId, members);
    },
    async unbind(chatId, senderOpenId) {
      const members = bindings.get(chatId);
      if (!members?.has(senderOpenId)) {
        return false;
      }
      members.delete(senderOpenId);
      if (members.size === 0) {
        bindings.delete(chatId);
      }
      return true;
    },
    count(chatId) {
      return bindings.get(chatId)?.size ?? 0;
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
