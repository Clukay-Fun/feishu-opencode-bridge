/**
 * 职责: 将知识库能力接入运行时模块体系。
 * 关注点:
 * - 拦截知识查询、摄入相关命令并切换交互流程。
 * - 管理知识摄入过程中的挂起状态与卡片更新。
 * - 在需要时向模型注入知识检索相关上下文。
 */
import path from "node:path";

import type { AppConfig } from "../config/schema.js";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import type { PendingFileInstructionInteraction, PendingKnowledgeIngestInteraction } from "../bridge/state.js";
import {
  buildKnowledgeIngestFailurePayload,
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestReadyPayload,
  buildKnowledgeIngestCompletedPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
} from "../feishu/knowledge-cards.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  resolveNoticeLevelFromTemplate,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "../feishu/shared-primitives.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import { PersistedInteractionManager } from "../runtime/persisted-interaction-manager.js";
import {
  getActiveSession,
  setActiveSession,
  setInteractionMode,
  updateSessionLabel,
} from "../runtime/session-windows.js";
import type { SessionBindingRecord, BridgeWindowRecord } from "../store/mappings.js";
import {
  buildActiveKnowledgeIngestFile,
  parseActiveKnowledgeIngestRecords,
  type ActiveKnowledgeIngestRecordMap,
} from "../store/active-ingests.js";
import { routeIncomingText, type RoutedText } from "../bridge/router.js";
import { detectKnowledgeWebIngest } from "./detector.js";
import {
  type KnowledgeBasePort,
  type KnowledgeIngestProgressStep,
  type KnowledgeIngestProgressUpdate,
  type KnowledgeIngestResult,
  type KnowledgeQueryResult,
} from "./index.js";

type KnowledgeIngestQueueItem = {
  conversationKey: string;
  chatId: string;
  requesterOpenId: string;
  receiptMessageId?: string | undefined;
  processingMessageId?: string | undefined;
  progressState: KnowledgeIngestProgressState;
} & (
  | {
    kind: "file";
    messageId: string;
    fileKey: string;
    fileName: string;
    size?: number | undefined;
    resourceType?: "file" | "image" | "folder" | undefined;
  }
  | {
    kind: "web";
    messageId: string;
    url: string;
    instruction: string;
  }
);

type KnowledgeIngestQueueState = {
  active: boolean;
  closing: boolean;
  activeItem?: KnowledgeIngestQueueItem | undefined;
  currentLabel?: string | undefined;
  batchMessageId?: string | undefined;
  pending: KnowledgeIngestQueueItem[];
};

type KnowledgeIngestSessionStats = {
  startedAt: number;
  completedCount: number;
  failedCount: number;
  totalExtractedCount: number;
  totalDedupedCount: number;
  bitableUrl?: string | undefined;
  results: Array<KnowledgeIngestResult & { elapsedMs?: number | undefined }>;
  failures: Array<{ sourceFile: string; reason: string; elapsedMs?: number | undefined }>;
};

type KnowledgeRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  knowledge: KnowledgeBasePort | null;
  transport: FeishuTransport;
  getSessionWindow(conversationKey: string, chatType?: string): BridgeWindowRecord;
  saveSessionWindow(conversationKey: string, chatType: string | undefined, window: BridgeWindowRecord): Promise<void>;
  createAndBindSession(source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<SessionBindingRecord>;
  whitelistBind(chatId: string, openId: string): Promise<void>;
};

type KnowledgeCommand = Extract<RoutedText, { kind: "command" }>["command"];

export class KnowledgeRuntimeModule implements RuntimeModule {
  readonly name = "knowledge";
  readonly priority = 20;
  readonly interactions: PersistedInteractionManager<PendingKnowledgeIngestInteraction>;

  private readonly runningKnowledgeIngests = new Map<string, { requesterOpenId: string }>();
  private readonly knowledgeIngestQueues = new Map<string, KnowledgeIngestQueueState>();
  private readonly knowledgeIngestSessionStats = new Map<string, KnowledgeIngestSessionStats>();

  constructor(private readonly deps: KnowledgeRuntimeModuleDeps) {
    this.interactions = new PersistedInteractionManager({
      stateFilePath: path.join(deps.config.storage.dataDir, "active-knowledge-ingests.json"),
      logger: deps.logger,
      logScope: "knowledge/ingest",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
      onExpire: async (interaction) => {
        await this.handleExpiredKnowledgeIngest(interaction);
      },
      deserialize: (value) => Object.values(parseActiveKnowledgeIngestRecords(value)).map((record) => ({
        ...record,
        kind: "knowledge-ingest-await-file" as const,
        replyToMessageId: record.anchorMessageId,
      })),
      serialize: (interactions) => buildActiveKnowledgeIngestFile(
        Object.fromEntries(interactions.map((interaction) => [interaction.conversationKey, interaction])) as ActiveKnowledgeIngestRecordMap,
      ),
    });
  }

  // #region 生命周期与入口

