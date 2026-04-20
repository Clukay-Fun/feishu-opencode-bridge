import type { LogContext } from "../logging/logger.js";

export type BridgeTurn = {
  turnId: string;
  chatId: string;
  conversationKey: string;
  threadKey: string;
  chatType?: string;
  senderOpenId: string;
  inboundMessageId: string;
  plainText: string;
  text: string;
  sessionId?: string;
  processMessageId?: string;
  finalMessageId?: string;
  state?: "queued" | "running" | "awaiting-sse" | "done" | "timeout" | "aborted";
  startedAt?: number;
  logContext?: LogContext;
};

export type QueueNotice = {
  message: string;
};
