/**
 * 职责: 定义应用配置的结构、默认值和校验规则。
 * 关注点:
 * - 为各子模块提供统一的 Zod schema。
 * - 在启动阶段尽早发现缺失或非法配置。
 */
import { z } from "zod";

import { moduleConfigSchemas } from "./modules.js";
import { DEFAULT_PROFILE, type BridgeProfile } from "./profiles.js";
import type { KnowledgeBaseConfig } from "../knowledge/config.js";
import type { ContractAssistantConfig } from "../contract-assistant/config.js";
import type { LaborSkillConfig } from "../labor/config.js";
export { DEFAULT_CONTRACT_ASSISTANT_CONFIG, type ContractAssistantConfig } from "../contract-assistant/config.js";
export { DEFAULT_LABOR_SKILL_CONFIG, type LaborSkillConfig } from "../labor/config.js";

const SessionModeSchema = z.enum(["single", "multi"]);
const MemoryRetrieverSchema = z.enum(["recent", "embedding"]);
const EmbeddingProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
});
const EmbeddingsConfigSchema = z.object({
  provider: EmbeddingProviderSchema.optional(),
  similarityThreshold: z.number().positive().max(1).optional(),
}).default({});
const ObsidianConfigSchema = z.object({
  enabled: z.boolean().default(false),
  vaultPath: z.string().min(1).optional(),
  syncCron: z.string().min(1).default("0 2 * * *"),
  enableWikiLinks: z.boolean().default(false),
}).default({});
const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  dbPath: z.string().min(1).optional(),
  maxMemoriesPerUser: z.number().int().positive().default(500),
  searchLimit: z.number().int().positive().default(5),
  extractQueueLimit: z.number().int().positive().default(100),
  sourcePreviewLength: z.number().int().positive().default(50),
  shutdownDrainTimeoutMs: z.number().int().positive().default(5_000),
  retriever: MemoryRetrieverSchema.default("recent"),
  embeddingProvider: EmbeddingProviderSchema.optional(),
  embeddingSimilarityThreshold: z.number().positive().max(1).optional(),
  obsidian: ObsidianConfigSchema,
}).superRefine((value, context) => {
  if (value.obsidian.enabled && !value.obsidian.vaultPath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["obsidian", "vaultPath"],
      message: "obsidian.enabled=true 时必须提供 vaultPath",
    });
  }
});
const ModelPriceSchema = z.object({
  inputPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
  cachedInputPer1M: z.number().nonnegative().optional(),
});
const CostsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  currency: z.literal("CNY").default("CNY"),
  dailyLimitCny: z.number().positive().optional(),
  modelPrices: z.record(ModelPriceSchema).default({}),
}).default({});
const UpdatesConfigSchema = z.object({
  checkOnStart: z.boolean().default(true),
  githubRepo: z.string().min(1).default("clukay/feishu-opencode-bridge"),
  channel: z.literal("stable").default("stable"),
}).default({});
const PersonaConfigSchema = z.object({
  enabled: z.boolean().default(true),
  profile: z.literal("xiaojing").default("xiaojing"),
  scope: z.enum(["legal", "global"]).default("legal"),
}).default({});
// 案件工作台目前只需要一个 enabled 开关，比照 memory 暂留中央 schema。
// 真实启用值由 loader 的 profile 解析覆盖；schema 默认值仅作为最终兜底。
const CaseWorkbenchConfigSchema = z.object({
  enabled: z.boolean().default(false),
}).default({});

