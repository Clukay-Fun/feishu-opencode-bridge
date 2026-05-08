/**
 * 职责: 构建知识库模块使用的飞书卡片。
 * 关注点:
 * - 覆盖查询结果、摄入进度、摄入摘要等展示场景。
 * - 复用共享卡片原语组织统计、步骤和引用信息。
 */
import type { KnowledgeIngestResult, KnowledgeQueryResult } from "../knowledge/index.js";
import { column, columnSet } from "./card-builder.js";
import {
  buildDivider,
  buildElapsedLine,
  buildGreyPanel,
  buildInteractivePayload,
  buildNoticeBodyBlock,
  buildQuoteLine,
  buildStatsRow,
  buildTagChartSection,
  buildTitleLine,
  cardMarkdown,
  escapeText,
  formatDurationMs,
  resolveElapsedText,
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
  completedItems?: ReadonlyArray<{ sourceFile: string; extractedCount?: number | undefined }> | undefined;
  failedItems?: ReadonlyArray<{ sourceFile: string; reason: string }> | undefined;
};

export type KnowledgeIngestQueuedCardView = {
  sourceLabel: string;
  queuedAhead: number;
  startedAt?: number | undefined;
  elapsedMs?: number | undefined;
};

export type KnowledgeIngestFailureCardView = {
  sourceLabel: string;
  reason: string;
  suggestion?: string | undefined;
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
  return buildInteractivePayload({
    title: "法律咨询",
    template: "indigo",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(`**问题**\n${escapeText(view.question)}`, "search_outlined", "indigo", { showIcon: false }),
      buildDivider(),
      ...view.results.flatMap((result, index) => buildKnowledgeQueryResultBlocks(view, result, index)),
      ...(view.bitableUrl ? [buildDivider(), buildKnowledgeQueryActionBlock(view)] : []),
    ],
  });
}

/** 构建知识查询未命中卡。 */
export function buildKnowledgeQueryEmptyPayload(view: KnowledgeQueryEmptyCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "法律咨询",
    template: "grey",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(`未找到与“${escapeText(view.question)}”直接相关的知识条目。`, "info_outlined", "grey", { showIcon: false }),
      buildDivider(),
      buildQuoteLine("以上内容仅供参考，不构成法律意见。"),
    ],
  });
}

// #endregion

// #region 知识入库卡片

/** 构建“已进入知识入库模式”提示卡。 */
export function buildKnowledgeIngestReadyPayload(): FeishuPostPayload {
  return buildInteractivePayload({
    title: "知识入库已开启",
    template: "indigo",
    iconToken: "status-meeting_filled",
    bodyElements: [
      buildGreyPanel([
        cardMarkdown("**支持格式** ：PDF / DOCX / TXT / MD / PNG / JPG / WEBP\n**模式** ：批量入库", "normal"),
      ]),
      buildDivider(),
      buildGreyPanel([
        cardMarkdown("发送文件或 URL 即可入库", "normal"),
        cardMarkdown("发送 `/kb-ingest-end` 结束本次任务", "notation"),
      ]),
    ],
  });
}

/** 构建知识入库完成卡。 */
export function buildKnowledgeIngestCompletedPayload(view: KnowledgeIngestCompletedCardView): FeishuPostPayload {
  const results = view.results ?? [];
  const failures = view.failures ?? [];
  const tagCounts = summarizeKnowledgeIngestTagCounts(results);
  const rawExtractedCount = summarizeKnowledgeIngestRawExtractedCount(results, view);
  const sourceLabel = resolveKnowledgeIngestFinalSourceLabel(results, failures);
  const bodyElements = buildKnowledgeIngestCompletionBodyElements({
    sourceLabel,
    materialCount: results.length + failures.length,
    successCount: view.completedCount,
    failedCount: view.failedCount,
    extractedCount: view.totalExtractedCount,
    rawExtractedCount,
    dedupedCount: view.totalDedupedCount,
    tagCounts,
    bitableUrl: view.bitableUrl,
    elapsedMs: view.elapsedMs,
  });

  return buildInteractivePayload({
    title: "知识入库完成",
    template: "green",
    iconToken: "yes_filled",
    bodyElements,
  });
}

/** 构建入库排队提示卡。 */
export function buildKnowledgeIngestQueuedPayload(view: KnowledgeIngestQueuedCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "知识入库排队中",
    template: "orange",
    iconToken: "time_outlined",
    bodyElements: [
      buildTitleLine(`排队文件：**${escapeText(view.sourceLabel)}**`),
      buildGreyPanel([
        cardMarkdown(`**前方队列**：${view.queuedAhead} 个素材`, "normal"),
        cardMarkdown("**预计开始**：前序处理完成后自动执行", "normal"),
      ]),
      buildQuoteLine("发送 /kb-ingest-end 提前结束入库"),
      buildDivider(),
      buildElapsedLine(resolveElapsedText(view)),
    ],
  });
}

