/**
 * 职责: 装配所有运行时模块及其依赖。
 * 关注点:
 * - 实例化各业务模块并注入所需服务。
 * - 产出可供 BridgeApp 使用的 ModuleManager 和相关运行时资源。
 */
import type { ModuleManager } from "../bridge/module.js";
import { ModuleManager as RuntimeModuleManager } from "../bridge/module.js";
import { CaseWorkbenchContextStore } from "../case-workbench/context-store.js";
import { CaseWorkbenchRuntimeModule, type CaseWorkbenchLaborPort } from "../case-workbench/runtime-module.js";
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
import { DEFAULT_PERSONA_CONFIG, PersonaRuntimeModule } from "../persona/runtime-module.js";
import type { CostTracker } from "./cost-tracker.js";
import type { BridgeWindowRecord, SessionBindingRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import type { IncomingChatMessage } from "./app.js";
import { createExternalRuntimeModule } from "./external-extension-adapter.js";
import type { FeishuTransport } from "./feishu-transport.js";

export type RuntimeModuleAssemblyResult = {
  moduleManager: ModuleManager;
  knowledgeModule: KnowledgeRuntimeModule;
};

/**
 * 读取某内置扩展（按 configKey）在当前配置下的最终启用状态。
 * enabled 已由 config loader 结合 profile 与显式开关解析完成，这里只做查表。
 */
function isBuiltinExtensionEnabled(config: AppConfig, configKey: keyof AppConfig | undefined): boolean {
  switch (configKey) {
    case "knowledgeBase":
      return config.knowledgeBase.enabled;
    case "contractAssistant":
      return config.contractAssistant?.enabled ?? false;
    case "laborSkill":
      return config.laborSkill?.enabled ?? false;
    case "memory":
      return config.memory.enabled;
    default:
      return true;
  }
}

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
  costTracker?: Pick<CostTracker, "recordExternalCall"> | undefined;
  externalExtensions?: readonly ExtensionDefinition[] | undefined;
  whitelist: Pick<WhitelistStore, "bind">;
  getSessionWindow(conversationKey: string, chatType?: string): BridgeWindowRecord;
  saveSessionWindow(conversationKey: string, chatType: string | undefined, window: BridgeWindowRecord): Promise<void>;
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
  const caseContextStore = new CaseWorkbenchContextStore(options.config.storage.dataDir, options.logger);
  let knowledgeModule: KnowledgeRuntimeModule | null = null;
  let laborPort: CaseWorkbenchLaborPort | null = null;

  moduleManager.register(new PersonaRuntimeModule(options.config.persona ?? DEFAULT_PERSONA_CONFIG));

  for (const extension of builtinExtensions) {
    const enabled = isBuiltinExtensionEnabled(options.config, extension.configKey);
    const isKnowledge = extension.id === "knowledge-base";
    // disabled 内置扩展不创建 RuntimeModule，因而不认领命令、自然语言 routing 或业务卡片。
    // knowledge 是例外：app.ts 依赖其入库挂起接口，需要始终构造对象，仅在禁用时不注册进模块链。
    if (!enabled && !isKnowledge) {
      continue;
    }
    const module = extension.createModule({
      config: options.config,
      outbound: options.outbound,
      transport: options.transport,
      logger: options.logger,
      opencode: options.opencode,
      memory,
      knowledge,
      costTracker: options.costTracker,
      caseContextStore,
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
    if (isKnowledge) {
      knowledgeModule = resolvedModule as KnowledgeRuntimeModule;
      if (!enabled) {
        // 禁用时仅保留对象供 app.ts 接线，不注册进模块链，确保不认领命令或 routing。
        continue;
      }
    }
    moduleManager.register(resolvedModule);
    if (resolvedModule.name === "labor" && "startCaseWorkbenchCollection" in resolvedModule) {
      laborPort = resolvedModule as unknown as CaseWorkbenchLaborPort;
    }
  }

  if (options.config.caseWorkbench.enabled) {
    if (laborPort) {
      moduleManager.register(new CaseWorkbenchRuntimeModule({
        logger: options.logger,
        transport: options.transport,
        labor: laborPort,
        contextStore: caseContextStore,
        opencode: options.opencode,
      }));
    } else {
      // 案件工作台依赖 labor 提供的采集 port；labor 未启用时跳过并告警，而不是静默失效。
      options.logger.log("runtime/modules", "case-workbench skipped: labor extension disabled", {
        caseWorkbenchEnabled: true,
        laborEnabled: isBuiltinExtensionEnabled(options.config, "laborSkill"),
      });
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
