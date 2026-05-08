/**
 * 职责: 封装知识库检索的外部重排服务协议。
 * 关注点:
 * - 使用 Jina-compatible /rerank 请求形态接入 cross-encoder。
 * - 将外部结果映射回本地候选条目的稳定顺序。
 * - 保持失败可回退，不影响原 LLM rerank 路径。
 */
import type { KnowledgeBaseConfig } from "./config.js";
import type { KnowledgeEntryCandidate } from "./db.js";

export type RerankProviderResult = {
  candidates: KnowledgeEntryCandidate[];
  usedProvider: boolean;
};

type JinaRerankResponse = {
  results?: Array<{
    index?: unknown;
    relevance_score?: unknown;
  }>;
};

export async function rerankWithConfiguredProvider(
  config: KnowledgeBaseConfig,
  question: string,
  candidates: KnowledgeEntryCandidate[],
): Promise<RerankProviderResult> {
  const rerank = config.rerank;
  if (!rerank || rerank.provider === "llm" || candidates.length <= 1) {
    return { candidates, usedProvider: false };
  }
  if (rerank.provider !== "jina-compatible" || !rerank.endpoint) {
    return { candidates, usedProvider: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), rerank.timeoutMs);
  try {
    const response = await fetch(new URL("rerank", ensureTrailingSlash(new URL(rerank.endpoint))), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: rerank.model,
        query: question,
        documents: candidates.map(formatCandidateDocument),
        top_n: rerank.topN,
      }),
    });
    if (!response.ok) {
      throw new Error(`rerank request failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json() as JinaRerankResponse;
    const ranked = normalizeRerankResults(payload, candidates);
    return ranked.length > 0
      ? { candidates: ranked, usedProvider: true }
      : { candidates, usedProvider: false };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRerankResults(payload: JinaRerankResponse, candidates: KnowledgeEntryCandidate[]): KnowledgeEntryCandidate[] {
  const ranked = (payload.results ?? [])
    .flatMap((item, order): Array<KnowledgeEntryCandidate & { order: number }> => {
      const index = typeof item.index === "number" && Number.isInteger(item.index) ? item.index : -1;
      const score = typeof item.relevance_score === "number" && Number.isFinite(item.relevance_score)
        ? item.relevance_score
        : null;
      const candidate = candidates[index];
      if (!candidate || score === null) {
        return [];
      }
      return [{
        ...candidate,
        score,
        reranked: true,
        order,
      }];
    })
    .sort((left, right) => left.order - right.order);
  return ranked.map((item) => {
    const { order, ...candidate } = item;
    void order;
    return candidate;
  });
}

function formatCandidateDocument(candidate: KnowledgeEntryCandidate): string {
  return [
    candidate.question,
    candidate.answer,
    candidate.statute ? `法条：${candidate.statute}` : "",
    candidate.sourceFile ? `来源：${candidate.sourceFile}` : "",
    candidate.pageSection ? `位置：${candidate.pageSection}` : "",
  ].filter(Boolean).join("\n");
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`);
}
