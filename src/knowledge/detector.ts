/**
 * 职责: 识别用户消息中的知识库相关意图。
 * 关注点:
 * - 检测知识查询、网页摄入等触发条件。
 * - 返回命中结果、置信度与判定理由，供上层决定是否分流。
 */
export type KnowledgeAutoDetectResult = {
  matched: boolean;
  confidence: number;
  reasons: string[];
};

export type KnowledgeWebIngestDetectResult = {
  matched: boolean;
  url?: string | undefined;
  reasons: string[];
};

const LEGAL_KEYWORDS = [
  "法律",
  "律师",
  "法条",
  "合同",
  "劳动",
  "仲裁",
  "诉讼",
  "起诉",
  "判决",
  "试用期",
  "赔偿",
  "赔偿金",
  "违约",
  "解除劳动合同",
  "解除合同",
  "保密协议",
  "竞业限制",
  "知识产权",
  "侵权",
  "社保",
  "工伤",
  "加班费",
  "经济补偿",
  "民法典",
  "劳动合同法",
];

const QUESTION_MARKERS = ["吗", "么", "如何", "怎么", "怎么办", "是否", "能否", "可以", "多久", "多长", "合法么"];

/** 根据关键词与问句特征判断消息是否像法律咨询问题。 */
export function detectLegalQuestion(text: string): KnowledgeAutoDetectResult {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return { matched: false, confidence: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let confidence = 0;

  const keywordHits = LEGAL_KEYWORDS.filter((keyword) => normalized.includes(keyword.toLowerCase()));
  if (keywordHits.length > 0) {
    confidence += Math.min(0.5, 0.2 + keywordHits.length * 0.1);
    reasons.push(`keywords:${keywordHits.join(",")}`);
  }

  const hasQuestionShape = normalized.includes("？")
    || normalized.includes("?")
    || QUESTION_MARKERS.some((marker) => normalized.includes(marker));
  if (hasQuestionShape) {
    confidence += 0.25;
    reasons.push("question-shape");
  }

  if (/第.{0,8}条/.test(normalized) || /法第.{0,8}条/.test(normalized)) {
    confidence += 0.2;
    reasons.push("statute-citation");
  }

  const bounded = Math.min(1, Number(confidence.toFixed(2)));
  return {
    matched: bounded >= 0.5,
    confidence: bounded,
    reasons,
  };
}

/** 检测消息中是否包含网页入库意图与 URL。 */
export function detectKnowledgeWebIngest(
  text: string,
  options: { requireIngestIntent?: boolean } = {},
): KnowledgeWebIngestDetectResult {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { matched: false, reasons: [] };
  }

  const url = extractFirstUrl(normalized);
  if (!url) {
    return { matched: false, reasons: [] };
  }

  const reasons: string[] = ["url"];
  const hasIngestIntent = /入库|导入|收录|加入知识库|添加到知识库|写入知识库|保存到知识库|放进知识库|同步到知识库/.test(normalized);
  if (hasIngestIntent) {
    reasons.push("ingest-intent");
  }

  return {
    matched: options.requireIngestIntent === false ? true : hasIngestIntent,
    url,
    reasons,
  };
}

/** 从文本中提取第一个 URL。 */
function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"'，。；、）)】\]]+/i);
  if (!match?.[0]) {
    return undefined;
  }
  return match[0].replace(/[.,;:!?。！？]+$/g, "");
}
