import { describe, expect, it, vi } from "vitest";

vi.mock("@larksuiteoapi/node-sdk", () => {
  class EventDispatcher {
    register() {
      return this;
    }
  }

  class WSClient {
    async start() {}
    stop() {}
  }

  return { EventDispatcher, WSClient };
});

import { FeishuWsClient, buildConversationKey, computeThreadKey, createFeishuIngressOptions, normalizeIncomingMessage } from "../src/feishu/ws.js";
import { toOpencodePromptText } from "../src/runtime/app.js";

function makeOptions(overrides?: Partial<ReturnType<typeof createFeishuIngressOptions>>) {
  return {
    ...createFeishuIngressOptions({
      appId: "app",
      appSecret: "secret",
      botOpenId: "ou_bot",
      botOpenIds: new Set(),
      botMentionNames: new Set(["opencode"]),
      selfBotOpenId: "ou_bot",
      selfBotOpenIds: new Set(["ou_bot"]),
      wsUrl: new URL("wss://open.feishu.cn/open-apis/ws/v2"),
      allowedOpenIds: new Set(),
      behavior: {
        enableP2p: true,
        enableGroup: true,
        requireBotMentionInGroup: true,
        strictBotMention: true,
        ignoreNonUserSenders: true,
        replyInThread: true,
      },
    }),
    ...overrides,
  };
}

