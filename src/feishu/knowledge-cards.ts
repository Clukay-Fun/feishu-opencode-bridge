/**
 * 职责: 构建知识库模块使用的飞书卡片。
 * 关注点:
 * - 覆盖查询结果、摄入进度、摄入摘要等展示场景。
 * - 复用共享卡片原语组织统计、步骤和引用信息。
 */
import type { KnowledgeIngestResult, KnowledgeQueryResult } from "../knowledge/index.js";
import { buildDesignerCardPayload, type DesignerCard } from "./designer-card-renderer.js";
import {
  type FeishuPostPayload,
  type ToolUpdateView,
} from "./shared-primitives.js";

export type KnowledgeQueryEmptyCardView = {
  question: string;
};

export type KnowledgeIngestProgressCardView = {
  sourceLabel: string;
  steps: ReadonlyArray<ToolUpdateView>;
  startedAt?: number | undefined;
  elapsedMs?: number | undefined;
  completedCount?: number | undefined;
  failedCount?: number | undefined;
  queuedLabels?: readonly string[] | undefined;
  completedItems?: ReadonlyArray<{ sourceFile: string; extractedCount?: number | undefined; elapsedMs?: number | undefined }> | undefined;
  failedItems?: ReadonlyArray<{ sourceFile: string; reason: string; elapsedMs?: number | undefined }> | undefined;
};

export type KnowledgeIngestQueuedCardView = {
  sourceLabel: string;
  queuedAhead: number;
  steps?: ReadonlyArray<ToolUpdateView> | undefined;
  startedAt?: number | undefined;
  elapsedMs?: number | undefined;
};

export type KnowledgeIngestFailureCardView = {
  sourceLabel: string;
  reason: string;
  suggestion?: string | undefined;
  steps?: ReadonlyArray<ToolUpdateView> | undefined;
  elapsedMs?: number | undefined;
};

export type KnowledgeIngestCompletedCardView = {
  completedCount: number;
  failedCount: number;
  queuedCount: number;
  currentLabel?: string | undefined;
  totalExtractedCount: number;
  totalDedupedCount: number;
  elapsedMs?: number | undefined;
  bitableUrl?: string | undefined;
  results?: KnowledgeIngestResult[] | undefined;
  failures?: Array<{ sourceFile: string; reason: string }> | undefined;
};

// #region 知识查询卡片

/** 构建知识查询命中结果卡。 */
export function buildKnowledgeQueryPayload(view: KnowledgeQueryResult): FeishuPostPayload {
  const results = view.results.slice(0, Math.max(1, view.results.length));
  const tags = uniqueKnowledgeTags(results).slice(0, 2);
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      style: {
        text_size: {
          normal_v2: {
            default: "normal",
            pc: "normal",
            mobile: "heading",
          },
        },
      },
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      elements: [
        questionBlock(view.question),
        { tag: "hr", margin: "0px 0px 0px 0px" },
        ...results.flatMap((result, index) => answerBlock(result, index, index < results.length - 1)),
      ],
    },
    header: {
      title: {
        tag: "plain_text",
        content: "法律咨询",
      },
      subtitle: {
        tag: "plain_text",
        content: "",
      },
      text_tag_list: [
        {
          tag: "text_tag",
          text: {
            tag: "plain_text",
            content: `${results.length} 条答案`,
          },
          color: "purple",
        },
        ...tags.map((tag) => ({
          tag: "text_tag",
          text: {
            tag: "plain_text",
            content: tag,
          },
          color: "blue",
        })),
      ],
      template: "indigo",
      icon: {
        tag: "standard_icon",
        token: "efficiency_outlined",
      },
      padding: "12px 8px 12px 12px",
    },
  };
  return {
    msg_type: "interactive",
    content: JSON.stringify(card),
  };
}

/** 构建知识查询未命中卡。 */
export function buildKnowledgeQueryEmptyPayload(view: KnowledgeQueryEmptyCardView): FeishuPostPayload {
  return buildDesignerCardPayload("法律咨询-无结果", [
    { from: "xxx", to: view.question },
  ]);
}

// #endregion

// #region 知识入库卡片

