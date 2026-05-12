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
import {
  buildDesignerCardPayload,
  replaceDesignerCardText,
  removeDesignerCardElements,
  type DesignerCard,
} from "./designer-card-renderer.js";
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
  totalFiles?: number | undefined;
  queuedFiles?: readonly string[] | undefined;
  completedFiles?: readonly string[] | undefined;
  failedFiles?: readonly string[] | undefined;
  currentPhase?: string | undefined;
  recentUpdates?: readonly string[] | undefined;
  insightLines?: readonly string[] | undefined;
  docUrl?: string | undefined;
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
  elapsedMs?: number | undefined;
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
  elapsedMs?: number | undefined;
  citationDetails?: readonly LaborCitationDetailView[] | undefined;
  findings?: ReadonlyArray<{
    severity: "low" | "medium" | "high";
    message: string;
  }> | undefined;
};

export type LaborCitationDetailView = {
  label: string;
  excerpt?: string | undefined;
  url?: string | undefined;
};

export type LaborFinalReviewCardView = {
  title: string;
  statusText: string;
  detail?: string | undefined;
  level: "info" | "warning" | "error" | "neutral";
  steps?: ReadonlyArray<{ label: string; status: ReviewStepStatus }> | undefined;
  authorityStatus?: ReviewStepStatus | undefined;
  citationStatus?: ReviewStepStatus | undefined;
  modelReviewStatus?: ReviewStepStatus | undefined;
};

type ReviewStepStatus = "pending" | "running" | "completed" | "error" | "skipped";

export type LaborMaterialCollectionCardView = {
  title?: string | undefined;
  conversationKey?: string | undefined;
};

export function buildLaborMaterialCollectionPayload(view: LaborMaterialCollectionCardView = {}): FeishuPostPayload {
  void view;
  return buildDesignerCardPayload("材料收集中", [
    { from: "发送 `/材料收集完成` 结束本次任务", to: "发送 `/完成上传` 或 `/材料收集完成` 结束本次任务" },
  ]);
}

export function buildLaborAnalysisProgressPayload(view: LaborAnalysisProgressCardView): FeishuPostPayload {
  return buildValidatedLaborDesignerPayload(LABOR_ANALYSIS_PROGRESS_TEMPLATE_ID, view, () => buildDesignerCardPayload("材料分析进行中", [
    { from: "解除通知.pdf", to: view.sourceLabel },
    { from: "已解析 3/5", to: formatLaborParsedTag(view) },
  ], (card) => {
    applyLaborProgressTemplateState(card, view);
    appendProgressPreviewButton(card, view.docUrl);
  }));
}

export function buildLaborAnalysisCompletedPayload(view: LaborAnalysisCompletedCardView): FeishuPostPayload {
  return buildValidatedLaborDesignerPayload(LABOR_ANALYSIS_COMPLETED_TEMPLATE_ID, view, () => buildDesignerCardPayload("材料分析完成", [
    { from: "张三违法解除劳动合同争议", to: view.title },
    { from: "材料 5", to: `材料 ${view.materialCount}` },
    { from: "证据 12", to: `证据 ${view.evidenceCount}` },
    { from: "焦点 4", to: `焦点 ${view.issueCount}` },
    { from: "耗时 2m 5s", to: formatElapsed(view.elapsedMs) },
  ], (card) => {
    updateDesignerTagChart(card, view.tagCounts, "材料占比");
    appendAnalysisDocumentButton(card, view.docUrl);
  }));
}

