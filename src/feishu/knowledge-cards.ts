/**
 * 职责: 构建知识库模块使用的飞书卡片。
 * 关注点:
 * - 覆盖查询结果、摄入进度、摄入摘要等展示场景。
 * - 复用共享卡片原语组织统计、步骤和引用信息。
 */
import type { KnowledgeIngestResult, KnowledgeQueryResult } from "../knowledge/index.js";
import { buildDesignerCardPayload, setDesignerButtonValue } from "./designer-card-renderer.js";
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
  const first = view.results[0];
  const second = view.results[1];
  return buildDesignerCardPayload("法律咨询", [
    { from: "违法解除劳动合同如何主张赔偿？", to: view.question },
    { from: "可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、", to: first?.answer ?? "暂无答案" },
    { from: "可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、", to: second?.answer ?? first?.answer ?? "暂无答案" },
    { from: "劳动合同法问答.pdf · 违法解除", to: first ? `${first.sourceFile}${first.pageSection ? ` · ${first.pageSection}` : ""}` : "知识库记录" },
    { from: "劳动合同法第四十八条", to: first?.statute ?? "相关依据" },
    { from: "2 条答案", to: `${view.results.length} 条答案` },
  ], (card) => {
    setDesignerButtonValue(card, "查看知识库", { kind: "knowledge-query-action", action: "open-knowledge-base", url: view.bitableUrl });
  });
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
export function buildKnowledgeIngestReadyPayload(): FeishuPostPayload {
  return buildDesignerCardPayload("知识入库已开启");
}

/** 构建知识入库完成卡。 */
export function buildKnowledgeIngestCompletedPayload(view: KnowledgeIngestCompletedCardView): FeishuPostPayload {
  const results = view.results ?? [];
  const failures = view.failures ?? [];
  const rawExtractedCount = summarizeKnowledgeIngestRawExtractedCount(results, view);
  return buildDesignerCardPayload("知识入库完成", [
    { from: "提取 47", to: `提取 ${rawExtractedCount}` },
    { from: "去重 22", to: `去重 ${view.totalDedupedCount}` },
    { from: "入库 63", to: `入库 ${view.totalExtractedCount}` },
    { from: "入库 25", to: `入库 ${view.totalExtractedCount}` },
    { from: "经济补偿计算规则.docx", to: results[0]?.sourceFile ?? "本次素材" },
    { from: "提取 13", to: `提取 ${results[0]?.rawExtractedCount ?? results[0]?.extractedCount ?? view.totalExtractedCount}` },
    { from: "去重 6", to: `去重 ${results[0]?.dedupedCount ?? 0}` },
    { from: "入库 2", to: `入库 ${results[0]?.extractedCount ?? view.totalExtractedCount}` },
    { from: "损坏文件.docx", to: failures[0]?.sourceFile ?? "失败素材" },
  ], (card) => {
    setDesignerButtonValue(card, "查看知识库", { kind: "knowledge-ingest-action", action: "open-knowledge-base", url: view.bitableUrl });
  });
}

/** 构建入库排队提示卡。 */
export function buildKnowledgeIngestQueuedPayload(view: KnowledgeIngestQueuedCardView): FeishuPostPayload {
  return buildDesignerCardPayload("知识入库排队中", [
    { from: "经济补偿计算规则.docx", to: view.sourceLabel },
    { from: "2 个素材", to: `${view.queuedAhead} 个素材` },
  ]);
}

/** 构建入库失败卡。 */
export function buildKnowledgeIngestFailurePayload(view: KnowledgeIngestFailureCardView): FeishuPostPayload {
  return buildDesignerCardPayload("知识入库失败", [
    { from: "经济补偿计算规则.docx", to: view.sourceLabel },
    { from: "PDF 解析失败", to: view.reason },
    { from: "请检查文件是否损坏或重新上传", to: view.suggestion ?? "请检查文件是否损坏或重新上传" },
  ], (card) => {
    setDesignerButtonValue(card, "重新上传", { kind: "knowledge-ingest-action", action: "retry-upload", sourceLabel: view.sourceLabel });
  });
}

/** 构建入库处理中卡。 */
export function buildKnowledgeIngestProcessingPayload(view: KnowledgeIngestProgressCardView): FeishuPostPayload {
  const completedCount = view.completedCount ?? view.completedItems?.length ?? 0;
  const failedCount = view.failedCount ?? view.failedItems?.length ?? 0;
  const queuedCount = view.queuedLabels?.length ?? 0;
  return buildDesignerCardPayload("知识入库进行中", [
    { from: "已完成 1", to: `已完成 ${completedCount}` },
    { from: "处理中 1", to: "处理中 1" },
    { from: "排队中 1", to: `排队中 ${queuedCount}` },
    { from: "失败 1", to: `失败 ${failedCount}` },
    { from: "解除通知.pdf", to: view.sourceLabel },
    { from: "社保缴纳记录.pdf", to: view.queuedLabels?.[0] ?? "排队素材.pdf" },
    { from: "劳动合同.pdf", to: view.completedItems?.[0]?.sourceFile ?? "已完成素材.pdf" },
    { from: "入库 18 条", to: `入库 ${view.completedItems?.[0]?.extractedCount ?? 0} 条` },
  ]);
}

// #endregion

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
