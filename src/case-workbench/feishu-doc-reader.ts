/**
 * 职责: 读取普通对话中引用的飞书云文档。
 * 关注点:
 * - 通过 lark-cli 复用本机已有飞书认证与文档读取能力。
 * - 将引用文档转换为可注入 OpenCode 的轻量上下文块。
 * - 失败时降级为空上下文，不阻断普通对话。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "../logging/logger.js";

const execFileAsync = promisify(execFile);
const MAX_REFERENCED_DOCS = 2;
const MAX_DOC_TEXT_LENGTH = 50_000;

export async function readReferencedFeishuDocuments(text: string, logger: Logger): Promise<string[]> {
  const urls = extractFeishuDocumentUrls(text).slice(0, MAX_REFERENCED_DOCS);
  if (urls.length === 0) {
    return [];
  }
  const blocks: string[] = [];
  for (const url of urls) {
    const content = await fetchFeishuDocument(url, logger);
    if (!content) {
      continue;
    }
    blocks.push(renderReferencedFeishuDocumentBlock(url, content));
  }
  return blocks;
}

function extractFeishuDocumentUrls(text: string): string[] {
  const candidates = text.match(/https?:\/\/[^\s<>"'）)]+/g) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of candidates) {
    const url = candidate.replace(/[，。；、,.!?！？]+$/g, "");
    if (!/\/\/(?:[a-z0-9-]+\.)?(?:feishu|larksuite)\.cn\//i.test(url)) {
      continue;
    }
    if (!/(?:\/docx?\/|\/wiki\/|\/docs\/|\/file\/)/i.test(url)) {
      continue;
    }
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

async function fetchFeishuDocument(url: string, logger: Logger): Promise<string | null> {
  const args = ["docs", "+fetch", "--api-version", "v2", "--doc", url, "--format", "json"];
  try {
    const { stdout } = await execFileAsync("lark-cli", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    return normalizeFetchedDocument(stdout);
  } catch (error) {
    logger.log("case-workbench/context", "referenced feishu document fetch failed", {
      url,
      detail: error instanceof Error ? error.message : String(error),
    }, "warn");
    return null;
  }
}

function normalizeFetchedDocument(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const text = extractTextFromJson(parsed);
    return text ? text.slice(0, MAX_DOC_TEXT_LENGTH) : trimmed.slice(0, MAX_DOC_TEXT_LENGTH);
  } catch {
    return trimmed.slice(0, MAX_DOC_TEXT_LENGTH);
  }
}

function extractTextFromJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractTextFromJson).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const preferred = [
    record["content"],
    record["markdown"],
    record["xml"],
    record["text"],
    record["docx_xml"],
    record["data"],
  ].map(extractTextFromJson).filter(Boolean);
  if (preferred.length > 0) {
    return preferred.join("\n");
  }
  return Object.entries(record)
    .filter(([key]) => !["url", "token", "id"].includes(key))
    .map(([, item]) => extractTextFromJson(item))
    .filter(Boolean)
    .join("\n");
}

function renderReferencedFeishuDocumentBlock(url: string, content: string): string {
  return [
    "[Referenced Feishu Document]",
    `来源：${url}`,
    "",
    content,
    "",
    "使用要求：如果用户要求根据该模板生成材料，请优先遵循此文档的结构、标题和措辞风格；不要把模板中的示例事实当作当前案件事实。",
  ].join("\n");
}
