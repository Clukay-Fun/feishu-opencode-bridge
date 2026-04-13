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
  "违约",
  "解除劳动合同",
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

  if (/劳动合同|试用期|赔偿金|仲裁|违约金|解除合同/.test(normalized)) {
    confidence += 0.2;
    reasons.push("high-signal-topic");
  }

  const bounded = Math.min(1, Number(confidence.toFixed(2)));
  return {
    matched: bounded >= 0.5,
    confidence: bounded,
    reasons,
  };
}

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

  const hasReadIntent = /读取|阅读|抓取|提取|整理|转成|写成|生成/.test(normalized);
  if (hasReadIntent) {
    reasons.push("read-intent");
  }

  return {
    matched: options.requireIngestIntent === false ? true : hasIngestIntent,
    url,
    reasons,
  };
}

function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"'，。；、）)】\]]+/i);
  if (!match?.[0]) {
    return undefined;
  }
  return match[0].replace(/[.,;:!?。！？]+$/g, "");
}
