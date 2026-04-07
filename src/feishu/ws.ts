import * as lark from "@larksuiteoapi/node-sdk";

import { routeIncomingText } from "../bridge/router.js";
import type { AppConfig } from "../config/schema.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { ChatWhitelist } from "../store/whitelist.js";

type MessageHandler = (message: IncomingChatMessage) => Promise<void>;

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type FeishuMention = {
  key?: string;
  name?: string;
  id?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
    app_id?: string;
  };
};

type FeishuReceiveEvent = {
  message?: {
    chat_id?: string;
    chat_type?: string;
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    message_type?: string;
    content?: string;
    mentions?: FeishuMention[];
  };
  sender?: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      user_id?: string;
      app_id?: string;
    };
  };
};

type FeishuSenderId = {
  open_id?: string;
  user_id?: string;
  app_id?: string;
};

type NormalizedMention = {
  openId?: string | undefined;
  userId?: string | undefined;
  key?: string | undefined;
  name?: string | undefined;
};

type TextParseResult = {
  plainText: string;
  hasAnyMention: boolean;
  hasExactBotMention: boolean;
};

type IncomingMessageInspection =
  | {
    accepted: true;
    incoming: IncomingChatMessage;
    hasAnyMention: boolean;
    hasExactBotMention: boolean;
    fields?: Record<string, unknown>;
  }
  | {
    accepted: false;
    reason:
      | "no-message"
      | "unsupported-chat-type"
      | "unsupported-message-type"
      | "self-bot-sender"
      | "malformed-message"
      | "group-mention-mismatch"
      | "not-whitelisted"
      | "empty-plain-text";
    fields?: Record<string, unknown>;
  };

const SUPPORTED_MESSAGE_TYPES = new Set(["text", "post"]);
const RECENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const NOOP_WHITELIST: ChatWhitelist = {
  isBound: () => false,
  bind: async () => {},
  unbind: async () => false,
  count: () => 0,
};

type FeishuIngressOptions = {
  botOpenIds: Set<string>;
  botMentionNames: Set<string>;
  selfBotOpenIds: Set<string>;
  enableP2p: boolean;
  enableGroup: boolean;
  requireBotMentionInGroup: boolean;
  strictBotMention: boolean;
  ignoreNonUserSenders: boolean;
};

export class FeishuWsClient {
  private client: lark.WSClient;
  private dispatcher: lark.EventDispatcher;
  private readonly recentMessageIds = new Map<string, number>();

