import crypto from "node:crypto";

import { QueueRegistry } from "../bridge/queue.js";
import { type PendingInteraction, type PendingPermissionInteraction, type PendingQuestionInteraction, type PendingSessionSelectionInteraction } from "../bridge/state.js";
import { routeIncomingText, type RoutedText } from "../bridge/router.js";
import { transitionTurn } from "../bridge/state-machine.js";
import { TurnWatchdog } from "../bridge/watchdog.js";
import type { BridgeTurn } from "../bridge/turn.js";
import {
  buildPostMarkdownPayload,
  buildQueueNoticePayload,
  buildTurnStatusCardPayload,
  type FeishuPostPayload,
  type OutputView,
  type ToolUpdateView,
  type TurnStatusCardView,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import {
  OpenCodeClient,
  type OpenCodeMessage,
  type OpenCodeProvidersResponse,
  type OpenCodeSession,
  type OpenCodeSessionStatus,
} from "../opencode/client.js";
import { getEventSessionId, OpenCodeEventStream, type OpenCodeEvent } from "../opencode/events.js";
import { MappingStore, type MappingRecord, type SessionBindingRecord, type SessionMode, type SessionWindowRecord } from "../store/mappings.js";
import type { ChatWhitelist } from "../store/whitelist.js";
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

const initialCardSummary = "已创建会话，等待 OpenCode 事件...";
const FIRST_SSE_FALLBACK_MS = 5_000;
const STREAM_FLUSH_MIN_CHARS = 120;
const STREAM_FLUSH_INTERVAL_MS = 750;
const PERMISSION_TTL_MS = 120_000;
const SESSION_SELECTION_TTL_MS = 30_000;
const NOOP_WHITELIST: ChatWhitelist = {
  isBound: () => false,
  bind: async () => {},
  unbind: async () => false,
  count: () => 0,
};

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
  private globalEventUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly outbound: OutboundPort,
    private readonly logger: Logger,
    private readonly whitelist: ChatWhitelist = NOOP_WHITELIST,
  ) {
    this.queues = new QueueRegistry(config.bridge.queueLimit, logger);
    this.mappings = new MappingStore(config.storage.dataDir, config.storage.mappingsFile, 200, logger);
    this.opencode = new OpenCodeClient(config.opencode.baseUrl);
    this.eventStream = new OpenCodeEventStream(config.opencode.baseUrl, logger);
  }

  async start(): Promise<void> {
    this.sessionMap = await this.mappings.load();
    const health = await this.opencode.health();
    const project = await this.opencode.getCurrentProject();
    if (project.worktree !== this.config.opencode.directory) {
      throw new Error(`opencode serve 当前在 ${project.worktree}，bridge 配置的是 ${this.config.opencode.directory}，请在正确目录重启 opencode serve`);
    }
    await this.syncStoredSessionLabels();

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
    await this.eventStream.stop();
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
          });
          watchdog.markEvent();
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
      const systemPrompt = this.config.bridge.injectSystemState
        ? buildBridgeSystemPrompt(turn, this.getSessionWindow(turn.conversationKey, turn.chatType))
        : undefined;
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
      this.setPendingInteraction(turn.conversationKey, {
        kind: "permission",
        chatId: turn.chatId,
        replyToMessageId: turn.inboundMessageId,
        sessionId: turn.sessionId,
        permissionId,
        permissionName,
        turnId: turn.turnId,
        expiresAt: Date.now() + PERMISSION_TTL_MS,
      });
      await this.updateTurnCard(turn.turnId, {
        status: "等待确认",
        update: `请求权限：${permissionName}，请回复 /allow once、/allow always 或 /deny`,
        target: "step",
      });
      await this.sendPayload(turn.chatId, buildPostMarkdownPayload(`OpenCode 请求权限 \`${escapeMarkdownText(permissionName)}\`，请回复 \`/allow once\`、\`/allow always\` 或 \`/deny\`。`), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: `权限请求：${permissionName}`,
        len: permissionName.length + 16,
      }, { replyToMessageId: turn.inboundMessageId });
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
      const entry = await this.createAndBindSession(message);
      await this.sendMarkdown(message.chatId, `已创建并切换到新会话 \`${entry.sessionId}\`。`, message.messageId);
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
      const statusText = [
        `事件流状态：${this.eventStream.getConnectionState()}`,
        `会话模式：${window.mode}`,
        `当前会话：${currentSession ? `${escapeMarkdownText(currentSession.label)} \`${currentSession.sessionId}\`` : "未绑定"}`,
        `Session 状态：${status}`,
        `队列状态：${active ? `处理中 ${createTextPreview(active.text)}` : "空闲"}`,
        `排队数量：${queue.pendingCount()}`,
        `窗口会话数：${window.sessions.length}`,
      ].join("\n");
      await this.sendMarkdown(message.chatId, statusText, message.messageId);
      return;
    }

    if (command.kind === "abort") {
      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      if (currentSession) {
        await this.opencode.abort(currentSession.sessionId);
      }
      await this.sendMarkdown(message.chatId, "已请求中止当前任务。", message.messageId);
      return;
    }

    if (command.kind === "models") {
      const providers = await this.opencode.listProviders();
      await this.sendMarkdown(message.chatId, formatProviders(providers), message.messageId);
      return;
    }

    if (command.kind === "leave") {
      if (!supportsGroupWhitelistCommands(message.chatType)) {
        await this.sendMarkdown(message.chatId, "该命令仅支持群聊使用。", message.messageId);
        return;
      }

      const removed = await this.whitelist.unbind(message.chatId, message.senderOpenId);
      await this.sendMarkdown(
        message.chatId,
        removed ? "已解除绑定，后续消息不再响应。" : "当前群里你尚未绑定，无需解除。",
        message.messageId,
      );
      return;
    }

    if (command.kind === "who") {
      if (!supportsGroupWhitelistCommands(message.chatType)) {
        await this.sendMarkdown(message.chatId, "该命令仅支持群聊使用。", message.messageId);
        return;
      }

      const count = this.whitelist.count(message.chatId);
      const isBound = this.whitelist.isBound(message.chatId, message.senderOpenId);
      await this.sendMarkdown(
        message.chatId,
        isBound
          ? `当前群已绑定 ${count} 人，你已绑定 ✓`
          : `当前群已绑定 ${count} 人，你未绑定（发送任意消息并 @ bot 即可绑定）`,
        message.messageId,
      );
      return;
    }

    if (command.kind === "sessions") {
      const window = this.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      if (window.mode === "single") {
        const text = currentSession
          ? formatSingleSessionStatus(window.mode, currentSession)
          : "当前窗口为单会话模式，暂未绑定会话。";
        await this.sendMarkdown(message.chatId, text, message.messageId);
        return;
      }

      const visibleSessions = getVisibleSessions(window).slice(0, this.config.bridge.sessionListLimit);
      if (visibleSessions.length === 0) {
        await this.sendMarkdown(message.chatId, "当前窗口暂无可切换的会话。", message.messageId);
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
      await this.sendMarkdown(message.chatId, formatSessionList(options), message.messageId);
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

      let nextWindow = setActiveSession(window, match.sessionId, Date.now(), this.config.bridge.maxSessionsPerWindow);
      const sessionMeta = openCodeSessions.get(match.sessionId);
      const fallbackLabel = resolveDisplayLabel(sessionMeta, match.title, match.sessionId);
      nextWindow = updateSessionLabel(nextWindow, match.sessionId, fallbackLabel, this.config.bridge.maxSessionsPerWindow);
      await this.saveSessionWindow(message.conversationKey, nextWindow);
      this.clearPendingInteraction(message.conversationKey, false);
      await this.sendMarkdown(message.chatId, `已切换到会话 ${escapeMarkdownText(fallbackLabel)} \`${match.sessionId}\`。`, message.messageId);
      return;
    }

    if (command.kind === "allow" || command.kind === "deny") {
      const pending = this.pendingInteractions.get(message.conversationKey);
      if (!pending || pending.kind !== "permission") {
        await this.sendMarkdown(message.chatId, "当前没有待确认的权限请求。", message.messageId);
        return;
      }

      const response = command.kind === "deny" ? "reject" : command.policy;
      const remember = command.kind === "allow" && command.policy === "always";
      await this.opencode.replyPermission(pending.sessionId, pending.permissionId, response, remember);
      this.clearPendingInteraction(message.conversationKey, false);
      await this.updateTurnCard(pending.turnId, { status: "处理中", update: `已处理权限请求：${pending.permissionName}`, target: "step" });
      await this.sendMarkdown(message.chatId, command.kind === "deny" ? "已拒绝权限请求。" : "已确认权限请求。", message.messageId);
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
      await this.sendMarkdown(message.chatId, "当前有待确认的权限请求，请先回复 `/allow once`、`/allow always` 或 `/deny`。", message.messageId);
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

    try {
      await this.opencode.replyPermission(current.sessionId, current.permissionId, "reject", false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("bridge/permission", "auto deny failed", { chatId: current.chatId, conversationKey, permissionId: current.permissionId, detail }, "warn");
    } finally {
      this.clearPendingInteraction(conversationKey, false);
    }

    await this.updateTurnCard(current.turnId, { status: "处理中", update: "权限请求已超时，已默认拒绝", target: "step" });
    await this.sendMarkdown(current.chatId, "权限请求已超时，已默认拒绝。", current.replyToMessageId);
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

function formatProviders(providers: OpenCodeProvidersResponse): string {
  const lines = ["可用模型提供方："];
  const defaults = providers.default;
  for (const provider of providers.providers) {
    const id = typeof provider.id === "string" ? provider.id : typeof provider.providerID === "string" ? provider.providerID : "unknown";
    const name = typeof provider.name === "string" ? provider.name : id;
    const model = defaults[id];
    lines.push(`- ${name}${model ? `：默认 \`${model}\`` : ""}`);
  }
  if (lines.length === 1) {
    lines.push("- 当前没有 provider 信息");
  }
  return lines.join("\n");
}

function formatSessionList(options: PendingSessionSelectionInteraction["options"]): string {
  return [
    "当前窗口会话：",
    ...options.map((option) => `${option.index}. ${escapeMarkdownText(option.title)}${option.current ? " ← 当前" : ""}\n   \`${option.sessionId}\``),
    "",
    "30 秒内可用 `/switch <编号>` 或 `/sessions <编号>` 切换。",
  ].join("\n");
}

function formatSingleSessionStatus(mode: SessionMode, session: SessionBindingRecord): string {
  return [
    `当前窗口为${mode}会话模式。`,
    `当前会话：${escapeMarkdownText(session.label)}`,
    `Session ID：\`${session.sessionId}\``,
  ].join("\n");
}

function supportsGroupWhitelistCommands(chatType: string): boolean {
  return chatType === "group" || chatType === "topic_group";
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
