/**
 * 职责: 适配北大法宝 law-semantic 权威法规检索。
 * 关注点:
 * - 通过本机 pkulaw-mcp CLI 调用权威源，不在日志或缓存中保存 token。
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
const LAW_SEMANTIC_TOOL = "law-semantic";
const LAW_SEMANTIC_OPERATION = "search_article";
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

type PkulawCacheFile = {
  schemaVersion: 1;
  toolName: typeof LAW_SEMANTIC_TOOL;
  operation: typeof LAW_SEMANTIC_OPERATION;
  createdAt: string;
  expiresAt: string;
  items: PkulawAuthorityItem[];
};

export class PkulawAuthorityService {
  private readonly cacheDir: string;
  private readonly enabled: boolean;
  private readonly cliCommand: string;

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

    const cacheKey = buildPkulawCacheKey(query);
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return {
        status: "cache-hit",
        query,
        items: cached.items,
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        this.cliCommand,
        [LAW_SEMANTIC_TOOL, LAW_SEMANTIC_OPERATION, "--text", query, "--json"],
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
      await this.writeCache(cacheKey, items);
      await this.costTracker?.recordExternalCall({
        turnId: input.turnId,
        sessionId: input.sessionId,
        provider: "pkulaw",
        tool: LAW_SEMANTIC_TOOL,
        operation: LAW_SEMANTIC_OPERATION,
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

  private async writeCache(cacheKey: string, items: PkulawAuthorityItem[]): Promise<void> {
    const now = Date.now();
    const payload: PkulawCacheFile = {
      schemaVersion: 1,
      toolName: LAW_SEMANTIC_TOOL,
      operation: LAW_SEMANTIC_OPERATION,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
      items,
    };
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(path.join(this.cacheDir, `${cacheKey}.json`), JSON.stringify(payload, null, 2), "utf8");
  }
}

function buildPkulawCacheKey(query: string): string {
  return crypto.createHash("sha256").update(`${LAW_SEMANTIC_TOOL}\n${query}`).digest("hex");
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

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDictionaryText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const labels = Object.values(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return labels.join("、") || undefined;
}
