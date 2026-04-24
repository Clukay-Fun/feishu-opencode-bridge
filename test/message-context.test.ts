/**
 * 职责: 覆盖飞书回复消息上下文缓存和 Prompt 拼接逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import { BridgeMessageContextStore, prependBridgeMessageContext } from "../src/runtime/message-context.js";
import type { IncomingChatMessage } from "../src/runtime/app.js";

describe("BridgeMessageContextStore", () => {
  it("builds short-term context when a Feishu reply references a known inbound message", () => {
    const store = new BridgeMessageContextStore();
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
    const store = new BridgeMessageContextStore();
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
