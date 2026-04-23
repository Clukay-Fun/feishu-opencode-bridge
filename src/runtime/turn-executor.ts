/**
 * 职责: 执行单个 BridgeTurn，并驱动与 OpenCode 的交互过程。
 * 关注点:
 * - 监听事件流并处理提问、权限、完成等关键事件。
 * - 协调看门狗、模块钩子、卡片管理器和错误收尾逻辑。
 */
import crypto from "node:crypto";

import type { PendingPermissionInteraction } from "../bridge/state.js";
import type { ModuleManager } from "../bridge/module.js";
import { transitionTurn } from "../bridge/state-machine.js";
import { TurnWatchdog } from "../bridge/watchdog.js";
import type { BridgeTurn } from "../bridge/turn.js";
import { buildPermissionRequestCardPayload } from "../feishu/runtime-cards.js";
import { buildPostMarkdownPayload, type FeishuPostPayload } from "../feishu/shared-primitives.js";
import { createTextPreview, logEvent, runWithLogContext, type Logger, type TranscriptType } from "../logging/logger.js";
import { type OpenCodeMessage, type OpenCodeSessionStatus } from "../opencode/client.js";
import { getEventSessionId, type OpenCodeEvent } from "../opencode/events.js";
import { type SessionWindowRecord } from "../store/mappings.js";
import type { PendingInteraction } from "../bridge/state.js";
import {
  buildBridgeSystemPrompt,
  buildPromptRequest,
  composeSystemPrompt,
  escapeMarkdownText,
  extractAssistantText,
  formatQuestionPrompt,
  formatToolRecord,
  getMessageTimestamp,
  isAssistantMessageAfterBaseline,
  isCompletedMessage,
  readOptionalBoolean,
  readOptionalRecord,
  readOptionalString,
  summarizeReasoningToProgress,
  toQuestionRequest,
} from "./app-helpers.js";
import { cleanAssistantReply } from "./sanitize.js";

const FIRST_SSE_FALLBACK_MS = 5_000;
const PERMISSION_TTL_MS = 120_000;

/**
 * 负责管理一次 turn 执行的收敛过程，避免重复完成或重复报错。
 */
type TurnExecutionSettlementOptions = {
  finalize: () => Promise<string>;
  reject: (reason?: unknown) => void;
  resolve: (value: string) => void;
  unsubscribe: () => void;
  watchdog: TurnWatchdog;
};

class TurnExecutionSettlement {
  private settled = false;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private seenSessionEvent = false;

  constructor(private readonly options: TurnExecutionSettlementOptions) {}

  /** 在首个 SSE 长时间未到达时触发兜底检查。 */
  startFallback(runFallback: () => void): void {
    this.fallbackTimer = setTimeout(() => {
      if (!this.seenSessionEvent) {
        runFallback();
      }
    }, FIRST_SSE_FALLBACK_MS);
  }

  /** 标记已经收到当前 session 的事件。 */
  markSessionEvent(): void {
    this.seenSessionEvent = true;
    this.clearFallbackTimer();
  }

  /** 根据事件节奏刷新或延长看门狗计时。 */
  markWatchdogEvent(nextWatchdogGapMs: number | null): void {
    if (nextWatchdogGapMs !== null) {
      this.options.watchdog.snoozeEventGap(nextWatchdogGapMs);
      return;
    }

    this.options.watchdog.markEvent();
  }

  /** 以错误结束本次执行。 */
  settleWithError(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.options.reject(error);
  }