export function buildLaborReviewCompletedPayload(view: LaborReviewCompletedCardView): FeishuPostPayload {
  const findings = groupLaborReviewFindings(view);
  return buildValidatedLaborDesignerPayload(LABOR_REVIEW_COMPLETED_TEMPLATE_ID, view, () => buildDesignerCardPayload("二次审查完成", [
    { from: "张三违法解除劳动合同争议", to: view.title },
    { from: "高风险问题（1项）", to: `高风险问题（${findings.high.length}项）` },
    { from: "中风险问题（1项）", to: `中风险问题（${findings.medium.length}项）` },
    { from: "低风险问题（0项）", to: `低风险问题（${findings.low.length}项）` },
    { from: "工资基数缺少来源", to: formatFindingLine(findings.high) },
    { from: "经济补偿计算未引用第四十七条", to: formatFindingLine(findings.medium) },
    { from: "无", to: formatFindingLine(findings.low) },
    { from: "耗时 2m 5s", to: formatElapsed(view.elapsedMs) },
  ], (card) => {
    updateDesignerTagChart(card, view.tagCounts, "材料占比");
    appendReviewStatusBlock(card, view.reviewStatus);
    hideReviewRiskSectionWhenEmpty(card, "高风险问题", findings.high.length === 0);
    hideReviewRiskSectionWhenEmpty(card, "中风险问题", findings.medium.length === 0);
    hideReviewRiskSectionWhenEmpty(card, "低风险问题", findings.low.length === 0);
    appendCitationDetailsBlock(card, view.citationDetails ?? []);
    removeButtonByText(card, "打开分析文档");
  }));
}

