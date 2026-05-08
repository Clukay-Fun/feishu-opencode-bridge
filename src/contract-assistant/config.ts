/**
 * 职责: 定义并规范化合同助手模块配置。
 * 关注点:
 * - 让 contractAssistant 子配置靠近合同助手模块维护。
 * - 保持 config.json 与 AppConfig["contractAssistant"] 的兼容形状。
 */
import { z } from "zod";

import type { ModuleConfigDefinition } from "../config/module-registry.js";

const ContractAssistantModelRefSchema = z.string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s].+$/, "contractAssistant.models.* 必须使用 <provider>/<model> 格式");

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
}).default({});

type ContractAssistantParsedConfig = z.infer<typeof ContractAssistantConfigSchema>;

export type ContractAssistantConfig = {
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
};

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
};

export const contractAssistantConfigDefinition: ModuleConfigDefinition<ContractAssistantParsedConfig, ContractAssistantConfig> = {
  key: "contractAssistant",
  schema: ContractAssistantConfigSchema.superRefine(validateContractAssistantConfig),
  validate: validateContractAssistantConfig,
  normalize: normalizeContractAssistantConfig,
};

function validateContractAssistantConfig(value: ContractAssistantParsedConfig, context: z.RefinementCtx): void {
  if (!value.enabled) {
    return;
  }
  if (!value.storage.baseToken) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "baseToken"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.baseToken",
    });
  }
  if (!value.storage.contractTableId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "contractTableId"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.contractTableId",
    });
  }
  if (!value.storage.invoiceTableId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "invoiceTableId"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.invoiceTableId",
    });
  }
  if (!value.storage.caseTableId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["storage", "caseTableId"],
      message: "contractAssistant.enabled=true 时必须提供 contractAssistant.storage.caseTableId",
    });
  }
}

function normalizeContractAssistantConfig(parsed: ContractAssistantParsedConfig): ContractAssistantConfig {
  return {
    enabled: parsed.enabled,
    storage: {
      baseToken: parsed.storage.baseToken,
      contractTableId: parsed.storage.contractTableId,
      invoiceTableId: parsed.storage.invoiceTableId,
      caseTableId: parsed.storage.caseTableId,
    },
    models: {
      default: parsed.models.default,
      draft: parsed.models.draft,
      extract: parsed.models.extract,
      invoice: parsed.models.invoice,
      caseManage: parsed.models.caseManage,
    },
    ingest: {
      contractAllowedExtensions: parsed.ingest.contractAllowedExtensions.map((value) => value.trim().toLowerCase()),
      invoiceAllowedExtensions: parsed.ingest.invoiceAllowedExtensions.map((value) => value.trim().toLowerCase()),
      maxFileSizeMb: parsed.ingest.maxFileSizeMb,
      pendingTtlMs: parsed.ingest.pendingTtlMs,
    },
  };
}
