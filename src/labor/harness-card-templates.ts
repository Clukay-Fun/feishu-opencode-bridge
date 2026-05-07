/**
 * 职责: 定义 Legal Harness V1 专用业务卡片的模板。
 * 关注点:
 * - 收口 reviewReport、authorityCoverage、findings、结果分组 4 张卡片的模板定义。
 * - 为每张卡片提供稳定 ID、集中入口和 Zod 输入校验。
 */
import { z } from "zod";

import { escapeText } from "../feishu/shared-primitives.js";
import type { BusinessCardBlock, BusinessCardTemplateDefinition } from "../feishu/templates/definition.js";

export const HARNESS_REVIEW_REPORT_TEMPLATE_ID = "harness.review-report";
export const HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID = "harness.authority-coverage";
export const HARNESS_FINDINGS_TEMPLATE_ID = "harness.findings";
export const HARNESS_RESULT_GROUP_TEMPLATE_ID = "harness.result-group";

const HarnessReviewReportViewSchema = z.object({
  title: z.string(),
  status: z.enum(["pass", "needs_revision", "needs_human_review"]),
  findingCount: z.number(),
  highCount: z.number(),
  mediumCount: z.number(),
  lowCount: z.number(),
  unsupportedClaimCount: z.number(),
  warningCount: z.number(),
  suggestedEditCount: z.number(),
});

const HarnessAuthorityCoverageViewSchema = z.object({
  title: z.string(),
  items: z.array(z.object({
    issue: z.string(),
    status: z.enum(["sufficient", "partial", "missing", "skipped"]),
    sourceType: z.string().optional(),
    sourceRef: z.string().optional(),
  })),
  sufficientCount: z.number(),
  partialCount: z.number(),
  missingCount: z.number(),
  skippedCount: z.number(),
});

const HarnessFindingsViewSchema = z.object({
  title: z.string(),
  findings: z.array(z.object({
    severity: z.enum(["low", "medium", "high"]),
    type: z.string(),
    message: z.string(),
    relatedSection: z.string().optional(),
  })),
  highFindings: z.array(z.object({
    type: z.string(),
    message: z.string(),
    relatedSection: z.string().optional(),
  })).optional(),
});

const HarnessResultGroupViewSchema = z.object({
  title: z.string(),
  groups: z.array(z.object({
    label: z.string(),
    riskLevel: z.enum(["high", "medium", "low", "info"]).optional(),
    count: z.number(),
    items: z.array(z.string()),
  })),
  totalCount: z.number(),
});

export const harnessReviewReportTemplate: BusinessCardTemplateDefinition<typeof HarnessReviewReportViewSchema> = {
  id: HARNESS_REVIEW_REPORT_TEMPLATE_ID,
  schema: HarnessReviewReportViewSchema,
  render(input) {
    const statusConfig = resolveReviewStatusConfig(input.status);
    const statsLabels = [
      `高风险 ${input.highCount}`,
      `中风险 ${input.mediumCount}`,
      `低风险 ${input.lowCount}`,
    ];
    const secondLineLabels = [
      `问题发现 ${input.findingCount}`,
      `无依据请求 ${input.unsupportedClaimCount}`,
      `修改建议 ${input.suggestedEditCount}`,
    ];
    const blocks: BusinessCardBlock[] = [
      { kind: "title", content: `案件：**${escapeText(input.title)}**` },
      { kind: "stats", labels: statsLabels },
      { kind: "stats", labels: secondLineLabels },
      ...(input.warningCount > 0
        ? [{ kind: "quote" as const, content: `⚠️ 存在 ${input.warningCount} 条警告，请留意。` }]
        : []),
      { kind: "divider" },
      { kind: "elapsed", content: `审核状态：${statusConfig.label}` },
    ];
    return {
      title: "二审报告",
      template: statusConfig.template,
      iconToken: statusConfig.icon,
      blocks,
    };
  },
};

