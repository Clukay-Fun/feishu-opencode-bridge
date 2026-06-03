/**
 * 职责: 覆盖 turn 过程卡管理器的内存态聚合行为。
 * 关注点: 验证 reasoning 累积、截断和空文本处理不会污染运行时卡片。
 */
import { describe, expect, it, vi } from "vitest";

import { TurnCardManager } from "../src/runtime/turn-card-manager.js";
import type { FeishuPostPayload } from "../src/feishu/shared-primitives.js";
import type { Logger } from "../src/logging/logger.js";

describe("TurnCardManager reasoning accumulation", () => {
  it("ignores blank reasoning chunks", async () => {
    const { manager, updates } = createManager();
    await manager.createTurnCard("oc_1", "turn_1", "ses_1", "om_1");

    manager.appendReasoning("turn_1", "");
    manager.appendReasoning("turn_1", "   \n  ");
    await manager.updateTurnCard("turn_1", { update: "仍在处理", target: "step" });

    expect(JSON.stringify(readInteractive(updates.at(-1)))).not.toContain("collapsible_panel");
  });

  it("joins reasoning chunks with a stable paragraph separator", async () => {
    const { manager, updates } = createManager();
    await manager.createTurnCard("oc_1", "turn_1", "ses_1", "om_1");

    manager.appendReasoning("turn_1", "第一段");
    manager.appendReasoning("turn_1", "第二段");
    await manager.updateTurnCard("turn_1", { update: "仍在处理", target: "step" });

    const panel = findByTag(readInteractive(updates.at(-1)), "collapsible_panel");
    const markdown = readPanelBodyMarkdown(panel);
    expect(markdown?.content).toContain("第一段\n\n第二段");
  });

  it("keeps accumulated reasoning within the hard memory limit", async () => {
    const { manager } = createManager();
    await manager.createTurnCard("oc_1", "turn_1", "ses_1", "om_1");

    manager.appendReasoning("turn_1", "a".repeat(7_999));
    manager.appendReasoning("turn_1", "bbbbbbbbbb");

    const card = (manager as unknown as { turnCards: Map<string, { reasoningText: string }> }).turnCards.get("turn_1");
    expect(card?.reasoningText).toHaveLength(7_999);
    expect(card?.reasoningText).not.toContain("b");
  });

  it("truncates the final chunk after accounting for the separator", async () => {
    const { manager } = createManager();
    await manager.createTurnCard("oc_1", "turn_1", "ses_1", "om_1");

    manager.appendReasoning("turn_1", "a".repeat(7_990));
    manager.appendReasoning("turn_1", "bbbbbbbbbb");

    const card = (manager as unknown as { turnCards: Map<string, { reasoningText: string }> }).turnCards.get("turn_1");
    expect(card?.reasoningText).toHaveLength(8_000);
    expect(card?.reasoningText.endsWith("bbbbbbbb")).toBe(true);
  });
});

function createManager() {
  const updates: FeishuPostPayload[] = [];
  const manager = new TurnCardManager({
    sendMessage: vi.fn(async () => ({ messageId: "om_process" })),
    replyMessage: vi.fn(async () => ({ messageId: "om_process" })),
    updateMessage: vi.fn(async (_messageId, payload) => {
      updates.push(payload);
      return { messageId: "om_process" };
    }),
  }, createSilentLogger(), true);
  return { manager, updates };
}

function createSilentLogger(): Logger {
  return {
    log() {},
    logTranscript() {},
  };
}

function readInteractive(payload: FeishuPostPayload | undefined): Record<string, unknown> {
  if (!payload) throw new Error("missing payload");
  return JSON.parse(payload.content) as Record<string, unknown>;
}

function findByTag(value: unknown, tag: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if ((value as Record<string, unknown>).tag === tag) return value as Record<string, unknown>;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findByTag(item, tag);
        if (found) return found;
      }
      continue;
    }
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return null;
}

function readPanelBodyMarkdown(panel: Record<string, unknown> | null): Record<string, unknown> | null {
  const elements = panel?.elements;
  if (!Array.isArray(elements)) return null;
  const first = elements[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : null;
}
