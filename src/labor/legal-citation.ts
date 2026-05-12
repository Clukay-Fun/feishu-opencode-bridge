/**
 * 职责: 识别并校验劳动争议输出中的法条引用。
 * 关注点:
 * - 用稳定正则抽取常见《法律》第X条引用。
 * - 用劳动领域白名单标记可直接展示与需人工复核的引用。
 * - 为 labor harness 和工作台渲染提供同一套风险判断。
 */

export type LegalCitationCheck = {
  citation: string;
  lawName: string;
  article: string;
  allowed: boolean;
  note?: string | undefined;
};

export const LEGAL_CITATION_PATTERN = /《([^》]+)》第([\d一二三四五六七八九十百千]+)条(?:第([一二三四五六七八九十百]+)款)?/g;

const LABOR_LAW_ARTICLE_WHITELIST: Record<string, Set<string>> = {
  劳动合同法: new Set(["7", "10", "14", "30", "38", "39", "40", "41", "46", "47", "48", "50", "82", "87"]),
  中华人民共和国劳动合同法: new Set(["7", "10", "14", "30", "38", "39", "40", "41", "46", "47", "48", "50", "82", "87"]),
  劳动法: new Set(["16", "44", "50", "72", "77", "79", "82"]),
  中华人民共和国劳动法: new Set(["16", "44", "50", "72", "77", "79", "82"]),
  劳动争议调解仲裁法: new Set(["2", "5", "27", "28", "43", "47", "48", "50"]),
  中华人民共和国劳动争议调解仲裁法: new Set(["2", "5", "27", "28", "43", "47", "48", "50"]),
  社会保险法: new Set(["58", "60", "63", "84", "86"]),
  中华人民共和国社会保险法: new Set(["58", "60", "63", "84", "86"]),
};

/** 抽取文本中的法条引用并标记是否属于劳动争议常用法规范围。 */
export function checkLaborLegalCitations(text: string): LegalCitationCheck[] {
  const checks: LegalCitationCheck[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LEGAL_CITATION_PATTERN)) {
    const citation = match[0];
    if (seen.has(citation)) {
      continue;
    }
    seen.add(citation);
    const lawName = match[1] ?? "";
    const article = normalizeArticleNumber(match[2] ?? "");
    const allowed = Boolean(LABOR_LAW_ARTICLE_WHITELIST[lawName]?.has(article));
    checks.push({
      citation,
      lawName,
      article,
      allowed,
      ...(allowed ? {} : { note: "需人工复核" }),
    });
  }
  return checks;
}

/** 为展示层生成带风险提示的引用文本。 */
export function formatCitationReviewText(checks: LegalCitationCheck[]): string[] {
  if (checks.length === 0) {
    return ["未识别到明确法条引用；正式提交前仍需律师补核法律依据。"];
  }
  return checks.map((check) => check.allowed
    ? `${check.citation}：属于劳动争议常用法条范围，仍需结合案件事实复核适用条件。`
    : `${check.citation}：不在当前劳动争议常用法条范围内，需人工确认是否适用。`);
}

function normalizeArticleNumber(value: string): string {
  if (/^\d+$/.test(value)) {
    return value;
  }
  const parsed = parseChineseInteger(value);
  return parsed > 0 ? String(parsed) : value;
}

function parseChineseInteger(value: string): number {
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const units: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
  };
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char in digits) {
      current = digits[char] ?? 0;
      continue;
    }
    const unit = units[char];
    if (unit) {
      total += (current || 1) * unit;
      current = 0;
    }
  }
  return total + current;
}
