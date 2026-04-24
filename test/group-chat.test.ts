/**
 * 职责: 覆盖群聊消息接入和提及过滤行为。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
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
import { toOpencodePromptText } from "../src/runtime/app-helpers.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";

function createWhitelistStub(initial: Record<string, string[]> = {}) {
  const map = new Map<string, Set<string>>(
    Object.entries(initial).map(([chatId, members]) => [chatId, new Set(members)]),
  );

  return {
    isBound(chatId: string, senderOpenId: string) {
      return map.get(chatId)?.has(senderOpenId) ?? false;
    },
    async bind(chatId: string, senderOpenId: string) {
      const members = map.get(chatId) ?? new Set<string>();
      members.add(senderOpenId);
      map.set(chatId, members);
    },
    async unbind(chatId: string, senderOpenId: string) {
      const members = map.get(chatId);
      if (!members?.has(senderOpenId)) return false;
      members.delete(senderOpenId);
      if (members.size === 0) map.delete(chatId);
      return true;
    },
    count(chatId: string) {
      return map.get(chatId)?.size ?? 0;
    },
  };
}

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
      cardActions: {
        enabled: false,
        path: "/webhook/card",
        verificationToken: "",
        encryptKey: "",
      },
    }),
    ...overrides,
  };
}

function createWhitelist(): ChatWhitelist & { bindings: Map<string, Set<string>> } {
  const bindings = new Map<string, Set<string>>();
  return {
    bindings,
    isBound(chatId, senderOpenId) {
      return bindings.get(chatId)?.has(senderOpenId) ?? false;
    },
    async bind(chatId, senderOpenId) {
      const members = bindings.get(chatId) ?? new Set<string>();
      members.add(senderOpenId);
      bindings.set(chatId, members);
    },
    async unbind(chatId, senderOpenId) {
      const members = bindings.get(chatId);
      if (!members?.has(senderOpenId)) return false;
      members.delete(senderOpenId);
      if (members.size === 0) bindings.delete(chatId);
      return true;
    },
    count(chatId) {
      return bindings.get(chatId)?.size ?? 0;
    },
  };
}

describe("group chat support", () => {
  it("normalizes group text messages using nested mentions and thread keys", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log() {} };
    const client = new FeishuWsClient("app", "secret", makeOptions(), createWhitelistStub(), handler, logger);

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
      threadKey: "main",
      conversationKey: "oc_group_1:main",
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

  it("separates p2p mainline and thread windows while keeping prompts unchanged", () => {
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

    expect(normalized?.threadKey).toBe("main");
    expect(normalized?.conversationKey).toBe("oc_p2p_1:main");
    expect(toOpencodePromptText({
      chatType: normalized?.chatType ?? "p2p",
      senderOpenId: normalized?.senderOpenId ?? "ou_123",
      plainText: normalized?.plainText ?? "",
    })).toBe("请帮我看看这个报错");

    const threaded = normalizeIncomingMessage({
      message: {
        chat_id: "oc_p2p_1",
        chat_type: "p2p",
        message_id: "om_p2p_2",
        root_id: "om_reply_anchor",
        message_type: "text",
        content: JSON.stringify({ text: "在线程里继续" }),
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    }, makeOptions());

    expect(threaded?.threadKey).toBe("om_reply_anchor");
    expect(threaded?.conversationKey).toBe("oc_p2p_1:om_reply_anchor");
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
      chatType: "p2p",
      messageId: "om_4",
    })).toBe("main");

    expect(computeThreadKey({
      chatType: "p2p",
      messageId: "om_4",
      rootId: "om_reply_anchor",
    })).toBe("om_reply_anchor");

    expect(computeThreadKey({
      chatType: "group",
      messageId: "om_5",
    })).toBe("main");

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

    expect(buildConversationKey("p2p", "oc_p2p_1", "main")).toBe("oc_p2p_1:main");
    expect(buildConversationKey("p2p", "oc_p2p_1", "om_reply_anchor")).toBe("oc_p2p_1:om_reply_anchor");
    expect(buildConversationKey("group", "oc_group_3", "main")).toBe("oc_group_3:main");
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
    const client = new FeishuWsClient("app", "secret", makeOptions(), createWhitelistStub(), handler, logger);
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

  it("allows bound group members to continue without mention", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log() {} };
    const client = new FeishuWsClient(
      "app",
      "secret",
      makeOptions(),
      createWhitelistStub({ oc_group_1: ["ou_123"] }),
      handler,
      logger,
    );

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_1",
        chat_type: "group",
        message_id: "om_bound_1",
        message_type: "text",
        content: JSON.stringify({ text: "继续刚才的话题" }),
      },
      sender: {
        sender_id: {
          open_id: "ou_123",
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      plainText: "继续刚才的话题",
      senderOpenId: "ou_123",
    }));
  });

  it("binds a sender after an @bot message and then allows non-mentioned follow-ups", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log: vi.fn() };
    const whitelist = createWhitelist();
    const client = new FeishuWsClient("app", "secret", makeOptions(), whitelist, handler, logger);

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_bind_1",
        chat_type: "group",
        message_id: "om_bind_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> 帮我分析一下' }),
        mentions: [{ id: { open_id: "ou_bot" }, name: "机器人" }],
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_bind_1",
        chat_type: "group",
        message_id: "om_bind_2",
        message_type: "text",
        content: JSON.stringify({ text: "继续刚才的话题" }),
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(whitelist.isBound("oc_group_bind_1", "ou_123")).toBe(true);
  });

  it("keeps dispatching mention messages when best-effort binding fails", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log: vi.fn() };
    const whitelist = {
      isBound() { return false; },
      bind: vi.fn(async () => {
        throw new Error("disk full");
      }),
      async unbind() { return false; },
      count() { return 0; },
    };
    const client = new FeishuWsClient("app", "secret", makeOptions(), whitelist, handler, logger);

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_bind_fail_1",
        chat_type: "group",
        message_id: "om_bind_fail_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> 帮我分析一下' }),
        mentions: [{ id: { open_id: "ou_bot" }, name: "机器人" }],
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    expect(whitelist.bind).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith("store/whitelist", "bind failed", expect.objectContaining({
      chatId: "oc_group_bind_fail_1",
      senderOpenId: "ou_123",
      detail: "disk full",
    }), "warn");
  });

  it("skips unbound non-mentioned group messages with not-whitelisted", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log: vi.fn() };
    const client = new FeishuWsClient("app", "secret", makeOptions(), createWhitelist(), handler, logger);

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_skip_1",
        chat_type: "group",
        message_id: "om_skip_1",
        message_type: "text",
        content: JSON.stringify({ text: "这条不该触发" }),
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith("feishu/ws", "message skipped", expect.objectContaining({
      reason: "not-whitelisted",
      chatId: "oc_group_skip_1",
    }), "warn");
  });

  it("preserves permissive group mode when requireBotMentionInGroup is false", async () => {
    const handler = vi.fn(async () => {});
    const client = new FeishuWsClient(
      "app",
      "secret",
      makeOptions({ requireBotMentionInGroup: false }),
      createWhitelist(),
      handler,
      { log() {} },
    );

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_loose_1",
        chat_type: "group",
        message_id: "om_loose_1",
        message_type: "text",
        content: JSON.stringify({ text: "不带 @ 也应该继续通过" }),
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "oc_group_loose_1",
      plainText: "不带 @ 也应该继续通过",
    }));
  });

  it("allows slash commands with @bot without auto-binding the sender", async () => {
    const handler = vi.fn(async () => {});
    const whitelist = createWhitelist();
    const client = new FeishuWsClient("app", "secret", makeOptions(), whitelist, handler, { log() {} });

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_cmd_1",
        chat_type: "group",
        message_id: "om_cmd_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> /status' }),
        mentions: [{ id: { open_id: "ou_bot" }, name: "机器人" }],
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ plainText: "/status" }));
    expect(whitelist.isBound("oc_group_cmd_1", "ou_123")).toBe(false);
  });

  it("shares the same whitelist across group and topic_group windows", async () => {
    const handler = vi.fn(async () => {});
    const whitelist = createWhitelist();
    const client = new FeishuWsClient("app", "secret", makeOptions(), whitelist, handler, { log() {} });

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_shared_1",
        chat_type: "group",
        message_id: "om_shared_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> 帮我看一下' }),
        mentions: [{ id: { open_id: "ou_bot" }, name: "机器人" }],
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_shared_1",
        chat_type: "topic_group",
        message_id: "om_shared_2",
        root_id: "om_root_1",
        message_type: "text",
        content: JSON.stringify({ text: "话题里继续说" }),
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({
      chatType: "topic_group",
      conversationKey: "oc_group_shared_1:om_root_1",
    }));
  });

  it("allows /who for unbound users without mention", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log() {} };
    const whitelist = {
      isBound() { return false; },
      bind: vi.fn(async () => {}),
      async unbind() { return false; },
      count() { return 0; },
    };
    const client = new FeishuWsClient("app", "secret", makeOptions(), whitelist, handler, logger);

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_1",
        chat_type: "group",
        message_id: "om_who_1",
        message_type: "text",
        content: JSON.stringify({ text: "/who" }),
      },
      sender: {
        sender_id: {
          open_id: "ou_999",
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(whitelist.bind).not.toHaveBeenCalled();
  });

  it("does not bind users for @bot /who", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log() {} };
    const whitelist = {
      isBound() { return false; },
      bind: vi.fn(async () => {}),
      async unbind() { return false; },
      count() { return 0; },
    };
    const client = new FeishuWsClient("app", "secret", makeOptions(), whitelist, handler, logger);

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_1",
        chat_type: "group",
        message_id: "om_who_2",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">OpenCode</at> /who' }),
        mentions: [
          {
            id: { open_id: "ou_bot" },
            name: "OpenCode",
          },
        ],
      },
      sender: {
        sender_id: {
          open_id: "ou_999",
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ plainText: "/who" }));
    expect(whitelist.bind).not.toHaveBeenCalled();
  });

  it("ignores follow-up messages again after a binding is removed", async () => {
    const handler = vi.fn(async () => {});
    const logger = { log: vi.fn() };
    const whitelist = createWhitelist();
    const client = new FeishuWsClient("app", "secret", makeOptions(), whitelist, handler, logger);

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_leave_1",
        chat_type: "group",
        message_id: "om_leave_1",
        message_type: "text",
        content: JSON.stringify({ text: '<at user_id="ou_bot">机器人</at> 先绑定一下' }),
        mentions: [{ id: { open_id: "ou_bot" }, name: "机器人" }],
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    await whitelist.unbind("oc_group_leave_1", "ou_123");

    await (client as unknown as { handleEvent(payload: unknown): Promise<void> }).handleEvent({
      message: {
        chat_id: "oc_group_leave_1",
        chat_type: "group",
        message_id: "om_leave_2",
        message_type: "text",
        content: JSON.stringify({ text: "解绑后这条不该继续触发" }),
      },
      sender: { sender_id: { open_id: "ou_123" } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const lastCall = logger.log.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("feishu/ws");
    expect(lastCall?.[1]).toBe("message skipped");
    expect(lastCall?.[2]).toEqual(expect.objectContaining({
      reason: "not-whitelisted",
      chatId: "oc_group_leave_1",
      messageId: "om_leave_2",
      senderOpenId: "ou_123",
    }));
    expect(lastCall?.[3]).toBe("warn");
  });
});