/** 构建“已进入知识入库模式”提示卡。 */
export function buildKnowledgeIngestReadyPayload(allowedExtensions: readonly string[] = [".pdf", ".docx", ".txt", ".md"]): FeishuPostPayload {
  const supported = allowedExtensions.map((extension) => extension.replace(/^\./, "").toUpperCase()).join(" ▪ ");
  return {
    msg_type: "interactive",
    content: JSON.stringify({
      schema: "2.0",
      config: { update_multi: true },
      body: {
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        elements: [
          {
            tag: "column_set",
            flex_mode: "stretch",
            horizontal_spacing: "12px",
            horizontal_align: "left",
            columns: [{
              tag: "column",
              width: "weighted",
              background_style: "blue-50",
              elements: [{
                tag: "markdown",
                content: `**支持格式** ：${supported}\n**模式** ：批量入库`,
                text_align: "left",
                text_size: "normal",
              }],
              padding: "8px 8px 8px 8px",
              direction: "vertical",
              horizontal_spacing: "8px",
              vertical_spacing: "4px",
              horizontal_align: "left",
              vertical_align: "top",
              margin: "0px 0px 0px 0px",
              weight: 1,
            }],
            margin: "0px 0px 0px 0px",
          },
          {
            tag: "markdown",
            content: "发送文件或 URL 即可入库",
            text_align: "left",
            text_size: "normal",
          },
          { tag: "hr", margin: "0px 0px 0px 0px" },
          {
            tag: "markdown",
            content: "> 发送 `知识入库完成` 结束本次任务",
            text_align: "left",
            text_size: "notation",
            margin: "0px 0px 0px 0px",
          },
        ],
      },
      header: {
        title: { tag: "plain_text", content: "知识入库已开启" },
        subtitle: { tag: "plain_text", content: "" },
        template: "blue",
        icon: { tag: "standard_icon", token: "status-vacation_filled" },
        padding: "12px 8px 12px 12px",
      },
    }),
  };
}

/** 构建知识入库完成卡。 */
export function buildKnowledgeIngestCompletedPayload(view: KnowledgeIngestCompletedCardView): FeishuPostPayload {
  const results = view.results ?? [];
  const failures = view.failures ?? [];
  const rawExtractedCount = summarizeKnowledgeIngestRawExtractedCount(results, view);
  const tagCounts = summarizeKnowledgeIngestTags(results);
  const completionState = resolveKnowledgeCompletedState(view);
  return buildDesignerCardPayload("知识入库完成", [
    { from: "知识入库完成", to: completionState.title },
    { from: "提取 47", to: `提取 ${rawExtractedCount}` },
    { from: "去重 22", to: `去重 ${view.totalDedupedCount}` },
    { from: "入库 63", to: `入库 ${view.totalExtractedCount}` },
    { from: "耗时 34s", to: `耗时 ${formatShortDuration(view.elapsedMs)}` },
  ], (card) => {
    updateKnowledgeCompletedHeader(card, completionState);
    updateKnowledgeCompletedChart(card, tagCounts);
    replaceKnowledgeCompletedMaterialRows(card, results, failures);
    configureKnowledgeCompletedButton(card, view.completedCount > 0 ? view.bitableUrl : undefined);
  });
}

/** 构建入库排队提示卡。 */
export function buildKnowledgeIngestQueuedPayload(view: KnowledgeIngestQueuedCardView): FeishuPostPayload {
  return buildKnowledgeIngestStatusPayload({
    title: "知识入库排队中",
    template: "blue",
    iconToken: "time_outlined",
    tagText: `前方 ${view.queuedAhead}`,
    elements: [
      sectionTitle("排队中"),
      fileRow(`待处理：${view.sourceLabel}`, "pending"),
      sectionTitle("流程步骤"),
      knowledgeFlowStepsBlock(view.sourceLabel, view.steps ?? createQueuedKnowledgeSteps()),
      mutedLine(view.queuedAhead > 0 ? `前方还有 ${view.queuedAhead} 个素材，稍后自动处理。` : "已加入队列，稍后自动处理。"),
    ],
  });
}

