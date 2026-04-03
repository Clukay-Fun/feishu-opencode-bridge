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
import { MappingStore, type MappingRecord } from "../store/mappings.js";
import type { AppConfig } from "../config/schema.js";
import { cleanAssistantReply } from "./sanitize.js";

export type IncomingChatMessage = {
  chatId: string;
  senderOpenId: string;
  messageId: string;
  text: string;
};

type OutboundPort = {
  sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
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

  constructor(private readonly config: AppConfig, private readonly outbound: OutboundPort, private readonly logger: Logger) {
    this.queues = new QueueRegistry(config.bridge.queueLimit, logger);
    this.mappings = new MappingStore(config.storage.dataDir, config.storage.mappingsFile);
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
      });
      return;
    }

    this.logger.logTranscript("inbound", {
      chatId: message.chatId,
      senderId: message.senderOpenId,
      messageId: message.messageId,
    }, message.text);

    const routed = routeIncomingText(message.text);
    if (routed.kind === "command") {
      await this.handleCommand(message.chatId, routed);
      return;
    }

    const pending = this.pendingInteractions.get(message.chatId);
    if (pending) {
      const consumed = await this.handlePendingInteraction(message.chatId, pending, message.text);
      if (consumed) return;
    }

    if (!await this.ensureServerAvailableForChat(message.chatId)) {
      return;
    }

    const queue = this.queues.get(message.chatId);
    const existingSession = this.sessionMap[message.chatId];
    const turn: BridgeTurn = {
      turnId: crypto.randomUUID(),
      chatId: message.chatId,
      senderOpenId: message.senderOpenId,
      inboundMessageId: message.messageId,
      text: message.text,
    };
    if (existingSession?.sessionId) {
      turn.sessionId = existingSession.sessionId;
    }

    const result = queue.enqueue(turn);
    if (!result.accepted) {
      await this.sendPayload(message.chatId, buildQueueNoticePayload(result.notice ?? { message: "当前不可用。" }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: result.notice?.message ?? "当前不可用。",
        len: (result.notice?.message ?? "当前不可用。").length,
      });
      return;
    }

    if (result.notice) {
      await this.sendPayload(message.chatId, buildQueueNoticePayload(result.notice), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.notice.message),
        len: result.notice.message.length,
      });
      return;
    }

    if (!this.runningChats.has(message.chatId)) {
      const runner = this.processChat(message.chatId).finally(() => {
        this.runningChats.delete(message.chatId);
      });
      this.runningChats.set(message.chatId, runner);
      await runner;
    }
  }

  private async processChat(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    while (queue.current()) {
      await this.runTurn(chatId);
      queue.finishActive();
    }
  }

  private async runTurn(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    const active = queue.peek();
    if (!active) return;

    let turn = transitionTurn(active, "running");
    queue.replaceActive(turn);

    try {
      const sessionId = turn.sessionId ?? await this.ensureSession(chatId);
      turn = { ...turn, sessionId };
      queue.replaceActive(turn);
      this.logger.log("bridge/queue", "turn started", { turnId: turn.turnId, sessionId, chatId });

      const card = await this.createTurnCard(chatId, turn.turnId, sessionId);
      if (card) {
        queue.replaceActive({ ...turn, processMessageId: card.messageId });
      }

      const reply = cleanAssistantReply(await this.executeTurn(chatId, turn as BridgeTurn & { sessionId: string }));
      this.logger.log("opencode/events", "reply completed", { turnId: turn.turnId, sessionId, len: reply.length });
      this.logger.logTranscript("opencode-reply", { sessionId, turnId: turn.turnId }, reply);
      await this.flushStreamUpdate(turn.turnId, reply, true);
      await this.updateTurnCard(turn.turnId, { status: "已完成", update: `最终回复已生成（${reply.length} 字）`, target: "step" });
      queue.replaceActive(transitionTurn({ ...turn, sessionId }, "done"));
      this.logger.log("bridge/queue", "turn completed", { turnId: turn.turnId, duration: Date.now() - (turn.startedAt ?? Date.now()) });
    } catch (error) {
      const detail = cleanAssistantReply(error instanceof Error ? error.message : String(error));
      this.logger.log("bridge/queue", "run turn failed", { chatId, turnId: turn.turnId, detail }, "error");
      await this.updateTurnCard(turn.turnId, { status: detail.includes("超时") ? "已超时" : "处理失败", update: detail, target: "step" });
      queue.replaceActive(transitionTurn(turn, detail.includes("超时") ? "timeout" : "aborted"));
    } finally {
      this.turnCards.delete(turn.turnId);
      this.clearPendingInteraction(chatId, false);
      this.clearStreamFlushState(turn.turnId);
    }
  }

  private async executeTurn(chatId: string, turn: BridgeTurn & { sessionId: string }): Promise<string> {
    const baselineAssistant = await this.getLatestAssistantMessage(turn.sessionId);
    const baselineAssistantId = baselineAssistant?.info.id ?? null;
    const queue = this.queues.get(chatId);

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
          const text = await this.finalizeAssistantReply(turn.sessionId, finalText, baselineAssistantId);
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
          await this.handleEvent(chatId, turn, event, {
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
          this.logger.log("opencode/events", "event listener failed", { chatId, sessionId: turn.sessionId, detail, type: event.type }, "warn");
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
      void this.opencode.promptAsync(turn.sessionId, buildPromptRequest(turn.text))
        .then(() => {
          queue.replaceActive(transitionTurn(turn, "awaiting-sse"));
          void this.updateTurnCard(turn.turnId, { status: "处理中", update: "请求已发送，等待事件流...", target: "step" });
          fallbackTimer = setTimeout(() => {
            if (!seenSessionEvent) {
              void this.runFirstSseFallback(turn.sessionId, baselineAssistantId, {
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
    chatId: string,
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
      this.setPendingInteraction(chatId, {
        kind: "permission",
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
      await this.sendPayload(chatId, buildPostMarkdownPayload(`OpenCode 请求权限 \`${escapeMarkdownText(permissionName)}\`，请回复 \`/allow once\`、\`/allow always\` 或 \`/deny\`。`), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: `权限请求：${permissionName}`,
        len: permissionName.length + 16,
      });
      return;
    }

    if (event.type === "question.asked") {
      const request = toQuestionRequest(event.properties, turn.sessionId);
      if (!request) return;
      this.setPendingInteraction(chatId, {
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

  private async handleCommand(chatId: string, routed: Extract<RoutedText, { kind: "command" }>): Promise<void> {
    const { command } = routed;
    if (command.kind === "new") {
      const session = await this.opencode.createSession(`Feishu ${chatId}`);
      await this.bindSession(chatId, session.id);
      await this.sendMarkdown(chatId, "已创建并绑定新会话，下一条消息将继续在这个 session 中处理。");
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

      const queue = this.queues.get(chatId);
      const active = queue.peek();
      const binding = this.sessionMap[chatId];
      const status = binding ? this.sessionStatuses.get(binding.sessionId)?.type ?? "unknown" : "unbound";
      const message = [
        `事件流状态：${this.eventStream.getConnectionState()}`,
        `当前会话：${binding ? `\`${binding.sessionId}\`` : "未绑定"}`,
        `Session 状态：${status}`,
        `队列状态：${active ? `处理中 ${createTextPreview(active.text)}` : "空闲"}`,
        `排队数量：${queue.pendingCount()}`,
      ].join("\n");
      await this.sendMarkdown(chatId, message);
      return;
    }

    if (command.kind === "abort") {
      const binding = this.sessionMap[chatId];
      if (binding) {
        await this.opencode.abort(binding.sessionId);
      }
      await this.sendMarkdown(chatId, "已请求中止当前任务。");
      return;
    }

    if (command.kind === "models") {
      const providers = await this.opencode.listProviders();
      await this.sendMarkdown(chatId, formatProviders(providers));
      return;
    }

    if (command.kind === "sessions") {
      const sessions = [...await this.opencode.listSessions()]
        .sort((a, b) => getSessionUpdatedAt(b) - getSessionUpdatedAt(a))
        .slice(0, 10);
      if (sessions.length === 0) {
        await this.sendMarkdown(chatId, "当前没有可切换的会话。");
        return;
      }

      const options = sessions.map((session, index) => ({
        index: index + 1,
        sessionId: session.id,
        title: session.title?.trim() || session.slug || session.id,
      }));
      this.setPendingInteraction(chatId, {
        kind: "session-select",
        options,
        expiresAt: Date.now() + SESSION_SELECTION_TTL_MS,
      });
      await this.sendMarkdown(chatId, formatSessionList(options));
      return;
    }

    if (command.kind === "sessions-select") {
      const pending = this.pendingInteractions.get(chatId);
      if (!pending || pending.kind !== "session-select" || pending.expiresAt <= Date.now()) {
        this.clearPendingInteraction(chatId, false);
        await this.sendMarkdown(chatId, "会话列表已过期，请先重新执行 `/sessions`。");
        return;
      }

      const match = pending.options.find((option) => option.index === command.index);
      if (!match) {
        await this.sendMarkdown(chatId, "无效的会话编号，请重新执行 `/sessions` 查看列表。");
        return;
      }

      await this.bindSession(chatId, match.sessionId);
      this.clearPendingInteraction(chatId, false);
      await this.sendMarkdown(chatId, `已切换到会话 \`${match.sessionId}\`。`);
      return;
    }

    if (command.kind === "allow" || command.kind === "deny") {
      const pending = this.pendingInteractions.get(chatId);
      if (!pending || pending.kind !== "permission") {
        await this.sendMarkdown(chatId, "当前没有待确认的权限请求。");
        return;
      }

      const response = command.kind === "deny" ? "reject" : command.policy;
      const remember = command.kind === "allow" && command.policy === "always";
      await this.opencode.replyPermission(pending.sessionId, pending.permissionId, response, remember);
      this.clearPendingInteraction(chatId, false);
      await this.updateTurnCard(pending.turnId, { status: "处理中", update: `已处理权限请求：${pending.permissionName}`, target: "step" });
      await this.sendMarkdown(chatId, command.kind === "deny" ? "已拒绝权限请求。" : "已确认权限请求。");
      return;
    }

    const sessionId = await this.ensureSession(chatId);
    const result = await this.opencode.runCommand(sessionId, {
      command: command.name,
      arguments: command.arguments,
    });
    const text = extractAssistantText(result) || "命令已执行。";
    await this.sendMarkdown(chatId, text);
  }

  private async handlePendingInteraction(chatId: string, pending: PendingInteraction, text: string): Promise<boolean> {
    if (pending.kind === "question") {
      try {
        await this.opencode.replyQuestion(pending.requestId, [text]);
        this.clearPendingInteraction(chatId, false);
        const currentTurnId = this.queues.get(chatId).peek()?.turnId;
        if (currentTurnId) {
          await this.updateTurnCard(currentTurnId, { status: "处理中", update: "已收到你的回答，继续处理中...", target: "step" });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.sendMarkdown(chatId, `回答问题失败：${escapeMarkdownText(detail)}`);
      }
      return true;
    }

    if (pending.kind === "permission") {
      await this.sendMarkdown(chatId, "当前有待确认的权限请求，请先回复 `/allow once`、`/allow always` 或 `/deny`。");
      return true;
    }

    return false;
  }

  private async ensureSession(chatId: string): Promise<string> {
    const existing = this.sessionMap[chatId];
    if (existing) {
      await this.touchSession(chatId, existing.sessionId);
      return existing.sessionId;
    }

    const session = await this.opencode.createSession(`Feishu ${chatId}`);
    await this.bindSession(chatId, session.id);
    return session.id;
  }

  private async bindSession(chatId: string, sessionId: string): Promise<void> {
    this.sessionMap[chatId] = {
      sessionId,
      lastUsedAt: Date.now(),
    };
    await this.mappings.save(this.sessionMap);
  }

  private async touchSession(chatId: string, sessionId: string): Promise<void> {
    this.sessionMap[chatId] = {
      sessionId,
      lastUsedAt: Date.now(),
    };
    await this.mappings.save(this.sessionMap);
  }

  private async ensureServerAvailableForChat(chatId: string): Promise<boolean> {
    if (this.eventStream.getConnectionState() === "connected") {
      return true;
    }

    try {
      await this.opencode.health();
      return true;
    } catch {
      await this.sendMarkdown(chatId, "OpenCode 服务不可用，请先确认 `opencode serve` 正在运行。");
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
    baselineAssistantId: string | null,
    handlers: {
      updateText: (text: string) => Promise<void>;
      finish: () => Promise<void>;
      fail: (error: Error) => void;
    },
  ): Promise<void> {
    try {
      const latestAssistant = await this.getLatestAssistantMessage(sessionId, baselineAssistantId);
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

  private async finalizeAssistantReply(sessionId: string, currentText: string, baselineAssistantId: string | null): Promise<string> {
    const normalizedCurrent = cleanAssistantReply(currentText);
    if (normalizedCurrent) {
      return normalizedCurrent;
    }

    const latestAssistant = await this.getLatestAssistantMessage(sessionId, baselineAssistantId);
    const text = cleanAssistantReply(extractAssistantText(latestAssistant));
    if (!text) {
      throw new Error("OpenCode 未返回文本回复。");
    }
    return text;
  }

  private async getLatestAssistantMessage(sessionId: string, baselineAssistantId?: string | null): Promise<OpenCodeMessage | null> {
    const messages = await this.opencode.getSessionMessages(sessionId, 50);
    const baselineIndex = baselineAssistantId
      ? messages.findIndex((message) => message.info.id === baselineAssistantId)
      : -1;
    const tail = baselineIndex >= 0 ? messages.slice(baselineIndex + 1) : messages;
    return [...tail].reverse().find((message) => message.info.role === "assistant") ?? null;
  }

  private setPendingInteraction(chatId: string, interaction: PendingInteraction): void {
    this.clearPendingInteraction(chatId, false);
    this.pendingInteractions.set(chatId, interaction);

    if (interaction.kind === "permission") {
      const timer = setTimeout(() => {
        void this.handlePermissionTimeout(chatId, interaction);
      }, Math.max(0, interaction.expiresAt - Date.now()));
      this.pendingInteractionTimers.set(chatId, timer);
      return;
    }

    if (interaction.kind === "session-select") {
      const timer = setTimeout(() => {
        this.clearPendingInteraction(chatId, false);
      }, Math.max(0, interaction.expiresAt - Date.now()));
      this.pendingInteractionTimers.set(chatId, timer);
    }
  }

  private clearPendingInteraction(chatId: string, keepNonExpiring: boolean): void {
    const timeout = this.pendingInteractionTimers.get(chatId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingInteractionTimers.delete(chatId);
    }

    if (keepNonExpiring) {
      const current = this.pendingInteractions.get(chatId);
      if (current?.kind === "question") {
        return;
      }
    }

    this.pendingInteractions.delete(chatId);
  }

  private async handlePermissionTimeout(chatId: string, pending: PendingPermissionInteraction): Promise<void> {
    const current = this.pendingInteractions.get(chatId);
    if (!current || current.kind !== "permission" || current.permissionId !== pending.permissionId) {
      return;
    }

    try {
      await this.opencode.replyPermission(current.sessionId, current.permissionId, "reject", false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("bridge/permission", "auto deny failed", { chatId, permissionId: current.permissionId, detail }, "warn");
    } finally {
      this.clearPendingInteraction(chatId, false);
    }

    await this.updateTurnCard(current.turnId, { status: "处理中", update: "权限请求已超时，已默认拒绝", target: "step" });
    await this.sendMarkdown(chatId, "权限请求已超时，已默认拒绝。");
  }

  private async createTurnCard(chatId: string, turnId: string, sessionId: string): Promise<TurnCardState | null> {
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
      });
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

  private async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    await this.sendPayload(chatId, buildPostMarkdownPayload(markdown), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(markdown),
      len: markdown.length,
    });
  }

  private async sendPayload(chatId: string, payload: FeishuPostPayload, options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number }): Promise<{ messageId: string }> {
    const result = await this.outbound.sendMessage(chatId, payload);
    this.logger.log("feishu/reply", options.event, { chatId, messageId: result.messageId, textPreview: options.textPreview, len: options.len });
    this.logger.logTranscript(options.transcriptType, { chatId, messageId: result.messageId }, prettyPrintPayload(payload));
    return result;
  }
}

function buildPromptRequest(text: string): { parts: Array<{ type: "text"; text: string }> } {
  return {
    parts: [{ type: "text", text }],
  };
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
    "最近会话：",
    ...options.map((option) => `${option.index}. ${escapeMarkdownText(option.title)}\n   \`${option.sessionId}\``),
    "",
    "30 秒内可用 `/sessions <编号>` 切换。",
  ].join("\n");
}

function getSessionUpdatedAt(session: OpenCodeSession): number {
  return session.time?.updated ?? session.time?.created ?? 0;
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
