/**
 * 职责: 作为桥接应用的核心编排器，接收飞书输入并驱动整条执行链路。
 * 关注点:
 * - 管理会话分配、执行队列、挂起交互和权限流程。
 * - 将消息解析后分发给运行时模块与 OpenCode。
 * - 协调卡片更新、状态持久化和异常兜底。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { QueueRegistry } from "../bridge/queue.js";
import { type PendingFileInstructionInteraction, type PendingInteraction, type PendingKnowledgeIngestInteraction, type PendingPermissionInteraction } from "../bridge/state.js";
import type { ModuleManager } from "../bridge/module.js";
import { routeIncomingText, type RoutedText } from "../bridge/router.js";
import type { BridgeTurn } from "../bridge/turn.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  buildQueueNoticePayload,
  toInteractiveCardContent,
  type FeishuPostPayload,
} from "../feishu/shared-primitives.js";
import { createTextPreview, getLogContext, logEvent, type LogContext, type Logger, type TranscriptType } from "../logging/logger.js";
import {
  type KnowledgeBasePort,
} from "../knowledge/index.js";
import { parseKnowledgeFile } from "../knowledge/parser.js";
import type { ExtensionDefinition } from "../extension-api/index.js";
import type { KnowledgeRuntimeModule } from "../knowledge/runtime-module.js";
import type { MemoryService } from "../memory/index.js";
import {
  OpenCodeClient,
  type OpenCodePromptPart,
  type OpenCodeSession,
  type OpenCodeSessionStatus,
} from "../opencode/client.js";
import { getEventSessionId, OpenCodeEventStream, type OpenCodeEvent } from "../opencode/events.js";
import { MappingStore, type MappingRecord, type SessionBindingRecord, type SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import type { AppConfig } from "../config/schema.js";
import { SUPPORTED_MATERIAL_EXTENSIONS } from "../document-pipeline/material-support.js";
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
import { createFeishuTransport } from "./feishu-transport.js";
import { createRuntimeModules } from "./runtime-modules.js";
import type { PersistedInteractionManager } from "./persisted-interaction-manager.js";
import { TurnCardManager } from "./turn-card-manager.js";
import { TurnExecutor } from "./turn-executor.js";
import { TurnOwnedResourceStore } from "./turn-owned-resources.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { BridgeMessageContextStore, prependBridgeMessageContext, type BridgeOutputContext } from "./message-context.js";
import { CostTracker } from "./cost-tracker.js";
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
  messageType: "file" | "image";
  file: {
    fileKey: string;
    fileName: string;
    size?: number | undefined;
  };
  /** 区分普通文件、图片与文件夹资源，下载时传给飞书 API。缺失时默认 "file"。 */
  resourceType?: "file" | "image" | "folder" | undefined;
};

export type IncomingChatMessage = IncomingTextMessage | IncomingFileMessage;

type OutboundPort = {
  sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: FeishuPostPayload, options?: { replyInThread?: boolean }): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
};