/** 构建入库失败卡。 */
export function buildKnowledgeIngestFailurePayload(view: KnowledgeIngestFailureCardView): FeishuPostPayload {
  return buildKnowledgeIngestStatusPayload({
    title: "知识入库失败",
    template: "red",
    iconToken: "error_filled",
    tagText: formatShortDuration(view.elapsedMs),
    elements: [
      sectionTitle("失败素材"),
      fileRow(`失败：${view.sourceLabel}${formatInlineElapsed(view.elapsedMs)}`, "error"),
      sectionTitle("流程步骤"),
      knowledgeFlowStepsBlock(view.sourceLabel, view.steps ?? createFailedKnowledgeSteps(view.reason)),
      reasonBlock(view.reason),
      mutedLine(view.suggestion ?? "请检查文件是否可读取；确认后可重新发起知识入库。"),
    ],
  });
}

/** 构建入库处理中卡。 */
export function buildKnowledgeIngestProcessingPayload(view: KnowledgeIngestProgressCardView): FeishuPostPayload {
  const completedCount = view.completedCount ?? view.completedItems?.length ?? 0;
  const failedCount = view.failedCount ?? view.failedItems?.length ?? 0;
  const queuedCount = view.queuedLabels?.length ?? 0;
  const elements: Record<string, unknown>[] = [
    metricColumns([
      { label: `已完成 ${completedCount}`, color: "green-50" },
      { label: "处理中 1", color: "blue-50" },
      { label: `排队中 ${queuedCount}`, color: "grey-50" },
      { label: `失败 ${failedCount}`, color: failedCount > 0 ? "red-50" : "grey-50" },
    ]),
    sectionTitle("当前处理"),
    knowledgeFlowStepsBlock(view.sourceLabel, view.steps),
  ];
  if ((view.queuedLabels?.length ?? 0) > 0) {
    elements.push(sectionTitle("排队中"));
    elements.push(...(view.queuedLabels ?? []).map((label) => fileRow(`待处理：${label}`, "pending")));
  }
  if ((view.completedItems?.length ?? 0) + (view.failedItems?.length ?? 0) > 0) {
    elements.push({ tag: "hr", margin: "0px 0px 0px 0px" });
  }
  if ((view.completedItems?.length ?? 0) > 0) {
    elements.push(sectionTitle("已完成"));
    elements.push(...(view.completedItems ?? []).map((item) => fileRow(formatCompletedIngestItem(item), "completed")));
  }
  if ((view.failedItems?.length ?? 0) > 0) {
    elements.push(sectionTitle("失败"));
    elements.push(...(view.failedItems ?? []).map((item) => fileRow(formatFailedIngestItem(item), "error")));
  }
  elements.push({ tag: "hr", margin: "0px 0px 0px 0px" });
  elements.push(mutedLine("生成内容仅供参考，入库后仍需人工复核。"));
  return buildKnowledgeIngestStatusPayload({
    title: "知识入库进行中",
    template: "blue",
    iconToken: "loading_outlined",
    tagText: `已处理 ${completedCount + failedCount}/${completedCount + failedCount + queuedCount + 1}`,
    elements,
  });
}

// #endregion

type KnowledgeQueryAnswer = KnowledgeQueryResult["results"][number];

function questionBlock(question: string): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    horizontal_align: "left",
    columns: [{
      tag: "column",
      width: "weighted",
      background_style: "grey-50",
      elements: [
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: "问题",
            text_size: "notation",
            text_align: "left",
            text_color: "grey",
          },
          margin: "0px 0px 0px 0px",
        },
        {
          tag: "markdown",
          content: `\n${question}`,
          text_align: "left",
          text_size: "normal_v2",
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
  };
}

