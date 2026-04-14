import { z } from "zod";

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
const KnowledgeBaseAutoDetectSchema = z.object({
  enabled: z.boolean().default(false),
  minConfidence: z.number().positive().max(1).default(0.75),
}).default({});
const KnowledgeBaseQuerySchema = z.object({
  topK: z.number().int().positive().default(10),
  finalTopN: z.number().int().positive().default(3),
  keywordFallbackLimit: z.number().int().positive().default(10),
}).default({});
const KnowledgeBaseStorageSchema = z.object({
  sqlitePath: z.string().min(1).optional(),
  bitable: z.object({
    appToken: z.string().default(""),
    tableId: z.string().default(""),
    documentTableId: z.string().min(1).optional(),
    sourceFileField: z.object({
      name: z.string().min(1).default("源文件"),
      type: z.enum(["text", "hyperlink"]).default("text"),
      urlTemplate: z.string().min(1).optional(),
      textTemplate: z.string().min(1).default("{{fileName}}"),
    }).optional(),
    statuteField: z.object({
      name: z.string().min(1).default("法条"),
      type: z.enum(["text", "hyperlink"]).default("text"),
      urlTemplate: z.string().min(1).optional(),
      textTemplate: z.string().min(1).default("{{statute}}"),
    }).optional(),
  }).default({}),
}).default({});
const KnowledgeBaseIngestSchema = z.object({
  allowedExtensions: z.array(z.string().min(1)).default([".pdf", ".docx", ".txt"]),
  maxFileSizeMb: z.number().positive().default(20),
  pendingTtlMs: z.number().int().positive().default(600_000),
  sessionIdleMs: z.number().int().positive().default(1_800_000),
  concurrency: z.number().int().positive().max(10).default(3),
  maxExtractChunks: z.number().int().positive().default(30),
  maxExtractQas: z.number().int().positive().default(500),
}).default({});
const KnowledgeBaseModelRefSchema = z.string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s].+$/, "knowledgeBase.models.* 必须使用 <provider>/<model> 格式");
const KnowledgeBaseModelsSchema = z.object({
  default: KnowledgeBaseModelRefSchema.optional(),
  webRead: KnowledgeBaseModelRefSchema.optional(),
  extract: KnowledgeBaseModelRefSchema.optional(),
  rerank: KnowledgeBaseModelRefSchema.optional(),
}).default({});
const ContractAssistantModelRefSchema = z.string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s].+$/, "contractAssistant.models.* 必须使用 <provider>/<model> 格式");
const LaborSkillModelRefSchema = z.string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s].+$/, "laborSkill.models.* 必须使用 <provider>/<model> 格式");
const ContractAssistantConfigSchema = z.object({
  enabled: z.boolean().default(false),
  storage: z.object({
    baseToken: z.string().default(""),
    contractTableId: z.string().default(""),
    invoiceTableId: z.string().default(""),
    caseTableId: z.string().default(""),
  }).default({}),
  models: z.object({
    default: ContractAssistantModelRefSchema.optional(),
    draft: ContractAssistantModelRefSchema.optional(),
    extract: ContractAssistantModelRefSchema.optional(),
    invoice: ContractAssistantModelRefSchema.optional(),
    caseManage: ContractAssistantModelRefSchema.optional(),
  }).default({}),
  ingest: z.object({
    contractAllowedExtensions: z.array(z.string().min(1)).default([".pdf", ".docx", ".txt", ".md"]),
    invoiceAllowedExtensions: z.array(z.string().min(1)).default([".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md"]),
    maxFileSizeMb: z.number().positive().default(20),
    pendingTtlMs: z.number().int().positive().default(600_000),
  }).default({}),
  reminder: z.object({
    enabled: z.boolean().default(false),
    targetChatIds: z.array(z.string().min(1)).default([]),
    hour: z.number().int().min(0).max(23).default(9),
    minute: z.number().int().min(0).max(59).default(0),
    lookaheadDays: z.number().int().positive().default(7),
  }).default({}),
}).default({});
export type ContractAssistantConfig = z.infer<typeof ContractAssistantConfigSchema>;
export const DEFAULT_CONTRACT_ASSISTANT_CONFIG: ContractAssistantConfig = {
  enabled: false,
  storage: {
    baseToken: "",
    contractTableId: "",
    invoiceTableId: "",
    caseTableId: "",
  },
  models: {},
  ingest: {
    contractAllowedExtensions: [".pdf", ".docx", ".txt", ".md"],
    invoiceAllowedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md"],
    maxFileSizeMb: 20,
    pendingTtlMs: 600_000,
  },
  reminder: {
    enabled: false,
    targetChatIds: [],
    hour: 9,
    minute: 0,
    lookaheadDays: 7,
  },
};
const LaborSkillConfigSchema = z.object({
  enabled: z.boolean().default(false),
  models: z.object({
    default: LaborSkillModelRefSchema.optional(),
    extract: LaborSkillModelRefSchema.optional(),
    analyze: LaborSkillModelRefSchema.optional(),
  }).default({}),
  ingest: z.object({
    allowedExtensions: z.array(z.string().min(1)).default([".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".xls", ".xlsx", ".csv"]),
    maxFileSizeMb: z.number().positive().default(20),
    pendingTtlMs: z.number().int().positive().default(600_000),
  }).default({}),
}).default({});
export type LaborSkillConfig = z.infer<typeof LaborSkillConfigSchema>;
export const DEFAULT_LABOR_SKILL_CONFIG: LaborSkillConfig = {
  enabled: false,
  models: {},
  ingest: {
    allowedExtensions: [".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".xls", ".xlsx", ".csv"],
    maxFileSizeMb: 20,
    pendingTtlMs: 600_000,
  },
};
const KnowledgeBaseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoDetect: KnowledgeBaseAutoDetectSchema,
  query: KnowledgeBaseQuerySchema,
  storage: KnowledgeBaseStorageSchema,
  embeddingProvider: EmbeddingProviderSchema.optional(),
  models: KnowledgeBaseModelsSchema,
  ingest: KnowledgeBaseIngestSchema,
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

export const ConfigSchema = z.object({
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
  embeddings: EmbeddingsConfigSchema,
  logging: z.object({
    dir: z.string().min(1).default("./logs"),
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    enableTranscript: z.boolean().default(true),
    enableConsole: z.boolean().default(true),
    enableColor: z.boolean().default(true),
    rotateDaily: z.boolean().default(true),
  }).default({}),
  memory: MemoryConfigSchema.default({}),
  knowledgeBase: KnowledgeBaseConfigSchema,
  contractAssistant: ContractAssistantConfigSchema,
  laborSkill: LaborSkillConfigSchema,
}).superRefine((value, context) => {
  if (value.memory.retriever === "embedding" && !value.embeddings.provider && !value.memory.embeddingProvider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["embeddings", "provider"],
      message: "retriever=embedding 时必须提供 embeddings.provider",
    });
  }

  if (!value.knowledgeBase.enabled) {
    // keep validating other feature blocks
  } else {
    if (
      value.knowledgeBase.storage.bitable.sourceFileField?.type === "hyperlink"
      && !value.knowledgeBase.storage.bitable.sourceFileField.urlTemplate
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeBase", "storage", "bitable", "sourceFileField", "urlTemplate"],
        message: "sourceFileField.type=hyperlink 时必须提供 urlTemplate",
      });
    }

    if (
      value.knowledgeBase.storage.bitable.statuteField?.type === "hyperlink"
      && !value.knowledgeBase.storage.bitable.statuteField.urlTemplate
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeBase", "storage", "bitable", "statuteField", "urlTemplate"],
        message: "statuteField.type=hyperlink 时必须提供 urlTemplate",
      });
    }

    if (!value.knowledgeBase.storage.bitable.appToken) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeBase", "storage", "bitable", "appToken"],
        message: "knowledgeBase.enabled=true 时必须提供 knowledgeBase.storage.bitable.appToken",
      });
    }

    if (!value.knowledgeBase.storage.bitable.tableId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeBase", "storage", "bitable", "tableId"],
        message: "knowledgeBase.enabled=true 时必须提供 knowledgeBase.storage.bitable.tableId",
      });
    }

    if (!value.knowledgeBase.embeddingProvider && !value.embeddings.provider && !value.memory.embeddingProvider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeBase", "embeddingProvider"],
        message: "knowledgeBase.enabled=true 时必须提供 knowledgeBase.embeddingProvider，或复用 embeddings.provider / memory.embeddingProvider",
      });
    }
  }

  if (value.contractAssistant.enabled && !value.contractAssistant.storage.baseToken) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contractAssistant", "storage", "baseToken"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.baseToken",
    });
  }
  if (value.contractAssistant.enabled && !value.contractAssistant.storage.contractTableId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contractAssistant", "storage", "contractTableId"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.contractTableId",
    });
  }
  if (value.contractAssistant.enabled && !value.contractAssistant.storage.invoiceTableId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contractAssistant", "storage", "invoiceTableId"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.invoiceTableId",
    });
  }
  if (value.contractAssistant.enabled && !value.contractAssistant.storage.caseTableId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contractAssistant", "storage", "caseTableId"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.caseTableId",
    });
  }
});

