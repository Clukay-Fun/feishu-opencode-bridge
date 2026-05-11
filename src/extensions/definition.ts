/**
 * 职责: 定义内置业务扩展 manifest 的内部契约。
 * 关注点:
 * - 复用 extension-api 的公共声明形状，避免维护两套扩展 contract。
 * - 明确该契约不作为第三方 plugin API，也不承担运行时热拔插。
 */
import type { RuntimeModule } from "../bridge/module.js";
import type { AppConfig } from "../config/schema.js";
import type {
  ExtensionCommandDefinition,
  ExtensionDefinition,
  ExtensionMetaDefinition,
  ExtensionOutboundPort,
} from "../extension-api/index.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { CostTracker } from "../runtime/cost-tracker.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import type { CaseWorkbenchContextStore } from "../case-workbench/context-store.js";

export type RuntimeModuleOutboundPort = ExtensionOutboundPort;

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
  costTracker?: Pick<CostTracker, "recordExternalCall"> | undefined;
  caseContextStore?: CaseWorkbenchContextStore | undefined;
  whitelist: Pick<WhitelistStore, "bind">;
  getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord;
  saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void>;
  createAndBindSession(source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<SessionBindingRecord>;
};

/** @internal 内置扩展 data-only meta，不作为第三方 plugin API。 */
export type BuiltinExtensionMetaDefinition = ExtensionMetaDefinition<keyof AppConfig>;

/** @internal 内置扩展 runtime 创建入口，不作为第三方 plugin API。 */
export type BuiltinExtensionDefinition = ExtensionDefinition<keyof AppConfig, RuntimeExtensionContext, RuntimeModule>;
export type { ExtensionCommandDefinition };
