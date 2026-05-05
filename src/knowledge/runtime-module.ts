/**
 * 职责: 将知识库能力接入运行时模块体系。
 * 关注点:
 * - 拦截知识查询、摄入相关命令并切换交互流程。
 * - 管理知识摄入过程中的挂起状态与卡片更新。
 * - 在需要时向模型注入知识检索相关上下文。
 */
import type { AppConfig } from "../config/schema.js";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import type { PendingFileInstructionInteraction, PendingKnowledgeIngestInteraction } from "../bridge/state.js";
import {
  buildKnowledgeIngestFailurePayload,
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestReadyPayload,
  buildKnowledgeIngestSessionFinalPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
} from "../feishu/knowledge-cards.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "../feishu/shared-primitives.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import type { IncomingChatMessage, IncomingFileMessage } from "../runtime/app.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import {
  getActiveSession,
  setActiveSession,
  setInteractionMode,
  updateSessionLabel,
} from "../runtime/session-windows.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import { ActiveKnowledgeIngestStore, type ActiveKnowledgeIngestRecordMap } from "../store/active-ingests.js";
import { routeIncomingText, type RoutedText } from "../bridge/router.js";
import { detectKnowledgeMaterialIngestIntent, detectKnowledgeWebIngest, detectLegalQuestion } from "./detector.js";
import {
  type KnowledgeBasePort,
  type KnowledgeIngestProgressStep,
  type KnowledgeIngestProgressUpdate,
  type KnowledgeIngestResult,
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
  results: KnowledgeIngestResult[];
  failures: Array<{ sourceFile: string; reason: string }>;
};

type RecentKnowledgeMaterial = {
  chatId: string;
  conversationKey: string;
  requesterOpenId: string;
  messageId: string;
  fileKey: string;
  fileName: string;
  size?: number | undefined;
  createdAt: number;
};

const KNOWLEDGE_INGEST_TEXT_PATTERN = /(^|[\s/])(?:kb-ingest-start|入库|导入|收录|加入知识库|添加到知识库|写入知识库|保存到知识库|放进知识库|同步到知识库)(?=$|\s)/i;
const MAX_RECENT_KNOWLEDGE_MATERIALS = 10;

type KnowledgeRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  knowledge: KnowledgeBasePort | null;
  transport: FeishuTransport;
  getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord;
  saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void>;
  createAndBindSession(source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<SessionBindingRecord>;
  whitelistBind(chatId: string, openId: string): Promise<void>;
};

type KnowledgeCommand = Extract<RoutedText, { kind: "command" }>["command"];

export class KnowledgeRuntimeModule implements RuntimeModule {
  readonly name = "knowledge";
  readonly priority = 20;
  readonly interactions = new Map<string, PendingKnowledgeIngestInteraction>();

  private readonly activeKnowledgeIngests: ActiveKnowledgeIngestStore;
  private activeKnowledgeIngestMap: ActiveKnowledgeIngestRecordMap = {};
  private readonly runningKnowledgeIngests = new Map<string, { requesterOpenId: string }>();
  private readonly knowledgeIngestQueues = new Map<string, KnowledgeIngestQueueState>();
  private readonly knowledgeIngestSessionStats = new Map<string, KnowledgeIngestSessionStats>();
  private readonly recentKnowledgeMaterials = new Map<string, RecentKnowledgeMaterial[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: KnowledgeRuntimeModuleDeps) {
    this.activeKnowledgeIngests = new ActiveKnowledgeIngestStore(deps.config.storage.dataDir);
  }

  // #region 生命周期与入口

  /** 恢复持久化状态，并在可用时同步知识镜像。 */
  async start(): Promise<void> {
    this.activeKnowledgeIngestMap = await this.activeKnowledgeIngests.load();
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
    for (const timeout of this.timers.values()) {
      clearTimeout(timeout);
    }
    this.timers.clear();
    this.recentKnowledgeMaterials.clear();
    this.deps.knowledge?.close();
  }

