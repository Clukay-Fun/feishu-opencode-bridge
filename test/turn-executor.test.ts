import { describe, expect, it, vi } from "vitest";

import { TurnExecutor, type TurnExecutorContext } from "../src/runtime/turn-executor.js";

describe("TurnExecutor text buffering", () => {
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
      registerInteraction() {},
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
  };
}

function createTurn() {
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