function answerBlock(result: KnowledgeQueryAnswer, index: number, withDivider: boolean): Record<string, unknown>[] {
  return [
    {
      tag: "column_set",
      flex_mode: "stretch",
      horizontal_spacing: "12px",
      horizontal_align: "left",
      columns: [{
        tag: "column",
        width: "weighted",
        elements: [
          answerLabel(index),
          {
            tag: "column_set",
            horizontal_spacing: "8px",
            horizontal_align: "left",
            columns: [{
              tag: "column",
              width: "weighted",
              elements: [{
                tag: "markdown",
                content: formatAnswerParagraphs(result.answer),
                text_align: "left",
                text_size: "normal_v2",
                margin: "0px 0px 0px 0px",
              }],
              padding: "0px 0px 0px 0px",
              direction: "vertical",
              horizontal_spacing: "8px",
              vertical_spacing: "8px",
              horizontal_align: "left",
              vertical_align: "top",
              margin: index === 0 ? "8px 0px 8px 0px" : "12px 0px 12px 0px",
              weight: 1,
            }],
            margin: "0px 0px 0px 0px",
          },
          {
            tag: "markdown",
            content: formatKnowledgeReference(result),
            text_align: "left",
            text_size: "notation",
            margin: "0px 0px 0px 0px",
          },
          ...(withDivider ? [{ tag: "hr", margin: "0px 0px 0px 0px" }] : []),
        ],
        padding: "0px 0px 0px 0px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "4px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      }],
      margin: "4px 0px 0px 0px",
    },
  ];
}

function answerLabel(index: number): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [{
      tag: "column",
      width: "auto",
      background_style: "blue-50",
      elements: [{
        tag: "markdown",
        content: `答案 ${index + 1}`,
        text_align: "left",
        text_size: "notation",
        margin: "0px 0px 0px 0px",
      }],
      padding: "4px 8px 4px 8px",
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      margin: "0px 0px 0px 0px",
    }],
    margin: "0px 0px 0px 0px",
  };
}

function formatKnowledgeReference(result: KnowledgeQueryAnswer): string {
  const sourceText = [result.sourceFile, result.pageSection].filter(Boolean).join(" · ") || "知识库记录";
  const source = result.sourceUrl ? markdownLink(sourceText, result.sourceUrl) : sourceText;
  const statuteText = result.statute ?? "未标注";
  const statute = result.statuteUrl ? markdownLink(statuteText, result.statuteUrl) : statuteText;
  return `> 来源：${source}\n> 法条：${statute}`;
}

function formatAnswerParagraphs(answer: string): string {
  const normalized = answer.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "暂无答案";
  }
  const orderedMarker = "(?:（\\d+）|\\(\\d+\\)|[0-9]+[.、．]|[①②③④⑤⑥⑦⑧⑨⑩]|第[一二三四五六七八九十]+[，、.．])";
  return normalized
    .replace(new RegExp(`(?!^)\\s*(${orderedMarker})`, "g"), "\n$1")
    .replace(/。(?=国家层面规定|实际工作|医疗期从|但地方法规|例如|此外|同时|用人单位|劳动者|根据|需要)/g, "。\n")
    .replace(/；(?=(?:实际工作|[0-9一二三四五六七八九十百千万]+年以上|[0-9一二三四五六七八九十百千万]+个月|同一|此外))/g, "；\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function uniqueKnowledgeTags(results: readonly KnowledgeQueryAnswer[]): string[] {
  const tags = new Set<string>();
  for (const result of results) {
    for (const tag of result.tags) {
      const normalized = tag.trim();
      if (normalized) {
        tags.add(normalized);
      }
    }
  }
  return [...tags];
}

function markdownLink(text: string, url: string): string {
  return `[${text.replace(/[[\]]/g, "")}](${url})`;
}

function metricColumns(metrics: Array<{ label: string; color: string }>): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "trisect",
    horizontal_spacing: "12px",
    horizontal_align: "left",
    columns: metrics.map((metric) => ({
      tag: "column",
      width: "weighted",
      background_style: metric.color,
      elements: [{
        tag: "markdown",
        content: metric.label,
        text_align: "center",
        text_size: "heading",
      }],
      padding: "12px 12px 12px 12px",
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "4px",
      horizontal_align: "center",
      vertical_align: "center",
      margin: "0px 0px 0px 0px",
      weight: 1,
    })),
    margin: "0px 0px 0px 0px",
  };
}

