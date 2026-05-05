/**
 * 职责: 记录 OpenCode turn 的本地 token/成本估算。
 * 关注点:
 * - 优先使用 provider 返回的 usage 字段，缺失时降级为本地估算。
 * - 只记录 token、金额、模型等元数据，不记录 prompt、回复或文件内容。
 * - 为运行时上限拦截、/cost 命令和 portable CLI 提供同一份 ledger。
 */
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeMessage, OpenCodeModelRef } from "../opencode/client.js";

export type UsageSource = "provider" | "estimated" | "external-call";

export type UsageLedgerEntry = {
  schemaVersion: 1;
  createdAt: string;
  turnId: string;
  sessionId: string;
  provider: string;
  model: string;
  source: UsageSource;
  tool?: string | undefined;
  operation?: string | undefined;
  durationMs?: number | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  currency: "CNY";
  estimatedCostCny?: number | undefined;
};

export type CostSummary = {
  totalTokens: number;
  estimatedCostCny?: number | undefined;
  source: UsageSource;
  provider: string;
  model: string;
};

export type CostWindowSummary = {
  entries: UsageLedgerEntry[];
  totalTokens: number;
  estimatedCostCny?: number | undefined;
};

export class CostTracker {
  private readonly ledgerPath: string;
  private readonly resolvedConfig: NonNullable<AppConfig["costs"]>;

  constructor(
    config: AppConfig["costs"] | undefined,
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.ledgerPath = path.join(dataDir, "usage-ledger.jsonl");
    this.resolvedConfig = {
      enabled: config?.enabled ?? true,
      currency: "CNY",
      dailyLimitCny: config?.dailyLimitCny,
      modelPrices: config?.modelPrices ?? {},
    };
  }

  get enabled(): boolean {
    return this.resolvedConfig.enabled;
  }

  get dailyLimitCny(): number | undefined {
    return this.resolvedConfig.dailyLimitCny;
  }

  async recordTurn(input: {
    turnId: string;
    sessionId: string;
    promptText: string;
    replyText: string;
    model?: OpenCodeModelRef | Record<string, unknown> | undefined;
    assistantMessage?: OpenCodeMessage | null | undefined;
  }): Promise<CostSummary | null> {
    if (!this.resolvedConfig.enabled) {
      return null;
    }

    const model = resolveModelLabel(input.model);
    const usage = extractUsage(input.assistantMessage) ?? estimateUsage(input.promptText, input.replyText);
    const price = this.resolvedConfig.modelPrices[`${model.provider}/${model.model}`];
    const estimatedCostCny = price
      ? roundCost(
        usage.inputTokens / 1_000_000 * (price.inputPer1M ?? 0)
        + usage.outputTokens / 1_000_000 * (price.outputPer1M ?? 0)
        + usage.cachedInputTokens / 1_000_000 * (price.cachedInputPer1M ?? price.inputPer1M ?? 0),
      )
      : undefined;
    const entry: UsageLedgerEntry = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      turnId: input.turnId,
      sessionId: input.sessionId,
      provider: model.provider,
      model: model.model,
      source: usage.source,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens + usage.cachedInputTokens,
      currency: "CNY",
      ...(estimatedCostCny !== undefined ? { estimatedCostCny } : {}),
    };

    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await appendFile(this.ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
    this.logger.log("cost/usage", "turn usage recorded", {
      turnId: entry.turnId,
      sessionId: entry.sessionId,
      provider: entry.provider,
      model: entry.model,
      source: entry.source,
      totalTokens: entry.totalTokens,
      estimatedCostCny: entry.estimatedCostCny,
    });

    return {
      totalTokens: entry.totalTokens,
      estimatedCostCny: entry.estimatedCostCny,
      source: entry.source,
      provider: entry.provider,
      model: entry.model,
    };
  }

  async recordExternalCall(input: {
    turnId: string;
    sessionId: string;
    provider: string;
    tool: string;
    operation: string;
    durationMs: number;
  }): Promise<UsageLedgerEntry | null> {
    if (!this.resolvedConfig.enabled) {
      return null;
    }
    const entry: UsageLedgerEntry = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      turnId: input.turnId,
      sessionId: input.sessionId,
      provider: input.provider,
      // 兼容既有 ledger schema；真实工具语义放在 tool / operation。
      model: `${input.provider}/${input.tool}`,
      source: "external-call",
      tool: input.tool,
      operation: input.operation,
      durationMs: input.durationMs,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      currency: "CNY",
    };
    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await appendFile(this.ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
    this.logger.log("cost/usage", "external call recorded", {
      turnId: entry.turnId,
      sessionId: entry.sessionId,
      provider: entry.provider,
      tool: entry.tool,
      operation: entry.operation,
      durationMs: entry.durationMs,
    });
    return entry;
  }