  constructor(
    appId: string,
    appSecret: string,
    private readonly options: FeishuIngressOptions,
    private readonly handler: MessageHandler,
    private readonly logger: LoggerLike,
    private readonly whitelist: ChatWhitelist = NOOP_WHITELIST,
  ) {
    this.dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.handleEvent((data ?? {}) as FeishuReceiveEvent);
      },
      // Feishu may emit this access event when a bot enters a p2p chat.
      // We do not need it for runtime behavior, but registering a no-op
      // handler keeps the SDK from logging an avoidable warning.
      "im.chat.access_event.bot_p2p_chat_entered_v1": async () => {},
    });

    this.client = new lark.WSClient({
      appId,
      appSecret,
    });
  }

  async start(): Promise<void> {
    await this.client.start({ eventDispatcher: this.dispatcher });
    this.logger.log("feishu/ws", "connection opened", {});
  }

  async stop(): Promise<void> {
    this.client.stop();
  }

  private async handleEvent(payload: FeishuReceiveEvent): Promise<void> {
    const duplicateMessageId = this.markMessageSeen(payload.message?.message_id);
    if (duplicateMessageId) {
      this.logger.log("feishu/ws", "duplicate message skipped", { messageId: duplicateMessageId }, "warn");
      return;
    }

    const inspection = await inspectIncomingMessageForDispatch(payload, this.options, this.whitelist);
    if (!inspection.accepted) {
      this.logger.log("feishu/ws", "message skipped", { reason: inspection.reason, ...(inspection.fields ?? {}) }, "warn");
      return;
    }
    const incoming = inspection.incoming;

    this.logger.log("feishu/ws", "message received", {
      chatId: incoming.chatId,
      chatType: incoming.chatType,
      conversationKey: incoming.conversationKey,
      threadKey: incoming.threadKey,
      messageId: incoming.messageId,
      senderId: incoming.senderOpenId,
      messageType: incoming.messageType,
      textPreview: incoming.plainText,
      len: incoming.plainText.length,
      ...(inspection.fields ?? {}),
    });

    const routed = routeIncomingText(incoming.plainText);
    if (
      incoming.chatType !== "p2p"
      && routed.kind === "message"
      && resolveMentionMatch(inspection, this.options)
    ) {
      try {
        await this.whitelist.bind(incoming.chatId, incoming.senderOpenId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.log("store/whitelist", "bind failed", {
          chatId: incoming.chatId,
          senderOpenId: incoming.senderOpenId,
          detail,
        }, "warn");
      }
    }

    await this.handler(incoming);
  }

  private markMessageSeen(messageId: string | undefined): string | null {
    const normalized = nonEmptyString(messageId);
    if (!normalized) {
      return null;
    }

    const now = Date.now();
    for (const [seenMessageId, seenAt] of this.recentMessageIds) {
      if (now - seenAt > RECENT_MESSAGE_TTL_MS) {
        this.recentMessageIds.delete(seenMessageId);
      }
    }

    if (this.recentMessageIds.has(normalized)) {
      return normalized;
    }

    this.recentMessageIds.set(normalized, now);
    return null;
  }
}

export function createFeishuIngressOptions(feishu: AppConfig["feishu"]): FeishuIngressOptions {
  const botOpenIds = new Set(feishu.botOpenIds);
  if (feishu.botOpenId) {
    botOpenIds.add(feishu.botOpenId);
  }
  return {
    botOpenIds,
    botMentionNames: new Set(feishu.botMentionNames),
    selfBotOpenIds: new Set(feishu.selfBotOpenIds),
    enableP2p: feishu.behavior.enableP2p,
    enableGroup: feishu.behavior.enableGroup,
    requireBotMentionInGroup: feishu.behavior.requireBotMentionInGroup,
    strictBotMention: feishu.behavior.strictBotMention,
    ignoreNonUserSenders: feishu.behavior.ignoreNonUserSenders,
  };
}

export function normalizeIncomingMessage(payload: FeishuReceiveEvent, options: FeishuIngressOptions): IncomingChatMessage | null {
  const inspection = inspectIncomingMessage(payload, options);
  return inspection.accepted ? inspection.incoming : null;
}

function inspectIncomingMessage(payload: FeishuReceiveEvent, options: FeishuIngressOptions): IncomingMessageInspection {
  const parsed = parseIncomingMessage(payload, options);
    if (!parsed.accepted) {
      return parsed;
    }

  if (parsed.incoming.chatType !== "p2p" && options.requireBotMentionInGroup) {
    const mentionMatched = resolveMentionMatch(parsed, options);
    if (!mentionMatched) {
      return {
        accepted: false,
        reason: "group-mention-mismatch",
        ...(parsed.fields ? { fields: parsed.fields } : {}),
      };
    }
  }

  return parsed;
}

