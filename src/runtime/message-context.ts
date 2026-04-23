import type { IncomingChatMessage } from "./app.js";

export type BridgeMessageContextKind = "inbound" | "bridge-output";

export type BridgeMessageContextEntry = {
  messageId: string;
  chatId: string;
  conversationKey?: string | undefined;
  threadKey?: string | undefined;
  rootId?: string | undefined;
  parentId?: string | undefined;
  kind: BridgeMessageContextKind;
  senderOpenId?: string | undefined;
  summary: string;
  createdAt: number;
};

const MAX_CONTEXT_ENTRIES = 500;
const MAX_SUMMARY_LENGTH = 1200;
const MAX_BLOCK_LENGTH = 2400;

export class BridgeMessageContextStore {
  private readonly entries = new Map<string, BridgeMessageContextEntry>();

  rememberInbound(message: IncomingChatMessage, now = Date.now()): void {
    this.remember({
      messageId: message.messageId,
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      threadKey: message.threadKey,
      rootId: message.rootId,
      parentId: message.parentId,
      kind: "inbound",
      senderOpenId: message.senderOpenId,
      summary: summarizeInboundMessage(message),
      createdAt: now,
    });
  }

  rememberBridgeOutput(input: {
    messageId: string;
    chatId: string;
    replyToMessageId?: string | undefined;
    summary?: string | undefined;
  }, now = Date.now()): void {
    const summary = normalizeSummary(input.summary);
    if (!summary) {
      return;
    }
    this.remember({
      messageId: input.messageId,
      chatId: input.chatId,
      parentId: input.replyToMessageId,
      kind: "bridge-output",
      summary,
      createdAt: now,
    });
  }

  resolveReplyContexts(message: Pick<IncomingChatMessage, "messageId" | "rootId" | "parentId">): BridgeMessageContextEntry[] {
    const candidateIds = [message.parentId, message.rootId]
      .filter((value): value is string => Boolean(value) && value !== message.messageId);
    const contexts: BridgeMessageContextEntry[] = [];
    const seen = new Set<string>();
    for (const messageId of candidateIds) {
      if (seen.has(messageId)) {
        continue;
      }
      seen.add(messageId);
      const entry = this.entries.get(messageId);
      if (entry) {
        contexts.push(entry);
      }
    }
    return contexts;
  }

  buildPromptBlock(message: IncomingChatMessage): string | null {
    const contexts = this.resolveReplyContexts(message);
    if (contexts.length === 0) {
      return null;
    }

    const lines = [
      "[Bridge Message Context]",
      "The user is continuing from a Feishu reply/thread/create action. Treat this as short-term conversation context.",
      "Do not write it to durable memory unless the user explicitly asks or it contains a stable long-term fact.",
    ];

    for (const context of contexts) {
      lines.push(
        "",
        `- sourceMessageId: ${context.messageId}`,
        `  sourceKind: ${context.kind}`,
        `  chatId: ${context.chatId}`,
      );
      if (context.conversationKey) {
        lines.push(`  conversationKey: ${context.conversationKey}`);
      }
      if (context.senderOpenId) {
        lines.push(`  senderOpenId: ${context.senderOpenId}`);
      }
      lines.push("  summary:");
      for (const line of context.summary.split("\n")) {
        lines.push(`    ${line}`);
      }
    }

    return truncate(lines.join("\n"), MAX_BLOCK_LENGTH);
  }

  private remember(entry: BridgeMessageContextEntry): void {
    this.entries.delete(entry.messageId);
    this.entries.set(entry.messageId, entry);
    while (this.entries.size > MAX_CONTEXT_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

export function prependBridgeMessageContext(prompt: string, contextBlock: string | null): string {
  if (!contextBlock) {
    return prompt;
  }
  return `${contextBlock}\n\n[User Message]\n${prompt}`;
}

function summarizeInboundMessage(message: IncomingChatMessage): string {
  if (message.messageType === "file") {
    return normalizeSummary(`[file] ${message.file.fileName}`);
  }
  return normalizeSummary(message.plainText);
}

function normalizeSummary(value: string | undefined): string {
  return truncate((value ?? "").trim().replace(/\r\n?/g, "\n"), MAX_SUMMARY_LENGTH);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
