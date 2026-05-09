/**
 * 职责: 定义类型化知识库条目的类型契约。
 * 关注点:
 * - 扩展现有 Q&A entry 为类型化 entry。
 * - 保留 question/answer 兼容字段，确保现有检索立即可用。
 * - 支持 case_reflow 自动派生兼容字段和去重。
 */
import { createHash } from "node:crypto";

/** 知识库条目类型 */
export type KnowledgeEntryType =
  | "article"
  | "case_digest"
  | "practice_note"
  | "case_reflow";

/** 回流条目中保留的证据来源分级，避免二审来源写成自由字符串。 */
export type KnowledgeReflowSourceType =
  | "material"
  | "local_kb:article"
  | "local_kb:digest"
  | "local_kb:reflow"
  | "local_kb:practice"
  | "authority"
  | null;

/** 知识库条目元数据 */
export type KnowledgeEntryMeta = {
  type: KnowledgeEntryType;
  confidence: number;
  reviewRequired: boolean;
  migrated?: boolean | undefined;
  effectiveStatus?: "current" | "unknown" | "expired" | undefined;
  dedupKey?: string | undefined;
  fieldsJson?: string | undefined;
};

/** case_reflow 回流草案 */
export type CaseReflowDraft = {
  caseId: string;
  title: string;
  issues: string[];
  claimBasis: Array<{ claim: string; basis: string; evidenceSummary: string[] }>;
  legalSupports: Array<{ issue: string; rule: string; sourceType: KnowledgeReflowSourceType }>;
  reviewFindings: string[];
  draftSummary: string;
  redactionCandidates: RedactionCandidate[];
  dedupKey: string;
};

/** 脱敏候选 */
export type RedactionCandidate = {
  text: string;
  category: "person" | "company" | "case_number" | "court" | "address" | "contact" | "other";
  confidence: number;
};

/** 类型化条目的默认 confidence */
export const DEFAULT_ENTRY_CONFIDENCE: Record<KnowledgeEntryType, number> = {
  article: 1.0,
  case_digest: 0.9,
  case_reflow: 0.8,
  practice_note: 0.7,
};

/** 类型化条目的默认 reviewRequired */
export const DEFAULT_ENTRY_REVIEW_REQUIRED: Record<KnowledgeEntryType, boolean> = {
  article: false,
  case_digest: false,
  case_reflow: true,
  practice_note: true,
};

/** case_reflow 兼容字段派生 */
export function deriveReflowCompatFields(draft: CaseReflowDraft): { question: string; answer: string } {
  const question = "争议焦点：" + draft.issues.join("；");
  const answer = [
    draft.claimBasis.length > 0
      ? "请求权基础：\n" + draft.claimBasis.map((cb) =>
        `- ${cb.claim}：${cb.basis}（证据：${cb.evidenceSummary.join("、")}）`
      ).join("\n")
      : "",
    draft.legalSupports.length > 0
      ? "法律依据：\n" + draft.legalSupports.map((ls) =>
        `- ${ls.issue}：${ls.rule}`
      ).join("\n")
      : "",
    draft.reviewFindings.length > 0
      ? "二审发现：\n" + draft.reviewFindings.map((rf) => `- ${rf}`).join("\n")
      : "",
    draft.draftSummary ? `\n摘要：${draft.draftSummary}` : "",
  ].filter(Boolean).join("\n\n");
  return { question, answer };
}

/** case_reflow 去重键生成 */
export function generateReflowDedupKey(draft: CaseReflowDraft): string {
  const keyMaterial = [
    draft.issues.join("|"),
    draft.legalSupports.map((ls) => ls.rule).join("|"),
    draft.draftSummary.slice(0, 200),
  ].join("###");
  return simpleHash(keyMaterial);
}

function simpleHash(input: string): string {
  // 去重键需要跨进程稳定，避免同类案件回流时静默堆出大量近重复条目。
  return `reflow_${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}
