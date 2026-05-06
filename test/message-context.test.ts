/**
 * 职责: 覆盖飞书回复消息上下文缓存和 Prompt 拼接逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { BridgeMessageContextStore, prependBridgeMessageContext } from "../src/runtime/message-context.js";
import type { IncomingChatMessage } from "../src/runtime/app.js";

describe("BridgeMessageContextStore", () => {
  const mockLogger = { log() {} };
  const dataDir = "/tmp/bridge-test-context";

  it("builds short-term context when a Feishu reply references a known inbound message", () => {
    const store = new BridgeMessageContextStore(dataDir, mockLogger);
    store.rememberInbound(createTextMessage({
      messageId: "om_source",
      plainText: "请分析这份知识库结果",
    }));

    const context = store.buildPromptBlock(createTextMessage({
      messageId: "om_reply",
      plainText: "基于这条继续",
      rootId: "om_source",
      parentId: "om_source",
    }));

    expect(context).toContain("[Bridge Message Context]");
    expect(context).toContain("sourceMessageId: om_source");
    expect(context).toContain("sourceKind: inbound");
    expect(context).toContain("请分析这份知识库结果");
    expect(prependBridgeMessageContext("基于这条继续", context)).toContain("[User Message]\n基于这条继续");
  });

  it("keeps bridge output summaries available for right-click continuation", () => {
    const store = new BridgeMessageContextStore(dataDir, mockLogger);
    store.rememberBridgeOutput({
      messageId: "om_card",
      chatId: "oc_p2p_1",
      replyToMessageId: "om_source",
      summary: "知识库查询完成：召回 3 条材料",
    });

    const context = store.buildPromptBlock(createTextMessage({
      messageId: "om_reply",
      plainText: "整理成知识条目",
      parentId: "om_card",
    }));

    expect(context).toContain("sourceMessageId: om_card");
    expect(context).toContain("sourceKind: bridge-output");
    expect(context).toContain("知识库查询完成：召回 3 条材料");
  });

  it("restores persisted bridge outputs without persisting inbound messages", async () => {
    const tempDir = path.join(os.tmpdir(), `bridge-test-context-${Date.now()}`);
    try {
      const store = new BridgeMessageContextStore(tempDir, mockLogger);
      store.rememberInbound(createTextMessage({ messageId: "om_inbound", plainText: "这条用户消息不应持久化" }));
      store.rememberBridgeOutput({
        messageId: "om_card",
        chatId: "oc_p2p_1",
        summary: "劳动分析完成：焦点 2 个",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const restored = new BridgeMessageContextStore(tempDir, mockLogger);
      await restored.restore();

      const bridgeContext = restored.buildRuntimeContext(createTextMessage({ messageId: "om_reply", parentId: "om_card" }));
      expect(bridgeContext).toHaveLength(1);
      expect(bridgeContext[0]).toEqual(expect.objectContaining({
        kind: "system-result",
        summary: "劳动分析完成：焦点 2 个",
      }));
      expect(restored.buildPromptBlock(createTextMessage({ messageId: "om_reply_2", parentId: "om_inbound" }))).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips empty bridge outputs", () => {
    const store = new BridgeMessageContextStore(dataDir, mockLogger);
    store.rememberBridgeOutput({
      messageId: "om_empty",
      chatId: "oc_p2p_1",
      summary: "   ",
    });

    expect(store.buildRuntimeContext(createTextMessage({ messageId: "om_reply", parentId: "om_empty" }))).toEqual([]);
  });
});

function createTextMessage(overrides: Partial<IncomingChatMessage> = {}): IncomingChatMessage {
  return {
    chatId: "oc_p2p_1",
    chatType: "p2p",
    senderOpenId: "ou_123",
    messageId: "om_1",
    messageType: "text",
    rawContent: "hello",
    plainText: "hello",
    threadKey: "main",
    conversationKey: "oc_p2p_1:main",
    ...overrides,
  } as IncomingChatMessage;
}
