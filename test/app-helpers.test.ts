import { describe, expect, it } from "vitest";

import { buildBridgeSystemPrompt, buildPromptRequest, composeSystemPrompt, resolveDisplayLabel, summarizeSessionLabel, upsertToolUpdate } from "../src/runtime/app-helpers.js";

describe("runtime prompt helpers", () => {
  it("adds system state when provided", () => {
    expect(buildPromptRequest("hello", "state")).toEqual({
      system: "state",
      parts: [{ type: "text", text: "hello" }],
    });
  });

  it("joins bridge state and memory recall without touching user text", () => {
    expect(composeSystemPrompt("[Bridge State]\nwindowType: p2p", "[Memory Recall]\n- 用户喜欢 TypeScript")).toBe(
      "[Bridge State]\nwindowType: p2p\n\n[Memory Recall]\n- 用户喜欢 TypeScript",
    );
  });

  it("builds bridge system state from the current window", () => {
    const prompt = buildBridgeSystemPrompt({
      chatType: "group",
      conversationKey: "oc_group_1:om_1",
      senderOpenId: "ou_123",
      sessionId: "ses_2",
    }, {
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "当前会话", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "旧会话", createdAt: 1, lastUsedAt: 1 },
      ],
    });

    expect(prompt).toContain("windowType: group");
    expect(prompt).toContain("sessionMode: multi");
    expect(prompt).toContain("activeSessionId: ses_2");
    expect(prompt).toContain("* 当前会话 (ses_2)");
    expect(prompt).toContain("Bridge owns /new /sessions /switch /status");
  });

  it("keeps local labels until they are still raw session ids", () => {
    expect(resolveDisplayLabel({
      id: "ses_1",
      title: "Feishu chat title",
    }, "新会话", "ses_1")).toBe("新会话");

    expect(resolveDisplayLabel({
      id: "ses_1",
      title: "Feishu chat title",
    }, "自定义标签", "ses_1")).toBe("自定义标签");

    expect(resolveDisplayLabel({
      id: "ses_1",
      title: "Feishu chat title",
    }, "ses_1", "ses_1")).toBe("Feishu chat title");
  });

  it("normalizes bridge-generated raw Feishu session titles", () => {
    expect(resolveDisplayLabel({
      id: "ses_1",
      title: "Feishu oc_4567a3759d43051bf069a6cb9ad69931",
    }, "ses_1", "ses_1")).toBe("【私聊】未命名会话");

    expect(resolveDisplayLabel({
      id: "ses_2",
      title: "Feishu group oc_4567a3759d43051bf069a6cb9ad69931 om_xxx",
    }, "ses_2", "ses_2")).toBe("【群聊】未命名会话");
  });

  it("adds conversation tags to summarized session labels", () => {
    expect(summarizeSessionLabel("帮我写个单测", "p2p")).toBe("【私聊】帮我写个单测");
    expect(summarizeSessionLabel("讨论提测计划", "group")).toBe("【群聊】讨论提测计划");
  });

  it("keeps all tool updates instead of trimming old entries", () => {
    let updates: Array<{ key: string; view: { label: string; detail: string; status: "pending" | "running" | "completed" | "error" | "unknown" } }> = [];

    for (let index = 0; index < 9; index += 1) {
      updates = upsertToolUpdate(updates, `tool-${index}`, {
        label: `工具 ${index}`,
        detail: `detail-${index}`,
        status: "completed",
      });
    }

    expect(updates).toHaveLength(9);
    expect(updates[0]?.view.label).toBe("工具 0");
    expect(updates[8]?.view.label).toBe("工具 8");
  });
});
