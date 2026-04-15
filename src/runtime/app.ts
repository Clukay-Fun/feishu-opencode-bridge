import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueueRegistry } from "../bridge/queue.js";
import { type PendingInteraction, type PendingKnowledgeIngestInteraction, type PendingPermissionInteraction } from "../bridge/state.js";
import { ModuleManager } from "../bridge/module.js";
import { routeIncomingText, type RoutedText } from "../bridge/router.js";
import type { BridgeTurn } from "../bridge/turn.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  buildQueueNoticePayload,
  type FeishuPostPayload,
  toInteractiveCardContent,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import {
  KnowledgeBaseService,
  type KnowledgeBasePort,
} from "../knowledge/index.js";
import { KnowledgeRuntimeModule } from "../knowledge/runtime-module.js";
import { ContractAssistantService } from "../contract-assistant/index.js";
import { ContractAssistantRuntimeModule } from "../contract-assistant/runtime-module.js";
import { LaborSkillService } from "../labor/index.js";
import { LaborRuntimeModule } from "../labor/runtime-module.js";
import { MemoryService } from "../memory/index.js";
import { MemoryRuntimeModule } from "../memory/runtime-module.js";
import {
  OpenCodeClient,
  type OpenCodeSession,
  type OpenCodeSessionStatus,
} from "../opencode/client.js";
import { getEventSessionId, OpenCodeEventStream, type OpenCodeEvent } from "../opencode/events.js";
import { MappingStore, type MappingRecord, type SessionBindingRecord, type SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import { DEFAULT_CONTRACT_ASSISTANT_CONFIG, DEFAULT_LABOR_SKILL_CONFIG, type AppConfig } from "../config/schema.js";
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
import { CommandHandler, isBridgeOwnedCommand } from "./command-handler.js";
import { TurnCardManager } from "./turn-card-manager.js";
import { TurnExecutor } from "./turn-executor.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import {
  addSession,
  addSessionWithoutActivating,
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
  replyMessage(messageId: string, payload: FeishuPostPayload, options?: { replyInThread?: boolean }): Promise<{ messageId: string }>;
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
  updateBitableRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
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

const REGULAR_FILE_ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;
const PENDING_NEW_SESSION_TTL_MS = 10 * 60_000;

type PendingNewSessionAnchor = {
  replyMessageId: string;
  sourceConversationKey: string;
  entry: SessionBindingRecord;
  expiresAt: number;
};

type SessionSource = Pick<BridgeTurn, "chatId" | "conversationKey" | "threadKey"> & {
  chatType?: string | undefined;
  rootId?: string | undefined;
  parentId?: string | undefined;
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

export class BridgeApp {
  private readonly queues: QueueRegistry;
  private readonly mappings: MappingStore;
  private readonly opencode: OpenCodePort;
  private readonly eventStream: OpenCodeEventStreamPort;
  private readonly permissionManager: PermissionManager;
  private readonly turnCardManager: TurnCardManager;
  private readonly turnExecutor: TurnExecutor;
  private readonly moduleManager: ModuleManager;
  private readonly knowledgeModule: KnowledgeRuntimeModule;
  private readonly rateLimiter = new SlidingWindowRateLimiter(20, 60_000);
  private sessionMap: MappingRecord = {};
  private readonly runningChats = new Map<string, Promise<void>>();
  private readonly knowledgeIngestInteractions: Map<string, PendingKnowledgeIngestInteraction>;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly pendingInteractionTimers = new Map<string, NodeJS.Timeout>();
  private readonly sessionStatuses = new Map<string, OpenCodeSessionStatus>();
  private readonly pendingNewSessionAnchors = new Map<string, PendingNewSessionAnchor>();
  private readonly memory: MemoryService | null;
  private readonly knowledge: KnowledgeBasePort | null;
  private readonly contractAssistant: ContractAssistantService | null;
  private readonly laborSkill: LaborSkillService | null;
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
    const contractAssistantConfig = config.contractAssistant ?? DEFAULT_CONTRACT_ASSISTANT_CONFIG;
    this.contractAssistant = contractAssistantConfig.enabled
      ? new ContractAssistantService(
        contractAssistantConfig,
        config.storage.dataDir,
        this.outbound as OutboundPort & KnowledgeResourcePort,
        this.opencode as OpenCodeClient,
        logger,
      )
      : null;
    const laborSkillConfig = config.laborSkill ?? DEFAULT_LABOR_SKILL_CONFIG;
    this.laborSkill = laborSkillConfig.enabled
      ? new LaborSkillService(
        laborSkillConfig,
        config.storage.dataDir,
        this.outbound as OutboundPort & KnowledgeResourcePort,
        this.opencode as OpenCodeClient,
        logger,
        this.knowledge,
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
    this.moduleManager = new ModuleManager();
    this.knowledgeModule = new KnowledgeRuntimeModule({
      config: this.config,
      logger: this.logger,
      knowledge: this.knowledge,
      sendPayload: async (chatId, payload, options, delivery) => await this.sendPayload(chatId, payload, options, delivery),
      updatePayload: async (chatId, messageId, payload, options) => await this.updatePayload(chatId, messageId, payload, options),
      getSessionWindow: (conversationKey, chatType) => this.getSessionWindow(conversationKey, chatType),
      saveSessionWindow: async (conversationKey, window) => await this.saveSessionWindow(conversationKey, window),
      createAndBindSession: async (source) => await this.createAndBindSession(source),
      whitelistBind: async (chatId, openId) => await this.whitelist.bind(chatId, openId),
    });
    this.knowledgeIngestInteractions = this.knowledgeModule.interactions;
    this.moduleManager.register(this.knowledgeModule);
    this.moduleManager.register(new ContractAssistantRuntimeModule({
      config: this.config,
      logger: this.logger,
      service: this.contractAssistant,
      sendPayload: async (chatId, payload, options, delivery) => await this.sendPayload(chatId, payload, options, delivery),
      updatePayload: async (chatId, messageId, payload, options) => await this.updatePayload(chatId, messageId, payload, options),
    }));
    this.moduleManager.register(new LaborRuntimeModule({
      config: this.config,
      logger: this.logger,
      knowledge: this.knowledge,
      service: this.laborSkill,
      sendPayload: async (chatId, payload, options, delivery) => await this.sendPayload(chatId, payload, options, delivery),
      updatePayload: async (chatId, messageId, payload, options) => await this.updatePayload(chatId, messageId, payload, options),
    }));
    if (this.memory) {
      this.moduleManager.register(new MemoryRuntimeModule(this.memory));
    }
    this.turnExecutor = new TurnExecutor({
      config: this.config,
      logger: this.logger,
      queues: this.queues,
      opencode: this.opencode,
      eventStream: this.eventStream,
      sessionStatuses: this.sessionStatuses,
      turnCardManager: this.turnCardManager,
      permissionManager: this.permissionManager,
      moduleManager: this.moduleManager,
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
    await this.moduleManager.start();

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
    await this.moduleManager.stop();
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

    const pending = this.pendingInteractions.get(message.conversationKey);
    if (pending && this.isCorePendingInteraction(pending)) {
      const consumed = await this.handlePendingInteraction(message, pending);
      if (consumed) {
        return;
      }
    }

    const moduleResult = await this.moduleManager.handleMessage({ message, routed, pendingInteraction: pending ?? null });
    if (moduleResult.claimed) {
      return;
    }

    if (pending?.kind === "file-await-instruction") {
      const consumed = await this.handleFileInstructionPending(message, pending);
      if (consumed) {
        return;
      }
    }

    if (message.messageType === "file") {
      try {
        this.validateRegularFileInput(message.file.fileName, message.file.size);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "文件暂不支持",
          template: "red",
          iconToken: "error_filled",
          message: detail,
          messageIconToken: "error_filled",
          messageIconColor: "red",
          showMessageIcon: false,
        }), {
          event: "file rejected",
          transcriptType: "outbound-final",
          textPreview: detail,
          len: detail.length,
        }, { replyToMessageId: message.messageId });
        return;
      }
      this.setPendingInteraction(message.conversationKey, {
        kind: "file-await-instruction",
        chatId: message.chatId,
        conversationKey: message.conversationKey,
        requesterOpenId: message.senderOpenId,
        replyToMessageId: message.messageId,
        file: {
          messageId: message.messageId,
          fileKey: message.file.fileKey,
          fileName: message.file.fileName,
          size: message.file.size,
        },
      });
      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "已收到文件",
        template: "blue",
        iconToken: "file-link-docx_outlined",
        message: [
          `文件：${message.file.fileName}`,
          "",
          "如果只处理这个文件，可直接回复例如：`总结这个文件` 或 `把这个文件入库`。",
          "如果要连续批量入库，请发送 `/kb-ingest-start` 后重新上传文件。",
        ].join("\n"),
        messageIconToken: "file-link-docx_outlined",
        messageIconColor: "blue",
        showMessageIcon: false,
      }), {
        event: "file instruction requested",
        transcriptType: "outbound-final",
        textPreview: "已收到文件，请说明处理方式。",
        len: 14,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (!await this.ensureServerAvailableForMessage(message)) {
      return;
    }

    const sessionId = await this.ensureSession(message);
    const executionKey = this.buildExecutionKey(message.conversationKey, sessionId);
    const queue = this.queues.get(executionKey);
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
      sessionId,
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

    if (!this.runningChats.has(executionKey)) {
      const runner = this.processChat(executionKey).finally(() => {
        this.runningChats.delete(executionKey);
      });
      this.runningChats.set(executionKey, runner);
      await runner;
    }
  }

  private async processChat(conversationKey: string): Promise<void> {
    await this.turnExecutor.processChat(conversationKey);
  }

  private async runTurn(conversationKey: string): Promise<void> {
    await this.turnExecutor.runTurn(conversationKey);
  }

  private buildExecutionKey(conversationKey: string, sessionId: string): string {
    return `${conversationKey}::${sessionId}`;
  }

  private getQueueState(conversationKey: string, sessionId?: string | null): { activeTurn: BridgeTurn | null; pendingCount: number } {
    if (sessionId) {
      const queue = this.queues.getIfExists(this.buildExecutionKey(conversationKey, sessionId))
        ?? this.queues.getIfExists(conversationKey);
      return {
        activeTurn: queue?.peek() ?? null,
        pendingCount: queue?.pendingCount() ?? 0,
      };
    }

    for (const queue of this.queues.listByPrefix(conversationKey)) {
      const activeTurn = queue.peek();
      if (activeTurn) {
        return {
          activeTurn,
          pendingCount: queue.pendingCount(),
        };
      }
    }

    return { activeTurn: null, pendingCount: 0 };
  }

  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
    routed: Extract<RoutedText, { kind: "command" }>,
  ): Promise<void> {
    if (routed.command.kind === "passthrough") {
      const moduleResult = await this.moduleManager.handleMessage({ message: message as IncomingChatMessage, routed });
      if (moduleResult.claimed) {
        return;
      }
    }

    if (isBridgeOwnedCommand(routed.command)) {
      return await new CommandHandler({
        config: this.config,
        opencode: this.opencode,
        whitelist: this.whitelist,
        getQueueState: (conversationKey, sessionId) => this.getQueueState(conversationKey, sessionId),
        eventStream: this.eventStream,
        sessionStatuses: this.sessionStatuses,
        pendingInteractions: this.pendingInteractions,
        permissionManager: this.permissionManager,
        getSessionWindow: (conversationKey, chatType) => this.getSessionWindow(conversationKey, chatType),
        createAndBindSession: async (source, preferredLabel) => await this.createAndBindSession(source, preferredLabel),
        createDetachedSession: async (source, preferredLabel) => await this.createDetachedSession(source, preferredLabel),
        bindSessionWithoutActivating: async (source, entry) => await this.bindSessionWithoutActivating(source, entry),
        registerPendingNewSessionAnchor: async (replyMessageId, sourceConversationKey, entry) => {
          this.registerPendingNewSessionAnchor(replyMessageId, sourceConversationKey, entry);
        },
        sendPayload: async (chatId, payload, options, delivery) => await this.sendPayload(chatId, payload, options, delivery),
        sendMarkdown: async (chatId, markdown, replyToMessageId) => await this.sendMarkdown(chatId, markdown, replyToMessageId),
        setPendingInteraction: (conversationKey, interaction) => this.setPendingInteraction(conversationKey, interaction),
        clearPendingInteraction: (conversationKey, keepNonExpiring) => this.clearPendingInteraction(conversationKey, keepNonExpiring),
        listOpenCodeSessionsById: async () => await this.listOpenCodeSessionsById(),
        saveSessionWindow: async (conversationKey, window) => await this.saveSessionWindow(conversationKey, window),
        getSessionMessageCount: async (sessionId) => await this.getSessionMessageCount(sessionId),
        isSessionBusy: (conversationKey, sessionId) => this.isSessionBusy(conversationKey, sessionId),
        resolveSessionCommandTarget: async (msg, index) => await this.resolveSessionCommandTarget(msg, index),
        resolveSessionCommandTargets: async (msg, range) => await this.resolveSessionCommandTargets(msg, range),
        ensureSession: async (source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">) => await this.ensureSession(source),
      }).handleCommand(message, routed);
    }

    await this.moduleManager.handleMessage({ message: message as IncomingChatMessage, routed });
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
        const currentTurnId = pending.turnId;
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

    return false;
  }

  private isCorePendingInteraction(pending: PendingInteraction): boolean {
    return pending.kind === "question" || pending.kind === "permission";
  }

  private async handleFileInstructionPending(
    message: IncomingChatMessage,
    pending: Extract<PendingInteraction, { kind: "file-await-instruction" }>,
  ): Promise<boolean> {
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendMarkdown(message.chatId, "当前文件处理仅允许文件发送者继续说明需求。", message.messageId);
      return true;
    }
    if (message.messageType === "file") {
      await this.sendMarkdown(message.chatId, "已收到上一个文件，请先发送文字说明你希望我如何处理；如需入库，请发送 `/kb-ingest-start`。", message.messageId);
      return true;
    }
    const instruction = message.plainText.trim();
    if (!instruction) {
      await this.sendMarkdown(message.chatId, "请发送文字说明你希望我如何处理这个文件。", message.messageId);
      return true;
    }
    const processed = await this.prepareFileForOpenCodeTurn(pending, instruction).catch(async (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "文件读取失败",
        template: "red",
        iconToken: "error_filled",
        message: detail,
        messageIconToken: "error_filled",
        messageIconColor: "red",
        showMessageIcon: false,
      }), {
        event: "file instruction failed",
        transcriptType: "outbound-final",
        textPreview: detail,
        len: detail.length,
      }, { replyToMessageId: message.messageId });
      return null;
    });
    if (!processed) {
      this.clearPendingInteraction(message.conversationKey, false);
      return true;
    }
    this.clearPendingInteraction(message.conversationKey, false);
    if (!await this.ensureServerAvailableForMessage(message)) {
      return true;
    }
    const sessionId = await this.ensureSession(message);
    const executionKey = this.buildExecutionKey(message.conversationKey, sessionId);
    const queue = this.queues.get(executionKey);
    const turn: BridgeTurn = {
      turnId: crypto.randomUUID(),
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      threadKey: message.threadKey,
      chatType: message.chatType,
      senderOpenId: message.senderOpenId,
      inboundMessageId: message.messageId,
      plainText: `${instruction}\n\n[文件] ${pending.file.fileName}`,
      text: processed.prompt,
      sessionId,
    };
    const result = queue.enqueue(turn);
    if (!result.accepted) {
      await this.sendPayload(message.chatId, buildQueueNoticePayload(result.notice ?? { message: "当前不可用。" }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: result.notice?.message ?? "当前不可用。",
        len: (result.notice?.message ?? "当前不可用。").length,
      }, { replyToMessageId: message.messageId });
      return true;
    }
    if (!this.runningChats.has(executionKey)) {
      const runner = this.processChat(executionKey).finally(() => {
        this.runningChats.delete(executionKey);
      });
      this.runningChats.set(executionKey, runner);
      await runner;
    }
    return true;
  }

  getKnowledgeIngestInteraction(conversationKey: string): PendingKnowledgeIngestInteraction | null {
    return this.knowledgeModule.getInteraction(conversationKey);
  }

  async clearKnowledgeIngestPending(conversationKey: string, chatType: string): Promise<boolean> {
    return await this.knowledgeModule.clearPending(conversationKey, chatType);
  }

  private async ensureSession(
    source: SessionSource,
  ): Promise<string> {
    const openCodeSessions = await this.listOpenCodeSessionsById();
    await this.maybeAdoptPendingNewSessionAnchor(source, openCodeSessions);
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

  private async maybeAdoptPendingNewSessionAnchor(
    source: Pick<SessionSource, "chatType" | "conversationKey" | "rootId" | "parentId">,
    openCodeSessions: Map<string, OpenCodeSession>,
  ): Promise<void> {
    const anchorMessageId = source.rootId ?? source.parentId;
    if (!anchorMessageId) {
      return;
    }

    const pending = this.pendingNewSessionAnchors.get(anchorMessageId);
    if (!pending) {
      return;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingNewSessionAnchors.delete(anchorMessageId);
      return;
    }

    if (pending.sourceConversationKey === source.conversationKey) {
      return;
    }

    if (!openCodeSessions.has(pending.entry.sessionId)) {
      this.pendingNewSessionAnchors.delete(anchorMessageId);
      return;
    }

    const window = this.getSessionWindow(source.conversationKey, source.chatType);
    if (window.sessions.some((session) => session.sessionId === pending.entry.sessionId)) {
      this.pendingNewSessionAnchors.delete(anchorMessageId);
      return;
    }

    const nextWindow = addSession(window, pending.entry, this.config.bridge.maxSessionsPerWindow);
    await this.saveSessionWindow(source.conversationKey, nextWindow);
    this.pendingNewSessionAnchors.delete(anchorMessageId);
  }

  private async prepareFileForOpenCodeTurn(
    pending: Extract<PendingInteraction, { kind: "file-await-instruction" }>,
    instruction: string,
  ): Promise<{ prompt: string }> {
    const resources = this.outbound as OutboundPort & Partial<KnowledgeResourcePort>;
    if (!resources.downloadMessageResource) {
      throw new Error("当前运行环境不支持下载飞书文件。");
    }
    const downloaded = await resources.downloadMessageResource(pending.file.messageId, pending.file.fileKey, "file");
    this.validateRegularFileInput(downloaded.fileName, downloaded.buffer.byteLength);
    const localPath = await this.saveUploadedFileForTurn(downloaded.fileName, downloaded.buffer);
    return {
      prompt: [
        "用户上传了一个文件，并要求你按下述需求处理。",
        "bridge 已将附件下载到本地绝对路径；你与 bridge 在同一台机器上，可按需直接读取该路径。",
        "不要默认把文件写入知识库。",
        "只有当用户明确要求“入库 / 加入知识库 / 导入知识库”时，才使用知识库本地命令。",
        "",
        `用户需求：${instruction}`,
        `文件名：${downloaded.fileName}`,
        `MIME：${downloaded.mimeType}`,
        `本地路径：${localPath}`,
        `来源文件消息：${pending.file.messageId}`,
        "",
        "如果用户只是要总结、识别、分析、改写或提问，请直接基于该文件完成任务。",
      ].join("\n"),
    };
  }

  private async saveUploadedFileForTurn(fileName: string, buffer: Buffer): Promise<string> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "bridge-turn-file-"));
    const targetPath = path.join(tempDir, sanitizeUploadedFileName(fileName));
    await writeFile(targetPath, buffer);
    return targetPath;
  }

  private validateRegularFileInput(fileName: string, sizeBytes?: number): void {
    const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (!REGULAR_FILE_ALLOWED_EXTENSIONS.includes(extension as typeof REGULAR_FILE_ALLOWED_EXTENSIONS[number])) {
      throw new Error(`仅支持 ${REGULAR_FILE_ALLOWED_EXTENSIONS.join(" / ")} 文件`);
    }
    if (typeof sizeBytes !== "number") {
      return;
    }
    const maxSizeBytes = this.config.knowledgeBase.ingest.maxFileSizeMb * 1024 * 1024;
    if (sizeBytes > maxSizeBytes) {
      throw new Error(`文件过大，请控制在 ${this.config.knowledgeBase.ingest.maxFileSizeMb}MB 以内`);
    }
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
    return normalizeSessionWindowRecord(this.sessionMap[this.resolveSessionWindowKey(conversationKey, chatType)], mode, this.config.bridge.maxSessionsPerWindow);
  }

  private async saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void> {
    const storageKey = this.resolveSessionWindowKey(conversationKey);
    const legacyKey = this.resolveLegacyP2pWindowKey(conversationKey);
    if (window.sessions.length === 0 && window.interactionMode !== "knowledge") {
      delete this.sessionMap[storageKey];
    } else {
      this.sessionMap[storageKey] = window;
    }
    if (legacyKey) {
      delete this.sessionMap[legacyKey];
    }
    await this.mappings.save(this.sessionMap);
  }

  private resolveSessionWindowKey(conversationKey: string, chatType?: string): string {
    if (chatType === "p2p" && conversationKey.endsWith(":main") && !this.sessionMap[conversationKey]) {
      const legacyKey = this.resolveLegacyP2pWindowKey(conversationKey);
      if (legacyKey && this.sessionMap[legacyKey]) {
        this.sessionMap[conversationKey] = this.sessionMap[legacyKey];
        delete this.sessionMap[legacyKey];
      }
    }

    return conversationKey;
  }

  private resolveLegacyP2pWindowKey(conversationKey: string): string | null {
    if (!conversationKey.endsWith(":main")) {
      return null;
    }
    return conversationKey.slice(0, -":main".length);
  }

  private async createAndBindSession(
    source: SessionSource,
    preferredLabel?: string,
  ): Promise<SessionBindingRecord> {
    const entry = await this.createDetachedSession(source, preferredLabel);
    const window = this.getSessionWindow(source.conversationKey, source.chatType);
    const nextWindow = addSession(window, entry, this.config.bridge.maxSessionsPerWindow);
    await this.saveSessionWindow(source.conversationKey, nextWindow);
    return entry;
  }

  private async bindSessionWithoutActivating(
    source: SessionSource,
    entry: SessionBindingRecord,
  ): Promise<SessionBindingRecord> {
    const window = this.getSessionWindow(source.conversationKey, source.chatType);
    const nextWindow = addSessionWithoutActivating(window, entry, this.config.bridge.maxSessionsPerWindow);
    await this.saveSessionWindow(source.conversationKey, nextWindow);
    return entry;
  }

  private async createDetachedSession(
    source: SessionSource,
    preferredLabel?: string,
  ): Promise<SessionBindingRecord> {
    const normalizedLabel = preferredLabel?.trim() || "新会话";
    const session = await this.opencode.createSession(preferredLabel?.trim() || buildSessionTitle(source.chatId, source.chatType, source.threadKey));
    return createSessionEntry(session.id, Date.now(), normalizedLabel);
  }

  private registerPendingNewSessionAnchor(replyMessageId: string, sourceConversationKey: string, entry: SessionBindingRecord): void {
    this.pendingNewSessionAnchors.set(replyMessageId, {
      replyMessageId,
      sourceConversationKey,
      entry,
      expiresAt: Date.now() + PENDING_NEW_SESSION_TTL_MS,
    });
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

  private clearPendingInteraction(
    conversationKey: string,
    keepNonExpiring: boolean,
  ): void {
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
    const active = this.queues.getIfExists(this.buildExecutionKey(conversationKey, sessionId))?.peek()
      ?? this.queues.getIfExists(conversationKey)?.peek();
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
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
  ): Promise<{ messageId: string }> {
    const result = delivery?.replyToMessageId && delivery.replyInThread !== undefined
      ? await this.outbound.replyMessage(delivery.replyToMessageId, payload, { replyInThread: delivery.replyInThread })
      : this.config.feishu.behavior.replyInThread && delivery?.replyToMessageId
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
}

function sanitizeUploadedFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeName = base || "uploaded-file";
  const safeExt = parsed.ext.replace(/[^a-zA-Z0-9.]+/g, "");
  return `${safeName}${safeExt}`;
}
