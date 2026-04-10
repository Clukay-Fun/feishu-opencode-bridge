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

  it("returns a rate-limit notice when requests exceed the per-user window", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const limiter = (app as unknown as { rateLimiter: { allow(key: string, now?: number): boolean } }).rateLimiter;
    const now = Date.now();
    for (let index = 0; index < 20; index += 1) {
      limiter.allow("ou_123", now - 100 + index);
    }
    await app.handleIncomingMessage(createIncomingMessage("om_20"));

    expect(extractMarkdown(getReplyPayloads(outbound).at(-1))).toContain("请求过于频繁，请稍后再试");
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

  it("soft-deletes the current session for /close", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "旧会话", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "close" },
    });

    expect(appAny.sessionMap["oc_p2p_1"].sessions.map((session) => session.sessionId)).toEqual(["ses_1"]);
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已删除会话");
  });

  it("asks for confirmation before deleting a session from OpenCode", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "旧会话", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", confirm: false },
    });

    expect(appAny.pendingInteractions.get("oc_p2p_1")).toEqual(expect.objectContaining({
      kind: "session-delete-confirm",
      sessionId: "ses_2",
    }));
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("/delete confirm");
  });

  it("lists hidden sessions through /sessions all", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listSessions = vi.fn(async () => ([
      { id: "ses_2", title: "当前会话", time: { updated: 2 } },
      { id: "ses_hidden", title: "已隐藏会话", time: { updated: 1 } },
    ]));
    const appAny = app as unknown as {
      opencode: { listSessions: typeof listSessions };
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.opencode = { listSessions };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-all" },
    });

    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("已隐藏会话");
    expect(text).toContain("已隐藏");
  });

  it("renders /model openai as an interactive provider card", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listProviders = vi.fn(async () => ({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.4-mini": { id: "gpt-5.4-mini", release_date: "2026-03-17" },
            "gpt-5.4": { id: "gpt-5.4", release_date: "2026-03-05" },
          },
        },
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "big-pickle": { id: "big-pickle", release_date: "2025-10-17" },
          },
        },
      ],
      default: { openai: "gpt-5.4-mini", opencode: "big-pickle" },
    }));
    const appAny = app as unknown as {
      opencode: { listProviders: typeof listProviders };
    };
    appAny.opencode = { listProviders };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "models", provider: "openai" },
    });

    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("可用模型");
    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("OpenAI");
    expect(text).toContain("gpt-5.4-mini");
    expect(text).not.toContain("OpenCode");
  });

  it("does not truncate /sessions all by sessionListLimit", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listSessions = vi.fn(async () => Array.from({ length: 12 }, (_, index) => ({
      id: `ses_${12 - index}`,
      title: `会话${12 - index}`,
      time: { updated: 12 - index },
    })));
    const appAny = app as unknown as {
      opencode: { listSessions: typeof listSessions };
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { listSessions };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-all" },
    });

    const pending = appAny.pendingInteractions.get("oc_p2p_1");
    expect(pending).toEqual(expect.objectContaining({
      kind: "session-select",
    }));
    expect((pending as Extract<PendingInteraction, { kind: "session-select" }>).options).toHaveLength(12);
    expect(getReplyPayloads(outbound)).toHaveLength(1);
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("会话12");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("会话1");
  });

  it("chunks /sessions all into multiple cards when the list is too long", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listSessions = vi.fn(async () => Array.from({ length: 25 }, (_, index) => ({
      id: `ses_${25 - index}`,
      title: `会话${25 - index}`,
      time: { updated: 25 - index },
    })));
    const appAny = app as unknown as {
      opencode: { listSessions: typeof listSessions };
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { listSessions };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-all" },
    });

    expect((appAny.pendingInteractions.get("oc_p2p_1") as Extract<PendingInteraction, { kind: "session-select" }>).options).toHaveLength(25);
    expect(getReplyPayloads(outbound)).toHaveLength(2);
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("会话25");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).not.toContain("会话5");
    expect(extractInteractiveText(getReplyPayloads(outbound)[1])).toContain("会话5");
  });

  it("hard-deletes a confirmed session through OpenCode", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const deleteSession = vi.fn(async () => true);
    const appAny = app as unknown as {
      opencode: { deleteSession: typeof deleteSession };
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { deleteSession };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "旧会话", createdAt: 1, lastUsedAt: 1 },
      ],
    };
    appAny.pendingInteractions.set("oc_p2p_1", {
      kind: "session-delete-confirm",
      index: 0,
      sessionId: "ses_2",
      title: "当前会话",
      expiresAt: Date.now() + 30_000,
    });

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", confirm: true },
    });

    expect(deleteSession).toHaveBeenCalledWith("ses_2");
    expect(appAny.sessionMap["oc_p2p_1"].sessions.map((session) => session.sessionId)).toEqual(["ses_1"]);
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已彻底删除会话");
  });

  it("allows /delete 1 in single mode for the current session", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.sessionMap["oc_group_1"] = {
      mode: "single",
      activeSessionId: "ses_1",
      sessions: [
        { sessionId: "ses_1", label: "当前会话", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", index: 1, confirm: false },
    }, {
      chatId: "oc_group_1",
      chatType: "group",
      conversationKey: "oc_group_1",
    });

    expect(appAny.pendingInteractions.get("oc_group_1")).toEqual(expect.objectContaining({
      kind: "session-delete-confirm",
      sessionId: "ses_1",
    }));
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("/delete 1 confirm");
  });

  it("can hard-delete a hidden session after /sessions all", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listSessions = vi.fn(async () => ([
      { id: "ses_2", title: "当前会话", time: { updated: 2 } },
      { id: "ses_hidden", title: "已隐藏会话", time: { updated: 1 } },
    ]));
    const deleteSession = vi.fn(async () => true);
    const appAny = app as unknown as {
      opencode: { listSessions: typeof listSessions; deleteSession: typeof deleteSession };
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { listSessions, deleteSession };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-all" },
    });
    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", index: 2, confirm: false },
    });
    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", index: 2, confirm: true },
    });

    expect(deleteSession).toHaveBeenCalledWith("ses_hidden");
    expect(extractInteractiveHeader(getReplyPayloads(outbound).at(-1))).toBe("已彻底删除会话");
  });

  it("supports /close all and /delete all confirm", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const deleteSession = vi.fn(async () => true);
    const appAny = app as unknown as {
      opencode: { deleteSession: typeof deleteSession };
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.opencode = { deleteSession };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "旧会话", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "close", all: true },
    });
    expect(appAny.sessionMap["oc_p2p_1"]).toBeUndefined();
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已删除全部会话");

    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "旧会话", createdAt: 1, lastUsedAt: 1 },
      ],
    };
    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", all: true, confirm: false },
    });
    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", all: true, confirm: true },
    });

    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(appAny.sessionMap["oc_p2p_1"]).toBeUndefined();
    expect(extractInteractiveHeader(getReplyPayloads(outbound).at(-1))).toBe("已彻底删除全部会话");
  });

  it("supports ranged /close and ranged /delete confirm", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const deleteSession = vi.fn(async () => true);
    const listSessions = vi.fn(async () => ([
      { id: "ses_4", title: "会话4", time: { updated: 4 } },
      { id: "ses_3", title: "会话3", time: { updated: 3 } },
      { id: "ses_2", title: "会话2", time: { updated: 2 } },
      { id: "ses_1", title: "会话1", time: { updated: 1 } },
    ]));
    const appAny = app as unknown as {
      opencode: { deleteSession: typeof deleteSession; listSessions: typeof listSessions };
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { deleteSession, listSessions };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_4",
      sessions: [
        { sessionId: "ses_4", label: "会话4", createdAt: 4, lastUsedAt: 4 },
        { sessionId: "ses_3", label: "会话3", createdAt: 3, lastUsedAt: 3 },
        { sessionId: "ses_2", label: "会话2", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "会话1", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "close", range: { start: 2, end: 3 } },
    });

    expect(appAny.sessionMap["oc_p2p_1"].sessions.map((session) => session.sessionId)).toEqual(["ses_4", "ses_1"]);
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已删除多个会话");

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-all" },
    });
    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", range: { start: 2, end: 3 }, confirm: false },
    });

    expect(appAny.pendingInteractions.get("oc_p2p_1")).toEqual(expect.objectContaining({
      kind: "session-delete-confirm",
      rangeLabel: "2-3",
      sessionIds: ["ses_3", "ses_2"],
    }));

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", range: { start: 2, end: 3 }, confirm: true },
    });

    expect(deleteSession).toHaveBeenCalledWith("ses_3");
    expect(deleteSession).toHaveBeenCalledWith("ses_2");
    expect(extractInteractiveHeader(getReplyPayloads(outbound).at(-1))).toBe("已彻底删除多个会话");
  });

  it("blocks close when the current session is still running", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
      queues: {
        get(key: string): {
          enqueue: (turn: Record<string, unknown>) => { accepted: boolean };
        };
      };
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_running",
      sessions: [
        { sessionId: "ses_running", label: "正在执行", createdAt: 2, lastUsedAt: 2 },
      ],
    };
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
      command: { kind: "close" },
    });

    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("请先发送 `/abort`");
  });
});