function updateKnowledgeCompletedChart(card: DesignerCard, tagCounts: Record<string, number>): void {
  const chart = findFirstDesignerElement(card, (element) => element.tag === "chart");
  if (!chart || !isRecord(chart.chart_spec)) {
    return;
  }
  const values = Object.entries(tagCounts)
    .filter(([, value]) => value > 0)
    .map(([tag, value]) => ({ tag, value }));
  const chartSpec = chart.chart_spec;
  chartSpec.data = {
    values: values.length > 0 ? values : [{ tag: "暂无标签", value: 1 }],
  };
}

function resolveKnowledgeCompletedState(view: KnowledgeIngestCompletedCardView): {
  title: string;
  template: string;
  iconToken: string;
  iconColor: string;
} {
  if (view.completedCount === 0 && view.failedCount > 0) {
    return {
      title: "知识入库失败",
      template: "red",
      iconToken: "error_filled",
      iconColor: "red",
    };
  }
  if (view.failedCount > 0) {
    return {
      title: "知识入库部分完成",
      template: "yellow",
      iconToken: "maybe_outlined",
      iconColor: "orange",
    };
  }
  return {
    title: "知识入库完成",
    template: "green",
    iconToken: "yes_filled",
    iconColor: "green",
  };
}

function updateKnowledgeCompletedHeader(
  card: DesignerCard,
  state: { template: string; iconToken: string; iconColor: string },
): void {
  if (!isRecord(card.header)) {
    return;
  }
  card.header.template = state.template;
  const icon = card.header.icon;
  if (isRecord(icon)) {
    icon.token = state.iconToken;
    icon.color = state.iconColor;
  }
}

function replaceKnowledgeCompletedMaterialRows(
  card: DesignerCard,
  results: KnowledgeIngestResult[],
  failures: Array<{ sourceFile: string; reason: string }>,
): void {
  const elements = getDesignerBodyElements(card);
  if (!elements) {
    return;
  }
  const startIndex = elements.findIndex((element) => containsDesignerText(element, "经济补偿计算规则.docx")
    || containsDesignerText(element, "损坏文件.docx"));
  if (startIndex < 0) {
    return;
  }
  const buttonIndex = elements.findIndex((element, index) => index > startIndex && element.tag === "button");
  const endIndex = buttonIndex >= 0 ? buttonIndex : elements.length;
  const rows = [
    ...results.map(knowledgeCompletedSuccessRow),
    ...failures.map(knowledgeCompletedFailureRow),
    { tag: "hr", margin: "0px 0px 0px 0px" },
  ];
  elements.splice(startIndex, endIndex - startIndex, ...rows);
}

function configureKnowledgeCompletedButton(card: DesignerCard, bitableUrl: string | undefined): void {
  const elements = getDesignerBodyElements(card);
  const buttonIndex = elements?.findIndex((element) => element.tag === "button"
    && isRecord(element.text)
    && element.text.content === "查看知识库") ?? -1;
  if (!elements || buttonIndex < 0) {
    return;
  }
  if (!bitableUrl) {
    elements.splice(buttonIndex, 1);
    const previous = elements[buttonIndex - 1];
    if (isRecord(previous) && previous.tag === "hr") {
      elements.splice(buttonIndex - 1, 1);
    }
    return;
  }
  const button = elements[buttonIndex];
  if (!button) {
    return;
  }
  button.url = bitableUrl;
  button.value = {
    kind: "knowledge-ingest-action",
    action: "open-knowledge-base",
    url: bitableUrl,
  };
}

function knowledgeCompletedSuccessRow(result: KnowledgeIngestResult): Record<string, unknown> {
  const rawExtractedCount = result.rawExtractedCount ?? result.extractedCount;
  const dedupedCount = result.dedupedCount ?? Math.max(0, rawExtractedCount - result.extractedCount);
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [markdownElement(`**${result.sourceFile}**`, {
          token: "yes_outlined",
          color: "green",
        })],
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
      },
      knowledgeCompletedBadge(`提取 ${rawExtractedCount}`),
      knowledgeCompletedBadge(`去重 ${dedupedCount}`),
      knowledgeCompletedBadge(`入库 ${result.extractedCount}`),
    ],
    margin: "0px 0px 0px 0px",
  };
}

