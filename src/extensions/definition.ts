/**
 * 职责: 定义内置业务扩展 manifest 的内部契约。
 * 关注点:
 * - 收口启动期模块创建、命令声明和卡片模板声明。
 * - 明确该契约不作为第三方 plugin API，也不承担运行时热拔插。
 */
import type { RuntimeModule } from "../bridge/module.js";
import type { AppConfig } from "../config/schema.js";
import type { AnyBusinessCardTemplateDefinition } from "../feishu/templates/definition.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";

export type RuntimeModuleOutboundPort = {
  sendMessage(chatId: string, payload: { msg_type: "post" | "interactive"; content: string }): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: { msg_type: "post" | "interactive"; content: string }, options?: { replyInThread?: boolean }): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: { msg_type: "post" | "interactive"; content: string }): Promise<{ messageId: string }>;
  downloadMessageResource(messageId: string, fileKey: string, type: "file"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
  listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
  updateBitableRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
};

export type RuntimeExtensionContext = {
  config: AppConfig;
  outbound: RuntimeModuleOutboundPort;
  transport: FeishuTransport;
  logger: Logger;
  opencode: Pick<OpenCodeClient,
    | "createSession"
    | "getSessionMessages"
    | "listSessions"
    | "postMessageSync"
    | "promptAsync"
    | "replyPermission"
    | "replyQuestion"
    | "runCommand"
  >;
  memory?: unknown;
  knowledge: KnowledgeBasePort | null;
  whitelist: Pick<WhitelistStore, "bind">;
  getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord;
  saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void>;
  createAndBindSession(source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<SessionBindingRecord>;
};

/** @internal 内置扩展 manifest，不作为第三方 plugin API。 */
export type BuiltinExtensionDefinition = {
  id: string;
  configKey?: keyof AppConfig;
  commands?: readonly ExtensionCommandDefinition[];
  createModule(context: RuntimeExtensionContext): RuntimeModule | null | Promise<RuntimeModule | null>;
  cardTemplates?: readonly AnyBusinessCardTemplateDefinition[];
  workflows?: readonly string[];
};

export type ExtensionCommandDefinition = {
  name: string;
  aliases?: readonly string[];
  owner: "framework" | "business";
  description: string;
};
