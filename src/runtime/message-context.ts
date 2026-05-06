/**
 * 职责: 保存短期飞书消息上下文，并为回复链路生成 Prompt 补充块。
 * 关注点:
 * - 记录用户入站消息和 Bridge 自身输出的摘要。
 * - 根据 parent/root 消息关系找回上下文，帮助模型理解飞书回复场景。
 * - 控制上下文数量和长度，避免把临时上下文扩散成长期记忆。
 * - 通过 ring buffer 持久化保存最近 1000 条 Bridge 输出，支持引用续接。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingChatMessage } from "./app.js";

export type BridgeOutputContextKind = "opencode-final" | "labor-result" | "knowledge-result" | "contract-result" | "file-result" | "system-result";

export type BridgeOutputContext = {
  kind: BridgeOutputContextKind;
  title: string;
  summary: string;
  keyPoints: string[];
  links?: string[] | undefined;
  sourceMessageId?: string | undefined;
  conversationKey?: string | undefined;
  createdAt: number;
};

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
  /** 结构化 Bridge 输出上下文（仅 bridge-output 条目有值） */
  bridgeOutput?: BridgeOutputContext | undefined;
};

const MAX_CONTEXT_ENTRIES = 1000;
const MAX_SUMMARY_LENGTH = 1200;
const MAX_BLOCK_LENGTH = 2400;

export class BridgeMessageContextStore {
  private readonly entries = new Map<string, BridgeMessageContextEntry>();
  private readonly dataDir: string;
  private readonly logger: { log(scope: string, message: string, data?: Record<string, unknown>, level?: string): void };
  private persistChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, logger: { log(scope: string, message: string, data?: Record<string, unknown>, level?: string): void }) {
    this.dataDir = dataDir;
    this.logger = logger;
  }

  async restore(): Promise<void> {
    try {
      const content = await readFile(path.join(this.dataDir, "message-context.json"), "utf-8");
      const parsed = JSON.parse(content) as BridgeMessageContextEntry[];
      const now = Date.now();
      for (const entry of parsed) {
        if (entry.createdAt > now - 7 * 24 * 60 * 60 * 1000) {
          this.entries.set(entry.messageId, entry);
        }
      }
      this.logger.log("runtime/message-context", "restored", { count: this.entries.size }, "debug");
    } catch {
      // 文件不存在或解析失败，忽略
    }
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain.then(async () => {
      try {
        await mkdir(this.dataDir, { recursive: true });
        const entries = [...this.entries.values()]
          .filter((entry) => entry.kind === "bridge-output")
          .slice(-MAX_CONTEXT_ENTRIES);
        await writeFile(path.join(this.dataDir, "message-context.json"), JSON.stringify(entries), "utf-8");
      } catch (error) {
        this.logger.log("runtime/message-context", "persist failed", { detail: String(error) }, "warn");
      }
    });
  }

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
    }, { persist: false });
  }

  rememberBridgeOutput(input: {
    messageId: string;
    chatId: string;
    replyToMessageId?: string | undefined;
    summary?: string | undefined;
    handoffSummary?: BridgeOutputContext | undefined;
  }, now = Date.now()): void {
    const summary = normalizeSummary(input.handoffSummary?.summary ?? input.summary);
    if (!summary && !input.handoffSummary) {
      return;
    }
    const bridgeOutput = normalizeBridgeOutputContext(input, summary, now);
    const entry: BridgeMessageContextEntry = {
      messageId: input.messageId,
      chatId: input.chatId,
      parentId: input.replyToMessageId,
      kind: "bridge-output",
      summary: bridgeOutput.summary,
      createdAt: now,
      bridgeOutput,
    };
    this.remember(entry, { persist: true });
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
      lines.push("", `- sourceMessageId: ${context.messageId}`, `  sourceKind: ${context.kind}`, `  chatId: ${context.chatId}`);
      if (context.conversationKey) {
        lines.push(`  conversationKey: ${context.conversationKey}`);
      }
      if (context.senderOpenId) {
        lines.push(`  senderOpenId: ${context.senderOpenId}`);
      }
      if (context.bridgeOutput) {
        lines.push(`  title: ${context.bridgeOutput.title}`);
        lines.push(`  kind: ${context.bridgeOutput.kind}`);
        if (context.bridgeOutput.keyPoints.length > 0) {
          lines.push("  keyPoints:");
          for (const point of context.bridgeOutput.keyPoints) {
            lines.push(`    - ${point}`);
          }
        }
        if (context.bridgeOutput.links && context.bridgeOutput.links.length > 0) {
          lines.push("  links:");
          for (const link of context.bridgeOutput.links) {
            lines.push(`    - ${link}`);
          }
        }
      }
      lines.push("  summary:");
      for (const line of context.summary.split("\n")) {
        lines.push(`    ${line}`);
      }
    }

    return truncate(lines.join("\n"), MAX_BLOCK_LENGTH);
  }

  buildRuntimeContext(message: Pick<IncomingChatMessage, "messageId" | "rootId" | "parentId">): BridgeOutputContext[] {
    return this.resolveReplyContexts(message)
      .filter((entry) => entry.bridgeOutput !== undefined)
      .map((entry) => entry.bridgeOutput!);
  }

  private remember(entry: BridgeMessageContextEntry, options: { persist: boolean }): void {
    this.entries.delete(entry.messageId);
    this.entries.set(entry.messageId, entry);
    while (this.entries.size > MAX_CONTEXT_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest);
    }
    if (options.persist) {
      this.schedulePersist();
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
  if (message.messageType === "file" || message.messageType === "image") {
    return normalizeSummary(`[file] ${message.file.fileName}`);
  }
  return normalizeSummary(message.plainText);
}

function normalizeBridgeOutputContext(
  input: {
    messageId: string;
    summary?: string | undefined;
    handoffSummary?: BridgeOutputContext | undefined;
  },
  fallbackSummary: string,
  now: number,
): BridgeOutputContext {
  if (input.handoffSummary) {
    return {
      ...input.handoffSummary,
      summary: normalizeSummary(input.handoffSummary.summary || fallbackSummary),
      sourceMessageId: input.handoffSummary.sourceMessageId ?? input.messageId,
      createdAt: input.handoffSummary.createdAt || now,
    };
  }
  const summary = normalizeSummary(fallbackSummary);
  return {
    kind: "system-result",
    title: summary || "Bridge 输出",
    summary,
    keyPoints: summary ? [summary] : [],
    sourceMessageId: input.messageId,
    createdAt: now,
  };
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