async function inspectIncomingMessageForDispatch(
  payload: FeishuReceiveEvent,
  options: FeishuIngressOptions,
  whitelist: ChatWhitelist,
): Promise<IncomingMessageInspection> {
  const parsed = parseIncomingMessage(payload, options);
  if (!parsed.accepted) {
    return parsed;
  }

  if (parsed.incoming.chatType === "p2p") {
    return parsed;
  }

  const routed = routeIncomingText(parsed.incoming.plainText);
  const hasBotMention = resolveMentionMatch(parsed, options);
  const isBound = whitelist.isBound(parsed.incoming.chatId, parsed.incoming.senderOpenId);

  if (routed.kind === "command") {
    if (hasBotMention || isBound) {
      return {
        ...parsed,
        fields: {
          ...(parsed.fields ?? {}),
          whitelistMatched: isBound,
          whitelistSize: whitelist.count(parsed.incoming.chatId),
        },
      };
    }

    return {
      accepted: false,
      reason: parsed.hasAnyMention ? "group-mention-mismatch" : "not-whitelisted",
      fields: {
        ...(parsed.fields ?? {}),
        chatId: parsed.incoming.chatId,
        chatType: parsed.incoming.chatType,
        messageId: parsed.incoming.messageId,
        senderOpenId: parsed.incoming.senderOpenId,
        whitelistChatId: parsed.incoming.chatId,
      },
    };
  }

  if (hasBotMention) {
    return {
      ...parsed,
      fields: {
        ...(parsed.fields ?? {}),
        whitelistMatched: isBound,
        whitelistSize: whitelist.count(parsed.incoming.chatId),
      },
    };
  }

  if (isBound) {
    return {
      ...parsed,
      fields: {
        ...(parsed.fields ?? {}),
        whitelistMatched: true,
        whitelistSize: whitelist.count(parsed.incoming.chatId),
      },
    };
  }

  return {
    accepted: false,
    reason: parsed.hasAnyMention ? "group-mention-mismatch" : "not-whitelisted",
    fields: {
      ...(parsed.fields ?? {}),
      chatId: parsed.incoming.chatId,
      chatType: parsed.incoming.chatType,
      messageId: parsed.incoming.messageId,
      senderOpenId: parsed.incoming.senderOpenId,
      whitelistChatId: parsed.incoming.chatId,
    },
  };
}

function parseIncomingMessage(payload: FeishuReceiveEvent, options: FeishuIngressOptions): IncomingMessageInspection {
  const message = payload.message;
  if (!message) {
    return { accepted: false, reason: "no-message" };
  }

  const chatType = String(message.chat_type ?? "");
  const messageType = String(message.message_type ?? "");
  const senderType = String(payload.sender?.sender_type ?? "").toUpperCase();
  const senderOpenId = normalizeSenderId(payload.sender?.sender_id);
  if (!isChatTypeEnabled(chatType, options)) {
    return { accepted: false, reason: "unsupported-chat-type", fields: { chatType } };
  }
  if (!SUPPORTED_MESSAGE_TYPES.has(messageType)) {
    return { accepted: false, reason: "unsupported-message-type", fields: { chatType, messageType } };
  }

  if (options.ignoreNonUserSenders && senderType && senderType !== "USER" && options.selfBotOpenIds.has(senderOpenId)) {
    return {
      accepted: false,
      reason: "self-bot-sender",
      fields: {
        chatType,
        messageId: message.message_id,
        senderOpenId,
        senderType,
        configuredSelfBotOpenIds: [...options.selfBotOpenIds],
      },
    };
  }

  const chatId = String(message.chat_id ?? "");
  const messageId = String(message.message_id ?? "");
  if (!chatId || !messageId || !senderOpenId) {
    return {
      accepted: false,
      reason: "malformed-message",
      fields: { chatId, messageId, senderOpenId },
    };
  }

  const normalizedMentions = normalizeMentions(message.mentions);
  const parsed = parseMessageContent(messageType, message.content ?? "", normalizedMentions, options.botOpenIds, options.botMentionNames);
  const mentionIds = normalizedMentions.flatMap((mention) => [mention.openId, mention.userId, mention.key].filter((value): value is string => Boolean(value)));
  if (!parsed) {
    return { accepted: false, reason: "unsupported-message-type", fields: { chatType, messageType } };
  }

  const threadKey = computeThreadKey({
    chatType,
    messageId,
    rootId: message.root_id,
    parentId: message.parent_id,
  });
  const plainText = normalizeWhitespace(parsed.plainText);
  if (!plainText) {
    return {
      accepted: false,
      reason: "empty-plain-text",
      fields: { chatId, chatType, messageId },
    };
  }

  return {
    accepted: true,
    incoming: {
      chatId,
      chatType,
      senderOpenId,
      messageId,
      messageType,
      rawContent: message.content ?? "",
      plainText,
      rootId: nonEmptyString(message.root_id),
      parentId: nonEmptyString(message.parent_id),
      threadKey,
      conversationKey: buildConversationKey(chatType, chatId, threadKey),
    },
    hasAnyMention: parsed.hasAnyMention,
    hasExactBotMention: parsed.hasExactBotMention,
    fields: {
      senderType,
      mentionIds,
      configuredBotOpenIds: [...options.botOpenIds],
      configuredBotMentionNames: [...options.botMentionNames],
      configuredSelfBotOpenIds: [...options.selfBotOpenIds],
      hasAnyMention: parsed.hasAnyMention,
      hasExactBotMention: parsed.hasExactBotMention,
    },
  };
}

