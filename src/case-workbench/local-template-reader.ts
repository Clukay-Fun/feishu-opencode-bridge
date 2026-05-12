/**
 * 职责: 读取本地案件文书模板并注入普通 OpenCode 对话上下文。
 * 关注点:
 * - 默认从用户桌面的“文书模板”目录查找模板文件。
 * - 按用户当前文书需求匹配仲裁申请书、证据清单等模板。
 * - 读取失败时静默降级，不阻断普通对话。
 */
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseKnowledgeFile } from "../knowledge/parser.js";
import type { Logger } from "../logging/logger.js";

const MAX_LOCAL_TEMPLATES = 2;
const MAX_TEMPLATE_TEXT_LENGTH = 60_000;
const LOCAL_TEMPLATE_DIR = path.join(os.homedir(), "Desktop", "文书模板");

type LocalTemplateCandidate = {
  name: string;
  path: string;
  score: number;
};

export async function readLocalCaseDocumentTemplates(text: string, logger: Logger): Promise<string[]> {
  const candidates = await findLocalTemplateCandidates(text, logger);
  const blocks: string[] = [];
  for (const candidate of candidates.slice(0, MAX_LOCAL_TEMPLATES)) {
    try {
      const buffer = await readFile(candidate.path);
      const parsed = await parseKnowledgeFile(candidate.path, buffer);
      const content = parsed.normalizedMarkdown.trim();
      if (!content) {
        continue;
      }
      blocks.push(renderLocalTemplateBlock(candidate.name, candidate.path, content));
    } catch (error) {
      logger.log("case-workbench/template", "local template read failed", {
        template: candidate.path,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }
  return blocks;
}

async function findLocalTemplateCandidates(text: string, logger: Logger): Promise<LocalTemplateCandidate[]> {
  const entries = await readdir(LOCAL_TEMPLATE_DIR, { withFileTypes: true }).catch((error) => {
    logger.log("case-workbench/template", "local template directory unavailable", {
      dir: LOCAL_TEMPLATE_DIR,
      detail: error instanceof Error ? error.message : String(error),
    }, "debug");
    return [];
  });
  const normalizedText = normalizeTemplateText(text);
  return entries
    .filter((entry) => entry.isFile() && /\.(docx|md|txt)$/i.test(entry.name))
    .map((entry) => {
      const templatePath = path.join(LOCAL_TEMPLATE_DIR, entry.name);
      return {
        name: entry.name,
        path: templatePath,
        score: scoreTemplate(entry.name, normalizedText),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "zh-Hans-CN"));
}

function scoreTemplate(fileName: string, normalizedText: string): number {
  const normalizedName = normalizeTemplateText(fileName);
  let score = 0;
  if (/仲裁申请书/.test(normalizedText) && /仲裁申请书/.test(normalizedName)) score += 10;
  if (/证据(目录|清单)/.test(normalizedText) && /证据(目录|清单)/.test(normalizedName)) score += 10;
  if (/起诉状/.test(normalizedText) && /起诉状/.test(normalizedName)) score += 10;
  if (/答辩状/.test(normalizedText) && /答辩状/.test(normalizedName)) score += 10;
  if (/代理意见|质证意见/.test(normalizedText) && /代理意见|质证意见/.test(normalizedName)) score += 10;
  if (/劳动|仲裁|人事争议/.test(normalizedText) && /劳动|仲裁|人事争议/.test(normalizedName)) score += 2;
  if (/模板/.test(normalizedName)) score += 1;
  return score;
}

function normalizeTemplateText(text: string): string {
  return text.replace(/\s+/g, "").replace(/\.(docx|md|txt)$/i, "");
}

function renderLocalTemplateBlock(name: string, templatePath: string, content: string): string {
  return [
    "[Local Case Document Template]",
    `模板名称：${name}`,
    `本地路径：${templatePath}`,
    "",
    "模板正文：",
    content.slice(0, MAX_TEMPLATE_TEXT_LENGTH),
    "",
    "使用要求：生成对应文书时，优先沿用该模板的栏目、顺序、措辞风格和空缺字段；案件事实、证据和请求项必须以当前案件工作台上下文为准。",
  ].join("\n");
}
