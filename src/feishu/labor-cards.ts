/**
 * 职责: 构建劳动争议分析流程使用的飞书卡片。
 * 关注点:
 * - 输出分析过程中的进度卡与完成结果卡。
 * - 组织事实、风险、时间线等劳动分析结果的展示结构。
 */
import {
  buildDivider,
  buildElapsedLine,
  buildInteractivePayload,
  buildKnowledgeIngestProgressStepElements,
  buildQuoteLine,
  buildStatsRow,
  buildTagChartSection,
  buildTitleLine,
  escapeText,
  resolveElapsedText,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "./shared-primitives.js";

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
  const stepElements = view.steps.flatMap((step) => buildKnowledgeIngestProgressStepElements(step));
  return buildInteractivePayload({
    title: "劳动分析进行中",
    template: "indigo",
    iconToken: "start_outlined",
    bodyElements: [
      buildTitleLine(`处理文件：**${escapeText(view.sourceLabel)}**`),
      ...stepElements,
      ...(view.progressText ? [buildQuoteLine(escapeText(view.progressText))] : []),
      buildDivider(),
      buildElapsedLine(resolveElapsedText(view)),
    ],
  });
}

export function buildLaborAnalysisCompletedPayload(view: LaborAnalysisCompletedCardView): FeishuPostPayload {
  const bodyElements: Array<Record<string, unknown>> = [
    buildTitleLine(`案件：**${escapeText(view.title)}**`),
    buildStatsRow([
      `材料 ${view.materialCount}`,
      `证据 ${view.evidenceCount}`,
      `焦点 ${view.issueCount}`,
    ]),
    buildTagChartSection(view.tagCounts, view.docUrl, "材料占比", "打开分析文档"),
  ];
  return buildInteractivePayload({
    title: "劳动分析完成",
    template: "green",
    iconToken: "yes_filled",
    bodyElements,
  });
}
