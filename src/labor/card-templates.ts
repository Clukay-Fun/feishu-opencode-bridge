/**
 * 职责: 定义劳动分析业务卡片模板。
 * 关注点:
 * - 通过 Zod 校验进度和完成卡片的数据输入。
 * - 将劳动分析视图模型渲染为通用业务卡片规格。
 * - 文档链接只在二审完成卡出现，一审完成卡不放。
 */
import { z } from "zod";

import { escapeText, resolveElapsedText } from "../feishu/shared-primitives.js";
import type { BusinessCardTemplateDefinition } from "../feishu/templates/definition.js";

const ToolUpdateViewSchema = z.object({
  label: z.string(),
  detail: z.string(),
  status: z.enum(["pending", "running", "completed", "error", "unknown"]),
});

const LaborAnalysisProgressCardViewSchema = z.object({
  sourceLabel: z.string(),
  steps: z.array(ToolUpdateViewSchema),
  progressText: z.string().optional(),
  startedAt: z.number().optional(),
  elapsedMs: z.number().optional(),
});

const LaborAnalysisCompletedCardViewSchema = z.object({
  title: z.string(),
  materialCount: z.number(),
  evidenceCount: z.number(),
  issueCount: z.number(),
  tagCounts: z.record(z.string(), z.number()),
  docUrl: z.string().optional(),
  ledgerUrl: z.string().optional(),
  keyEvidenceViewUrl: z.string().optional(),
  missingEvidenceViewUrl: z.string().optional(),
  syncedEvidenceCount: z.number().optional(),
  syncedGapCount: z.number().optional(),
  reviewStatus: z.string().optional(),
});

const LaborReviewCompletedCardViewSchema = z.object({
  title: z.string(),
  materialCount: z.number(),
  evidenceCount: z.number(),
  issueCount: z.number(),
  tagCounts: z.record(z.string(), z.number()),
  reviewStatus: z.string(),
  findingsCount: z.number().optional(),
  humanReviewCount: z.number().optional(),
  docUrl: z.string().optional(),
  ledgerUrl: z.string().optional(),
  keyEvidenceViewUrl: z.string().optional(),
  missingEvidenceViewUrl: z.string().optional(),
  syncedEvidenceCount: z.number().optional(),
  syncedGapCount: z.number().optional(),
});

export const LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID = "labor.analysis.progress";
export const LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID = "labor.analysis.completed";
export const LABOR_REVIEW_COMPLETED_TEMPLATE_ID = "labor.review.completed";

export const laborAnalysisProgressTemplate: BusinessCardTemplateDefinition<typeof LaborAnalysisProgressCardViewSchema> = {
  id: LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID,
  schema: LaborAnalysisProgressCardViewSchema,
  render(input) {
    return {
      title: "劳动分析进行中",
      template: "indigo",
      iconToken: "start_outlined",
      blocks: [
        { kind: "title", content: `处理文件：**${escapeText(input.sourceLabel)}**` },
        { kind: "steps", steps: input.steps },
        ...(input.progressText ? [{ kind: "quote" as const, content: escapeText(input.progressText) }] : []),
        { kind: "divider" },
        { kind: "elapsed", content: resolveElapsedText(input) },
      ],
    };
  },
};

export const laborAnalysisCompletedTemplate: BusinessCardTemplateDefinition<typeof LaborAnalysisCompletedCardViewSchema> = {
  id: LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID,
  schema: LaborAnalysisCompletedCardViewSchema,
  render(input) {
    return {
      title: "劳动分析完成",
      template: "green",
      iconToken: "yes_filled",
      blocks: [
        { kind: "title", content: `案件：**${escapeText(input.title)}**` },
        { kind: "stats", labels: [`材料 ${input.materialCount}`, `证据 ${input.evidenceCount}`, `焦点 ${input.issueCount}`] },
        ...(input.reviewStatus
          ? [{ kind: "quote" as const, content: escapeText(input.reviewStatus) }]
          : []),
        { kind: "tagChart", tagCounts: input.tagCounts, title: "材料占比" },
      ],
    };
  },
};

export const laborReviewCompletedTemplate: BusinessCardTemplateDefinition<typeof LaborReviewCompletedCardViewSchema> = {
  id: LABOR_REVIEW_COMPLETED_TEMPLATE_ID,
  schema: LaborReviewCompletedCardViewSchema,
  render(input) {
    const isPass = input.reviewStatus.includes("通过");
    const docLinks = [
      input.docUrl ? `[打开分析文档](${input.docUrl})` : "",
      input.ledgerUrl ? `[打开证据台账](${input.ledgerUrl})` : "",
    ].filter(Boolean).join("｜");
    const reviewStats = [
      typeof input.findingsCount === "number" ? `发现 ${input.findingsCount} 项` : "",
      typeof input.humanReviewCount === "number" ? `需人工复核 ${input.humanReviewCount} 项` : "",
    ].filter(Boolean).join("｜");
    return {
      title: isPass ? "劳动分析二审通过" : "劳动分析二审完成",
      template: isPass ? "green" : "yellow",
      iconToken: isPass ? "yes_filled" : "warning_filled",
      blocks: [
        { kind: "title", content: `案件：**${escapeText(input.title)}**` },
        { kind: "stats", labels: [`材料 ${input.materialCount}`, `证据 ${input.evidenceCount}`, `焦点 ${input.issueCount}`] },
        { kind: "quote", content: escapeText(input.reviewStatus) },
        ...(reviewStats
          ? [{ kind: "quote" as const, content: reviewStats }]
          : []),
        ...(docLinks
          ? [{ kind: "quote" as const, content: docLinks }]
          : []),
        ...(input.ledgerUrl
          ? [{ kind: "quote" as const, content: [
            `证据台账：[打开总表](${input.ledgerUrl})`,
            input.keyEvidenceViewUrl ? `[关键证据视图](${input.keyEvidenceViewUrl})` : "",
            input.missingEvidenceViewUrl ? `[缺口视图](${input.missingEvidenceViewUrl})` : "",
            typeof input.syncedEvidenceCount === "number" || typeof input.syncedGapCount === "number"
              ? `已同步 ${input.syncedEvidenceCount ?? 0} 条证据、${input.syncedGapCount ?? 0} 条缺口`
              : "",
          ].filter(Boolean).join("｜") }]
          : []),
      ],
    };
  },
};
