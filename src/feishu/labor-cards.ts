/**
 * 职责: 构建劳动争议分析流程使用的飞书卡片。
 * 关注点:
 * - 输出分析过程中的进度卡与完成结果卡。
 * - 权威法规检索作为后台能力融入分析和二审，不再暴露独立卡片。
 * - 文档链接只在二审完成卡出现，一审完成卡不放。
 */
import {
  buildNoticeCardPayload,
  buildInteractivePayload,
  buildDivider,
  buildGreyPanel,
  cardMarkdown,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "./shared-primitives.js";
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
  return buildInteractivePayload({
    title: "材料收集中",
    template: "blue",
    iconToken: "loading_outlined",
    bodyElements: [
      cardMarkdown("请上传劳动相关材料，直接发送到聊天窗口即可。", "heading"),
      buildGreyPanel([
        cardMarkdown("**支持格式** ：PDF / DOCX / TXT / MD\n**模式** ：批量导入", "normal"),
        ...(view.title ? [cardMarkdown(`**案件标题** ：${view.title}`, "normal")] : []),
      ]),
      buildDivider(),
      ...(view.conversationKey
        ? [buildCollectionFinishButton(view.conversationKey)]
        : []),
      cardMarkdown("上传完成后点击按钮，或发送 `/完成上传` 开始分析。", "notation"),
    ],
  });
}

function buildCollectionFinishButton(conversationKey: string): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: "完成上传，开始分析" },
    type: "primary",
    width: "fill",
    size: "medium",
    icon: { tag: "standard_icon", token: "play_outlined" },
    value: {
      kind: "labor-collection-action",
      action: "finish-upload",
      conversationKey,
    },
  };
}

export function buildLaborAnalysisProgressPayload(view: LaborAnalysisProgressCardView): FeishuPostPayload {
  return buildLaborTemplatePayload(LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID, view);
}

export function buildLaborAnalysisCompletedPayload(view: LaborAnalysisCompletedCardView): FeishuPostPayload {
  return buildLaborTemplatePayload(LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID, view);
}

export function buildLaborReviewCompletedPayload(view: LaborReviewCompletedCardView): FeishuPostPayload {
  return buildLaborTemplatePayload(LABOR_REVIEW_COMPLETED_TEMPLATE_ID, view);
}

export function buildLaborFinalReviewPayload(view: LaborFinalReviewCardView): FeishuPostPayload {
  if (view.level === "info") {
    return buildInteractivePayload({
      title: "二次审查进行中",
      template: "blue",
      iconToken: "loading_outlined",
      bodyElements: [
        cardMarkdown(`案件：**${view.title}**`, "normal_v2"),
        buildGreyPanel([
          cardMarkdown("权威法规检索：已完成", "normal_v2", { icon: { token: "yes_outlined", color: "green" } }),
          cardMarkdown("法条引用校验：进行中", "normal_v2", { icon: { token: "loading_outlined", color: "blue" } }),
          cardMarkdown("请求权基础校验：等待中", "normal_v2", { icon: { token: "ellipse_outlined", color: "grey" } }),
        ], { padding: "8px 8px 8px 8px" }),
      ],
    });
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

function buildLaborTemplatePayload(
  templateId: typeof LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID | typeof LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID | typeof LABOR_REVIEW_COMPLETED_TEMPLATE_ID,
  input: LaborAnalysisProgressCardView | LaborAnalysisCompletedCardView | LaborReviewCompletedCardView,
): FeishuPostPayload {
  try {
    return renderBusinessCard(templateId, input);
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
