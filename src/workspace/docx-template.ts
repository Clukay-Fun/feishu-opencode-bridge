/**
 * 职责: 提供 docx 模板填充能力。
 * 关注点:
 * - 复用 docxtemplater + PizZip 处理 .docx 模板。
 * - 占位符语法：{xxx} 或 {{xxx}}（docxtemplater 默认支持 {xxx}）。
 * - 返回缺口清单。
 */
import fs from "node:fs/promises";
import path from "node:path";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

export type DocxTemplateGapAnalysis = {
  outputPath: string;
  allPlaceholders: string[];
  providedFields: string[];
  missingFields: string[];
};

/**
 * 用数据填充 .docx 模板并输出到指定路径。
 * 占位符格式：{variable}（docxtemplater 默认语法）。
 */
export async function fillDocxTemplate(
  templatePath: string,
  data: Record<string, string>,
  outputPath: string,
): Promise<DocxTemplateGapAnalysis> {
  const templateBuffer = await fs.readFile(templatePath);
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  // 收集模板中的占位符（从 zip 文件文本内容提取）
  const allPlaceholders = extractDocxPlaceholders(zip);
  const providedFields = Object.keys(data);
  const missingFields = allPlaceholders.filter((key) => !(key in data));

  doc.render(data);
  const output = doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, output);

  return {
    outputPath,
    allPlaceholders,
    providedFields,
    missingFields,
  };
}

/** 从 docx zip 内容中提取 {xxx} 占位符。 */
function extractDocxPlaceholders(zip: PizZip): string[] {
  const placeholders = new Set<string>();
  const files = zip.files;
  for (const filePath of Object.keys(files)) {
    if (!filePath.endsWith(".xml")) continue;
    const content = files[filePath]!.asText();
    const matches = content.match(/\{([a-zA-Z0-9_]+)\}/g);
    if (matches) {
      for (const match of matches) {
        const key = match.slice(1, -1);
        if (key && !key.startsWith("#") && !key.startsWith("/") && !key.startsWith("^")) {
          placeholders.add(key);
        }
      }
    }
  }
  return [...placeholders];
}
