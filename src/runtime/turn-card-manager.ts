/**
 * 职责: 管理 turn 生命周期中的飞书过程卡与最终输出。
 * 关注点:
 * - 创建、更新和收尾进度卡。
 * - 汇总流式事件、工具更新和最终结果，输出给飞书。
 */
import { type FeishuPostPayload, type OutputView, type ToolUpdateView } from "../feishu/shared-primitives.js";
import { buildTurnStatusCardPayload, type TurnStatusCardView } from "../feishu/runtime-cards.js";
import { createTextPreview, logEvent, type Logger, type TranscriptType } from "../logging/logger.js";
import type { BridgeOutputContext } from "./message-context.js";
import {
  appendProgressUpdate,
  formatDuration,
  isFinalStatus,
  parseOutput,
  parseToolUpdate,
  prettyPrintPayload,
  upsertToolUpdate,
} from "./app-helpers.js";
import { cleanAssistantReply } from "./sanitize.js";

const INITIAL_CARD_SUMMARY = "已收到消息，正在准备会话...";
const STREAM_FLUSH_MIN_CHARS = 120;
const STREAM_FLUSH_INTERVAL_MS = 750;

type OutboundPort = {
  sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: FeishuPostPayload, options?: { replyInThread?: boolean }): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
};

type TurnCardState = {
  messageId: string;
  chatId: string;
  status: string;
  sessionId: string;
  startedAt: number;
  progressUpdates: string[];
  toolUpdates: Array<{ key: string; view: ToolUpdateView }>;
  output: OutputView;
  costSummary?: string | undefined;
};

type StreamFlushState = {
  flushedLength: number;
  lastFlushedAt: number;
  timer: NodeJS.Timeout | null;
};

type MessageContextRecorder = {
  rememberBridgeOutput(input: {
    messageId: string;
    chatId: string;
    summary?: string | undefined;
    handoffSummary?: BridgeOutputContext | undefined;
  }): void;
};

export class TurnCardManager {
  private readonly turnCards = new Map<string, TurnCardState>();
  private readonly streamFlushStates = new Map<string, StreamFlushState>();

  constructor(
    private readonly outbound: OutboundPort,
    private readonly logger: Logger,
    private readonly replyInThread: boolean,
    private readonly contextRecorder?: MessageContextRecorder | undefined,
  ) {}

  // #region 生命周期

