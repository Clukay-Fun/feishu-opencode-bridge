import { type FeishuPostPayload, type OutputView, type ToolUpdateView } from "../feishu/shared-primitives.js";
import { buildTurnStatusCardPayload, type TurnStatusCardView } from "../feishu/runtime-cards.js";
import { createTextPreview, logEvent, type Logger, type TranscriptType } from "../logging/logger.js";
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

const INITIAL_CARD_SUMMARY = "已创建会话，等待 OpenCode 事件...";
const STREAM_FLUSH_MIN_CHARS = 120;
const STREAM_FLUSH_INTERVAL_MS = 750;

type OutboundPort = {
  sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: FeishuPostPayload, options?: { replyInThread?: boolean }): Promise<{ messageId: string }>;
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

export class TurnCardManager {
  private readonly turnCards = new Map<string, TurnCardState>();
  private readonly streamFlushStates = new Map<string, StreamFlushState>();

  constructor(
    private readonly outbound: OutboundPort,
    private readonly logger: Logger,
    private readonly replyInThread: boolean,
  ) {}

  stop(): void {
    for (const state of this.streamFlushStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.streamFlushStates.clear();
  }

  cleanup(turnId: string): void {
    this.turnCards.delete(turnId);
    this.clearStreamFlushState(turnId);
  }

  async createTurnCard(chatId: string, turnId: string, sessionId: string, replyToMessageId: string): Promise<{ messageId: string } | null> {
    const state: TurnCardState = {
      messageId: "",
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

  async updateTurnCard(turnId: string, update: { status?: string; update?: string; sanitize?: boolean; target?: "step" | "tool" | "final"; toolKey?: string }): Promise<void> {
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

  private clearStreamFlushState(turnId: string): void {
    const state = this.streamFlushStates.get(turnId);
    if (state?.timer) clearTimeout(state.timer);
    this.streamFlushStates.delete(turnId);
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
}