async function callHandleCommand(
  app: BridgeApp,
  routed: AppCommandSurfaceTestRoute,
  overrides?: Partial<{
    chatId: string;
    chatType: string;
    messageId: string;
    conversationKey: string;
    threadKey: string;
    senderOpenId: string;
  }>,
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
      ...overrides,
  }, routed);
}

type AppCommandSurfaceTestRoute = {
  kind: "command";
  command:
    | { kind: "abort" }
    | { kind: "models"; provider?: string | undefined }
    | { kind: "sessions-all" }
    | { kind: "sessions-select"; index: number }
    | { kind: "close"; index?: number | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined }
    | { kind: "delete"; index?: number | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined; confirm: boolean };
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
    memory: {
      enabled: false,
      dbPath: "memory.db",
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

function createIncomingMessage(messageId: string) {
  return {
    chatId: "oc_p2p_1",
    chatType: "p2p",
    senderOpenId: "ou_123",
    messageId,
    messageType: "text",
    rawContent: "hello",
    plainText: "hello",
    threadKey: messageId,
    conversationKey: "oc_p2p_1",
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

function extractInteractiveHeader(payload: { content: string } | undefined): string {
  if (!payload) {
    return "";
  }
  const parsed = JSON.parse(payload.content) as { header?: { title?: { content?: string } } };
  return parsed.header?.title?.content ?? "";
}

function getReplyPayloads(outbound: ReturnType<typeof createOutbound>): Array<{ content: string } | undefined> {
  return (outbound.replyMessage.mock.calls as unknown[][]).map((call) => call[1] as { content: string } | undefined);
}
