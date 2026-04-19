import type { KnowledgeIngestResult, KnowledgeQueryResult } from "../knowledge/index.js";
import {
  buildDivider,
  buildElapsedLine,
  buildFooterTipBlock,
  buildGreyPanel,
  buildInteractivePayload,
  buildKnowledgeIngestProgressStepElements,
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

export function buildKnowledgeIngestSessionFinalPayload(view: KnowledgeIngestSessionSummaryView): FeishuPostPayload {
  const results = view.results ?? [];
  const failures = view.failures ?? [];
  const summaryLines = [
    `**成功**：${view.completedCount} 个素材`,
    `**失败**：${view.failedCount} 个素材`,
    `**总入库**：${view.totalExtractedCount} 条问答`,
    `**去重合并**：${view.totalDedupedCount} 条`,
    ...(view.elapsedMs ? [`**总耗时**：${formatDurationMs(view.elapsedMs)}`] : []),
  ];
  const detailLines = buildKnowledgeIngestFinalDetailLines(results, failures);

  return buildInteractivePayload({
    title: "本次入库完成",
    template: "indigo",
    iconToken: "grid-view_filled",
    bodyElements: [
      buildGreyPanel([
        cardMarkdown(summaryLines.join("\n"), "normal_v2"),
      ]),
      ...(detailLines.length > 0 ? [
        buildDivider(),
        cardMarkdown(detailLines.join("\n\n"), "normal_v2"),
      ] : []),
      buildDivider(),
      ...(view.bitableUrl ? [cardMarkdown(`[查看知识库 →](${escapeText(view.bitableUrl)})`, "normal")] : []),
    ],
  });
}

export function buildKnowledgeIngestPayload(view: KnowledgeIngestResult): FeishuPostPayload {
  const rawExtractedCount = view.rawExtractedCount ?? view.extractedCount;
  const dedupedCount = view.dedupedCount ?? Math.max(0, rawExtractedCount - view.extractedCount);
  const bodyElements: Array<Record<string, unknown>> = [
    buildTitleLine(`文件：**${escapeText(view.sourceFile)}**`),
    buildStatsRow([
      `入库 ${view.extractedCount}`,
      `提取 ${rawExtractedCount}`,
      `去重 ${dedupedCount}`,
    ]),
    buildTagChartSection(view.tagCounts, view.bitableUrl),
  ];
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

export function buildKnowledgeIngestProcessingPayload(view: KnowledgeIngestProgressCardView): FeishuPostPayload {
  const stepElements = view.steps.flatMap((step) => buildKnowledgeIngestProgressStepElements(step));
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

function buildKnowledgeIngestFinalDetailLines(
  results: KnowledgeIngestResult[],
  failures: Array<{ sourceFile: string; reason: string }>,
): string[] {
  const maxVisibleItems = 12;
  const lines: string[] = [];
  const successLines = results.map((result) => {
    const rawExtractedCount = result.rawExtractedCount ?? result.extractedCount;
    const dedupedCount = result.dedupedCount ?? Math.max(0, rawExtractedCount - result.extractedCount);
    return [
      `**${escapeText(result.sourceFile)}**`,
      `入库 ${result.extractedCount} · 提取 ${rawExtractedCount} · 去重 ${dedupedCount}`,
    ].join("\n");
  });
  const failureLines = failures.map((failure) => [
    `**${escapeText(failure.sourceFile)}**`,
    `失败 · ${escapeText(failure.reason)}`,
  ].join("\n"));
  const allLines = [...successLines, ...failureLines];
  const visibleLines = allLines.slice(0, maxVisibleItems);
  lines.push(...visibleLines);
  const omittedCount = allLines.length - visibleLines.length;
  if (omittedCount > 0) {
    lines.push(`其余 ${omittedCount} 个素材已省略，请查看知识库或日志获取完整结果。`);
  }
  return lines;
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
