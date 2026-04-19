import { buildNoticeCardPayload, type FeishuPostPayload, type NoticeCardView } from "../feishu/shared-primitives.js";
import { createTextPreview, type TranscriptType } from "../logging/logger.js";

export type FeishuTransportLog = {
  event: string;
  transcriptType: TranscriptType;
  textPreview: string;
  len: number;
};

export type FeishuTransportDelivery = {
  replyToMessageId: string;
  replyInThread?: boolean;
};

export interface FeishuTransport {
  sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: FeishuTransportLog,
    delivery?: FeishuTransportDelivery,
  ): Promise<{ messageId: string }>;
  updatePayload(
    chatId: string,
    messageId: string,
    payload: FeishuPostPayload,
    options: FeishuTransportLog,
  ): Promise<{ messageId: string }>;
  sendNotice(
    message: Pick<FeishuTransportDelivery, "replyToMessageId"> & { chatId: string },
    notice: NoticeCardView,
    options: {
      event: string;
      transcriptType: TranscriptType;
      textPreview?: string;
      len?: number;
    },
    delivery?: Omit<FeishuTransportDelivery, "replyToMessageId">,
  ): Promise<{ messageId: string }>;
}

export function createFeishuTransport(callbacks: {
  sendPayload: FeishuTransport["sendPayload"];
  updatePayload: FeishuTransport["updatePayload"];
}): FeishuTransport {
  return {
    sendPayload: callbacks.sendPayload,
    updatePayload: callbacks.updatePayload,
    // `sendNotice` is the only transport-level convenience that builds a card payload.
    // Keep this boundary narrow: do not expand this pattern to other card families.
    async sendNotice(message, notice, options, delivery) {
      const nextDelivery = {
        replyToMessageId: message.replyToMessageId,
        ...(delivery?.replyInThread !== undefined ? { replyInThread: delivery.replyInThread } : {}),
      };
      return await callbacks.sendPayload(message.chatId, buildNoticeCardPayload(notice), {
        event: options.event,
        transcriptType: options.transcriptType,
        textPreview: options.textPreview ?? createTextPreview(notice.message),
        len: options.len ?? notice.message.length,
      }, nextDelivery);
    },
  };
}