/** 构建入库失败卡。 */
export function buildKnowledgeIngestFailurePayload(view: KnowledgeIngestFailureCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "入库失败",
    template: "red",
    iconToken: "error-hollow_filled",
    bodyElements: [
      buildTitleLine(`文件：**${escapeText(view.sourceLabel)}**`),
      buildGreyPanel([
        cardMarkdown(`**原因**：${escapeText(view.reason)}`, "normal_v2"),
        cardMarkdown(`**建议**：${escapeText(view.suggestion ?? "请检查文件是否损坏或重新上传")}`, "normal_v2"),
      ], { padding: "4px 4px 4px 4px" }),
    ],
  });
}

/** 构建入库处理中卡。 */
export function buildKnowledgeIngestProcessingPayload(view: KnowledgeIngestProgressCardView): FeishuPostPayload {
  const completedCount = view.completedCount ?? view.completedItems?.length ?? 0;
  const failedCount = view.failedCount ?? view.failedItems?.length ?? 0;
  const queuedCount = view.queuedLabels?.length ?? 0;
  return buildInteractivePayload({
    title: "知识入库进行中",
    subtitle: `${completedCount}/${completedCount + failedCount + queuedCount + 1} 已完成`,
    template: "indigo",
    iconToken: "start_outlined",
    bodyElements: [
      cardMarkdown("**当前处理**", "normal_v2"),
      buildKnowledgeIngestCurrentProcessingBlock(view),
      ...(queuedCount > 0
        ? [
          cardMarkdown("**排队中**", "normal_v2"),
          ...view.queuedLabels!.map((label) => buildKnowledgeIngestMaterialRow(label, "排队中", "queued")),
        ]
        : []),
      ...(completedCount > 0
        ? [
          buildDivider(),
          cardMarkdown("**已完成**", "normal_v2"),
          ...buildKnowledgeIngestCompletedRows(view.completedItems ?? []),
        ]
        : []),
      ...buildKnowledgeIngestFailureRows(view.failedItems ?? []),
      buildDivider(),
      buildElapsedLine(resolveElapsedText(view)),
    ],
  });
}

// #endregion

function buildKnowledgeQueryResultBlocks(
  view: KnowledgeQueryResult,
  result: KnowledgeQueryResult["results"][number],
  index: number,
): Array<Record<string, unknown>> {
  const sourceLabel = `${escapeText(result.sourceFile)}${result.pageSection ? ` · ${escapeText(result.pageSection)}` : ""}`;
  const sourceRecordUrl = buildKnowledgeRecordUrl(view.bitableUrl, result.bitableRecordId);
  const sourceText = sourceRecordUrl
    ? `📄 来源：[打开知识库记录｜${sourceLabel}](${escapeText(sourceRecordUrl)})`
    : `📄 来源：${sourceLabel}`;
  const quoteLines = [
    sourceText,
    result.statute ? `🏛 法条：${escapeText(result.statute)}` : "",
    "以上内容仅供参考，不构成法律意见。",
  ].filter(Boolean);
  return [
    buildNoticeBodyBlock(`**答案 ${index + 1}**\n${escapeText(result.answer)}`, "book_outlined", "blue", { showIcon: false }),
    buildQuoteLine(quoteLines.join("\n")),
    ...(index < view.results.length - 1 ? [buildDivider()] : []),
  ];
}

function buildKnowledgeQueryActionBlock(view?: Pick<KnowledgeQueryResult, "bitableUrl">): Record<string, unknown> {
  const buttons = [
    ...(view?.bitableUrl ? [buildKnowledgeActionButton("查看知识库", "default", {
      kind: "knowledge-query-action",
      action: "open-knowledge-base",
      url: view.bitableUrl,
    })] : []),
  ];
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [button],
      vertical_align: "top",
    })),
    margin: "0px 0px 0px 0px",
  };
}

function buildKnowledgeActionButton(
  label: string,
  type: "primary" | "default",
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: label,
    },
    type,
    width: type === "primary" ? "fill" : "default",
    size: "medium",
    margin: "0px 0px 0px 0px",
    value,
  };
}

