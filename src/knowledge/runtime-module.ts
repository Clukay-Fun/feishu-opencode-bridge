import type { AppConfig } from "../config/schema.js";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import type { PendingKnowledgeIngestInteraction } from "../bridge/state.js";
import {
  buildKnowledgeIngestFailurePayload,
  buildKnowledgeIngestPayload,
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestQueuedPayload,
  buildKnowledgeIngestReadyPayload,
  buildKnowledgeIngestSessionFinalPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import {
  getActiveSession,
  setActiveSession,
  setInteractionMode,
  updateSessionLabel,
} from "../runtime/session-windows.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import { ActiveKnowledgeIngestStore, type ActiveKnowledgeIngestRecordMap } from "../store/active-ingests.js";
import type { RoutedText } from "../bridge/router.js";
import { detectKnowledgeWebIngest, detectLegalQuestion } from "./detector.js";
import {
  type KnowledgeBasePort,
  type KnowledgeIngestProgressStep,
  type KnowledgeIngestProgressUpdate,
  type KnowledgeIngestResult,
} from "./index.js";

type SendPayload = (
  chatId: string,
  payload: FeishuPostPayload,
  options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
  delivery?: { replyToMessageId: string; replyInThread?: boolean },
) => Promise<{ messageId: string }>;

type UpdatePayload = (
  chatId: string,
  messageId: string,
  payload: FeishuPostPayload,
  options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
) => Promise<{ messageId: string }>;

type KnowledgeIngestQueueItem = {
  conversationKey: string;
  chatId: string;
  requesterOpenId: string;
  processingMessageId: string;
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

type KnowledgeRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  knowledge: KnowledgeBasePort | null;
  sendPayload: SendPayload;
  updatePayload: UpdatePayload;
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
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: KnowledgeRuntimeModuleDeps) {
    this.activeKnowledgeIngests = new ActiveKnowledgeIngestStore(deps.config.storage.dataDir);
  }

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

  async stop(): Promise<void> {
    for (const timeout of this.timers.values()) {
      clearTimeout(timeout);
    }
    this.timers.clear();
    this.deps.knowledge?.close();
  }

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

    const backgroundKnowledgeIngest = this.getInteraction(message.conversationKey);
    if (backgroundKnowledgeIngest) {
      await this.restoreOrCreateNormalSessionForBackgroundIngest(message, backgroundKnowledgeIngest);
    }

    const claimed = pendingInteraction?.kind === "file-await-instruction"
      ? false
      : await this.handleKnowledgeQueryMessage(message);
    return { claimed };
  }

  getInteraction(conversationKey: string): PendingKnowledgeIngestInteraction | null {
    return this.interactions.get(conversationKey) ?? null;
  }

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

  private async handleKnowledgeCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
    command: KnowledgeCommand,
  ): Promise<boolean> {
    if (
      message.chatType === "p2p"
      && (
        command.kind === "knowledge-query"
        || command.kind === "knowledge-mode-start"
        || command.kind === "knowledge-mode-end"
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
        message: "私聊不再使用 `/legal-query*` 切换知识库模式。直接发送问题即可，由 OpenCode 自主决定是否使用知识库；如需批量入库，请使用 `/kb-ingest-start`。",
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
        const result = await this.deps.knowledge.query(command.question);
        await this.deps.sendPayload(
          message.chatId,
          result.results.length > 0 ? buildKnowledgeQueryPayload(result) : buildKnowledgeQueryEmptyPayload(command.question),
          {
            event: "knowledge query sent",
            transcriptType: "outbound-final",
            textPreview: command.question,
            len: command.question.length,
          },
          { replyToMessageId: message.messageId },
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
          message: "请继续上传 PDF / DOCX / TXT 文件；发送 `/kb-ingest-end` 可退出。",
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
      const ready = await this.deps.sendPayload(message.chatId, buildKnowledgeIngestReadyPayload(), {
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
            ? "已退出知识入库模式；当前仍是知识库模式。接下来直接发送问题即可检索知识库，发送 `/legal-query-end` 可退出。"
            : "接下来直接发送问题即可检索知识库，发送 `/legal-query-end` 可退出。",
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
          ? "已退出知识入库模式，并切换到知识库查询模式。接下来直接发送问题即可检索知识库，发送 `/legal-query-end` 可退出。"
          : "接下来直接发送问题即可检索知识库，发送 `/legal-query-end` 可退出。",
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
          message: "当前仍是普通对话模式，发送 `/legal-query-start` 可进入知识库模式。",
        });
        return true;
      }
      const nextWindow = setInteractionMode(window, "default", this.deps.config.bridge.maxSessionsPerWindow);
      await this.deps.saveSessionWindow(message.conversationKey, nextWindow);
      await this.sendNotice(message, {
        title: "已退出知识库模式",
        template: "green",
        icon: "chat_outlined",
        message: "后续消息将恢复为普通 OpenCode 对话，仍可用 `/legal-query <问题>` 单次查询。",
      });
      return true;
    }

    return false;
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
        await this.deps.sendPayload(
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
        await this.deps.sendPayload(message.chatId, buildNoticeCardPayload({
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
      await this.deps.sendPayload(
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
      | Omit<Extract<KnowledgeIngestQueueItem, { kind: "file" }>, "processingMessageId" | "progressState">
      | Omit<Extract<KnowledgeIngestQueueItem, { kind: "web" }>, "processingMessageId" | "progressState">;
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
        await this.sendKnowledgeIngestMarkdown(pending, "请继续上传 PDF / DOCX / TXT / MD 文件，或直接发送网页 URL / 带 URL 的入库请求；发送 `/kb-ingest-end` 退出。");
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
    const queuedCount = queue.pending.length + (queue.active ? 1 : 0);
    if (queuedCount >= this.deps.config.bridge.queueLimit) {
      await this.sendKnowledgeIngestMarkdown(pending, "已达上限，请等待当前文件处理完成。");
      return true;
    }

    const queuedAhead = queue.pending.length + (queue.active ? 1 : 0);
    const progressState = createKnowledgeIngestProgressState(sourceLabel);
    const initialPayload = queuedAhead > 0
      ? buildKnowledgeIngestQueuedPayload({ sourceLabel, queuedAhead, startedAt: progressState.startedAt })
      : buildKnowledgeIngestProcessingPayload(progressState);
    const processing = await this.deps.sendPayload(message.chatId, initialPayload, {
      event: itemInput.kind === "web" ? "knowledge web ingest queued" : "knowledge ingest queued",
      transcriptType: "outbound-final",
      textPreview: sourceLabel,
      len: sourceLabel.length,
    }, this.getKnowledgeIngestDelivery(pending));
    queue.pending.push({
      ...itemInput,
      processingMessageId: processing.messageId,
      progressState,
    });
    this.refreshKnowledgeIngestPending(pending.conversationKey, pending);
    void this.processKnowledgeIngestQueue(pending.conversationKey);
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
        void this.updateKnowledgeIngestProcessingCard(currentItem);
        try {
          if (currentItem.kind === "web") {
            const result = await this.deps.knowledge.ingestWebPage!({
              url: currentItem.url,
              instruction: currentItem.instruction,
              messageId: currentItem.messageId,
            }, {
              onProgress: async (update) => await this.updateKnowledgeIngestProgress(currentItem.chatId, currentItem.processingMessageId, currentItem.progressState, update),
            });
            this.refreshKnowledgeIngestPending(conversationKey, pending);
            await this.deps.updatePayload(currentItem.chatId, currentItem.processingMessageId, buildKnowledgeIngestPayload(result), {
              event: "knowledge web ingest updated",
              transcriptType: "outbound-final",
              textPreview: result.sourceFile,
              len: result.sourceFile.length,
            });
            this.recordKnowledgeIngestResult(conversationKey, result);
          } else {
            const result = await this.deps.knowledge.ingestFile({
              messageId: currentItem.messageId,
              fileKey: currentItem.fileKey,
              fileName: currentItem.fileName,
              size: currentItem.size,
            }, {
              onProgress: async (update) => await this.updateKnowledgeIngestProgress(currentItem.chatId, currentItem.processingMessageId, currentItem.progressState, update),
            });
            this.refreshKnowledgeIngestPending(conversationKey, pending);
            await this.deps.updatePayload(currentItem.chatId, currentItem.processingMessageId, buildKnowledgeIngestPayload(result), {
              event: "knowledge ingest updated",
              transcriptType: "outbound-final",
              textPreview: result.sourceFile,
              len: result.sourceFile.length,
            });
            this.recordKnowledgeIngestResult(conversationKey, result);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.recordKnowledgeIngestFailure(conversationKey, getKnowledgeIngestQueueItemLabel(currentItem), detail);
          await this.deps.updatePayload(currentItem.chatId, currentItem.processingMessageId, buildKnowledgeIngestFailurePayload({
            sourceLabel: getKnowledgeIngestQueueItemLabel(currentItem),
            reason: detail,
          }), {
            event: currentItem.kind === "web" ? "knowledge web ingest failed" : "knowledge ingest failed",
            transcriptType: "outbound-final",
            textPreview: detail,
            len: detail.length,
          });
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
    if (stats.completedCount + stats.failedCount <= 1) {
      return;
    }
    await this.deps.sendPayload(pending.chatId, buildKnowledgeIngestSessionFinalPayload({
      completedCount: stats.completedCount,
      failedCount: stats.failedCount,
      queuedCount: 0,
      totalExtractedCount: stats.totalExtractedCount,
      totalDedupedCount: stats.totalDedupedCount,
      elapsedMs: Date.now() - stats.startedAt,
      bitableUrl: stats.bitableUrl,
      results: stats.results,
      failures: stats.failures,
    }), {
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
      await this.deps.sendPayload(pending.chatId, buildNoticeCardPayload({
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
      await this.sendKnowledgeIngestMarkdown(pending, "已收到结束指令，将处理完当前队列后结束。");
    } else {
      await this.sendKnowledgeIngestFinalSummary(pending);
      await this.clearPending(pending.conversationKey, pending.chatType);
    }
    if (!delivery || !endedImmediately) {
      return;
    }
    await this.deps.sendPayload(pending.chatId, buildNoticeCardPayload({
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
    await this.deps.sendPayload(current.chatId, buildNoticeCardPayload({
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
    await this.deps.sendPayload(pending.chatId, buildPostMarkdownPayload(markdown), {
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
      await this.deps.sendPayload(record.chatId, buildNoticeCardPayload({
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
      await this.deps.updatePayload(chatId, messageId, payload, {
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

  private async updateKnowledgeIngestProcessingCard(item: KnowledgeIngestQueueItem): Promise<void> {
    try {
      await this.deps.updatePayload(item.chatId, item.processingMessageId, buildKnowledgeIngestProcessingPayload(item.progressState), {
        event: "knowledge ingest processing started",
        transcriptType: "outbound-final",
        textPreview: getKnowledgeIngestQueueItemLabel(item),
        len: getKnowledgeIngestQueueItemLabel(item).length,
      });
    } catch (error) {
      this.deps.logger.log("feishu/reply", "knowledge ingest processing card update failed", {
        chatId: item.chatId,
        messageId: item.processingMessageId,
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
    await this.deps.sendPayload(message.chatId, buildNoticeCardPayload({
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
    }), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: input.title,
      len: input.title.length,
    }, { replyToMessageId: message.messageId });
  }
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