function resolveMentionMatch(
  inspection: Extract<IncomingMessageInspection, { accepted: true }>,
  options: FeishuIngressOptions,
): boolean {
  return options.strictBotMention
    ? inspection.hasExactBotMention
    : inspection.hasExactBotMention || inspection.hasAnyMention;
}

function isChatTypeEnabled(chatType: string, options: FeishuIngressOptions): boolean {
  if (chatType === "p2p") {
    return options.enableP2p;
  }

  if (chatType === "group" || chatType === "topic_group") {
    return options.enableGroup;
  }

  return false;
}

export function computeThreadKey(input: {
  chatType: string;
  messageId: string;
  rootId?: string | undefined;
  parentId?: string | undefined;
}): string {
  if (input.chatType === "p2p") {
    return input.messageId;
  }

  return nonEmptyString(input.rootId) ?? nonEmptyString(input.parentId) ?? input.messageId;
}

export function buildConversationKey(chatType: string, chatId: string, threadKey: string): string {
  return chatType === "p2p" ? chatId : `${chatId}:${threadKey}`;
}

function parseMessageContent(
  messageType: string,
  rawContent: string,
  mentions: NormalizedMention[],
  botOpenIds: Set<string>,
  botMentionNames: Set<string>,
): TextParseResult | null {
  if (messageType === "text") {
    return parseTextMessage(rawContent, mentions, botOpenIds, botMentionNames);
  }

  if (messageType === "post") {
    return parsePostMessage(rawContent, mentions, botOpenIds, botMentionNames);
  }

  return null;
}

function parseTextMessage(rawContent: string, mentions: NormalizedMention[], botOpenIds: Set<string>, botMentionNames: Set<string>): TextParseResult {
  const text = parseRawTextContent(rawContent);
  const contentResult = replaceAtTags(text, botOpenIds, botMentionNames);
  const exactFromMentions = mentions.some((mention) => matchesBotMention(mention, botOpenIds, botMentionNames));
  const hasAnyMention = contentResult.hasAnyMention || mentions.length > 0;
  return {
    plainText: contentResult.plainText,
    hasAnyMention,
    hasExactBotMention: contentResult.hasExactBotMention || exactFromMentions,
  };
}

