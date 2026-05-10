/**
 * 职责: 定义并规范化知识库模块配置。
 * 关注点:
 * - 让 knowledgeBase 子配置靠近 knowledge 模块维护。
 * - 保持 config.json 与 AppConfig["knowledgeBase"] 的兼容形状。
 */
import path from "node:path";

import { z } from "zod";

import type { ConfigLoadContext, ModuleConfigDefinition } from "../config/module-registry.js";
import { SUPPORTED_MATERIAL_EXTENSIONS, normalizeAllowedExtensions } from "../document-pipeline/material-support.js";

const EmbeddingProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
});

const KnowledgeBaseAutoDetectSchema = z.object({
  enabled: z.boolean().default(false),
  minConfidence: z.number().positive().max(1).default(0.75),
}).default({});

const KnowledgeBaseQuerySchema = z.object({
  topK: z.number().int().positive().default(10),
  finalTopN: z.number().int().positive().default(3),
  keywordFallbackLimit: z.number().int().positive().default(10),
}).default({});

const KnowledgeBaseRerankSchema = z.object({
  provider: z.enum(["llm", "jina-compatible"]).default("llm"),
  endpoint: z.string().url().optional(),
  model: z.string().min(1).default("BAAI/bge-reranker-v2-m3"),
  topN: z.number().int().positive().default(3),
  timeoutMs: z.number().int().positive().default(5_000),
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
  allowedExtensions: z.array(z.string().min(1)).default([...SUPPORTED_MATERIAL_EXTENSIONS]),
  maxFileSizeMb: z.number().positive().default(20),
  pendingTtlMs: z.number().int().positive().default(600_000),
  sessionIdleMs: z.number().int().positive().default(1_800_000),
  concurrency: z.number().int().positive().max(10).default(3),
  maxExtractChunks: z.number().int().positive().default(30),
  maxExtractQas: z.number().int().positive().default(500),
}).default({});

const DocumentParserProviderSchema = z.enum(["mineru-agent", "paddleocr-vl", "paddleocr-vl-aistudio", "pymupdf4llm", "docling", "pdf-parse", "tesseract"]);

const KnowledgeBaseParserSchema = z.object({
  externalApiEnabled: z.boolean().default(false),
  pdfProviderOrder: z.array(DocumentParserProviderSchema).default(["pdf-parse", "pymupdf4llm", "docling"]),
  imageProviderOrder: z.array(DocumentParserProviderSchema).default(["tesseract"]),
  ocrLang: z.string().min(1).default("chi_sim+eng"),
  timeoutMs: z.number().int().positive().default(180_000),
  pollIntervalMs: z.number().int().positive().default(5_000),
  maxPollMs: z.number().int().positive().default(180_000),
  mineru: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().default("https://mineru.net/api/v1/agent"),
    apiKey: z.string().default(""),
  }).default({}),
  paddleocr: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().default(""),
    secretKey: z.string().default(""),
  }).default({}),
  paddleocrAiStudio: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().default("https://r630f5rbv7l5a5j7.aistudio-app.com/layout-parsing"),
    token: z.string().default(""),
    useDocOrientationClassify: z.boolean().default(false),
    useDocUnwarping: z.boolean().default(false),
    useChartRecognition: z.boolean().default(false),
  }).default({}),
}).default({});

export const DEFAULT_KNOWLEDGE_BASE_PARSER_CONFIG = {
  externalApiEnabled: false,
  pdfProviderOrder: ["pdf-parse", "pymupdf4llm", "docling"],
  imageProviderOrder: ["tesseract"],
  ocrLang: "chi_sim+eng",
  timeoutMs: 180_000,
  pollIntervalMs: 5_000,
  maxPollMs: 180_000,
  mineru: {
    enabled: false,
    endpoint: "https://mineru.net/api/v1/agent",
    apiKey: "",
  },
  paddleocr: {
    enabled: false,
    apiKey: "",
    secretKey: "",
  },
  paddleocrAiStudio: {
    enabled: false,
    endpoint: "https://r630f5rbv7l5a5j7.aistudio-app.com/layout-parsing",
    token: "",
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: false,
  },
} as const;

