import crypto from "node:crypto";

import type { PendingPermissionInteraction } from "../bridge/state.js";
import { transitionTurn } from "../bridge/state-machine.js";
import { TurnWatchdog } from "../bridge/watchdog.js";
import type { BridgeTurn } from "../bridge/turn.js";
import { buildPermissionRequestCardPayload, buildPostMarkdownPayload, type FeishuPostPayload } from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
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
    promptAsync(sessionId: string, input: { system?: string; parts: Array<{ type: "text"; text: string }> }): Promise<unknown>;
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
  memory: {
    buildRecallBlock(openId: string, plainText: string): Promise<string>;
    enqueueLearn(openId: string, userText: string, assistantText: string): void;
  } | null;
  getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord;
  ensureSession(source: Pick<BridgeTurn, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<string>;
  maybeUpdateSessionLabel(turn: BridgeTurn & { sessionId: string }): Promise<void>;
  clearPendingInteraction(conversationKey: string, keepNonExpiring: boolean): void;
  clearTurnOwnedPendingInteraction(conversationKey: string, turnId: string): void;
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

  async processChat(conversationKey: string): Promise<void> {
    const queue = this.context.queues.get(conversationKey);
    while (queue.current()) {
      await this.runTurn(conversationKey);
      queue.finishActive();
    }
  }

  async runTurn(conversationKey: string): Promise<void> {
    const queue = this.context.queues.get(conversationKey);
    const active = queue.peek();
    if (!active) return;

    let turn = transitionTurn(active, "running");
    queue.replaceActive(turn);
    let hasProcessCard = false;

    try {
      const sessionId = turn.sessionId ?? await this.context.ensureSession(turn);
      turn = { ...turn, sessionId };
      queue.replaceActive(turn);
      this.context.logger.log("bridge/queue", "turn started", { turnId: turn.turnId, sessionId, chatId: turn.chatId, conversationKey });

      const card = await this.context.turnCardManager.createTurnCard(turn.chatId, turn.turnId, sessionId, turn.inboundMessageId);
      if (card) {
        hasProcessCard = true;
        turn = { ...turn, processMessageId: card.messageId };
        queue.replaceActive(turn);
      }

      const reply = cleanAssistantReply(await this.executeTurn(conversationKey, turn as BridgeTurn & { sessionId: string }));
      this.context.logger.log("opencode/events", "reply completed", { turnId: turn.turnId, sessionId, len: reply.length });
      this.context.logger.logTranscript("opencode-reply", { sessionId, turnId: turn.turnId }, reply);
      await this.context.maybeUpdateSessionLabel(turn as BridgeTurn & { sessionId: string });
      if (reply) {
        this.context.memory?.enqueueLearn(turn.senderOpenId, turn.plainText, reply);
      }
      if (!card && reply) {
        await this.sendTurnFallbackMarkdown(turn.chatId, reply, turn.inboundMessageId);
      }
      await this.context.turnCardManager.flushStreamUpdate(turn.turnId, reply, true);
      await this.context.turnCardManager.updateTurnCard(turn.turnId, { status: "已完成", update: `最终回复已生成（${reply.length} 字）`, target: "step" });
      queue.replaceActive(transitionTurn({ ...turn, sessionId }, "done"));
      this.context.logger.log("bridge/queue", "turn completed", { turnId: turn.turnId, duration: Date.now() - (turn.startedAt ?? Date.now()) });
    } catch (error) {
      const detail = normalizeTurnFailureDetail(error);
      this.context.logger.log("bridge/queue", "run turn failed", { chatId: turn.chatId, conversationKey, turnId: turn.turnId, detail }, "error");
      if (!hasProcessCard) {
        await this.sendTurnFallbackMarkdown(turn.chatId, `处理失败：${escapeMarkdownText(detail)}`, turn.inboundMessageId);
      }
      await this.context.turnCardManager.updateTurnCard(turn.turnId, { status: detail.includes("超时") ? "已超时" : "处理失败", update: detail, target: "step" });
      queue.replaceActive(transitionTurn(turn, detail.includes("超时") ? "timeout" : "aborted"));
    } finally {
      this.context.clearTurnOwnedPendingInteraction(conversationKey, turn.turnId);
      this.context.turnCardManager.cleanup(turn.turnId);
    }
  }

  private async executeTurn(conversationKey: string, turn: BridgeTurn & { sessionId: string }): Promise<string> {
    const baselineAssistant = await this.getLatestAssistantMessage(turn.sessionId);
    const baselineAssistantId = baselineAssistant?.info.id ?? null;
    const baselineAssistantTimestamp = getMessageTimestamp(baselineAssistant);
    const queue = this.context.queues.get(conversationKey);
    const bridgeSystemPrompt = this.context.config.bridge.injectSystemState
      ? buildBridgeSystemPrompt(turn, this.context.getSessionWindow(turn.conversationKey, turn.chatType))
      : undefined;
    const memoryRecall = this.context.memory
      ? await this.context.memory.buildRecallBlock(turn.senderOpenId, turn.plainText)
      : "";
    const systemPrompt = composeSystemPrompt(bridgeSystemPrompt, memoryRecall);

    return new Promise<string>((resolve, reject) => {
      let assistantMessageId: string | null = null;
      let finalText = "";
      let settled = false;
      let fallbackTimer: NodeJS.Timeout | null = null;
      let seenSessionEvent = false;
      const ignoredTextPartIds = new Set<string>();

      const settleWithError = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        unsubscribe();
        watchdog.clear();
        reject(error);
      };

      const settleWithText = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        unsubscribe();
        watchdog.clear();
        try {
          const text = await this.finalizeAssistantReply(turn.sessionId, finalText, {
            baselineAssistantId,
            baselineAssistantTimestamp,
            assistantMessageId,
          });
          resolve(text);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const unsubscribe = this.context.eventStream.subscribe(async (event) => {
        if (getEventSessionId(event) !== turn.sessionId) return;
        seenSessionEvent = true;
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }

        try {
          let nextWatchdogGapMs: number | null = null;
          await this.handleEvent(turn, event, {
            getAssistantMessageId: () => assistantMessageId,
            setAssistantMessageId: (value) => { assistantMessageId = value; },
            ignoredTextPartIds,
            appendFinalText: async (delta) => {
              finalText += delta;
              await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
            },
            setFinalText: async (value) => {
              finalText = value;
              await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
            },
            finish: settleWithText,
            fail: settleWithError,
            getFinalText: () => finalText,
            snoozeWatchdog: (timeoutMs) => { nextWatchdogGapMs = timeoutMs; },
          });
          if (nextWatchdogGapMs !== null) {
            watchdog.snoozeEventGap(nextWatchdogGapMs);
          } else {
            watchdog.markEvent();
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.context.logger.log("opencode/events", "event listener failed", { chatId: turn.chatId, conversationKey, sessionId: turn.sessionId, detail, type: event.type }, "warn");
        }
      });

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

      watchdog.start();
      void this.context.opencode.promptAsync(turn.sessionId, buildPromptRequest(turn.text, systemPrompt))
        .then(() => {
          queue.replaceActive(transitionTurn(turn, "awaiting-sse"));
          void this.context.turnCardManager.updateTurnCard(turn.turnId, { status: "处理中", update: "请求已发送，等待事件流...", target: "step" });
          fallbackTimer = setTimeout(() => {
            if (!seenSessionEvent) {
              void this.runFirstSseFallback(turn.sessionId, {
                baselineAssistantId,
                baselineAssistantTimestamp,
                assistantMessageId: () => assistantMessageId,
              }, {
                updateText: async (text) => {
                  finalText = text;
                  await this.context.turnCardManager.scheduleStreamUpdate(turn.turnId, finalText);
                },
                finish: settleWithText,
                fail: settleWithError,
              });
            }
          }, FIRST_SSE_FALLBACK_MS);
        })
        .catch((error) => settleWithError(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async handleEvent(
    turn: BridgeTurn & { sessionId: string },
    event: OpenCodeEvent,
    runtime: {
      getAssistantMessageId: () => string | null;
      setAssistantMessageId: (value: string | null) => void;
      ignoredTextPartIds: Set<string>;
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
        runtime.setAssistantMessageId(readOptionalString(info, "id") ?? runtime.getAssistantMessageId());
      }
      return;
    }

    if (event.type === "message.part.delta") {
      const partId = readOptionalString(event.properties, "partID");
      const messageId = readOptionalString(event.properties, "messageID");
      if (runtime.getAssistantMessageId() && messageId && messageId !== runtime.getAssistantMessageId()) return;
      if (partId && runtime.ignoredTextPartIds.has(partId)) return;
      if (readOptionalString(event.properties, "field") === "text") {
        await runtime.appendFinalText(readOptionalString(event.properties, "delta") ?? "");
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
        : buildPostMarkdownPayload(`OpenCode 请求权限 \`${escapeMarkdownText(permissionName)}\`，请回复 \`/allow once\`、\`/allow always\` 或 \`/deny\`。`);
      const sent = await this.context.sendPayload(turn.chatId, permissionPayload, {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: `权限请求：${permissionName}`,
        len: permissionName.length + 16,
      }, { replyToMessageId: turn.inboundMessageId });
      interaction.permissionMessageId = sent.messageId;
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

  private async getAssistantMessageById(sessionId: string, messageId: string): Promise<OpenCodeMessage | null> {
    const messages = await this.context.opencode.getSessionMessages(sessionId, 200);
    return messages.find((message) => message.info.id === messageId && message.info.role === "assistant") ?? null;
  }

  private async sendTurnFallbackMarkdown(chatId: string, markdown: string, replyToMessageId: string): Promise<void> {
    await this.context.sendPayload(chatId, buildPostMarkdownPayload(markdown), {
      event: "fallback final message sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(markdown),
      len: markdown.length,
    }, { replyToMessageId });
  }
}

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
