/**
 * 职责: 定义外部扩展唯一可依赖的公共契约面。
 * 关注点:
 * - 收口 L2 动态加载前置 API，不代表运行时热拔插或沙箱隔离。
 * - 只暴露扩展编程需要的 port、view 和声明 helper，避免泄漏 bridge 内部状态结构。
 * - 外部扩展应只从本入口 import 类型和 helper，不直接依赖 runtime/bridge/feishu/store 等内部目录。
 */
import type { z } from "zod";

import type {
  ConfigLoadContext as InternalConfigLoadContext,
  ModuleConfigDefinition as InternalModuleConfigDefinition,
} from "../config/module-registry.js";
import type {
  AnyBusinessCardTemplateDefinition,
  BusinessCardBlock,
  BusinessCardSpec,
  BusinessCardTemplateDefinition,
} from "../feishu/templates/definition.js";
import type {
  KnowledgeBasePort,
  KnowledgeDocumentDetail,
  KnowledgeDocumentSummary,
  KnowledgeExtractPreviewResult,
  KnowledgeFileRef,
  KnowledgeIngestOptions,
  KnowledgeIngestResult,
  KnowledgeParsedFileResult,
  KnowledgeQueryResult,
  KnowledgeStatsResult,
  KnowledgeWebPageIngestRequest,
} from "../knowledge/index.js";
import type { BridgeEventName, LogLevel } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeMessage, OpenCodePromptRequest, OpenCodeSession } from "../opencode/client.js";

export type {
  AnyBusinessCardTemplateDefinition,
  BusinessCardBlock,
  BusinessCardSpec,
  BusinessCardTemplateDefinition,
};

/** 扩展配置 normalize 上下文；字段集自 Phase 2 起冻结。 */
export type ConfigLoadContext = InternalConfigLoadContext;

/** 扩展配置定义契约；供外部扩展通过 meta 声明自己的配置块。 */
export type ModuleConfigDefinition<Parsed, Normalized> = InternalModuleConfigDefinition<Parsed, Normalized>;

export type ExtensionCommandDefinition = {
  name: string;
  aliases?: readonly string[];
  owner: "framework" | "business";
  description: string;
};

export type ExtensionConfigMap = Readonly<Record<string, unknown>>;

export type ExtensionOutboundPayload = {
  msg_type: "post" | "interactive";
  content: string;
};

export type ExtensionOutboundPort = {
  sendMessage(chatId: string, payload: ExtensionOutboundPayload): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: ExtensionOutboundPayload, options?: { replyInThread?: boolean }): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: ExtensionOutboundPayload): Promise<{ messageId: string }>;
  downloadMessageResource(messageId: string, fileKey: string, type: "file" | "image" | "folder"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
  listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
  updateBitableRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
};

export type ExtensionOpenCodePort = Pick<OpenCodeClient,
  | "createSession"
  | "getSessionMessages"
  | "listSessions"
  | "postMessageSync"
  | "promptAsync"
  | "replyPermission"
  | "replyQuestion"
  | "runCommand"
>;

export type ExtensionKnowledgePort = Pick<KnowledgeBasePort,
  | "query"
  | "ingestFile"
  | "ingestLocalFile"
  | "ingestWebPage"
  | "parseLocalFile"
  | "previewLocalFileExtraction"
  | "listDocuments"
  | "getDocument"
  | "getStats"
  | "syncMirror"
  | "close"
>;

export type {
  KnowledgeDocumentDetail,
  KnowledgeDocumentSummary,
  KnowledgeExtractPreviewResult,
  KnowledgeFileRef,
  KnowledgeIngestOptions,
  KnowledgeIngestResult,
  KnowledgeParsedFileResult,
  KnowledgeQueryResult,
  KnowledgeStatsResult,
  KnowledgeWebPageIngestRequest,
  OpenCodeMessage,
  OpenCodePromptRequest,
  OpenCodeSession,
};

export type ExtensionLogger = {
  log(scope: string, message: string, fields?: Record<string, unknown>, level?: LogLevel): void;
  event?(scope: string, event: BridgeEventName, fields?: Record<string, unknown>, level?: LogLevel): void;
};