const KnowledgeBaseModelRefSchema = z.string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s].+$/, "knowledgeBase.models.* 必须使用 <provider>/<model> 格式");

const KnowledgeBaseModelsSchema = z.object({
  default: KnowledgeBaseModelRefSchema.optional(),
  webRead: KnowledgeBaseModelRefSchema.optional(),
  extract: KnowledgeBaseModelRefSchema.optional(),
  rerank: KnowledgeBaseModelRefSchema.optional(),
}).default({});

const KnowledgeBaseObsidianSchema = z.object({
  enabled: z.boolean().default(false),
  vaultPath: z.string().min(1).optional(),
  baseDir: z.string().min(1).default("Legal Knowledge"),
  enableWikiLinks: z.boolean().default(true),
}).default({});

const PkulawTransportSchema = z.enum(["auto", "stdio", "http"]);

const PkulawSkillBindingSchema = z.object({
  tool: z.string().min(1),
  operation: z.string().min(1),
});

const KnowledgeBaseAuthoritySourcesSchema = z.object({
  pkulaw: z.object({
    enabled: z.boolean().default(false),
    cliCommand: z.string().min(1).default("pkulaw-mcp"),
    transport: PkulawTransportSchema.default("auto"),
    skills: z.object({
      lawSemantic: PkulawSkillBindingSchema.default({ tool: "law-semantic", operation: "search_article" }),
      lawRecognition: PkulawSkillBindingSchema.default({ tool: "law-recognition", operation: "law_recognition" }),
      citationValidator: PkulawSkillBindingSchema.default({ tool: "citation-validator", operation: "adjust_provisions" }),
      caseNumberRecognition: PkulawSkillBindingSchema.default({ tool: "case-number", operation: "anhao_recognition" }),
    }).default({}),
  }).default({}),
}).default({});

const KnowledgeBaseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoDetect: KnowledgeBaseAutoDetectSchema,
  query: KnowledgeBaseQuerySchema,
  rerank: KnowledgeBaseRerankSchema,
  storage: KnowledgeBaseStorageSchema,
  embeddingProvider: EmbeddingProviderSchema.optional(),
  models: KnowledgeBaseModelsSchema,
  ingest: KnowledgeBaseIngestSchema,
  parser: KnowledgeBaseParserSchema,
  obsidian: KnowledgeBaseObsidianSchema,
  authoritySources: KnowledgeBaseAuthoritySourcesSchema,
}).default({});

type KnowledgeBaseParsedConfig = z.infer<typeof KnowledgeBaseConfigSchema>;

export type KnowledgeBaseConfig = {
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
  rerank?: {
    provider: "llm" | "jina-compatible";
    endpoint?: string | undefined;
    model: string;
    topN: number;
    timeoutMs: number;
  } | undefined;
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
  parser?: {
    externalApiEnabled: boolean;
    pdfProviderOrder: Array<"mineru-agent" | "paddleocr-vl" | "paddleocr-vl-aistudio" | "pymupdf4llm" | "docling" | "pdf-parse" | "tesseract">;
    imageProviderOrder: Array<"mineru-agent" | "paddleocr-vl" | "paddleocr-vl-aistudio" | "pymupdf4llm" | "docling" | "pdf-parse" | "tesseract">;
    ocrLang: string;
    timeoutMs: number;
    pollIntervalMs: number;
    maxPollMs: number;
    mineru: {
      enabled: boolean;
      endpoint: string;
      apiKey: string;
    };
    paddleocr: {
      enabled: boolean;
      apiKey: string;
      secretKey: string;
    };
    paddleocrAiStudio: {
      enabled: boolean;
      endpoint: string;
      token: string;
      useDocOrientationClassify: boolean;
      useDocUnwarping: boolean;
      useChartRecognition: boolean;
    };
  } | undefined;
  obsidian?: {
    enabled: boolean;
    vaultPath?: string | undefined;
    baseDir: string;
    enableWikiLinks: boolean;
  } | undefined;
  authoritySources?: {
    pkulaw: {
      enabled: boolean;
      cliCommand: string;
      transport: "auto" | "stdio" | "http";
      skills: {
        lawSemantic: { tool: string; operation: string };
        lawRecognition: { tool: string; operation: string };
        citationValidator: { tool: string; operation: string };
        caseNumberRecognition: { tool: string; operation: string };
      };
    };
  } | undefined;
};