type KnowledgeResourcePort = {
  downloadMessageResource(messageId: string, fileKey: string, type: "file" | "image" | "folder"): Promise<{
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
  externalExtensions?: readonly ExtensionDefinition[] | undefined;
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

const REGULAR_FILE_ALLOWED_EXTENSIONS = SUPPORTED_MATERIAL_EXTENSIONS;
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

/**
 * 职责: 作为桥接应用的核心编排器，接收飞书输入并驱动整条执行链路。
 * 关注点:
 * - 管理会话分配、执行队列、挂起交互和权限流程。
 * - 将消息解析后分发给运行时模块与 OpenCode。
 * - 协调卡片更新、状态持久化和异常兜底。
 */
export class BridgeApp {
  private readonly queues: QueueRegistry;
  private readonly mappings: MappingStore;
  private readonly opencode: OpenCodePort;
  private readonly eventStream: OpenCodeEventStreamPort;
  private readonly permissionManager: PermissionManager;
  private readonly messageContextStore: BridgeMessageContextStore;
  private readonly turnCardManager: TurnCardManager;
  private readonly costTracker: CostTracker;
  private readonly turnOwnedResources: TurnOwnedResourceStore;
  private readonly turnExecutor: TurnExecutor;
  private readonly moduleManager: ModuleManager;
  private readonly knowledgeModule: KnowledgeRuntimeModule;
  private readonly knowledgeIngestInteractions: PersistedInteractionManager<PendingKnowledgeIngestInteraction>;
  private readonly rateLimiter = new SlidingWindowRateLimiter(20, 60_000);
  private sessionMap: MappingRecord = {};
  private readonly runningChats = new Map<string, Promise<void>>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly pendingInteractionTimers = new Map<string, NodeJS.Timeout>();
  private readonly sessionStatuses = new Map<string, OpenCodeSessionStatus>();
  private readonly pendingNewSessionAnchors = new Map<string, PendingNewSessionAnchor>();
  private readonly pendingNewSessionAnchorTimers = new Map<string, NodeJS.Timeout>();
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
    this.messageContextStore = new BridgeMessageContextStore(config.storage.dataDir, logger);
    this.opencode = deps?.opencode ?? new OpenCodeClient(config.opencode.baseUrl);
    this.eventStream = deps?.eventStream ?? new OpenCodeEventStream(config.opencode.baseUrl, logger);
    this.turnCardManager = new TurnCardManager(this.outbound, this.logger, this.config.feishu.behavior.replyInThread, {
      rememberBridgeOutput: (input) => this.messageContextStore.rememberBridgeOutput(input),
    });
    this.costTracker = new CostTracker(config.costs, config.storage.dataDir, logger);
    this.turnOwnedResources = new TurnOwnedResourceStore(this.logger);
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
      updatePayload: async (chatId, messageId, payload, options) => {
        return await this.updatePayload(chatId, messageId, payload, options);
      },
      toCardContent: (payload) => this.toCardContent(payload),
    }, this.config.permissions?.defaultPolicy ?? "ask");
    const transport = createFeishuTransport({
      sendPayload: async (chatId, payload, options, delivery, handoffSummary) => await this.sendPayload(chatId, payload, options, delivery, handoffSummary),
      updatePayload: async (chatId, messageId, payload, options, handoffSummary) => await this.updatePayload(chatId, messageId, payload, options, handoffSummary),
    });
    const moduleAssembly = createRuntimeModules({
      config: this.config,
      outbound: this.getRuntimeModuleOutbound(),
      transport,
      logger: this.logger,
      opencode: this.opencode as OpenCodeClient,
      costTracker: this.costTracker,
      whitelist: this.whitelist,
      getSessionWindow: (conversationKey, chatType) => this.getSessionWindow(conversationKey, chatType),
      saveSessionWindow: async (conversationKey, window) => await this.saveSessionWindow(conversationKey, window),
      createAndBindSession: async (source) => await this.createAndBindSession(source),
      ...(deps && "memory" in deps ? { memory: deps.memory ?? null } : {}),
      ...(deps && "knowledge" in deps ? { knowledge: deps.knowledge ?? null } : {}),
      ...(deps?.externalExtensions ? { externalExtensions: deps.externalExtensions } : {}),
    });
    this.moduleManager = moduleAssembly.moduleManager;
    this.knowledgeModule = moduleAssembly.knowledgeModule;
    this.knowledgeIngestInteractions = this.knowledgeModule.interactions;
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
      cleanupTurnResources: async (turnId) => await this.turnOwnedResources.cleanupTurn(turnId),
      setPendingInteraction: (conversationKey, interaction) => this.setPendingInteraction(conversationKey, interaction),
      sendPayload: async (chatId, payload, options, delivery, handoffSummary) => this.sendPayload(chatId, payload, options, delivery, handoffSummary),
      costTracker: this.costTracker,
      messageContextStore: this.messageContextStore,
    });
  }

  // #region 生命周期与外部入口

  /**
   * 启动桥接应用，并完成映射恢复、模块装配和事件流订阅。
   */
  async start(): Promise<void> {
    await this.messageContextStore.restore();
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

  /**
   * 停止桥接应用，并清理定时器、模块、事件流和临时资源。
   */
  async stop(): Promise<void> {
    this.globalEventUnsubscribe?.();
    this.globalEventUnsubscribe = null;
    for (const timeout of this.pendingInteractionTimers.values()) {
      clearTimeout(timeout);
    }
    this.pendingInteractionTimers.clear();
    this.turnCardManager.stop();
    await this.moduleManager.stop();
    await this.turnOwnedResources.cleanupAll();
    await this.eventStream.stop();
  }

  /**
   * 处理飞书权限卡片回调，并转交给权限管理器。
   */
  async handlePermissionCardAction(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.permissionManager.handleCardAction(actorOpenId, openMessageId, value);
  }

  /** 处理业务模块卡片回调。 */
  async handleCardAction(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.moduleManager.handleCardAction(actorOpenId, openMessageId, value);
    return result ?? {
      toast: {
        type: "warning",
        content: "未识别的卡片操作，请使用文本命令兜底。",
      },
    };
  }

  // #endregion

  // #region 消息入口与主处理链路

  /**
   * 处理一条飞书消息，并完成鉴权、分流、排队和模块分派。
   */
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
    this.messageContextStore.rememberInbound(message);
    const messageContext = this.messageContextStore.buildRuntimeContext(message);

    const routed = message.messageType === "file" || message.messageType === "image"
      ? null
      : routeIncomingText(message.plainText);
    if (routed?.kind === "command") {
      await this.handleCommand(message, routed);
      return;
    }

    const pending = this.pendingInteractions.get(message.conversationKey);
    const bypassCorePending = pending?.kind === "question" && shouldBypassQuestionForBusinessEntrypoint(message);
    if (bypassCorePending) {
      this.clearPendingInteraction(message.conversationKey, false);
    }
    if (pending && !bypassCorePending && this.isCorePendingInteraction(pending)) {
      const consumed = await this.handlePendingInteraction(message, pending);
      if (consumed) {
        return;
      }
    }

    const moduleResult = await this.moduleManager.handleMessage({
      message,
      routed,
      window: this.getSessionWindow(message.conversationKey, message.chatType),
      pendingInteraction: pending ?? null,
      messageContext,
    });
    if (moduleResult.claimed) {
      return;
    }

    if (pending?.kind === "file-await-instruction") {
      const claimedByModule = await this.moduleManager.claimFileInstruction(pending, message);
      if (claimedByModule) {
        this.clearPendingInteraction(message.conversationKey, false);
        return;
      }
      const consumed = await this.handleFileInstructionPending(message, pending);
      if (consumed) {
        return;
      }
    }

    if (message.messageType === "file" || message.messageType === "image") {
      try {
        this.validateRegularFileInput(message.file.fileName, message.file.size);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "文件暂不支持",
          level: "error",
          message: detail,
          showMessageIcon: false,
        }), {
          event: "file rejected",
          transcriptType: "outbound-final",
          textPreview: detail,
          len: detail.length,
        }, { replyToMessageId: message.messageId });
        return;
      }
      const resourceType = message.resourceType ?? (message.messageType === "image" ? "image" : "file");
      const pending: PendingFileInstructionInteraction = {
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
        resourceType,
      };
      await this.handleFileInstructionPending(this.buildAutoFileInstructionMessage(message), pending);
      return;
    }

    if (!await this.ensureServerAvailableForMessage(message)) {
      return;
    }

    if (await this.costTracker.isDailyLimitExceeded()) {
      const limit = this.costTracker.dailyLimitCny;
      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "已达到今日 AI 成本上限",
        level: "warning",
        message: `今天的本地估算成本已达到上限${limit === undefined ? "" : `（¥${limit.toFixed(2)}）`}。\n普通对话已暂停，仍可使用 \`/cost\`、\`/status\`、\`/help\` 查看状态。\n如需继续，请调整 config.json 的 \`costs.dailyLimitCny\` 后重启。`,
      }), {
        event: "cost limit reached",
        transcriptType: "outbound-final",
        textPreview: "已达到今日 AI 成本上限",
        len: 12,
      }, { replyToMessageId: message.messageId });
      return;
    }

    const sessionId = await this.ensureSession(message);
    const executionKey = this.buildExecutionKey(message.conversationKey, sessionId);
    const queue = this.queues.get(executionKey);
    const window = this.getSessionWindow(message.conversationKey, message.chatType);
    const turnId = crypto.randomUUID();
    const turn: BridgeTurn = {
      turnId,
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      threadKey: message.threadKey,
      chatType: message.chatType,
      senderOpenId: message.senderOpenId,
      inboundMessageId: message.messageId,
      plainText: message.plainText,
      text: this.buildPromptTextWithMessageContext(message, toOpencodePromptText(message)),
      model: window.modelOverride,
      sessionId,
      rootId: message.rootId,
      parentId: message.parentId,
      logContext: this.buildTurnLogContext(message, turnId, sessionId),
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

  // #endregion

  // #region 队列调度

  /**
   * 消费指定执行队列中的所有待处理 turn。
   */
  private async processChat(conversationKey: string): Promise<void> {
    await this.turnExecutor.processChat(conversationKey);
  }

  /**
   * 触发指定队列继续执行当前 turn。
   */
  private async runTurn(conversationKey: string): Promise<void> {
    await this.turnExecutor.runTurn(conversationKey);
  }

  /**
   * 生成 conversation 与 session 维度的执行键。
   */
  private buildExecutionKey(conversationKey: string, sessionId: string): string {
    return `${conversationKey}::${sessionId}`;
  }

  /**
   * 将飞书右键回复/话题根消息里已知的短期上下文注入本轮 OpenCode prompt。
   */
  private buildPromptTextWithMessageContext(message: IncomingChatMessage, prompt: string): string {
    return prependBridgeMessageContext(prompt, this.messageContextStore.buildPromptBlock(message));
  }

  /**
   * 查询当前窗口或指定 session 的执行状态与积压数量。
   */
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

  // #endregion

  // #region 指令与挂起交互

  /**
   * 处理桥接层命令，并把桥接自有命令与模块命令分流。
   */
  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId" | "rootId" | "parentId">,
    routed: Extract<RoutedText, { kind: "command" }>,
  ): Promise<void> {
    if (routed.command.kind === "passthrough") {
      const moduleResult = await this.moduleManager.handleMessage({
        message: message as IncomingChatMessage,
        routed,
        window: this.getSessionWindow(message.conversationKey, message.chatType),
        messageContext: this.messageContextStore.buildRuntimeContext(message),
      });
      if (moduleResult.claimed) {
        return;
      }
    }

    if (isBridgeOwnedCommand(routed.command)) {
      return await new CommandHandler({
        config: this.config,
        costTracker: this.costTracker,
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

    await this.moduleManager.handleMessage({
      message: message as IncomingChatMessage,
      routed,
      window: this.getSessionWindow(message.conversationKey, message.chatType),
      messageContext: this.messageContextStore.buildRuntimeContext(message),
    });
  }

  /**
   * 处理 question / permission 等核心挂起交互。
   */
  private async handlePendingInteraction(message: IncomingChatMessage, pending: PendingInteraction): Promise<boolean> {
    if (pending.kind === "question") {
      if (message.messageType === "file" || message.messageType === "image") {
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
      const textResolution = parsePermissionTextResolution(message.plainText);
      if (textResolution) {
        if (pending.requesterOpenId !== message.senderOpenId) {
          await this.sendPayload(message.chatId, buildNoticeCardPayload({
            title: "权限请求待确认",
            level: "warning",
            message: "当前权限请求仅限本轮发起者处理。",
          }), {
            event: "final message sent",
            transcriptType: "outbound-final",
            textPreview: "当前权限请求仅限本轮发起者处理。",
            len: 16,
          }, { replyToMessageId: message.messageId });
          return true;
        }

        await this.permissionManager.resolveInteraction(pending, textResolution);
        const finalResolution = pending.resolution ?? textResolution;
        await this.sendPayload(message.chatId, this.permissionManager.buildResolutionPayload(finalResolution), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: finalResolution === "upstream-expired" ? "权限请求已失效。" : finalResolution === "deny" ? "已拒绝权限请求。" : "已确认权限请求。",
          len: 8,
        }, { replyToMessageId: message.messageId });
        return true;
      }

      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "信息提示",
        level: "info",
        message: "当前有待确认的权限请求，请先点击卡片按钮，或发送 `/allow once`、`/allow always`、`/deny`、`允许一次`、`始终允许`、`拒绝`。",
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

  /**
   * 判断挂起交互是否属于需要优先拦截的核心类型。
   */
  private isCorePendingInteraction(pending: PendingInteraction): boolean {
    return pending.kind === "question" || pending.kind === "permission";
  }

  private buildAutoFileInstructionMessage(message: IncomingFileMessage): IncomingTextMessage {
    const noun = message.messageType === "image" ? "图片" : "文件";
    return {
      chatId: message.chatId,
      chatType: message.chatType,
      senderOpenId: message.senderOpenId,
      messageId: message.messageId,
      rawContent: message.rawContent,
      plainText: [
        `请直接识别并总结这个${noun}的内容。`,
        "先判断它大概是什么类型，例如发票、合同、判决书、聊天截图、表格、普通文档或其他材料。",
        "如果是发票，请把能识别到的关键信息逐项列出：发票类型、发票号码、开票日期、购买方、销售方、项目名称、金额、税额、价税合计、备注等；未识别到的字段写“未识别”。",
        "如果是合同、判决书或其他文档，请列出文件类型、主体/案由、第一页或主要内容摘要、关键日期、关键金额、重要当事人和需要注意的风险点。",
        "只回复识别结果本身，不要写入知识库、合同台账或发票台账，也不要反问用户要做什么。",
      ].join("\n"),
      rootId: message.rootId,
      parentId: message.parentId,
      threadKey: message.threadKey,
      conversationKey: message.conversationKey,
      messageType: "text",
    };
  }

  /**
   * 处理“先传文件，后补说明”这一类挂起文件指令流程。
   */
  private async handleFileInstructionPending(
    message: IncomingChatMessage,
    pending: Extract<PendingInteraction, { kind: "file-await-instruction" }>,
  ): Promise<boolean> {
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendMarkdown(message.chatId, "当前文件处理仅允许文件发送者继续说明需求。", message.messageId);
      return true;
    }
    if (message.messageType === "file" || message.messageType === "image") {
      await this.sendMarkdown(message.chatId, "已收到上一个文件，请先发送文字说明你希望我如何处理；如需入库，请发送 `/知识入库`。", message.messageId);
      return true;
    }
    const instruction = message.plainText.trim();
    if (!instruction) {
      await this.sendMarkdown(message.chatId, "请发送文字说明你希望我如何处理这个文件。", message.messageId);
      return true;
    }
    const turnId = crypto.randomUUID();
    let processed: { prompt: string; promptParts?: OpenCodePromptPart[] | undefined } | null = null;
    try {
      processed = await this.prepareFileForOpenCodeTurn(turnId, pending, instruction);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.turnOwnedResources.cleanupTurn(turnId);
      await this.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "文件读取失败",
        level: "error",
        message: detail,
        showMessageIcon: false,
      }), {
        event: "file instruction failed",
        transcriptType: "outbound-final",
        textPreview: detail,
        len: detail.length,
      }, { replyToMessageId: message.messageId });
    }
    if (!processed) {
      this.clearPendingInteraction(message.conversationKey, false);
      return true;
    }
    this.clearPendingInteraction(message.conversationKey, false);
    if (!await this.ensureServerAvailableForMessage(message)) {
      await this.turnOwnedResources.cleanupTurn(turnId);
      return true;
    }
    const sessionId = await this.ensureSession(message);
    const executionKey = this.buildExecutionKey(message.conversationKey, sessionId);
    const queue = this.queues.get(executionKey);
    const window = this.getSessionWindow(message.conversationKey, message.chatType);
    const turn: BridgeTurn = {
      turnId,
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      threadKey: message.threadKey,
      chatType: message.chatType,
      senderOpenId: message.senderOpenId,
      inboundMessageId: message.messageId,
      plainText: `${instruction}\n\n[文件] ${pending.file.fileName}`,
      text: this.buildPromptTextWithMessageContext(message, processed.prompt),
      promptParts: processed.promptParts,
      model: window.modelOverride,
      sessionId,
      rootId: message.rootId,
      parentId: message.parentId,
      logContext: this.buildTurnLogContext(message, turnId, sessionId),
    };
    const result = queue.enqueue(turn);
    if (!result.accepted) {
      await this.turnOwnedResources.cleanupTurn(turnId);
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

  // #endregion

  // #region 业务模块桥接接口

  /**
   * 返回当前窗口中的知识库入库挂起状态。
   */
  getKnowledgeIngestInteraction(conversationKey: string): PendingKnowledgeIngestInteraction | null {
    return this.knowledgeModule.getInteraction(conversationKey);
  }

  /**
   * 清理当前窗口里的知识库入库挂起状态。
   */
  async clearKnowledgeIngestPending(conversationKey: string, chatType: string): Promise<boolean> {
    return await this.knowledgeModule.clearPending(conversationKey, chatType);
  }

  // #region 会话绑定与锚点认领

  /**
   * 为当前消息找到可用 session；必要时创建并绑定新 session。
   */
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

  /**
   * 尝试认领由 `/new` 等流程提前创建、但尚未绑定窗口的 session。
   */
  private async maybeAdoptPendingNewSessionAnchor(
    source: Pick<SessionSource, "chatType" | "conversationKey" | "rootId" | "parentId">,
    openCodeSessions: Map<string, OpenCodeSession>,
  ): Promise<void> {
    const match = this.findPendingNewSessionAnchor(source);
    if (!match) {
      return;
    }
    const { messageId: anchorMessageId, pending } = match;

    if (pending.expiresAt <= Date.now()) {
      this.clearPendingNewSessionAnchor(anchorMessageId);
      return;
    }

    if (pending.sourceConversationKey === source.conversationKey) {
      return;
    }

    if (!openCodeSessions.has(pending.entry.sessionId)) {
      this.clearPendingNewSessionAnchor(anchorMessageId);
      return;
    }

    const window = this.getSessionWindow(source.conversationKey, source.chatType);
    if (window.sessions.some((session) => session.sessionId === pending.entry.sessionId)) {
      this.clearPendingNewSessionAnchor(anchorMessageId);
      return;
    }

    const nextWindow = addSession(window, pending.entry, this.config.bridge.maxSessionsPerWindow);
    await this.saveSessionWindow(source.conversationKey, nextWindow);
    this.clearPendingNewSessionAnchor(anchorMessageId);
  }

  /**
   * 根据 root / parent 消息链查找待认领的 session 锚点。
   */
  private findPendingNewSessionAnchor(source: Pick<SessionSource, "rootId" | "parentId">): { messageId: string; pending: PendingNewSessionAnchor } | null {
    const candidates = [source.rootId, source.parentId]
      .filter((value): value is string => Boolean(value));
    for (const messageId of new Set(candidates)) {
      const pending = this.pendingNewSessionAnchors.get(messageId);
      if (pending) {
        return { messageId, pending };
      }
    }
    return null;
  }

  // #endregion

  // #region 资源与附件处理

  /**
   * 组装 runtime modules 所需的消息与资源能力集合。
   */
  private getRuntimeModuleOutbound(): OutboundPort & KnowledgeResourcePort {
    const resources = this.outbound as OutboundPort & Partial<KnowledgeResourcePort>;
    const missing = [
      "downloadMessageResource",
      "createBitableRecord",
      "listBitableRecords",
      "updateBitableRecord",
    ].filter((name) => typeof resources[name as keyof KnowledgeResourcePort] !== "function");
    if (missing.length > 0 && this.hasResourceBackedFeatureEnabled()) {
      throw new Error(`runtime modules require outbound resource methods: ${missing.join(", ")}`);
    }
    const missingResourceMethod = async (): Promise<never> => {
      throw new Error("当前运行环境不支持飞书资源操作。");
    };
    const downloadMessageResource = resources.downloadMessageResource;
    const createBitableRecord = resources.createBitableRecord;
    const listBitableRecords = resources.listBitableRecords;
    const updateBitableRecord = resources.updateBitableRecord;
    return {
      sendMessage: async (chatId, payload) => await this.outbound.sendMessage(chatId, payload),
      replyMessage: async (messageId, payload, options) => await this.outbound.replyMessage(messageId, payload, options),
      updateMessage: async (messageId, payload) => await this.outbound.updateMessage(messageId, payload),
      downloadMessageResource: downloadMessageResource
        ? async (messageId, fileKey, type) => await downloadMessageResource.call(resources, messageId, fileKey, type)
        : missingResourceMethod,
      createBitableRecord: createBitableRecord
        ? async (appToken, tableId, fields) => await createBitableRecord.call(resources, appToken, tableId, fields)
        : missingResourceMethod,
      listBitableRecords: listBitableRecords
        ? async (appToken, tableId) => await listBitableRecords.call(resources, appToken, tableId)
        : missingResourceMethod,
      updateBitableRecord: updateBitableRecord
        ? async (appToken, tableId, recordId, fields) => await updateBitableRecord.call(resources, appToken, tableId, recordId, fields)
        : missingResourceMethod,
    };
  }

  /**
   * 判断当前是否启用了依赖飞书资源接口的功能模块。
   */
  private hasResourceBackedFeatureEnabled(): boolean {
    return Boolean(
      this.config.knowledgeBase.enabled
      || this.config.contractAssistant?.enabled
      || this.config.laborSkill?.enabled,
    );
  }

  /**
   * 下载挂起文件并拼装交给 OpenCode 的文件处理提示词。
   */
  private async prepareFileForOpenCodeTurn(
    turnId: string,
    pending: Extract<PendingInteraction, { kind: "file-await-instruction" }>,
    instruction: string,
  ): Promise<{ prompt: string; promptParts?: OpenCodePromptPart[] | undefined }> {
    const resources = this.outbound as OutboundPort & Partial<KnowledgeResourcePort>;
    if (!resources.downloadMessageResource) {
      throw new Error("当前运行环境不支持下载飞书文件。");
    }
    const downloaded = await resources.downloadMessageResource(pending.file.messageId, pending.file.fileKey, pending.resourceType ?? "file");
    const fileName = normalizeDownloadedResourceFileName(downloaded.fileName, downloaded.mimeType, pending);
    this.validateRegularFileInput(fileName, downloaded.buffer.byteLength);
    const localPath = await this.saveUploadedFileForTurn(turnId, fileName, downloaded.buffer);
    const extractedPreview = await this.extractUploadedFilePreview(fileName, downloaded.buffer);
    const promptParts = buildUploadedResourcePromptParts(fileName, downloaded.mimeType, downloaded.buffer, pending.resourceType);
    return {
      prompt: [
        "用户上传了一个文件，并要求你按下述需求处理。",
        "bridge 已将附件下载到本地绝对路径；你与 bridge 在同一台机器上，可按需直接读取该路径。",
        "如果本次上传的是图片，请直接基于本地路径读取图片内容；不要再要求用户重新上传。",
        "bridge 已尽力用本地文档解析/OCR 管线提取正文预览；如果预览为空或质量较低，请结合本地路径继续判断。",
        "不要默认把文件写入知识库。",
        "只有当用户明确要求“入库 / 加入知识库 / 导入知识库”时，才使用知识库本地命令。",
        "",
        `用户需求：${instruction}`,
        `文件名：${fileName}`,
        `MIME：${downloaded.mimeType}`,
        `本地路径：${localPath}`,
        `来源文件消息：${pending.file.messageId}`,
        "已提取内容预览：",
        extractedPreview || "无",
        "",
        "如果用户只是要总结、识别、分析、改写或提问，请直接基于该文件完成任务。",
      ].join("\n"),
      promptParts,
    };
  }

  /**
   * 为默认文件识别 turn 提供轻量正文预览，失败时不阻断用户流程。
   */
  private async extractUploadedFilePreview(fileName: string, buffer: Buffer): Promise<string> {
    const parsed = await parseKnowledgeFile(fileName, buffer, this.config.knowledgeBase.parser).catch((error) => {
      this.logger.log("bridge/app", "uploaded file preview extraction failed", {
        fileName,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return null;
    });
    return parsed?.normalizedMarkdown.trim().slice(0, 4_000) ?? "";
  }

  /**
   * 将上传附件保存到 turn 级临时目录，并注册清理动作。
   */
  private async saveUploadedFileForTurn(turnId: string, fileName: string, buffer: Buffer): Promise<string> {
    const tempRoot = path.resolve(this.config.storage.dataDir, "turn-files");
    await mkdir(tempRoot, { recursive: true });
    const tempDir = await mkdtemp(path.join(tempRoot, "bridge-turn-file-"));
    const targetPath = path.join(tempDir, sanitizeUploadedFileName(fileName));
    await writeFile(targetPath, buffer);
    this.turnOwnedResources.register(turnId, { path: tempDir });
    return targetPath;
  }

  /**
   * 校验普通附件的扩展名与大小限制。
   */
  private validateRegularFileInput(fileName: string, sizeBytes?: number): void {
    const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (!REGULAR_FILE_ALLOWED_EXTENSIONS.includes(extension as typeof REGULAR_FILE_ALLOWED_EXTENSIONS[number])) {
      throw new Error(`仅支持 ${REGULAR_FILE_ALLOWED_EXTENSIONS.join(" / ")} 文件`);
    }
    if (typeof sizeBytes !== "number") {
      return;
    }
    if (sizeBytes <= 0) {
      throw new Error("文件为空，请重新上传包含内容的文件");
    }
    const maxSizeBytes = this.config.knowledgeBase.ingest.maxFileSizeMb * 1024 * 1024;
    if (sizeBytes > maxSizeBytes) {
      throw new Error(`文件过大，请控制在 ${this.config.knowledgeBase.ingest.maxFileSizeMb}MB 以内`);
    }
  }

  // #endregion

  // #region 服务探活与全局事件

  /**
   * 在正式入队前确认 OpenCode 服务当前可用。
   */
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

  /**
   * 处理全局 session 状态事件，并维护本地状态快照。
   */
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

  // #endregion

  // #region 会话窗口存储

  /**
   * 读取并规范化指定窗口的 session 记录。
   */
  private getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord {
    const mode = resolveSessionMode(chatType, this.config.bridge.sessionModes);
    return normalizeSessionWindowRecord(this.sessionMap[this.resolveSessionWindowKey(conversationKey, chatType)], mode, this.config.bridge.maxSessionsPerWindow);
  }

  /**
   * 保存窗口状态，并处理空窗口和旧键兼容。
   */
  private async saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void> {
    const storageKey = this.resolveSessionWindowKey(conversationKey);
    const legacyKey = this.resolveLegacyP2pWindowKey(conversationKey);
    if (window.sessions.length === 0 && window.interactionMode !== "knowledge" && !window.modelOverride) {
      delete this.sessionMap[storageKey];
    } else {
      this.sessionMap[storageKey] = window;
    }
    if (legacyKey) {
      delete this.sessionMap[legacyKey];
    }
    await this.mappings.save(this.sessionMap);
  }

  /**
   * 解析窗口存储键，并在需要时迁移旧版单聊键。
   */
  private resolveSessionWindowKey(conversationKey: string, chatType?: string): string {
    if (chatType === "p2p" && conversationKey.endsWith(":main")) {
      const legacyKey = this.resolveLegacyP2pWindowKey(conversationKey);
      if (legacyKey && this.sessionMap[legacyKey]) {
        this.sessionMap[conversationKey] = this.mergeSessionWindows(
          this.sessionMap[conversationKey],
          this.sessionMap[legacyKey],
          chatType,
        );
        delete this.sessionMap[legacyKey];
      }
    }

    return conversationKey;
  }

  /**
   * 返回旧版 p2p 窗口键；如果不是旧格式则返回 null。
   */
  private resolveLegacyP2pWindowKey(conversationKey: string): string | null {
    if (!conversationKey.endsWith(":main")) {
      return null;
    }
    return conversationKey.slice(0, -":main".length);
  }

  /**
   * 合并当前窗口与旧版窗口记录，并重新规范化。
   */
  private mergeSessionWindows(
    current: SessionWindowRecord | undefined,
    legacy: SessionWindowRecord,
    chatType?: string,
  ): SessionWindowRecord {
    const mode = resolveSessionMode(chatType, this.config.bridge.sessionModes);
    if (!current) {
      return normalizeSessionWindowRecord(legacy, mode, this.config.bridge.maxSessionsPerWindow);
    }

    return normalizeSessionWindowRecord({
      mode,
      ...((current.interactionMode ?? legacy.interactionMode) ? { interactionMode: current.interactionMode ?? legacy.interactionMode } : {}),
      ...((current.modelOverride ?? legacy.modelOverride) ? { modelOverride: current.modelOverride ?? legacy.modelOverride } : {}),
      activeSessionId: current.activeSessionId ?? legacy.activeSessionId,
      sessions: [...current.sessions, ...legacy.sessions],
    }, mode, this.config.bridge.maxSessionsPerWindow);
  }

  // #endregion

  // #region Session 管理

  /**
   * 创建新 session，并立即绑定到当前窗口且设为活跃。
   */
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

  /**
   * 将已有 session 绑定进窗口，但不切换当前活跃 session。
   */
  private async bindSessionWithoutActivating(
    source: SessionSource,
    entry: SessionBindingRecord,
  ): Promise<SessionBindingRecord> {
    const window = this.getSessionWindow(source.conversationKey, source.chatType);
    const nextWindow = addSessionWithoutActivating(window, entry, this.config.bridge.maxSessionsPerWindow);
    await this.saveSessionWindow(source.conversationKey, nextWindow);
    return entry;
  }

  /**
   * 仅在 OpenCode 侧创建 session，并返回本地绑定记录。
   */
  private async createDetachedSession(
    source: SessionSource,
    preferredLabel?: string,
  ): Promise<SessionBindingRecord> {
    const normalizedLabel = preferredLabel?.trim() || "新会话";
    const session = await this.opencode.createSession(preferredLabel?.trim() || buildSessionTitle(source.chatId, source.chatType, source.threadKey));
    return createSessionEntry(session.id, Date.now(), normalizedLabel);
  }

  /**
   * 为新建但未绑定的 session 注册临时锚点，便于后续认领。
   */
  private registerPendingNewSessionAnchor(replyMessageId: string, sourceConversationKey: string, entry: SessionBindingRecord): void {
    this.clearPendingNewSessionAnchor(replyMessageId);
    this.pendingNewSessionAnchors.set(replyMessageId, {
      replyMessageId,
      sourceConversationKey,
      entry,
      expiresAt: Date.now() + PENDING_NEW_SESSION_TTL_MS,
    });
    const timer = setTimeout(() => {
      this.clearPendingNewSessionAnchor(replyMessageId);
    }, PENDING_NEW_SESSION_TTL_MS);
    this.pendingNewSessionAnchorTimers.set(replyMessageId, timer);
  }

  /**
   * 清理某个待认领 session 锚点及其超时器。
   */
  private clearPendingNewSessionAnchor(replyMessageId: string): void {
    this.pendingNewSessionAnchors.delete(replyMessageId);
    const timer = this.pendingNewSessionAnchorTimers.get(replyMessageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingNewSessionAnchorTimers.delete(replyMessageId);
    }
  }

  /**
   * 在 session 仍为默认名时，尝试根据用户首条输入补齐标题。
   */
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

  /**
   * 获取当前所有 OpenCode sessions，并按 id 建立索引。
   */
  private async listOpenCodeSessionsById(): Promise<Map<string, OpenCodeSession>> {
    const sessions = await this.opencode.listSessions();
    return new Map(sessions.map((session) => [session.id, session]));
  }

  /**
   * 返回指定 session 的消息数量；失败时降级为 0。
   */
  private async getSessionMessageCount(sessionId: string): Promise<number> {
    try {
      return (await this.opencode.getSessionMessages(sessionId, 200)).length;
    } catch {
      return 0;
    }
  }

  /**
   * 启动时用 OpenCode 元数据回填本地缓存中的 session 标题。
   */
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

  // #endregion

  // #region 挂起交互状态管理

  /**
   * 设置当前窗口的挂起交互，并按类型注册超时器。
   */
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

  /**
   * 清理当前窗口的挂起交互，并在需要时保留非过期类型。
   */
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

  /**
   * 仅在挂起交互属于当前 turn 时才执行清理，避免误删。
   */
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

  /**
   * 处理权限请求超时，并交给权限管理器做收尾。
   */
  private async handlePermissionTimeout(conversationKey: string, pending: PendingPermissionInteraction): Promise<void> {
    const current = this.pendingInteractions.get(conversationKey);
    if (!current || current.kind !== "permission" || current.permissionId !== pending.permissionId) {
      return;
    }

    await this.permissionManager.expireInteraction(current, true);
  }

  // #endregion

  // #region Session 指令解析

  /**
   * 判断指定 session 当前是否仍在执行中。
   */
  private isSessionBusy(conversationKey: string, sessionId: string): boolean {
    const active = this.queues.getIfExists(this.buildExecutionKey(conversationKey, sessionId))?.peek()
      ?? this.queues.getIfExists(conversationKey)?.peek();
    return active?.sessionId === sessionId;
  }

  /**
   * 将 `/switch 2`、`/close 1` 这类索引命令解析为真实 session。
   */
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

  /**
   * 将会话区间命令解析为一组去重后的目标 sessions。
   */
  private async resolveSessionCommandTargets(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey">,
    range: { start: number; end: number },
  ): Promise<
    | { ok: true; window: SessionWindowRecord; sessions: SessionWindowRecord["sessions"]; indices: number[] }
    | { ok: false; message: string }
  > {
    const indices = buildSessionRangeIndices(range);
    if (indices.length === 0) {
      return { ok: false, message: "无效的会话编号范围，请重新输入。" };
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

  // #endregion

  // #region 飞书消息发送

  /**
   * 将统一 payload 转换为飞书 interactive card content。
   */
  private toCardContent(payload: FeishuPostPayload): Record<string, unknown> {
    return toInteractiveCardContent(payload);
  }

  /**
   * 发送一条简短 Markdown 消息。
   */
  private async sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<void> {
    await this.sendPayload(chatId, buildPostMarkdownPayload(markdown), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(markdown),
      len: markdown.length,
    }, replyToMessageId ? { replyToMessageId } : undefined);
  }

  /**
   * 统一发送飞书消息，并记录传输日志。
   */
  private async sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
    handoffSummary?: BridgeOutputContext | undefined,
  ): Promise<{ messageId: string }> {
    const transportAction = delivery?.replyToMessageId
      ? "reply"
      : "send";
    try {
      const result = delivery?.replyToMessageId && delivery.replyInThread !== undefined
        ? await this.outbound.replyMessage(delivery.replyToMessageId, payload, { replyInThread: delivery.replyInThread })
        : this.config.feishu.behavior.replyInThread && delivery?.replyToMessageId
          ? await this.outbound.replyMessage(delivery.replyToMessageId, payload)
          : await this.outbound.sendMessage(chatId, payload);
      logEvent(this.logger, "feishu/reply", "transport.sent", {
        chatId,
        messageId: result.messageId,
        transportAction,
        payloadKind: payload.msg_type === "interactive" ? "card" : "post",
        legacyEvent: options.event,
        textPreview: options.textPreview,
        len: options.len,
      });
      this.logger.logTranscript(options.transcriptType, { chatId, messageId: result.messageId }, prettyPrintPayload(payload));
      this.messageContextStore.rememberBridgeOutput({
        messageId: result.messageId,
        chatId,
        replyToMessageId: delivery?.replyToMessageId,
        summary: options.textPreview,
        handoffSummary: handoffSummary ?? buildDefaultBridgeOutputContext(options, result.messageId),
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logEvent(this.logger, "feishu/reply", "transport.failed", {
        chatId,
        transportAction,
        payloadKind: payload.msg_type === "interactive" ? "card" : "post",
        legacyEvent: options.event,
        errorKind: error instanceof Error ? error.name : "unknown",
        detail,
      }, "warn");
      throw error;
    }
  }

  /**
   * 原位更新已发送的飞书消息或卡片。
   */
  private async updatePayload(
    chatId: string,
    messageId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    handoffSummary?: BridgeOutputContext | undefined,
  ): Promise<{ messageId: string }> {
    try {
      const result = await this.outbound.updateMessage(messageId, payload);
      logEvent(this.logger, "feishu/reply", "transport.sent", {
        chatId,
        messageId: result.messageId,
        transportAction: "update",
        payloadKind: payload.msg_type === "interactive" ? "card" : "post",
        legacyEvent: options.event,
        textPreview: options.textPreview,
        len: options.len,
      });
      this.logger.logTranscript(options.transcriptType, { chatId, messageId: result.messageId }, prettyPrintPayload(payload));
      this.messageContextStore.rememberBridgeOutput({
        messageId: result.messageId,
        chatId,
        summary: options.textPreview,
        handoffSummary: handoffSummary ?? buildDefaultBridgeOutputContext(options, result.messageId),
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logEvent(this.logger, "feishu/reply", "transport.failed", {
        chatId,
        messageId,
        transportAction: "update",
        payloadKind: payload.msg_type === "interactive" ? "card" : "post",
        legacyEvent: options.event,
        errorKind: error instanceof Error ? error.name : "unknown",
        detail,
      }, "warn");
      throw error;
    }
  }

  // #endregion

  // #region 日志上下文

  /**
   * 为当前 turn 组装统一的日志上下文字段。
   */
  private buildTurnLogContext(
    message: Pick<IncomingChatMessage, "chatId" | "senderOpenId" | "messageId">,
    turnId: string,
    sessionId?: string,
  ): LogContext {
    return {
      ...getLogContext(),
      turnId,
      chatId: message.chatId,
      userId: message.senderOpenId,
      messageId: message.messageId,
      sessionId,
    };
  }

  // #endregion
}

function sanitizeUploadedFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeName = base || "uploaded-file";
  const safeExt = parsed.ext.replace(/[^a-zA-Z0-9.]+/g, "");
  return `${safeName}${safeExt}`;
}

function normalizeDownloadedResourceFileName(
  downloadedFileName: string,
  mimeType: string,
  pending: PendingFileInstructionInteraction,
): string {
  const extension = path.extname(downloadedFileName).toLowerCase();
  if (extension) {
    return downloadedFileName;
  }
  const pendingExtension = path.extname(pending.file.fileName).toLowerCase();
  if (pendingExtension) {
    return `${downloadedFileName}${pendingExtension}`;
  }
  const mimeExtension = extensionFromMimeType(mimeType);
  return mimeExtension ? `${downloadedFileName}${mimeExtension}` : downloadedFileName;
}

function buildDefaultBridgeOutputContext(
  options: { event: string; transcriptType: TranscriptType; textPreview: string },
  messageId: string,
): BridgeOutputContext | undefined {
  const summary = createTextPreview(options.textPreview);
  if (!summary) {
    return undefined;
  }
  const kind = inferBridgeOutputKind(options.event, options.transcriptType);
  return {
    kind,
    title: inferBridgeOutputTitle(kind, options.event),
    summary,
    keyPoints: [summary],
    sourceMessageId: messageId,
    createdAt: Date.now(),
  };
}

function inferBridgeOutputKind(event: string, transcriptType: TranscriptType): BridgeOutputContext["kind"] {
  if (event.includes("labor")) return "labor-result";
  if (event.includes("knowledge")) return "knowledge-result";
  if (event.includes("contract") || event.includes("invoice") || event.includes("case")) return "contract-result";
  if (event.includes("file")) return "file-result";
  if (transcriptType === "outbound-final") return "opencode-final";
  return "system-result";
}

function inferBridgeOutputTitle(kind: BridgeOutputContext["kind"], event: string): string {
  switch (kind) {
    case "labor-result":
      return "劳动分析结果";
    case "knowledge-result":
      return "知识库结果";
    case "contract-result":
      return "合同/案件处理结果";
    case "file-result":
      return "文件处理结果";
    case "opencode-final":
      return "OpenCode 回复";
    default:
      return event || "Bridge 输出";
  }
}

type PermissionTextResolution = "once" | "always" | "deny";

function parsePermissionTextResolution(text: string): PermissionTextResolution | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (["/allow once", "allow once", "/允许一次", "允许一次", "/仅此一次", "仅此一次"].includes(normalized)) {
    return "once";
  }
  if (["/allow always", "allow always", "/始终允许", "始终允许", "/总是允许", "总是允许"].includes(normalized)) {
    return "always";
  }
  if (["/deny", "deny", "/拒绝", "拒绝"].includes(normalized)) {
    return "deny";
  }
  return null;
}

function shouldBypassQuestionForBusinessEntrypoint(message: IncomingChatMessage): boolean {
  if (message.messageType !== "text" && message.messageType !== "post") {
    return false;
  }
  const normalized = message.plainText.replace(/\s+/g, "");
  // 保护明确的新业务入口，避免 OpenCode 的挂起 question 把“启动案件工作台”等指令吞掉。
  return /(启动|打开|进入|开启)?(案件工作台|办案工作台)/.test(normalized);
}

function buildUploadedResourcePromptParts(
  fileName: string,
  mimeType: string,
  buffer: Buffer,
  resourceType?: "file" | "image" | "folder",
): OpenCodePromptPart[] | undefined {
  const extension = path.extname(fileName).toLowerCase();
  const imageMimeType = mimeType.startsWith("image/")
    ? mimeType
    : resourceType === "image"
      ? mimeTypeFromImageExtension(extension)
      : undefined;
  if (!imageMimeType) {
    return undefined;
  }
  return [{
    type: "file",
    mime: imageMimeType,
    filename: fileName,
    url: `data:${imageMimeType};base64,${buffer.toString("base64")}`,
  }];
}

function extensionFromMimeType(mimeType: string): string | undefined {
  if (mimeType.includes("jpeg")) return ".jpg";
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("pdf")) return ".pdf";
  if (mimeType.includes("text/markdown")) return ".md";
  if (mimeType.startsWith("text/")) return ".txt";
  if (mimeType.includes("wordprocessingml.document")) return ".docx";
  return undefined;
}

function mimeTypeFromImageExtension(extension: string): string | undefined {
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    default:
      return undefined;
  }
}
