import { describe, expect, it } from "vitest";

import { ModuleManager, type RuntimeModule } from "../src/bridge/module.js";

describe("module manager", () => {
  it("runs handlers by priority and stops after the first claim", async () => {
    const calls: string[] = [];
    const manager = new ModuleManager();

    manager.register({
      name: "late",
      priority: 20,
      async handleMessage() {
        calls.push("late");
        return { claimed: false };
      },
    } satisfies RuntimeModule);
    manager.register({
      name: "first",
      priority: 10,
      async handleMessage() {
        calls.push("first");
        return { claimed: true };
      },
    } satisfies RuntimeModule);
    manager.register({
      name: "skipped",
      priority: 30,
      async handleMessage() {
        calls.push("skipped");
        return { claimed: false };
      },
    } satisfies RuntimeModule);

    const result = await manager.handleMessage({
      message: {
        chatId: "oc_p2p_1",
        chatType: "p2p",
        senderOpenId: "ou_123",
        messageId: "om_1",
        rawContent: "hello",
        plainText: "hello",
        threadKey: "om_1",
        conversationKey: "oc_p2p_1",
        messageType: "text",
      },
      routed: { kind: "message", text: "hello" },
      pendingInteraction: null,
    });

    expect(result).toEqual({ claimed: true });
    expect(calls).toEqual(["first"]);
  });

  it("collects system blocks and after-turn hooks in priority order", async () => {
    const calls: string[] = [];
    const manager = new ModuleManager();

    manager.register({
      name: "memory",
      priority: 30,
      async beforeTurn() {
        calls.push("before-memory");
        return { systemBlocks: ["[Memory Recall]\n- A", "   "] };
      },
      async afterTurn() {
        calls.push("after-memory");
      },
    } satisfies RuntimeModule);
    manager.register({
      name: "knowledge",
      priority: 20,
      async beforeTurn() {
        calls.push("before-knowledge");
        return { systemBlocks: ["[Knowledge Hint]\n- B"] };
      },
      async afterTurn() {
        calls.push("after-knowledge");
      },
    } satisfies RuntimeModule);

    const turn = {
      turnId: "turn_1",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      threadKey: "om_1",
      chatType: "p2p",
      senderOpenId: "ou_123",
      inboundMessageId: "om_1",
      plainText: "hello",
      text: "hello",
      sessionId: "ses_1",
    };
    const window = {
      mode: "multi" as const,
      activeSessionId: "ses_1",
      sessions: [{ sessionId: "ses_1", label: "当前会话", createdAt: 1, lastUsedAt: 1 }],
      interactionMode: "default" as const,
    };

    const blocks = await manager.collectBeforeTurnBlocks({ turn, window });
    await manager.runAfterTurnHooks({ turn, window, reply: "done" });

    expect(blocks).toEqual([
      "[Knowledge Hint]\n- B",
      "[Memory Recall]\n- A",
    ]);
    expect(calls).toEqual([
      "before-knowledge",
      "before-memory",
      "after-knowledge",
      "after-memory",
    ]);
  });

  it("asks modules to claim file-await-instruction in priority order", async () => {
    const calls: string[] = [];
    const manager = new ModuleManager();

    manager.register({
      name: "knowledge",
      priority: 20,
      async claimFileInstruction() {
        calls.push("knowledge");
        return false;
      },
    } satisfies RuntimeModule);
    manager.register({
      name: "contract",
      priority: 10,
      async claimFileInstruction() {
        calls.push("contract");
        return true;
      },
    } satisfies RuntimeModule);

    const claimed = await manager.claimFileInstruction({
      kind: "file-await-instruction",
      chatId: "oc_p2p_1",
      conversationKey: "oc_p2p_1",
      requesterOpenId: "ou_123",
      replyToMessageId: "om_file",
      file: {
        messageId: "om_file",
        fileKey: "file_1",
        fileName: "invoice.pdf",
      },
    }, {
      chatId: "oc_p2p_1",
      chatType: "p2p",
      senderOpenId: "ou_123",
      messageId: "om_2",
      rawContent: "识别发票",
      plainText: "识别发票",
      threadKey: "om_1",
      conversationKey: "oc_p2p_1",
      messageType: "text",
    });

    expect(claimed).toBe(true);
    expect(calls).toEqual(["contract"]);
  });
});
