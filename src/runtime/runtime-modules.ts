import type { ModuleManager } from "../bridge/module.js";
import { ModuleManager as RuntimeModuleManager } from "../bridge/module.js";
import { DEFAULT_CONTRACT_ASSISTANT_CONFIG, DEFAULT_LABOR_SKILL_CONFIG, type AppConfig } from "../config/schema.js";
import { ContractAssistantService } from "../contract-assistant/index.js";
import { ContractAssistantRuntimeModule } from "../contract-assistant/runtime-module.js";
import { KnowledgeBaseService, type KnowledgeBasePort } from "../knowledge/index.js";
import { KnowledgeRuntimeModule } from "../knowledge/runtime-module.js";
import { LaborSkillService } from "../labor/index.js";
import { LaborRuntimeModule } from "../labor/runtime-module.js";
import type { Logger } from "../logging/logger.js";
import { MemoryService } from "../memory/index.js";
import { MemoryRuntimeModule } from "../memory/runtime-module.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import type { WhitelistStore } from "../store/whitelist.js";
import type { IncomingChatMessage } from "./app.js";
import type { FeishuTransport } from "./feishu-transport.js";

type OutboundPort = {
  sendMessage(chatId: string, payload: { msg_type: "post" | "interactive"; content: string }): Promise<{ messageId: string }>;
  replyMessage(messageId: string, payload: { msg_type: "post" | "interactive"; content: string }, options?: { replyInThread?: boolean }): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: { msg_type: "post" | "interactive"; content: string }): Promise<{ messageId: string }>;
};

type KnowledgeResourcePort = {
  downloadMessageResource(messageId: string, fileKey: string, type: "file"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
  listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
  updateBitableRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
};

export type RuntimeModuleAssemblyResult = {
  moduleManager: ModuleManager;
  knowledgeModule: KnowledgeRuntimeModule;
};

export function createRuntimeModules(options: {
  config: AppConfig;
  outbound: OutboundPort & Partial<KnowledgeResourcePort>;
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
  whitelist: Pick<WhitelistStore, "bind">;
  getSessionWindow(conversationKey: string, chatType?: string): SessionWindowRecord;
  saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void>;
  createAndBindSession(source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<SessionBindingRecord>;
}): RuntimeModuleAssemblyResult {
  const memory = options.memory ?? createMemoryService(options.config, options.logger, options.opencode as OpenCodeClient);
  const knowledge = options.knowledge ?? createKnowledgeService(options.config, options.outbound, options.opencode as OpenCodeClient, options.logger);
  const contractAssistant = createContractAssistantService(options.config, options.outbound, options.opencode as OpenCodeClient, options.logger);
  const laborSkill = createLaborSkillService(options.config, options.outbound, options.opencode as OpenCodeClient, options.logger, knowledge);

  const moduleManager = new RuntimeModuleManager();
  const knowledgeModule = new KnowledgeRuntimeModule({
    config: options.config,
    logger: options.logger,
    knowledge,
    transport: options.transport,
    getSessionWindow: options.getSessionWindow,
    saveSessionWindow: options.saveSessionWindow,
    createAndBindSession: options.createAndBindSession,
    whitelistBind: async (chatId, openId) => await options.whitelist.bind(chatId, openId),
  });

  moduleManager.register(knowledgeModule);
  moduleManager.register(new ContractAssistantRuntimeModule({
    config: options.config,
    logger: options.logger,
    service: contractAssistant,
    transport: options.transport,
  }));
  moduleManager.register(new LaborRuntimeModule({
    config: options.config,
    logger: options.logger,
    knowledge,
    service: laborSkill,
    transport: options.transport,
  }));
  if (memory) {
    moduleManager.register(new MemoryRuntimeModule(memory));
  }

  return {
    moduleManager,
    knowledgeModule,
  };
}

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

function createKnowledgeService(
  config: AppConfig,
  outbound: OutboundPort & Partial<KnowledgeResourcePort>,
  opencode: OpenCodeClient,
  logger: Logger,
): KnowledgeBasePort | null {
  if (!config.knowledgeBase.enabled) {
    return null;
  }
  assertKnowledgeResourcePort(outbound, "knowledge base");
  return new KnowledgeBaseService(
    config.knowledgeBase,
    outbound,
    opencode,
    logger,
  );
}

function createContractAssistantService(
  config: AppConfig,
  outbound: OutboundPort & Partial<KnowledgeResourcePort>,
  opencode: OpenCodeClient,
  logger: Logger,
): ContractAssistantService | null {
  const contractAssistantConfig = config.contractAssistant ?? DEFAULT_CONTRACT_ASSISTANT_CONFIG;
  if (!contractAssistantConfig.enabled) {
    return null;
  }
  assertKnowledgeResourcePort(outbound, "contract assistant");
  return new ContractAssistantService(
    contractAssistantConfig,
    config.storage.dataDir,
    outbound,
    opencode,
    logger,
  );
}

function createLaborSkillService(
  config: AppConfig,
  outbound: OutboundPort & Partial<KnowledgeResourcePort>,
  opencode: OpenCodeClient,
  logger: Logger,
  knowledge: KnowledgeBasePort | null,
): LaborSkillService | null {
  const laborSkillConfig = config.laborSkill ?? DEFAULT_LABOR_SKILL_CONFIG;
  if (!laborSkillConfig.enabled) {
    return null;
  }
  assertKnowledgeResourcePort(outbound, "labor skill");
  return new LaborSkillService(
    laborSkillConfig,
    config.storage.dataDir,
    outbound,
    opencode,
    logger,
    knowledge,
  );
}

function assertKnowledgeResourcePort(
  outbound: OutboundPort & Partial<KnowledgeResourcePort>,
  featureName: string,
): asserts outbound is OutboundPort & KnowledgeResourcePort {
  const missing = [
    "downloadMessageResource",
    "createBitableRecord",
    "listBitableRecords",
    "updateBitableRecord",
  ].filter((name) => typeof outbound[name as keyof KnowledgeResourcePort] !== "function");

  if (missing.length === 0) {
    return;
  }

  throw new Error(`${featureName} requires outbound resource methods: ${missing.join(", ")}`);
}