describe("group chat support", () => {
  it("normalizes group text messages using nested mentions and thread keys", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log() {} };
    const client = new FeishuWsClient("app", "secret", makeOptions(), handler, logger);

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_1",
        chat_type: "group",
        message_id: "om_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> 大家好' }),
        mentions: [
          {
            id: {
              open_id: "ou_bot",
            },
            name: "机器人",
          },
        ],
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      chatId: "oc_group_1",
      chatType: "group",
      senderOpenId: "ou_123",
      messageId: "om_1",
      messageType: "text",
      rawContent: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> 大家好' }),
      plainText: "大家好",
      rootId: undefined,
      parentId: undefined,
      threadKey: "om_1",
      conversationKey: "oc_group_1:om_1",
    });
  });

  it("ignores group messages that only mention other users in strict mode", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_1",
        chat_type: "group",
        message_id: "om_2",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_other">张三</at> 帮我看下' }),
        mentions: [
          {
            id: {
              open_id: "ou_other",
            },
            name: "张三",
          },
        ],
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    }, makeOptions());

    expect(normalized).toBeNull();
  });

  it("requires botOpenId for strict group mention matching", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_1",
        chat_type: "group",
        message_id: "om_3",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> 请帮我看看' }),
      },
      sender: {
        sender_id: {
          open_id: "ou_456",
        },
      },
    }, makeOptions({ botOpenIds: new Set() }));

    expect(normalized).toBeNull();
  });

  it("accepts bot senders when they mention a configured bot identity", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_bot",
        chat_type: "group",
        message_id: "om_bot_mention_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">opencode</at> 帮我总结一下' }),
        mentions: [
          {
            id: {
              open_id: "ou_bot",
            },
            name: "opencode",
          },
        ],
      },
      sender: {
        sender_type: "ASSISTANT",
        sender_id: {
          open_id: "ou_other_bot",
        },
      },
    }, makeOptions({ selfBotOpenIds: new Set(["ou_bot"]) }));

    expect(normalized?.plainText).toBe("帮我总结一下");
    expect(normalized?.senderOpenId).toBe("ou_other_bot");
  });

  it("falls back to sender user_id when open_id is missing", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_bot_user_id",
        chat_type: "group",
        message_id: "om_bot_user_id_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">opencode</at> 帮我看一下' }),
        mentions: [
          {
            id: {
              open_id: "ou_bot",
            },
            name: "opencode",
          },
        ],
      },
      sender: {
        sender_type: "ASSISTANT",
        sender_id: {
          user_id: "u_other_bot",
        },
      },
    }, makeOptions());

    expect(normalized?.senderOpenId).toBe("u_other_bot");
    expect(normalized?.plainText).toBe("帮我看一下");
  });

  it("ignores self-sent bot messages to avoid reply loops", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_self_bot",
        chat_type: "group",
        message_id: "om_self_bot_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">opencode</at> 这是我自己发的' }),
        mentions: [
          {
            id: {
              open_id: "ou_bot",
            },
            name: "opencode",
          },
        ],
      },
      sender: {
        sender_type: "ASSISTANT",
        sender_id: {
          open_id: "ou_bot",
        },
      },
    }, makeOptions());

    expect(normalized).toBeNull();
  });

  it("separates trigger identities from self bot identities", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_split",
        chat_type: "group",
        message_id: "om_split_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_trigger">opencode</at> 看一下' }),
        mentions: [
          {
            id: {
              open_id: "ou_trigger",
            },
            name: "opencode",
          },
        ],
      },
      sender: {
        sender_type: "ASSISTANT",
        sender_id: {
          open_id: "ou_trigger",
        },
      },
    }, makeOptions({ botOpenIds: new Set(["ou_trigger"]), selfBotOpenIds: new Set(["ou_bot"]) }));

    expect(normalized?.plainText).toBe("看一下");
  });

  it("matches configured mention names when mention ids do not match", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_name_match",
        chat_type: "group",
        message_id: "om_name_match_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_unknown">Open Code</at> 帮忙看一下' }),
        mentions: [
          {
            id: {
              open_id: "ou_unknown",
            },
            name: "Open Code",
          },
        ],
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    }, makeOptions({ botOpenIds: new Set(["ou_bot"]), botMentionNames: new Set(["opencode", "open code"]) }));

    expect(normalized?.plainText).toBe("帮忙看一下");
  });

  it("parses post messages with non-zh locale keys", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_2",
        chat_type: "group",
        message_id: "om_4",
        root_id: "om_root",
        message_type: "post",
        content: JSON.stringify({
          en_us: {
            title: "",
            content: [[
              { tag: "at", user_id: "ou_bot", user_name: "Robot" },
              { tag: "text", text: " please help " },
              { tag: "at", user_id: "ou_other", user_name: "Alice" },
            ]],
          },
        }),
      },
      sender: {
        sender_id: {
          open_id: "ou_789",
        },
      },
    }, makeOptions());

    expect(normalized).toEqual({
      chatId: "oc_group_2",
      chatType: "group",
      senderOpenId: "ou_789",
      messageId: "om_4",
      messageType: "post",
      rawContent: JSON.stringify({
        en_us: {
          title: "",
          content: [[
            { tag: "at", user_id: "ou_bot", user_name: "Robot" },
            { tag: "text", text: " please help " },
            { tag: "at", user_id: "ou_other", user_name: "Alice" },
          ]],
        },
      }),
      plainText: "please help @Alice",
      rootId: "om_root",
      parentId: undefined,
      threadKey: "om_root",
      conversationKey: "oc_group_2:om_root",
    });
  });

  it("keeps p2p conversation keys flat and leaves prompts unchanged", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_p2p_1",
        chat_type: "p2p",
        message_id: "om_p2p_1",
        message_type: "text",
        content: JSON.stringify({ text: "请帮我看看这个报错" }),
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    }, makeOptions());

    expect(normalized?.conversationKey).toBe("oc_p2p_1");
    expect(toOpencodePromptText({
      chatType: normalized?.chatType ?? "p2p",
      senderOpenId: normalized?.senderOpenId ?? "ou_123",
      plainText: normalized?.plainText ?? "",
    })).toBe("请帮我看看这个报错");
  });

  it("formats group prompts with sender context", () => {
    expect(toOpencodePromptText({
      chatType: "group",
      senderOpenId: "ou_123",
      plainText: "请帮我看看这个报错",
    })).toBe("[群聊消息][发送者 ou_123]\n请帮我看看这个报错");
  });

  it("computes thread and conversation keys deterministically", () => {
    expect(computeThreadKey({
      chatType: "group",
      messageId: "om_5",
      rootId: "om_root",
      parentId: "om_parent",
    })).toBe("om_root");

    expect(computeThreadKey({
      chatType: "group",
      messageId: "om_5",
      parentId: "om_parent",
    })).toBe("om_parent");

    expect(buildConversationKey("topic_group", "oc_group_3", "om_root")).toBe("oc_group_3:om_root");
  });

  it("can disable strict mention matching from config", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_9",
        chat_type: "group",
        message_id: "om_9",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_other">张三</at> 看一下' }),
        mentions: [
          {
            id: { open_id: "ou_other" },
            name: "张三",
            key: "ou_other",
          },
        ],
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    }, makeOptions({ strictBotMention: false }));

    expect(normalized?.plainText).toBe("@张三 看一下");
  });

  it("matches any configured bot identity", () => {
    const normalized = normalizeIncomingMessage({
      message: {
        chat_id: "oc_group_10",
        chat_type: "group",
        message_id: "om_10",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_opencode">opencode</at> 继续' }),
        mentions: [
          {
            id: { open_id: "ou_opencode" },
            name: "opencode",
            key: "ou_opencode",
          },
        ],
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    }, makeOptions({ botOpenIds: new Set(["ou_bot", "ou_opencode"]) }));

    expect(normalized?.plainText).toBe("继续");
  });

  it("deduplicates repeated deliveries with the same message id", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log() {} };
    const client = new FeishuWsClient("app", "secret", makeOptions(), handler, logger);
    const payload = {
      message: {
        chat_id: "oc_p2p_1",
        chat_type: "p2p",
        message_id: "om_dup_1",
        message_type: "text",
        content: JSON.stringify({ text: "早上好" }),
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    };

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent(payload);
    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent(payload);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
