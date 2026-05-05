/**
 * 职责: 收口知识库检索词确认流的纯领域契约。
 * 关注点:
 * - 将用户案情转成可展示、可编辑、可确认的检索词草案。
 * - 区分本地知识库、pkulaw 权威源和人工复核边界。
 * - 不直接发起检索、不持久化 pending，也不绑定飞书卡片实现。
 */

export type KnowledgeSearchSource = "local-knowledge" | "pkulaw";

export type KnowledgeSearchTermDraft = {
  terms: string[];
  reason: string;
};

export type KnowledgeSearchStrategyDraft = {
  question: string;
  status: "pending-confirmation";
  terms: KnowledgeSearchTermDraft[];
  sources: KnowledgeSearchSource[];
  reviewNote: string;
};

export type ConfirmedKnowledgeSearchStrategy = {
  question: string;
  status: "confirmed";
  terms: string[];
  sources: KnowledgeSearchSource[];
  answerBoundaries: string[];
};

const LEGAL_STOP_WORDS = new Set([
  "请问",
  "如何",
  "什么",
  "是否",
  "可以",
  "需要",
  "一个",
  "这个",
  "那个",
]);

const LABOR_SIGNAL_TERMS = [
  { pattern: /违法解除|辞退|开除|解除劳动合同/, term: "违法解除劳动合同" },
  { pattern: /赔偿金|补偿金|经济补偿/, term: "经济补偿金 赔偿金" },
  { pattern: /工资|薪资|加班费|奖金/, term: "工资报酬 举证责任" },
  { pattern: /竞业限制|保密协议/, term: "竞业限制 补偿" },
  { pattern: /工伤|职业病/, term: "工伤认定 劳动能力鉴定" },
  { pattern: /仲裁|劳动仲裁/, term: "劳动争议仲裁 时效" },
];

export function buildKnowledgeSearchStrategyDraft(input: {
  question: string;
  pkulawEnabled?: boolean | undefined;
  maxTerms?: number | undefined;
}): KnowledgeSearchStrategyDraft {
  const question = input.question.trim();
  const maxTerms = input.maxTerms ?? 6;
  const signalTerms = LABOR_SIGNAL_TERMS
    .filter((item) => item.pattern.test(question))
    .map((item) => ({
      terms: [item.term],
      reason: "命中劳动争议案情信号，优先作为可解释检索词。",
    }));
  const keywordTerms = extractKeywordTerms(question)
    .filter((term) => !signalTerms.some((item) => item.terms.includes(term)))
    .slice(0, Math.max(0, maxTerms - signalTerms.length))
    .map((term) => ({
      terms: [term],
      reason: "从案情原文抽取的关键词，供律师确认或编辑。",
    }));

  return {
    question,
    status: "pending-confirmation",
    terms: [...signalTerms, ...keywordTerms].slice(0, maxTerms),
    sources: input.pkulawEnabled ? ["local-knowledge", "pkulaw"] : ["local-knowledge"],
    reviewNote: input.pkulawEnabled
      ? "确认后将同时查询本地知识库与 pkulaw 权威源；权威源不可用时应降级为本地知识库。"
      : "pkulaw 未启用或不可用，本轮只查询本地知识库。",
  };
}

export function confirmKnowledgeSearchStrategy(
  draft: KnowledgeSearchStrategyDraft,
  editedTerms?: string[] | undefined,
): ConfirmedKnowledgeSearchStrategy {
  const terms = normalizeTermList(editedTerms && editedTerms.length > 0
    ? editedTerms
    : draft.terms.flatMap((item) => item.terms));
  return {
    question: draft.question,
    status: "confirmed",
    terms,
    sources: draft.sources,
    answerBoundaries: [
      "回答必须区分本地知识库、权威法规/案例、模型补充、需人工复核。",
      "未命中权威来源的法条或案例引用不得包装为确定结论。",
    ],
  };
}

function extractKeywordTerms(question: string): string[] {
  const terms = question
    .split(/[，。！？、\s,.;:!?]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !LEGAL_STOP_WORDS.has(term));
  return normalizeTermList(terms);
}

function normalizeTermList(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}
