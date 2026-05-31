/**
 * 职责: 提供模板占位符识别、数据填充和缺口清单。
 * 关注点:
 * - 识别 `{{variable}}` 语法的占位符。
 * - 数据填充时保留未匹配的占位符为缺口。
 * - 缺口清单：模板需要哪些字段，数据提供了哪些，缺哪些。
 */
import fs from "node:fs/promises";

export type TemplateGapAnalysis = {
  /** 模板中发现的所有占位符 */
  allPlaceholders: string[];
  /** 数据提供的字段 */
  providedFields: string[];
  /** 缺少的字段 */
  missingFields: string[];
  /** 填充后的文本 */
  filledText: string;
};

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** 扫描文本中的所有占位符。 */
export function scanPlaceholders(text: string): string[] {
  const placeholders: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(PLACEHOLDER_REGEX.source, PLACEHOLDER_REGEX.flags);
  while ((match = regex.exec(text)) !== null) {
    const key = match[1]!;
    if (!seen.has(key)) {
      seen.add(key);
      placeholders.push(key);
    }
  }
  return placeholders;
}

/** 填充占位符并返回缺口分析。 */
export function fillTemplate(text: string, data: Record<string, string>): TemplateGapAnalysis {
  const allPlaceholders = scanPlaceholders(text);
  const providedFields = Object.keys(data);
  const missingFields = allPlaceholders.filter((key) => !(key in data));

  const filledText = text.replace(PLACEHOLDER_REGEX, (_match, key: string) => {
    return key in data ? data[key]! : `{{${key}}}`;
  });

  return {
    allPlaceholders,
    providedFields,
    missingFields,
    filledText,
  };
}

/** 从文件读取模板并填充。 */
export async function loadAndFillTemplate(
  templatePath: string,
  data: Record<string, string>,
): Promise<TemplateGapAnalysis> {
  const text = await fs.readFile(templatePath, "utf-8");
  return fillTemplate(text, data);
}