  /** 正常完成本次执行，并在需要时做最终文本收敛。 */
  async settleWithText(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    try {
      this.options.resolve(await this.options.finalize());
    } catch (error) {
      this.options.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private cleanup(): void {
    this.clearFallbackTimer();
    this.options.unsubscribe();
    this.options.watchdog.clear();
  }

  private clearFallbackTimer(): void {
    if (!this.fallbackTimer) return;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }
}

type RuntimeQueue = {
  peek(): BridgeTurn | null;
  replaceActive(turn: BridgeTurn): void;
  current(): BridgeTurn | null;
  finishActive(): void;
};

export type TurnExecutorContext = {
  config: {
    bridge: {
      injectSystemState: boolean;
      firstEventTimeoutMs: number;
      eventGapTimeoutMs: number;
      totalTimeoutMs: number;
    };
    feishu: {
      cardActions: {
        enabled: boolean;
      };
    };
  };
  logger: Logger;
  queues: {
    get(key: string): RuntimeQueue;
  };
  opencode: {
    promptAsync(sessionId: string, input: ReturnType<typeof buildPromptRequest>): Promise<unknown>;
    getSessionMessages(sessionId: string, limit: number): Promise<OpenCodeMessage[]>;
  };
  eventStream: {
    subscribe(handler: (event: OpenCodeEvent) => Promise<void>): () => void;
  };
  sessionStatuses: Map<string, OpenCodeSessionStatus>;
  turnCardManager: {
    createTurnCard(chatId: string, turnId: string, sessionId: string, replyToMessageId: string): Promise<{ messageId: string } | null>;
    flushStreamUpdate(turnId: string, text: string, force: boolean): Promise<void>;
    updateTurnCard(turnId: string, update: { status?: string; update?: string; sanitize?: boolean; target?: "step" | "tool" | "final"; toolKey?: string }): Promise<void>;
    scheduleStreamUpdate(turnId: string, text: string): Promise<void>;
    cleanup(turnId: string): void;
  };
  permissionManager: {
    registerInteraction(interaction: PendingPermissionInteraction): void;
    buildActionButtons(interaction: PendingPermissionInteraction): Array<{
      label: string;
      type: "default" | "primary" | "danger";
      value: Record<string, unknown>;
    }>;
  };
  moduleManager: Pick<ModuleManager, "collectBeforeTurnBlocks" | "runAfterTurnHooks">;
  getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord;
  ensureSession(source: Pick<BridgeTurn, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<string>;
  maybeUpdateSessionLabel(turn: BridgeTurn & { sessionId: string }): Promise<void>;
  clearPendingInteraction(conversationKey: string, keepNonExpiring: boolean): void;
  clearTurnOwnedPendingInteraction(conversationKey: string, turnId: string): void;
  cleanupTurnResources(turnId: string): Promise<void>;
  setPendingInteraction(conversationKey: string, interaction: PendingInteraction): void;
  sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
  ): Promise<{ messageId: string }>;
};

export class TurnExecutor {
  constructor(private readonly context: TurnExecutorContext) {}

  // #region 队列入口

  /** 持续消费指定队列中的 turn，直到队列清空。 */
  async processChat(queueKey: string): Promise<void> {
    const queue = this.context.queues.get(queueKey);
    while (queue.current()) {
      await this.runTurn(queueKey);
      queue.finishActive();
    }
  }

  /** 在 assistant 消息 id 确定后回放之前积压的文本事件。 */
  private async flushPendingTextEvents(
    assistantMessageId: string,
    pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }>,
    runtime: {
      appendFinalText: (delta: string) => Promise<void>;
      setFinalText: (value: string) => Promise<void>;
    },
  ): Promise<void> {
    const matchingEvents = pendingTextEvents.filter((event) => event.messageId === assistantMessageId);
    pendingTextEvents.length = 0;

    for (const event of matchingEvents) {
      if (event.kind === "set") {
        await runtime.setFinalText(event.value);
        continue;
      }

      await runtime.appendFinalText(event.value);
    }
  }

  /** 执行当前队列头部的 turn，并补齐日志上下文。 */
  async runTurn(queueKey: string): Promise<void> {
    const queue = this.context.queues.get(queueKey);
    const active = queue.peek();
    if (!active) return;

    await runWithLogContext(active.logContext ?? {
      turnId: active.turnId,
      chatId: active.chatId,
      userId: active.senderOpenId,
      messageId: active.inboundMessageId,
      sessionId: active.sessionId,
    }, async () => {
      await this.runTurnWithContext(queueKey, active);
    });
  }

  /** 包裹单个 turn 的完整执行与收尾逻辑。 */
  private async runTurnWithContext(queueKey: string, active: BridgeTurn): Promise<void> {
    const queue = this.context.queues.get(queueKey);
    let turn = transitionTurn(active, "running");
    queue.replaceActive(turn);
    let hasProcessCard = false;

    try {
      const sessionId = turn.sessionId ?? await this.context.ensureSession(turn);
      turn = { ...turn, sessionId, logContext: { ...(turn.logContext ?? {}), sessionId } };
      queue.replaceActive(turn);
      logEvent(this.context.logger, "bridge/queue", "turn.started", { turnId: turn.turnId, sessionId, chatId: turn.chatId, conversationKey: turn.conversationKey });

      const card = await this.context.turnCardManager.createTurnCard(turn.chatId, turn.turnId, sessionId, turn.inboundMessageId);
      if (card) {
        hasProcessCard = true;
        turn = { ...turn, processMessageId: card.messageId };
        queue.replaceActive(turn);
      }

      const reply = cleanAssistantReply(await this.executeTurn(queueKey, turn as BridgeTurn & { sessionId: string }));
      this.context.logger.log("opencode/events", "reply completed", { turnId: turn.turnId, sessionId, len: reply.length });
      this.context.logger.logTranscript("opencode-reply", { sessionId, turnId: turn.turnId }, reply);
      await this.context.maybeUpdateSessionLabel(turn as BridgeTurn & { sessionId: string });
      if (reply) {
        await this.context.moduleManager.runAfterTurnHooks({
          turn: turn as BridgeTurn & { sessionId: string },
          reply,
          window: this.context.getSessionWindow(turn.conversationKey, turn.chatType),
        });
      }
      if (!card && reply) {
        await this.sendTurnFallbackMarkdown(turn.chatId, reply, turn.inboundMessageId);
      }
      await this.context.turnCardManager.flushStreamUpdate(turn.turnId, reply, true);
      await this.context.turnCardManager.updateTurnCard(turn.turnId, { status: "已完成", update: `最终回复已生成（${reply.length} 字）`, target: "step" });
      queue.replaceActive(transitionTurn({ ...turn, sessionId }, "done"));
      logEvent(this.context.logger, "bridge/queue", "turn.completed", {
        turnId: turn.turnId,
        sessionId,
        durationMs: Date.now() - (turn.startedAt ?? Date.now()),
        replyLength: reply.length,
        processMessageId: turn.processMessageId,
      });
    } catch (error) {
      const detail = normalizeTurnFailureDetail(error);
      logEvent(this.context.logger, "bridge/queue", "turn.failed", {
        chatId: turn.chatId,
        conversationKey: turn.conversationKey,
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        errorKind: error instanceof Error ? error.name : "unknown",
        detail,
      }, "error");
      if (!hasProcessCard) {
        logEvent(this.context.logger, "bridge/queue", "turn.fallback_triggered", {
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          chatId: turn.chatId,
          fallbackKind: "failure-markdown",
          reason: detail,
        }, "warn");
        await this.sendTurnFallbackMarkdown(turn.chatId, `处理失败：${escapeMarkdownText(detail)}`, turn.inboundMessageId);
      }
      await this.context.turnCardManager.updateTurnCard(turn.turnId, { status: detail.includes("超时") ? "已超时" : "处理失败", update: detail, target: "step" });
      queue.replaceActive(transitionTurn(turn, detail.includes("超时") ? "timeout" : "aborted"));
    } finally {
      this.context.clearTurnOwnedPendingInteraction(turn.conversationKey, turn.turnId);
      await this.context.cleanupTurnResources(turn.turnId);
      this.context.turnCardManager.cleanup(turn.turnId);
    }
  }

  // #endregion

  // #region Turn 执行准备

  /** 收集执行 turn 前所需的 session 基线和 system prompt。 */
  private async prepareTurnExecution(
    queueKey: string,
    turn: BridgeTurn & { sessionId: string },
  ): Promise<{
    baselineAssistantId: string | null;
    baselineAssistantTimestamp: number | null;
    queue: RuntimeQueue;
    systemPrompt: string | undefined;
  }> {
    const baselineAssistant = await this.getLatestAssistantMessage(turn.sessionId);
    const bridgeSystemPrompt = this.context.config.bridge.injectSystemState
      ? buildBridgeSystemPrompt(turn, this.context.getSessionWindow(turn.conversationKey, turn.chatType))
      : undefined;
    const moduleSystemBlocks = await this.context.moduleManager.collectBeforeTurnBlocks({
      turn,
      window: this.context.getSessionWindow(turn.conversationKey, turn.chatType),
    });

    return {
      baselineAssistantId: baselineAssistant?.info.id ?? null,
      baselineAssistantTimestamp: getMessageTimestamp(baselineAssistant),
      queue: this.context.queues.get(queueKey),
      systemPrompt: composeSystemPrompt(bridgeSystemPrompt, ...moduleSystemBlocks),
    };
  }

  /** 准备完成后真正执行 turn。 */
  private async executeTurn(queueKey: string, turn: BridgeTurn & { sessionId: string }): Promise<string> {
    const {
      baselineAssistantId,
      baselineAssistantTimestamp,
      queue,
      systemPrompt,
    } = await this.prepareTurnExecution(queueKey, turn);

    return this.executePromptWithEventStream(turn, queue, systemPrompt, {
      baselineAssistantId,
      baselineAssistantTimestamp,
    });
  }

  /** 通过事件流驱动一次 prompt 执行，并实时汇总回复文本。 */
  private async executePromptWithEventStream(
    turn: BridgeTurn & { sessionId: string },
    queue: RuntimeQueue,
    systemPrompt: string | undefined,
    baseline: {
      baselineAssistantId: string | null;
      baselineAssistantTimestamp: number | null;
    },
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let assistantMessageId: string | null = null;
      let finalText = "";
      const ignoredTextPartIds = new Set<string>();
      const pendingTextEvents: Array<{ messageId: string; kind: "delta" | "set"; value: string }> = [];

      let unsubscribe = (): void => {};
      const settleWithError = (error: Error): void => { settlement.settleWithError(error); };
      const watchdog = new TurnWatchdog(
        {
          firstEventTimeoutMs: this.context.config.bridge.firstEventTimeoutMs,
          eventGapTimeoutMs: this.context.config.bridge.eventGapTimeoutMs,
          totalTimeoutMs: this.context.config.bridge.totalTimeoutMs,
        },
        {
          onFirstEventTimeout: () => settleWithError(new Error("处理超时，请重试或 /new 开新会话")),
          onEventGapTimeout: () => settleWithError(new Error("处理超时，请重试或 /new 开新会话")),
          onTotalTimeout: () => settleWithError(new Error("处理超时，请重试或 /new 开新会话")),
        },
      );
      const settlement = new TurnExecutionSettlement({
        finalize: () => this.finalizeAssistantReply(turn.sessionId, finalText, {
          baselineAssistantId: baseline.baselineAssistantId,
          baselineAssistantTimestamp: baseline.baselineAssistantTimestamp,
          assistantMessageId,
        }),
        reject,
        resolve,
        unsubscribe: () => { unsubscribe(); },
        watchdog,
      });

      unsubscribe = this.context.eventStream.subscribe(async (event) => {
        if (getEventSessionId(event) !== turn.sessionId) return;
        settlement.markSessionEvent();

        try {
          let nextWatchdogGapMs: number | null = null;
          await this.handleEvent(turn, event, {
            getAssistantMessageId: () => assistantMessageId,
            setAssistantMessageId: async (value) => {
              assistantMessageId = value;
              if (assistantMessageId) {
                await this.flushPendingTextEvents(assistantMessageId, pendingTextEvents, {
                  appendFinalText: async (delta) => {
                    finalText += delta;
                    await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
                  },
                  setFinalText: async (value) => {
                    finalText = value;
                    await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
                  },
                });
              }
            },
            ignoredTextPartIds,
            queuePendingTextEvent: (messageId, eventType, value) => {
              pendingTextEvents.push({ messageId, kind: eventType, value });
            },
            appendFinalText: async (delta) => {
              finalText += delta;
              await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
            },
            setFinalText: async (value) => {
              finalText = value;
              await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
            },
            finish: () => settlement.settleWithText(),
            fail: (error) => settlement.settleWithError(error),
            getFinalText: () => finalText,
            snoozeWatchdog: (timeoutMs) => { nextWatchdogGapMs = timeoutMs; },
          });
          settlement.markWatchdogEvent(nextWatchdogGapMs);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.context.logger.log("opencode/events", "event listener failed", { chatId: turn.chatId, conversationKey: turn.conversationKey, sessionId: turn.sessionId, detail, type: event.type }, "warn");
        }
      });

      watchdog.start();
      void this.context.opencode.promptAsync(turn.sessionId, buildPromptRequest(turn.text, systemPrompt, turn.model))
        .then(() => {
          queue.replaceActive(transitionTurn(turn, "awaiting-sse"));
          void this.context.turnCardManager.updateTurnCard(turn.turnId, { status: "处理中", update: "请求已发送，等待事件流...", target: "step" });
          settlement.startFallback(() => {
            void this.runFirstSseFallback(turn.sessionId, {
              baselineAssistantId: baseline.baselineAssistantId,
              baselineAssistantTimestamp: baseline.baselineAssistantTimestamp,
              assistantMessageId: () => assistantMessageId,
            }, {
              updateText: async (text) => {
                finalText = text;
                await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
              },
              finish: () => settlement.settleWithText(),
              fail: settleWithError,
            });
          });
        })
        .catch((error) => settleWithError(error instanceof Error ? error : new Error(String(error))));
    });
  }

  // #endregion

  // #region 事件处理

  /** 处理单条 OpenCode 事件，并把变化同步到 turn 运行时。 */
  private async handleEvent(
    turn: BridgeTurn & { sessionId: string },
    event: OpenCodeEvent,
    runtime: {
      getAssistantMessageId: () => string | null;
      setAssistantMessageId: (value: string | null) => Promise<void>;
      ignoredTextPartIds: Set<string>;
      queuePendingTextEvent: (messageId: string, eventType: "delta" | "set", value: string) => void;
      appendFinalText: (delta: string) => Promise<void>;
      setFinalText: (value: string) => Promise<void>;
      finish: () => Promise<void>;
      fail: (error: Error) => void;
      getFinalText: () => string;
      snoozeWatchdog: (timeoutMs: number) => void;
    },
  ): Promise<void> {
    if (event.type === "message.updated") {
      const info = readOptionalRecord(event.properties, "info");
      if (info && readOptionalString(info, "role") === "assistant") {
        await runtime.setAssistantMessageId(readOptionalString(info, "id") ?? runtime.getAssistantMessageId());
      }
      return;
    }

    if (event.type === "message.part.delta") {
      const partId = readOptionalString(event.properties, "partID");
      const messageId = readOptionalString(event.properties, "messageID");
      if (runtime.getAssistantMessageId() && messageId && messageId !== runtime.getAssistantMessageId()) return;
      if (partId && runtime.ignoredTextPartIds.has(partId)) return;
      if (readOptionalString(event.properties, "field") === "text") {
        const delta = readOptionalString(event.properties, "delta") ?? "";
        if (!runtime.getAssistantMessageId()) {
          if (messageId) {
            runtime.queuePendingTextEvent(messageId, "delta", delta);
          }
          return;
        }
        await runtime.appendFinalText(delta);
      }
      return;
    }

    if (event.type === "message.part.updated") {
      const part = readOptionalRecord(event.properties, "part");
      if (!part) return;
      const messageId = readOptionalString(part, "messageID");
      if (runtime.getAssistantMessageId() && messageId && messageId !== runtime.getAssistantMessageId()) return;
      const partType = readOptionalString(part, "type");
      const partId = readOptionalString(part, "id");

      if (partType === "text") {
        if (readOptionalBoolean(part, "synthetic") || readOptionalBoolean(part, "ignored")) {
          if (partId) runtime.ignoredTextPartIds.add(partId);
          return;
        }
        const text = readOptionalString(part, "text");
        if (text !== undefined) {
          if (!runtime.getAssistantMessageId()) {
            if (messageId) {
              runtime.queuePendingTextEvent(messageId, "set", text);
            }
            return;
          }
          await runtime.setFinalText(text);
        }
        return;
      }

      if (partType === "reasoning") {
        const text = readOptionalString(part, "text") ?? "";
        if (partId) {
          this.context.logger.log("opencode/events", "reasoning received", { turnId: turn.turnId, sessionId: turn.sessionId, len: text.length });
          this.context.logger.logTranscript("reasoning-raw", { turnId: turn.turnId, sessionId: turn.sessionId, partId, len: text.length }, text);
          const step = summarizeReasoningToProgress(text);
          if (step) {
            await this.context.turnCardManager.updateTurnCard(turn.turnId, { status: "处理中", update: step, sanitize: false, target: "step" });
          }
        }
        return;
      }

      if (partType === "tool") {
        const state = readOptionalRecord(part, "state");
        const status = state ? readOptionalString(state, "status") : undefined;
        const toolName = readOptionalString(part, "tool") ?? "tool";
        const title = state ? readOptionalString(state, "title") : undefined;
        await this.context.turnCardManager.updateTurnCard(turn.turnId, {
          status: "处理中",
          update: formatToolRecord(toolName, status, title),
          target: "tool",
          ...(partId ? { toolKey: partId } : {}),
        });
      }
      return;
    }

    if (event.type === "permission.asked") {
      await this.handlePermissionAskedEvent(turn, event, runtime);
      return;
    }

    if (event.type === "question.asked") {
      const request = toQuestionRequest(event.properties, turn.sessionId);
      if (!request) return;
      this.context.setPendingInteraction(turn.conversationKey, {
        kind: "question",
        turnId: turn.turnId,
        requestId: request.id,
        sessionId: request.sessionId,
        questions: request.questions,
      });
      await this.context.turnCardManager.updateTurnCard(turn.turnId, { status: "等待回答", update: formatQuestionPrompt(request.questions), target: "step" });
      return;
    }

    if (event.type === "session.status") {
      const status = readOptionalRecord(event.properties, "status");
      if (status && readOptionalString(status, "type") === "idle") {
        await runtime.finish();
      }
      return;
    }

    if (event.type === "session.idle") {
      await runtime.finish();
    }
  }

  /** 处理权限请求事件，并向飞书发出审批卡片或文本提示。 */
  private async handlePermissionAskedEvent(
    turn: BridgeTurn & { sessionId: string },
    event: OpenCodeEvent,
    runtime: {
      snoozeWatchdog: (timeoutMs: number) => void;
    },
  ): Promise<void> {
    const permissionId = readOptionalString(event.properties, "id");
    const permissionName = readOptionalString(event.properties, "permission") ?? "unknown";
    if (!permissionId) return;

    const interaction: PendingPermissionInteraction = {
      kind: "permission",
      chatId: turn.chatId,
      conversationKey: turn.conversationKey,
      replyToMessageId: turn.inboundMessageId,
      requesterOpenId: turn.senderOpenId,
      sessionId: turn.sessionId,
      permissionId,
      permissionName,
      permissionMessageId: null,
      permissionVersion: crypto.randomUUID(),
      turnId: turn.turnId,
      expiresAt: Date.now() + PERMISSION_TTL_MS,
    };
    this.context.permissionManager.registerInteraction(interaction);
    this.context.setPendingInteraction(turn.conversationKey, interaction);
    runtime.snoozeWatchdog(PERMISSION_TTL_MS + 5_000);
    await this.context.turnCardManager.updateTurnCard(turn.turnId, {
      status: "等待确认",
      update: "当前权限请求待确认，可点击卡片按钮或发送文本命令处理",
      target: "step",
    });
    const permissionPayload = this.context.config.feishu.cardActions.enabled
      ? buildPermissionRequestCardPayload({
        permissionName,
        buttons: this.context.permissionManager.buildActionButtons(interaction),
        expiresInSeconds: Math.floor(PERMISSION_TTL_MS / 1000),
      })
      : buildPostMarkdownPayload([
        `OpenCode 请求权限：\`${escapeMarkdownText(permissionName)}\``,
        "",
        "回复以下任一命令：",
        "- `/allow once`：仅本次允许",
        "- `/allow always`：始终允许，后续同类权限不再弹出",
        "- `/deny`：拒绝",
      ].join("\n"));
    const sent = await this.context.sendPayload(turn.chatId, permissionPayload, {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: `权限请求：${permissionName}`,
      len: permissionName.length + 16,
    }, { replyToMessageId: turn.inboundMessageId });
    interaction.permissionMessageId = sent.messageId;
    logEvent(this.context.logger, "bridge/permission", "permission.asked", {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      permissionId,
      permissionKind: permissionName,
      chatId: turn.chatId,
      messageId: sent.messageId,
    });
  }

  // #endregion

  // #region 回复收敛与兜底

  /** 在首个 SSE 长时间未到达时，直接从 session 历史里尝试补捞回复。 */
  private async runFirstSseFallback(
    sessionId: string,
    baseline: {
      baselineAssistantId: string | null;
      baselineAssistantTimestamp: number | null;
      assistantMessageId: () => string | null;
    },
    handlers: {
      updateText: (text: string) => Promise<void>;
      finish: () => Promise<void>;
      fail: (error: Error) => void;
    },
  ): Promise<void> {
    try {
      const latestAssistant = await this.resolveAssistantMessage(sessionId, baseline);
      if (!latestAssistant) {
        return;
      }

      const text = extractAssistantText(latestAssistant);
      if (!text) {
        return;
      }

      await handlers.updateText(text);
      if (isCompletedMessage(latestAssistant)) {
        await handlers.finish();
      }
    } catch (error) {
      handlers.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** 对流式文本和最终消息做统一收敛，返回最终 assistant 回复。 */
  private async finalizeAssistantReply(
    sessionId: string,
    currentText: string,
    baseline: {
      baselineAssistantId: string | null;
      baselineAssistantTimestamp: number | null;
      assistantMessageId: string | null;
    },
  ): Promise<string> {
    const normalizedCurrent = cleanAssistantReply(currentText);
    if (normalizedCurrent) {
      return normalizedCurrent;
    }

    const latestAssistant = await this.resolveAssistantMessage(sessionId, {
      baselineAssistantId: baseline.baselineAssistantId,
      baselineAssistantTimestamp: baseline.baselineAssistantTimestamp,
      assistantMessageId: () => baseline.assistantMessageId,
    });
    const text = cleanAssistantReply(extractAssistantText(latestAssistant));
    if (!text) {
      throw new Error("OpenCode 未返回文本回复。");
    }
    return text;
  }

  /** 按 assistantMessageId 或 baseline 条件解析最终 assistant 消息。 */
  private async resolveAssistantMessage(
    sessionId: string,
    baseline: {
      baselineAssistantId: string | null;
      baselineAssistantTimestamp: number | null;
      assistantMessageId: () => string | null;
    },
  ): Promise<OpenCodeMessage | null> {
    const targetAssistantId = baseline.assistantMessageId();
    if (targetAssistantId) {
      const exactMessage = await this.getAssistantMessageById(sessionId, targetAssistantId);
      if (exactMessage) {
        return exactMessage;
      }
    }

    return this.getLatestAssistantMessage(sessionId, {
      afterAssistantId: baseline.baselineAssistantId,
      afterTimestamp: baseline.baselineAssistantTimestamp,
    });
  }

  /** 返回满足 baseline 条件的最新 assistant 消息。 */
  private async getLatestAssistantMessage(
    sessionId: string,
    options?: {
      afterAssistantId?: string | null;
      afterTimestamp?: number | null;
    },
  ): Promise<OpenCodeMessage | null> {
    const messages = await this.context.opencode.getSessionMessages(sessionId, 200);
    return [...messages].reverse().find((message) => isAssistantMessageAfterBaseline(message, options)) ?? null;
  }

  /** 按消息 id 精确查找 assistant 消息。 */
  private async getAssistantMessageById(sessionId: string, messageId: string): Promise<OpenCodeMessage | null> {
    const messages = await this.context.opencode.getSessionMessages(sessionId, 200);
    return messages.find((message) => message.info.id === messageId && message.info.role === "assistant") ?? null;
  }

  /** 在没有过程卡可用时，直接发出兜底 Markdown 回复。 */
  private async sendTurnFallbackMarkdown(chatId: string, markdown: string, replyToMessageId: string): Promise<void> {
    await this.context.sendPayload(chatId, buildPostMarkdownPayload(markdown), {
      event: "fallback final message sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(markdown),
      len: markdown.length,
    }, { replyToMessageId });
  }

  // #endregion
}

/** 将底层异常转换为更适合用户侧展示的错误文案。 */
function normalizeTurnFailureDetail(error: unknown): string {
  const detail = cleanAssistantReply(error instanceof Error ? error.message : String(error));
  const normalized = detail.toLowerCase();

  if (normalized.includes("token refresh failed") && normalized.includes("401")) {
    return "模型提供方登录已失效，请重新执行 `opencode providers login`。";
  }

  if (
    normalized.includes("no credentials")
    || normalized.includes("provider not configured")
    || normalized.includes("no providers")
  ) {
    return "当前未配置可用模型提供方，请先执行 `opencode providers login`。";
  }

  return detail;
}
