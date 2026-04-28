/**
 * 职责: 装配所有运行时模块及其依赖。
 * 关注点:
 * - 实例化各业务模块并注入所需服务。
 * - 产出可供 BridgeApp 使用的 ModuleManager 和相关运行时资源。
 */
import type { ModuleManager } from "../bridge/module.js";
import { ModuleManager as RuntimeModuleManager } from "../bridge/module.js";
import type { AppConfig } from "../config/schema.js";
import type { ExtensionDefinition } from "../extension-api/index.js";
import { builtinExtensions } from "../extensions/builtin.js";
import type { RuntimeModuleOutboundPort } from "../extensions/definition.js";
import { createKnowledgeService } from "../knowledge/factory.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { KnowledgeRuntimeModule } from "../knowledge/runtime-module.js";
import type { Logger } from "../logging/logger.js";
import { MemoryService } from "../memory/index.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import type { IncomingChatMessage } from "./app.js";
import { createExternalRuntimeModule } from "./external-extension-adapter.js";
import type { FeishuTransport } from "./feishu-transport.js";

export type RuntimeModuleAssemblyResult = {
  moduleManager: ModuleManager;
  knowledgeModule: KnowledgeRuntimeModule;
};

/** 创建并装配运行时模块树。 */
export function createRuntimeModules(options: {
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
  memory?: MemoryService | null;
  knowledge?: KnowledgeBasePort | null;
  externalExtensions?: readonly ExtensionDefinition[] | undefined;
  whitelist: Pick<WhitelistStore, "bind">;
  getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord;
  saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void>;
  createAndBindSession(source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<SessionBindingRecord>;
}): RuntimeModuleAssemblyResult {
  const memory = options.memory ?? createMemoryService(options.config, options.logger, options.opencode as OpenCodeClient);
  const knowledge = options.knowledge ?? createKnowledgeService({
    config: options.config,
    resources: options.outbound,
    opencode: options.opencode as OpenCodeClient,
    logger: options.logger,
  });

  const moduleManager = new RuntimeModuleManager(options.logger);
  let knowledgeModule: KnowledgeRuntimeModule | null = null;

  for (const extension of builtinExtensions) {
    const module = extension.createModule({
      config: options.config,
      outbound: options.outbound,
      transport: options.transport,
      logger: options.logger,
      opencode: options.opencode,
      memory,
      knowledge,
      whitelist: options.whitelist,
      getSessionWindow: options.getSessionWindow,
      saveSessionWindow: options.saveSessionWindow,
      createAndBindSession: options.createAndBindSession,
    });
    if (!module) {
      continue;
    }
    const resolvedModule = module instanceof Promise ? null : module;
    if (!resolvedModule) {
      throw new Error(`Runtime extension ${extension.id} returned an async module; createRuntimeModules only supports sync builtins`);
    }
    moduleManager.register(resolvedModule);
    if (resolvedModule.name === "knowledge") {
      knowledgeModule = resolvedModule as KnowledgeRuntimeModule;
    }
  }

  for (const extension of options.externalExtensions ?? []) {
    let module;
    try {
      module = createExternalRuntimeModule(extension, {
        config: options.config.extensions ?? {},
        outbound: options.outbound,
        logger: options.logger,
        opencode: options.opencode,
        knowledge,
      });
    } catch (error) {
      options.logger.log("runtime/modules", "external extension skipped", {
        extensionId: extension.id,
        errorKind: error instanceof Error ? error.name : "unknown",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (module) {
      moduleManager.register(module);
    }
  }

  if (!knowledgeModule) {
    throw new Error("Knowledge runtime module was not registered");
  }

  return {
    moduleManager,
    knowledgeModule,
  };
}

/** 在启用记忆功能时创建记忆服务。 */
function createMemoryService(
  config: AppConfig,
  logger: Logger,
  opencode: OpenCodeClient,
): MemoryService | null {
  if (!config.memory.enabled) {
    return null;
  }
  return new MemoryService(
    config.memory,
    config.embeddings ?? { provider: undefined, similarityThreshold: 0.75 },
    opencode,
    logger,
  );
}