function knowledgeCompletedFailureRow(failure: { sourceFile: string; reason: string }): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [markdownElement(failure.sourceFile, {
          token: "more-close_outlined",
          color: "red",
        })],
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
      },
      {
        tag: "column",
        width: "auto",
        elements: [{
          tag: "div",
          text: {
            tag: "plain_text",
            content: failure.reason,
            text_size: "notation",
            text_align: "left",
            text_color: "red",
          },
          margin: "0px 0px 0px 0px",
        }],
        padding: "0px 0px 0px 0px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "center",
        vertical_align: "center",
        margin: "0px 0px 0px 0px",
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function knowledgeCompletedBadge(content: string): Record<string, unknown> {
  return {
    tag: "column",
    width: "auto",
    background_style: "grey-50",
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content,
        text_size: "notation",
        text_align: "left",
        text_color: "grey",
      },
      margin: "0px 0px 0px 0px",
    }],
    padding: "0px 4px 0px 4px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: "8px",
    horizontal_align: "center",
    vertical_align: "center",
    margin: "0px 0px 0px 0px",
  };
}

function getDesignerBodyElements(card: DesignerCard): Record<string, unknown>[] | null {
  if (!isRecord(card.body)) {
    return null;
  }
  const elements = card.body.elements;
  return Array.isArray(elements) && elements.every(isRecord) ? elements : null;
}