  /** 恢复持久化状态，并在可用时同步知识镜像。 */
  async start(): Promise<void> {
    await this.interactions.restore();
    await this.interruptPersistedKnowledgeIngests();
    if (!this.deps.knowledge) {
      return;
    }
    try {
      await this.deps.knowledge.syncMirror();
    } catch (error) {
      this.deps.logger.log("knowledge/sync", "mirror sync skipped", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  /** 清理计时器并关闭知识库资源。 */
  async stop(): Promise<void> {
    await this.interactions.stop();
    this.deps.knowledge?.close();
  }

  /** 处理知识查询、知识入库和知识模式相关输入。 */
  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    const activeKnowledgeIngest = this.findKnowledgeIngestInteraction(message);
    if (activeKnowledgeIngest) {
      if (message.messageType === "text" && matchesKnowledgeIngestEndInstruction(message.plainText)) {
        await this.endKnowledgeIngestInteraction(message, activeKnowledgeIngest, { replyToMessageId: message.messageId });
        return { claimed: true };
      }

      const consumed = await this.enqueueKnowledgeIngestInput(message, activeKnowledgeIngest);
      if (consumed) {
        return { claimed: true };
      }
    }

    if (routed?.kind === "command") {
      const claimed = await this.handleKnowledgeCommand(message, routed.command);
      if (claimed) {
        return { claimed: true };
      }
      return { claimed: false };
    }

    const backgroundKnowledgeIngest = this.getInteraction(message.conversationKey);
    if (backgroundKnowledgeIngest) {
      await this.restoreOrCreateNormalSessionForBackgroundIngest(message, backgroundKnowledgeIngest);
    }

    return { claimed: false };
  }

  async claimFileInstruction(
    pending: PendingFileInstructionInteraction,
    message: IncomingChatMessage,
  ): Promise<boolean> {
    if (message.messageType === "file" || message.senderOpenId !== pending.requesterOpenId) {
      return false;
    }
    if (!matchesKnowledgeIngestInstruction(message.plainText)) {
      return false;
    }
    await this.startKnowledgeIngestFromPendingFile(pending, message);
    return true;
  }

  /** 获取当前窗口的知识入库挂起状态。 */
  getInteraction(conversationKey: string): PendingKnowledgeIngestInteraction | null {
    return this.interactions.get(conversationKey) ?? null;
  }

  /** 清理指定窗口中的知识入库挂起状态与队列。 */
  async clearPending(conversationKey: string, chatType: string): Promise<boolean> {
    const pending = this.getInteraction(conversationKey);
    if (!pending) {
      return false;
    }
    if (pending.previousActiveSessionId) {
      await this.restorePreviousSessionForBackgroundIngest(conversationKey, chatType, pending);
    }
    this.clearKnowledgeIngestInteraction(conversationKey);
    this.knowledgeIngestQueues.delete(conversationKey);
    this.knowledgeIngestSessionStats.delete(conversationKey);
    return true;
  }

  // #endregion

  // #region 命令与交互流程

  /** 处理知识模块自有命令。 */
  private async handleKnowledgeCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
    command: KnowledgeCommand,
  ): Promise<boolean> {
    if (command.kind === "passthrough") {
      const legacyAlias = command.name.trim().toLowerCase();
      if (legacyAlias === "法律咨询开始") {
        return await this.handleKnowledgeCommand(message, { kind: "knowledge-mode-start" });
      }
      if (legacyAlias === "法律咨询结束") {
        return await this.handleKnowledgeCommand(message, { kind: "knowledge-mode-end" });
      }
      if (legacyAlias === "法律咨询" && command.arguments.length > 0) {
        await this.sendNotice(message, {
          title: "命令已更新",
          template: "yellow",
          icon: "maybe_outlined",
          message: "法律知识库问答入口已从 `/法律咨询 <问题>` 迁移到 `/法律问答 <问题>`；你这次的问题会继续按知识库检索处理。",
        });
        return await this.handleKnowledgeCommand(message, {
          kind: "knowledge-query",
          question: command.arguments.join(" ").trim(),
          explicit: true,
        });
      }
      if (legacyAlias === "legal-query-start") {
        await this.sendNotice(message, {
          title: "命令已更新",
          template: "yellow",
          icon: "maybe_outlined",
          message: message.chatType === "p2p"
            ? "私聊里不再使用 `/legal-query-start`。知识库问答请使用 `/法律问答 <问题>`；如需批量入库，请使用 `/知识入库`。"
            : "知识库模式入口已从 `/legal-query-start` 迁移到 `/法律咨询开始`。如需单次检索，也可以使用 `/法律问答 <问题>`。",
        });
        return true;
      }
      if (legacyAlias === "legal-query-end") {
        await this.sendNotice(message, {
          title: "命令已更新",
          template: "yellow",
          icon: "maybe_outlined",
          message: message.chatType === "p2p"
            ? "私聊里不再使用 `/legal-query-end`。知识库问答请使用 `/法律问答 <问题>`，不需要显式退出。"
            : "知识库模式退出命令已从 `/legal-query-end` 迁移到 `/法律咨询结束`。",
        });
        return true;
      }
      if (legacyAlias === "legal-query") {
        await this.sendNotice(message, {
          title: "命令已更新",
          template: "yellow",
          icon: "maybe_outlined",
          message: message.chatType === "p2p"
            ? "私聊里不再使用 `/legal-query <问题>`。知识库问答请使用 `/法律问答 <问题>`。"
            : "单次知识库检索已从 `/legal-query <问题>` 迁移到 `/法律问答 <问题>`；连续检索模式请使用 `/法律咨询开始`。",
        });
        return true;
      }
    }

    if (
      message.chatType === "p2p"
      && (
        command.kind === "knowledge-mode-start"
        || command.kind === "knowledge-mode-end"
        || (command.kind === "knowledge-query" && !command.explicit)
      )
    ) {
      const window = this.deps.getSessionWindow(message.conversationKey, message.chatType);
      if (window.interactionMode === "knowledge") {
        const nextWindow = setInteractionMode(window, "default", this.deps.config.bridge.maxSessionsPerWindow);
        await this.deps.saveSessionWindow(message.conversationKey, message.chatType, nextWindow);
      }
      await this.sendNotice(message, {
        title: "私聊里直接提问即可",
        template: "blue",
        icon: "search_outlined",
        message: "私聊不需要显式切换知识库模式。知识库问答请使用 `/法律问答 <问题>`；如需批量入库，请使用 `/知识入库`。",
      });
      return true;
    }

    if (command.kind === "knowledge-query") {
      if (!this.deps.knowledge) {
        await this.sendNotice(message, {
          title: "知识库未启用",
          template: "yellow",
          icon: "maybe_outlined",
          message: "当前未启用法律知识库，请联系部署者补充 knowledgeBase 配置。",
        });
        return true;
      }
      try {
        await this.sendKnowledgeQueryWithProgress(message, command.question);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.sendNotice(message, {
          title: "知识检索失败",
          template: "red",
          icon: "error_filled",
          message: detail,
        });
      }
      return true;
    }

    if (command.kind === "knowledge-ingest") {
      if (!this.deps.knowledge) {
        await this.sendNotice(message, {
          title: "知识库未启用",
          template: "yellow",
          icon: "maybe_outlined",
          message: "当前未启用法律知识库，请联系部署者补充 knowledgeBase 配置。",
        });
        return true;
      }
      const currentPending = this.getInteraction(message.conversationKey);
      if (currentPending?.requesterOpenId === message.senderOpenId) {
        await this.sendNotice(message, {
          title: "已在知识入库模式",
          template: "blue",
          icon: "upload_outlined",
          message: `请继续上传 ${formatKnowledgeAllowedExtensions(this.deps.config.knowledgeBase.ingest.allowedExtensions)} 文件；发送 \`知识入库完成\` 可退出。`,
        });
        return true;
      }
      const window = this.deps.getSessionWindow(message.conversationKey, message.chatType);
      const previousSession = getActiveSession(window);
      const entry = await this.deps.createAndBindSession(message);
      const nextWindow = updateSessionLabel(
        this.deps.getSessionWindow(message.conversationKey, message.chatType),
        entry.sessionId,
        "知识入库",
        this.deps.config.bridge.maxSessionsPerWindow,
      );
      await this.deps.saveSessionWindow(message.conversationKey, message.chatType, nextWindow);
      const deliveryMode = message.chatType === "p2p" ? "p2p_reply" : "group_thread";
      const ready = await this.sendPayload(message.chatId, buildKnowledgeIngestReadyPayload(this.deps.config.knowledgeBase.ingest.allowedExtensions), {
        event: "knowledge ingest pending",
        transcriptType: "outbound-final",
        textPreview: "已进入知识入库模式",
        len: 9,
      }, { replyToMessageId: message.messageId, replyInThread: deliveryMode === "group_thread" });
      this.setKnowledgeIngestInteraction(message.conversationKey, {
        kind: "knowledge-ingest-await-file",
        chatId: message.chatId,
        chatType: message.chatType,
        conversationKey: message.conversationKey,
        requesterOpenId: message.senderOpenId,
        replyToMessageId: ready.messageId,
        rootMessageId: message.messageId,
        anchorMessageId: ready.messageId,
        deliveryMode,
        ingestSessionId: entry.sessionId,
        previousActiveSessionId: previousSession?.sessionId ?? null,
        expiresAt: Date.now() + this.deps.config.knowledgeBase.ingest.sessionIdleMs,
      });
      if (message.chatType !== "p2p") {
        await this.deps.whitelistBind(message.chatId, message.senderOpenId);
      }
      return true;
    }

    if (command.kind === "knowledge-ingest-end") {
      const pending = this.getInteraction(message.conversationKey);
      if (!pending) {
        await this.sendNotice(message, {
          title: "当前未开启知识入库模式",
          template: "grey",
          icon: "info-hollow_filled",
          message: "发送 `/知识入库` 可进入知识入库模式。",
        });
        return true;
      }
      await this.endKnowledgeIngestInteraction(message, pending, { replyToMessageId: message.messageId });
      return true;
    }

    if (command.kind === "knowledge-mode-start") {
      if (!this.deps.knowledge) {
        await this.sendNotice(message, {
          title: "知识库未启用",
          template: "yellow",
          icon: "maybe_outlined",
          message: "当前未启用法律知识库，请联系部署者补充 knowledgeBase 配置。",
        });
        return true;
      }
      const clearedIngestPending = await this.clearPending(message.conversationKey, message.chatType);
      const window = this.deps.getSessionWindow(message.conversationKey, message.chatType);
      if (window.interactionMode === "knowledge") {
        await this.sendNotice(message, {
          title: "已在知识库模式",
          template: "blue",
          icon: "search_outlined",
          message: clearedIngestPending
            ? "已退出知识入库模式；当前仍是知识库模式。请使用 `/法律问答 <问题>` 检索知识库，发送 `/法律咨询结束` 可退出。"
            : "请使用 `/法律问答 <问题>` 检索知识库，发送 `/法律咨询结束` 可退出。",
        });
        return true;
      }
      const nextWindow = setInteractionMode(window, "knowledge", this.deps.config.bridge.maxSessionsPerWindow);
      await this.deps.saveSessionWindow(message.conversationKey, message.chatType, nextWindow);
      await this.sendNotice(message, {
        title: "已进入知识库模式",
        template: "indigo",
        icon: "search_outlined",
        message: clearedIngestPending
          ? "已退出知识入库模式，并切换到知识库查询模式。请使用 `/法律问答 <问题>` 检索知识库，发送 `/法律咨询结束` 可退出。"
          : "请使用 `/法律问答 <问题>` 检索知识库，发送 `/法律咨询结束` 可退出。",
      });
      return true;
    }

    if (command.kind === "knowledge-mode-end") {
      await this.clearPending(message.conversationKey, message.chatType);
      const window = this.deps.getSessionWindow(message.conversationKey, message.chatType);
      if (window.interactionMode !== "knowledge") {
        await this.sendNotice(message, {
          title: "当前未开启知识库模式",
          template: "grey",
          icon: "info-hollow_filled",
          message: "当前仍是普通对话模式，发送 `/法律咨询开始` 可进入知识库模式。",
        });
        return true;
      }
      const nextWindow = setInteractionMode(window, "default", this.deps.config.bridge.maxSessionsPerWindow);
      await this.deps.saveSessionWindow(message.conversationKey, message.chatType, nextWindow);
      await this.sendNotice(message, {
        title: "已退出知识库模式",
        template: "green",
        icon: "chat_outlined",
        message: "后续消息将恢复为普通 OpenCode 对话，仍可用 `/法律问答 <问题>` 单次检索知识库。",
      });
      return true;
    }

    return false;
  }

  private async startKnowledgeIngestFromPendingFile(
    pendingFile: PendingFileInstructionInteraction,
    message: IncomingChatMessage,
  ): Promise<void> {
    if (!this.deps.knowledge) {
      await this.sendNotice(message, {
        title: "知识库未启用",
        template: "yellow",
        icon: "maybe_outlined",
        message: "当前未启用法律知识库，请联系部署者补充 knowledgeBase 配置。",
      });
      return;
    }
    let pending = this.getInteraction(message.conversationKey);
    if (!pending || pending.requesterOpenId !== message.senderOpenId) {
      pending = await this.openKnowledgeIngestInteraction(message);
    }
    const fileMessage: IncomingChatMessage = {
      ...message,
      messageId: pendingFile.file.messageId,
      rawContent: pendingFile.file.fileName,
      plainText: pendingFile.file.fileName,
      messageType: "file",
      file: {
        fileKey: pendingFile.file.fileKey,
        fileName: pendingFile.file.fileName,
        size: pendingFile.file.size,
      },
      resourceType: pendingFile.resourceType,
    };
    await this.enqueueKnowledgeIngestInput(fileMessage, pending);
  }

  private async openKnowledgeIngestInteraction(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
  ): Promise<PendingKnowledgeIngestInteraction> {
    const window = this.deps.getSessionWindow(message.conversationKey, message.chatType);
    const previousSession = getActiveSession(window);
    const entry = await this.deps.createAndBindSession(message);
    const nextWindow = updateSessionLabel(
      this.deps.getSessionWindow(message.conversationKey, message.chatType),
      entry.sessionId,
      "知识入库",
      this.deps.config.bridge.maxSessionsPerWindow,
    );
    await this.deps.saveSessionWindow(message.conversationKey, message.chatType, nextWindow);
    const deliveryMode = message.chatType === "p2p" ? "p2p_reply" : "group_thread";
    const ready = await this.sendPayload(message.chatId, buildKnowledgeIngestReadyPayload(this.deps.config.knowledgeBase.ingest.allowedExtensions), {
      event: "knowledge ingest pending",
      transcriptType: "outbound-final",
      textPreview: "已进入知识入库模式",
      len: 9,
    }, { replyToMessageId: message.messageId, replyInThread: deliveryMode === "group_thread" });
    const interaction: PendingKnowledgeIngestInteraction = {
      kind: "knowledge-ingest-await-file",
      chatId: message.chatId,
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      replyToMessageId: ready.messageId,
      rootMessageId: message.messageId,
      anchorMessageId: ready.messageId,
      deliveryMode,
      ingestSessionId: entry.sessionId,
      previousActiveSessionId: previousSession?.sessionId ?? null,
      expiresAt: Date.now() + this.deps.config.knowledgeBase.ingest.sessionIdleMs,
    };
    this.setKnowledgeIngestInteraction(message.conversationKey, interaction);
    if (message.chatType !== "p2p") {
      await this.deps.whitelistBind(message.chatId, message.senderOpenId);
    }
    return interaction;
  }

  private async sendKnowledgeQueryWithProgress(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    question: string,
    knownResult?: KnowledgeQueryResult | undefined,
  ): Promise<void> {
    const processing = await this.sendPayload(
      message.chatId,
      buildNoticeCardPayload({
        title: "知识检索进行中",
        level: "info",
        message: `正在检索知识库...\n\n**问题**\n${question}`,
      }),
      {
        event: "knowledge query started",
        transcriptType: "outbound-process",
        textPreview: question,
        len: question.length,
      },
      { replyToMessageId: message.messageId },
    );
    const result = knownResult ?? await this.deps.knowledge?.query(question);
    await this.updatePayload(
      message.chatId,
      processing.messageId,
      result && result.results.length > 0 ? buildKnowledgeQueryPayload(result) : buildKnowledgeQueryEmptyPayload({ question }),
      {
        event: "knowledge query sent",
        transcriptType: "outbound-final",
        textPreview: question,
        len: question.length,
      },
    );
  }

  private async enqueueKnowledgeIngestInput(message: IncomingChatMessage, pending: PendingKnowledgeIngestInteraction): Promise<boolean> {
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendKnowledgeIngestMarkdown(pending, "当前入库任务仅允许发起人继续上传文件。");
      return true;
    }
    if (!this.deps.knowledge) {
      await this.sendKnowledgeIngestMarkdown(pending, "当前未启用法律知识库，请联系部署者补充 knowledgeBase 配置。");
      return true;
    }

    let sourceLabel: string;
    let itemInput:
      | Omit<Extract<KnowledgeIngestQueueItem, { kind: "file" }>, "receiptMessageId" | "processingMessageId" | "progressState">
      | Omit<Extract<KnowledgeIngestQueueItem, { kind: "web" }>, "receiptMessageId" | "processingMessageId" | "progressState">;
    if (message.messageType === "file") {
      sourceLabel = message.file.fileName;
      itemInput = {
        kind: "file",
        conversationKey: pending.conversationKey,
        chatId: message.chatId,
        requesterOpenId: pending.requesterOpenId,
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
        resourceType: message.resourceType,
      };
    } else {
      const webIngest = detectKnowledgeWebIngest(message.plainText, { requireIngestIntent: false });
      if (!webIngest.matched || !webIngest.url || !this.deps.knowledge.ingestWebPage) {
        await this.sendKnowledgeIngestMarkdown(pending, `请继续上传 ${formatKnowledgeAllowedExtensions(this.deps.config.knowledgeBase.ingest.allowedExtensions)} 文件，或直接发送网页 URL / 带 URL 的入库请求；发送 \`知识入库完成\` 退出。`);
        return true;
      }
      sourceLabel = webIngest.url;
      itemInput = {
        kind: "web",
        conversationKey: pending.conversationKey,
        chatId: message.chatId,
        requesterOpenId: pending.requesterOpenId,
        messageId: message.messageId,
        url: webIngest.url,
        instruction: message.plainText,
      };
    }

    const queue = this.getKnowledgeIngestQueue(pending.conversationKey);
    if (queue.closing) {
      await this.sendKnowledgeIngestMarkdown(pending, "已收到结束指令，当前队列处理完成后会自动结束。");
      return true;
    }
    const progressState = createKnowledgeIngestProgressState(sourceLabel);
    const queuedItem: KnowledgeIngestQueueItem = {
      ...itemInput,
      progressState,
    };
    if (this.hasKnowledgeIngestQueueDuplicate(pending.conversationKey, queuedItem)) {
      this.deps.logger.log("knowledge/ingest", "duplicate ingest item skipped", {
        conversationKey: pending.conversationKey,
        source: getKnowledgeIngestQueueItemLabel(queuedItem),
      }, "info");
      return true;
    }
    queue.pending.push(queuedItem);
    this.refreshKnowledgeIngestPending(pending.conversationKey, pending);
    return true;
  }

