/**
 * 职责: 覆盖Bridge turn 队列行为。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import { QueueRegistry } from "../src/bridge/queue.js";
import type { BridgeTurn } from "../src/bridge/turn.js";

const logger = { log() {}, logTranscript() {} };

function makeTurn(overrides: Partial<BridgeTurn> = {}): BridgeTurn {
  return {
    turnId: "1",
    chatId: "chat",
    conversationKey: "chat:thread",
    threadKey: "thread",
    senderOpenId: "u",
    inboundMessageId: "m",
    plainText: "hi",
    text: "hi",
    ...overrides,
  };
}

describe("QueueRegistry", () => {
  it("accepts first turn without notice", () => {
    const registry = new QueueRegistry(2, logger as any);
    const queue = registry.get("chat");
    const result = queue.enqueue(makeTurn());
    expect(result.accepted).toBe(true);
    expect(result.notice).toBeUndefined();
  });

  it("returns queue notice for later turns", () => {
    const registry = new QueueRegistry(2, logger as any);
    const queue = registry.get("chat");
    queue.enqueue(makeTurn());
    const result = queue.enqueue(makeTurn({ turnId: "2", inboundMessageId: "m2", text: "hello" }));
    expect(result.accepted).toBe(true);
    expect(result.notice?.message).toContain("排在第1位");
  });

  it("rejects when queue is full", () => {
    const registry = new QueueRegistry(1, logger as any);
    const queue = registry.get("chat");
    queue.enqueue(makeTurn());
    queue.enqueue(makeTurn({ turnId: "2", inboundMessageId: "m2", text: "hello" }));
    const result = queue.enqueue(makeTurn({ turnId: "3", inboundMessageId: "m3", text: "hey" }));
    expect(result.accepted).toBe(false);
  });
});
