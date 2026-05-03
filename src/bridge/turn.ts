/**
 * 职责: 定义桥接层单轮执行体 BridgeTurn 的核心数据结构。
 * 关注点:
 * - 固定一次请求在队列、执行、收尾过程中的身份与上下文。
 * - 描述 turn 的生命周期状态，以及进度卡、消息锚点等运行时元数据。
 * - 为队列、执行器和卡片管理器提供共享状态模型。
 */
import type { LogContext } from "../logging/logger.js";
import type { OpenCodeModelRef, OpenCodePromptPart } from "../opencode/client.js";

export type BridgeTurn = {
  // Stable identity for one bridge turn across queueing and execution.
  turnId: string;
  // Chat and conversation coordinates used to route replies back to Feishu.
  chatId: string;
  conversationKey: string;
  threadKey: string;
  chatType?: string;
  // Sender and inbound message metadata captured from the original event.
  senderOpenId: string;
  inboundMessageId: string;
  plainText: string;
  text: string;
  promptParts?: OpenCodePromptPart[] | undefined;
  model?: OpenCodeModelRef | undefined;
  // Runtime-owned session and message anchors created while the turn executes.
  sessionId?: string;
  processMessageId?: string;
  finalMessageId?: string;
  // Coarse lifecycle state used by queueing and status cards.
  state?: "queued" | "running" | "awaiting-sse" | "done" | "timeout" | "aborted";
  startedAt?: number;
  logContext?: LogContext;
};

export type QueueNotice = {
  // Human-readable queue status shown back to the user.
  message: string;
};
