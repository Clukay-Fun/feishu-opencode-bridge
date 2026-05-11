/**
 * 职责: 提供发票文本的结构化识别、字段抽取与修补提示词。
 * 关注点:
 * - 用可解释信号和模糊匹配拦截非发票材料。
 * - 从 OCR / PDF 文本层中快速提取核心发票字段。
 * - 为后续 LLM 只修补缺失字段提供严格 diff prompt。
 */
export type InvoiceSignalMatch = {
  name: string;
  weight: number;
  matchedBy: string;
};

export type InvoiceDetectionResult = {
  isInvoice: boolean;
  confidence: number;
  positiveScore: number;
  negativeScore: number;
  maxPositiveScore: number;
  matchedStrongSignals: InvoiceSignalMatch[];
  matchedAuxSignals: InvoiceSignalMatch[];
  matchedNegativeSignals: InvoiceSignalMatch[];
  missingStrongSignals: string[];
  reason: string;
};

export type StructuredInvoiceExtraction = {
  detection: InvoiceDetectionResult;
  fields: Record<string, unknown>;
  missingFields: string[];
};

type SignalDefinition = {
  name: string;
  weight: number;
  patterns: string[];
};

const STRONG_SIGNALS: SignalDefinition[] = [
  { name: "发票号码", weight: 2, patterns: ["发票号码", "发票号", "发票No"] },
  { name: "开票日期", weight: 2, patterns: ["开票日期", "开具日期"] },
  { name: "购买方信息", weight: 2, patterns: ["购买方信息", "购买方名称", "购方名称", "购买方"] },
  { name: "销售方信息", weight: 2, patterns: ["销售方信息", "销售方名称", "销方名称", "销售方"] },
  { name: "价税合计", weight: 2, patterns: ["价税合计", "小写", "合计金额"] },
  { name: "税额", weight: 2, patterns: ["税额", "税率"] },
  { name: "发票类型", weight: 2, patterns: ["电子发票", "增值税专用发票", "增值税普通发票", "普通发票", "数电票"] },
];

const AUX_SIGNALS: SignalDefinition[] = [
  { name: "纳税人识别号", weight: 1, patterns: ["纳税人识别号", "统一社会信用代码", "税号"] },
  { name: "发票代码", weight: 1, patterns: ["发票代码"] },
  { name: "校验码", weight: 1, patterns: ["校验码"] },
  { name: "商品明细", weight: 1, patterns: ["项目名称", "规格型号", "单位", "数量", "单价"] },
  { name: "金额合计", weight: 1, patterns: ["金额", "合计", "大写"] },
];

const NEGATIVE_SIGNALS: SignalDefinition[] = [
  { name: "合同材料", weight: 2, patterns: ["合同编号", "委托代理合同", "法律服务合同", "协议书"] },
  { name: "诉讼材料", weight: 2, patterns: ["仲裁申请书", "起诉状", "判决书", "裁定书", "证据目录"] },
  { name: "普通截图", weight: 1, patterns: ["聊天记录", "截图", "朋友圈"] },
];

const REQUIRED_FIELDS = ["购买方", "发票号", "开票日期", "发票金额"];

