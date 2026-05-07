/**
 * 职责: 构建 Legal Harness V1 专用飞书卡片。
 * 关注点:
 * - 输出二审报告卡、权威覆盖率卡、问题发现卡、结果分组卡。
 * - 依赖：harness-card-templates.ts 模板定义，需模板 runtime 注册完成后方可预览。
 */
import {
  buildInteractivePayload,
  buildNoticeBodyBlock,
  type FeishuPostPayload,
} from "./shared-primitives.js";
import { renderBusinessCard } from "./templates/runtime.js";
import {
  HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID,
  HARNESS_FINDINGS_TEMPLATE_ID,
  HARNESS_RESULT_GROUP_TEMPLATE_ID,
  HARNESS_REVIEW_REPORT_TEMPLATE_ID,
} from "../labor/harness-card-templates.js";

export type HarnessReviewReportCardView = {
  title: string;
  status: "pass" | "needs_revision" | "needs_human_review";
  findingCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  unsupportedClaimCount: number;
  warningCount: number;
  suggestedEditCount: number;
};

export type HarnessAuthorityCoverageCardView = {
  title: string;
  items: Array<{
    issue: string;
    status: "sufficient" | "partial" | "missing" | "skipped";
    sourceType?: string | undefined;
    sourceRef?: string | undefined;
  }>;
  sufficientCount: number;
  partialCount: number;
  missingCount: number;
  skippedCount: number;
};

export type HarnessFindingsCardView = {
  title: string;
  findings: Array<{
    severity: "low" | "medium" | "high";
    type: string;
    message: string;
    relatedSection?: string | undefined;
  }>;
  highFindings?: Array<{
    type: string;
    message: string;
    relatedSection?: string | undefined;
  }> | undefined;
};

export type HarnessResultGroupCardView = {
  title: string;
  groups: Array<{
    label: string;
    riskLevel?: "high" | "medium" | "low" | "info" | undefined;
    count: number;
    items: string[];
  }>;
  totalCount: number;
};

export function buildHarnessReviewReportPayload(view: HarnessReviewReportCardView): FeishuPostPayload {
  return buildHarnessTemplatePayload(HARNESS_REVIEW_REPORT_TEMPLATE_ID, view);
}

export function buildHarnessAuthorityCoveragePayload(view: HarnessAuthorityCoverageCardView): FeishuPostPayload {
  return buildHarnessTemplatePayload(HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID, view);
}

export function buildHarnessFindingsPayload(view: HarnessFindingsCardView): FeishuPostPayload {
  return buildHarnessTemplatePayload(HARNESS_FINDINGS_TEMPLATE_ID, view);
}

export function buildHarnessResultGroupPayload(view: HarnessResultGroupCardView): FeishuPostPayload {
  return buildHarnessTemplatePayload(HARNESS_RESULT_GROUP_TEMPLATE_ID, view);
}

function buildHarnessTemplatePayload(
  templateId: typeof HARNESS_REVIEW_REPORT_TEMPLATE_ID | typeof HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID | typeof HARNESS_FINDINGS_TEMPLATE_ID | typeof HARNESS_RESULT_GROUP_TEMPLATE_ID,
  input: HarnessReviewReportCardView | HarnessAuthorityCoverageCardView | HarnessFindingsCardView | HarnessResultGroupCardView,
): FeishuPostPayload {
  try {
    return renderBusinessCard(templateId, input);
  } catch (error) {
    console.warn("[feishu/card-template] harness template render failed", {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return buildInteractivePayload({
      title: "Legal Harness 卡片渲染失败",
      template: "red",
      iconToken: "error-hollow_filled",
      bodyElements: [
        buildNoticeBodyBlock("卡片内容已生成，但渲染失败，请查看日志后重试。", "error-hollow_filled", "red"),
      ],
    });
  }
}
