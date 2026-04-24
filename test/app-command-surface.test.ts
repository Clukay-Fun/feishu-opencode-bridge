/**
 * 职责: 覆盖BridgeApp 命令入口和用户可见命令面。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuApiClient } from "../src/feishu/api.js";
import { BridgeApp } from "../src/runtime/app.js";
import type { AppConfig } from "../src/config/schema.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";
import type { PendingInteraction } from "../src/bridge/state.js";
import type { SessionWindowRecord } from "../src/store/mappings.js";

describe("BridgeApp command surface", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves FeishuApiClient resource method binding when adapting runtime module outbound", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "token_1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { has_more: false, items: [] } }));
    vi.stubGlobal("fetch", fetch);
    const app = new BridgeApp(baseConfig(), new FeishuApiClient("app", "secret"), logger(), createWhitelist());
    const outbound = (app as unknown as {
      getRuntimeModuleOutbound(): {
        listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
      };
    }).getRuntimeModuleOutbound();

    await expect(outbound.listBitableRecords("app_token", "tbl_1")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

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

  it("switches directly by session name when /switch receives a unique title", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listSessions = vi.fn(async () => ([
      { id: "ses_1", title: "日常聊天", time: { created: 1, updated: 2 } },
      { id: "ses_2", title: "知识库入库与法律检索", time: { created: 1, updated: 1 } },
    ]));
    const appAny = app as unknown as {
      opencode: { listSessions: typeof listSessions };
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.opencode = { listSessions };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_1",
      sessions: [
        { sessionId: "ses_1", label: "日常聊天", createdAt: 1, lastUsedAt: 2 },
        { sessionId: "ses_2", label: "知识库入库与法律检索", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-select", query: "知识库入库" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.activeSessionId).toBe("ses_2");
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已切换会话");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("知识库入库与法律检索");
  });

  it("migrates legacy p2p main-window sessions from the flat key to the :main key", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_legacy",
      sessions: [
        { sessionId: "ses_legacy", label: "日常聊天2", createdAt: 1, lastUsedAt: 2 },
        { sessionId: "ses_other", label: "发票识别", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions" },
    }, {
      conversationKey: "oc_p2p_1:main",
      threadKey: "main",
    });

    expect(appAny.sessionMap["oc_p2p_1"]).toBeUndefined();
    expect(appAny.sessionMap["oc_p2p_1:main"]?.activeSessionId).toBe("ses_legacy");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("日常聊天2");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("发票识别");
  });

  it("merges legacy p2p sessions into an existing :main window", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_legacy",
      sessions: [
        { sessionId: "ses_legacy", label: "日常聊天2", createdAt: 1, lastUsedAt: 2 },
      ],
    };
    appAny.sessionMap["oc_p2p_1:main"] = {
      mode: "multi",
      activeSessionId: "ses_current",
      sessions: [
        { sessionId: "ses_current", label: "发票识别", createdAt: 1, lastUsedAt: 3 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions" },
    }, {
      conversationKey: "oc_p2p_1:main",
      threadKey: "main",
    });

    expect(appAny.sessionMap["oc_p2p_1"]).toBeUndefined();
    expect(appAny.sessionMap["oc_p2p_1:main"]?.activeSessionId).toBe("ses_current");
    expect(appAny.sessionMap["oc_p2p_1:main"]?.sessions.map((session) => session.sessionId)).toEqual(["ses_current", "ses_legacy"]);
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

  it("uses /new title as the new session label", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const createSession = vi.fn(async (title: string) => ({
      id: "ses_named",
      title,
      time: { created: 1, updated: 1 },
    }));
    const appAny = app as unknown as {
      opencode: { createSession: typeof createSession };
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.opencode = { ...(appAny.opencode ?? {}), createSession };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "new", title: "劳动争议分析" },
    });

    expect(createSession).toHaveBeenCalledWith("劳动争议分析");
    expect(appAny.sessionMap["oc_p2p_1"]?.activeSessionId).toBe("ses_named");
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions[0]?.label).toBe("劳动争议分析");
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已创建新会话");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("劳动争议分析");
  });

  it("switches the current window to the new session and stores a thread anchor when /new is sent from a busy window", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const createSession = vi.fn(async (title: string) => ({
      id: "ses_threaded",
      title,
      time: { created: 1, updated: 1 },
    }));
    const appAny = app as unknown as {
      opencode: { createSession: typeof createSession };
      sessionMap: Record<string, SessionWindowRecord>;
      pendingNewSessionAnchors: Map<string, { sourceConversationKey: string; entry: { sessionId: string; label: string } }>;
    };
    appAny.opencode = { ...(appAny.opencode ?? {}), createSession };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_existing",
      sessions: [
        { sessionId: "ses_existing", label: "下午好", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "new", title: "劳动争议分析" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.activeSessionId).toBe("ses_threaded");
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions).toHaveLength(2);
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions.map((session) => session.sessionId)).toContain("ses_threaded");
    expect(appAny.pendingNewSessionAnchors.get("om_reply")).toEqual(expect.objectContaining({
      sourceConversationKey: "oc_p2p_1",
      entry: expect.objectContaining({ sessionId: "ses_threaded", label: "劳动争议分析" }),
    }));
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("当前会话");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("已切换到新会话");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("创建话题");
  });

  it("truncates long /new titles in bridge labels while keeping the OpenCode title intact", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const createSession = vi.fn(async (title: string) => ({
      id: "ses_named_long",
      title,
      time: { created: 1, updated: 1 },
    }));
    const appAny = app as unknown as {
      opencode: { createSession: typeof createSession };
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.opencode = { ...(appAny.opencode ?? {}), createSession };
    const longTitle = "这是一个特别特别特别特别特别长的劳动争议分析会话标题用于测试";

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "new", title: longTitle },
    });

    expect(createSession).toHaveBeenCalledWith(longTitle);
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions[0]?.label.length).toBe(24);
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions[0]?.label.endsWith("...")).toBe(true);
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("...");
  });

  it("hydrates the first thread message from the /new reply anchor", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const createSession = vi.fn(async (title: string) => ({
      id: "ses_threaded",
      title,
      time: { created: 1, updated: 1 },
    }));
    const promptAsync = vi.fn(async () => ({ id: "evt_1" }));
    const appAny = app as unknown as {
      opencode: {
        health: () => Promise<{ ok: boolean }>;
        createSession: typeof createSession;
        listSessions: () => Promise<Array<{ id: string; title: string; time: { created: number; updated: number } }>>;
        promptAsync: typeof promptAsync;
      };
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.opencode = {
      ...(appAny.opencode ?? {}),
      health: async () => ({ ok: true }),
      createSession,
      listSessions: async () => [{ id: "ses_threaded", title: "劳动争议分析", time: { created: 1, updated: 1 } }],
      promptAsync,
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_existing",
      sessions: [
        { sessionId: "ses_existing", label: "下午好", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "new", title: "劳动争议分析" },
    });

    await app.handleIncomingMessage({
      ...createIncomingMessage("om_thread_1"),
      conversationKey: "oc_p2p_1:om_reply",
      threadKey: "om_reply",
      rootId: "om_reply",
      plainText: "继续分析这个劳动争议",
      rawContent: "继续分析这个劳动争议",
    });

    expect(appAny.sessionMap["oc_p2p_1:om_reply"]?.activeSessionId).toBe("ses_threaded");
    expect(appAny.sessionMap["oc_p2p_1:om_reply"]?.sessions[0]?.label).toBe("劳动争议分析");
    expect(appAny.sessionMap["oc_p2p_1"]?.activeSessionId).toBe("ses_threaded");
  });

  it("hydrates a thread from the /new reply parent id when root id points elsewhere", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const createSession = vi.fn(async (title: string) => ({
      id: "ses_parent_threaded",
      title,
      time: { created: 1, updated: 1 },
    }));
    const appAny = app as unknown as {
      opencode: {
        health: () => Promise<{ ok: boolean }>;
        createSession: typeof createSession;
        listSessions: () => Promise<Array<{ id: string; title: string; time: { created: number; updated: number } }>>;
        promptAsync: () => Promise<{ id: string }>;
      };
      sessionMap: Record<string, SessionWindowRecord>;
    };
    appAny.opencode = {
      ...(appAny.opencode ?? {}),
      health: async () => ({ ok: true }),
      createSession,
      listSessions: async () => [{ id: "ses_parent_threaded", title: "发票识别", time: { created: 1, updated: 1 } }],
      promptAsync: async () => ({ id: "evt_1" }),
    };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_existing",
      sessions: [
        { sessionId: "ses_existing", label: "日常聊天", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "new", title: "发票识别" },
    });

    await app.handleIncomingMessage({
      ...createIncomingMessage("om_thread_2"),
      conversationKey: "oc_p2p_1:om_thread_root",
      threadKey: "om_thread_root",
      rootId: "om_thread_root",
      parentId: "om_reply",
      plainText: "识别这张发票",
      rawContent: "识别这张发票",
    });

    expect(appAny.sessionMap["oc_p2p_1:om_thread_root"]?.activeSessionId).toBe("ses_parent_threaded");
  });

  it("expires pending /new reply anchors without waiting for a matching message", async () => {
    vi.useFakeTimers();
    try {
      const outbound = createOutbound();
      const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
      const createSession = vi.fn(async (title: string) => ({
        id: "ses_expiring",
        title,
        time: { created: 1, updated: 1 },
      }));
      const appAny = app as unknown as {
        opencode: { createSession: typeof createSession };
        sessionMap: Record<string, SessionWindowRecord>;
        pendingNewSessionAnchors: Map<string, unknown>;
        pendingNewSessionAnchorTimers: Map<string, unknown>;
      };
      appAny.opencode = { ...(appAny.opencode ?? {}), createSession };
      appAny.sessionMap["oc_p2p_1"] = {
        mode: "multi",
        activeSessionId: "ses_existing",
        sessions: [
          { sessionId: "ses_existing", label: "日常聊天", createdAt: 1, lastUsedAt: 1 },
        ],
      };

      await callHandleCommand(app, {
        kind: "command",
        command: { kind: "new", title: "临时会话" },
      });

      expect(appAny.pendingNewSessionAnchors.has("om_reply")).toBe(true);
      vi.advanceTimersByTime(10 * 60_000);
      expect(appAny.pendingNewSessionAnchors.has("om_reply")).toBe(false);
      expect(appAny.pendingNewSessionAnchorTimers.has("om_reply")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renames the current session with /rename", async () => {
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
      command: { kind: "rename", title: "合同起草" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.sessions.find((session) => session.sessionId === "ses_2")?.label).toBe("合同起草");
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已重命名会话");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("合同起草");
  });

  it("truncates long /rename titles in bridge labels", async () => {
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
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "rename", title: "这是一个特别特别特别特别特别长的合同起草标题用于测试" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.sessions[0]?.label.length).toBe(24);
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions[0]?.label.endsWith("...")).toBe(true);
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("...");
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

  it("renders /models openai as an interactive provider card", async () => {
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

  it("shows a retirement notice for the legacy /model listing alias", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "passthrough", name: "model", arguments: [] },
    });

    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("命令已更新");
    expect(extractInteractiveText(getReplyPayloads(outbound)[0])).toContain("/models");
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it("stores a window-level model override for /model use and clears it with /model reset", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as { sessionMap: Record<string, SessionWindowRecord> };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "model-use", model: "openai/gpt-5.4-mini" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.modelOverride).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-mini",
    });
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("已切换窗口模型");

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "model-reset" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.modelOverride).toBeUndefined();
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[1])).toBe("已恢复默认模型");
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

  it("filters /sessions all by keyword and keeps filtered numbering stable", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listSessions = vi.fn(async () => ([
      { id: "ses_labor", title: "劳动争议分析", time: { updated: 3 } },
      { id: "ses_invoice", title: "发票识别", time: { updated: 2 } },
      { id: "ses_contract", title: "合同审查", time: { updated: 1 } },
    ]));
    const appAny = app as unknown as {
      opencode: { listSessions: typeof listSessions };
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { listSessions };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "sessions-all", query: "劳动" },
    });

    const pending = appAny.pendingInteractions.get("oc_p2p_1") as Extract<PendingInteraction, { kind: "session-select" }>;
    expect(pending.options).toEqual([expect.objectContaining({ index: 1, sessionId: "ses_labor" })]);
    const text = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(text).toContain("劳动争议分析");
    expect(text).not.toContain("发票识别");
    expect(text).toContain("关键词：劳动");
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

  it("can hard-delete a session directly by session id", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const listSessions = vi.fn(async () => ([
      { id: "ses_hidden", title: "已隐藏会话", time: { updated: 1 } },
    ]));
    const deleteSession = vi.fn(async () => true);
    const appAny = app as unknown as {
      opencode: { listSessions: typeof listSessions; deleteSession: typeof deleteSession };
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { listSessions, deleteSession };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", sessionId: "ses_hidden", confirm: false },
    });
    const confirmText = extractInteractiveText(getReplyPayloads(outbound)[0]);
    expect(confirmText).toContain("删除 OpenCode 本地真实 session");
    expect(confirmText).toContain("已隐藏会话");
    expect(confirmText).toContain("/delete ses_hidden confirm");

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "delete", sessionId: "ses_hidden", confirm: true },
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

  it("keeps explicit knowledge-mode commands out of private chat", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query() {
          return { question: "", results: [] };
        },
        async ingestFile() {
          throw new Error("not used");
        },
        async syncMirror() {},
        close() {},
      },
      memory: null,
    });
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
      knowledgeIngestInteractions: Map<string, PendingInteraction>;
    };
    appAny.knowledgeIngestInteractions.set("oc_p2p_1", {
      kind: "knowledge-ingest-await-file",
      chatId: "oc_p2p_1",
      chatType: "p2p",
      conversationKey: "oc_p2p_1",
      requesterOpenId: "ou_123",
      replyToMessageId: "om_1",
      rootMessageId: "om_1",
      anchorMessageId: "om_anchor",
      deliveryMode: "p2p_reply",
      expiresAt: Date.now() + 600_000,
    });

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "knowledge-mode-start" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.interactionMode).toBeUndefined();
    expect(appAny.knowledgeIngestInteractions.has("oc_p2p_1")).toBe(true);
    expect(extractInteractiveHeader(getReplyPayloads(outbound)[0])).toBe("私聊里直接提问即可");

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "knowledge-mode-end" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]).toBeUndefined();
    expect(appAny.knowledgeIngestInteractions.has("oc_p2p_1")).toBe(true);
    expect(extractInteractiveHeader(getReplyPayloads(outbound).at(-1))).toBe("私聊里直接提问即可");
  });

  it("creates a dedicated ingest session and restores the previous session on exit", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query() {
          return { question: "", results: [] };
        },
        async ingestFile() {
          throw new Error("not used");
        },
        async syncMirror() {},
        close() {},
      },
      memory: null,
    });
    const createSession = vi.fn(async () => ({
      id: "ses_ingest",
      title: "知识入库",
      time: { created: Date.now(), updated: Date.now() },
    }));
    const appAny = app as unknown as {
      opencode: { createSession: typeof createSession };
      sessionMap: Record<string, SessionWindowRecord>;
      pendingInteractions: Map<string, PendingInteraction>;
      knowledgeIngestInteractions: Map<string, PendingInteraction>;
    };
    appAny.opencode = { createSession };
    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_chat",
      sessions: [
        { sessionId: "ses_chat", label: "普通对话", createdAt: 1, lastUsedAt: 1 },
      ],
    };

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "knowledge-ingest" },
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(appAny.sessionMap["oc_p2p_1"]?.activeSessionId).toBe("ses_ingest");
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions.map((session) => session.sessionId)).toEqual(["ses_ingest", "ses_chat"]);
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions.find((session) => session.sessionId === "ses_ingest")?.label).toBe("知识入库");
    expect(appAny.knowledgeIngestInteractions.get("oc_p2p_1")).toEqual(expect.objectContaining({
      kind: "knowledge-ingest-await-file",
      ingestSessionId: "ses_ingest",
      previousActiveSessionId: "ses_chat",
    }));

    await callHandleCommand(app, {
      kind: "command",
      command: { kind: "knowledge-ingest-end" },
    });

    expect(appAny.sessionMap["oc_p2p_1"]?.activeSessionId).toBe("ses_chat");
    expect(appAny.knowledgeIngestInteractions.has("oc_p2p_1")).toBe(false);
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

  it("falls back to a direct message when the process card cannot be created", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      turnExecutor: {
        context: {
          ensureSession: (source: Record<string, unknown>) => Promise<string>;
          turnCardManager: {
            createTurnCard: (chatId: string, turnId: string, sessionId: string, replyToMessageId: string) => Promise<null>;
          };
        };
        executeTurn: (conversationKey: string, turn: Record<string, unknown>) => Promise<string>;
      };
      runTurn: (conversationKey: string) => Promise<void>;
      queues: {
        get(key: string): {
          enqueue: (turn: Record<string, unknown>) => { accepted: boolean };
        };
      };
    };
    appAny.turnExecutor.context.ensureSession = vi.fn(async () => "ses_1");
    appAny.turnExecutor.context.turnCardManager.createTurnCard = vi.fn(async () => null);
    appAny.turnExecutor.executeTurn = vi.fn(async () => "最终回复");
    appAny.queues.get("oc_p2p_1").enqueue({
      turnId: "turn_1",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
      inboundMessageId: "om_1",
      plainText: "hello",
      text: "hello",
    });

    await appAny.runTurn("oc_p2p_1");

    expect(outbound.sendMessage).not.toHaveBeenCalled();
    expect(outbound.replyMessage).toHaveBeenCalledTimes(1);
    expect(outbound.replyMessage).toHaveBeenCalledWith("om_1", expect.any(Object));
    expect(extractMarkdown(getReplyPayloads(outbound)[0])).toContain("最终回复");
  });

  it("falls back to a direct error message when the process card cannot be created", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      turnExecutor: {
        context: {
          ensureSession: (source: Record<string, unknown>) => Promise<string>;
          turnCardManager: {
            createTurnCard: (chatId: string, turnId: string, sessionId: string, replyToMessageId: string) => Promise<null>;
          };
        };
        executeTurn: (conversationKey: string, turn: Record<string, unknown>) => Promise<string>;
      };
      runTurn: (conversationKey: string) => Promise<void>;
      queues: {
        get(key: string): {
          enqueue: (turn: Record<string, unknown>) => { accepted: boolean };
        };
      };
    };
    appAny.turnExecutor.context.ensureSession = vi.fn(async () => "ses_1");
    appAny.turnExecutor.context.turnCardManager.createTurnCard = vi.fn(async () => null);
    appAny.turnExecutor.executeTurn = vi.fn(async () => {
      throw new Error("服务暂时不可用");
    });
    appAny.queues.get("oc_p2p_1").enqueue({
      turnId: "turn_1",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
      inboundMessageId: "om_1",
      plainText: "hello",
      text: "hello",
    });

    await appAny.runTurn("oc_p2p_1");

    expect(outbound.sendMessage).not.toHaveBeenCalled();
    expect(outbound.replyMessage).toHaveBeenCalledTimes(1);
    expect(outbound.replyMessage).toHaveBeenCalledWith("om_1", expect.any(Object));
    expect(extractMarkdown(getReplyPayloads(outbound)[0])).toContain("处理失败：服务暂时不可用");
  });

  it("maps token refresh failures to an actionable provider login hint", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      turnExecutor: {
        context: {
          ensureSession: (source: Record<string, unknown>) => Promise<string>;
          turnCardManager: {
            createTurnCard: (chatId: string, turnId: string, sessionId: string, replyToMessageId: string) => Promise<null>;
          };
        };
        executeTurn: (conversationKey: string, turn: Record<string, unknown>) => Promise<string>;
      };
      runTurn: (conversationKey: string) => Promise<void>;
      queues: {
        get(key: string): {
          enqueue: (turn: Record<string, unknown>) => { accepted: boolean };
        };
      };
    };
    appAny.turnExecutor.context.ensureSession = vi.fn(async () => "ses_1");
    appAny.turnExecutor.context.turnCardManager.createTurnCard = vi.fn(async () => null);
    appAny.turnExecutor.executeTurn = vi.fn(async () => {
      throw new Error("Token refresh failed: 401");
    });
    appAny.queues.get("oc_p2p_1").enqueue({
      turnId: "turn_1",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
      inboundMessageId: "om_1",
      plainText: "hello",
      text: "hello",
    });

    await appAny.runTurn("oc_p2p_1");

    expect(outbound.sendMessage).not.toHaveBeenCalled();
    expect(outbound.replyMessage).toHaveBeenCalledTimes(1);
    expect(outbound.replyMessage).toHaveBeenCalledWith("om_1", expect.any(Object));
    expect(extractMarkdown(getReplyPayloads(outbound)[0])).toContain("请重新执行 `opencode providers login`");
  });

  it("keeps session selection state after an unrelated turn finishes", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      turnExecutor: {
        context: {
          ensureSession: (source: Record<string, unknown>) => Promise<string>;
          turnCardManager: {
            createTurnCard: (chatId: string, turnId: string, sessionId: string, replyToMessageId: string) => Promise<null>;
          };
        };
        executeTurn: (conversationKey: string, turn: Record<string, unknown>) => Promise<string>;
      };
      runTurn: (conversationKey: string) => Promise<void>;
      queues: {
        get(key: string): {
          enqueue: (turn: Record<string, unknown>) => { accepted: boolean };
        };
      };
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.turnExecutor.context.ensureSession = vi.fn(async () => "ses_1");
    appAny.turnExecutor.context.turnCardManager.createTurnCard = vi.fn(async () => null);
    appAny.turnExecutor.executeTurn = vi.fn(async () => "done");
    appAny.pendingInteractions.set("oc_p2p_1", {
      kind: "session-select",
      expiresAt: Date.now() + 30_000,
      options: [
        { index: 1, sessionId: "ses_1", title: "会话1", current: true },
      ],
    });
    appAny.queues.get("oc_p2p_1").enqueue({
      turnId: "turn_1",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
      inboundMessageId: "om_1",
      plainText: "hello",
      text: "hello",
    });

    await appAny.runTurn("oc_p2p_1");

    expect(appAny.pendingInteractions.get("oc_p2p_1")).toEqual(expect.objectContaining({
      kind: "session-select",
    }));
  });

  it("allows parallel turns after switching to another session in the same window", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const startedSessions: string[] = [];
    const resolvers = new Map<string, () => void>();
    const appAny = app as unknown as {
      sessionMap: Record<string, SessionWindowRecord>;
      runningChats: Map<string, Promise<void>>;
      ensureSession: (source: { conversationKey: string }) => Promise<string>;
      ensureServerAvailableForMessage: (message: { messageId: string }) => Promise<boolean>;
      turnExecutor: {
        context: {
          turnCardManager: {
            createTurnCard: (chatId: string, turnId: string, sessionId: string, replyToMessageId: string) => Promise<null>;
          };
        };
        executeTurn: (queueKey: string, turn: Record<string, unknown>) => Promise<string>;
      };
    };

    appAny.sessionMap["oc_p2p_1"] = {
      mode: "multi",
      activeSessionId: "ses_1",
      sessions: [
        { sessionId: "ses_1", label: "会话一", createdAt: 1, lastUsedAt: 2 },
        { sessionId: "ses_2", label: "会话二", createdAt: 1, lastUsedAt: 1 },
      ],
    };
    appAny.ensureServerAvailableForMessage = vi.fn(async () => true);
    appAny.ensureSession = vi.fn(async (source) => appAny.sessionMap[source.conversationKey]?.activeSessionId ?? "ses_1");
    appAny.turnExecutor.context.turnCardManager.createTurnCard = vi.fn(async () => null);
    appAny.turnExecutor.executeTurn = vi.fn(async (_queueKey, turn) => {
      const sessionId = String(turn.sessionId);
      startedSessions.push(sessionId);
      await new Promise<void>((resolve) => {
        resolvers.set(sessionId, resolve);
      });
      return `reply-${sessionId}`;
    });

    const firstRun = app.handleIncomingMessage(createIncomingMessage("om_1"));
    await vi.waitFor(() => expect(startedSessions).toEqual(["ses_1"]));

    appAny.sessionMap["oc_p2p_1"] = {
      ...appAny.sessionMap["oc_p2p_1"],
      activeSessionId: "ses_2",
    };
    const secondRun = app.handleIncomingMessage({
      ...createIncomingMessage("om_2"),
      rawContent: "hello 2",
      plainText: "hello 2",
    });

    await vi.waitFor(() => expect(startedSessions).toEqual(["ses_1", "ses_2"]));
    expect(appAny.runningChats.size).toBe(2);
    expect(JSON.stringify(outbound.replyMessage.mock.calls)).not.toContain("排在第1位");

    resolvers.get("ses_1")?.();
    resolvers.get("ses_2")?.();
    await Promise.all([firstRun, secondRun]);
  });

  it("clears question state owned by the finishing turn", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const appAny = app as unknown as {
      turnExecutor: {
        context: {
          ensureSession: (source: Record<string, unknown>) => Promise<string>;
          turnCardManager: {
            createTurnCard: (chatId: string, turnId: string, sessionId: string, replyToMessageId: string) => Promise<null>;
          };
        };
        executeTurn: (conversationKey: string, turn: Record<string, unknown>) => Promise<string>;
      };
      runTurn: (conversationKey: string) => Promise<void>;
      queues: {
        get(key: string): {
          enqueue: (turn: Record<string, unknown>) => { accepted: boolean };
        };
      };
      pendingInteractions: Map<string, PendingInteraction>;
    };
    appAny.turnExecutor.context.ensureSession = vi.fn(async () => "ses_1");
    appAny.turnExecutor.context.turnCardManager.createTurnCard = vi.fn(async () => null);
    appAny.turnExecutor.executeTurn = vi.fn(async () => "done");
    appAny.pendingInteractions.set("oc_p2p_1", {
      kind: "question",
      turnId: "turn_1",
      requestId: "q_1",
      sessionId: "ses_1",
      questions: [{ header: "问题", question: "请补充信息" }],
    });
    appAny.queues.get("oc_p2p_1").enqueue({
      turnId: "turn_1",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      senderOpenId: "ou_123",
      inboundMessageId: "om_1",
      plainText: "hello",
      text: "hello",
    });

    await appAny.runTurn("oc_p2p_1");

    expect(appAny.pendingInteractions.has("oc_p2p_1")).toBe(false);
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
    | { kind: "new"; title?: string | undefined }
    | { kind: "rename"; title: string }
    | { kind: "abort" }
    | { kind: "models"; provider?: string | undefined }
    | { kind: "model-use"; model: string }
    | { kind: "model-reset" }
    | { kind: "passthrough"; name: string; arguments: string[] }
    | { kind: "knowledge-ingest" }
    | { kind: "knowledge-mode-start" }
    | { kind: "knowledge-mode-end" }
    | { kind: "knowledge-ingest-end" }
    | { kind: "sessions" }
    | { kind: "sessions-all"; query?: string | undefined }
    | { kind: "sessions-select"; index?: number | undefined; query?: string | undefined }
    | { kind: "close"; index?: number | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined }
    | { kind: "delete"; index?: number | undefined; sessionId?: string | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined; confirm: boolean };
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
    messageType: "text" as const,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