export const knowledgeBaseConfigDefinition: ModuleConfigDefinition<KnowledgeBaseParsedConfig, KnowledgeBaseConfig> = {
  key: "knowledgeBase",
  schema: KnowledgeBaseConfigSchema.superRefine(validateKnowledgeBaseConfig),
  validate: validateKnowledgeBaseConfig,
  normalize: normalizeKnowledgeBaseConfig,
};

function validateKnowledgeBaseConfig(value: KnowledgeBaseParsedConfig, context: z.RefinementCtx): void {
  if (!value.enabled) {
    return;
  }

  if (
    value.storage.bitable.sourceFileField?.type === "hyperlink"
    && !value.storage.bitable.sourceFileField.urlTemplate
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "bitable", "sourceFileField", "urlTemplate"],
      message: "sourceFileField.type=hyperlink 时必须提供 urlTemplate",
    });
  }

  if (
    value.storage.bitable.statuteField?.type === "hyperlink"
    && !value.storage.bitable.statuteField.urlTemplate
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "bitable", "statuteField", "urlTemplate"],
      message: "statuteField.type=hyperlink 时必须提供 urlTemplate",
    });
  }

  if (!value.storage.bitable.appToken) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "bitable", "appToken"],
      message: "knowledgeBase.enabled=true 时必须提供 knowledgeBase.storage.bitable.appToken",
    });
  }

  if (!value.storage.bitable.tableId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "bitable", "tableId"],
      message: "knowledgeBase.enabled=true 时必须提供 knowledgeBase.storage.bitable.tableId",
    });
  }

  if (value.obsidian.enabled && !value.obsidian.vaultPath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["obsidian", "vaultPath"],
      message: "knowledgeBase.obsidian.enabled=true 时必须提供 vaultPath",
    });
  }
}