export const ConfigSchema = z.object({
  // 发行形态 profile：为内置扩展提供默认启用值，用户显式 enabled 始终优先。
  profile: z.enum(["general", "legal"]).default(DEFAULT_PROFILE),
  feishu: z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    botOpenId: z.string().min(1).optional(),
    botOpenIds: z.array(z.string().min(1)).default([]),
    botMentionNames: z.array(z.string().min(1)).default([]),
    selfBotOpenId: z.string().min(1).optional(),
    selfBotOpenIds: z.array(z.string().min(1)).default([]),
    wsUrl: z.string().url().default("wss://open.feishu.cn/open-apis/ws/v2"),
    allowedOpenIds: z.array(z.string()).default([]),
    behavior: z.object({
      enableP2p: z.boolean().default(true),
      enableGroup: z.boolean().default(true),
      requireBotMentionInGroup: z.boolean().default(true),
      strictBotMention: z.boolean().default(true),
      ignoreNonUserSenders: z.boolean().default(true),
      replyInThread: z.boolean().default(true),
    }).default({}),
    cardActions: z.object({
      enabled: z.boolean().default(false),
      path: z.string().min(1).default("/webhook/card"),
      verificationToken: z.string().default(""),
      encryptKey: z.string().default(""),
    }).default({}),
  }),
  opencode: z.object({
    baseUrl: z.string().url(),
    directory: z.string().min(1),
  }),
  storage: z.object({
    dataDir: z.string().min(1).default("./data"),
    mappingsFile: z.string().min(1).default("mappings.json"),
  }),
  server: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().positive().default(3000),
    publicBaseUrl: z.string().url().default("http://127.0.0.1:3000/"),
  }).default({}),
  whitelist: z.object({
    storePath: z.string().min(1).default("whitelist.json"),
  }).default({}),
  bridge: z.object({
    queueLimit: z.number().int().positive().default(3),
    sessions: z.object({
      p2pMode: SessionModeSchema.default("multi"),
      groupMode: SessionModeSchema.default("single"),
      topicGroupMode: SessionModeSchema.default("single"),
      maxSessionsPerWindow: z.number().int().positive().default(20),
      listLimit: z.number().int().positive().default(10),
      injectSystemState: z.boolean().default(true),
    }).default({}),
    timeouts: z.object({
      firstEvent: z.number().int().positive().default(30_000),
      eventInterval: z.number().int().positive().default(120_000),
      totalTurn: z.number().int().positive().default(300_000),
    }).default({}),
  }),
  permissions: z.object({
    /** ask: 每次都询问; allow: 只读权限自动放行; deny: 只读权限自动拒绝 */
    defaultPolicy: z.enum(["ask", "allow", "deny"]).default("ask"),
  }).default({}),
  embeddings: EmbeddingsConfigSchema,
  logging: z.object({
    dir: z.string().min(1).default("./logs"),
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    enableTranscript: z.boolean().default(true),
    enableConsole: z.boolean().default(true),
    enableColor: z.boolean().default(true),
    rotateDaily: z.boolean().default(true),
    format: z.enum(["pretty", "json"]).default("pretty"),
    messagePolicy: z.enum(["full", "preview", "hash", "none"]).default("preview"),
    redactFields: z.array(z.string().min(1)).default([
      "feishu.appSecret",
      "opencode.apiKey",
      "appSecret",
      "apiKey",
      "plainText",
      "content",
    ]),
  }).default({}),
  costs: CostsConfigSchema,
  updates: UpdatesConfigSchema,
  persona: PersonaConfigSchema,
  memory: MemoryConfigSchema.default({}),
  caseWorkbench: CaseWorkbenchConfigSchema,
  extensions: z.record(z.unknown()).default({}),
  knowledgeBase: moduleConfigSchemas.knowledgeBase,
  contractAssistant: moduleConfigSchemas.contractAssistant,
  laborSkill: moduleConfigSchemas.laborSkill,
}).superRefine((value, context) => {
  if (value.memory.retriever === "embedding" && !value.embeddings.provider && !value.memory.embeddingProvider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["embeddings", "provider"],
      message: "retriever=embedding 时必须提供 embeddings.provider",
    });
  }

  if (value.knowledgeBase.enabled && !value.knowledgeBase.embeddingProvider && !value.embeddings.provider && !value.memory.embeddingProvider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["knowledgeBase", "embeddingProvider"],
      message: "knowledgeBase.enabled=true 时必须提供 knowledgeBase.embeddingProvider，或复用 embeddings.provider / memory.embeddingProvider",
    });
  }

});

export type AppConfig = {
  profile: BridgeProfile;
  feishu: {
    appId: string;
    appSecret: string;
    botOpenId?: string | undefined;
    botOpenIds: Set<string>;
    botMentionNames: Set<string>;
    selfBotOpenId?: string | undefined;
    selfBotOpenIds: Set<string>;
    wsUrl: URL;
    allowedOpenIds: Set<string>;
    behavior: {
      enableP2p: boolean;
      enableGroup: boolean;
      requireBotMentionInGroup: boolean;
      strictBotMention: boolean;
      ignoreNonUserSenders: boolean;
      replyInThread: boolean;
    };
    cardActions: {
      enabled: boolean;
      path: string;
      verificationToken: string;
      encryptKey: string;
    };
  };
  opencode: {
    baseUrl: URL;
    directory: string;
  };
  storage: {
    dataDir: string;
    mappingsFile: string;
  };
  server: {
    host: string;
    port: number;
    publicBaseUrl: URL;
  };
  whitelist: {
    storePath: string;
  };
  bridge: {
    queueLimit: number;
    sessionModes: {
      p2p: "single" | "multi";
      group: "single" | "multi";
      topicGroup: "single" | "multi";
    };
    maxSessionsPerWindow: number;
    sessionListLimit: number;
    injectSystemState: boolean;
    firstEventTimeoutMs: number;
    eventGapTimeoutMs: number;
    totalTimeoutMs: number;
  };
  permissions?: {
    defaultPolicy: "ask" | "allow" | "deny";
  } | undefined;
  embeddings?: {
    provider?: {
      baseUrl: URL;
      apiKey: string;
      model: string;
    } | undefined;
    similarityThreshold: number;
  };
  logging: {
    dir: string;
    level: "debug" | "info" | "warn" | "error";
    enableTranscript: boolean;
    enableConsole: boolean;
    enableColor: boolean;
    rotateDaily: boolean;
    format?: "pretty" | "json" | undefined;
    messagePolicy?: "full" | "preview" | "hash" | "none" | undefined;
    redactFields?: string[] | undefined;
  };
  costs?: {
    enabled: boolean;
    currency: "CNY";
    dailyLimitCny?: number | undefined;
    modelPrices: Record<string, {
      inputPer1M?: number | undefined;
      outputPer1M?: number | undefined;
      cachedInputPer1M?: number | undefined;
    }>;
  };
  updates?: {
    checkOnStart: boolean;
    githubRepo: string;
    channel: "stable";
  };
  persona?: {
    enabled: boolean;
    profile: "xiaojing";
    scope: "legal" | "global";
  } | undefined;
  memory: {
    enabled: boolean;
    dbPath: string;
    maxMemoriesPerUser: number;
    searchLimit: number;
    extractQueueLimit: number;
    sourcePreviewLength: number;
    shutdownDrainTimeoutMs: number;
    retriever: "recent" | "embedding";
    embeddingProvider?: {
      baseUrl: URL;
      apiKey: string;
      model: string;
    } | undefined;
    obsidian: {
      enabled: boolean;
      vaultPath?: string | undefined;
      syncCron: string;
      enableWikiLinks: boolean;
    };
  };
  caseWorkbench: {
    enabled: boolean;
  };
  extensions?: Record<string, unknown> | undefined;
  knowledgeBase: KnowledgeBaseConfig;
  contractAssistant?: ContractAssistantConfig;
  laborSkill?: LaborSkillConfig;
};