export type AppConfig = {
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
  };
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
  knowledgeBase: {
    enabled: boolean;
    autoDetect: {
      enabled: boolean;
      minConfidence: number;
    };
    query: {
      topK: number;
      finalTopN: number;
      keywordFallbackLimit: number;
    };
    storage: {
      sqlitePath: string;
      bitable: {
        appToken: string;
        tableId: string;
        documentTableId?: string | undefined;
        sourceFileField?: {
          name: string;
          type: "text" | "hyperlink";
          urlTemplate?: string | undefined;
          textTemplate: string;
        } | undefined;
        statuteField?: {
          name: string;
          type: "text" | "hyperlink";
          urlTemplate?: string | undefined;
          textTemplate: string;
        } | undefined;
      };
    };
    embeddingProvider?: {
      baseUrl: URL;
      apiKey: string;
      model: string;
    } | undefined;
    models: {
      default?: string | undefined;
      webRead?: string | undefined;
      extract?: string | undefined;
      rerank?: string | undefined;
    };
    ingest: {
      allowedExtensions: string[];
      maxFileSizeMb: number;
      pendingTtlMs: number;
      sessionIdleMs: number;
      concurrency: number;
      maxExtractChunks: number;
      maxExtractQas: number;
    };
  };
  contractAssistant?: {
    enabled: boolean;
    storage: {
      baseToken: string;
      contractTableId: string;
      invoiceTableId: string;
      caseTableId: string;
    };
    models: {
      default?: string | undefined;
      draft?: string | undefined;
      extract?: string | undefined;
      invoice?: string | undefined;
      caseManage?: string | undefined;
    };
    ingest: {
      contractAllowedExtensions: string[];
      invoiceAllowedExtensions: string[];
      maxFileSizeMb: number;
      pendingTtlMs: number;
    };
    reminder: {
      enabled: boolean;
      targetChatIds: string[];
      hour: number;
      minute: number;
      lookaheadDays: number;
    };
  };
  laborSkill?: {
    enabled: boolean;
    models: {
      default?: string | undefined;
      extract?: string | undefined;
      analyze?: string | undefined;
    };
    ingest: {
      allowedExtensions: string[];
      maxFileSizeMb: number;
      pendingTtlMs: number;
    };
  };
};
