import { describe, expect, it } from "vitest";

import { QueueRegistry } from "../src/bridge/queue.js";

const logger = { log() {}, logTranscript() {} };

describe("QueueRegistry", () => {
  it("accepts first turn without notice", () => {
    const registry = new QueueRegistry(2, logger as any);
    const queue = registry.get("chat");
    const result = queue.enqueue({ turnId: "1", chatId: "chat", senderOpenId: "u", inboundMessageId: "m", text: "hi" });
    expect(result.accepted).toBe(true);
    expect(result.notice).toBeUndefined();
  });

  it("returns queue notice for later turns", () => {
    const registry = new QueueRegistry(2, logger as any);
    const queue = registry.get("chat");
    queue.enqueue({ turnId: "1", chatId: "chat", senderOpenId: "u", inboundMessageId: "m", text: "hi" });
    const result = queue.enqueue({ turnId: "2", chatId: "chat", senderOpenId: "u", inboundMessageId: "m2", text: "hello" });
    expect(result.accepted).toBe(true);
    expect(result.notice?.message).toContain("排在第1位");
  });

  it("rejects when queue is full", () => {
    const registry = new QueueRegistry(1, logger as any);
    const queue = registry.get("chat");
    queue.enqueue({ turnId: "1", chatId: "chat", senderOpenId: "u", inboundMessageId: "m", text: "hi" });
    queue.enqueue({ turnId: "2", chatId: "chat", senderOpenId: "u", inboundMessageId: "m2", text: "hello" });
    const result = queue.enqueue({ turnId: "3", chatId: "chat", senderOpenId: "u", inboundMessageId: "m3", text: "hey" });
    expect(result.accepted).toBe(false);
  });
});
