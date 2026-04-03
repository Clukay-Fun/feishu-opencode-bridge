export type BridgeTurn = {
  turnId: string;
  chatId: string;
  senderOpenId: string;
  inboundMessageId: string;
  text: string;
  sessionId?: string;
  processMessageId?: string;
  finalMessageId?: string;
  state?: "queued" | "running" | "awaiting-sse" | "done" | "timeout" | "aborted";
  startedAt?: number;
};

export type QueueNotice = {
  message: string;
};
