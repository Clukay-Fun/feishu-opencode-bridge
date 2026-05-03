/**
 * 职责: 覆盖 runtime 成本 ledger 与 token 估算逻辑。
 * 关注点:
 * - 优先使用 OpenCode/provider usage 字段。
 * - 缺失 usage 时降级为本地估算并避免记录用户原文。
 * - 日上限判断基于本地 ledger 汇总。
 */
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CostTracker, formatCostSummary } from "../src/runtime/cost-tracker.js";

describe("CostTracker", () => {
  it("records provider usage and estimates configured model cost", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-cost-provider-"));
    const tracker = new CostTracker({
      enabled: true,
      currency: "CNY",
      modelPrices: {
        "openai/gpt-test": {
          inputPer1M: 10,
          outputPer1M: 20,
          cachedInputPer1M: 1,
        },
      },
    }, dir, fakeLogger());

    const summary = await tracker.recordTurn({
      turnId: "turn_1",
      sessionId: "ses_1",
      promptText: "secret prompt should not be persisted",
      replyText: "secret reply should not be persisted",
      model: { providerID: "openai", modelID: "gpt-test" },
      assistantMessage: {
        info: {
          role: "assistant",
          usage: {
            inputTokens: 1000,
            outputTokens: 2000,
            cachedInputTokens: 3000,
          },
        },
        parts: [],
      },
    });

    expect(summary).toMatchObject({
      source: "provider",
      totalTokens: 6000,
      estimatedCostCny: 0.053,
    });
    const ledger = await readFile(path.join(dir, "usage-ledger.jsonl"), "utf8");
    expect(ledger).not.toContain("secret prompt");
    expect(ledger).not.toContain("secret reply");
    expect(formatCostSummary(summary)).toContain("按 provider usage 统计");
  });

  it("falls back to token estimates and enforces daily limit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-cost-estimated-"));
    const tracker = new CostTracker({
      enabled: true,
      currency: "CNY",
      dailyLimitCny: 0.0001,
      modelPrices: {
        "opencode-default/default": {
          inputPer1M: 100,
          outputPer1M: 100,
        },
      },
    }, dir, fakeLogger());

    const summary = await tracker.recordTurn({
      turnId: "turn_2",
      sessionId: "ses_2",
      promptText: "这是一段用户输入",
      replyText: "这是一段模型回复",
    });

    expect(summary?.source).toBe("estimated");
    expect(summary?.totalTokens).toBeGreaterThan(0);
    await expect(tracker.isDailyLimitExceeded()).resolves.toBe(true);
  });
});

function fakeLogger() {
  return {
    log: vi.fn(),
    logTranscript: vi.fn(),
  };
}