  async summarizeToday(now = new Date()): Promise<CostWindowSummary> {
    const prefix = now.toISOString().slice(0, 10);
    return summarizeEntries((await this.readEntries()).filter((entry) => entry.createdAt.startsWith(prefix)));
  }

  async summarizeMonth(now = new Date()): Promise<CostWindowSummary> {
    const prefix = now.toISOString().slice(0, 7);
    return summarizeEntries((await this.readEntries()).filter((entry) => entry.createdAt.startsWith(prefix)));
  }

  async isDailyLimitExceeded(): Promise<boolean> {
    if (!this.resolvedConfig.enabled || this.resolvedConfig.dailyLimitCny === undefined) {
      return false;
    }
    const today = await this.summarizeToday();
    return (today.estimatedCostCny ?? 0) >= this.resolvedConfig.dailyLimitCny;
  }

  async resetLocal(): Promise<void> {
    await rm(this.ledgerPath, { force: true });
  }

  async readEntries(): Promise<UsageLedgerEntry[]> {
    let raw = "";
    try {
      raw = await readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: UsageLedgerEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as UsageLedgerEntry;
        if (parsed.schemaVersion === 1 && typeof parsed.createdAt === "string") {
          entries.push(parsed);
        }
      } catch {
        // 忽略损坏行，避免一个半写入记录导致整个成本摘要不可用。
      }
    }
    return entries;
  }
}

export function formatCostSummary(summary: CostSummary | null): string {
  if (!summary) {
    return "";
  }
  const sourceLabel = summary.source === "provider" ? "按 provider usage 统计" : "估算";
  const cost = summary.estimatedCostCny === undefined ? "" : `（≈¥${summary.estimatedCostCny.toFixed(4)}，${sourceLabel}）`;
  return `本次约消耗 ${summary.totalTokens} tokens${cost || `（${sourceLabel}）`}`;
}

function summarizeEntries(entries: UsageLedgerEntry[]): CostWindowSummary {
  const totalTokens = entries.reduce((sum, entry) => sum + entry.totalTokens, 0);
  const costValues = entries.map((entry) => entry.estimatedCostCny).filter((value): value is number => typeof value === "number");
  return {
    entries,
    totalTokens,
    ...(costValues.length > 0 ? { estimatedCostCny: roundCost(costValues.reduce((sum, value) => sum + value, 0)) } : {}),
  };
}

function resolveModelLabel(model: OpenCodeModelRef | Record<string, unknown> | undefined): { provider: string; model: string } {
  const provider = typeof model?.providerID === "string" && model.providerID.trim() ? model.providerID.trim() : "opencode-default";
  const modelId = typeof model?.modelID === "string" && model.modelID.trim() ? model.modelID.trim() : "default";
  return { provider, model: modelId };
}

function estimateUsage(promptText: string, replyText: string): {
  source: "estimated";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} {
  return {
    source: "estimated",
    inputTokens: estimateTokens(promptText),
    outputTokens: estimateTokens(replyText),
    cachedInputTokens: 0,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

function extractUsage(message: OpenCodeMessage | null | undefined): {
  source: "provider";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} | null {
  if (!message) {
    return null;
  }
  const candidates = [
    message.info.usage,
    message.info.tokens,
    ...message.parts.map((part) => part.usage),
    ...message.parts.map((part) => part.tokens),
  ].filter(isRecord);

  for (const candidate of candidates) {
    const inputTokens = readNumber(candidate, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
    const outputTokens = readNumber(candidate, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
    const cachedInputTokens = readNumber(candidate, ["cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens"]) ?? 0;
    const totalTokens = readNumber(candidate, ["totalTokens", "total_tokens"]);
    if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
      const resolvedInput = inputTokens ?? Math.max(0, (totalTokens ?? 0) - (outputTokens ?? 0) - cachedInputTokens);
      const resolvedOutput = outputTokens ?? Math.max(0, (totalTokens ?? 0) - resolvedInput - cachedInputTokens);
      return {
        source: "provider",
        inputTokens: resolvedInput,
        outputTokens: resolvedOutput,
        cachedInputTokens,
      };
    }
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundCost(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