function buildKnowledgeIngestCurrentProcessingBlock(view: KnowledgeIngestProgressCardView): Record<string, unknown> {
  return {
    ...buildGreyPanel([
      cardMarkdown(`处理文件：**${escapeText(view.sourceLabel)}**`, "heading"),
      ...view.steps.map((step) => cardMarkdown(formatKnowledgeIngestStepLine(step), "normal_v2")),
    ]),
    background_style: "blue-50",
  };
}

function formatKnowledgeIngestStepLine(step: ToolUpdateView): string {
  const label = step.status === "error" && step.label === "写入知识库" ? "写入失败" : step.label;
  const detail = step.status === "error" ? `${step.detail}（发送 /retry 重试）` : step.detail;
  const prefix = step.status === "completed"
    ? "✓"
    : step.status === "running"
      ? "⟳"
      : step.status === "error"
        ? "×"
        : "○";
  return `${prefix} ${escapeText(label)}：${escapeText(detail)}`;
}

function buildKnowledgeIngestMaterialRow(
  sourceLabel: string,
  statusText: string,
  status: "running" | "queued" | "completed" | "failed",
): Record<string, unknown> {
  const bg = status === "running" ? "blue-50" : status === "failed" ? "red-50" : "grey-50";
  const marker = status === "completed" ? "✓" : status === "failed" ? "×" : status === "running" ? "⟳" : "○";
  return columnSet([
    column([
      cardMarkdown(`${marker} **${escapeText(sourceLabel)}**`, "normal_v2"),
    ], { bg, weight: 2 }),
    column([
      cardMarkdown(escapeText(statusText), "normal_v2"),
    ], { bg, weight: 1 }),
  ]);
}

function buildKnowledgeIngestCompletedRows(
  results: ReadonlyArray<{ sourceFile: string; extractedCount?: number | undefined }>,
): Array<Record<string, unknown>> {
  return results.map((result) => buildKnowledgeIngestMaterialRow(
    result.sourceFile,
    `入库 ${result.extractedCount ?? 0} 条`,
    "completed",
  ));
}

function buildKnowledgeIngestFailureRows(failures: ReadonlyArray<{ sourceFile: string; reason: string }>): Array<Record<string, unknown>> {
  return failures.map((failure) => buildKnowledgeIngestMaterialRow(
    failure.sourceFile,
    "解析失败",
    "failed",
  ));
}

function summarizeKnowledgeIngestTagCounts(results: KnowledgeIngestResult[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const [tag, value] of Object.entries(result.tagCounts)) {
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }
      counts.set(tag, (counts.get(tag) ?? 0) + value);
    }
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

function buildKnowledgeIngestCompletionBodyElements(input: {
  sourceLabel: string;
  materialCount: number;
  successCount: number;
  failedCount: number;
  extractedCount: number;
  rawExtractedCount: number;
  dedupedCount: number;
  tagCounts: Record<string, number>;
  bitableUrl?: string | undefined;
  elapsedMs?: number | undefined;
}): Array<Record<string, unknown>> {
  return [
    buildStatsRow([
      `素材 ${input.materialCount}`,
      `成功 ${input.successCount}`,
      `失败 ${input.failedCount}`,
      `总入库 ${input.extractedCount}`,
    ]),
    buildTagChartSection(input.tagCounts, input.bitableUrl),
    buildDivider(),
    buildKnowledgeIngestMaterialRow(
      input.sourceLabel,
      `入库 ${input.extractedCount} · 提取 ${input.rawExtractedCount} · 去重 ${input.dedupedCount}`,
      input.failedCount > 0 ? "failed" : "completed",
    ),
    ...(input.elapsedMs ? [buildElapsedLine(`耗时：${formatDurationMs(input.elapsedMs)}`)] : []),
  ];
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

function resolveKnowledgeIngestFinalSourceLabel(
  results: KnowledgeIngestResult[],
  failures: Array<{ sourceFile: string; reason: string }>,
): string {
  const totalCount = results.length + failures.length;
  if (totalCount === 0) {
    return "本次素材";
  }
  const firstSourceFile = results[0]?.sourceFile ?? failures[0]?.sourceFile ?? "本次素材";
  if (totalCount === 1) {
    return firstSourceFile;
  }
  return `${firstSourceFile} 等 ${totalCount} 个素材`;
}

function buildKnowledgeRecordUrl(bitableUrl: string | undefined, recordId: string | undefined): string | undefined {
  if (!bitableUrl || !recordId) {
    return undefined;
  }
  try {
    const parsed = new URL(bitableUrl);
    if (!parsed.pathname.startsWith("/base/")) {
      return undefined;
    }
    parsed.searchParams.set("recordId", recordId);
    return parsed.toString();
  } catch {
    return undefined;
  }
}