  /** 停止所有待刷新的定时器。 */
  stop(): void {
    for (const state of this.streamFlushStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.streamFlushStates.clear();
  }

  /** 清理指定 turn 的卡片状态与流式刷新状态。 */
  cleanup(turnId: string): void {
    this.turnCards.delete(turnId);
    this.clearStreamFlushState(turnId);
  }

  /** 创建 turn 过程卡；发送失败时返回 null。 */
  async createTurnCard(chatId: string, turnId: string, sessionId: string, replyToMessageId: string): Promise<{ messageId: string } | null> {
    const state: TurnCardState = {
      messageId: "",
      chatId,
      status: "处理中",
      sessionId,
      startedAt: Date.now(),
      progressUpdates: [INITIAL_CARD_SUMMARY],
      toolUpdates: [],
      output: { text: "", paths: [], commands: [] },
    };
    try {
      const payload = buildTurnStatusCardPayload(this.toTurnCardView(state));
      const result = await this.sendPayload(chatId, payload, {
        event: "process message sent",
        transcriptType: "outbound-process",
        textPreview: INITIAL_CARD_SUMMARY,
        len: INITIAL_CARD_SUMMARY.length,
      }, { replyToMessageId });
      state.messageId = result.messageId;
      this.turnCards.set(turnId, state);
      return { messageId: result.messageId };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logEvent(this.logger, "feishu/reply", "transport.failed", {
        chatId,
        turnId,
        transportAction: this.replyInThread ? "reply" : "send",
        payloadKind: "card",
        legacyEvent: "process card send failed",
        errorKind: error instanceof Error ? error.name : "unknown",
        detail,
      }, "warn");
      return null;
    }
  }

  // #endregion

  // #region 流式更新

  /** 调度一次流式文本刷新，避免过高频率更新卡片。 */
  async scheduleStreamUpdate(turnId: string, text: string): Promise<void> {
    const card = this.turnCards.get(turnId);
    if (!card) return;

    const state = this.streamFlushStates.get(turnId) ?? { flushedLength: 0, lastFlushedAt: 0, timer: null };
    this.streamFlushStates.set(turnId, state);

    const deltaLength = Math.max(0, text.length - state.flushedLength);
    const elapsed = Date.now() - state.lastFlushedAt;
    if (deltaLength >= STREAM_FLUSH_MIN_CHARS || elapsed >= STREAM_FLUSH_INTERVAL_MS) {
      await this.flushStreamUpdate(turnId, text, false);
      return;
    }

    if (state.timer) return;

    const delay = Math.max(0, STREAM_FLUSH_INTERVAL_MS - elapsed);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushStreamUpdate(turnId, text, false);
    }, delay);
  }

  /** 立即把当前文本刷新到卡片。 */
  async flushStreamUpdate(turnId: string, text: string, force: boolean): Promise<void> {
    const state = this.streamFlushStates.get(turnId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    await this.updateTurnCard(turnId, { update: text, sanitize: false, target: "final" });
    const nextState = state ?? { flushedLength: 0, lastFlushedAt: 0, timer: null };
    nextState.flushedLength = text.length;
    nextState.lastFlushedAt = Date.now();
    this.streamFlushStates.set(turnId, nextState);

    if (force) {
      this.clearStreamFlushState(turnId);
    }
  }

  /** 更新 turn 卡片中的状态、步骤、工具或最终输出。 */
  async updateTurnCard(turnId: string, update: { status?: string; sessionId?: string; update?: string; sanitize?: boolean; target?: "step" | "tool" | "final"; toolKey?: string; costSummary?: string }): Promise<void> {
    const card = this.turnCards.get(turnId);
    if (!card) return;

    if (update.status) card.status = update.status;
    if (update.sessionId) card.sessionId = update.sessionId;
    if (update.costSummary !== undefined) card.costSummary = update.costSummary;
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
      logEvent(this.logger, "feishu/reply", "transport.sent", {
        messageId: result.messageId,
        turnId,
        transportAction: "update",
        payloadKind: "card",
        legacyEvent: "process message updated",
        textPreview: createTextPreview([...card.progressUpdates, ...card.toolUpdates.map((item) => item.view.label)].join(" | ")),
        len: [...card.progressUpdates, ...card.toolUpdates.map((item) => item.view.label)].join("\n").length,
      });
      this.logger.logTranscript("outbound-process", { messageId: result.messageId }, prettyPrintPayload(payload));
      if (card.output.text) {
        this.contextRecorder?.rememberBridgeOutput({
          messageId: result.messageId,
          chatId: card.chatId,
          summary: createTextPreview(card.output.text),
          handoffSummary: {
            kind: "opencode-final",
            title: "OpenCode 回复",
            summary: createTextPreview(card.output.text),
            keyPoints: [createTextPreview(card.output.text)],
            sourceMessageId: result.messageId,
            createdAt: Date.now(),
          },
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logEvent(this.logger, "feishu/reply", "transport.failed", {
        messageId: card.messageId,
        turnId,
        transportAction: "update",
        payloadKind: "card",
        legacyEvent: "process card update failed",
        errorKind: error instanceof Error ? error.name : "unknown",
        detail,
      }, "warn");
    }
  }

  // #endregion

  // #region 内部辅助

  /** 清理单个 turn 的流式刷新状态。 */
  private clearStreamFlushState(turnId: string): void {
    const state = this.streamFlushStates.get(turnId);
    if (state?.timer) clearTimeout(state.timer);
    this.streamFlushStates.delete(turnId);
  }

  /** 将内部状态转换为运行时卡片视图。 */
  private toTurnCardView(card: TurnCardState): TurnStatusCardView {
    return {
      title: card.status.includes("完成") ? "已完成" : card.status.includes("失败") || card.status.includes("超时") ? "处理异常" : "处理中",
      status: card.status,
      sessionId: card.sessionId,
      durationText: isFinalStatus(card.status) ? formatDuration(Date.now() - card.startedAt) : "",
      progressUpdates: card.progressUpdates,
      toolUpdates: card.toolUpdates.map((item) => item.view),
      output: card.output,
      costSummary: card.costSummary,
    };
  }

  /** 发送过程卡，并统一记录传输日志。 */
  private async sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
  ): Promise<{ messageId: string }> {
    const result = this.replyInThread && delivery?.replyToMessageId
      ? await this.outbound.replyMessage(delivery.replyToMessageId, payload)
      : await this.outbound.sendMessage(chatId, payload);
    logEvent(this.logger, "feishu/reply", "transport.sent", {
      chatId,
      messageId: result.messageId,
      transportAction: this.replyInThread && delivery?.replyToMessageId ? "reply" : "send",
      payloadKind: payload.msg_type === "interactive" ? "card" : "post",
      legacyEvent: options.event,
      textPreview: options.textPreview,
      len: options.len,
    });
    this.logger.logTranscript(options.transcriptType, { chatId, messageId: result.messageId }, prettyPrintPayload(payload));
    return result;
  }

  // #endregion
}
