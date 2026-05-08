/**
 * 职责: 构建劳动争议分析流程使用的飞书卡片。
 * 关注点:
 * - 输出分析过程中的进度卡与完成结果卡。
 * - 权威法规检索作为后台能力融入分析和二审，不再暴露独立卡片。
 * - 文档链接只在二审完成卡出现，一审完成卡不放。
 */
import {
  buildNoticeCardPayload,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "./shared-primitives.js";
import { buildDesignerCardPayload, setDesignerButtonValue } from "./designer-card-renderer.js";
import { renderBusinessCard } from "./templates/runtime.js";
import {
  LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID,
  LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID,
  LABOR_REVIEW_COMPLETED_TEMPLATE_ID,
} from "../labor/card-templates.js";

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
  ledgerUrl?: string | undefined;
  keyEvidenceViewUrl?: string | undefined;
  missingEvidenceViewUrl?: string | undefined;
  syncedEvidenceCount?: number | undefined;
  syncedGapCount?: number | undefined;
  reviewStatus?: string | undefined;
};

export type LaborReviewCompletedCardView = {
  title: string;
  materialCount: number;
  evidenceCount: number;
  issueCount: number;
  tagCounts: Record<string, number>;
  reviewStatus: string;
  findingsCount?: number | undefined;
  humanReviewCount?: number | undefined;
  docUrl?: string | undefined;
  ledgerUrl?: string | undefined;
  keyEvidenceViewUrl?: string | undefined;
  missingEvidenceViewUrl?: string | undefined;
  syncedEvidenceCount?: number | undefined;
  syncedGapCount?: number | undefined;
};

export type LaborFinalReviewCardView = {
  title: string;
  statusText: string;
  detail?: string | undefined;
  level: "info" | "warning" | "error" | "neutral";
};

export type LaborMaterialCollectionCardView = {
  title?: string | undefined;
  conversationKey?: string | undefined;
};

export function buildLaborMaterialCollectionPayload(view: LaborMaterialCollectionCardView = {}): FeishuPostPayload {
  void view;
  return buildDesignerCardPayload("材料收集中");
}

export function buildLaborAnalysisProgressPayload(view: LaborAnalysisProgressCardView): FeishuPostPayload {
  return buildValidatedLaborDesignerPayload(LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID, view, () => buildDesignerCardPayload("材料分析进行中", [
    { from: "解除通知.pdf", to: view.sourceLabel },
    { from: "耗时 1m", to: view.elapsedMs ? `耗时 ${Math.round(view.elapsedMs / 1000)}s` : "处理中" },
  ]));
}

export function buildLaborAnalysisCompletedPayload(view: LaborAnalysisCompletedCardView): FeishuPostPayload {
  return buildValidatedLaborDesignerPayload(LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID, view, () => buildDesignerCardPayload("材料分析完成", [
    { from: "张三违法解除劳动合同争议", to: view.title },
    { from: "材料 5", to: `材料 ${view.materialCount}` },
    { from: "证据 12", to: `证据 ${view.evidenceCount}` },
    { from: "焦点 4", to: `焦点 ${view.issueCount}` },
  ]));
}

export function buildLaborReviewCompletedPayload(view: LaborReviewCompletedCardView): FeishuPostPayload {
  return buildValidatedLaborDesignerPayload(LABOR_REVIEW_COMPLETED_TEMPLATE_ID, view, () => buildDesignerCardPayload("二次审查完成", [
    { from: "张三违法解除劳动合同争议", to: view.title },
    { from: "高风险问题（1项）", to: `高风险问题（${view.humanReviewCount ?? 0}项）` },
    { from: "中风险问题（1项）", to: `中风险问题（${view.findingsCount ?? 0}项）` },
    { from: "工资基数缺少来源", to: view.reviewStatus },
  ], (card) => {
    setDesignerButtonValue(card, "打开分析文档", { kind: "labor-review-action", action: "open-analysis-doc", url: view.docUrl });
  }));
}

export function buildLaborFinalReviewPayload(view: LaborFinalReviewCardView): FeishuPostPayload {
  if (view.level === "info") {
    return buildDesignerCardPayload("二次审查进行中", [
      { from: "张三违法解除劳动合同争议", to: view.title },
    ]);
  }
  return buildNoticeCardPayload({
    title: "劳动分析二审",
    level: view.level,
    message: [
      `案件：${view.title}`,
      view.statusText,
      view.detail ?? "",
    ].filter(Boolean).join("\n"),
    showMessageIcon: false,
  });
}

function buildValidatedLaborDesignerPayload(
  templateId: typeof LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID | typeof LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID | typeof LABOR_REVIEW_COMPLETED_TEMPLATE_ID,
  input: LaborAnalysisProgressCardView | LaborAnalysisCompletedCardView | LaborReviewCompletedCardView,
  renderDesignerCard: () => FeishuPostPayload,
): FeishuPostPayload {
  try {
    // 设计器模板只负责视觉；zod schema 仍由模板运行时校验，保护业务输入契约。
    renderBusinessCard(templateId, input);
    return renderDesignerCard();
  } catch (error) {
    console.warn("[feishu/card-template] labor template render failed", {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return buildNoticeCardPayload({
      title: "劳动分析卡片渲染失败",
      level: "error",
      message: "劳动分析结果已生成，但卡片渲染失败，请查看日志后重试。",
      showMessageIcon: false,
    });
  }
}