export const harnessAuthorityCoverageTemplate: BusinessCardTemplateDefinition<typeof HarnessAuthorityCoverageViewSchema> = {
  id: HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID,
  schema: HarnessAuthorityCoverageViewSchema,
  render(input) {
    const accountableCount = input.items.length - input.skippedCount;
    const coverageRate = accountableCount > 0
      ? Math.round((input.sufficientCount / accountableCount) * 100)
      : 0;
    const statsLabels = [
      `充分 ${input.sufficientCount}`,
      `部分 ${input.partialCount}`,
      `缺失 ${input.missingCount}`,
      `跳过 ${input.skippedCount}`,
    ];
    return {
      title: "权威检索覆盖率",
      template: coverageRate >= 80 ? "green" : coverageRate >= 50 ? "yellow" : "red",
      iconToken: coverageRate >= 80 ? "yes_outlined" : coverageRate >= 50 ? "maybe_outlined" : "error-hollow_filled",
      blocks: [
        { kind: "title", content: `案件：**${escapeText(input.title)}**` },
        { kind: "stats", labels: [`覆盖率 ${coverageRate}%`] },
        { kind: "stats", labels: statsLabels },
        { kind: "divider" },
        { kind: "elapsed", content: `共 ${input.items.length} 个争议点` },
      ],
    };
  },
};

export const harnessFindingsTemplate: BusinessCardTemplateDefinition<typeof HarnessFindingsViewSchema> = {
  id: HARNESS_FINDINGS_TEMPLATE_ID,
  schema: HarnessFindingsViewSchema,
  render(input) {
    const highFindings = input.highFindings ?? input.findings.filter((f) => f.severity === "high").slice(0, 3);
    const blocks: BusinessCardBlock[] = [
      { kind: "title", content: `案件：**${escapeText(input.title)}**` },
      { kind: "stats", labels: [`共 ${input.findings.length} 个发现`] },
    ];
    if (highFindings.length > 0) {
      blocks.push({ kind: "divider" });
      blocks.push({ kind: "quote", content: `🚨 高风险问题（${highFindings.length} 项）：\n${highFindings.map((f, i) => `${i + 1}. ${escapeText(f.type)}：${escapeText(f.message)}`).join("\n")}` });
    }
    return {
      title: "问题发现列表",
      template: highFindings.length > 0 ? "red" : "green",
      iconToken: highFindings.length > 0 ? "error-hollow_filled" : "yes_outlined",
      blocks,
    };
  },
};

export const harnessResultGroupTemplate: BusinessCardTemplateDefinition<typeof HarnessResultGroupViewSchema> = {
  id: HARNESS_RESULT_GROUP_TEMPLATE_ID,
  schema: HarnessResultGroupViewSchema,
  render(input) {
    const riskLabelMap: Record<string, string> = {
      high: "🔴 高风险",
      medium: "🟡 中风险",
      low: "🟢 低风险",
      info: "🔵 参考",
    };
    const groupLines = input.groups
      .map((g) => {
        const prefix = g.riskLevel ? `${riskLabelMap[g.riskLevel] ?? ""} ` : "";
        return `${prefix}${escapeText(g.label)}（${g.count}）`;
      })
      .join("\n");
    return {
      title: "结果分组",
      template: "blue",
      iconToken: "result_outlined",
      blocks: [
        { kind: "title", content: `**${escapeText(input.title)}**` },
        { kind: "stats", labels: [`共 ${input.totalCount} 项结果`] },
        { kind: "divider" },
        { kind: "quote", content: groupLines || "暂无分组结果" },
      ],
    };
  },
};

function resolveReviewStatusConfig(status: "pass" | "needs_revision" | "needs_human_review"): { template: "blue" | "green" | "yellow" | "red"; icon: string; label: string } {
  switch (status) {
    case "pass":
      return { template: "green", icon: "yes_outlined", label: "通过" };
    case "needs_revision":
      return { template: "yellow", icon: "maybe_outlined", label: "需修改" };
    case "needs_human_review":
      return { template: "red", icon: "error-hollow_filled", label: "需人工复核" };
  }
}