export function normalizeTextForSignal(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

export function fuzzySignalMatch(text: string, patterns: string[], maxDistance = 2): string | null {
  const normalizedText = normalizeTextForSignal(text);
  if (!normalizedText) {
    return null;
  }
  for (const pattern of patterns) {
    const normalizedPattern = normalizeTextForSignal(pattern);
    if (!normalizedPattern) {
      continue;
    }
    if (normalizedText.includes(normalizedPattern)) {
      return pattern;
    }
    const windowSize = normalizedPattern.length;
    if (windowSize < 3 || normalizedText.length < windowSize) {
      continue;
    }
    for (let index = 0; index <= normalizedText.length - windowSize; index += 1) {
      const candidate = normalizedText.slice(index, index + windowSize);
      if (levenshteinDistance(candidate, normalizedPattern) <= maxDistance) {
        return pattern;
      }
    }
  }
  return null;
}

export function detectInvoiceDocument(text: string): InvoiceDetectionResult {
  const strong = collectSignalMatches(text, STRONG_SIGNALS);
  const aux = collectSignalMatches(text, AUX_SIGNALS);
  const negative = collectSignalMatches(text, NEGATIVE_SIGNALS);
  const positiveScore = sumWeights(strong) + sumWeights(aux);
  const negativeScore = sumWeights(negative);
  const maxPositiveScore = sumWeights(STRONG_SIGNALS) + sumWeights(AUX_SIGNALS);
  const confidence = maxPositiveScore > 0
    ? clamp01((positiveScore - negativeScore) / maxPositiveScore)
    : 0;
  const missingStrongSignals = STRONG_SIGNALS
    .filter((signal) => !strong.some((match) => match.name === signal.name))
    .map((signal) => signal.name);
  return {
    isInvoice: confidence >= 0.75,
    confidence,
    positiveScore,
    negativeScore,
    maxPositiveScore,
    matchedStrongSignals: strong,
    matchedAuxSignals: aux,
    matchedNegativeSignals: negative,
    missingStrongSignals,
    reason: buildDetectionReason(strong, aux, negative, confidence),
  };
}

export function extractStructuredInvoice(text: string): StructuredInvoiceExtraction {
  const detection = detectInvoiceDocument(text);
  const fields = extractInvoiceFields(text);
  const missingFields = REQUIRED_FIELDS.filter((field) => fields[field] === undefined || fields[field] === "");
  return { detection, fields, missingFields };
}

export function buildInvoiceRepairPrompt(input: {
  text: string;
  confirmedFields: Record<string, unknown>;
  missingFields: string[];
}): string {
  return [
    "你是发票字段修补助手。",
    "请只根据材料文本修补待补字段，输出 JSON 对象，不要输出额外说明。",
    "",
    "已确认字段禁止修改：",
    JSON.stringify(input.confirmedFields, null, 2),
    "",
    "待补字段：",
    JSON.stringify(input.missingFields),
    "",
    "输出格式：",
    "{",
    "  \"patch\": { \"字段名\": \"补充值\" },",
    "  \"unchanged\": [\"已确认字段名\"],",
    "  \"cannotFill\": [\"无法从文本确认的字段名\"]",
    "}",
    "",
    "规则：",
    "1. patch 只能包含待补字段，禁止返回已确认字段。",
    "2. 没有明确证据的字段放入 cannotFill，不要编造。",
    "3. 日期优先 YYYY-MM-DD，金额输出数字。",
    "",
    "材料文本：",
    "---",
    input.text,
    "---",
  ].join("\n");
}

function collectSignalMatches(text: string, signals: SignalDefinition[]): InvoiceSignalMatch[] {
  return signals.flatMap((signal) => {
    const matchedBy = fuzzySignalMatch(text, signal.patterns);
    return matchedBy ? [{ name: signal.name, weight: signal.weight, matchedBy }] : [];
  });
}

function extractInvoiceFields(text: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  setIfPresent(fields, "发票号", matchFirst(text, [
    /发票\s*号码\s*[:：]?\s*([A-Z0-9]{6,30})/i,
    /发票\s*号\s*[:：]?\s*([A-Z0-9]{6,30})/i,
  ]));
  setIfPresent(fields, "开票日期", normalizeInvoiceDate(matchFirst(text, [
    /开票日期\s*[:：]?\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?)/,
    /开具日期\s*[:：]?\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?)/,
  ])));
  setIfPresent(fields, "购买方", extractBuyerName(text));
  setIfPresent(fields, "发票金额", extractInvoiceAmount(text));
  return fields;
}

function extractBuyerName(text: string): string | undefined {
  const direct = cleanupPartyName(matchFirst(text, [
    /购方名称\s*[:：]?\s*([^\n；;]+?)(?:\s{2,}|纳税人|统一社会|地址|电话|开户|$)/,
    /购买方名称\s*[:：]?\s*([^\n；;]+?)(?:\s{2,}|纳税人|统一社会|地址|电话|开户|$)/,
  ]));
  if (direct) {
    return direct;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const buyerIndex = lines.findIndex((line) => /购买方|购方/.test(line));
  if (buyerIndex < 0) {
    return undefined;
  }
  for (const line of lines.slice(buyerIndex, buyerIndex + 6)) {
    const name = cleanupPartyName(line.match(/名称\s*[:：]?\s*(.+)$/)?.[1]);
    if (name && !/购买方|购方|信息/.test(name)) {
      return name;
    }
  }
  return undefined;
}

function extractInvoiceAmount(text: string): number | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labeledLine = lines.find((line) => /价税合计|小写|合计金额/.test(line));
  const value = labeledLine
    ? matchFirst(labeledLine, [
      /(?:价税合计|小写|合计金额)[^\d¥￥-]{0,30}[¥￥]?\s*([0-9,]+(?:\.\d{1,2})?)/,
      /[¥￥]\s*([0-9,]+(?:\.\d{1,2})?)/,
    ])
    : undefined;
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function matchFirst(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

function normalizeInvoiceDate(value: string | undefined): string | undefined {
  return value
    ?.replace(/年|[./]/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .replace(/-(\d)(?=-|$)/g, "-0$1")
    .trim();
}

function cleanupPartyName(value: string | undefined): string | undefined {
  return value
    ?.replace(/^(名称|购买方|购方名称)[:：]?/, "")
    .replace(/[，,；;\s]+$/g, "")
    .trim();
}

function setIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") {
    target[key] = value;
  }
}

function sumWeights(items: Array<{ weight: number }>): number {
  return items.reduce((sum, item) => sum + item.weight, 0);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function buildDetectionReason(
  strong: InvoiceSignalMatch[],
  aux: InvoiceSignalMatch[],
  negative: InvoiceSignalMatch[],
  confidence: number,
): string {
  const positive = [...strong, ...aux].map((item) => item.name).join("、") || "无发票信号";
  const negativeText = negative.length ? `；反信号：${negative.map((item) => item.name).join("、")}` : "";
  return `置信度 ${confidence.toFixed(2)}；命中：${positive}${negativeText}`;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] = Math.min(
        current[rightIndex]! + 1,
        previous[rightIndex + 1]! + 1,
        previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}