function normalizeKnowledgeBaseConfig(
  parsed: KnowledgeBaseParsedConfig,
  context: ConfigLoadContext,
): KnowledgeBaseConfig {
  const resolvedEmbeddingProvider = parsed.embeddingProvider ?? context.resolvedEmbeddingProvider;
  return {
    enabled: parsed.enabled,
    autoDetect: {
      enabled: parsed.autoDetect.enabled,
      minConfidence: parsed.autoDetect.minConfidence,
    },
    query: {
      topK: parsed.query.topK,
      finalTopN: parsed.query.finalTopN,
      keywordFallbackLimit: parsed.query.keywordFallbackLimit,
    },
    rerank: {
      provider: parsed.rerank.provider,
      endpoint: parsed.rerank.endpoint,
      model: parsed.rerank.model,
      topN: parsed.rerank.topN,
      timeoutMs: parsed.rerank.timeoutMs,
    },
    storage: {
      sqlitePath: context.resolveRelative(
        context.baseDir,
        parsed.storage.sqlitePath ?? path.join(context.dataDir, "knowledge-base.db"),
      ),
      bitable: {
        appToken: parsed.storage.bitable.appToken,
        tableId: parsed.storage.bitable.tableId,
        documentTableId: parsed.storage.bitable.documentTableId,
        sourceFileField: parsed.storage.bitable.sourceFileField
          ? {
            name: parsed.storage.bitable.sourceFileField.name,
            type: parsed.storage.bitable.sourceFileField.type,
            urlTemplate: parsed.storage.bitable.sourceFileField.urlTemplate,
            textTemplate: parsed.storage.bitable.sourceFileField.textTemplate,
          }
          : undefined,
        statuteField: parsed.storage.bitable.statuteField
          ? {
            name: parsed.storage.bitable.statuteField.name,
            type: parsed.storage.bitable.statuteField.type,
            urlTemplate: parsed.storage.bitable.statuteField.urlTemplate,
            textTemplate: parsed.storage.bitable.statuteField.textTemplate,
          }
          : undefined,
      },
    },
    embeddingProvider: resolvedEmbeddingProvider
      ? {
        baseUrl: new URL(resolvedEmbeddingProvider.baseUrl),
        apiKey: resolvedEmbeddingProvider.apiKey,
        model: resolvedEmbeddingProvider.model,
      }
      : undefined,
    models: {
      default: parsed.models.default,
      webRead: parsed.models.webRead,
      extract: parsed.models.extract,
      rerank: parsed.models.rerank,
    },
    ingest: {
      allowedExtensions: normalizeAllowedExtensions(parsed.ingest.allowedExtensions),
      maxFileSizeMb: parsed.ingest.maxFileSizeMb,
      pendingTtlMs: parsed.ingest.pendingTtlMs,
      sessionIdleMs: parsed.ingest.sessionIdleMs,
      concurrency: parsed.ingest.concurrency,
      maxExtractChunks: parsed.ingest.maxExtractChunks,
      maxExtractQas: parsed.ingest.maxExtractQas,
    },
    parser: {
      externalApiEnabled: parsed.parser.externalApiEnabled,
      pdfProviderOrder: parsed.parser.pdfProviderOrder,
      imageProviderOrder: parsed.parser.imageProviderOrder,
      ocrLang: parsed.parser.ocrLang,
      timeoutMs: parsed.parser.timeoutMs,
      pollIntervalMs: parsed.parser.pollIntervalMs,
      maxPollMs: parsed.parser.maxPollMs,
      mineru: {
        enabled: parsed.parser.mineru.enabled,
        endpoint: parsed.parser.mineru.endpoint,
        apiKey: parsed.parser.mineru.apiKey,
      },
      paddleocr: {
        enabled: parsed.parser.paddleocr.enabled,
        apiKey: parsed.parser.paddleocr.apiKey,
        secretKey: parsed.parser.paddleocr.secretKey,
      },
      paddleocrAiStudio: {
        enabled: parsed.parser.paddleocrAiStudio.enabled,
        endpoint: parsed.parser.paddleocrAiStudio.endpoint,
        token: parsed.parser.paddleocrAiStudio.token,
        useDocOrientationClassify: parsed.parser.paddleocrAiStudio.useDocOrientationClassify,
        useDocUnwarping: parsed.parser.paddleocrAiStudio.useDocUnwarping,
        useChartRecognition: parsed.parser.paddleocrAiStudio.useChartRecognition,
      },
    },
    obsidian: {
      enabled: parsed.obsidian.enabled,
      vaultPath: parsed.obsidian.vaultPath
        ? context.resolveRelative(context.baseDir, parsed.obsidian.vaultPath)
        : undefined,
      baseDir: parsed.obsidian.baseDir,
      enableWikiLinks: parsed.obsidian.enableWikiLinks,
    },
    authoritySources: {
      pkulaw: {
        enabled: parsed.authoritySources.pkulaw.enabled,
        cliCommand: parsed.authoritySources.pkulaw.cliCommand,
        transport: parsed.authoritySources.pkulaw.transport,
        skills: {
          lawSemantic: parsed.authoritySources.pkulaw.skills.lawSemantic,
          lawRecognition: parsed.authoritySources.pkulaw.skills.lawRecognition,
          citationValidator: parsed.authoritySources.pkulaw.skills.citationValidator,
          caseNumberRecognition: parsed.authoritySources.pkulaw.skills.caseNumberRecognition,
        },
      },
    },
  };
}
