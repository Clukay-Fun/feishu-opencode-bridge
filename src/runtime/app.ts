import { QueueRegistry } from "../bridge/queue.js";
import { type PendingInteraction, type PendingPermissionInteraction } from "../bridge/state.js";
import { routeIncomingText, type RoutedText } from "../bridge/router.js";
import type { BridgeTurn } from "../bridge/turn.js";
import {
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  buildQueueNoticePayload,
  type FeishuPostPayload,
  type ToolUpdateView,
  toInteractiveCardContent,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import { detectKnowledgeWebIngest, detectLegalQuestion } from "../knowledge/detector.js";
import {
  KnowledgeBaseService,
  type KnowledgeBasePort,
  type KnowledgeIngestProgressStep,
  type KnowledgeIngestProgressUpdate,
} from "../knowledge/index.js";
import { MemoryService } from "../memory/index.js";
import {
  OpenCodeClient,
  type OpenCodeSession,
  type OpenCodeSessionStatus,
} from "../opencode/client.js";
import { getEventSessionId, OpenCodeEventStream, type OpenCodeEvent } from "../opencode/events.js";
import { MappingStore, type MappingRecord, type SessionBindingRecord, type SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import type { AppConfig } from "../config/schema.js";
import {
  buildSessionRangeIndices,
  buildSessionTitle,
  prettyPrintPayload,
  readOptionalRecord,
  resolveDisplayLabel,
  shouldHydrateLabelFromSessionMeta,
  summarizeSessionLabel,
  escapeMarkdownText,
  toOpencodePromptText,
} from "./app-helpers.js";
import { PermissionManager } from "./permission-manager.js";
import { CommandHandler } from "./command-handler.js";
import { TurnCardManager } from "./turn-card-manager.js";
import { TurnExecutor } from "./turn-executor.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
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

type IncomingChatMessageBase = {
  chatId: string;
  chatType: string;
  senderOpenId: string;
  messageId: string;
  rawContent: string;
  plainText: string;
  rootId?: string | undefined;
  parentId?: string | undefined;
  threadKey: string;
  conversationKey: string;
};

export type IncomingTextMessage = IncomingChatMessageBase & {
  messageType: "text" | "post";
};

export type IncomingFileMessage = IncomingChatMessageBase & {
  messageType: "file";
  file: {
    fileKey: string;
    fileName: string;
    size?: number | undefined;
  };
};

export type IncomingChatMessage = IncomingTextMessage | IncomingFileMessage;

type OutboundPort = {
  sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
};

type KnowledgeResourcePort = {
  downloadMessageResource(messageId: string, fileKey: string, type: "file"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
  listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
};

type BridgeAppDeps = {
  opencode?: OpenCodePort;
  eventStream?: OpenCodeEventStreamPort;
  memory?: MemoryService | null;
  knowledge?: KnowledgeBasePort | null;
};

type OpenCodePort = Pick<OpenCodeClient,
    | "health"
    | "getCurrentProject"
    | "createSession"
    | "listSessions"
    | "deleteSession"
    | "getSessionStatuses"
    | "getSessionMessages"
    | "promptAsync"
    | "abort"
    | "listProviders"
    | "runCommand"
    | "replyPermission"
    | "replyQuestion"
    | "postMessageSync"
  >;

type OpenCodeEventStreamPort = Pick<OpenCodeEventStream, "start" | "stop" | "subscribe" | "getConnectionState">;

export type PermissionCardActionValue = {
  kind: "permission";
  conversationKey: string;
  turnId: string;
  sessionId: string;
  permissionId: string;
  policy: "once" | "always" | "deny";
  nonce: string;
};

export class BridgeApp {
  private readonly queues: QueueRegistry;
  private readonly mappings: MappingStore;
  private readonly opencode: OpenCodePort;
  private readonly eventStream: OpenCodeEventStreamPort;
  private readonly permissionManager: PermissionManager;
  private readonly turnCardManager: TurnCardManager;
  private readonly turnExecutor: TurnExecutor;
  private readonly rateLimiter = new SlidingWindowRateLimiter(20, 60_000);
  private sessionMap: MappingRecord = {};
  private readonly runningChats = new Map<string, Promise<void>>();
  private readonly runningKnowledgeIngests = new Map<string, { requesterOpenId: string }>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly pendingInteractionTimers = new Map<string, NodeJS.Timeout>();
  private readonly sessionStatuses = new Map<string, OpenCodeSessionStatus>();
  private readonly memory: MemoryService | null;
  private readonly knowledge: KnowledgeBasePort | null;
  private globalEventUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly outbound: OutboundPort,
    private readonly logger: Logger,
    private readonly whitelist: Pick<WhitelistStore, "bind" | "count" | "isBound" | "unbind">,
    deps?: BridgeAppDeps,
  ) {
    this.queues = new QueueRegistry(config.bridge.queueLimit, logger);
    this.mappings = new MappingStore(config.storage.dataDir, config.storage.mappingsFile, 200, logger);
    this.opencode = deps?.opencode ?? new OpenCodeClient(config.opencode.baseUrl);
    this.eventStream = deps?.eventStream ?? new OpenCodeEventStream(config.opencode.baseUrl, logger);
    this.memory = deps && "memory" in deps
      ? (deps.memory ?? null)
      : config.memory.enabled
        ? new MemoryService(
          config.memory,
          config.embeddings ?? { provider: undefined, similarityThreshold: 0.75 },
          this.opencode as OpenCodeClient,
          logger,
        )
        : null;
    this.knowledge = deps && "knowledge" in deps
      ? (deps.knowledge ?? null)
      : config.knowledgeBase.enabled
        ? new KnowledgeBaseService(
          config.knowledgeBase,
          this.outbound as OutboundPort & KnowledgeResourcePort,
          this.opencode as OpenCodeClient,
          logger,
        )
        : null;
    this.permissionManager = new PermissionManager({
      replyPermission: async (sessionId, permissionId, policy, remember) => {
        return await this.opencode.replyPermission(sessionId, permissionId, policy, remember);
      },
    }, this.logger, {
      clearPendingInteraction: (conversationKey, keepNonExpiring) => {
        this.clearPendingInteraction(conversationKey, keepNonExpiring);
      },
      updateTurnCard: async (turnId, update) => {
        await this.turnCardManager.updateTurnCard(turnId, update);
      },
      sendPayload: async (chatId, payload, options, delivery) => {
        return await this.sendPayload(chatId, payload, options, delivery);
      },
      toCardContent: (payload) => this.toCardContent(payload),
    });
    this.turnCardManager = new TurnCardManager(this.outbound, this.logger, this.config.feishu.behavior.replyInThread);
    this.turnExecutor = new TurnExecutor({
      config: this.config,
      logger: this.logger,
      queues: this.queues,
      opencode: this.opencode,
      eventStream: this.eventStream,
      sessionStatuses: this.sessionStatuses,
      turnCardManager: this.turnCardManager,
      permissionManager: this.permissionManager,
      memory: this.memory,
      getSessionWindow: (conversationKey, chatType) => this.getSessionWindow(conversationKey, chatType),
      ensureSession: async (source) => await this.ensureSession(source),
      maybeUpdateSessionLabel: async (turn) => await this.maybeUpdateSessionLabel(turn),
      clearPendingInteraction: (conversationKey, keepNonExpiring) => this.clearPendingInteraction(conversationKey, keepNonExpiring),
      clearTurnOwnedPendingInteraction: (conversationKey, turnId) => this.clearTurnOwnedPendingInteraction(conversationKey, turnId),
      setPendingInteraction: (conversationKey, interaction) => this.setPendingInteraction(conversationKey, interaction),
      sendPayload: async (chatId, payload, options, delivery) => await this.sendPayload(chatId, payload, options, delivery),
    });
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
    if (this.knowledge) {
      try {
        await this.knowledge.syncMirror();
      } catch (error) {
        this.logger.log("knowledge/sync", "mirror sync skipped", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      }
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
    this.pendingInteractionTimers.clear();
    this.turnCardManager.stop();
    await this.memory?.stop();
    this.knowledge?.close();
    await this.eventStream.stop();
  }

  async handlePermissionCardAction(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.permissionManager.handleCardAction(actorOpenId, openMessageId, value);
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

    if (!this.rateLimiter.allow(message.senderOpenId)) {
      await this.sendPayload(message.chatId, buildPostMarkdownPayload("请求过于频繁，请稍后再试。"), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "请求过于频繁，请稍后再试。",
        len: 14,
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

    const routed = message.messageType === "file"
      ? null
      : routeIncomingText(message.plainText);
    if (routed?.kind === "command") {
      await this.handleCommand(message, routed);
      return;
    }

    const runningKnowledgeIngest = this.runningKnowledgeIngests.get(message.conversationKey);
    if (runningKnowledgeIngest) {
      await this.sendKnowledgeIngestBusyNotice(message);
      return;
    }

    const pending = this.pendingInteractions.get(message.conversationKey);
    if (pending) {
      const consumed = await this.handlePendingInteraction(message, pending);
      if (consumed) return;
    }

    if (message.messageType === "file") {
      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "提醒",
        template: "yellow",
        iconToken: "maybe_outlined",
        message: "当前仅支持通过 `/kb-ingest-start` 接收文件，请先进入知识入库模式后再上传 PDF / DOCX / TXT。",
        messageIconToken: "maybe_outlined",
        messageIconColor: "yellow",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "当前仅支持通过 /kb-ingest-start 接收文件。",
        len: 29,
      }, { replyToMessageId: message.messageId });
      return;
    }

    const window = this.getSessionWindow(message.conversationKey, message.chatType);
    if (this.knowledge && window.interactionMode === "knowledge") {
      try {
        const result = await this.knowledge.query(message.plainText);
        await this.sendPayload(
          message.chatId,
          result.results.length > 0 ? buildKnowledgeQueryPayload(result) : buildKnowledgeQueryEmptyPayload(message.plainText),
          {
            event: "knowledge query sent",
            transcriptType: "outbound-final",
            textPreview: message.plainText,
            len: message.plainText.length,
          },
          { replyToMessageId: message.messageId },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "知识检索失败",
          template: "red",
          iconToken: "error_filled",
          message: detail,
          messageIconToken: "error_filled",
          messageIconColor: "red",
        }), {
          event: "knowledge query failed",
          transcriptType: "outbound-final",
          textPreview: detail,
          len: detail.length,
        }, { replyToMessageId: message.messageId });
      }
      return;
    }

    if (this.knowledge && this.config.knowledgeBase.autoDetect.enabled) {
      const detection = detectLegalQuestion(message.plainText);
      if (detection.matched && detection.confidence >= this.config.knowledgeBase.autoDetect.minConfidence) {
        try {
          const result = await this.knowledge.query(message.plainText);
          if (result.results.length > 0) {
            await this.sendPayload(
              message.chatId,
              buildKnowledgeQueryPayload(result),
              {
                event: "knowledge query sent",
                transcriptType: "outbound-final",
                textPreview: message.plainText,
                len: message.plainText.length,
              },
              { replyToMessageId: message.messageId },
            );
            return;
          }
        } catch (error) {
          this.logger.log("knowledge/query", "auto-detect query failed", {
            detail: error instanceof Error ? error.message : String(error),
            confidence: detection.confidence,
          }, "warn");
        }
      }
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
    await this.turnExecutor.processChat(conversationKey);
  }

  private async runTurn(conversationKey: string): Promise<void> {
    await this.turnExecutor.runTurn(conversationKey);
  }

  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
    routed: Extract<RoutedText, { kind: "command" }>,
  ): Promise<void> {
    return new CommandHandler({
      config: this.config,
      opencode: this.opencode,
      whitelist: this.whitelist,
      queues: this.queues,
      eventStream: this.eventStream,
      sessionStatuses: this.sessionStatuses,
      pendingInteractions: this.pendingInteractions,
      permissionManager: this.permissionManager,
      knowledge: this.knowledge,
      getSessionWindow: (conversationKey, chatType) => this.getSessionWindow(conversationKey, chatType),
      createAndBindSession: async (source) => await this.createAndBindSession(source),
      sendPayload: async (chatId, payload, options, delivery) => await this.sendPayload(chatId, payload, options, delivery),
      sendMarkdown: async (chatId, markdown, replyToMessageId) => await this.sendMarkdown(chatId, markdown, replyToMessageId),
      setPendingInteraction: (conversationKey, interaction) => this.setPendingInteraction(conversationKey, interaction),
      clearPendingInteraction: (conversationKey, keepNonExpiring) => this.clearPendingInteraction(conversationKey, keepNonExpiring),
      listOpenCodeSessionsById: async () => await this.listOpenCodeSessionsById(),
      saveSessionWindow: async (conversationKey, window) => await this.saveSessionWindow(conversationKey, window),
      getSessionMessageCount: async (sessionId) => await this.getSessionMessageCount(sessionId),
      isSessionBusy: (conversationKey, sessionId) => this.isSessionBusy(conversationKey, sessionId),
      whitelistBind: async (chatId, openId) => await this.whitelist.bind(chatId, openId),
      resolveSessionCommandTarget: async (msg, index) => await this.resolveSessionCommandTarget(msg, index),
      resolveSessionCommandTargets: async (msg, range) => await this.resolveSessionCommandTargets(msg, range),
      ensureSession: async (source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">) => await this.ensureSession(source),
    }).handleCommand(message, routed);
  }

  private async handlePendingInteraction(message: IncomingChatMessage, pending: PendingInteraction): Promise<boolean> {
    if (pending.kind === "question") {
      if (message.messageType === "file") {
        await this.sendMarkdown(message.chatId, "当前正在等待文本回答，请直接发送文字内容。", message.messageId);
        return true;
      }
      try {
        await this.opencode.replyQuestion(pending.requestId, [message.plainText]);
        this.clearPendingInteraction(message.conversationKey, false);
        const currentTurnId = this.queues.get(message.conversationKey).peek()?.turnId;
        if (currentTurnId) {
          await this.turnCardManager.updateTurnCard(currentTurnId, { status: "处理中", update: "已收到你的回答，继续处理中...", target: "step" });
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

    if (pending.kind === "knowledge-ingest-await-file") {
      if (message.senderOpenId !== pending.requesterOpenId) {
        await this.sendMarkdown(message.chatId, "当前入库任务仅允许发起人继续上传文件。", message.messageId);
        return true;
      }
      if (!this.knowledge) {
        await this.sendMarkdown(message.chatId, "当前未启用法律知识库，请联系部署者补充 knowledgeBase 配置。", message.messageId);
        return true;
      }
      if (message.messageType !== "file") {
        const webIngest = detectKnowledgeWebIngest(message.plainText, { requireIngestIntent: false });
        if (!webIngest.matched || !webIngest.url || !this.knowledge.ingestWebPage) {
          await this.sendMarkdown(message.chatId, "请继续上传 PDF / DOCX / TXT / MD 文件，或直接发送网页 URL / 带 URL 的入库请求；发送 `/kb-ingest-end` 退出。", message.messageId);
          return true;
        }
        this.setRunningKnowledgeIngest(message.conversationKey, pending.requesterOpenId);
        const progressState = createKnowledgeIngestProgressState(webIngest.url);
        const processing = await this.sendPayload(
          message.chatId,
          buildKnowledgeIngestProcessingPayload(progressState),
          {
            event: "knowledge web ingest processing sent",
            transcriptType: "outbound-final",
            textPreview: webIngest.url,
            len: webIngest.url.length,
          },
          { replyToMessageId: message.messageId },
        );
        try {
          const result = await this.knowledge.ingestWebPage({
            url: webIngest.url,
            instruction: message.plainText,
            messageId: message.messageId,
          }, {
            onProgress: async (update) => await this.updateKnowledgeIngestProgress(message.chatId, processing.messageId, progressState, update),
          });
          this.maybeRefreshKnowledgeIngestPending(message.conversationKey, pending, message.messageId);
          await this.updatePayload(
            message.chatId,
            processing.messageId,
            buildKnowledgeIngestPayload(result),
            {
              event: "knowledge web ingest updated",
              transcriptType: "outbound-final",
              textPreview: result.sourceFile,
              len: result.sourceFile.length,
            },
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await this.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
            title: "网页入库失败",
            template: "red",
            iconToken: "error_filled",
            message: detail,
            messageIconToken: "error_filled",
            messageIconColor: "red",
            showMessageIcon: false,
          }), {
            event: "knowledge web ingest failed",
            transcriptType: "outbound-final",
            textPreview: detail,
            len: detail.length,
          });
        } finally {
          this.clearRunningKnowledgeIngest(message.conversationKey);
        }
        return true;
      }
      this.setRunningKnowledgeIngest(message.conversationKey, pending.requesterOpenId);
      const progressState = createKnowledgeIngestProgressState(message.file.fileName);
      const processing = await this.sendPayload(
        message.chatId,
        buildKnowledgeIngestProcessingPayload(progressState),
        {
          event: "knowledge ingest processing sent",
          transcriptType: "outbound-final",
          textPreview: message.file.fileName,
          len: message.file.fileName.length,
        },
        { replyToMessageId: message.messageId },
      );
      try {
        const result = await this.knowledge.ingestFile({
          messageId: message.messageId,
          fileKey: message.file.fileKey,
          fileName: message.file.fileName,
          size: message.file.size,
        }, {
          onProgress: async (update) => await this.updateKnowledgeIngestProgress(message.chatId, processing.messageId, progressState, update),
        });
        this.maybeRefreshKnowledgeIngestPending(message.conversationKey, pending, message.messageId);
        await this.updatePayload(
          message.chatId,
          processing.messageId,
          buildKnowledgeIngestPayload(result),
          {
            event: "knowledge ingest updated",
            transcriptType: "outbound-final",
            textPreview: result.sourceFile,
            len: result.sourceFile.length,
          },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
          title: "知识入库失败",
          template: "red",
          iconToken: "error_filled",
          message: detail,
          messageIconToken: "error_filled",
          messageIconColor: "red",
          showMessageIcon: false,
        }), {
          event: "knowledge ingest failed",
          transcriptType: "outbound-final",
          textPreview: detail,
          len: detail.length,
        });
      } finally {
        this.clearRunningKnowledgeIngest(message.conversationKey);
      }
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

  private getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord {
    const mode = resolveSessionMode(chatType, this.config.bridge.sessionModes);
    return normalizeSessionWindowRecord(this.sessionMap[conversationKey], mode, this.config.bridge.maxSessionsPerWindow);
  }

  private async saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void> {
    if (window.sessions.length === 0 && window.interactionMode !== "knowledge") {
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
      return;
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

  private clearTurnOwnedPendingInteraction(conversationKey: string, turnId: string): void {
    const current = this.pendingInteractions.get(conversationKey);
    if (!current) {
      return;
    }

    if (
      (current.kind === "permission" && current.turnId === turnId)
      || (current.kind === "question" && current.turnId === turnId)
    ) {
      this.clearPendingInteraction(conversationKey, false);
    }
  }

  private async handlePermissionTimeout(conversationKey: string, pending: PendingPermissionInteraction): Promise<void> {
    const current = this.pendingInteractions.get(conversationKey);
    if (!current || current.kind !== "permission" || current.permissionId !== pending.permissionId) {
      return;
    }

    await this.permissionManager.expireInteraction(current, true);
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

  private toCardContent(payload: FeishuPostPayload): Record<string, unknown> {
    return toInteractiveCardContent(payload);
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

  private async updatePayload(
    chatId: string,
    messageId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
  ): Promise<{ messageId: string }> {
    const result = await this.outbound.updateMessage(messageId, payload);
    this.logger.log("feishu/reply", options.event, { chatId, messageId: result.messageId, textPreview: options.textPreview, len: options.len });
    this.logger.logTranscript(options.transcriptType, { chatId, messageId: result.messageId }, prettyPrintPayload(payload));
    return result;
  }

  private setRunningKnowledgeIngest(conversationKey: string, requesterOpenId: string): void {
    this.runningKnowledgeIngests.set(conversationKey, { requesterOpenId });
  }

  private clearRunningKnowledgeIngest(conversationKey: string): void {
    this.runningKnowledgeIngests.delete(conversationKey);
  }

  private maybeRefreshKnowledgeIngestPending(
    conversationKey: string,
    pending: Extract<PendingInteraction, { kind: "knowledge-ingest-await-file" }>,
    replyToMessageId: string,
  ): void {
    const current = this.pendingInteractions.get(conversationKey);
    if (current?.kind !== "knowledge-ingest-await-file" || current.requesterOpenId !== pending.requesterOpenId) {
      return;
    }
    this.setPendingInteraction(conversationKey, {
      ...current,
      replyToMessageId,
    });
  }

  private async sendKnowledgeIngestBusyNotice(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
  ): Promise<void> {
    await this.sendPayload(message.chatId, buildNoticeCardPayload({
      title: "知识入库处理中",
      template: "blue",
      iconToken: "upload_outlined",
      message: "当前正在处理知识入库任务。\n发送 `/kb-ingest-end` 可退出入库模式。\n如需切换到法律查询，请发送 `/legal-query-start`。\n普通对话请等待当前入库完成后再发送。",
      messageIconToken: "upload_outlined",
      messageIconColor: "blue",
      showMessageIcon: false,
    }), {
      event: "knowledge ingest busy",
      transcriptType: "outbound-final",
      textPreview: "当前正在处理知识入库任务。",
      len: 43,
    }, { replyToMessageId: message.messageId });
  }

  private async updateKnowledgeIngestProgress(
    chatId: string,
    messageId: string,
    state: KnowledgeIngestProgressState,
    update: KnowledgeIngestProgressUpdate,
  ): Promise<void> {
    applyKnowledgeIngestProgress(state, update);
    const payload = buildKnowledgeIngestProcessingPayload(state);
    try {
      await this.updatePayload(chatId, messageId, payload, {
        event: "knowledge ingest progress updated",
        transcriptType: "outbound-final",
        textPreview: `${state.sourceLabel} ${state.steps.map((step) => `${step.label}:${step.detail}`).join(" | ")}`,
        len: state.steps.map((step) => `${step.label}:${step.detail}`).join("\n").length,
      });
    } catch (error) {
      this.logger.log("feishu/reply", "knowledge ingest progress update failed", {
        chatId,
        messageId,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }
}

type KnowledgeIngestProgressState = {
  sourceLabel: string;
  steps: ToolUpdateView[];
};

function createKnowledgeIngestProgressState(sourceLabel: string): KnowledgeIngestProgressState {
  return {
    sourceLabel,
    steps: [
      { label: "读取内容", detail: "等待开始", status: "pending" },
      { label: "提取问答", detail: "等待开始", status: "pending" },
      { label: "写入知识库", detail: "等待开始", status: "pending" },
    ],
  };
}

function applyKnowledgeIngestProgress(state: KnowledgeIngestProgressState, update: KnowledgeIngestProgressUpdate): void {
  const label = mapKnowledgeProgressLabel(update.step);
  const step = state.steps.find((item) => item.label === label);
  if (!step) {
    return;
  }
  step.status = update.status;
  if (update.detail) {
    step.detail = update.detail;
  } else if (update.status === "completed") {
    step.detail = "已完成";
  } else if (update.status === "running") {
    step.detail = "处理中";
  } else if (update.status === "error") {
    step.detail = "执行失败";
  }
}

function mapKnowledgeProgressLabel(step: KnowledgeIngestProgressStep): ToolUpdateView["label"] {
  switch (step) {
    case "read":
      return "读取内容";
    case "extract":
      return "提取问答";
    case "write":
      return "写入知识库";
  }
}
