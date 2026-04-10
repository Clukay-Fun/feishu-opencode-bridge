import crypto from "node:crypto";

import { QueueRegistry } from "../bridge/queue.js";
import { type PendingInteraction, type PendingPermissionInteraction, type PendingQuestionInteraction } from "../bridge/state.js";
import { routeIncomingText, type RoutedText } from "../bridge/router.js";
import { transitionTurn } from "../bridge/state-machine.js";
import { TurnWatchdog } from "../bridge/watchdog.js";
import type { BridgeTurn } from "../bridge/turn.js";
import {
  buildModelListCardPayload,
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  buildPermissionRequestCardPayload,
  buildLeaveCommandCardPayload,
  buildQueueNoticePayload,
  buildSessionListCardPayload,
  buildSessionTransitionCardPayload,
  buildStatusCommandCardPayload,
  buildTurnStatusCardPayload,
  buildWhoCommandCardPayload,
  type FeishuPostPayload,
  type ModelListCardView,
  type OutputView,
  toInteractiveCardContent,
  type ToolUpdateView,
  type TurnStatusCardView,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import { MemoryService } from "../memory/index.js";
import {
  OpenCodeClient,
  type OpenCodeMessage,
  type OpenCodeProvidersResponse,
  type PermissionPolicy,
  type OpenCodeSession,
  type OpenCodeSessionStatus,
} from "../opencode/client.js";
import { getEventSessionId, OpenCodeEventStream, type OpenCodeEvent } from "../opencode/events.js";
import { MappingStore, type MappingRecord, type SessionBindingRecord, type SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import type { AppConfig } from "../config/schema.js";
import { cleanAssistantReply } from "./sanitize.js";
import {
  addSession,
  createSessionEntry,
  getActiveSession,
  getVisibleSessions,
  normalizeSessionWindowRecord,
  removeSession,
  resolveSessionMode,
  setActiveSession,
  updateSessionLabel,
} from "./session-windows.js";

export type IncomingChatMessage = {
  chatId: string;
  chatType: string;
  senderOpenId: string;
  messageId: string;
  messageType: string;
  rawContent: string;
  plainText: string;
  rootId?: string | undefined;
  parentId?: string | undefined;
  threadKey: string;
  conversationKey: string;
};

type OutboundPort = {
  sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
};

type TurnCardState = {
  messageId: string;
  status: string;
  sessionId: string;
  startedAt: number;
  progressUpdates: string[];
  toolUpdates: Array<{ key: string; view: ToolUpdateView }>;
  output: OutputView;
};

type StreamFlushState = {
  flushedLength: number;
  lastFlushedAt: number;
  timer: NodeJS.Timeout | null;
};

export type PermissionCardActionValue = {
  kind: "permission";
  conversationKey: string;
  turnId: string;
  sessionId: string;
  permissionId: string;
  policy: "once" | "always" | "deny";
  nonce: string;
};

const initialCardSummary = "已创建会话，等待 OpenCode 事件...";
const FIRST_SSE_FALLBACK_MS = 5_000;
const STREAM_FLUSH_MIN_CHARS = 120;
const STREAM_FLUSH_INTERVAL_MS = 750;
const PERMISSION_TTL_MS = 120_000;
const SESSION_SELECTION_TTL_MS = 30_000;
const SESSION_DELETE_CONFIRM_TTL_MS = 30_000;
const SESSIONS_ALL_PAGE_SIZE = 20;

type PermissionResolution = "once" | "always" | "deny" | "timeout";

export class BridgeApp {
  private readonly queues: QueueRegistry;
  private readonly mappings: MappingStore;
  private readonly opencode: OpenCodeClient;
  private readonly eventStream: OpenCodeEventStream;
  private sessionMap: MappingRecord = {};
  private readonly runningChats = new Map<string, Promise<void>>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly pendingInteractionTimers = new Map<string, NodeJS.Timeout>();
  private readonly turnCards = new Map<string, TurnCardState>();
  private readonly streamFlushStates = new Map<string, StreamFlushState>();
  private readonly sessionStatuses = new Map<string, OpenCodeSessionStatus>();
  private readonly permissionInteractions = new Map<string, PendingPermissionInteraction>();
  private readonly permissionProcessing = new Set<string>();
  private readonly memory: MemoryService | null;
  private globalEventUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly outbound: OutboundPort,
    private readonly logger: Logger,
    private readonly whitelist: Pick<WhitelistStore, "count" | "isBound" | "unbind">,
  ) {
    this.queues = new QueueRegistry(config.bridge.queueLimit, logger);
    this.mappings = new MappingStore(config.storage.dataDir, config.storage.mappingsFile, 200, logger);
    this.opencode = new OpenCodeClient(config.opencode.baseUrl);
    this.eventStream = new OpenCodeEventStream(config.opencode.baseUrl, logger);
    this.memory = config.memory.enabled ? new MemoryService(config.memory, this.opencode, logger) : null;
  }

  async start(): Promise<void> {
    this.sessionMap = await this.mappings.load();
    const health = await this.opencode.health();
    const project = await this.opencode.getCurrentProject();
    if (project.worktree !== this.config.opencode.directory) {
      throw new Error(`opencode serve 当前在 ${project.worktree}，bridge 配置的是 ${this.config.opencode.directory}，请在正确目录重启 opencode serve`);
    }
    await this.syncStoredSessionLabels();
    await this.memory?.start();

    await this.eventStream.start();
    this.globalEventUnsubscribe = this.eventStream.subscribe(async (event) => {
      await this.handleGlobalEvent(event);
    });

    this.logger.log("bridge/app", "bridge started", {
      queueLimit: this.config.bridge.queueLimit,
      opencodeBaseUrl: this.config.opencode.baseUrl.toString(),
      opencodeVersion: health.version,
      project: project.worktree,
    });
  }

  async stop(): Promise<void> {
    this.globalEventUnsubscribe?.();
    this.globalEventUnsubscribe = null;
    for (const timeout of this.pendingInteractionTimers.values()) {
      clearTimeout(timeout);
    }
    for (const state of this.streamFlushStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.pendingInteractionTimers.clear();
    this.streamFlushStates.clear();
    await this.memory?.stop();
    await this.eventStream.stop();
  }

  async handlePermissionCardAction(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isPermissionCardActionValue(value)) {
      return this.toCardContent(buildNoticeCardPayload({
        title: "信息提示",
        template: "blue",
        iconToken: "info_outlined",
        message: "当前卡片动作无法识别。",
        messageIconToken: "info_outlined",
        messageIconColor: "blue",
      }));
    }

    const interaction = this.permissionInteractions.get(value.nonce);
    if (!interaction || !this.matchesPermissionAction(interaction, value, openMessageId)) {
      return this.toCardContent(buildNoticeCardPayload({
        title: "提醒",
        template: "yellow",
        iconToken: "maybe_outlined",
        message: "权限请求已失效，请重新触发操作。",
        messageIconToken: "maybe_outlined",
        messageIconColor: "yellow",
      }));
    }

    if (interaction.requesterOpenId !== actorOpenId) {
      return this.toCardContent(buildNoticeCardPayload({
        title: "提醒",
        template: "yellow",
        iconToken: "maybe_outlined",
        message: "当前按钮仅限本轮发起者处理。",
        messageIconToken: "maybe_outlined",
        messageIconColor: "yellow",
      }));
    }

    if (interaction.resolvedAt && interaction.resolution) {
      return this.toCardContent(this.buildPermissionResolutionPayload(interaction.resolution));
    }

    if (interaction.expiresAt <= Date.now()) {
      await this.expirePermissionInteraction(interaction, false);
      return this.toCardContent(this.buildPermissionResolutionPayload("timeout"));
    }

    if (this.permissionProcessing.has(interaction.permissionVersion)) {
      return this.toCardContent(buildNoticeCardPayload({
        title: "信息提示",
        template: "blue",
        iconToken: "info_outlined",
        message: "当前权限请求正在处理。",
        messageIconToken: "info_outlined",
        messageIconColor: "blue",
      }));
    }

    try {
      await this.resolvePermissionInteraction(interaction, value.policy);
      return this.toCardContent(this.buildPermissionResolutionPayload(value.policy));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("bridge/permission", "card action failed", {
        permissionId: interaction.permissionId,
        nonce: interaction.permissionVersion,
        detail,
      }, "warn");
      return this.toCardContent(buildNoticeCardPayload({
        title: "错误",
        template: "red",
        iconToken: "more-close_outlined",
        message: "权限请求处理失败，请稍后重试。",
        messageIconToken: "more-close_outlined",
        messageIconColor: "red",
      }));
    }
  }

  async handleIncomingMessage(message: IncomingChatMessage): Promise<void> {
    if (this.config.feishu.allowedOpenIds.size > 0 && !this.config.feishu.allowedOpenIds.has(message.senderOpenId)) {
      await this.sendPayload(message.chatId, buildPostMarkdownPayload("当前账号未加入白名单。"), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "当前账号未加入白名单。",
        len: 11,
      }, { replyToMessageId: message.messageId });
      return;
    }

    this.logger.logTranscript("inbound", {
      chatId: message.chatId,
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      threadKey: message.threadKey,
      senderId: message.senderOpenId,
      messageId: message.messageId,
      messageType: message.messageType,
    }, message.plainText);

    const routed = routeIncomingText(message.plainText);
    if (routed.kind === "command") {
      await this.handleCommand(message, routed);
      return;
    }

    const pending = this.pendingInteractions.get(message.conversationKey);
    if (pending) {
      const consumed = await this.handlePendingInteraction(message, pending);
      if (consumed) return;
    }

    if (!await this.ensureServerAvailableForMessage(message)) {
      return;
    }

    const queue = this.queues.get(message.conversationKey);
    const turn: BridgeTurn = {
      turnId: crypto.randomUUID(),
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      threadKey: message.threadKey,
      chatType: message.chatType,
      senderOpenId: message.senderOpenId,
      inboundMessageId: message.messageId,
      plainText: message.plainText,
      text: toOpencodePromptText(message),
    };

    const result = queue.enqueue(turn);
    if (!result.accepted) {
      await this.sendPayload(message.chatId, buildQueueNoticePayload(result.notice ?? { message: "当前不可用。" }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: result.notice?.message ?? "当前不可用。",
        len: (result.notice?.message ?? "当前不可用。").length,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (result.notice) {
      await this.sendPayload(message.chatId, buildQueueNoticePayload(result.notice), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.notice.message),
        len: result.notice.message.length,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (!this.runningChats.has(message.conversationKey)) {
      const runner = this.processChat(message.conversationKey).finally(() => {
        this.runningChats.delete(message.conversationKey);
      });
      this.runningChats.set(message.conversationKey, runner);
      await runner;
    }
  }

  private async processChat(conversationKey: string): Promise<void> {
    const queue = this.queues.get(conversationKey);
    while (queue.current()) {
      await this.runTurn(conversationKey);
      queue.finishActive();
    }
  }

  private async runTurn(conversationKey: string): Promise<void> {
    const queue = this.queues.get(conversationKey);
    const active = queue.peek();
    if (!active) return;

    let turn = transitionTurn(active, "running");
    queue.replaceActive(turn);

    try {
      const sessionId = turn.sessionId ?? await this.ensureSession(turn);
      turn = { ...turn, sessionId };
      queue.replaceActive(turn);
      this.logger.log("bridge/queue", "turn started", { turnId: turn.turnId, sessionId, chatId: turn.chatId, conversationKey });

      const card = await this.createTurnCard(turn.chatId, turn.turnId, sessionId, turn.inboundMessageId);
      if (card) {
        queue.replaceActive({ ...turn, processMessageId: card.messageId });
      }

      const reply = cleanAssistantReply(await this.executeTurn(conversationKey, turn as BridgeTurn & { sessionId: string }));
      this.logger.log("opencode/events", "reply completed", { turnId: turn.turnId, sessionId, len: reply.length });
      this.logger.logTranscript("opencode-reply", { sessionId, turnId: turn.turnId }, reply);
      await this.maybeUpdateSessionLabel(turn as BridgeTurn & { sessionId: string });
      if (reply) {
        this.memory?.enqueueLearn(turn.senderOpenId, turn.plainText, reply);
      }
      await this.flushStreamUpdate(turn.turnId, reply, true);
      await this.updateTurnCard(turn.turnId, { status: "已完成", update: `最终回复已生成（${reply.length} 字）`, target: "step" });
      queue.replaceActive(transitionTurn({ ...turn, sessionId }, "done"));
      this.logger.log("bridge/queue", "turn completed", { turnId: turn.turnId, duration: Date.now() - (turn.startedAt ?? Date.now()) });
    } catch (error) {
      const detail = cleanAssistantReply(error instanceof Error ? error.message : String(error));
      this.logger.log("bridge/queue", "run turn failed", { chatId: turn.chatId, conversationKey, turnId: turn.turnId, detail }, "error");
      await this.updateTurnCard(turn.turnId, { status: detail.includes("超时") ? "已超时" : "处理失败", update: detail, target: "step" });
      queue.replaceActive(transitionTurn(turn, detail.includes("超时") ? "timeout" : "aborted"));
    } finally {
      this.turnCards.delete(turn.turnId);
      this.clearPendingInteraction(conversationKey, false);
      this.clearStreamFlushState(turn.turnId);
    }
  }

  private async executeTurn(conversationKey: string, turn: BridgeTurn & { sessionId: string }): Promise<string> {
    const baselineAssistant = await this.getLatestAssistantMessage(turn.sessionId);
    const baselineAssistantId = baselineAssistant?.info.id ?? null;
    const baselineAssistantTimestamp = getMessageTimestamp(baselineAssistant);
    const queue = this.queues.get(conversationKey);
    const bridgeSystemPrompt = this.config.bridge.injectSystemState
      ? buildBridgeSystemPrompt(turn, this.getSessionWindow(turn.conversationKey, turn.chatType))
      : undefined;
    const memoryRecall = this.memory
      ? await this.memory.buildRecallBlock(turn.senderOpenId, turn.plainText)
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

      const unsubscribe = this.eventStream.subscribe(async (event) => {
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
              await this.scheduleStreamUpdate(turn.turnId, finalText);
            },
            setFinalText: async (value) => {
              finalText = value;
              await this.scheduleStreamUpdate(turn.turnId, finalText);
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
          this.logger.log("opencode/events", "event listener failed", { chatId: turn.chatId, conversationKey, sessionId: turn.sessionId, detail, type: event.type }, "warn");
        }
      });

      const watchdog = new TurnWatchdog(
        {
          firstEventTimeoutMs: this.config.bridge.firstEventTimeoutMs,
          eventGapTimeoutMs: this.config.bridge.eventGapTimeoutMs,
          totalTimeoutMs: this.config.bridge.totalTimeoutMs,
        },
        {
          onFirstEventTimeout: () => settleWithError(new Error("处理超时，请重试或 /new 开新会话")),
          onEventGapTimeout: () => settleWithError(new Error("处理超时，请重试或 /new 开新会话")),
          onTotalTimeout: () => settleWithError(new Error("处理超时，请重试或 /new 开新会话")),
        },
      );

      watchdog.start();
      void this.opencode.promptAsync(turn.sessionId, buildPromptRequest(turn.text, systemPrompt))
        .then(() => {
          queue.replaceActive(transitionTurn(turn, "awaiting-sse"));
          void this.updateTurnCard(turn.turnId, { status: "处理中", update: "请求已发送，等待事件流...", target: "step" });
          fallbackTimer = setTimeout(() => {
            if (!seenSessionEvent) {
              void this.runFirstSseFallback(turn.sessionId, {
                baselineAssistantId,
                baselineAssistantTimestamp,
                assistantMessageId: () => assistantMessageId,
              }, {
                updateText: async (text) => {
                  finalText = text;
                  await this.scheduleStreamUpdate(turn.turnId, finalText);
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
    context: {
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
        context.setAssistantMessageId(readOptionalString(info, "id") ?? context.getAssistantMessageId());
      }
      return;
    }

    if (event.type === "message.part.delta") {
      const partId = readOptionalString(event.properties, "partID");
      const messageId = readOptionalString(event.properties, "messageID");
      if (context.getAssistantMessageId() && messageId && messageId !== context.getAssistantMessageId()) return;
      if (partId && context.ignoredTextPartIds.has(partId)) return;
      if (readOptionalString(event.properties, "field") === "text") {
        await context.appendFinalText(readOptionalString(event.properties, "delta") ?? "");
      }
      return;
    }

    if (event.type === "message.part.updated") {
      const part = readOptionalRecord(event.properties, "part");
      if (!part) return;
      const messageId = readOptionalString(part, "messageID");
      if (context.getAssistantMessageId() && messageId && messageId !== context.getAssistantMessageId()) return;
      const partType = readOptionalString(part, "type");
      const partId = readOptionalString(part, "id");

      if (partType === "text") {
        if (readOptionalBoolean(part, "synthetic") || readOptionalBoolean(part, "ignored")) {
          if (partId) context.ignoredTextPartIds.add(partId);
          return;
        }
        const text = readOptionalString(part, "text");
        if (text !== undefined) {
          await context.setFinalText(text);
        }
        return;
      }

      if (partType === "reasoning") {
        const text = readOptionalString(part, "text") ?? "";
        if (partId) {
          this.logger.log("opencode/events", "reasoning received", { turnId: turn.turnId, sessionId: turn.sessionId, len: text.length });
          this.logger.logTranscript("reasoning-raw", { turnId: turn.turnId, sessionId: turn.sessionId, partId, len: text.length }, text);
          const step = summarizeReasoningToProgress(text);
          if (step) {
            await this.updateTurnCard(turn.turnId, { status: "处理中", update: step, sanitize: false, target: "step" });
          }
        }
        return;
      }

      if (partType === "tool") {
        const state = readOptionalRecord(part, "state");
        const status = state ? readOptionalString(state, "status") : undefined;
        const toolName = readOptionalString(part, "tool") ?? "tool";
        const title = state ? readOptionalString(state, "title") : undefined;
        await this.updateTurnCard(turn.turnId, {
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
      this.permissionInteractions.set(interaction.permissionVersion, interaction);
      this.setPendingInteraction(turn.conversationKey, interaction);
      context.snoozeWatchdog(PERMISSION_TTL_MS + 5_000);
      await this.updateTurnCard(turn.turnId, {
        status: "等待确认",
        update: "当前权限请求待确认，可点击卡片按钮或发送文本命令处理",
        target: "step",
      });
      const permissionPayload = this.config.feishu.cardActions.enabled
        ? buildPermissionRequestCardPayload({
          permissionName,
          buttons: this.buildPermissionActionButtons(interaction),
          expiresInSeconds: Math.floor(PERMISSION_TTL_MS / 1000),
        })
        : buildPostMarkdownPayload(`OpenCode 请求权限 \`${escapeMarkdownText(permissionName)}\`，请回复 \`/allow once\`、\`/allow always\` 或 \`/deny\`。`);
      const sent = await this.sendPayload(turn.chatId, permissionPayload, {
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
      this.setPendingInteraction(turn.conversationKey, {
        kind: "question",
        requestId: request.id,
        sessionId: request.sessionId,
        questions: request.questions,
      });
      await this.updateTurnCard(turn.turnId, { status: "等待回答", update: formatQuestionPrompt(request.questions), target: "step" });
      return;
    }

    if (event.type === "session.status") {
      const status = readOptionalRecord(event.properties, "status");
      if (status && readOptionalString(status, "type") === "idle") {
        await context.finish();
      }
      return;
    }

    if (event.type === "session.idle") {
      await context.finish();
    }
  }

  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
    routed: Extract<RoutedText, { kind: "command" }>,
  ): Promise<void> {
    const { command } = routed;
    if (command.kind === "new") {
      const previousSession = getActiveSession(this.getSessionWindow(message.conversationKey, message.chatType));
      const entry = await this.createAndBindSession(message);
      await this.sendPayload(message.chatId, buildSessionTransitionCardPayload({
        title: "已创建新会话",
        iconToken: "add-bold_outlined",
        previousLabel: previousSession?.label ?? null,
        currentLabel: entry.label,
        footer: "刚刚创建 · 发送第一条消息开始",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已创建新会话",
        len: 6,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "status") {
      try {
        const statuses = await this.opencode.getSessionStatuses();
        for (const [sessionId, status] of Object.entries(statuses)) {
          this.sessionStatuses.set(sessionId, status);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.log("bridge/status", "refresh status failed", { detail }, "warn");
      }

      const queue = this.queues.get(message.conversationKey);
      const active = queue.peek();
      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const status = currentSession ? this.sessionStatuses.get(currentSession.sessionId)?.type ?? "unknown" : "unbound";
      await this.sendPayload(message.chatId, buildStatusCommandCardPayload({
        currentSession: currentSession ? { sessionId: currentSession.sessionId, label: currentSession.label } : null,
        connectionState: this.eventStream.getConnectionState(),
        sessionMode: window.mode,
        sessionState: status,
        queueState: active ? "处理中" : "空闲",
        pendingCount: queue.pendingCount(),
        windowCount: window.sessions.length,
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "会话状态",
        len: 4,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "abort") {
      const queue = this.queues.get(message.conversationKey);
      const activeTurn = queue.peek();
      if (!activeTurn) {
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "无任务可中止",
          template: "grey",
          iconToken: "info-hollow_filled",
          message: "当前没有正在执行的任务。",
          messageIconToken: "info-hollow_filled",
          messageIconColor: "grey",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前没有正在执行的任务。",
          len: 12,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const sessionId = activeTurn.sessionId ?? currentSession?.sessionId;
      if (sessionId) {
        await this.opencode.abort(sessionId);
      }
      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "任务已中止",
        template: "orange",
        iconToken: "stop-record_filled",
        message: "当前任务已中止，可发送新消息继续对话。",
        messageIconToken: "stop-record_filled",
        messageIconColor: "orange",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "当前任务已中止，可发送新消息继续对话。",
        len: 17,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "models") {
      const providers = await this.opencode.listProviders();
      const modelCard = buildModelCardView(providers, command.provider);
      if (!modelCard) {
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "提醒",
          template: "yellow",
          iconToken: "maybe_outlined",
          message: "当前没有匹配的模型提供方，请重新发送 `/model` 查看列表。",
          messageIconToken: "maybe_outlined",
          messageIconColor: "yellow",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前没有匹配的模型提供方，请重新发送 `/model` 查看列表。",
          len: 27,
        }, { replyToMessageId: message.messageId });
        return;
      }

      await this.sendPayload(message.chatId, buildModelListCardPayload(modelCard), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "可用模型",
        len: 4,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "sessions") {
      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      if (window.mode === "single") {
        await this.sendPayload(message.chatId, buildSessionListCardPayload({
          items: currentSession ? [{
            index: 1,
            title: currentSession.label,
            current: true,
            meta: "当前",
          }] : [],
          footer: currentSession
            ? "当前窗口为单会话模式，不支持切换"
            : "发送 `/new` 创建第一个会话",
          emptyText: "暂无会话",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "会话列表",
          len: 4,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const visibleSessions = getVisibleSessions(window).slice(0, this.config.bridge.sessionListLimit);
      if (visibleSessions.length === 0) {
        await this.sendPayload(message.chatId, buildSessionListCardPayload({
          items: [],
          footer: "发送 `/new` 创建第一个会话",
          emptyText: "暂无会话",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "会话列表",
          len: 4,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const options = visibleSessions.map((session, index) => ({
        index: index + 1,
        sessionId: session.sessionId,
        title: session.label,
        current: session.sessionId === currentSession?.sessionId,
      }));
      this.setPendingInteraction(message.conversationKey, {
        kind: "session-select",
        options,
        expiresAt: Date.now() + SESSION_SELECTION_TTL_MS,
      });
      await this.sendPayload(message.chatId, buildSessionListCardPayload({
        items: options.map((option) => ({
          index: option.index,
          title: option.title,
          current: option.current,
          meta: option.current ? "当前" : formatSessionTimestamp(findSessionMeta(window, option.sessionId)?.lastUsedAt),
        })),
        footer: "发送 `/switch <编号>` 切换 · 30s 内有效",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "会话列表",
        len: 4,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "sessions-all") {
      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const openCodeSessions = await this.listOpenCodeSessionsById();
      const visibleIds = new Set(window.sessions.map((session) => session.sessionId));
      const sessions = [...openCodeSessions.values()]
        .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0));

      if (sessions.length === 0) {
        await this.sendPayload(message.chatId, buildSessionListCardPayload({
          items: [],
          footer: "发送 `/new` 创建第一个会话",
          emptyText: "暂无会话",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "全部会话",
          len: 4,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const options = sessions.map((session, index) => ({
        index: index + 1,
        sessionId: session.id,
        title: resolveDisplayLabel(session, session.title ?? session.slug ?? session.id, session.id),
        current: session.id === currentSession?.sessionId,
        inWindow: visibleIds.has(session.id),
      }));
      this.setPendingInteraction(message.conversationKey, {
        kind: "session-select",
        options,
        expiresAt: Date.now() + SESSION_SELECTION_TTL_MS,
      });
      const pages = chunkArray(options, SESSIONS_ALL_PAGE_SIZE);
      for (const [pageIndex, page] of pages.entries()) {
        const footer = `第 ${pageIndex + 1}/${pages.length} 页 · 发送 \`/switch <编号>\` 恢复或切换 · \`/delete <编号>\` 彻底删除 · 30s 内有效`;
        await this.sendPayload(message.chatId, buildSessionListCardPayload({
          items: page.map((option) => ({
            index: option.index,
            title: option.title,
            current: option.current,
            archived: !option.inWindow,
            meta: option.current ? "当前" : option.inWindow ? "窗口中" : "已隐藏",
          })),
          footer,
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "全部会话",
          len: 4,
        }, { replyToMessageId: message.messageId });
      }
      return;
    }

    if (command.kind === "sessions-select") {
      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      if (window.mode === "single") {
        await this.sendMarkdown(message.chatId, "当前窗口为单会话模式，不支持切换。", message.messageId);
        return;
      }

      const pending = this.pendingInteractions.get(message.conversationKey);
      if (!pending || pending.kind !== "session-select" || pending.expiresAt <= Date.now()) {
        this.clearPendingInteraction(message.conversationKey, false);
        await this.sendMarkdown(message.chatId, "会话列表已过期，请先重新执行 `/sessions`。", message.messageId);
        return;
      }

      const match = pending.options.find((option) => option.index === command.index);
      if (!match) {
        await this.sendMarkdown(message.chatId, "无效的会话编号，请重新执行 `/sessions` 查看列表。", message.messageId);
        return;
      }

      const openCodeSessions = await this.listOpenCodeSessionsById();
      if (!openCodeSessions.has(match.sessionId)) {
        const nextWindow = removeSession(window, match.sessionId, this.config.bridge.maxSessionsPerWindow);
        await this.saveSessionWindow(message.conversationKey, nextWindow);
        this.clearPendingInteraction(message.conversationKey, false);
        await this.sendMarkdown(message.chatId, "目标会话已失效，已从当前窗口列表移除，请重新执行 `/sessions`。", message.messageId);
        return;
      }

      const sessionMeta = openCodeSessions.get(match.sessionId);
      const fallbackLabel = resolveDisplayLabel(sessionMeta, match.title, match.sessionId);
      let nextWindow = match.inWindow
        ? setActiveSession(window, match.sessionId, Date.now(), this.config.bridge.maxSessionsPerWindow)
        : addSession(window, createSessionEntry(
          match.sessionId,
          Date.now(),
          fallbackLabel,
        ), this.config.bridge.maxSessionsPerWindow);
      nextWindow = setActiveSession(nextWindow, match.sessionId, Date.now(), this.config.bridge.maxSessionsPerWindow);
      nextWindow = updateSessionLabel(nextWindow, match.sessionId, fallbackLabel, this.config.bridge.maxSessionsPerWindow);
      await this.saveSessionWindow(message.conversationKey, nextWindow);
      this.clearPendingInteraction(message.conversationKey, false);
      const previous = getActiveSession(window);
      const current = getActiveSession(nextWindow);
      const messageCount = await this.getSessionMessageCount(match.sessionId);
      await this.sendPayload(message.chatId, buildSessionTransitionCardPayload({
        title: "已切换会话",
        iconToken: "sheet-iconsets-check_filled",
        previousLabel: previous?.sessionId === current?.sessionId ? null : previous?.label ?? null,
        currentLabel: current?.label ?? fallbackLabel,
        footer: `创建于 ${formatSessionTimestamp(current?.createdAt ?? sessionMeta?.time?.created ?? Date.now())} · 共 ${messageCount} 条消息`,
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已切换会话",
        len: 5,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "close") {
      if (command.all) {
        const window = this.getSessionWindow(message.conversationKey, message.chatType);
        if (window.sessions.length === 0) {
          await this.sendMarkdown(message.chatId, "当前窗口暂无可操作的会话，请先发送 `/new`。", message.messageId);
          return;
        }
        const busySession = window.sessions.find((session) => this.isSessionBusy(message.conversationKey, session.sessionId));
        if (busySession) {
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "提醒",
            template: "yellow",
            iconToken: "maybe_outlined",
            message: "当前会话正在执行任务，请先发送 `/abort`。",
            messageIconToken: "maybe_outlined",
            messageIconColor: "yellow",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
            len: 20,
          }, { replyToMessageId: message.messageId });
          return;
        }

        await this.saveSessionWindow(message.conversationKey, normalizeSessionWindowRecord(undefined, window.mode, this.config.bridge.maxSessionsPerWindow));
        this.clearPendingInteraction(message.conversationKey, false);
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "已删除全部会话",
          template: "grey",
          iconToken: "close-bold_outlined",
          message: "当前窗口的全部会话已移除，发送 `/new` 创建新会话。",
          messageIconToken: "close-bold_outlined",
          messageIconColor: "grey",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前窗口的全部会话已移除，发送 `/new` 创建新会话。",
          len: 24,
        }, { replyToMessageId: message.messageId });
        return;
      }

      if (command.range) {
        const targets = await this.resolveSessionCommandTargets(message, command.range);
        if (!targets.ok) {
          await this.sendMarkdown(message.chatId, targets.message, message.messageId);
          return;
        }

        const busySession = targets.sessions.find((session) => this.isSessionBusy(message.conversationKey, session.sessionId));
        if (busySession) {
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "提醒",
            template: "yellow",
            iconToken: "maybe_outlined",
            message: "当前会话正在执行任务，请先发送 `/abort`。",
            messageIconToken: "maybe_outlined",
            messageIconColor: "yellow",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
            len: 20,
          }, { replyToMessageId: message.messageId });
          return;
        }

        let nextWindow = targets.window;
        for (const session of targets.sessions) {
          nextWindow = removeSession(nextWindow, session.sessionId, this.config.bridge.maxSessionsPerWindow);
        }
        await this.saveSessionWindow(message.conversationKey, nextWindow);
        this.clearPendingInteraction(message.conversationKey, false);
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "已删除多个会话",
          template: "grey",
          iconToken: "close-bold_outlined",
          message: `已从当前窗口移除 ${targets.sessions.length} 个会话。`,
          messageIconToken: "close-bold_outlined",
          messageIconColor: "grey",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: `已从当前窗口移除 ${targets.sessions.length} 个会话。`,
          len: 17,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const target = await this.resolveSessionCommandTarget(message, command.index);
      if (!target.ok) {
        await this.sendMarkdown(message.chatId, target.message, message.messageId);
        return;
      }

      if (this.isSessionBusy(message.conversationKey, target.session.sessionId)) {
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "提醒",
          template: "yellow",
          iconToken: "maybe_outlined",
          message: "当前会话正在执行任务，请先发送 `/abort`。",
          messageIconToken: "maybe_outlined",
          messageIconColor: "yellow",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
          len: 20,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const nextWindow = removeSession(target.window, target.session.sessionId, this.config.bridge.maxSessionsPerWindow);
      await this.saveSessionWindow(message.conversationKey, nextWindow);
      this.clearPendingInteraction(message.conversationKey, false);
      const current = getActiveSession(nextWindow);
      await this.sendPayload(message.chatId, buildSessionTransitionCardPayload({
        title: "已删除会话",
        iconToken: "close-bold_outlined",
        previousLabel: target.session.label,
        currentLabel: current?.label ?? "当前窗口已无会话",
        footer: current ? "已从当前窗口移除，可继续使用当前会话" : "已从当前窗口移除，发送 `/new` 创建新会话",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已删除会话",
        len: 5,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "delete") {
      if (command.all && !command.confirm) {
        const window = this.getSessionWindow(message.conversationKey, message.chatType);
        if (window.sessions.length === 0) {
          await this.sendMarkdown(message.chatId, "当前窗口暂无可操作的会话，请先发送 `/new`。", message.messageId);
          return;
        }
        const busySession = window.sessions.find((session) => this.isSessionBusy(message.conversationKey, session.sessionId));
        if (busySession) {
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "提醒",
            template: "yellow",
            iconToken: "maybe_outlined",
            message: "当前会话正在执行任务，请先发送 `/abort`。",
            messageIconToken: "maybe_outlined",
            messageIconColor: "yellow",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
            len: 20,
          }, { replyToMessageId: message.messageId });
          return;
        }

        this.setPendingInteraction(message.conversationKey, {
          kind: "session-delete-confirm",
          all: true,
          sessionIds: window.sessions.map((session) => session.sessionId),
          expiresAt: Date.now() + SESSION_DELETE_CONFIRM_TTL_MS,
        });
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "提醒",
          template: "yellow",
          iconToken: "maybe_outlined",
          message: "确认彻底删除当前窗口全部会话？发送 `/delete all confirm`",
          messageIconToken: "maybe_outlined",
          messageIconColor: "yellow",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "确认彻底删除当前窗口全部会话？发送 `/delete all confirm`",
          len: 31,
        }, { replyToMessageId: message.messageId });
        return;
      }

      if (!command.confirm) {
        if (command.range) {
          const targets = await this.resolveSessionCommandTargets(message, command.range);
          if (!targets.ok) {
            await this.sendMarkdown(message.chatId, targets.message, message.messageId);
            return;
          }

          const busySession = targets.sessions.find((session) => this.isSessionBusy(message.conversationKey, session.sessionId));
          if (busySession) {
            await this.sendPayload(message.chatId, buildNoticeCardPayload({
              title: "提醒",
              template: "yellow",
              iconToken: "maybe_outlined",
              message: "当前会话正在执行任务，请先发送 `/abort`。",
              messageIconToken: "maybe_outlined",
              messageIconColor: "yellow",
            }), {
              event: "final message sent",
              transcriptType: "outbound-final",
              textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
              len: 20,
            }, { replyToMessageId: message.messageId });
            return;
          }

          const rangeLabel = `${command.range.start}-${command.range.end}`;
          this.setPendingInteraction(message.conversationKey, {
            kind: "session-delete-confirm",
            indices: targets.indices,
            rangeLabel,
            sessionIds: targets.sessions.map((session) => session.sessionId),
            titles: targets.sessions.map((session) => session.label),
            expiresAt: Date.now() + SESSION_DELETE_CONFIRM_TTL_MS,
          });
          const confirmText = `确认删除会话 #${rangeLabel}？发送 \`/delete ${rangeLabel} confirm\``;
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "提醒",
            template: "yellow",
            iconToken: "maybe_outlined",
            message: confirmText,
            messageIconToken: "maybe_outlined",
            messageIconColor: "yellow",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: confirmText,
            len: confirmText.length,
          }, { replyToMessageId: message.messageId });
          return;
        }

        const target = await this.resolveSessionCommandTarget(message, command.index);
        if (!target.ok) {
          await this.sendMarkdown(message.chatId, target.message, message.messageId);
          return;
        }

        if (this.isSessionBusy(message.conversationKey, target.session.sessionId)) {
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "提醒",
            template: "yellow",
            iconToken: "maybe_outlined",
            message: "当前会话正在执行任务，请先发送 `/abort`。",
            messageIconToken: "maybe_outlined",
            messageIconColor: "yellow",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
            len: 20,
          }, { replyToMessageId: message.messageId });
          return;
        }

        this.setPendingInteraction(message.conversationKey, {
          kind: "session-delete-confirm",
          index: target.index,
          sessionId: target.session.sessionId,
          title: target.session.label,
          expiresAt: Date.now() + SESSION_DELETE_CONFIRM_TTL_MS,
        });
        const confirmText = target.index > 0
          ? `确认删除会话 #${target.index}？发送 \`/delete ${target.index} confirm\``
          : "确认删除当前会话？发送 `/delete confirm`";
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "提醒",
          template: "yellow",
          iconToken: "maybe_outlined",
          message: confirmText,
          messageIconToken: "maybe_outlined",
          messageIconColor: "yellow",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: confirmText,
          len: confirmText.length,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const pending = this.pendingInteractions.get(message.conversationKey);
      if (!pending || pending.kind !== "session-delete-confirm" || pending.expiresAt <= Date.now()) {
        this.clearPendingInteraction(message.conversationKey, false);
        await this.sendMarkdown(message.chatId, "删除确认已过期，请重新发送 `/delete`。", message.messageId);
        return;
      }

      if (command.all) {
        if (!pending.all || !pending.sessionIds || pending.sessionIds.length === 0) {
          this.clearPendingInteraction(message.conversationKey, false);
          await this.sendMarkdown(message.chatId, "删除确认已过期，请重新发送 `/delete all`。", message.messageId);
          return;
        }

        const busySession = pending.sessionIds.find((sessionId) => this.isSessionBusy(message.conversationKey, sessionId));
        if (busySession) {
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "提醒",
            template: "yellow",
            iconToken: "maybe_outlined",
            message: "当前会话正在执行任务，请先发送 `/abort`。",
            messageIconToken: "maybe_outlined",
            messageIconColor: "yellow",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
            len: 20,
          }, { replyToMessageId: message.messageId });
          return;
        }

        for (const sessionId of pending.sessionIds) {
          await this.opencode.deleteSession(sessionId);
        }
        const window = this.getSessionWindow(message.conversationKey, message.chatType);
        await this.saveSessionWindow(message.conversationKey, normalizeSessionWindowRecord(undefined, window.mode, this.config.bridge.maxSessionsPerWindow));
        this.clearPendingInteraction(message.conversationKey, false);
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "已彻底删除全部会话",
          template: "red",
          iconToken: "close-bold_outlined",
          message: "当前窗口的全部会话已从窗口和 OpenCode 中删除。",
          messageIconToken: "close-bold_outlined",
          messageIconColor: "red",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前窗口的全部会话已从窗口和 OpenCode 中删除。",
          len: 25,
        }, { replyToMessageId: message.messageId });
        return;
      }

      if (command.index !== undefined && pending.index !== command.index) {
        await this.sendMarkdown(message.chatId, "删除确认编号不匹配，请重新发送 `/delete <编号>`。", message.messageId);
        return;
      }

      if (command.range) {
        const rangeLabel = `${command.range.start}-${command.range.end}`;
        const expectedIndices = buildSessionRangeIndices(command.range);
        const sameRange = pending.indices
          && pending.rangeLabel === rangeLabel
          && pending.indices.length === expectedIndices.length
          && pending.indices.every((value, idx) => value === expectedIndices[idx]);
        if (!sameRange) {
          await this.sendMarkdown(message.chatId, "删除确认编号不匹配，请重新发送 `/delete <起始-结束>`。", message.messageId);
          return;
        }
      }

      if (!pending.sessionId) {
        if (pending.sessionIds && pending.sessionIds.length > 0) {
          const busySession = pending.sessionIds.find((sessionId) => this.isSessionBusy(message.conversationKey, sessionId));
          if (busySession) {
            await this.sendPayload(message.chatId, buildNoticeCardPayload({
              title: "提醒",
              template: "yellow",
              iconToken: "maybe_outlined",
              message: "当前会话正在执行任务，请先发送 `/abort`。",
              messageIconToken: "maybe_outlined",
              messageIconColor: "yellow",
            }), {
              event: "final message sent",
              transcriptType: "outbound-final",
              textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
              len: 20,
            }, { replyToMessageId: message.messageId });
            return;
          }

          const window = this.getSessionWindow(message.conversationKey, message.chatType);
          for (const sessionId of pending.sessionIds) {
            await this.opencode.deleteSession(sessionId);
          }
          let nextWindow = window;
          for (const sessionId of pending.sessionIds) {
            nextWindow = removeSession(nextWindow, sessionId, this.config.bridge.maxSessionsPerWindow);
          }
          await this.saveSessionWindow(message.conversationKey, nextWindow);
          this.clearPendingInteraction(message.conversationKey, false);
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "已彻底删除多个会话",
            template: "red",
            iconToken: "close-bold_outlined",
            message: `已从当前窗口和 OpenCode 中删除 ${pending.sessionIds.length} 个会话。`,
            messageIconToken: "close-bold_outlined",
            messageIconColor: "red",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: `已从当前窗口和 OpenCode 中删除 ${pending.sessionIds.length} 个会话。`,
            len: 25,
          }, { replyToMessageId: message.messageId });
          return;
        }

        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "提醒",
          template: "yellow",
          iconToken: "maybe_outlined",
          message: "删除确认已失效，请重新发送 `/delete`。",
          messageIconToken: "maybe_outlined",
          messageIconColor: "yellow",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "删除确认已失效，请重新发送 `/delete`。",
          len: 19,
        }, { replyToMessageId: message.messageId });
        return;
      }

      if (this.isSessionBusy(message.conversationKey, pending.sessionId)) {
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "提醒",
          template: "yellow",
          iconToken: "maybe_outlined",
          message: "当前会话正在执行任务，请先发送 `/abort`。",
          messageIconToken: "maybe_outlined",
          messageIconColor: "yellow",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前会话正在执行任务，请先发送 `/abort`。",
          len: 20,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      const targetSession = window.sessions.find((session) => session.sessionId === pending.sessionId);
      await this.opencode.deleteSession(pending.sessionId);
      const nextWindow = removeSession(window, pending.sessionId, this.config.bridge.maxSessionsPerWindow);
      await this.saveSessionWindow(message.conversationKey, nextWindow);
      this.clearPendingInteraction(message.conversationKey, false);
      const current = getActiveSession(nextWindow);
      await this.sendPayload(message.chatId, buildSessionTransitionCardPayload({
        title: "已彻底删除会话",
        iconToken: "close-bold_outlined",
        previousLabel: targetSession?.label ?? pending.title ?? null,
        currentLabel: current?.label ?? "当前窗口已无会话",
        footer: current ? "已从当前窗口和 OpenCode 中删除" : "已从当前窗口和 OpenCode 中删除，发送 `/new` 创建新会话",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已彻底删除会话",
        len: 7,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "who") {
      if (message.chatType !== "group" && message.chatType !== "topic_group") {
        await this.sendMarkdown(message.chatId, "该命令仅支持群聊使用", message.messageId);
        return;
      }

      await this.sendPayload(message.chatId, buildWhoCommandCardPayload({
        boundCount: this.whitelist.count(message.chatId),
        isBound: this.whitelist.isBound(message.chatId, message.senderOpenId),
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "群聊绑定状态",
        len: 6,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "leave") {
      if (message.chatType !== "group" && message.chatType !== "topic_group") {
        await this.sendMarkdown(message.chatId, "该命令仅支持群聊使用", message.messageId);
        return;
      }

      const unbound = await this.whitelist.unbind(message.chatId, message.senderOpenId);
      await this.sendPayload(message.chatId, buildLeaveCommandCardPayload({ unbound }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: unbound ? "已解除绑定" : "无需解除绑定",
        len: unbound ? 5 : 6,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "allow" || command.kind === "deny") {
      const pending = this.pendingInteractions.get(message.conversationKey);
      if (!pending || pending.kind !== "permission") {
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "信息提示",
          template: "blue",
          iconToken: "info_outlined",
          message: "当前没有待确认的权限请求。",
          messageIconToken: "info_outlined",
          messageIconColor: "blue",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前没有待确认的权限请求。",
          len: 13,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const resolution: PermissionResolution = command.kind === "deny" ? "deny" : command.policy;
      await this.resolvePermissionInteraction(pending, resolution);
      await this.sendPayload(message.chatId, this.buildPermissionResolutionPayload(resolution), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: resolution === "deny" ? "已拒绝权限请求。" : "已确认权限请求。",
        len: 8,
      }, { replyToMessageId: message.messageId });
      return;
    }

    const sessionId = await this.ensureSession(message);
    const result = await this.opencode.runCommand(sessionId, {
      command: command.name,
      arguments: command.arguments,
    });
    const text = extractAssistantText(result) || "命令已执行。";
    await this.sendMarkdown(message.chatId, text, message.messageId);
  }

  private async handlePendingInteraction(message: IncomingChatMessage, pending: PendingInteraction): Promise<boolean> {
    if (pending.kind === "question") {
      try {
        await this.opencode.replyQuestion(pending.requestId, [message.plainText]);
        this.clearPendingInteraction(message.conversationKey, false);
        const currentTurnId = this.queues.get(message.conversationKey).peek()?.turnId;
        if (currentTurnId) {
          await this.updateTurnCard(currentTurnId, { status: "处理中", update: "已收到你的回答，继续处理中...", target: "step" });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.sendMarkdown(message.chatId, `回答问题失败：${escapeMarkdownText(detail)}`, message.messageId);
      }
      return true;
    }

    if (pending.kind === "permission") {
      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "信息提示",
        template: "blue",
        iconToken: "info_outlined",
        message: "当前有待确认的权限请求，请先点击卡片按钮或发送 `/allow once`、`/allow always`、`/deny`。",
        messageIconToken: "info_outlined",
        messageIconColor: "blue",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "当前有待确认的权限请求。",
        len: 25,
      }, { replyToMessageId: message.messageId });
      return true;
    }

    return false;
  }

  private async ensureSession(source: Pick<BridgeTurn, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<string> {
    const openCodeSessions = await this.listOpenCodeSessionsById();
    let window = this.getSessionWindow(source.conversationKey, source.chatType);
    let currentSession = getActiveSession(window);

    while (currentSession) {
      if (openCodeSessions.has(currentSession.sessionId)) {
        let nextWindow = setActiveSession(window, currentSession.sessionId, Date.now(), this.config.bridge.maxSessionsPerWindow);
        const sessionMeta = openCodeSessions.get(currentSession.sessionId);
        const fallbackLabel = resolveDisplayLabel(sessionMeta, currentSession.label, currentSession.sessionId);
        nextWindow = updateSessionLabel(nextWindow, currentSession.sessionId, fallbackLabel, this.config.bridge.maxSessionsPerWindow);
        await this.saveSessionWindow(source.conversationKey, nextWindow);
        return currentSession.sessionId;
      }

      window = removeSession(window, currentSession.sessionId, this.config.bridge.maxSessionsPerWindow);
      await this.saveSessionWindow(source.conversationKey, window);
      currentSession = getActiveSession(window);
    }

    const entry = await this.createAndBindSession(source);
    return entry.sessionId;
  }

  private async ensureServerAvailableForMessage(message: Pick<IncomingChatMessage, "chatId" | "messageId">): Promise<boolean> {
    if (this.eventStream.getConnectionState() === "connected") {
      return true;
    }

    try {
      await this.opencode.health();
      return true;
    } catch {
      await this.sendMarkdown(message.chatId, "OpenCode 服务不可用，请先确认 `opencode serve` 正在运行。", message.messageId);
      return false;
    }
  }

  private async handleGlobalEvent(event: OpenCodeEvent): Promise<void> {
    if (event.type === "session.status") {
      const sessionId = getEventSessionId(event);
      const status = readOptionalRecord(event.properties, "status");
      if (sessionId && status) {
        this.sessionStatuses.set(sessionId, status as OpenCodeSessionStatus);
      }
      return;
    }

    if (event.type === "session.idle") {
      const sessionId = getEventSessionId(event);
      if (sessionId) {
        this.sessionStatuses.set(sessionId, { type: "idle" });
      }
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
    const messages = await this.opencode.getSessionMessages(sessionId, 200);
    return [...messages]
      .reverse()
      .find((message) => isAssistantMessageAfterBaseline(message, options)) ?? null;
  }

  private async getAssistantMessageById(sessionId: string, messageId: string): Promise<OpenCodeMessage | null> {
    const messages = await this.opencode.getSessionMessages(sessionId, 200);
    return messages.find((message) => message.info.id === messageId && message.info.role === "assistant") ?? null;
  }

  private getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord {
    const mode = resolveSessionMode(chatType, this.config.bridge.sessionModes);
    return normalizeSessionWindowRecord(this.sessionMap[conversationKey], mode, this.config.bridge.maxSessionsPerWindow);
  }

  private async saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void> {
    if (window.sessions.length === 0) {
      delete this.sessionMap[conversationKey];
    } else {
      this.sessionMap[conversationKey] = window;
    }
    await this.mappings.save(this.sessionMap);
  }

  private async createAndBindSession(
    source: Pick<BridgeTurn, "chatId" | "chatType" | "conversationKey" | "threadKey">,
  ): Promise<SessionBindingRecord> {
    const session = await this.opencode.createSession(buildSessionTitle(source.chatId, source.chatType, source.threadKey));
    const entry = createSessionEntry(session.id, Date.now(), "新会话");
    const window = this.getSessionWindow(source.conversationKey, source.chatType);
    const nextWindow = addSession(window, entry, this.config.bridge.maxSessionsPerWindow);
    await this.saveSessionWindow(source.conversationKey, nextWindow);
    return entry;
  }

  private async maybeUpdateSessionLabel(turn: BridgeTurn & { sessionId: string }): Promise<void> {
    const window = this.getSessionWindow(turn.conversationKey, turn.chatType);
    const currentSession = window.sessions.find((session) => session.sessionId === turn.sessionId);
    if (!currentSession || currentSession.label !== "新会话") {
      return;
    }

    const nextLabel = summarizeSessionLabel(turn.plainText) || currentSession.label;
    if (nextLabel === currentSession.label) {
      return;
    }

    const nextWindow = updateSessionLabel(window, turn.sessionId, nextLabel, this.config.bridge.maxSessionsPerWindow);
    await this.saveSessionWindow(turn.conversationKey, nextWindow);
  }

  private async listOpenCodeSessionsById(): Promise<Map<string, OpenCodeSession>> {
    const sessions = await this.opencode.listSessions();
    return new Map(sessions.map((session) => [session.id, session]));
  }

  private async getSessionMessageCount(sessionId: string): Promise<number> {
    try {
      return (await this.opencode.getSessionMessages(sessionId, 200)).length;
    } catch {
      return 0;
    }
  }

  private async syncStoredSessionLabels(): Promise<void> {
    const sessionsById = await this.listOpenCodeSessionsById();
    let changed = false;

    for (const [conversationKey, window] of Object.entries(this.sessionMap)) {
      let nextWindow = normalizeSessionWindowRecord(window, window.mode, this.config.bridge.maxSessionsPerWindow);
      for (const session of nextWindow.sessions) {
        if (!shouldHydrateLabelFromSessionMeta(session.label, session.sessionId)) {
          continue;
        }
        const nextLabel = resolveDisplayLabel(sessionsById.get(session.sessionId), session.label, session.sessionId);
        if (nextLabel === session.label) {
          continue;
        }
        nextWindow = updateSessionLabel(nextWindow, session.sessionId, nextLabel, this.config.bridge.maxSessionsPerWindow);
        changed = true;
      }
      this.sessionMap[conversationKey] = nextWindow;
    }

    if (changed) {
      await this.mappings.save(this.sessionMap);
    }
  }

  private setPendingInteraction(conversationKey: string, interaction: PendingInteraction): void {
    this.clearPendingInteraction(conversationKey, false);
    this.pendingInteractions.set(conversationKey, interaction);

    if (interaction.kind === "permission") {
      const timer = setTimeout(() => {
        void this.handlePermissionTimeout(conversationKey, interaction);
      }, Math.max(0, interaction.expiresAt - Date.now()));
      this.pendingInteractionTimers.set(conversationKey, timer);
      return;
    }

    if (interaction.kind === "session-select") {
      const timer = setTimeout(() => {
        this.clearPendingInteraction(conversationKey, false);
      }, Math.max(0, interaction.expiresAt - Date.now()));
      this.pendingInteractionTimers.set(conversationKey, timer);
      return;
    }

    if (interaction.kind === "session-delete-confirm") {
      const timer = setTimeout(() => {
        this.clearPendingInteraction(conversationKey, false);
      }, Math.max(0, interaction.expiresAt - Date.now()));
      this.pendingInteractionTimers.set(conversationKey, timer);
    }
  }

  private clearPendingInteraction(conversationKey: string, keepNonExpiring: boolean): void {
    const timeout = this.pendingInteractionTimers.get(conversationKey);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingInteractionTimers.delete(conversationKey);
    }

    if (keepNonExpiring) {
      const current = this.pendingInteractions.get(conversationKey);
      if (current?.kind === "question") {
        return;
      }
    }

    this.pendingInteractions.delete(conversationKey);
  }

  private async handlePermissionTimeout(conversationKey: string, pending: PendingPermissionInteraction): Promise<void> {
    const current = this.pendingInteractions.get(conversationKey);
    if (!current || current.kind !== "permission" || current.permissionId !== pending.permissionId) {
      return;
    }

    await this.expirePermissionInteraction(current, true);
  }

  private isSessionBusy(conversationKey: string, sessionId: string): boolean {
    const active = this.queues.get(conversationKey).peek();
    return active?.sessionId === sessionId;
  }

  private async resolveSessionCommandTarget(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey">,
    index: number | undefined,
  ): Promise<
    | { ok: true; window: SessionWindowRecord; session: SessionWindowRecord["sessions"][number]; index: number }
    | { ok: false; message: string }
  > {
    const window = this.getSessionWindow(message.conversationKey, message.chatType);
    const current = getActiveSession(window);
    if (index === undefined) {
      if (!current) {
        return { ok: false, message: "当前窗口暂无可操作的会话，请先发送 `/new`。" };
      }
      return { ok: true, window, session: current, index: 0 };
    }

    if (window.mode === "single" && index === 1 && current) {
      return { ok: true, window, session: current, index };
    }

    const pending = this.pendingInteractions.get(message.conversationKey);
    if (!pending || pending.kind !== "session-select" || pending.expiresAt <= Date.now()) {
      this.clearPendingInteraction(message.conversationKey, false);
      const visibleSessions = getVisibleSessions(window);
      const directSession = visibleSessions[index - 1];
      if (directSession) {
        return { ok: true, window, session: directSession, index };
      }
      return {
        ok: false,
        message: window.mode === "single"
          ? "当前窗口为单会话模式，请发送 `/delete`、`/close` 或先执行 `/sessions all`。"
          : "会话列表已过期，请先重新执行 `/sessions`。",
      };
    }

    const match = pending.options.find((option) => option.index === index);
    if (!match) {
      return { ok: false, message: "无效的会话编号，请重新执行 `/sessions` 查看列表。" };
    }

    const session = window.sessions.find((item) => item.sessionId === match.sessionId);
    if (!session && !match.inWindow) {
      return {
        ok: true,
        window,
        session: {
          sessionId: match.sessionId,
          label: match.title,
          createdAt: 0,
          lastUsedAt: 0,
        },
        index,
      };
    }

    if (!session) {
      return { ok: false, message: "目标会话已失效，请重新执行 `/sessions`。" };
    }

    return { ok: true, window, session, index };
  }

  private async resolveSessionCommandTargets(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey">,
    range: { start: number; end: number },
  ): Promise<
    | { ok: true; window: SessionWindowRecord; sessions: SessionWindowRecord["sessions"]; indices: number[] }
    | { ok: false; message: string }
  > {
    const indices = buildSessionRangeIndices(range);
    if (indices.length === 0) {
      return { ok: false, message: "无效的会话编号范围，请重新输入。"};
    }

    const sessions: SessionWindowRecord["sessions"] = [];
    let window: SessionWindowRecord | null = null;
    for (const index of indices) {
      const target = await this.resolveSessionCommandTarget(message, index);
      if (!target.ok) {
        return target;
      }
      window = target.window;
      if (!sessions.some((session) => session.sessionId === target.session.sessionId)) {
        sessions.push(target.session);
      }
    }

    return { ok: true, window: window ?? this.getSessionWindow(message.conversationKey, message.chatType), sessions, indices };
  }

  private buildPermissionActionButtons(interaction: PendingPermissionInteraction): Array<{
    label: string;
    type: "default" | "primary" | "danger";
    value: PermissionCardActionValue;
  }> {
    return [
      {
        label: "/allow once · 仅此一次",
        type: "primary",
        value: this.buildPermissionActionValue(interaction, "once"),
      },
      {
        label: "/allow always · 始终允许",
        type: "default",
        value: this.buildPermissionActionValue(interaction, "always"),
      },
      {
        label: "/deny · 拒绝",
        type: "danger",
        value: this.buildPermissionActionValue(interaction, "deny"),
      },
    ];
  }

  private buildPermissionActionValue(
    interaction: PendingPermissionInteraction,
    policy: PermissionCardActionValue["policy"],
  ): PermissionCardActionValue {
    return {
      kind: "permission",
      conversationKey: interaction.conversationKey,
      turnId: interaction.turnId,
      sessionId: interaction.sessionId,
      permissionId: interaction.permissionId,
      policy,
      nonce: interaction.permissionVersion,
    };
  }

  private matchesPermissionAction(
    interaction: PendingPermissionInteraction,
    value: PermissionCardActionValue,
    openMessageId: string,
  ): boolean {
    const matchesMessageId = !openMessageId
      || !interaction.permissionMessageId
      || interaction.permissionMessageId === openMessageId;

    return interaction.conversationKey === value.conversationKey
      && interaction.permissionId === value.permissionId
      && interaction.sessionId === value.sessionId
      && interaction.turnId === value.turnId
      && interaction.permissionVersion === value.nonce
      && matchesMessageId;
  }

  private async resolvePermissionInteraction(
    interaction: PendingPermissionInteraction,
    resolution: PermissionResolution,
  ): Promise<void> {
    const remember = resolution === "always";
    const response: PermissionPolicy = resolution === "deny" || resolution === "timeout" ? "reject" : resolution;
    this.permissionProcessing.add(interaction.permissionVersion);
    try {
      await this.opencode.replyPermission(interaction.sessionId, interaction.permissionId, response, remember);
      interaction.resolvedAt = Date.now();
      interaction.resolution = resolution;
      this.permissionInteractions.set(interaction.permissionVersion, interaction);
      this.clearPendingInteraction(interaction.conversationKey, false);
      await this.updateTurnCard(interaction.turnId, {
        status: "处理中",
        update: resolution === "timeout"
          ? "权限请求已超时，已默认拒绝"
          : `已处理权限请求：${interaction.permissionName}`,
        target: "step",
      });
    } finally {
      this.permissionProcessing.delete(interaction.permissionVersion);
    }
  }

  private async expirePermissionInteraction(
    interaction: PendingPermissionInteraction,
    notifyChat: boolean,
  ): Promise<void> {
    try {
      await this.resolvePermissionInteraction(interaction, "timeout");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("bridge/permission", "auto deny failed", {
        chatId: interaction.chatId,
        permissionId: interaction.permissionId,
        nonce: interaction.permissionVersion,
        detail,
      }, "warn");
      interaction.resolvedAt = Date.now();
      interaction.resolution = "timeout";
      this.permissionInteractions.set(interaction.permissionVersion, interaction);
      this.clearPendingInteraction(interaction.conversationKey, false);
    }

    if (!notifyChat) {
      return;
    }

    await this.sendPayload(interaction.chatId, this.buildPermissionResolutionPayload("timeout"), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: "权限请求已超时，已默认拒绝。",
      len: 13,
    }, { replyToMessageId: interaction.replyToMessageId });
  }

  private buildPermissionResolutionPayload(resolution: PermissionResolution): FeishuPostPayload {
    if (resolution === "once") {
      return buildNoticeCardPayload({
        title: "信息提示",
        template: "green",
        iconToken: "yes_outlined",
        message: "当前权限请求已确认，可继续执行。",
        messageIconToken: "yes_outlined",
        messageIconColor: "green",
      });
    }

    if (resolution === "always") {
      return buildNoticeCardPayload({
        title: "信息提示",
        template: "green",
        iconToken: "yes_outlined",
        message: "当前权限请求已确认，后续同类权限将自动允许。",
        messageIconToken: "yes_outlined",
        messageIconColor: "green",
      });
    }

    if (resolution === "timeout") {
      return buildNoticeCardPayload({
        title: "提醒",
        template: "yellow",
        iconToken: "maybe_outlined",
        message: "权限请求已超时，已默认拒绝。",
        messageIconToken: "maybe_outlined",
        messageIconColor: "yellow",
      });
    }

    return buildNoticeCardPayload({
      title: "错误",
      template: "red",
      iconToken: "more-close_outlined",
      message: "当前权限请求已拒绝。",
      messageIconToken: "more-close_outlined",
      messageIconColor: "red",
    });
  }

  private toCardContent(payload: FeishuPostPayload): Record<string, unknown> {
    return toInteractiveCardContent(payload);
  }

  private async createTurnCard(chatId: string, turnId: string, sessionId: string, replyToMessageId: string): Promise<TurnCardState | null> {
    const state: TurnCardState = {
      messageId: "",
      status: "处理中",
      sessionId,
      startedAt: Date.now(),
      progressUpdates: [initialCardSummary],
      toolUpdates: [],
      output: { text: "", paths: [], commands: [] },
    };
    try {
      const payload = buildTurnStatusCardPayload(this.toTurnCardView(state));
      const result = await this.sendPayload(chatId, payload, {
        event: "process message sent",
        transcriptType: "outbound-process",
        textPreview: initialCardSummary,
        len: initialCardSummary.length,
      }, { replyToMessageId });
      state.messageId = result.messageId;
      this.turnCards.set(turnId, state);
      return state;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("feishu/reply", "process card send failed", { chatId, turnId, detail }, "warn");
      return null;
    }
  }

  private async scheduleStreamUpdate(turnId: string, text: string): Promise<void> {
    const card = this.turnCards.get(turnId);
    if (!card) return;

    const state = this.streamFlushStates.get(turnId) ?? {
      flushedLength: 0,
      lastFlushedAt: 0,
      timer: null,
    };
    this.streamFlushStates.set(turnId, state);

    const deltaLength = Math.max(0, text.length - state.flushedLength);
    const elapsed = Date.now() - state.lastFlushedAt;
    if (deltaLength >= STREAM_FLUSH_MIN_CHARS || elapsed >= STREAM_FLUSH_INTERVAL_MS) {
      await this.flushStreamUpdate(turnId, text, false);
      return;
    }

    if (state.timer) {
      return;
    }

    const delay = Math.max(0, STREAM_FLUSH_INTERVAL_MS - elapsed);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushStreamUpdate(turnId, text, false);
    }, delay);
  }

  private async flushStreamUpdate(turnId: string, text: string, force: boolean): Promise<void> {
    const state = this.streamFlushStates.get(turnId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    await this.updateTurnCard(turnId, { update: text, sanitize: false, target: "final" });
    const nextState = state ?? {
      flushedLength: 0,
      lastFlushedAt: 0,
      timer: null,
    };
    nextState.flushedLength = text.length;
    nextState.lastFlushedAt = Date.now();
    this.streamFlushStates.set(turnId, nextState);

    if (force) {
      this.clearStreamFlushState(turnId);
    }
  }

  private clearStreamFlushState(turnId: string): void {
    const state = this.streamFlushStates.get(turnId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.streamFlushStates.delete(turnId);
  }

  private async updateTurnCard(turnId: string, update: { status?: string; update?: string; sanitize?: boolean; target?: "step" | "tool" | "final"; toolKey?: string }): Promise<void> {
    const card = this.turnCards.get(turnId);
    if (!card) return;
    if (update.status) card.status = update.status;
    const nextUpdate = update.update ? (update.sanitize === false ? update.update.trim() : cleanAssistantReply(update.update)) : "";
    if (nextUpdate) {
      if (update.target === "tool") {
        const toolKey = update.toolKey ?? nextUpdate;
        card.toolUpdates = upsertToolUpdate(card.toolUpdates, toolKey, parseToolUpdate(nextUpdate));
      } else if (update.target === "final") {
        card.output = parseOutput(nextUpdate);
      } else {
        card.progressUpdates = appendProgressUpdate(card.progressUpdates, nextUpdate);
      }
    }
    try {
      const payload = buildTurnStatusCardPayload(this.toTurnCardView(card));
      const result = await this.outbound.updateMessage(card.messageId, payload);
      this.logger.log("feishu/reply", "process message updated", {
        messageId: result.messageId,
        turnId,
        textPreview: createTextPreview([...card.progressUpdates, ...card.toolUpdates.map((item) => item.view.label)].join(" | ")),
        len: [...card.progressUpdates, ...card.toolUpdates.map((item) => item.view.label)].join("\n").length,
      });
      this.logger.logTranscript("outbound-process", { messageId: result.messageId }, prettyPrintPayload(payload));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("feishu/reply", "process card update failed", { messageId: card.messageId, turnId, detail }, "warn");
    }
  }

  private toTurnCardView(card: TurnCardState): TurnStatusCardView {
    return {
      title: card.status.includes("完成") ? "已完成" : card.status.includes("失败") || card.status.includes("超时") ? "处理异常" : "处理中",
      status: card.status,
      sessionId: card.sessionId,
      durationText: isFinalStatus(card.status) ? formatDuration(Date.now() - card.startedAt) : "",
      progressUpdates: card.progressUpdates,
      toolUpdates: card.toolUpdates.map((item) => item.view),
      output: card.output,
    };
  }

  private async sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<void> {
    await this.sendPayload(chatId, buildPostMarkdownPayload(markdown), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(markdown),
      len: markdown.length,
    }, replyToMessageId ? { replyToMessageId } : undefined);
  }

  private async sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    delivery?: { replyToMessageId: string },
  ): Promise<{ messageId: string }> {
    const shouldReplyInThread = this.config.feishu.behavior.replyInThread;
    const result = shouldReplyInThread && delivery?.replyToMessageId
      ? await this.outbound.replyMessage(delivery.replyToMessageId, payload)
      : await this.outbound.sendMessage(chatId, payload);
    this.logger.log("feishu/reply", options.event, { chatId, messageId: result.messageId, textPreview: options.textPreview, len: options.len });
    this.logger.logTranscript(options.transcriptType, { chatId, messageId: result.messageId }, prettyPrintPayload(payload));
    return result;
  }
}

export function buildPromptRequest(text: string, system?: string): { system?: string; parts: Array<{ type: "text"; text: string }> } {
  return system
    ? {
      system,
      parts: [{ type: "text", text }],
    }
    : {
      parts: [{ type: "text", text }],
    };
}

export function composeSystemPrompt(...sections: Array<string | undefined>): string | undefined {
  const normalized = sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section));
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.join("\n\n");
}

export function toOpencodePromptText(message: Pick<IncomingChatMessage, "chatType" | "senderOpenId" | "plainText">): string {
  if (message.chatType === "p2p") {
    return message.plainText;
  }

  return `[群聊消息][发送者 ${message.senderOpenId}]\n${message.plainText}`;
}

function buildSessionTitle(chatId: string, chatType: string | undefined, threadKey?: string): string {
  if (chatType === "p2p" || !chatType) {
    return `Feishu ${chatId}`;
  }

  return threadKey ? `Feishu ${chatType} ${chatId} ${threadKey}` : `Feishu ${chatType} ${chatId}`;
}

function isPermissionCardActionValue(value: Record<string, unknown>): value is PermissionCardActionValue {
  return value.kind === "permission"
    && typeof value.conversationKey === "string"
    && typeof value.turnId === "string"
    && typeof value.sessionId === "string"
    && typeof value.permissionId === "string"
    && (value.policy === "once" || value.policy === "always" || value.policy === "deny")
    && typeof value.nonce === "string";
}

function toQuestionRequest(properties: Record<string, unknown>, sessionId: string): { id: string; sessionId: string; questions: Array<{ header: string; question: string }> } | null {
  const requestId = readOptionalString(properties, "id");
  const rawQuestions = properties.questions;
  if (!requestId || !Array.isArray(rawQuestions)) return null;
  const questions = rawQuestions
    .map((value) => {
      if (!isRecord(value)) return null;
      const header = readOptionalString(value, "header") ?? "问题";
      const question = readOptionalString(value, "question") ?? header;
      return { header, question };
    })
    .filter((value): value is { header: string; question: string } => value !== null);
  if (questions.length === 0) return null;
  return { id: requestId, sessionId, questions };
}

function formatQuestionPrompt(questions: PendingQuestionInteraction["questions"]): string {
  return ["OpenCode 需要你回答：", ...questions.map((question, index) => `${index + 1}. ${escapeMarkdownText(question.header)}\n${escapeMarkdownText(question.question)}`)].join("\n\n");
}

function buildModelCardView(
  providers: OpenCodeProvidersResponse,
  requestedProvider?: string,
): ModelListCardView | null {
  const normalizedFilter = requestedProvider?.trim().toLowerCase();
  const providerViews = providers.providers
    .map((provider) => toProviderCardView(provider, providers.default, !normalizedFilter))
    .filter((provider): provider is NonNullable<typeof provider> => provider !== null)
    .filter((provider) => !normalizedFilter
      || provider.id.toLowerCase() === normalizedFilter
      || provider.name.toLowerCase() === normalizedFilter);

  if (providerViews.length === 0) {
    return null;
  }

  return {
    providers: providerViews,
    footer: normalizedFilter
      ? "发送 `/model use <provider/model>` 切换当前窗口模型\n发送 `/model reset` 恢复默认模型"
      : "发送 `/model <provider>` 查看更多\n发送 `/model use <provider/model>` 切换当前窗口模型",
  };
}

function toProviderCardView(
  provider: Record<string, unknown>,
  defaults: Record<string, string>,
  compact: boolean,
): { id: string; name: string; models: Array<{ id: string; current?: boolean; default?: boolean }> } | null {
  const id = typeof provider.id === "string"
    ? provider.id
    : typeof provider.providerID === "string"
      ? provider.providerID
      : null;
  if (!id) {
    return null;
  }

  const name = typeof provider.name === "string" ? provider.name : id;
  const rawModels = isRecord(provider.models) ? provider.models : {};
  const defaultModel = defaults[id];
  const allModels = Object.values(rawModels)
    .map((value) => toProviderModelView(value, defaultModel))
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => {
      const leftScore = (left.current ? 100 : 0) + (left.default ? 50 : 0);
      const rightScore = (right.current ? 100 : 0) + (right.default ? 50 : 0);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "");
    });

  const models = (compact ? allModels.slice(0, 5) : allModels).map((model) => ({
    id: `${id}/${model.id}`,
    current: model.current,
    default: model.default,
  }));

  return { id, name, models };
}

function toProviderModelView(
  value: unknown,
  defaultModel: string | undefined,
): { id: string; current: boolean; default: boolean; releaseDate?: string } | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id : null;
  if (!id) {
    return null;
  }

  return {
    id,
    current: false,
    default: defaultModel === id,
    ...(typeof value.release_date === "string" ? { releaseDate: value.release_date } : {}),
  };
}

export function buildBridgeSystemPrompt(
  turn: Pick<BridgeTurn, "chatType" | "conversationKey" | "senderOpenId" | "sessionId">,
  window: SessionWindowRecord,
): string {
  const visibleSessions = getVisibleSessions(window);
  const lines = [
    "[Bridge State]",
    `windowType: ${turn.chatType ?? "p2p"}`,
    `conversationKey: ${turn.conversationKey}`,
    `sessionMode: ${window.mode}`,
    `activeSessionId: ${window.activeSessionId ?? "none"}`,
    "visibleSessions:",
    ...(visibleSessions.length > 0
      ? visibleSessions.map((session) => `- ${session.sessionId === turn.sessionId ? "*" : " "} ${session.label} (${session.sessionId})`)
      : ["- none"]),
    `senderOpenId: ${turn.senderOpenId}`,
    "rules:",
    "- Bridge owns /new /sessions /switch /status and all runtime progress or reply messages.",
    "- Do not pretend to switch, create, close, or rename bridge sessions yourself.",
    "- Use lark-cli only when the user explicitly asks to operate on Feishu or Lark resources.",
  ];
  return lines.join("\n");
}

export function resolveDisplayLabel(session: OpenCodeSession | undefined, currentLabel: string, sessionId: string): string {
  if (!shouldHydrateLabelFromSessionMeta(currentLabel, sessionId)) {
    return currentLabel;
  }

  return session?.title?.trim() || session?.slug?.trim() || currentLabel || sessionId;
}

function shouldHydrateLabelFromSessionMeta(currentLabel: string, sessionId: string): boolean {
  return currentLabel === sessionId;
}

function summarizeSessionLabel(plainText: string): string {
  const normalized = plainText.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 20);
}

function extractAssistantText(message: OpenCodeMessage | null): string {
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function isCompletedMessage(message: OpenCodeMessage): boolean {
  const time = isRecord(message.info.time) ? message.info.time : null;
  return typeof message.info.finish === "string" || typeof time?.completed === "number";
}

function isAssistantMessageAfterBaseline(
  message: OpenCodeMessage,
  options?: {
    afterAssistantId?: string | null;
    afterTimestamp?: number | null;
  },
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }

  if (options?.afterAssistantId && message.info.id === options.afterAssistantId) {
    return false;
  }

  const baselineTimestamp = options?.afterTimestamp ?? null;
  const messageTimestamp = getMessageTimestamp(message);
  if (baselineTimestamp !== null && messageTimestamp !== null && messageTimestamp <= baselineTimestamp) {
    return false;
  }

  return true;
}

function getMessageTimestamp(message: OpenCodeMessage | null): number | null {
  if (!message || !isRecord(message.info.time)) {
    return null;
  }

  const time = message.info.time;
  const candidates = [time.updated, time.completed, time.created];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function prettyPrintPayload(payload: FeishuPostPayload): string {
  return JSON.stringify({ msg_type: payload.msg_type, content: JSON.parse(payload.content) }, null, 2);
}

function escapeMarkdownText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mapToolStatus(status: string | undefined): string {
  switch (status) {
    case "pending": return "等待中";
    case "running": return "执行中";
    case "completed": return "已完成";
    case "error": return "失败";
    default: return status ?? "未知状态";
  }
}

function summarizeReasoningToProgress(text: string): string {
  const normalized = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
  if (!normalized) return "";
  if (/considering user response/i.test(normalized)) return "";
  if (/news|headline|search/i.test(normalized)) return "正在检索相关信息";
  if (/project|package\.json|file/i.test(normalized)) return "正在整理上下文信息";
  return "正在处理中";
}

function formatToolRecord(toolName: string, status: string | undefined, title: string | undefined): string {
  const statusLabel = mapToolStatus(status);
  const detail = formatToolTarget(title) || "-";
  switch (toolName) {
    case "webfetch": return `抓取网页：${detail}（${statusLabel}）`;
    case "read": return `读取文件：${detail}（${statusLabel}）`;
    case "glob": return `查找路径：${detail}（${statusLabel}）`;
    case "apply_patch": return `工具 apply_patch：${detail}（${statusLabel}）`;
    case "bash": return `执行命令：${detail}（${statusLabel}）`;
    default: return `工具 ${toolName}：${detail}（${statusLabel}）`;
  }
}

function formatToolTarget(title: string | undefined): string {
  if (!title) return "";
  const cleaned = title.replace(/\(text\/html.*$/i, "").replace(/Success\. Updated the following files:\s*/i, "Success. Updated the following files: ").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function formatDuration(ms: number): string {
  return `约 ${Math.max(1, Math.round(ms / 1000))}s`;
}

function formatSessionTimestamp(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "--";
  }

  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function findSessionMeta(window: SessionWindowRecord, sessionId: string): SessionBindingRecord | null {
  return window.sessions.find((session) => session.sessionId === sessionId) ?? null;
}

function isFinalStatus(status: string): boolean {
  return status.includes("完成") || status.includes("失败") || status.includes("超时") || status.includes("中止");
}

function upsertToolUpdate(updates: Array<{ key: string; view: ToolUpdateView }>, key: string, view: ToolUpdateView): Array<{ key: string; view: ToolUpdateView }> {
  const existingIndex = updates.findIndex((item) => item.key === key);
  if (existingIndex === -1) return [...updates, { key, view }].slice(-8);
  return updates.map((item, index) => (index === existingIndex ? { key, view } : item));
}

function parseToolUpdate(text: string): ToolUpdateView {
  const match = text.match(/^(.*?)[：:](.*?)[（(]([^）)]+)[）)]$/);
  if (!match) return { label: text, detail: "", status: "unknown" };
  const [, label, detail, statusLabel] = match;
  return { label: (label ?? text).trim(), detail: (detail ?? "").trim(), status: parseToolStatus((statusLabel ?? "").trim()) };
}

function parseToolStatus(statusLabel: string): ToolUpdateView["status"] {
  switch (statusLabel) {
    case "等待中": return "pending";
    case "执行中": return "running";
    case "已完成": return "completed";
    case "失败": return "error";
    default: return "unknown";
  }
}

function parseOutput(finalReply: string): OutputView {
  const paths = extractPaths(finalReply);
  const commands = extractCommands(finalReply);
  const text = stripStructuredLines(finalReply, paths, commands);
  return { text, paths, commands };
}

function extractPaths(text: string): string[] {
  return dedupe((text.match(/[A-Za-z]:\\[^\n`]+/g) ?? []).map((item) => item.trim()));
}

function extractCommands(text: string): string[] {
  const commandMatches = Array.from(text.matchAll(/`([^`]+)`/g), (match) => match[1] ?? "");
  return dedupe(commandMatches.map((item) => item.trim()).filter((item) => /^(npm|pnpm|yarn|node|python|python3|git|bash|powershell|pwsh|cmd|npx)\b/i.test(item)));
}

function stripStructuredLines(text: string, paths: string[], commands: string[]): string {
  let result = text;
  for (const path of paths) result = result.replace(path, "");
  for (const command of commands) result = result.replace(`\`${command}\``, "");
  return result.split("\n").map((line) => line.trimEnd()).filter((line, index, lines) => line.trim() !== "" || (index > 0 && lines[index - 1]?.trim() !== "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function appendProgressUpdate(updates: string[], nextUpdate: string): string[] {
  if (!nextUpdate || updates.includes(nextUpdate)) return updates;
  return [...updates, nextUpdate].slice(-6);
}

function buildSessionRangeIndices(range: { start: number; end: number }): number[] {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  if (start < 1 || end < 1) {
    return [];
  }

  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
