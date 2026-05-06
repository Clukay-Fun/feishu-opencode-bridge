/**
 * 职责: 构建劳动争议分析流程使用的飞书卡片。
 * 关注点:
 * - 输出分析过程中的进度卡与完成结果卡。
 * - 组织事实、风险、时间线等劳动分析结果的展示结构。
 */
import {
  buildDivider,
  buildFooterTipBlock,
  buildInteractivePayload,
  buildNoticeCardPayload,
  buildNoticeBodyBlock,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "./shared-primitives.js";
import { renderBusinessCard } from "./templates/runtime.js";
import {
  LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID,
  LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID,
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

export type LaborAuthoritySearchCardView = {
  conversationKey: string;
  nonce: string;
  mainQuery: string;
  alternatives: string[];
  reason: string;
};

export type LaborAuthoritySearchResultCardView = {
  title: string;
  query: string;
  status: string;
  durationMs: number;
  items: Array<{
    title: string;
    excerpt: string;
    url?: string | undefined;
    sourceUpdatedAt?: string | undefined;
    timeliness?: string | undefined;
  }>;
  message?: string | undefined;
};

export function buildLaborAnalysisProgressPayload(view: LaborAnalysisProgressCardView): FeishuPostPayload {
  return buildLaborTemplatePayload(LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID, view);
}

export function buildLaborAnalysisCompletedPayload(view: LaborAnalysisCompletedCardView): FeishuPostPayload {
  return buildLaborTemplatePayload(LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID, view);
}

export function buildLaborAuthoritySearchConfirmPayload(view: LaborAuthoritySearchCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "补充权威法规检索",
    template: "indigo",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(renderAuthoritySearchSummary(view), "search_outlined", "indigo"),
      buildDivider(),
      buildAuthoritySearchActionBlock(view),
      buildFooterTipBlock("按钮不可用时，可回复 `确认检索词`、`/检索词 <自定义>` 或 `/跳过权威检索`。", "keyboard_outlined", "grey", "notation"),
    ],
  });
}

export function buildLaborAuthoritySearchRunningPayload(query: string): FeishuPostPayload {
  return buildInteractivePayload({
    title: "正在检索权威法规",
    template: "blue",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(`检索词：${query}\n最多等待 5 秒；失败不会影响原劳动分析报告。`, "search_outlined", "blue"),
      buildFooterTipBlock("正在调用北大法宝 law-semantic，请稍候。", "time_outlined", "grey", "notation"),
    ],
  });
}

export function buildLaborAuthoritySearchResultPayload(view: LaborAuthoritySearchResultCardView): FeishuPostPayload {
  const ok = view.items.length > 0;
  return buildInteractivePayload({
    title: ok ? "权威法规检索完成" : "权威法规检索未命中",
    template: ok ? "green" : "yellow",
    iconToken: ok ? "yes_outlined" : "maybe_outlined",
    bodyElements: [
      buildNoticeBodyBlock(
        [
          `案件：${view.title}`,
          `检索词：${view.query || "未生成"}`,
          `状态：${view.status}`,
          `耗时：${view.durationMs}ms`,
          view.message ? `提示：${view.message}` : "",
        ].filter(Boolean).join("\n"),
        ok ? "yes_outlined" : "maybe_outlined",
        ok ? "green" : "orange",
      ),
      buildDivider(),
      ...(ok ? buildAuthorityResultBlocks(view.items) : []),
      buildFooterTipBlock("本区块只作为权威法规线索；不替换本地知识库结论，也未触发劳动分析二次生成。", "info_outlined", "grey", "notation"),
    ],
  });
}

function buildLaborTemplatePayload(
  templateId: typeof LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID | typeof LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID,
  input: LaborAnalysisProgressCardView | LaborAnalysisCompletedCardView,
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
      template: "red",
      iconToken: "error-hollow_filled",
      message: "劳动分析结果已生成，但卡片渲染失败，请查看日志后重试。",
      showMessageIcon: false,
    });
  }
}

function buildAuthorityResultBlocks(items: LaborAuthoritySearchResultCardView["items"]): Array<Record<string, unknown>> {
  return items.slice(0, 5).flatMap((item, index) => [
    buildNoticeBodyBlock([
      `**${index + 1}. ${item.title}**`,
      item.excerpt,
      item.timeliness ? `时效性：${item.timeliness}` : "",
      item.sourceUpdatedAt ? `更新时间：${item.sourceUpdatedAt}` : "",
      item.url ? `来源：${item.url}` : "",
    ].filter(Boolean).join("\n"), "doc-search_outlined", "blue"),
    ...(index < Math.min(items.length, 5) - 1 ? [buildDivider()] : []),
  ]);
}

function renderAuthoritySearchSummary(view: LaborAuthoritySearchCardView): string {
  const alternatives = view.alternatives.length > 0
    ? `\n\n备选关键词：\n${view.alternatives.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
    : "";
  return [
    "劳动分析报告已生成。可追加北大法宝 law-semantic 权威法规区块。",
    "",
    `主查询：${view.mainQuery}`,
    `生成依据：${view.reason}`,
    alternatives,
  ].filter(Boolean).join("\n");
}

function buildAuthoritySearchActionBlock(view: LaborAuthoritySearchCardView): Record<string, unknown> {
  const buttons = [
    {
      label: "使用主查询",
      type: "primary",
      value: {
        kind: "labor-authority-search",
        action: "confirm",
        conversationKey: view.conversationKey,
        nonce: view.nonce,
      },
    },
    ...view.alternatives.slice(0, 2).map((query, index) => ({
      label: `备选 ${index + 1}`,
      type: "default",
      value: {
        kind: "labor-authority-search",
        action: "alternative",
        conversationKey: view.conversationKey,
        nonce: view.nonce,
        index: index + 1,
        query,
      },
    })),
    {
      label: "跳过",
      type: "default",
      value: {
        kind: "labor-authority-search",
        action: "skip",
        conversationKey: view.conversationKey,
        nonce: view.nonce,
      },
    },
  ];
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: button.label,
          },
          type: button.type,
          width: button.type === "primary" ? "fill" : "default",
          size: "medium",
          margin: "0px 0px 0px 0px",
          value: button.value,
        },
      ],
      vertical_align: "top",
    })),
    margin: "0px 0px 0px 0px",
  };
}
