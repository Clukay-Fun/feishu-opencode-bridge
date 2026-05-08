/**
 * 职责: 适配北大法宝 MCP 后台权威源。
 * 关注点:
 * - 通过本机 pkulaw-mcp CLI 调用法条检索、法条校验、法条溯源和案号溯源，不在日志或缓存中保存 token。
 * - 使用可重建文件缓存保护劳动分析主流程的延迟与稳定性。
 * - 将超时、认证失败、空结果统一降级为可展示状态。
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { KnowledgeBaseConfig } from "./config.js";
import type { Logger } from "../logging/logger.js";
import type { CostTracker } from "../runtime/cost-tracker.js";
import { redactEvidenceText } from "../runtime/sanitize.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SKILLS = {
  lawSemantic: { tool: "law-semantic", operation: "search_article" },
  lawRecognition: { tool: "law_recognition", operation: "law_recognition" },
  citationValidator: { tool: "pku_citation_validator", operation: "adjust_provisions" },
  caseNumberRecognition: { tool: "pkulaw-case-number-recognition", operation: "anhao_recognition" },
} as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type PkulawAuthorityItem = {
  title: string;
  excerpt: string;
  url?: string | undefined;
  sourceUpdatedAt?: string | undefined;
  timeliness?: string | undefined;
};

export type PkulawAuthoritySearchResult =
  | {
    status: "success" | "cache-hit";
    query: string;
    items: PkulawAuthorityItem[];
    durationMs: number;
  }
  | {
    status: "disabled" | "timeout" | "error" | "empty";
    query: string;
    items: PkulawAuthorityItem[];
    durationMs: number;
    message: string;
  };

export type PkulawToolStatus = PkulawAuthoritySearchResult["status"];

export type PkulawLawRecognitionItem = {
  text: string;
  original: string;
  fulltext?: string | undefined;
  source?: string | undefined;
};

export type PkulawCitationValidationInput = {
  userlaw?: Array<{ title: string; article_number: string }> | undefined;
  answerlaw?: Array<{ title: string; article_number: string; text?: string | undefined }> | undefined;
  prompt?: string | undefined;
};

export type PkulawCitationValidationItem = {
  title: string;
  articleNumber: string;
  originalText: string;
  url?: string | undefined;
  issueDate?: string | undefined;
  implementDate?: string | undefined;
  gid?: string | undefined;
  lib?: string | undefined;
  kuanNumber?: string | undefined;
};

export type PkulawCaseNumberItem = {
  text: string;
  start?: number | undefined;
  end?: number | undefined;
  gid?: string | undefined;
  caseFlag?: string | undefined;
  court?: string | undefined;
  title?: string | undefined;
  lastInstanceDate?: string | undefined;
  url?: string | undefined;
};

export type PkulawToolResult<T> =
  | {
    status: "success" | "cache-hit";
    input: string;
    items: T[];
    durationMs: number;
  }
  | {
    status: "disabled" | "timeout" | "error" | "empty";
    input: string;
    items: T[];
    durationMs: number;
    message: string;
  };

type PkulawCacheFile = {
  schemaVersion: 1;
  toolName: string;
  operation: string;
  createdAt: string;
  expiresAt: string;
  items: unknown[];
};

type PkulawSkillBindings = NonNullable<KnowledgeBaseConfig["authoritySources"]>["pkulaw"]["skills"];

export class PkulawAuthorityService {
  private readonly cacheDir: string;
  private readonly enabled: boolean;
  private readonly cliCommand: string;
  private readonly skills: PkulawSkillBindings;

  constructor(
    config: KnowledgeBaseConfig,
    dataDir: string,
    private readonly logger: Logger,
    private readonly costTracker?: Pick<CostTracker, "recordExternalCall"> | undefined,
    private readonly options: { timeoutMs?: number; ttlMs?: number } = {},
  ) {
    const pkulaw = config.authoritySources?.pkulaw;
    this.enabled = pkulaw?.enabled === true;
    this.cliCommand = pkulaw?.cliCommand ?? "pkulaw-mcp";
    this.skills = pkulaw?.skills ?? DEFAULT_SKILLS;
    this.cacheDir = path.join(dataDir, "pkulaw-cache");
  }

  async searchLawSemantic(input: {
    query: string;
    turnId: string;
    sessionId: string;
  }): Promise<PkulawAuthoritySearchResult> {
    const query = input.query.trim();
    const startedAt = Date.now();
    if (!this.enabled) {
      return this.fail("disabled", query, startedAt, "pkulaw 未启用。");
    }
    if (!query) {
      return this.fail("empty", query, startedAt, "未生成可用权威检索词。");
    }

    const skill = this.skills.lawSemantic;
    const cacheKey = buildPkulawCacheKey(skill.tool, skill.operation, query);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return {
        status: "cache-hit",
        query,
        items: normalizePkulawItems(cached.items),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        this.cliCommand,
        [skill.tool, skill.operation, "--text", query, "--json"],
        {
          timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
      const items = normalizePkulawItems(parsePkulawJson(stdout));
      if (items.length === 0) {
        this.logger.log("knowledge/pkulaw", "law semantic returned empty result", {
          stderrPreview: redactEvidenceText(stderr.slice(0, 160)),
        }, "warn");
        return this.fail("empty", query, startedAt, "未检索到权威法规。");
      }
      await this.writeCache(cacheKey, skill.tool, skill.operation, items);
      await this.costTracker?.recordExternalCall({
        turnId: input.turnId,
        sessionId: input.sessionId,
        provider: "pkulaw",
        tool: skill.tool,
        operation: skill.operation,
        durationMs: Date.now() - startedAt,
      });
      return {
        status: "success",
        query,
        items,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = /timed out|timeout|SIGTERM/i.test(detail) ? "timeout" : "error";
      this.logger.log("knowledge/pkulaw", "law semantic query downgraded", {
        status,
        detail: redactEvidenceText(detail.slice(0, 240)),
      }, status === "timeout" ? "warn" : "error");
      return this.fail(status, query, startedAt, status === "timeout" ? "权威检索超时。" : "权威检索不可用。");
    }
  }

  async recognizeLawReferences(input: {
    text: string;
    turnId: string;
    sessionId: string;
  }): Promise<PkulawToolResult<PkulawLawRecognitionItem>> {
    return await this.callTextTool({
      kind: "law-recognition",
      binding: this.skills.lawRecognition,
      text: input.text,
      turnId: input.turnId,
      sessionId: input.sessionId,
      emptyMessage: "未识别到法规名称或条款。",
      normalize: normalizeLawRecognitionItems,
    });
  }

  async validateCitations(input: {
    param: PkulawCitationValidationInput;
    turnId: string;
    sessionId: string;
  }): Promise<PkulawToolResult<PkulawCitationValidationItem>> {
    const payload = JSON.stringify(input.param);
    return await this.callJsonParamTool({
      kind: "citation-validator",
      binding: this.skills.citationValidator,
      payload,
      turnId: input.turnId,
      sessionId: input.sessionId,
      emptyMessage: "未返回可校验法条。",
      normalize: normalizeCitationValidationItems,
    });
  }

  async recognizeCaseNumbers(input: {
    text: string;
    turnId: string;
    sessionId: string;
  }): Promise<PkulawToolResult<PkulawCaseNumberItem>> {
    return await this.callTextTool({
      kind: "case-number-recognition",
      binding: this.skills.caseNumberRecognition,
      text: input.text,
      turnId: input.turnId,
      sessionId: input.sessionId,
      emptyMessage: "未识别到可溯源案号。",
      normalize: normalizeCaseNumberItems,
    });
  }

  private async callTextTool<T>(input: {
    kind: string;
    binding: { tool: string; operation: string };
    text: string;
    turnId: string;
    sessionId: string;
    emptyMessage: string;
    normalize: (value: unknown) => T[];
  }): Promise<PkulawToolResult<T>> {
    const text = input.text.trim();
    return await this.callTool({
      kind: input.kind,
      binding: input.binding,
      inputText: text,
      args: ["--text", text, "--json"],
      turnId: input.turnId,
      sessionId: input.sessionId,
      emptyMessage: input.emptyMessage,
      normalize: input.normalize,
    });
  }

  private async callJsonParamTool<T>(input: {
    kind: string;
    binding: { tool: string; operation: string };
    payload: string;
    turnId: string;
    sessionId: string;
    emptyMessage: string;
    normalize: (value: unknown) => T[];
  }): Promise<PkulawToolResult<T>> {
    return await this.callTool({
      kind: input.kind,
      binding: input.binding,
      inputText: input.payload,
      args: ["--param", input.payload, "--json"],
      turnId: input.turnId,
      sessionId: input.sessionId,
      emptyMessage: input.emptyMessage,
      normalize: input.normalize,
    });
  }

  private async callTool<T>(input: {
    kind: string;
    binding: { tool: string; operation: string };
    inputText: string;
    args: string[];
    turnId: string;
    sessionId: string;
    emptyMessage: string;
    normalize: (value: unknown) => T[];
  }): Promise<PkulawToolResult<T>> {
    const startedAt = Date.now();
    if (!this.enabled) {
      return this.toolFail("disabled", input.inputText, startedAt, "pkulaw 未启用。");
    }
    if (!input.inputText.trim()) {
      return this.toolFail("empty", input.inputText, startedAt, input.emptyMessage);
    }

    const cacheKey = buildPkulawCacheKey(input.binding.tool, input.binding.operation, input.inputText);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return {
        status: "cache-hit",
        input: input.inputText,
        items: input.normalize(cached.items),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        this.cliCommand,
        [input.binding.tool, input.binding.operation, ...input.args],
        {
          timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const items = input.normalize(parsePkulawJson(stdout));
      if (items.length === 0) {
        this.logger.log("knowledge/pkulaw", `${input.kind} returned empty result`, {
          stderrPreview: redactEvidenceText(stderr.slice(0, 160)),
        }, "warn");
        return this.toolFail("empty", input.inputText, startedAt, input.emptyMessage);
      }
      await this.writeCache(cacheKey, input.binding.tool, input.binding.operation, items);
      await this.costTracker?.recordExternalCall({
        turnId: input.turnId,
        sessionId: input.sessionId,
        provider: "pkulaw",
        tool: input.binding.tool,
        operation: input.binding.operation,
        durationMs: Date.now() - startedAt,
      });
      return {
        status: "success",
        input: input.inputText,
        items,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = /timed out|timeout|SIGTERM/i.test(detail) ? "timeout" : "error";
      this.logger.log("knowledge/pkulaw", `${input.kind} downgraded`, {
        status,
        detail: redactEvidenceText(detail.slice(0, 240)),
      }, status === "timeout" ? "warn" : "error");
      return this.toolFail(status, input.inputText, startedAt, status === "timeout" ? "北大法宝调用超时。" : "北大法宝调用不可用。");
    }
  }

  private fail(
    status: "disabled" | "timeout" | "error" | "empty",
    query: string,
    startedAt: number,
    message: string,
  ): PkulawAuthoritySearchResult {
    return {
      status,
      query,
      items: [],
      durationMs: Date.now() - startedAt,
      message,
    };
  }

  private toolFail<T>(
    status: "disabled" | "timeout" | "error" | "empty",
    input: string,
    startedAt: number,
    message: string,
  ): PkulawToolResult<T> {
    return {
      status,
      input,
      items: [],
      durationMs: Date.now() - startedAt,
      message,
    };
  }

  private async readCache(cacheKey: string): Promise<PkulawCacheFile | null> {
    try {
      const raw = await readFile(path.join(this.cacheDir, `${cacheKey}.json`), "utf8");
      const parsed = JSON.parse(raw) as Partial<PkulawCacheFile>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items) || typeof parsed.expiresAt !== "string") {
        return null;
      }
      if (Date.parse(parsed.expiresAt) <= Date.now()) {
        return null;
      }
      return parsed as PkulawCacheFile;
    } catch {
      return null;
    }
  }

  private async writeCache(cacheKey: string, toolName: string, operation: string, items: unknown[]): Promise<void> {
    const now = Date.now();
    const payload: PkulawCacheFile = {
      schemaVersion: 1,
      toolName,
      operation,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
      items,
    };
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(path.join(this.cacheDir, `${cacheKey}.json`), JSON.stringify(payload, null, 2), "utf8");
  }
}

function buildPkulawCacheKey(toolName: string, operation: string, input: string): string {
  return crypto.createHash("sha256").update(`${toolName}\n${operation}\n${input}`).digest("hex");
}

function parsePkulawJson(stdout: string): unknown {
  const objectStart = stdout.indexOf("{");
  const arrayStart = stdout.indexOf("[");
  const jsonStart = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (jsonStart < 0) {
    return [];
  }
  return JSON.parse(stdout.slice(jsonStart));
}

function normalizePkulawItems(value: unknown): PkulawAuthorityItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      title: readString(item, "title") ?? readString(item, "Title") ?? "未命名法规",
      excerpt: readString(item, "article") ?? readString(item, "FullText") ?? readString(item, "summary") ?? "",
      url: readString(item, "url") ?? readString(item, "Url"),
      sourceUpdatedAt: readString(item, "UpdateTime") ?? readString(item, "updateTime"),
      timeliness: readDictionaryText(item, "TimelinessDic"),
    }))
    .filter((item) => item.title || item.excerpt)
    .slice(0, 5)
    .map((item) => ({
      ...item,
      title: redactEvidenceText(item.title),
      excerpt: redactEvidenceText(item.excerpt.slice(0, 300)),
    }));
}

function normalizeLawRecognitionItems(value: unknown): PkulawLawRecognitionItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      text: redactEvidenceText(readString(item, "text") ?? ""),
      original: redactEvidenceText(readString(item, "original") ?? readString(item, "text") ?? ""),
      fulltext: redactEvidenceText((readString(item, "fulltext") ?? "").slice(0, 1200)) || undefined,
      source: readString(item, "source"),
    }))
    .filter((item) => item.text || item.original || item.fulltext)
    .slice(0, 10);
}

function normalizeCitationValidationItems(value: unknown): PkulawCitationValidationItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      title: redactEvidenceText(readString(item, "title") ?? ""),
      articleNumber: readString(item, "article_number") ?? readString(item, "articleNumber") ?? "",
      originalText: redactEvidenceText((readString(item, "original_text") ?? readString(item, "originalText") ?? "").slice(0, 1200)),
      url: readString(item, "url"),
      issueDate: readString(item, "issue_date") ?? readString(item, "issueDate"),
      implementDate: readString(item, "implement_date") ?? readString(item, "implementDate"),
      gid: readString(item, "gid"),
      lib: readString(item, "lib"),
      kuanNumber: readString(item, "kuan_number") ?? readString(item, "kuanNumber"),
    }))
    .filter((item) => item.title || item.originalText)
    .slice(0, 10);
}

function normalizeCaseNumberItems(value: unknown): PkulawCaseNumberItem[] {
  const rows: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>)["anhaoname"])
      ? (value as Record<string, unknown>)["anhaoname"] as unknown[]
      : [];
  return rows
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      text: redactEvidenceText(readString(item, "text") ?? readString(item, "caseFlag") ?? ""),
      start: readNumber(item, "start"),
      end: readNumber(item, "end"),
      gid: readString(item, "gid"),
      caseFlag: redactEvidenceText(readString(item, "caseFlag") ?? ""),
      court: redactEvidenceText(readString(item, "court") ?? ""),
      title: redactEvidenceText(readString(item, "title") ?? ""),
      lastInstanceDate: readString(item, "lastInstanceDate"),
      url: readString(item, "url"),
    }))
    .filter((item) => item.text || item.caseFlag || item.title)
    .slice(0, 10);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readDictionaryText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const labels = Object.values(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return labels.join("、") || undefined;
}
