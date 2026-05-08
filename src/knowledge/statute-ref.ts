/**
 * 职责: 解析并规范化用户问题中的法条引用。
 * 关注点:
 * - 支持书名号、裸法名和仅条号三类常见表达。
 * - 为本地知识库精确匹配提供稳定的数字化条号。
 * - 不负责外部法条库识别或权威法源补全。
 */

export type StatuteReference = {
  raw: string;
  lawName?: string | undefined;
  articleNumber: number;
  articleText: string;
  index: number;
};

const ARTICLE_NUMBER_PATTERN = "[零〇一二三四五六七八九十百千万两\\d]+";
const BOOK_TITLE_PATTERN = new RegExp(`《([^》]{1,48})》\\s*第\\s*(${ARTICLE_NUMBER_PATTERN})\\s*条`, "g");
const BARE_LAW_PATTERN = new RegExp(`([\\u4e00-\\u9fa5A-Za-z0-9]{2,48}(?:法|条例|办法|规定|解释|规则))\\s*第\\s*(${ARTICLE_NUMBER_PATTERN})\\s*条`, "g");
const ARTICLE_ONLY_PATTERN = new RegExp(`第\\s*(${ARTICLE_NUMBER_PATTERN})\\s*条`, "g");

/** 从查询文本中提取法条引用，并按出现顺序返回去重结果。 */
export function parseStatuteReferences(query: string): StatuteReference[] {
  const occupied: Array<{ start: number; end: number }> = [];
  const refs: StatuteReference[] = [];

  collectReferences(query, BOOK_TITLE_PATTERN, refs, occupied, (match) => ({
    lawName: normalizeLawName(match[1]),
    articleText: match[2] ?? "",
  }));

  collectReferences(query, BARE_LAW_PATTERN, refs, occupied, (match) => ({
    lawName: normalizeLawName(match[1]),
    articleText: match[2] ?? "",
  }));

  collectReferences(query, ARTICLE_ONLY_PATTERN, refs, occupied, (match) => ({
    articleText: match[1] ?? "",
  }));

  const sorted = refs
    .sort((left, right) => left.index - right.index)
    .map((ref, index, all) => {
      if (ref.lawName) {
        return ref;
      }
      const previous = findPreviousLawReference(all, index);
      if (!previous) {
        return ref;
      }
      const between = query.slice(previous.index + previous.raw.length, ref.index);
      return /^[\s，,、和及与以及]*(?:第)?$/u.test(between)
        ? { ...ref, lawName: previous.lawName }
        : ref;
    });

  const seen = new Set<string>();
  return sorted
    .filter((ref) => {
      const key = `${ref.lawName ?? ""}#${ref.articleNumber}#${ref.index}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function findPreviousLawReference(refs: StatuteReference[], index: number): StatuteReference | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const ref = refs[cursor];
    if (ref?.lawName) {
      return ref;
    }
  }
  return null;
}

export function normalizeLawName(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[《》\s]/g, "").trim();
  return normalized ? normalized : undefined;
}

export function toChineseArticleNumber(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value >= 10_000) {
    return String(value);
  }
  if (value < 10) {
    return digitToChinese(value);
  }
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${tens === 1 ? "" : digitToChinese(tens)}十${ones === 0 ? "" : digitToChinese(ones)}`;
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    return `${digitToChinese(hundreds)}百${rest === 0 ? "" : rest < 10 ? `零${digitToChinese(rest)}` : toChineseArticleNumber(rest)}`;
  }
  const thousands = Math.floor(value / 1000);
  const rest = value % 1000;
  return `${digitToChinese(thousands)}千${rest === 0 ? "" : rest < 100 ? `零${toChineseArticleNumber(rest)}` : toChineseArticleNumber(rest)}`;
}

function collectReferences(
  query: string,
  pattern: RegExp,
  refs: StatuteReference[],
  occupied: Array<{ start: number; end: number }>,
  read: (match: RegExpExecArray) => { lawName?: string | undefined; articleText: string },
): void {
  pattern.lastIndex = 0;
  for (const match of query.matchAll(pattern)) {
    const start = match.index ?? 0;
    const raw = match[0] ?? "";
    const end = start + raw.length;
    if (occupied.some((range) => start >= range.start && end <= range.end)) {
      continue;
    }
    const parsed = read(match);
    const articleNumber = parseArticleNumber(parsed.articleText);
    if (!articleNumber) {
      continue;
    }
    refs.push({
      raw,
      lawName: parsed.lawName,
      articleNumber,
      articleText: parsed.articleText,
      index: start,
    });
    occupied.push({ start, end });
  }
}

function parseArticleNumber(value: string): number | null {
  const normalized = value.replace(/\s/g, "");
  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const parsed = parseChineseInteger(normalized);
  return parsed > 0 ? parsed : null;
}

function parseChineseInteger(value: string): number {
  const chars = value.replace(/两/g, "二").replace(/[零〇]/g, "零");
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of chars) {
    const digit = chineseDigitValue(char);
    if (digit !== null) {
      number = digit;
      continue;
    }
    const unit = chineseUnitValue(char);
    if (unit === null) {
      return 0;
    }
    if (unit === 10_000) {
      total += (section + number) * unit;
      section = 0;
      number = 0;
      continue;
    }
    section += (number || 1) * unit;
    number = 0;
  }
  return total + section + number;
}

function chineseDigitValue(value: string): number | null {
  return "零一二三四五六七八九".indexOf(value) >= 0 ? "零一二三四五六七八九".indexOf(value) : null;
}

function chineseUnitValue(value: string): number | null {
  if (value === "十") {
    return 10;
  }
  if (value === "百") {
    return 100;
  }
  if (value === "千") {
    return 1000;
  }
  if (value === "万") {
    return 10_000;
  }
  return null;
}

function digitToChinese(value: number): string {
  return "零一二三四五六七八九"[value] ?? String(value);
}
