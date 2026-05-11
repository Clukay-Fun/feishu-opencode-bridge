/**
 * 职责: 将知识库入库结果导出为 Obsidian Markdown 笔记。
 * 关注点:
 * - 生成 frontmatter、摘要、问答和双链主题。
 * - Obsidian 只做可读知识资产，不参与实时检索。
 * - Bitable 未配置时省略 bitableUrl，不写 null。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { KnowledgeBaseConfig } from "./config.js";

type KnowledgeObsidianConfig = NonNullable<KnowledgeBaseConfig["obsidian"]>;

export type KnowledgeObsidianEntry = {
  question: string;
  answer: string;
  tags: string[];
  statute?: string | undefined;
  pageSection?: string | undefined;
};

export type KnowledgeObsidianExportInput = {
  sourceType: string;
  fileName: string;
  checksum: string;
  domain?: string | undefined;
  tags: string[];
  entries: KnowledgeObsidianEntry[];
  sqliteDocumentId: number;
  bitableUrl?: string | undefined;
  ingestedAt?: Date | undefined;
};

export async function exportKnowledgeObsidianNote(
  config: KnowledgeObsidianConfig,
  input: KnowledgeObsidianExportInput,
): Promise<string | null> {
  if (!config.enabled || !config.vaultPath) {
    return null;
  }

  const notePath = resolveKnowledgeObsidianNotePath(config, input);
  await mkdir(path.dirname(notePath), { recursive: true });
  await writeFile(notePath, buildKnowledgeObsidianMarkdown(config, input), "utf8");
  return notePath;
}

export function resolveKnowledgeObsidianNotePath(
  config: Pick<KnowledgeObsidianConfig, "vaultPath" | "baseDir">,
  input: Pick<KnowledgeObsidianExportInput, "fileName" | "checksum" | "sqliteDocumentId">,
): string {
  return path.join(config.vaultPath ?? "", config.baseDir, `${buildNoteFileStem(input)}.md`);
}

export function buildKnowledgeObsidianMarkdown(
  config: Pick<KnowledgeObsidianConfig, "enableWikiLinks">,
  input: KnowledgeObsidianExportInput,
): string {
  const ingestedAt = (input.ingestedAt ?? new Date()).toISOString();
  const uniqueTags = [...new Set(input.tags.filter(Boolean))];
  const wikiLinks = config.enableWikiLinks ? buildWikiLinks(input) : [];
  return [
    "---",
    `sourceType: ${yamlString(input.sourceType)}`,
    `fileName: ${yamlString(input.fileName)}`,
    `checksum: ${yamlString(input.checksum)}`,
    `ingestedAt: ${yamlString(ingestedAt)}`,
    `domain: ${yamlString(input.domain ?? "劳动争议")}`,
    `tags: ${yamlArray(uniqueTags)}`,
    `entryCount: ${input.entries.length}`,
    `sqliteDocumentId: ${input.sqliteDocumentId}`,
    ...(input.bitableUrl ? [`bitableUrl: ${yamlString(input.bitableUrl)}`] : []),
    "---",
    "",
    `# ${input.fileName}`,
    "",
    "## 摘要",
    input.entries[0]?.answer.slice(0, 240) || "暂无摘要。",
    "",
    "## 关联主题",
    wikiLinks.length > 0 ? wikiLinks.map((link) => `- ${link}`).join("\n") : "- 暂无",
    "",
    "## 提取问答",
    ...input.entries.flatMap((entry, index) => [
      `### Q${index + 1}. ${entry.question}`,
      "",
      entry.answer,
      "",
      entry.pageSection ? `来源页码/章节：${entry.pageSection}` : "来源页码/章节：未标注",
      entry.statute ? `法条：${entry.statute}` : "法条：未标注",
      "",
    ]),
  ].join("\n");
}

function buildWikiLinks(input: KnowledgeObsidianExportInput): string[] {
  const links = new Set<string>(["[[劳动争议]]"]);
  for (const tag of input.tags) {
    if (tag.includes("违法解除")) {
      links.add("[[违法解除劳动合同]]");
    }
    if (tag.includes("劳动合同")) {
      links.add("[[劳动合同]]");
    }
  }
  for (const entry of input.entries) {
    const statutes = entry.statute?.matchAll(/《?劳动合同法》?第([\d一二三四五六七八九十百千]+)条/g) ?? [];
    for (const match of statutes) {
      links.add(`[[劳动合同法第${match[1]}条]]`);
    }
  }
  return [...links];
}

function sanitizeFileName(value: string): string {
  return value.replace(/[/:*?"<>|\\]/g, "_").replace(/\s+/g, " ").trim() || "knowledge-note";
}

function buildNoteFileStem(input: Pick<KnowledgeObsidianExportInput, "fileName" | "checksum" | "sqliteDocumentId">): string {
  const checksumPrefix = sanitizeFileName(input.checksum).slice(0, 12);
  return `${sanitizeFileName(input.fileName)}-${input.sqliteDocumentId}-${checksumPrefix || "no-checksum"}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  return `[${values.map(yamlString).join(", ")}]`;
}