  private async processKnowledgeIngestQueue(conversationKey: string): Promise<void> {
    const queue = this.knowledgeIngestQueues.get(conversationKey);
    if (!queue || queue.active) {
      return;
    }
    queue.active = true;
    try {
      let item = queue.pending.shift();
      while (item) {
        const currentItem = item;
        const pending = this.getInteraction(conversationKey);
        if (!pending || !this.deps.knowledge) {
          break;
        }
        queue.activeItem = currentItem;
        queue.currentLabel = getKnowledgeIngestQueueItemLabel(currentItem);
        this.setRunningKnowledgeIngest(conversationKey, currentItem.requesterOpenId);
        await this.ensureKnowledgeIngestProcessingCard(queue, pending, currentItem);
        try {
          if (currentItem.kind === "web") {
            const result = await this.deps.knowledge.ingestWebPage!({
              url: currentItem.url,
              instruction: currentItem.instruction,
              messageId: currentItem.messageId,
            }, {
              onProgress: async (update) => {
                if (!queue.batchMessageId) {
                  return;
                }
                await this.updateKnowledgeIngestProgress(conversationKey, currentItem.chatId, queue.batchMessageId, currentItem.progressState, update);
              },
            });
            this.refreshKnowledgeIngestPending(conversationKey, pending);
            this.recordKnowledgeIngestResult(conversationKey, result, Date.now() - currentItem.progressState.startedAt);
          } else {
            const result = await this.deps.knowledge.ingestFile({
              messageId: currentItem.messageId,
              fileKey: currentItem.fileKey,
              fileName: currentItem.fileName,
              size: currentItem.size,
              resourceType: currentItem.resourceType,
            }, {
              onProgress: async (update) => {
                if (!queue.batchMessageId) {
                  return;
                }
                await this.updateKnowledgeIngestProgress(conversationKey, currentItem.chatId, queue.batchMessageId, currentItem.progressState, update);
              },
            });
            this.refreshKnowledgeIngestPending(conversationKey, pending);
            this.recordKnowledgeIngestResult(conversationKey, result, Date.now() - currentItem.progressState.startedAt);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const elapsedMs = Date.now() - currentItem.progressState.startedAt;
          this.recordKnowledgeIngestFailure(conversationKey, getKnowledgeIngestQueueItemLabel(currentItem), detail, elapsedMs);
          if (queue.batchMessageId) {
            await this.updatePayload(currentItem.chatId, queue.batchMessageId, buildKnowledgeIngestFailurePayload({
              sourceLabel: getKnowledgeIngestQueueItemLabel(currentItem),
              reason: detail,
              steps: currentItem.progressState.steps,
              elapsedMs,
            }), {
              event: currentItem.kind === "web" ? "knowledge web ingest failed" : "knowledge ingest failed",
              transcriptType: "outbound-final",
              textPreview: detail,
              len: detail.length,
            });
          }
        } finally {
          this.clearRunningKnowledgeIngest(conversationKey);
        }
        queue.currentLabel = undefined;
        queue.activeItem = undefined;
        item = queue.pending.shift();
      }
    } finally {
      queue.active = false;
      queue.currentLabel = undefined;
      queue.activeItem = undefined;
      let shouldUpdateSummary = true;
      if (queue.pending.length === 0) {
        if (queue.closing) {
          shouldUpdateSummary = false;
          const pending = this.getInteraction(conversationKey);
          if (pending) {
            await this.sendKnowledgeIngestFinalSummary(pending);
            await this.clearPending(conversationKey, pending.chatType);
          } else {
            this.knowledgeIngestQueues.delete(conversationKey);
          }
        } else {
          this.knowledgeIngestQueues.delete(conversationKey);
          shouldUpdateSummary = false;
        }
      }
      if (shouldUpdateSummary) {
        const pending = this.getInteraction(conversationKey);
        if (pending) {
          this.refreshKnowledgeIngestPending(conversationKey, pending);
        }
      }
    }
  }

  private getKnowledgeIngestQueue(conversationKey: string): KnowledgeIngestQueueState {
    const existing = this.knowledgeIngestQueues.get(conversationKey);
    if (existing) {
      return existing;
    }
    const queue: KnowledgeIngestQueueState = { active: false, closing: false, pending: [] };
    this.knowledgeIngestQueues.set(conversationKey, queue);
    return queue;
  }

  private hasKnowledgeIngestQueueDuplicate(conversationKey: string, item: KnowledgeIngestQueueItem): boolean {
    const queue = this.getKnowledgeIngestQueue(conversationKey);
    const itemKey = getKnowledgeIngestQueueItemKey(item);
    const sameItem = (candidate: KnowledgeIngestQueueItem): boolean => getKnowledgeIngestQueueItemKey(candidate) === itemKey;
    if (queue.activeItem && sameItem(queue.activeItem)) {
      return true;
    }
    if (queue.pending.some(sameItem)) {
      return true;
    }
    const stats = this.getKnowledgeIngestSessionStats(conversationKey);
    const label = getKnowledgeIngestQueueItemLabel(item);
    return stats.results.some((result) => result.sourceFile === label)
      || stats.failures.some((failure) => failure.sourceFile === label);
  }

  private getKnowledgeIngestSessionStats(conversationKey: string): KnowledgeIngestSessionStats {
    const existing = this.knowledgeIngestSessionStats.get(conversationKey);
    if (existing) {
      return existing;
    }
    const stats: KnowledgeIngestSessionStats = {
      startedAt: Date.now(),
      completedCount: 0,
      failedCount: 0,
      totalExtractedCount: 0,
      totalDedupedCount: 0,
      results: [],
      failures: [],
    };
    this.knowledgeIngestSessionStats.set(conversationKey, stats);
    return stats;
  }

  private recordKnowledgeIngestResult(conversationKey: string, result: KnowledgeIngestResult, elapsedMs?: number): void {
    const stats = this.getKnowledgeIngestSessionStats(conversationKey);
    const rawExtractedCount = result.rawExtractedCount ?? result.extractedCount;
    stats.completedCount += 1;
    stats.totalExtractedCount += result.extractedCount;
    stats.totalDedupedCount += result.dedupedCount ?? Math.max(0, rawExtractedCount - result.extractedCount);
    stats.bitableUrl = result.bitableUrl ?? stats.bitableUrl;
    stats.results.push({ ...result, elapsedMs });
  }

  private recordKnowledgeIngestFailure(conversationKey: string, sourceFile: string, reason: string, elapsedMs?: number): void {
    const stats = this.getKnowledgeIngestSessionStats(conversationKey);
    stats.failedCount += 1;
    stats.failures.push({ sourceFile, reason, elapsedMs });
  }

  private async sendKnowledgeIngestFinalSummary(pending: PendingKnowledgeIngestInteraction): Promise<void> {
    const stats = this.getKnowledgeIngestSessionStats(pending.conversationKey);
    if (stats.completedCount + stats.failedCount === 0) {
      return;
    }
    const payload = buildKnowledgeIngestCompletedPayload({
      completedCount: stats.completedCount,
      failedCount: stats.failedCount,
      queuedCount: 0,
      totalExtractedCount: stats.totalExtractedCount,
      totalDedupedCount: stats.totalDedupedCount,
      elapsedMs: Date.now() - stats.startedAt,
      bitableUrl: stats.bitableUrl,
      results: stats.results,
      failures: stats.failures,
    });
    const finalSummaryPreview = stats.completedCount === 0 && stats.failedCount > 0
      ? "知识入库失败汇总"
      : stats.failedCount > 0
        ? "知识入库部分完成汇总"
        : "知识入库完成汇总";
    const queue = this.knowledgeIngestQueues.get(pending.conversationKey);
    if (queue?.batchMessageId) {
      await this.updatePayload(pending.chatId, queue.batchMessageId, payload, {
        event: "knowledge ingest session final summary updated",
        transcriptType: "outbound-final",
        textPreview: finalSummaryPreview,
        len: finalSummaryPreview.length,
      });
      return;
    }
    await this.sendPayload(pending.chatId, payload, {
      event: "knowledge ingest session final summary sent",
      transcriptType: "outbound-final",
      textPreview: finalSummaryPreview,
      len: finalSummaryPreview.length,
    }, this.getKnowledgeIngestDelivery(pending));
  }

  private findKnowledgeIngestInteraction(message: IncomingChatMessage): PendingKnowledgeIngestInteraction | null {
    const direct = this.getInteraction(message.conversationKey);
    if (direct && this.isMessageInKnowledgeIngestChain(message, direct)) {
      return direct;
    }
    if (
      direct
      && message.chatType === "p2p"
      && message.messageType === "text"
      && direct.requesterOpenId === message.senderOpenId
      && matchesKnowledgeIngestEndInstruction(message.plainText)
    ) {
      return direct;
    }

    for (const pending of this.interactions.values()) {
      if (pending.conversationKey === message.conversationKey) {
        continue;
      }
      if (this.isMessageInKnowledgeIngestChain(message, pending)) {
        return pending;
      }
    }

    if (message.chatType !== "p2p" || message.messageType === "file") {
      const sameChatRequesterMatches = [...this.interactions.values()]
        .filter((pending) => pending.chatId === message.chatId && pending.requesterOpenId === message.senderOpenId);
      if (sameChatRequesterMatches.length === 1) {
        return sameChatRequesterMatches[0] ?? null;
      }
    }

    return null;
  }

  private isMessageInKnowledgeIngestChain(message: IncomingChatMessage, pending: PendingKnowledgeIngestInteraction): boolean {
    if (message.chatId !== pending.chatId) {
      return false;
    }
    if (message.chatType === "p2p") {
      return message.rootId === pending.anchorMessageId
        || message.parentId === pending.anchorMessageId
        || message.rootId === pending.rootMessageId
        || message.parentId === pending.rootMessageId;
    }
    const candidates = new Set([
      message.rootId,
      message.parentId,
      message.threadKey,
    ].filter((value): value is string => Boolean(value)));
    return message.conversationKey === pending.conversationKey
      || candidates.has(pending.anchorMessageId)
      || candidates.has(pending.rootMessageId);
  }

  private async endKnowledgeIngestInteraction(
    message: Pick<IncomingChatMessage, "messageId" | "senderOpenId">,
    pending: PendingKnowledgeIngestInteraction,
    delivery?: { replyToMessageId: string },
  ): Promise<void> {
    if (pending.requesterOpenId !== message.senderOpenId) {
      await this.sendPayload(pending.chatId, buildNoticeCardPayload({
        title: "无法结束入库模式",
        level: "warning",
        message: "当前入库模式仅允许发起人结束。",
        showMessageIcon: false,
      }), {
        event: "knowledge ingest end rejected",
        transcriptType: "outbound-final",
        textPreview: "当前入库模式仅允许发起人结束。",
        len: 16,
      }, delivery ?? this.getKnowledgeIngestDelivery(pending));
      return;
    }
    const queue = this.knowledgeIngestQueues.get(pending.conversationKey);
    let endedImmediately = true;
    if (queue && (queue.active || queue.pending.length > 0)) {
      endedImmediately = false;
      queue.closing = true;
      void this.processKnowledgeIngestQueue(pending.conversationKey);
    } else {
      await this.sendKnowledgeIngestFinalSummary(pending);
      await this.clearPending(pending.conversationKey, pending.chatType);
    }
    if (!delivery || !endedImmediately) {
      return;
    }
    await this.sendPayload(pending.chatId, buildNoticeCardPayload({
      title: "已退出知识入库模式",
      level: "info",
      message: "后续文件消息将不再自动入库；如需继续入库，请发送 `/知识入库`。",
      showMessageIcon: false,
    }), {
      event: "knowledge ingest ended",
      transcriptType: "outbound-final",
      textPreview: "已退出知识入库模式",
      len: 9,
    }, delivery);
  }

  private setKnowledgeIngestInteraction(conversationKey: string, interaction: PendingKnowledgeIngestInteraction): void {
    this.clearKnowledgeIngestInteraction(conversationKey, { keepPersisted: true });
    this.interactions.set(interaction);
    this.getKnowledgeIngestSessionStats(conversationKey);
  }

  private clearKnowledgeIngestInteraction(
    conversationKey: string,
    options?: { keepPersisted?: boolean },
  ): void {
    if (!options?.keepPersisted) {
      this.interactions.delete(conversationKey);
    }
  }

  private async handleExpiredKnowledgeIngest(pending: PendingKnowledgeIngestInteraction): Promise<void> {
    if (this.runningKnowledgeIngests.has(pending.conversationKey)) {
      this.setKnowledgeIngestInteraction(pending.conversationKey, {
        ...pending,
        expiresAt: Date.now() + this.deps.config.knowledgeBase.ingest.sessionIdleMs,
      });
      return;
    }
    await this.sendKnowledgeIngestFinalSummary(pending);
    if (pending.previousActiveSessionId) {
      await this.restorePreviousSessionForBackgroundIngest(pending.conversationKey, pending.chatType, pending);
    }
    this.knowledgeIngestQueues.delete(pending.conversationKey);
    this.knowledgeIngestSessionStats.delete(pending.conversationKey);
    await this.sendPayload(pending.chatId, buildNoticeCardPayload({
      title: "入库任务已超时",
      level: "warning",
      message: "长时间未收到新的入库素材，已结束当前入库任务。需要继续时请重新发送 `/知识入库`。",
      showMessageIcon: false,
    }), {
      event: "knowledge ingest timed out",
      transcriptType: "outbound-final",
      textPreview: "入库任务已超时",
      len: 7,
    }, this.getKnowledgeIngestDelivery(pending));
  }

  private async sendKnowledgeIngestMarkdown(pending: PendingKnowledgeIngestInteraction, markdown: string): Promise<void> {
    await this.sendPayload(pending.chatId, buildPostMarkdownPayload(markdown), {
      event: "knowledge ingest notice sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(markdown),
      len: markdown.length,
    }, this.getKnowledgeIngestDelivery(pending));
  }

  private getKnowledgeIngestDelivery(pending: PendingKnowledgeIngestInteraction): { replyToMessageId: string; replyInThread: boolean } {
    return {
      replyToMessageId: pending.anchorMessageId,
      replyInThread: pending.deliveryMode === "group_thread",
    };
  }

  private setRunningKnowledgeIngest(conversationKey: string, requesterOpenId: string): void {
    this.runningKnowledgeIngests.set(conversationKey, { requesterOpenId });
  }

  private clearRunningKnowledgeIngest(conversationKey: string): void {
    this.runningKnowledgeIngests.delete(conversationKey);
  }

  private refreshKnowledgeIngestPending(
    conversationKey: string,
    pending: PendingKnowledgeIngestInteraction,
  ): void {
    const current = this.getInteraction(conversationKey);
    if (!current || current.anchorMessageId !== pending.anchorMessageId) {
      return;
    }
    this.setKnowledgeIngestInteraction(conversationKey, {
      ...current,
      expiresAt: Date.now() + this.deps.config.knowledgeBase.ingest.sessionIdleMs,
    });
  }

  private async restorePreviousSessionForBackgroundIngest(
    conversationKey: string,
    chatType: string | undefined,
    pending: Pick<PendingKnowledgeIngestInteraction, "previousActiveSessionId">,
  ): Promise<void> {
    if (!pending.previousActiveSessionId) {
      return;
    }
    const window = this.deps.getSessionWindow(conversationKey, chatType);
    if (window.activeSessionId === pending.previousActiveSessionId) {
      return;
    }
    if (!window.sessions.some((session) => session.sessionId === pending.previousActiveSessionId)) {
      return;
    }
    const nextWindow = setActiveSession(
      window,
      pending.previousActiveSessionId,
      Date.now(),
      this.deps.config.bridge.maxSessionsPerWindow,
    );
    await this.deps.saveSessionWindow(conversationKey, chatType, nextWindow);
  }

  private async restoreOrCreateNormalSessionForBackgroundIngest(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">,
    pending: Pick<PendingKnowledgeIngestInteraction, "previousActiveSessionId" | "ingestSessionId">,
  ): Promise<void> {
    if (pending.previousActiveSessionId) {
      await this.restorePreviousSessionForBackgroundIngest(message.conversationKey, message.chatType, pending);
      return;
    }
    if (!pending.ingestSessionId) {
      return;
    }
    const window = this.deps.getSessionWindow(message.conversationKey, message.chatType);
    if (window.activeSessionId !== pending.ingestSessionId) {
      return;
    }
    await this.deps.createAndBindSession(message);
  }

  private async interruptPersistedKnowledgeIngests(): Promise<void> {
    const records = [...this.interactions.values()];
    if (records.length === 0) {
      return;
    }

    for (const record of records) {
      await this.restorePreviousSessionForBackgroundIngest(record.conversationKey, record.chatType, record).catch((error) => {
        this.deps.logger.log("knowledge/ingest", "failed to restore interrupted ingest session", {
          conversationKey: record.conversationKey,
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
      await this.sendPayload(record.chatId, buildNoticeCardPayload({
        title: "入库任务已中断",
        level: "warning",
        message: "入库任务因服务重启中断，请重新发送 `/知识入库`。",
        showMessageIcon: false,
      }), {
        event: "knowledge ingest interrupted",
        transcriptType: "outbound-final",
        textPreview: "入库任务因服务重启中断",
        len: 12,
      }, {
        replyToMessageId: record.anchorMessageId,
        replyInThread: record.deliveryMode === "group_thread",
      }).catch((error) => {
        this.deps.logger.log("knowledge/ingest", "failed to notify interrupted ingest", {
          conversationKey: record.conversationKey,
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }

    for (const record of records) {
      this.interactions.delete(record.conversationKey);
    }
    await this.interactions.flush();
  }

  private async updateKnowledgeIngestProgress(
    conversationKey: string,
    chatId: string,
    messageId: string,
    state: KnowledgeIngestProgressState,
    update: KnowledgeIngestProgressUpdate,
  ): Promise<void> {
    applyKnowledgeIngestProgress(state, update);
    const payload = buildKnowledgeIngestProcessingPayload(this.buildKnowledgeIngestProgressCardView(conversationKey, state));
    try {
      await this.updatePayload(chatId, messageId, payload, {
        event: "knowledge ingest progress updated",
        transcriptType: "outbound-final",
        textPreview: `${state.sourceLabel} ${state.steps.map((step) => `${step.label}:${step.detail}`).join(" | ")}`,
        len: state.steps.map((step) => `${step.label}:${step.detail}`).join("\n").length,
      });
    } catch (error) {
      this.deps.logger.log("feishu/reply", "knowledge ingest progress update failed", {
        chatId,
        messageId,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private async ensureKnowledgeIngestProcessingCard(
    queue: KnowledgeIngestQueueState,
    pending: PendingKnowledgeIngestInteraction,
    item: KnowledgeIngestQueueItem,
  ): Promise<void> {
    if (!queue.batchMessageId) {
      const created = await this.sendPayload(item.chatId, buildKnowledgeIngestProcessingPayload(this.buildKnowledgeIngestProgressCardView(pending.conversationKey, item.progressState)), {
        event: "knowledge ingest processing started",
        transcriptType: "outbound-final",
        textPreview: getKnowledgeIngestQueueItemLabel(item),
        len: getKnowledgeIngestQueueItemLabel(item).length,
      }, this.getKnowledgeIngestDelivery(pending));
      queue.batchMessageId = created.messageId;
      return;
    }
    try {
      await this.updatePayload(item.chatId, queue.batchMessageId, buildKnowledgeIngestProcessingPayload(this.buildKnowledgeIngestProgressCardView(pending.conversationKey, item.progressState)), {
        event: "knowledge ingest processing started",
        transcriptType: "outbound-final",
        textPreview: getKnowledgeIngestQueueItemLabel(item),
        len: getKnowledgeIngestQueueItemLabel(item).length,
      });
    } catch (error) {
      this.deps.logger.log("feishu/reply", "knowledge ingest processing card update failed", {
        chatId: item.chatId,
        messageId: queue.batchMessageId,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private buildKnowledgeIngestProgressCardView(
    conversationKey: string,
    state: KnowledgeIngestProgressState,
  ): KnowledgeIngestProgressState & {
    completedCount: number;
    failedCount: number;
    queuedLabels: string[];
    completedItems: Array<{ sourceFile: string; extractedCount: number; elapsedMs?: number | undefined }>;
    failedItems: Array<{ sourceFile: string; reason: string; elapsedMs?: number | undefined }>;
  } {
    const queue = this.knowledgeIngestQueues.get(conversationKey);
    const stats = this.getKnowledgeIngestSessionStats(conversationKey);
    return {
      ...state,
      completedCount: stats.completedCount,
      failedCount: stats.failedCount,
      queuedLabels: queue?.pending.map((item) => getKnowledgeIngestQueueItemLabel(item)) ?? [],
      completedItems: stats.results.map((result) => ({
        sourceFile: result.sourceFile,
        extractedCount: result.extractedCount,
        elapsedMs: result.elapsedMs,
      })),
      failedItems: stats.failures,
    };
  }

  private async sendNotice(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    input: {
      title: string;
      template: "blue" | "green" | "red" | "wathet" | "grey" | "orange" | "yellow" | "purple" | "indigo";
      icon: string;
      message: string;
    },
  ): Promise<void> {
    await this.deps.transport.sendNotice({
      chatId: message.chatId,
      replyToMessageId: message.messageId,
    }, {
      title: input.title,
      level: resolveNoticeLevelFromTemplate(input.template),
      message: input.message,
      showMessageIcon: false,
    }, {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: input.title,
      len: input.title.length,
    });
  }

  private async sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
  ): Promise<{ messageId: string }> {
    return await this.deps.transport.sendPayload(chatId, payload, options, delivery);
  }

  private async updatePayload(
    chatId: string,
    messageId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
  ): Promise<{ messageId: string }> {
    return await this.deps.transport.updatePayload(chatId, messageId, payload, options);
  }

  // #endregion
}

type KnowledgeIngestProgressState = {
  sourceLabel: string;
  startedAt: number;
  steps: ToolUpdateView[];
};

function createKnowledgeIngestProgressState(sourceLabel: string): KnowledgeIngestProgressState {
  return {
    sourceLabel,
    startedAt: Date.now(),
    steps: [
      { label: "读取内容", detail: "等待开始", status: "pending" },
      { label: "提取问答", detail: "等待开始", status: "pending" },
      { label: "写入知识库", detail: "等待开始", status: "pending" },
    ],
  };
}

function getKnowledgeIngestQueueItemLabel(item: KnowledgeIngestQueueItem): string {
  return item.kind === "web" ? item.url : item.fileName;
}

function getKnowledgeIngestQueueItemKey(item: KnowledgeIngestQueueItem): string {
  if (item.kind === "web") {
    return `web:${item.url}`;
  }
  return [
    "file",
    item.messageId,
    item.fileKey,
    item.fileName,
  ].join(":");
}

function formatKnowledgeAllowedExtensions(allowedExtensions: readonly string[]): string {
  return allowedExtensions.map((extension) => extension.toUpperCase()).join(" / ");
}

function matchesKnowledgeIngestInstruction(text: string): boolean {
  const routed = routeIncomingText(text.trim());
  return routed.kind === "command" && routed.command.kind === "knowledge-ingest";
}

function matchesKnowledgeIngestEndInstruction(text: string): boolean {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/^\/+/, "").trim().toLowerCase();
  if (["完成上传", "材料收集完成", "知识入库完成", "知识入库结束", "kb-ingest-end"].includes(normalized)) {
    return true;
  }
  const routed = routeIncomingText(trimmed);
  return routed.kind === "command" && routed.command.kind === "knowledge-ingest-end";
}

function applyKnowledgeIngestProgress(state: KnowledgeIngestProgressState, update: KnowledgeIngestProgressUpdate): void {
  const label = mapKnowledgeProgressLabel(update.step);
  const step = state.steps.find((item) => item.label === label);
  if (!step) {
    return;
  }
  step.status = update.status;
  if (update.detail) {
    step.detail = normalizeKnowledgeProgressDetail(update.detail, label);
  } else if (update.status === "completed") {
    step.detail = "已完成";
  } else if (update.status === "running") {
    step.detail = "处理中";
  } else if (update.status === "error") {
    step.detail = "执行失败";
  }
}

function normalizeKnowledgeProgressDetail(detail: string, label: ToolUpdateView["label"]): string {
  const normalized = detail.trim();
  if (!normalized) {
    return normalized;
  }
  const prefixes = label === "提取问答"
    ? ["提取问答", "提取关键信息"]
    : label === "写入知识库"
      ? ["写入知识库", "生成结果"]
      : [label];
  for (const prefix of prefixes) {
    const marker = `${prefix}：`;
    if (normalized.startsWith(marker)) {
      return normalized.slice(marker.length).trim() || normalized;
    }
  }
  return normalized;
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