  /** 处理知识查询、知识入库和知识模式相关输入。 */
  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed, pendingInteraction } = context;
    const activeKnowledgeIngest = this.findKnowledgeIngestInteraction(message);
    if (activeKnowledgeIngest) {
      if (routed?.kind === "command" && routed.command.kind === "knowledge-ingest-end") {
        await this.endKnowledgeIngestInteraction(message, activeKnowledgeIngest);
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

    if (this.captureRecentKnowledgeMaterial(message)) {
      return { claimed: false };
    }

    const backgroundKnowledgeIngest = this.getInteraction(message.conversationKey);
    if (backgroundKnowledgeIngest) {
      await this.restoreOrCreateNormalSessionForBackgroundIngest(message, backgroundKnowledgeIngest);
    }

    if (await this.handleRecentMaterialIngestIntent(message)) {
      return { claimed: true };
    }

    const claimed = pendingInteraction?.kind === "file-await-instruction"
      ? false
      : await this.handleKnowledgeQueryMessage(message);
    return { claimed };
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
        return await this.handleKnowledgeCommand(message, {
          kind: "knowledge-query",
          question: command.arguments.join(" ").trim(),
        });
      }
      if (legacyAlias === "legal-query-start") {
        await this.sendNotice(message, {
          title: "命令已更新",
          template: "yellow",
          icon: "maybe_outlined",
          message: message.chatType === "p2p"
            ? "私聊里不再使用 `/legal-query-start`。直接发送问题即可；如需批量入库，请使用 `/kb-ingest-start`。"
            : "知识库模式入口已从 `/legal-query-start` 迁移到 `/法律咨询开始`。如需单次检索，也可以使用 `/kb-query <问题>`。",
        });
        return true;
      }
      if (legacyAlias === "legal-query-end") {
        await this.sendNotice(message, {
          title: "命令已更新",
          template: "yellow",
          icon: "maybe_outlined",
          message: message.chatType === "p2p"
            ? "私聊里不再使用 `/legal-query-end`。直接发送问题即可，不需要显式退出。"
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
            ? "私聊里不再使用 `/legal-query <问题>`。直接发送问题即可；如需强制走知识库查询，请使用 `/kb-query <问题>`。"
            : "单次知识库检索已从 `/legal-query <问题>` 迁移到 `/kb-query <问题>`；连续检索模式请使用 `/法律咨询开始`。",
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
        await this.deps.saveSessionWindow(message.conversationKey, nextWindow);
      }
      await this.sendNotice(message, {
        title: "私聊里直接提问即可",
        template: "blue",
        icon: "search_outlined",
        message: "私聊不需要显式切换知识库模式。直接发送问题即可，由 OpenCode 自主决定是否使用知识库；如需批量入库，请使用 `/kb-ingest-start`。",
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
        const processing = await this.sendPayload(
          message.chatId,
          buildNoticeCardPayload({
            title: "知识检索进行中",
            template: "indigo",
            iconToken: "search_outlined",
            message: `正在检索知识库...\n\n**问题**\n${command.question}`,
          }),
          {
            event: "knowledge query started",
            transcriptType: "outbound-process",
            textPreview: command.question,
            len: command.question.length,
          },
          { replyToMessageId: message.messageId },
        );
        const result = await this.deps.knowledge.query(command.question);
        await this.updatePayload(
          message.chatId,
          processing.messageId,
          result.results.length > 0 ? buildKnowledgeQueryPayload(result) : buildKnowledgeQueryEmptyPayload({ question: command.question }),
          {
            event: "knowledge query sent",
            transcriptType: "outbound-final",
            textPreview: command.question,
            len: command.question.length,
          },
        );
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
          message: "请继续上传 PDF / DOCX / TXT / MD / 图片文件；发送 `/kb-ingest-end` 可退出。",
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
      await this.deps.saveSessionWindow(message.conversationKey, nextWindow);
      const deliveryMode = message.chatType === "p2p" ? "p2p_reply" : "group_thread";
      const ready = await this.sendPayload(message.chatId, buildKnowledgeIngestReadyPayload(), {
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
          message: "发送 `/kb-ingest-start` 可进入知识入库模式。",
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
            ? "已退出知识入库模式；当前仍是知识库模式。接下来直接发送问题即可检索知识库，发送 `/法律咨询结束` 可退出。"
            : "接下来直接发送问题即可检索知识库，发送 `/法律咨询结束` 可退出。",
        });
        return true;
      }
      const nextWindow = setInteractionMode(window, "knowledge", this.deps.config.bridge.maxSessionsPerWindow);
      await this.deps.saveSessionWindow(message.conversationKey, nextWindow);
      await this.sendNotice(message, {
        title: "已进入知识库模式",
        template: "indigo",
        icon: "search_outlined",
        message: clearedIngestPending
          ? "已退出知识入库模式，并切换到知识库查询模式。接下来直接发送问题即可检索知识库，发送 `/法律咨询结束` 可退出。"
          : "接下来直接发送问题即可检索知识库，发送 `/法律咨询结束` 可退出。",
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
      await this.deps.saveSessionWindow(message.conversationKey, nextWindow);
      await this.sendNotice(message, {
        title: "已退出知识库模式",
        template: "green",
        icon: "chat_outlined",
        message: "后续消息将恢复为普通 OpenCode 对话，仍可用 `/kb-query <问题>` 单次检索知识库。",
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
    };
    await this.enqueueKnowledgeIngestInput(fileMessage, pending);
  }

  private async startKnowledgeIngestFromRecentMaterials(
    materials: RecentKnowledgeMaterial[],
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
    const pending = await this.openKnowledgeIngestInteraction(message);
    for (const material of materials) {
      const fileMessage: IncomingChatMessage = {
        ...message,
        chatId: material.chatId,
        conversationKey: material.conversationKey,
        messageId: material.messageId,
        rawContent: material.fileName,
        plainText: material.fileName,
        messageType: "file",
        file: {
          fileKey: material.fileKey,
          fileName: material.fileName,
          size: material.size,
        },
      };
      await this.enqueueKnowledgeIngestInput(fileMessage, pending);
    }
    this.clearRecentKnowledgeMaterials(message);
    await this.endKnowledgeIngestInteraction(message, pending, { replyToMessageId: message.messageId });
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
    await this.deps.saveSessionWindow(message.conversationKey, nextWindow);
    const deliveryMode = message.chatType === "p2p" ? "p2p_reply" : "group_thread";
    const ready = await this.sendPayload(message.chatId, buildKnowledgeIngestReadyPayload(), {
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

  private async handleKnowledgeQueryMessage(message: IncomingChatMessage): Promise<boolean> {
    if (message.chatType === "p2p" || message.messageType === "file" || !this.deps.knowledge) {
      return false;
    }

    const window = this.deps.getSessionWindow(message.conversationKey, message.chatType);
    const knowledgeModeDetection = window.interactionMode === "knowledge"
      ? detectLegalQuestion(message.plainText)
      : null;
    if (
      window.interactionMode === "knowledge"
      && knowledgeModeDetection?.matched
      && knowledgeModeDetection.confidence >= this.deps.config.knowledgeBase.autoDetect.minConfidence
    ) {
      try {
        const result = await this.deps.knowledge.query(message.plainText);
        await this.sendPayload(
          message.chatId,
          result.results.length > 0 ? buildKnowledgeQueryPayload(result) : buildKnowledgeQueryEmptyPayload({ question: message.plainText }),
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
      return true;
    }

    if (!this.deps.config.knowledgeBase.autoDetect.enabled) {
      return false;
    }

    const detection = detectLegalQuestion(message.plainText);
    if (!detection.matched || detection.confidence < this.deps.config.knowledgeBase.autoDetect.minConfidence) {
      return false;
    }

    try {
      const result = await this.deps.knowledge.query(message.plainText);
      if (result.results.length === 0) {
        return false;
      }
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
      return true;
    } catch (error) {
      this.deps.logger.log("knowledge/query", "auto-detect query failed", {
        detail: error instanceof Error ? error.message : String(error),
        confidence: detection.confidence,
      }, "warn");
      return false;
    }
  }

  private captureRecentKnowledgeMaterial(message: IncomingChatMessage): boolean {
    if (message.messageType !== "file" || !this.deps.knowledge) {
      return false;
    }
    if (!this.isSupportedRecentKnowledgeMaterial(message)) {
      return false;
    }
    const key = this.getRecentKnowledgeMaterialKey(message);
    const expiresBefore = Date.now() - this.deps.config.knowledgeBase.ingest.pendingTtlMs;
    const existing = (this.recentKnowledgeMaterials.get(key) ?? [])
      .filter((item) => item.createdAt >= expiresBefore && item.messageId !== message.messageId);
    existing.push({
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      messageId: message.messageId,
      fileKey: message.file.fileKey,
      fileName: message.file.fileName,
      size: message.file.size,
      createdAt: Date.now(),
    });
    this.recentKnowledgeMaterials.set(key, existing.slice(-MAX_RECENT_KNOWLEDGE_MATERIALS));
    return true;
  }

  private async handleRecentMaterialIngestIntent(message: IncomingChatMessage): Promise<boolean> {
    if (message.messageType !== "text" || !this.deps.knowledge) {
      return false;
    }
    const materials = this.getRecentKnowledgeMaterials(message);
    if (materials.length === 0) {
      return false;
    }
    const detection = detectKnowledgeMaterialIngestIntent(message.plainText);
    if (!detection.matched) {
      return false;
    }
    this.deps.logger.log("knowledge/ingest", "recent material ingest claimed", {
      confidence: detection.confidence,
      reasons: detection.reasons.join(","),
      materialCount: materials.length,
    });
    await this.startKnowledgeIngestFromRecentMaterials(materials, message);
    return true;
  }

  private getRecentKnowledgeMaterials(message: Pick<IncomingChatMessage, "chatId" | "senderOpenId">): RecentKnowledgeMaterial[] {
    const key = this.getRecentKnowledgeMaterialKey(message);
    const expiresBefore = Date.now() - this.deps.config.knowledgeBase.ingest.pendingTtlMs;
    const materials = (this.recentKnowledgeMaterials.get(key) ?? []).filter((item) => item.createdAt >= expiresBefore);
    if (materials.length === 0) {
      this.recentKnowledgeMaterials.delete(key);
      return [];
    }
    this.recentKnowledgeMaterials.set(key, materials);
    return materials;
  }

  private clearRecentKnowledgeMaterials(message: Pick<IncomingChatMessage, "chatId" | "senderOpenId">): void {
    this.recentKnowledgeMaterials.delete(this.getRecentKnowledgeMaterialKey(message));
  }

  private getRecentKnowledgeMaterialKey(message: Pick<IncomingChatMessage, "chatId" | "senderOpenId">): string {
    return `${message.chatId}:${message.senderOpenId}`;
  }

  private isSupportedRecentKnowledgeMaterial(message: IncomingFileMessage): boolean {
    const extension = message.file.fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (!this.deps.config.knowledgeBase.ingest.allowedExtensions.includes(extension)) {
      return false;
    }
    if (typeof message.file.size !== "number") {
      return true;
    }
    if (message.file.size <= 0) {
      return false;
    }
    return message.file.size <= this.deps.config.knowledgeBase.ingest.maxFileSizeMb * 1024 * 1024;
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
      };
    } else {
      const webIngest = detectKnowledgeWebIngest(message.plainText, { requireIngestIntent: false });
      if (!webIngest.matched || !webIngest.url || !this.deps.knowledge.ingestWebPage) {
        await this.sendKnowledgeIngestMarkdown(pending, "请继续上传 PDF / DOCX / TXT / MD / 图片文件，或直接发送网页 URL / 带 URL 的入库请求；发送 `/kb-ingest-end` 退出。");
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
    queue.pending.push(queuedItem);
    this.refreshKnowledgeIngestPending(pending.conversationKey, pending);
    const receipt = await this.sendPayload(message.chatId, buildNoticeCardPayload({
      title: "已收到入库素材",
      template: "blue",
      iconToken: itemInput.kind === "web" ? "global-link_outlined" : "file-link-docx_outlined",
      message: [
        `素材：${sourceLabel}`,
        "",
        "已加入本次入库清单，发送 `/kb-ingest-end` 后开始统一分析。",
      ].join("\n"),
      showMessageIcon: false,
    }), {
      event: itemInput.kind === "web" ? "knowledge web ingest accepted" : "knowledge ingest accepted",
      transcriptType: "outbound-final",
      textPreview: sourceLabel,
      len: sourceLabel.length,
    }, this.getKnowledgeIngestDelivery(pending));
    queuedItem.receiptMessageId = receipt.messageId;
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
                await this.updateKnowledgeIngestProgress(currentItem.chatId, queue.batchMessageId, currentItem.progressState, update);
              },
            });
            this.refreshKnowledgeIngestPending(conversationKey, pending);
            this.recordKnowledgeIngestResult(conversationKey, result);
          } else {
            const result = await this.deps.knowledge.ingestFile({
              messageId: currentItem.messageId,
              fileKey: currentItem.fileKey,
              fileName: currentItem.fileName,
              size: currentItem.size,
            }, {
              onProgress: async (update) => {
                if (!queue.batchMessageId) {
                  return;
                }
                await this.updateKnowledgeIngestProgress(currentItem.chatId, queue.batchMessageId, currentItem.progressState, update);
              },
            });
            this.refreshKnowledgeIngestPending(conversationKey, pending);
            this.recordKnowledgeIngestResult(conversationKey, result);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.recordKnowledgeIngestFailure(conversationKey, getKnowledgeIngestQueueItemLabel(currentItem), detail);
          if (queue.batchMessageId) {
            await this.updatePayload(currentItem.chatId, queue.batchMessageId, buildKnowledgeIngestFailurePayload({
              sourceLabel: getKnowledgeIngestQueueItemLabel(currentItem),
              reason: detail,
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
        item = queue.pending.shift();
      }
    } finally {
      queue.active = false;
      queue.currentLabel = undefined;
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

  private recordKnowledgeIngestResult(conversationKey: string, result: KnowledgeIngestResult): void {
    const stats = this.getKnowledgeIngestSessionStats(conversationKey);
    const rawExtractedCount = result.rawExtractedCount ?? result.extractedCount;
    stats.completedCount += 1;
    stats.totalExtractedCount += result.extractedCount;
    stats.totalDedupedCount += result.dedupedCount ?? Math.max(0, rawExtractedCount - result.extractedCount);
    stats.bitableUrl = result.bitableUrl ?? stats.bitableUrl;
    stats.results.push(result);
  }

  private recordKnowledgeIngestFailure(conversationKey: string, sourceFile: string, reason: string): void {
    const stats = this.getKnowledgeIngestSessionStats(conversationKey);
    stats.failedCount += 1;
    stats.failures.push({ sourceFile, reason });
  }

  private async sendKnowledgeIngestFinalSummary(pending: PendingKnowledgeIngestInteraction): Promise<void> {
    const stats = this.getKnowledgeIngestSessionStats(pending.conversationKey);
    if (stats.completedCount + stats.failedCount === 0) {
      return;
    }
    const payload = buildKnowledgeIngestSessionFinalPayload({
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
    const queue = this.knowledgeIngestQueues.get(pending.conversationKey);
    if (queue?.batchMessageId) {
      await this.updatePayload(pending.chatId, queue.batchMessageId, payload, {
        event: "knowledge ingest session final summary updated",
        transcriptType: "outbound-final",
        textPreview: "知识入库完成汇总",
        len: 10,
      });
      return;
    }
    await this.sendPayload(pending.chatId, payload, {
      event: "knowledge ingest session final summary sent",
      transcriptType: "outbound-final",
      textPreview: "知识入库完成汇总",
      len: 10,
    }, this.getKnowledgeIngestDelivery(pending));
  }

  private findKnowledgeIngestInteraction(message: IncomingChatMessage): PendingKnowledgeIngestInteraction | null {
    const direct = this.getInteraction(message.conversationKey);
    if (direct && this.isMessageInKnowledgeIngestChain(message, direct)) {
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
        template: "yellow",
        iconToken: "maybe_outlined",
        message: "当前入库模式仅允许发起人结束。",
        messageIconToken: "maybe_outlined",
        messageIconColor: "yellow",
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
      template: "green",
      iconToken: "yes_filled",
      message: "后续文件消息将不再自动入库；如需继续入库，请发送 `/kb-ingest-start`。",
      messageIconToken: "yes_filled",
      messageIconColor: "green",
      showMessageIcon: false,
    }), {
      event: "knowledge ingest ended",
      transcriptType: "outbound-final",
      textPreview: "已退出知识入库模式",
      len: 9,
    }, delivery);
  }

  private setKnowledgeIngestInteraction(conversationKey: string, interaction: PendingKnowledgeIngestInteraction): void {
    this.clearKnowledgeIngestInteraction(conversationKey, { keepActiveKnowledgeIngest: true });
    this.interactions.set(conversationKey, interaction);
    this.getKnowledgeIngestSessionStats(conversationKey);
    const timer = setTimeout(() => {
      void this.handleKnowledgeIngestTimeout(conversationKey, interaction);
    }, Math.max(0, interaction.expiresAt - Date.now()));
    this.timers.set(this.getKnowledgeIngestTimerKey(conversationKey), timer);
    this.saveActiveKnowledgeIngest(interaction);
  }

  private clearKnowledgeIngestInteraction(
    conversationKey: string,
    options?: { keepActiveKnowledgeIngest?: boolean },
  ): void {
    const timerKey = this.getKnowledgeIngestTimerKey(conversationKey);
    const timeout = this.timers.get(timerKey);
    if (timeout) {
      clearTimeout(timeout);
      this.timers.delete(timerKey);
    }
    this.interactions.delete(conversationKey);
    if (!options?.keepActiveKnowledgeIngest) {
      this.deleteActiveKnowledgeIngest(conversationKey);
    }
  }

  private getKnowledgeIngestTimerKey(conversationKey: string): string {
    return `knowledge-ingest:${conversationKey}`;
  }

  private async handleKnowledgeIngestTimeout(conversationKey: string, pending: PendingKnowledgeIngestInteraction): Promise<void> {
    const current = this.getInteraction(conversationKey);
    if (
      !current
      || current.anchorMessageId !== pending.anchorMessageId
      || current.expiresAt > Date.now()
    ) {
      return;
    }
    if (this.runningKnowledgeIngests.has(conversationKey)) {
      this.refreshKnowledgeIngestPending(conversationKey, current);
      return;
    }
    await this.sendKnowledgeIngestFinalSummary(current);
    await this.clearPending(conversationKey, current.chatType);
    await this.sendPayload(current.chatId, buildNoticeCardPayload({
      title: "入库任务已超时",
      template: "yellow",
      iconToken: "maybe_outlined",
      message: "长时间未收到新的入库素材，已结束当前入库任务。需要继续时请重新发送 `/kb-ingest-start`。",
      messageIconToken: "maybe_outlined",
      messageIconColor: "yellow",
      showMessageIcon: false,
    }), {
      event: "knowledge ingest timed out",
      transcriptType: "outbound-final",
      textPreview: "入库任务已超时",
      len: 7,
    }, this.getKnowledgeIngestDelivery(current));
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

  private saveActiveKnowledgeIngest(pending: PendingKnowledgeIngestInteraction): void {
    this.activeKnowledgeIngestMap[pending.conversationKey] = {
      chatId: pending.chatId,
      chatType: pending.chatType,
      conversationKey: pending.conversationKey,
      requesterOpenId: pending.requesterOpenId,
      rootMessageId: pending.rootMessageId,
      anchorMessageId: pending.anchorMessageId,
      deliveryMode: pending.deliveryMode,
      ingestSessionId: pending.ingestSessionId,
      previousActiveSessionId: pending.previousActiveSessionId,
      expiresAt: pending.expiresAt,
    };
    void this.activeKnowledgeIngests.saveRecords(this.activeKnowledgeIngestMap).catch((error) => {
      this.deps.logger.log("knowledge/ingest", "failed to persist active ingest", {
        conversationKey: pending.conversationKey,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    });
  }

  private deleteActiveKnowledgeIngest(conversationKey: string): void {
    if (!(conversationKey in this.activeKnowledgeIngestMap)) {
      return;
    }
    delete this.activeKnowledgeIngestMap[conversationKey];
    void this.activeKnowledgeIngests.saveRecords(this.activeKnowledgeIngestMap).catch((error) => {
      this.deps.logger.log("knowledge/ingest", "failed to clear active ingest", {
        conversationKey,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    });
  }

  private async restorePreviousSessionForBackgroundIngest(
    conversationKey: string,
    chatType: string,
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
    await this.deps.saveSessionWindow(conversationKey, nextWindow);
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
    const records = Object.values(this.activeKnowledgeIngestMap);
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
        template: "yellow",
        iconToken: "maybe_outlined",
        message: "入库任务因服务重启中断，请重新发送 `/kb-ingest-start`。",
        messageIconToken: "maybe_outlined",
        messageIconColor: "yellow",
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

    this.activeKnowledgeIngestMap = {};
    await this.activeKnowledgeIngests.saveRecords(this.activeKnowledgeIngestMap);
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
      const created = await this.sendPayload(item.chatId, buildKnowledgeIngestProcessingPayload(item.progressState), {
        event: "knowledge ingest processing started",
        transcriptType: "outbound-final",
        textPreview: getKnowledgeIngestQueueItemLabel(item),
        len: getKnowledgeIngestQueueItemLabel(item).length,
      }, this.getKnowledgeIngestDelivery(pending));
      queue.batchMessageId = created.messageId;
      return;
    }
    try {
      await this.updatePayload(item.chatId, queue.batchMessageId, buildKnowledgeIngestProcessingPayload(item.progressState), {
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
      template: input.template,
      iconToken: input.icon,
      message: input.message,
      messageIconToken: input.icon,
      messageIconColor: input.template === "red"
        ? "red"
        : input.template === "green"
          ? "green"
          : input.template === "yellow"
            ? "yellow"
            : input.template === "indigo"
              ? "indigo"
              : "blue",
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

function matchesKnowledgeIngestInstruction(text: string): boolean {
  const routed = routeIncomingText(text.trim());
  if (routed.kind === "command" && routed.command.kind === "knowledge-ingest") {
    return true;
  }
  return KNOWLEDGE_INGEST_TEXT_PATTERN.test(text.trim());
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
