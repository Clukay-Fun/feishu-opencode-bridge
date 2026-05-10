/**
 * 职责: 覆盖turn 执行器事件处理和收尾逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnExecutor, type TurnExecutorContext } from "../src/runtime/turn-executor.js";
import type { BridgeMessageContextStore } from "../src/runtime/message-context.js";

describe("TurnExecutor text buffering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not surface non-assistant text before the assistant message is confirmed", async () => {
    const executor = new TurnExecutor(createContext()) as unknown as {
      handleEvent: (turn: Record<string, unknown>, event: Record<string, unknown>, runtime: ReturnType<typeof createRuntime>) => Promise<void>;
      flushPendingTextEvents: (
        assistantMessageId: string,
        pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }>,
        runtime: { appendFinalText: (delta: string) => Promise<void>; setFinalText: (value: string) => Promise<void> },
      ) => Promise<void>;
    };
    const pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }> = [];
    const runtime = createRuntime(executor, pendingTextEvents);

    await executor.handleEvent(createTurn(), {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_user", field: "text", delta: "用户原问题" },
    }, runtime);
    await executor.handleEvent(createTurn(), {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_assistant", field: "text", delta: "助手开头" },
    }, runtime);

    expect(runtime.getFinalText()).toBe("");

    await executor.handleEvent(createTurn(), {
      type: "message.updated",
      properties: { info: { id: "msg_assistant", role: "assistant", sessionID: "ses_1" } },
    }, runtime);
    await executor.handleEvent(createTurn(), {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_assistant", field: "text", delta: "，继续回答" },
    }, runtime);

    expect(runtime.getFinalText()).toBe("助手开头，继续回答");
  });

  it("buffers text part updates until the assistant message is confirmed", async () => {
    const executor = new TurnExecutor(createContext()) as unknown as {
      handleEvent: (turn: Record<string, unknown>, event: Record<string, unknown>, runtime: ReturnType<typeof createRuntime>) => Promise<void>;
      flushPendingTextEvents: (
        assistantMessageId: string,
        pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }>,
        runtime: { appendFinalText: (delta: string) => Promise<void>; setFinalText: (value: string) => Promise<void> },
      ) => Promise<void>;
    };
    const pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }> = [];
    const runtime = createRuntime(executor, pendingTextEvents);

    await executor.handleEvent(createTurn(), {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_assistant",
          type: "text",
          messageID: "msg_assistant",
          text: "完整回答",
        },
      },
    }, runtime);

    expect(runtime.getFinalText()).toBe("");

    await executor.handleEvent(createTurn(), {
      type: "message.updated",
      properties: { info: { id: "msg_assistant", role: "assistant", sessionID: "ses_1" } },
    }, runtime);

    expect(runtime.getFinalText()).toBe("完整回答");
  });

  it("renders a clear text fallback for permission requests", async () => {
    const context = createContext();
    let capturedPayload: { content: string } | null = null;
    const sendPayload: TurnExecutorContext["sendPayload"] = vi.fn(async (_chatId, payload) => {
      capturedPayload = payload;
      return { messageId: "om_permission_1" };
    });
    context.sendPayload = sendPayload;
    const executor = new TurnExecutor(context) as unknown as {
      handleEvent: (turn: Record<string, unknown>, event: Record<string, unknown>, runtime: ReturnType<typeof createRuntime>) => Promise<void>;
      flushPendingTextEvents: (
        assistantMessageId: string,
        pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }>,
        runtime: { appendFinalText: (delta: string) => Promise<void>; setFinalText: (value: string) => Promise<void> },
      ) => Promise<void>;
    };
    const runtime = createRuntime(executor, []);

    await executor.handleEvent(createTurn(), {
      type: "permission.asked",
      properties: { sessionID: "ses_1", id: "per_1", permission: "bash" },
    }, runtime);

    expect(capturedPayload).not.toBeNull();
    const content = JSON.parse(capturedPayload!.content) as { zh_cn: { content: Array<Array<{ tag: string; text: string }>> } };
    const text = content.zh_cn.content[0]?.[0]?.text ?? "";
    expect(text).toContain("OpenCode 请求权限：`bash`");
    expect(text).toContain("`/allow always`：始终允许，后续同类权限不再弹出");
  });

  it("cleans turn-owned resources after a successful run", async () => {
    const context = createContext();
    const cleanupTurnResources = vi.fn(async () => {});
    const replaceActive = vi.fn();
    context.cleanupTurnResources = cleanupTurnResources;
    context.queues.get = () => ({
      peek: () => createTurn(),
      replaceActive,
      current: () => createTurn(),
      finishActive() {},
    });
    const executor = new TurnExecutor(context) as unknown as {
      runTurn: (queueKey: string) => Promise<void>;
      executeTurn: () => Promise<string>;
    };
    executor.executeTurn = vi.fn(async () => "最终回复");

    await executor.runTurn("queue-1");

    expect(cleanupTurnResources).toHaveBeenCalledWith("turn_1");
    expect(replaceActive).toHaveBeenCalled();
  });

  it("sends the first progress card before creating a missing session", async () => {
    const context = createContext();
    const order: string[] = [];
    const replaceActive = vi.fn();
    context.queues.get = () => ({
      peek: () => createTurn({ sessionId: undefined }),
      replaceActive,
      current: () => createTurn(),
      finishActive() {},
    });
    context.turnCardManager.createTurnCard = vi.fn(async (_chatId, _turnId, sessionId) => {
      order.push(`card:${sessionId}`);
      return { messageId: "om_card" };
    });
    context.turnCardManager.updateTurnCard = vi.fn(async (_turnId, update) => {
      if (update.sessionId) order.push(`card-session:${update.sessionId}`);
    });
    context.ensureSession = vi.fn(async () => {
      order.push("ensure-session");
      return "ses_created";
    });
    const executor = new TurnExecutor(context) as unknown as {
      runTurn: (queueKey: string) => Promise<void>;
      executeTurn: () => Promise<string>;
    };
    executor.executeTurn = vi.fn(async () => "最终回复");

    await executor.runTurn("queue-1");

    expect(order.slice(0, 3)).toEqual(["card:准备中", "ensure-session", "card-session:ses_created"]);
    expect(replaceActive).toHaveBeenCalledWith(expect.objectContaining({ processMessageId: "om_card" }));
  });

  it("cleans turn-owned resources after a failed run", async () => {
    const context = createContext();
    const cleanupTurnResources = vi.fn(async () => {});
    context.cleanupTurnResources = cleanupTurnResources;
    context.queues.get = () => ({
      peek: () => createTurn(),
      replaceActive() {},
      current: () => createTurn(),
      finishActive() {},
    });
    const executor = new TurnExecutor(context) as unknown as {
      runTurn: (queueKey: string) => Promise<void>;
      executeTurn: () => Promise<string>;
    };
    executor.executeTurn = vi.fn(async () => {
      throw new Error("总超时");
    });

    await executor.runTurn("queue-1");

    expect(cleanupTurnResources).toHaveBeenCalledWith("turn_1");
  });

  it("falls back to the latest completed assistant message when SSE does not arrive", async () => {
    vi.useFakeTimers();
    const context = createContext();
    const replaceActive = vi.fn();
    const scheduleStreamUpdate = vi.fn(async () => {});
    context.queues.get = () => ({
      peek: () => createTurn(),
      replaceActive,
      current: () => createTurn(),
      finishActive() {},
    });
    context.opencode.promptAsync = vi.fn(async () => ({}));
    context.opencode.getSessionMessages = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{
        info: {
          id: "msg_assistant",
          role: "assistant",
          sessionID: "ses_1",
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [{ type: "text", text: "fallback 最终回复" }],
      }]);
    context.turnCardManager.scheduleStreamUpdate = scheduleStreamUpdate;
    const executor = new TurnExecutor(context) as unknown as {
      runTurn: (queueKey: string) => Promise<void>;
    };

    const run = executor.runTurn("queue-1");
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(scheduleStreamUpdate).toHaveBeenCalledWith("turn_1", "fallback 最终回复");
    expect(replaceActive).toHaveBeenCalledWith(expect.objectContaining({ state: "done" }));
  });

  it("passes a window-level model override to OpenCode prompt requests", async () => {
    vi.useFakeTimers();
    const context = createContext();
    const promptAsync = vi.fn(async () => ({}));
    context.queues.get = () => ({
      peek: () => createTurn({ model: { providerID: "openai", modelID: "gpt-5.4-mini" } }),
      replaceActive() {},
      current: () => createTurn(),
      finishActive() {},
    });
    context.opencode.promptAsync = promptAsync;
    context.opencode.getSessionMessages = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{
        info: {
          id: "msg_assistant",
          role: "assistant",
          sessionID: "ses_1",
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [{ type: "text", text: "fallback 最终回复" }],
      }]);
    const executor = new TurnExecutor(context) as unknown as {
      runTurn: (queueKey: string) => Promise<void>;
    };

    const run = executor.runTurn("queue-1");
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(promptAsync).toHaveBeenCalledWith("ses_1", expect.objectContaining({
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
    }));
  });

  it("surfaces OpenCode session errors with actionable model guidance", async () => {
    const context = createContext();
    const updateTurnCard = vi.fn(async () => {});
    context.turnCardManager.createTurnCard = vi.fn(async () => ({ messageId: "om_card" }));
    context.turnCardManager.updateTurnCard = updateTurnCard;
    context.queues.get = () => ({
      peek: () => createTurn({ model: { providerID: "minimax-cn-coding-plan", modelID: "MiniMax-M2.7" } }),
      replaceActive() {},
      current: () => createTurn(),
      finishActive() {},
    });
    context.opencode.promptAsync = vi.fn(async () => {
      queueMicrotask(() => {
        void listener?.({
          type: "session.error",
          properties: {
            sessionID: "ses_1",
            error: {
              name: "ProviderModelNotFoundError",
              data: {
                providerID: "minimax-cn-coding-plan",
                modelID: "MiniMax-M2.7",
              },
            },
          },
          sessionId: "ses_1",
          receivedAt: Date.now(),
          streamEndpoint: "/event",
          raw: {},
        });
      });
      return {};
    });
    let listener: ((event: Record<string, unknown>) => Promise<void>) | null = null;
    context.eventStream.subscribe = (handler) => {
      listener = handler as (event: Record<string, unknown>) => Promise<void>;
      return () => {};
    };
    const executor = new TurnExecutor(context) as unknown as {
      runTurn: (queueKey: string) => Promise<void>;
    };

    await executor.runTurn("queue-1");

    expect(updateTurnCard).toHaveBeenCalledWith("turn_1", expect.objectContaining({
      status: "处理失败",
      target: "final",
      update: expect.stringContaining("/model reset"),
    }));
  });

  it("normalizes generic model-not-found errors from OpenCode", async () => {
    const context = createContext();
    const updateTurnCard = vi.fn(async () => {});
    context.turnCardManager.createTurnCard = vi.fn(async () => ({ messageId: "om_card" }));
    context.turnCardManager.updateTurnCard = updateTurnCard;
    context.queues.get = () => ({
      peek: () => createTurn(),
      replaceActive() {},
      current: () => createTurn(),
      finishActive() {},
    });
    context.opencode.promptAsync = vi.fn(async () => {
      queueMicrotask(() => {
        void listener?.({
          type: "session.error",
          properties: {
            sessionID: "ses_1",
            error: {
              name: "UnknownError",
              data: {
                message: "Model not found: minimax-cn-coding-plan/MiniMax-M2.7.",
              },
            },
          },
          sessionId: "ses_1",
          receivedAt: Date.now(),
          streamEndpoint: "/event",
          raw: {},
        });
      });
      return {};
    });
    let listener: ((event: Record<string, unknown>) => Promise<void>) | null = null;
    context.eventStream.subscribe = (handler) => {
      listener = handler as (event: Record<string, unknown>) => Promise<void>;
      return () => {};
    };
    const executor = new TurnExecutor(context) as unknown as {
      runTurn: (queueKey: string) => Promise<void>;
    };

    await executor.runTurn("queue-1");

    expect(updateTurnCard).toHaveBeenCalledWith("turn_1", expect.objectContaining({
      update: expect.stringContaining("`minimax-cn-coding-plan/MiniMax-M2.7` 在 OpenCode provider 中不存在"),
    }));
  });
});

function createContext(): TurnExecutorContext {
  return {
    config: {
      bridge: {
        injectSystemState: false,
        firstEventTimeoutMs: 30_000,
        eventGapTimeoutMs: 120_000,
        totalTimeoutMs: 300_000,
      },
      feishu: {
        cardActions: {
          enabled: false,
        },
      },
    },
    logger: {
      log() {},
      logTranscript() {},
    } as TurnExecutorContext["logger"],
    queues: {
      get() {
        return {
          peek() { return null; },
          replaceActive() {},
          current() { return null; },
          finishActive() {},
        };
      },
    },
    opencode: {
      async promptAsync() { return {}; },
      async getSessionMessages() { return []; },
    },
    eventStream: {
      subscribe() {
        return () => {};
      },
    },
    sessionStatuses: new Map(),
    turnCardManager: {
      async createTurnCard() { return null; },
      async flushStreamUpdate() {},
      async updateTurnCard() {},
      async scheduleStreamUpdate() {},
      cleanup() {},
    },
    permissionManager: {
      async registerInteraction() { return false; },
      buildActionButtons() { return []; },
    },
    moduleManager: {
      async collectBeforeTurnBlocks() { return []; },
      async runAfterTurnHooks() {},
    },
    getSessionWindow() {
      return { mode: "single", activeSessionId: null, sessions: [] };
    },
    async ensureSession() { return "ses_1"; },
    async maybeUpdateSessionLabel() {},
    clearPendingInteraction() {},
    clearTurnOwnedPendingInteraction() {},
    async cleanupTurnResources() {},
    setPendingInteraction() {},
    async sendPayload() {
      return { messageId: "om_reply_1" };
    },
    messageContextStore: {
      buildRuntimeContext() { return []; },
      buildPromptBlock() { return null; },
      rememberBridgeOutput() {},
    } as unknown as BridgeMessageContextStore,
  };
}

function createTurn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: "turn_1",
    chatId: "oc_p2p_1",
    chatType: "p2p",
    conversationKey: "oc_p2p_1",
    threadKey: "om_1",
    inboundMessageId: "om_1",
    senderOpenId: "ou_123",
    sessionId: "ses_1",
    plainText: "帮我处理一下",
    text: "帮我处理一下",
    ...overrides,
  };
}

function createRuntime(
  executor: {
    flushPendingTextEvents: (
      assistantMessageId: string,
      pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }>,
      runtime: { appendFinalText: (delta: string) => Promise<void>; setFinalText: (value: string) => Promise<void> },
    ) => Promise<void>;
  },
  pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }>,
) {
  let assistantMessageId: string | null = null;
  let finalText = "";

  return {
    getAssistantMessageId: () => assistantMessageId,
    setAssistantMessageId: async (value: string | null) => {
      assistantMessageId = value;
      if (assistantMessageId) {
        await executor.flushPendingTextEvents(assistantMessageId, pendingTextEvents, {
          appendFinalText: async (delta: string) => {
            finalText += delta;
          },
          setFinalText: async (value: string) => {
            finalText = value;
          },
        });
      }
    },
    ignoredTextPartIds: new Set<string>(),
    queuePendingTextEvent: (messageId: string, eventType: "delta" | "set", value: string) => {
      pendingTextEvents.push({ messageId, kind: eventType, value });
    },
    appendFinalText: async (delta: string) => {
      finalText += delta;
    },
    setFinalText: async (value: string) => {
      finalText = value;
    },
    finish: async () => {},
    fail: () => {},
    getFinalText: () => finalText,
    snoozeWatchdog: () => {},
  };
}