export function buildLaborFinalReviewPayload(view: LaborFinalReviewCardView): FeishuPostPayload {
  if (view.level === "info") {
    const steps = view.steps ?? [
      { label: "整理审查材料", status: "completed" as const },
      { label: "法条与案例溯源", status: view.authorityStatus ?? "running" },
      { label: "二审模型审查", status: view.modelReviewStatus ?? "pending" },
      { label: "汇总审查结论", status: "pending" as const },
    ];
    return buildDesignerCardPayload("二次审查进行中", [
      { from: "张三违法解除劳动合同争议", to: view.title },
    ], (card) => {
      applyReviewStepTemplateState(card, steps);
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

function formatLaborParsedTag(view: LaborAnalysisProgressCardView): string {
  if (typeof view.totalFiles !== "number") {
    return "分析中";
  }
  const completed = (view.completedFiles?.length ?? 0) + (view.failedFiles?.length ?? 0);
  return `已解析 ${completed}/${view.totalFiles}`;
}

function formatElapsed(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined || elapsedMs < 0) {
    return "处理中";
  }
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `耗时 ${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `耗时 ${minutes}m ${rest}s` : `耗时 ${minutes}m`;
}

function applyLaborProgressTemplateState(card: DesignerCard, view: LaborAnalysisProgressCardView): void {
  const visibleSteps = pickLaborVisibleSteps(view.steps);
  const placeholders = ["读取内容：已完成", "提取关键信息：进行中", "生成结果：等待中"];
  visibleSteps.slice(0, placeholders.length).forEach((step, index) => {
    const content = `${step.label}：${formatToolStatus(step.status)}`;
    replaceDesignerCardText(card, placeholders[index]!, content);
    updateDivByPlainText(card, content, step.status);
  });
  appendExtraProgressSteps(card, visibleSteps.slice(placeholders.length));
  replaceDesignerListRows(card, "社保缴纳记录.pdf", inferQueuedMaterials(view).map((line) => ({ text: line, status: "pending" })));
  replaceDesignerListRows(card, "劳动合同.pdf", [
    ...(view.completedFiles ?? []).map((line) => ({ text: `已完成：${line}`, status: "completed" as const })),
    ...(view.failedFiles ?? []).map((line) => ({ text: `失败：${line}`, status: "error" as const })),
  ]);
  removeCompletedElapsedColumn(card);
  appendProgressInsightToCurrentPanel(card, view.insightLines ?? []);
  ensureDividerBeforeSection(card, "已完成");
  hideLaborSectionWhenEmpty(card, "排队中", inferQueuedMaterials(view).length === 0);
  hideLaborSectionWhenEmpty(card, "已完成", (view.completedFiles?.length ?? 0) + (view.failedFiles?.length ?? 0) === 0);
}

function appendAnalysisDocumentButton(card: DesignerCard, docUrl: string | undefined): void {
  if (!docUrl) {
    return;
  }
  const body = getCardBodyElements(card);
  if (!body) {
    return;
  }
  const insertIndex = body.findIndex((element) => isRecord(element) && element.tag === "hr");
  body.splice(insertIndex >= 0 ? insertIndex : body.length, 0, {
    tag: "button",
    text: {
      tag: "plain_text",
      content: "打开分析文档",
    },
    type: "primary",
    width: "fill",
    size: "medium",
    icon: {
      tag: "standard_icon",
      token: "right-bold_outlined",
    },
    url: docUrl,
    value: { kind: "labor-analysis-action", action: "open-analysis-doc", url: docUrl },
    margin: "0px 0px 0px 0px",
  });
}

function appendProgressPreviewButton(card: DesignerCard, docUrl: string | undefined): void {
  if (!docUrl) {
    return;
  }
  const body = getCardBodyElements(card);
  if (!body) {
    return;
  }
  const insertIndex = body.findIndex((element) => isRecord(element)
    && element.tag === "div"
    && isRecord(element.text)
    && element.text.content === "生成内容仅供参考，不构成法律意见");
  const button = {
    tag: "button",
    text: {
      tag: "plain_text",
      content: "预览分析文档",
    },
    type: "primary",
    width: "fill",
    size: "medium",
    icon: {
      tag: "standard_icon",
      token: "right-bold_outlined",
    },
    url: docUrl,
    value: { kind: "labor-progress-action", action: "open-preview-doc", url: docUrl },
    margin: "0px 0px 0px 0px",
  };
  body.splice(insertIndex >= 0 ? insertIndex : body.length, 0, button);
}

function appendExtraProgressSteps(card: DesignerCard, steps: readonly ToolUpdateView[]): void {
  if (steps.length === 0) {
    return;
  }
  const target = findFirstColumnWithMarkdown(card, `**${extractCurrentSourceLabel(card)}**`);
  if (!target) {
    return;
  }
  target.elements.push(...steps.map((step) => buildProgressStepDiv(`${step.label}：${formatToolStatus(step.status)}`, step.status)));
}

function buildProgressStepDiv(content: string, status: ToolUpdateView["status"]): Record<string, unknown> {
  const style = resolveStepStyle(status);
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content,
      text_size: "normal_v2",
      text_align: "left",
      text_color: style.textColor,
    },
    icon: {
      tag: "standard_icon",
      token: style.iconToken,
      color: style.iconColor,
    },
    margin: "0px 0px 0px 0px",
  };
}

function updateDesignerTagChart(card: DesignerCard, tagCounts: Record<string, number>, title: string): void {
  const values = Object.entries(tagCounts)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .slice(0, 10)
    .map(([tag, value]) => ({ tag, value }));
  forEachDesignerChart(card, (chart) => {
    const chartSpec = chart["chart_spec"];
    if (!isRecord(chartSpec)) {
      return;
    }
    chartSpec["title"] = { text: title };
    chartSpec["data"] = { values };
  });
}

function inferQueuedMaterials(view: LaborAnalysisProgressCardView): string[] {
  if (view.queuedFiles && view.queuedFiles.length > 0) {
    return view.queuedFiles.map((fileName) => `待处理：${fileName}`);
  }
  const total = view.totalFiles ?? 0;
  const completed = (view.completedFiles?.length ?? 0) + (view.failedFiles?.length ?? 0);
  const hasCurrent = view.sourceLabel && view.sourceLabel !== "劳动争议材料";
  const count = Math.max(total - completed - (hasCurrent ? 1 : 0), 0);
  if (count <= 0) {
    return [];
  }
  return Array.from({ length: count }, (_, index) => `待处理材料 ${index + 1}`);
}

function appendProgressInsightToCurrentPanel(card: DesignerCard, lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  const target = findFirstColumnWithMarkdown(card, `**${extractCurrentSourceLabel(card)}**`);
  if (!target) {
    return;
  }
  target.elements.push({
    tag: "hr",
    margin: "0px 0px 0px 0px",
  }, {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [{
      tag: "column",
      width: "weighted",
    background_style: "grey-50",
    elements: [
      {
        tag: "markdown",
        content: "**模型处理动态**",
        text_align: "left",
        text_size: "normal_v2",
        margin: "0px 0px 0px 0px",
      },
      ...lines.slice(0, 4).map((line) => ({
        tag: "div",
        text: {
          tag: "plain_text",
          content: line,
          text_size: "notation",
          text_align: "left",
          text_color: "grey",
        },
        margin: "0px 0px 0px 0px",
      })),
    ],
    padding: "8px 8px 8px 8px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: "8px",
    horizontal_align: "left",
    vertical_align: "top",
    margin: "0px 0px 0px 0px",
    weight: 1,
    }],
    margin: "0px 0px 0px 0px",
  });
}

function ensureDividerBeforeSection(card: DesignerCard, title: string): void {
  const body = getCardBodyElements(card);
  if (!body) {
    return;
  }
  const index = body.findIndex((element) => isRecord(element)
    && element.tag === "div"
    && isRecord(element.text)
    && element.text.content === title);
  if (index <= 0) {
    return;
  }
  const previous = body[index - 1];
  if (isRecord(previous) && previous.tag === "hr") {
    return;
  }
  body.splice(index, 0, { tag: "hr", margin: "0px 0px 0px 0px" });
}

function extractCurrentSourceLabel(card: DesignerCard): string {
  const label = findFirstMarkdownContent(card, (content) => content.startsWith("**") && content.endsWith("**"));
  return label?.slice(2, -2) ?? "劳动争议材料";
}

function findFirstMarkdownContent(input: unknown, predicate: (content: string) => boolean): string | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstMarkdownContent(item, predicate);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(input)) {
    return null;
  }
  if (input.tag === "markdown" && typeof input.content === "string" && predicate(input.content)) {
    return input.content;
  }
  for (const value of Object.values(input)) {
    const found = findFirstMarkdownContent(value, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function hideLaborSectionWhenEmpty(card: DesignerCard, title: string, shouldHide: boolean): void {
  if (!shouldHide) {
    return;
  }
  removeDesignerElementsAroundMarkdown(card, title, 2);
}

function replaceDesignerListRows(
  card: DesignerCard,
  placeholder: string,
  rows: ReadonlyArray<{ text: string; status: ToolUpdateView["status"] }>,
): void {
  const target = findElementParentByText(card, placeholder);
  if (!target) {
    return;
  }
  if (rows.length === 0) {
    target.parent.splice(target.index, 1);
    return;
  }
  const template = target.parent[target.index];
  const nextRows = rows.map((row) => applyListRowState(cloneDesignerElement(template), row.text, row.status));
  target.parent.splice(target.index, 1, ...nextRows);
}

function applyListRowState(input: unknown, content: string, status: ToolUpdateView["status"]): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const style = resolveStepStyle(status);
  if (input.tag === "div" && isRecord(input.text)) {
    input.text = { ...input.text, content, text_color: style.textColor };
    input.icon = {
      tag: "standard_icon",
      token: style.iconToken,
      color: style.iconColor,
    };
    return input;
  }
  if (input.tag === "markdown" && typeof input.content === "string") {
    input.content = content;
    input.icon = {
      tag: "standard_icon",
      token: style.iconToken,
      color: style.iconColor,
    };
    return input;
  }
  return input;
}

function removeCompletedElapsedColumn(card: DesignerCard): void {
  const body = getCardBodyElements(card);
  if (!body) {
    return;
  }
  removeColumnContainingPlainText(body, "耗时 1m");
}

function pickLaborVisibleSteps(steps: ReadonlyArray<ToolUpdateView>): ToolUpdateView[] {
  const fallback: ToolUpdateView[] = [
    { label: "读取内容", detail: "等待开始", status: "pending" },
    { label: "提取关键信息", detail: "等待开始", status: "pending" },
    { label: "案件级汇总", detail: "等待开始", status: "pending" },
    { label: "创建预览文档", detail: "等待开始", status: "pending" },
    { label: "写入云文档", detail: "等待开始", status: "pending" },
    { label: "生成图表与台账", detail: "等待开始", status: "pending" },
  ];
  const byLabel = new Map(steps.map((step) => [step.label, step]));
  return fallback.map((step) => byLabel.get(step.label) ?? step);
}

function formatToolStatus(status: ToolUpdateView["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "running":
      return "进行中";
    case "error":
      return "失败";
    case "unknown":
      return "待确认";
    case "pending":
      return "等待中";
  }
}

function formatReviewStepLine(label: string, status: ReviewStepStatus): string {
  return `${label}：${formatReviewStatusLabel(status)}`;
}

function formatReviewStatusLabel(status: ReviewStepStatus): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "running":
      return "进行中";
    case "error":
      return "不可用";
    case "skipped":
      return "已跳过";
    case "pending":
      return "等待中";
  }
}

function applyReviewStepTemplateState(
  card: DesignerCard,
  steps: ReadonlyArray<{ label: string; status: ReviewStepStatus }>,
): void {
  const placeholders = ["权威法规检索：已完成", "法条引用校验：进行中", "请求权基础校验：等待中"];
  steps.slice(0, placeholders.length).forEach((step, index) => {
    updateDivByPlainText(card, placeholders[index]!, mapReviewStatus(step.status), formatReviewStepLine(step.label, step.status));
  });
  appendReviewExtraSteps(card, steps.slice(placeholders.length));
}

function appendReviewExtraSteps(card: DesignerCard, steps: ReadonlyArray<{ label: string; status: ReviewStepStatus }>): void {
  if (steps.length === 0) {
    return;
  }
  const target = findFirstColumnWithPlainText(card, "二审模型审查");
  if (!target) {
    return;
  }
  target.elements.push(...steps.map((step) => buildProgressStepDiv(formatReviewStepLine(step.label, step.status), mapReviewStatus(step.status))));
}

function mapReviewStatus(status: ReviewStepStatus): ToolUpdateView["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "error":
      return "error";
    case "skipped":
    case "pending":
      return "pending";
  }
}

function updateDivByPlainText(input: unknown, content: string, status: ToolUpdateView["status"], nextContent = content): boolean {
  if (Array.isArray(input)) {
    return input.some((item) => updateDivByPlainText(item, content, status, nextContent));
  }
  if (!isRecord(input)) {
    return false;
  }
  if (input.tag === "div" && isRecord(input.text) && input.text.content === content) {
    const style = resolveStepStyle(status);
    input.text = { ...input.text, content: nextContent, text_color: style.textColor };
    input.icon = {
      tag: "standard_icon",
      token: style.iconToken,
      color: style.iconColor,
    };
    return true;
  }
  return Object.values(input).some((value) => updateDivByPlainText(value, content, status, nextContent));
}

function resolveStepStyle(status: ToolUpdateView["status"]): {
  textColor: "green" | "default" | "grey" | "red";
  iconToken: string;
  iconColor: "green" | "blue" | "grey" | "red";
} {
  switch (status) {
    case "completed":
      return { textColor: "green", iconToken: "yes_outlined", iconColor: "green" };
    case "running":
      return { textColor: "default", iconToken: "loading_outlined", iconColor: "blue" };
    case "error":
      return { textColor: "red", iconToken: "error_outlined", iconColor: "red" };
    case "unknown":
    case "pending":
      return { textColor: "grey", iconToken: "ellipse_outlined", iconColor: "grey" };
  }
}

function groupLaborReviewFindings(view: LaborReviewCompletedCardView): {
  high: string[];
  medium: string[];
  low: string[];
} {
  const groups = {
    high: [] as string[],
    medium: [] as string[],
    low: [] as string[],
  };
  for (const finding of view.findings ?? []) {
    const message = finding.message.trim() || "该项需要人工复核。";
    groups[finding.severity].push(message);
  }
  return groups;
}

function formatFindingLine(findings: readonly string[], fallback?: string): string {
  if (findings.length > 0) {
    return findings.slice(0, 3).map((item, index) => `${index + 1}. ${item}`).join("\n\n");
  }
  return fallback ?? "未发现该等级问题";
}

function appendReviewStatusBlock(card: DesignerCard, reviewStatus: string): void {
  const body = getCardBodyElements(card);
  if (!body) {
    return;
  }
  body.splice(1, 0, {
    tag: "markdown",
    content: `二审状态：${reviewStatus}`,
    text_align: "left",
    text_size: "normal_v2",
  });
}

function appendCitationDetailsBlock(card: DesignerCard, details: readonly LaborCitationDetailView[]): void {
  if (details.length === 0) {
    return;
  }
  const body = getCardBodyElements(card);
  if (!body) {
    return;
  }
  const insertIndex = Math.max(1, body.findIndex((element) => isRecord(element) && element.tag === "hr"));
  body.splice(insertIndex, 0, {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [{
      tag: "column",
      width: "weighted",
      background_style: "green-50",
      elements: [
        {
          tag: "markdown",
          content: `**已校验法条（${details.length}项）**`,
          text_align: "left",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px",
          icon: {
            tag: "standard_icon",
            token: "yes_outlined",
            color: "green",
          },
        },
        {
          tag: "markdown",
          content: details.slice(0, 5).map(formatCitationDetailText).join("\n\n"),
          text_align: "left",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px",
        },
      ],
      padding: "8px 8px 8px 8px",
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      margin: "0px 0px 0px 0px",
      weight: 1,
    }],
    margin: "0px 0px 0px 0px",
  });
}

function formatCitationDetailText(detail: LaborCitationDetailView): string {
  const label = detail.url ? `[${detail.label}](${detail.url})` : detail.label;
  return [
    `> **${label}**`,
    detail.excerpt ? `> ${detail.excerpt}` : "",
  ].filter(Boolean).join("\n");
}

function removeButtonByText(card: DesignerCard, label: string): void {
  removeDesignerCardElements(card, (element) => element.tag === "button"
    && isRecord(element.text)
    && element.text.content === label);
}

function hideReviewRiskSectionWhenEmpty(card: DesignerCard, titleKeyword: string, shouldHide: boolean): void {
  if (!shouldHide) {
    return;
  }
  while (removeColumnSetContainingMarkdown(card, titleKeyword)) {
    // 同一等级可能在模板中拆成标题与内容两块，需要全部移除，避免 0 项区块残留。
  }
}

function removeColumnSetContainingMarkdown(input: unknown, titleKeyword: string): boolean {
  if (Array.isArray(input)) {
    const index = input.findIndex((item) => isRecord(item) && containsMarkdown(item, titleKeyword));
    if (index >= 0) {
      input.splice(index, 1);
      return true;
    }
    return input.some((item) => removeColumnSetContainingMarkdown(item, titleKeyword));
  }
  if (!isRecord(input)) {
    return false;
  }
  return Object.values(input).some((value) => removeColumnSetContainingMarkdown(value, titleKeyword));
}

function containsMarkdown(input: unknown, keyword: string): boolean {
  if (Array.isArray(input)) {
    return input.some((item) => containsMarkdown(item, keyword));
  }
  if (!isRecord(input)) {
    return false;
  }
  if (input.tag === "markdown" && typeof input.content === "string" && input.content.includes(keyword)) {
    return true;
  }
  return Object.values(input).some((value) => containsMarkdown(value, keyword));
}

function findFirstColumnWithMarkdown(input: unknown, markdownContent: string): { elements: unknown[] } | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstColumnWithMarkdown(item, markdownContent);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(input)) {
    return null;
  }
  if (input.tag === "column" && Array.isArray(input.elements)
    && input.elements.some((element) => isRecord(element)
      && element.tag === "markdown"
      && element.content === markdownContent)) {
    return { elements: input.elements };
  }
  for (const value of Object.values(input)) {
    const found = findFirstColumnWithMarkdown(value, markdownContent);
    if (found) {
      return found;
    }
  }
  return null;
}

function findFirstColumnWithPlainText(input: unknown, textContent: string): { elements: unknown[] } | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstColumnWithPlainText(item, textContent);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(input)) {
    return null;
  }
  if (input.tag === "column" && Array.isArray(input.elements)
    && input.elements.some((element) => containsPlainTextIncluding(element, textContent))) {
    return { elements: input.elements };
  }
  for (const value of Object.values(input)) {
    const found = findFirstColumnWithPlainText(value, textContent);
    if (found) {
      return found;
    }
  }
  return null;
}

function containsPlainTextIncluding(input: unknown, textContent: string): boolean {
  if (Array.isArray(input)) {
    return input.some((item) => containsPlainTextIncluding(item, textContent));
  }
  if (!isRecord(input)) {
    return false;
  }
  if (input.tag === "plain_text" && typeof input.content === "string" && input.content.includes(textContent)) {
    return true;
  }
  return Object.values(input).some((value) => containsPlainTextIncluding(value, textContent));
}

function findElementParentByText(input: unknown, text: string): { parent: unknown[]; index: number } | null {
  if (Array.isArray(input)) {
    const index = input.findIndex((item) => elementHasExactText(item, text));
    if (index >= 0) {
      return { parent: input, index };
    }
    for (const item of input) {
      const found = findElementParentByText(item, text);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(input)) {
    return null;
  }
  for (const value of Object.values(input)) {
    const found = findElementParentByText(value, text);
    if (found) {
      return found;
    }
  }
  return null;
}

function elementHasExactText(input: unknown, text: string): boolean {
  if (!isRecord(input)) {
    return false;
  }
  if (input.tag === "markdown" && input.content === text) {
    return true;
  }
  return input.tag === "div" && isRecord(input.text) && input.text.content === text;
}

function removeColumnContainingPlainText(input: unknown, text: string): boolean {
  if (Array.isArray(input)) {
    const index = input.findIndex((item) => isRecord(item) && item.tag === "column" && containsPlainText(item, text));
    if (index >= 0) {
      input.splice(index, 1);
      return true;
    }
    return input.some((item) => removeColumnContainingPlainText(item, text));
  }
  if (!isRecord(input)) {
    return false;
  }
  return Object.values(input).some((value) => removeColumnContainingPlainText(value, text));
}

function containsPlainText(input: unknown, text: string): boolean {
  if (Array.isArray(input)) {
    return input.some((item) => containsPlainText(item, text));
  }
  if (!isRecord(input)) {
    return false;
  }
  if (input.tag === "plain_text" && input.content === text) {
    return true;
  }
  return Object.values(input).some((value) => containsPlainText(value, text));
}

function forEachDesignerChart(input: unknown, visitor: (chart: Record<string, unknown>) => void): void {
  if (Array.isArray(input)) {
    input.forEach((item) => forEachDesignerChart(item, visitor));
    return;
  }
  if (!isRecord(input)) {
    return;
  }
  if (input.tag === "chart") {
    visitor(input);
  }
  for (const value of Object.values(input)) {
    forEachDesignerChart(value, visitor);
  }
}

function cloneDesignerElement<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function removeDesignerElementsAroundMarkdown(card: DesignerCard, markdownContent: string, followingCount: number): void {
  const elements = getCardBodyElements(card);
  if (!elements) {
    return;
  }
  const index = elements.findIndex((element) => isRecord(element)
    && element.tag === "markdown"
    && element.content === markdownContent);
  if (index >= 0) {
    elements.splice(index, followingCount + 1);
  }
}

function getCardBodyElements(card: DesignerCard): unknown[] | null {
  const body = card.body;
  if (!isRecord(body) || !Array.isArray(body.elements)) {
    return null;
  }
  return body.elements;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
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