function parsePostMessage(rawContent: string, mentions: NormalizedMention[], botOpenIds: Set<string>, botMentionNames: Set<string>): TextParseResult {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const localeKey = Object.keys(parsed).find((key) => isRecord(parsed[key]));
    if (!localeKey) {
      return { plainText: "", hasAnyMention: false, hasExactBotMention: false };
    }

    const localePayload = parsed[localeKey];
    if (!isRecord(localePayload)) {
      return { plainText: "", hasAnyMention: false, hasExactBotMention: false };
    }

    const blocks = Array.isArray(localePayload.content) ? localePayload.content : [];
    const parts: string[] = [];
    let hasAnyMention = mentions.length > 0;
    let hasExactBotMention = mentions.some((mention) => matchesBotMention(mention, botOpenIds, botMentionNames));

    for (const row of blocks) {
      if (!Array.isArray(row)) continue;
      const rowParts: string[] = [];
      for (const element of row) {
        if (!isRecord(element)) continue;
        const tag = typeof element.tag === "string" ? element.tag : "";
        if (tag === "text" || tag === "a") {
          const text = typeof element.text === "string" ? element.text : "";
          if (text) {
            rowParts.push(text);
          }
          continue;
        }

        if (tag === "at") {
          hasAnyMention = true;
          const mention = {
            openId: nonEmptyStringFromKeys(element, ["open_id", "user_id"]),
            userId: nonEmptyStringFromKeys(element, ["user_id"]),
            key: nonEmptyStringFromKeys(element, ["key"]),
            name: nonEmptyStringFromKeys(element, ["user_name", "name", "text"]),
          };
          if (matchesBotMention(mention, botOpenIds, botMentionNames)) {
            hasExactBotMention = true;
            continue;
          }
          rowParts.push(formatVisibleMention(mention.name));
        }
      }

      if (rowParts.length > 0) {
        parts.push(rowParts.join("").trim());
      }
    }

    return {
      plainText: parts.join("\n"),
      hasAnyMention,
      hasExactBotMention,
    };
  } catch {
    return { plainText: "", hasAnyMention: false, hasExactBotMention: false };
  }
}

function parseRawTextContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return rawContent;
  }
}

function replaceAtTags(text: string, botOpenIds: Set<string>, botMentionNames: Set<string>): TextParseResult {
  let hasAnyMention = false;
  let hasExactBotMention = false;
  const plainText = text.replace(/<at\b([^>]*)>([\s\S]*?)<\/at>/gi, (_, rawAttrs: string, innerText: string) => {
    hasAnyMention = true;
    const mention = parseAtTagAttributes(rawAttrs, innerText);
    if (matchesBotMention(mention, botOpenIds, botMentionNames)) {
      hasExactBotMention = true;
      return "";
    }
    return formatVisibleMention(mention.name);
  });

  return {
    plainText,
    hasAnyMention,
    hasExactBotMention,
  };
}

function normalizeMentions(mentions: FeishuMention[] | undefined): NormalizedMention[] {
  if (!Array.isArray(mentions)) {
    return [];
  }

  return mentions.map((mention) => ({
    openId: nonEmptyString(mention.id?.open_id),
    userId: nonEmptyString(mention.id?.user_id),
    key: nonEmptyString(mention.key),
    name: nonEmptyString(mention.name),
  }));
}

function parseAtTagAttributes(rawAttrs: string, innerText: string): NormalizedMention {
  return {
    openId: extractAttribute(rawAttrs, ["open_id", "user_id"]),
    userId: extractAttribute(rawAttrs, ["user_id"]),
    key: extractAttribute(rawAttrs, ["key"]),
    name: normalizeWhitespace(innerText),
  };
}

function extractAttribute(rawAttrs: string, names: string[]): string | undefined {
  for (const name of names) {
    const match = rawAttrs.match(new RegExp(`${name}="([^"]+)"`, "i"));
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function matchesBotMention(mention: NormalizedMention, botOpenIds: Set<string>, botMentionNames: Set<string>): boolean {
  if (
    (mention.openId !== undefined && botOpenIds.has(mention.openId))
    || (mention.userId !== undefined && botOpenIds.has(mention.userId))
    || (mention.key !== undefined && botOpenIds.has(mention.key))
  ) {
    return true;
  }

  const normalizedName = normalizeMentionName(mention.name);
  return normalizedName !== undefined && botMentionNames.has(normalizedName);
}

function normalizeMentionName(name: string | undefined): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }

  const normalized = name.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function formatVisibleMention(name?: string): string {
  return name ? `@${name}` : "";
}

function normalizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nonEmptyStringFromKeys(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function normalizeSenderId(senderId: FeishuSenderId | undefined): string {
  return String(senderId?.open_id ?? senderId?.user_id ?? senderId?.app_id ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
