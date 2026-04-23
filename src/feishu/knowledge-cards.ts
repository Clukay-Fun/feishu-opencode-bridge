/**
 * 职责: 构建知识库模块使用的飞书卡片。
 * 关注点:
 * - 覆盖查询结果、摄入进度、摄入摘要等展示场景。
 * - 复用共享卡片原语组织统计、步骤和引用信息。
 */
import type { KnowledgeIngestResult, KnowledgeQueryResult } from "../knowledge/index.js";
import {
  buildProgressStepElements,
  buildDivider,
  buildElapsedLine,
  buildFooterTipBlock,
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

export type KnowledgeIngestSessionSummaryView = {
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
  const footerTip = view.bitableUrl
    ? `以上内容仅供参考，不构成法律意见。\n\n[查看知识库](${escapeText(view.bitableUrl)})`
    : "以上内容仅供参考，不构成法律意见。";
  return buildInteractivePayload({
    title: "法律咨询",
    template: "indigo",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(`**问题**\n${escapeText(view.question)}`, "search_outlined", "indigo", { showIcon: false }),
      buildDivider(),
      ...view.results.flatMap((result, index) => {
        const sourceLabel = `${escapeText(result.sourceFile)}${result.pageSection ? ` · ${escapeText(result.pageSection)}` : ""}`;
        const sourceRecordUrl = buildKnowledgeRecordUrl(view.bitableUrl, result.bitableRecordId);
        const parts = [
          `**答案 ${index + 1}**`,
          escapeText(result.answer),
          sourceRecordUrl
            ? `📄 来源：[打开知识库记录｜${sourceLabel}](${escapeText(sourceRecordUrl)})`
            : `📄 来源：${sourceLabel}`,
          result.statute ? `📌 法条：${escapeText(result.statute)}` : "",
        ].filter(Boolean).join("\n\n");
        return index < view.results.length - 1
          ? [buildNoticeBodyBlock(parts, "book_outlined", "blue", { showIcon: false }), buildDivider()]
          : [buildNoticeBodyBlock(parts, "book_outlined", "blue", { showIcon: false })];
      }),
      buildDivider(),
      buildFooterTipBlock(footerTip, "warning_outlined", "orange", "notation"),
    ],
  });
}

/** 构建知识查询未命中卡。 */
export function buildKnowledgeQueryEmptyPayload(view: KnowledgeQueryEmptyCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "法律咨询",
    template: "wathet",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(`未找到与“${escapeText(view.question)}”直接相关的知识条目。`, "info_outlined", "grey", { showIcon: false }),
      buildDivider(),
      buildFooterTipBlock("以上内容仅供参考，不构成法律意见。", "warning_outlined", "orange", "notation"),
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
        cardMarkdown("**支持格式** ：PDF / DOCX / TXT / MD\n**模式** ：批量入库", "normal"),
      ]),
      cardMarkdown("发送文件或 URL 即可入库\n", "normal"),
      cardMarkdown("发送 `/kb-ingest-end` 结束本次任务", "normal_v2"),
    ],
  });
}

/** 构建知识入库会话摘要卡。 */
export function buildKnowledgeIngestSessionPayload(view: KnowledgeIngestSessionSummaryView): FeishuPostPayload {
  const bodyParts = [
    `**已完成**\n${view.completedCount} 个素材`,
    `**处理中**\n${view.currentLabel ? escapeText(view.currentLabel) : "无"}`,
    `**排队中**\n${view.queuedCount} 个素材`,
    `**总入库**\n${view.totalExtractedCount} 条问答`,
  ];
  if (view.failedCount > 0) {
    bodyParts.push(`**失败**\n${view.failedCount} 个素材`);
  }
  return buildInteractivePayload({
    title: "知识入库会话",
    template: "blue",
    iconToken: "upload_outlined",
    bodyElements: [
      buildNoticeBodyBlock(bodyParts.join("\n\n"), "upload_outlined", "blue", { showIcon: false }),
      buildDivider(),
      buildFooterTipBlock("发送文件或网页链接继续入库；发送 `/kb-ingest-end` 结束。", "info_outlined", "grey", "notation"),
    ],
  });
}

/** 构建知识入库会话最终汇总卡。 */
export function buildKnowledgeIngestSessionFinalPayload(view: KnowledgeIngestSessionSummaryView): FeishuPostPayload {
  const results = view.results ?? [];
  const failures = view.failures ?? [];
  const tagCounts = summarizeKnowledgeIngestTagCounts(results);
  const rawExtractedCount = summarizeKnowledgeIngestRawExtractedCount(results, view);
  const sourceLabel = resolveKnowledgeIngestFinalSourceLabel(results, failures);
  const bodyElements = buildKnowledgeIngestCompletionBodyElements({
    sourceLabel,
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

/** 构建单个素材入库完成卡。 */
export function buildKnowledgeIngestPayload(view: KnowledgeIngestResult): FeishuPostPayload {
  const rawExtractedCount = view.rawExtractedCount ?? view.extractedCount;
  const dedupedCount = view.dedupedCount ?? Math.max(0, rawExtractedCount - view.extractedCount);
  const bodyElements = buildKnowledgeIngestCompletionBodyElements({
    sourceLabel: view.sourceFile,
    extractedCount: view.extractedCount,
    rawExtractedCount,
    dedupedCount,
    tagCounts: view.tagCounts,
    bitableUrl: view.bitableUrl,
    elapsedMs: view.durationMs,
  });
  if (view.warning) {
    bodyElements.push(buildQuoteLine(escapeText(view.warning)));
  }
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
  const stepElements = view.steps.flatMap((step) => buildProgressStepElements(step));
  return buildInteractivePayload({
    title: "知识入库进行中",
    template: "indigo",
    iconToken: "start_outlined",
    bodyElements: [
      buildTitleLine(`处理文件：**${escapeText(view.sourceLabel)}**`),
      ...stepElements,
      buildDivider(),
      buildElapsedLine(resolveElapsedText(view)),
    ],
  });
}

// #endregion

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
  extractedCount: number;
  rawExtractedCount: number;
  dedupedCount: number;
  tagCounts: Record<string, number>;
  bitableUrl?: string | undefined;
  elapsedMs?: number | undefined;
}): Array<Record<string, unknown>> {
  return [
    buildTitleLine(`文件：**${escapeText(input.sourceLabel)}**`),
    buildStatsRow([
      `入库 ${input.extractedCount}`,
      `提取 ${input.rawExtractedCount}`,
      `去重 ${input.dedupedCount}`,
    ]),
    buildTagChartSection(input.tagCounts, input.bitableUrl),
    ...(input.elapsedMs ? [buildElapsedLine(`耗时：${formatDurationMs(input.elapsedMs)}`)] : []),
  ];
}

function summarizeKnowledgeIngestRawExtractedCount(
  results: KnowledgeIngestResult[],
  fallback: Pick<KnowledgeIngestSessionSummaryView, "totalExtractedCount" | "totalDedupedCount">,
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
