/**
 * 职责: 定义并规范化劳动分析模块配置。
 * 关注点:
 * - 让 laborSkill 子配置靠近劳动分析模块维护。
 * - 保持 config.json 与 AppConfig["laborSkill"] 的兼容形状。
 */
import { z } from "zod";

import type { ModuleConfigDefinition } from "../config/module-registry.js";
import { SUPPORTED_MATERIAL_EXTENSIONS, normalizeAllowedExtensions } from "../document-pipeline/material-support.js";

const LaborSkillModelRefSchema = z.string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s].+$/, "laborSkill.models.* 必须使用 <provider>/<model> 格式");

export interface LaborSkillModels {
  default?: string | undefined;
  extract?: string | undefined;
  analyze?: string | undefined;
  review?: string | undefined;
}

const LaborSkillConfigSchema = z.object({
  enabled: z.boolean().default(false),
  models: z.object({
    default: LaborSkillModelRefSchema.optional(),
    extract: LaborSkillModelRefSchema.optional(),
    analyze: LaborSkillModelRefSchema.optional(),
    review: LaborSkillModelRefSchema.optional(),
  }).default({}),
  ingest: z.object({
    allowedExtensions: z.array(z.string().min(1)).default([...SUPPORTED_MATERIAL_EXTENSIONS]),
    maxFileSizeMb: z.number().positive().default(20),
    pendingTtlMs: z.number().int().positive().default(600_000),
  }).default({}),
  storage: z.object({
    evidenceLedger: z.object({
      appToken: z.string().default(""),
      tableId: z.string().default(""),
      keyEvidenceViewId: z.string().min(1).optional(),
      missingEvidenceViewId: z.string().min(1).optional(),
    }).optional(),
  }).default({}),
}).default({});

type LaborSkillParsedConfig = z.infer<typeof LaborSkillConfigSchema>;

export type LaborSkillConfig = {
  enabled: boolean;
  models: LaborSkillModels;
  ingest: {
    allowedExtensions: string[];
    maxFileSizeMb: number;
    pendingTtlMs: number;
  };
  storage: {
    evidenceLedger?: {
      appToken: string;
      tableId: string;
      keyEvidenceViewId?: string | undefined;
      missingEvidenceViewId?: string | undefined;
    } | undefined;
  };
};

export const DEFAULT_LABOR_SKILL_CONFIG: LaborSkillConfig = {
  enabled: false,
  models: {},
  ingest: {
    allowedExtensions: [...SUPPORTED_MATERIAL_EXTENSIONS],
    maxFileSizeMb: 20,
    pendingTtlMs: 600_000,
  },
  storage: {},
};

export const laborSkillConfigDefinition: ModuleConfigDefinition<LaborSkillParsedConfig, LaborSkillConfig> = {
  key: "laborSkill",
  schema: LaborSkillConfigSchema,
  normalize: normalizeLaborSkillConfig,
};

function normalizeLaborSkillConfig(parsed: LaborSkillParsedConfig): LaborSkillConfig {
  return {
    enabled: parsed.enabled,
    models: {
      default: parsed.models.default,
      extract: parsed.models.extract,
      analyze: parsed.models.analyze,
      review: parsed.models.review,
    },
    ingest: {
      allowedExtensions: normalizeAllowedExtensions(parsed.ingest.allowedExtensions),
      maxFileSizeMb: parsed.ingest.maxFileSizeMb,
      pendingTtlMs: parsed.ingest.pendingTtlMs,
    },
    storage: {
      evidenceLedger: parsed.storage.evidenceLedger
        ? {
          appToken: parsed.storage.evidenceLedger.appToken,
          tableId: parsed.storage.evidenceLedger.tableId,
          keyEvidenceViewId: parsed.storage.evidenceLedger.keyEvidenceViewId,
          missingEvidenceViewId: parsed.storage.evidenceLedger.missingEvidenceViewId,
        }
        : undefined,
    },
  };
}
