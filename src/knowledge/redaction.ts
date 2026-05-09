/**
 * 职责: 提供三道脱敏闸的规则层实现。
 * 关注点:
 * - 正则拦截手机号、身份证、邮箱、银行卡、统一社会信用代码。
 * - 为模型层 NER 和人工层确认提供基础。
 */

export type RedactionCategory =
  | "phone"
  | "id_card"
  | "email"
  | "bank_card"
  | "credit_code"
  | "unknown";

export type RegexRedactionHit = {
  text: string;
  category: RedactionCategory;
  start: number;
  end: number;
};

/** 手机号：11 位，1 开头 */
const PHONE_RE = /1[3-9]\d{9}/g;

/** 身份证：18 位，最后一位可以是 X */
const ID_CARD_RE = /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g;

/** 邮箱 */
const EMAIL_RE = /[\w.-]+@[\w.-]+\.\w{2,}/g;

/** 银行卡：16-19 位数字 */
const BANK_CARD_RE = /\b\d{16,19}\b/g;

/** 统一社会信用代码：18 位字母数字 */
const CREDIT_CODE_RE = /[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}/g;

const PATTERN_MAP: Array<{ re: RegExp; category: RedactionCategory }> = [
  { re: PHONE_RE, category: "phone" },
  { re: ID_CARD_RE, category: "id_card" },
  { re: EMAIL_RE, category: "email" },
  { re: BANK_CARD_RE, category: "bank_card" },
  { re: CREDIT_CODE_RE, category: "credit_code" },
];

/**
 * 执行规则层脱敏扫描，返回所有命中。
 * 调用方负责对原文做替换或标记。
 */
export function scanRegexRedactions(text: string): RegexRedactionHit[] {
  const hits: RegexRedactionHit[] = [];
  for (const { re, category } of PATTERN_MAP) {
    const cloned = new RegExp(re.source, re.flags);
    let match: RegExpExecArray | null;
    while ((match = cloned.exec(text)) !== null) {
      hits.push({
        text: match[0],
        category,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  // 按位置排序，重叠时保留先匹配的
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const filtered: RegexRedactionHit[] = [];
  let lastEnd = -1;
  for (const hit of hits) {
    if (hit.start >= lastEnd) {
      filtered.push(hit);
      lastEnd = hit.end;
    }
  }
  return filtered;
}

/**
 * 将命中的敏感信息替换为脱敏标记。
 * 保留前 3 位和后 4 位（手机号/银行卡），其他全部用 * 替代。
 */
export function applyRegexRedactions(text: string, hits: RegexRedactionHit[]): string {
  if (hits.length === 0) {
    return text;
  }
  let result = "";
  let cursor = 0;
  for (const hit of hits) {
    result += text.slice(cursor, hit.start);
    result += maskText(hit.text, hit.category);
    cursor = hit.end;
  }
  result += text.slice(cursor);
  return result;
}

function maskText(text: string, category: RedactionCategory): string {
  switch (category) {
    case "phone":
      return text.slice(0, 3) + "****" + text.slice(-4);
    case "id_card":
      return text.slice(0, 6) + "********" + text.slice(-4);
    case "bank_card":
      return text.slice(0, 4) + " **** **** " + text.slice(-4);
    case "email": {
      const [local, domain] = text.split("@");
      return (local ? local[0] : "*") + "***@" + domain;
    }
    case "credit_code":
      return text.slice(0, 4) + "**********" + text.slice(-4);
    default:
      return "***";
  }
}
