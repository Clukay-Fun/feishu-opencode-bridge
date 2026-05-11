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

export type KnowledgeMaterialIngestDetectResult = {
  matched: boolean;
  confidence: number;
  reasons: string[];
};

const LEGAL_KEYWORDS = [
  "法律",
  "律师",
  "法条",
  "合同",
  "合同纠纷",
  "劳动",
  "仲裁",
  "诉讼",
  "起诉",
  "判决",
  "执行",
  "试用期",
  "赔偿",
  "赔偿金",
  "违约",
  "解除劳动合同",
  "解除合同",
  "保密协议",
  "竞业限制",
  "知识产权",
  "著作权",
  "商标",
  "专利",
  "侵权",
  "公司治理",
  "股东",
  "股权",
  "董事",
  "婚姻",
  "继承",
  "行政处罚",
  "行政复议",
  "数据合规",
  "个人信息",
  "税务",
  "平台合规",
  "社保",
  "工伤",
  "加班费",
  "经济补偿",
  "民法典",
  "劳动合同法",
];

const QUESTION_MARKERS = ["吗", "么", "如何", "怎么", "怎么办", "是否", "能否", "可以", "多久", "多长", "合法么"];
const LEGAL_QUERY_FORCE_PATTERN = /^\/?法律问答(?:\s+|[：:])/;
const META_DOCUMENT_PATTERNS = [
  /演示视频脚本|视频脚本|最终版|分镜|画面说明|时长[:：]|第[一二三四五六七八九十]+幕/,
  /AI\s*回复|用户(?:打开|把|说|输入)|语音[:：]|命令示例|示例[:：]/i,
  /测试用例|验收清单|开发计划|修复计划|需求文档|方案|脚本/,
];
const META_STRUCTURE_PATTERNS = [
  /^#{1,6}\s+/m,
  /\n---\n/,
  />\s*["“]?[^"\n“”]*(?:法律问答|劳动合同|竞业限制|解除劳动合同)[^"\n“”]*["”]?/,
];
const MATERIAL_INGEST_NEGATIVE_PATTERN = /不要入库|别入库|不用入库|不入库|先别入库|不要写入知识库|不要保存到知识库/;
const MATERIAL_INGEST_TARGET_PATTERN = /知识库|知识|库/;
const MATERIAL_INGEST_ACTION_PATTERN = /入库|导入|收录|收入|整理|保存|写入|同步|加入|添加|放进|放到|归档/;
const MATERIAL_REFERENCE_PATTERN = /这些|这几|刚才|上面|前面|文件|材料|文档|附件|书|资料|pdf|docx|txt|md|图片/;

/** 根据关键词与问句特征判断消息是否像法律咨询问题。 */
export function detectLegalQuestion(text: string): KnowledgeAutoDetectResult {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return { matched: false, confidence: 0, reasons: [] };
  }
  if (isMetaDocumentWithEmbeddedLegalExample(text)) {
    return { matched: false, confidence: 0, reasons: ["meta-document"] };
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

/** 避免把演示稿、测试方案等长文本里的法律问题示例误判成真实咨询。 */
function isMetaDocumentWithEmbeddedLegalExample(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || LEGAL_QUERY_FORCE_PATTERN.test(trimmed)) {
    return false;
  }

  const metaHits = META_DOCUMENT_PATTERNS.filter((pattern) => pattern.test(trimmed)).length;
  const structureHits = META_STRUCTURE_PATTERNS.filter((pattern) => pattern.test(trimmed)).length;
  if (trimmed.length < 120 || metaHits < 1 || structureHits < 1) {
    return false;
  }

  const legalExampleCount = (trimmed.match(/法律问答|劳动合同|竞业限制|解除劳动合同|法条|诉讼|仲裁/g) ?? []).length;
  return legalExampleCount >= 2;
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

/** 判断用户是否在要求把最近上传/引用的材料写入知识库。 */
export function detectKnowledgeMaterialIngestIntent(text: string): KnowledgeMaterialIngestDetectResult {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return { matched: false, confidence: 0, reasons: [] };
  }
  if (MATERIAL_INGEST_NEGATIVE_PATTERN.test(normalized)) {
    return { matched: false, confidence: 0, reasons: ["negative-ingest-intent"] };
  }

  const reasons: string[] = [];
  let confidence = 0;
  if (MATERIAL_INGEST_TARGET_PATTERN.test(normalized)) {
    confidence += 0.35;
    reasons.push("knowledge-target");
  }
  if (MATERIAL_INGEST_ACTION_PATTERN.test(normalized)) {
    confidence += 0.35;
    reasons.push("ingest-action");
  }
  if (MATERIAL_REFERENCE_PATTERN.test(normalized)) {
    confidence += 0.2;
    reasons.push("material-reference");
  }

  const strongShortIntent = /^(?:入库|收录|导入|收入知识库|整理入库|存入知识库|写入知识库)$/.test(normalized);
  if (strongShortIntent) {
    confidence += 0.4;
    reasons.push("short-strong-intent");
  }

  const bounded = Math.min(1, Number(confidence.toFixed(2)));
  return {
    matched: bounded >= 0.7,
    confidence: bounded,
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