export type ExtensionIncomingMessage = {
  messageId: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  text: string;
  parentId?: string | undefined;
  threadKey: string;
  conversationKey: string;
  messageType: "text" | "post" | "file" | "image";
  file?: {
    fileKey: string;
    fileName: string;
    size?: number | undefined;
  } | undefined;
  /** 区分普通文件、图片与文件夹资源，缺失时默认 "file"。 */
  resourceType?: "file" | "image" | "folder" | undefined;
};

export type ExtensionRoutedText =
  | { kind: "command"; command: { kind: string; [key: string]: unknown } }
  | { kind: "message"; text: string };

export type ExtensionPendingInteractionView =
  | { kind: string }
  | {
    kind: "file-await-instruction";
    file: {
      fileKey: string;
      fileName: string;
      size?: number | undefined;
    };
  };

export type ExtensionRuntimeModuleHandleResult =
  | { claimed: true }
  | { claimed: false };

export type ExtensionSessionBindingView = {
  sessionId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
};

export type ExtensionSessionWindowView = {
  mode: "single" | "multi";
  interactionMode?: "default" | "knowledge" | undefined;
  modelOverride?: {
    providerID: string;
    modelID: string;
  } | undefined;
  activeSessionId: string | null;
  sessions: readonly ExtensionSessionBindingView[];
};

export type ExtensionTurnView = {
  turnId: string;
  chatId: string;
  conversationKey: string;
  threadKey: string;
  chatType?: string | undefined;
  senderOpenId: string;
  inboundMessageId: string;
  plainText: string;
  text: string;
  sessionId: string;
};

export type ExtensionRuntimeModuleMessageContext = {
  message: ExtensionIncomingMessage;
  routed: ExtensionRoutedText | null;
  window: ExtensionSessionWindowView;
  pendingInteraction?: ExtensionPendingInteractionView | null;
};

export type ExtensionRuntimeModuleBeforeTurnContext = {
  turn: ExtensionTurnView;
  window: ExtensionSessionWindowView;
};

export type ExtensionRuntimeModuleAfterTurnContext = ExtensionRuntimeModuleBeforeTurnContext & {
  reply: string;
};

export interface ExtensionRuntimeModule {
  readonly name: string;
  readonly priority: number;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  handleMessage?(context: ExtensionRuntimeModuleMessageContext): Promise<ExtensionRuntimeModuleHandleResult>;
  claimFileInstruction?(
    pending: ExtensionPendingInteractionView,
    message: ExtensionIncomingMessage,
  ): Promise<boolean>;
  beforeTurn?(context: ExtensionRuntimeModuleBeforeTurnContext): Promise<{ systemBlocks?: string[] } | void>;
  afterTurn?(context: ExtensionRuntimeModuleAfterTurnContext): Promise<void>;
}

export type ExtensionRuntimeContext = {
  config: ExtensionConfigMap;
  outbound: ExtensionOutboundPort;
  logger: ExtensionLogger;
  opencode: ExtensionOpenCodePort;
  knowledge: ExtensionKnowledgePort | null;
  window: ExtensionSessionWindowView;
};

export type ExtensionMetaDefinition<TConfigKey extends string = string> = {
  id: string;
  configKey?: TConfigKey;
  commands?: readonly ExtensionCommandDefinition[];
  configDefinition?: ModuleConfigDefinition<unknown, unknown>;
  cardTemplates?: readonly AnyBusinessCardTemplateDefinition[];
  workflows?: readonly string[];
  dependencies?: readonly string[];
};

export type ExtensionDefinition<
  TConfigKey extends string = string,
  TContext = ExtensionRuntimeContext,
  TModule = ExtensionRuntimeModule,
> = {
  id: string;
  configKey?: TConfigKey;
  commands?: readonly ExtensionCommandDefinition[];
  dependencies?: readonly string[];
  /**
   * Phase 2 只支持同步创建模块。
   * 数据库连接、远端握手等异步初始化应放在 module.start()。
   */
  createModule(context: TContext): TModule | null | Promise<TModule | null>;
};

/**
 * 声明一个无运行时副作用的扩展。
 *
 * Phase 2 要求 createModule() 同步返回；异步初始化应放入 module.start()。
 */
export function defineExtension<const TDefinition extends ExtensionDefinition>(
  definition: TDefinition,
): TDefinition {
  return definition;
}

export function defineCardTemplate<const TSchema extends z.ZodTypeAny>(
  template: BusinessCardTemplateDefinition<TSchema>,
): BusinessCardTemplateDefinition<TSchema> {
  return template;
}
