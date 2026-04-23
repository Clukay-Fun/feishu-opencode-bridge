/**
 * 职责: 构建劳动争议分析流程使用的飞书卡片。
 * 关注点:
 * - 输出分析过程中的进度卡与完成结果卡。
 * - 组织事实、风险、时间线等劳动分析结果的展示结构。
 */
import {
  buildNoticeCardPayload,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "./shared-primitives.js";
import { renderBusinessCard } from "./templates/runtime.js";
import {
  LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID,
  LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID,
} from "./templates/labor-analysis.js";

export type LaborAnalysisProgressCardView = {
  sourceLabel: string;
  steps: ReadonlyArray<ToolUpdateView>;
  progressText?: string | undefined;
  startedAt?: number | undefined;
  elapsedMs?: number | undefined;
};

export type LaborAnalysisCompletedCardView = {
  title: string;
  materialCount: number;
  evidenceCount: number;
  issueCount: number;
  tagCounts: Record<string, number>;
  docUrl?: string | undefined;
};

export function buildLaborAnalysisProgressPayload(view: LaborAnalysisProgressCardView): FeishuPostPayload {
  return buildLaborTemplatePayload(LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID, view);
}

export function buildLaborAnalysisCompletedPayload(view: LaborAnalysisCompletedCardView): FeishuPostPayload {
  return buildLaborTemplatePayload(LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID, view);
}

function buildLaborTemplatePayload(
  templateId: typeof LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID | typeof LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID,
  input: LaborAnalysisProgressCardView | LaborAnalysisCompletedCardView,
): FeishuPostPayload {
  try {
    return renderBusinessCard(templateId, input, { onError: "throw" });
  } catch (error) {
    console.warn("[feishu/card-template] labor template render failed", {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return buildNoticeCardPayload({
      title: "劳动分析卡片渲染失败",
      template: "red",
      iconToken: "error-hollow_filled",
      message: "劳动分析结果已生成，但卡片渲染失败，请查看日志后重试。",
      showMessageIcon: false,
    });
  }
}
