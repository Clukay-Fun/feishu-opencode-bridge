/**
 * 职责: 定义并规范化知识库模块配置。
 * 关注点:
 * - 让 knowledgeBase 子配置靠近 knowledge 模块维护。
 * - 保持 config.json 与 AppConfig["knowledgeBase"] 的兼容形状。
 */
import path from "node:path";

import { z } from "zod";

import type { ConfigLoadContext, ModuleConfigDefinition } from "../config/module-registry.js";

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
  allowedExtensions: z.array(z.string().min(1)).default([".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp"]),
  maxFileSizeMb: z.number().positive().default(20),
  pendingTtlMs: z.number().int().positive().default(600_000),
  sessionIdleMs: z.number().int().positive().default(1_800_000),
  concurrency: z.number().int().positive().max(10).default(3),
  maxExtractChunks: z.number().int().positive().default(30),
  maxExtractQas: z.number().int().positive().default(500),
}).default({});

const DocumentParserProviderSchema = z.enum(["mineru-agent", "paddleocr-vl", "pymupdf4llm", "docling", "pdf-parse", "tesseract"]);

const KnowledgeBaseParserSchema = z.object({
  externalApiEnabled: z.boolean().default(false),
  pdfProviderOrder: z.array(DocumentParserProviderSchema).default(["mineru-agent", "paddleocr-vl", "pymupdf4llm", "docling", "pdf-parse"]),
  imageProviderOrder: z.array(DocumentParserProviderSchema).default(["paddleocr-vl", "mineru-agent", "tesseract"]),
  ocrLang: z.string().min(1).default("chi_sim+eng"),
  timeoutMs: z.number().int().positive().default(180_000),
  pollIntervalMs: z.number().int().positive().default(5_000),
  maxPollMs: z.number().int().positive().default(180_000),
  mineru: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().default("https://mineru.net/api/v1/agent"),
  }).default({}),
  paddleocr: z.object({
    enabled: z.boolean().default(false),
    apiKey: z.string().default(""),
    secretKey: z.string().default(""),
  }).default({}),
}).default({});

export const DEFAULT_KNOWLEDGE_BASE_PARSER_CONFIG = {
  externalApiEnabled: false,
  pdfProviderOrder: ["mineru-agent", "paddleocr-vl", "pymupdf4llm", "docling", "pdf-parse"],
  imageProviderOrder: ["paddleocr-vl", "mineru-agent", "tesseract"],
  ocrLang: "chi_sim+eng",
  timeoutMs: 180_000,
  pollIntervalMs: 5_000,
  maxPollMs: 180_000,
  mineru: {
    enabled: false,
    endpoint: "https://mineru.net/api/v1/agent",
  },
  paddleocr: {
    enabled: false,
    apiKey: "",
    secretKey: "",
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

const KnowledgeBaseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoDetect: KnowledgeBaseAutoDetectSchema,
  query: KnowledgeBaseQuerySchema,
  storage: KnowledgeBaseStorageSchema,
  embeddingProvider: EmbeddingProviderSchema.optional(),
  models: KnowledgeBaseModelsSchema,
  ingest: KnowledgeBaseIngestSchema,
  parser: KnowledgeBaseParserSchema,
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
    pdfProviderOrder: Array<"mineru-agent" | "paddleocr-vl" | "pymupdf4llm" | "docling" | "pdf-parse" | "tesseract">;
    imageProviderOrder: Array<"mineru-agent" | "paddleocr-vl" | "pymupdf4llm" | "docling" | "pdf-parse" | "tesseract">;
    ocrLang: string;
    timeoutMs: number;
    pollIntervalMs: number;
    maxPollMs: number;
    mineru: {
      enabled: boolean;
      endpoint: string;
    };
    paddleocr: {
      enabled: boolean;
      apiKey: string;
      secretKey: string;
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
      allowedExtensions: parsed.ingest.allowedExtensions.map((value) => value.trim().toLowerCase()),
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
      },
      paddleocr: {
        enabled: parsed.parser.paddleocr.enabled,
        apiKey: parsed.parser.paddleocr.apiKey,
        secretKey: parsed.parser.paddleocr.secretKey,
      },
    },
  };
}