function findFirstDesignerElement(
  input: unknown,
  predicate: (element: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstDesignerElement(item, predicate);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(input)) {
    return null;
  }
  if (predicate(input)) {
    return input;
  }
  for (const value of Object.values(input)) {
    const found = findFirstDesignerElement(value, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function containsDesignerText(input: unknown, text: string): boolean {
  if (typeof input === "string") {
    return input.includes(text);
  }
  if (Array.isArray(input)) {
    return input.some((item) => containsDesignerText(item, text));
  }
  if (!isRecord(input)) {
    return false;
  }
  return Object.values(input).some((value) => containsDesignerText(value, text));
}

function markdownElement(content: string, icon: { token: string; color: string }): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
    text_align: "left",
    text_size: "normal_v2",
    icon: {
      tag: "standard_icon",
      token: icon.token,
      color: icon.color,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildKnowledgeIngestStatusPayload(input: {
  title: string;
  template: string;
  iconToken: string;
  tagText?: string | undefined;
  elements: Record<string, unknown>[];
}): FeishuPostPayload {
  return {
    msg_type: "interactive",
    content: JSON.stringify({
      schema: "2.0",
      config: { update_multi: true },
      body: {
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        elements: input.elements,
      },
      header: {
        title: { tag: "plain_text", content: input.title },
        subtitle: { tag: "plain_text", content: "" },
        ...(input.tagText
          ? {
            text_tag_list: [{
              tag: "text_tag",
              text: { tag: "plain_text", content: input.tagText },
              color: input.template === "red" ? "red" : input.template === "green" ? "green" : "blue",
            }],
          }
          : {}),
        template: input.template,
        icon: { tag: "standard_icon", token: input.iconToken },
        padding: "12px 8px 12px 12px",
      },
    }),
  };
}

function knowledgeFlowStepsBlock(sourceLabel: string, steps: ReadonlyArray<ToolUpdateView>): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [{
      tag: "column",
      width: "weighted",
      background_style: "blue-50",
      elements: [
        {
          tag: "markdown",
          content: `**${sourceLabel}**`,
          text_align: "left",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px",
        },
        ...steps.map((step) => stepRow(`${step.label}：${formatKnowledgeStepDetail(step)}`, step.status)),
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
  };
}

function createQueuedKnowledgeSteps(): ToolUpdateView[] {
  return [
    { label: "读取内容", detail: "等待中", status: "pending" },
    { label: "提取问答", detail: "等待中", status: "pending" },
    { label: "写入知识库", detail: "等待中", status: "pending" },
  ];
}

function createFailedKnowledgeSteps(reason: string): ToolUpdateView[] {
  return [
    { label: "读取内容", detail: reason, status: "error" },
    { label: "提取问答", detail: "未执行", status: "pending" },
    { label: "写入知识库", detail: "未执行", status: "pending" },
  ];
}

function sectionTitle(text: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content: `**${text}**`,
    text_align: "left",
    text_size: "normal_v2",
    margin: "0px 0px 0px 0px",
  };
}

function fileRow(text: string, status: "pending" | "completed" | "error"): Record<string, unknown> {
  const icon = status === "completed"
    ? { token: "yes_outlined", color: "green" }
    : status === "error"
      ? { token: "error_filled", color: "red" }
      : { token: "time_outlined", color: "grey" };
  return {
    tag: "markdown",
    content: text,
    text_align: "left",
    text_size: "normal_v2",
    margin: "0px 0px 0px 0px",
    icon: { tag: "standard_icon", token: icon.token, color: icon.color },
  };
}

function stepRow(text: string, status: ToolUpdateView["status"]): Record<string, unknown> {
  const icon = status === "completed"
    ? { token: "yes_outlined", color: "green" }
    : status === "error"
      ? { token: "error_filled", color: "red" }
      : status === "running"
        ? { token: "loading_outlined", color: "blue" }
        : { token: "time_outlined", color: "grey" };
  return {
    tag: "markdown",
    content: text,
    text_align: "left",
    text_size: "normal_v2",
    margin: "0px 0px 0px 0px",
    icon: { tag: "standard_icon", token: icon.token, color: icon.color },
  };
}

function reasonBlock(reason: string): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [{
      tag: "column",
      width: "weighted",
      background_style: "red-50",
      elements: [{
        tag: "markdown",
        content: `**失败原因**\n${reason}`,
        text_align: "left",
        text_size: "normal_v2",
        margin: "0px 0px 0px 0px",
      }],
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
  };
}

function mutedLine(text: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content: `> ${text}`,
    text_align: "left",
    text_size: "notation",
    margin: "0px 0px 0px 0px",
  };
}

function formatKnowledgeStepDetail(step: ToolUpdateView): string {
  const detail = step.detail.trim();
  if (!detail || detail === "等待开始") {
    switch (step.status) {
      case "completed":
        return "已完成";
      case "running":
        return "进行中";
      case "error":
        return "失败";
      default:
        return "等待中";
    }
  }
  return detail;
}

function formatCompletedIngestItem(item: { sourceFile: string; extractedCount?: number | undefined; elapsedMs?: number | undefined }): string {
  const extracted = typeof item.extractedCount === "number" ? `｜入库 ${item.extractedCount} 条` : "";
  return `已完成：${item.sourceFile}${extracted}${formatInlineElapsed(item.elapsedMs)}`;
}

function formatFailedIngestItem(item: { sourceFile: string; reason: string; elapsedMs?: number | undefined }): string {
  return `失败：${item.sourceFile}${formatInlineElapsed(item.elapsedMs)}｜${item.reason}`;
}

function formatInlineElapsed(elapsedMs: number | undefined): string {
  return typeof elapsedMs === "number" && elapsedMs >= 0 ? `｜耗时 ${formatShortDuration(elapsedMs)}` : "";
}

function summarizeKnowledgeIngestTags(results: KnowledgeIngestResult[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const [tag, count] of Object.entries(result.tagCounts ?? {})) {
      if (count > 0) {
        counts.set(tag, (counts.get(tag) ?? 0) + count);
      }
    }
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

function formatShortDuration(elapsedMs: number | undefined): string {
  if (typeof elapsedMs !== "number" || elapsedMs <= 0) {
    return "0s";
  }
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain > 0 ? `${minutes}m${remain}s` : `${minutes}m`;
}

function summarizeKnowledgeIngestRawExtractedCount(
  results: KnowledgeIngestResult[],
  fallback: Pick<KnowledgeIngestCompletedCardView, "totalExtractedCount" | "totalDedupedCount">,
): number {
  if (results.length === 0) {
    return fallback.totalExtractedCount + fallback.totalDedupedCount;
  }
  return results.reduce((total, result) => {
    const rawExtractedCount = result.rawExtractedCount ?? result.extractedCount;
    return total + rawExtractedCount;
  }, 0);
}
