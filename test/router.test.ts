/**
 * 职责: 覆盖桥接命令路由解析逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import { routeIncomingText } from "../src/bridge/router.js";

describe("routeIncomingText", () => {
  it("routes built-in session and status commands", () => {
    expect(routeIncomingText("/status")).toEqual({
      kind: "command",
      command: { kind: "status" },
    });
    expect(routeIncomingText("/new")).toEqual({
      kind: "command",
      command: { kind: "new" },
    });
    expect(routeIncomingText("/new 劳动争议分析")).toEqual({
      kind: "command",
      command: { kind: "new", title: "劳动争议分析" },
    });
    expect(routeIncomingText("/rename 合同起草")).toEqual({
      kind: "command",
      command: { kind: "rename", title: "合同起草" },
    });
    expect(routeIncomingText("/help")).toEqual({
      kind: "command",
      command: { kind: "help" },
    });
    expect(routeIncomingText("/commands")).toEqual({
      kind: "command",
      command: { kind: "help" },
    });
    expect(routeIncomingText("/指令")).toEqual({
      kind: "command",
      command: { kind: "help" },
    });
    expect(routeIncomingText("/cost")).toEqual({
      kind: "command",
      command: { kind: "cost" },
    });
  });

  it("does not route multiline markdown text that contains slash-like content as a command", () => {
    const text = [
      "/文本不是指令",
      "",
      "这是用户粘贴的 Markdown 正文。",
      "- 路径：/Users/example/material.md",
    ].join("\n");

    expect(routeIncomingText(text)).toEqual({
      kind: "message",
      text,
    });
  });

  it("routes /sessions <index> without accepting bare numbers", () => {
    expect(routeIncomingText("/sessions 3")).toEqual({
      kind: "command",
      command: { kind: "sessions-select", index: 3 },
    });
    expect(routeIncomingText("/sessions preview 3")).toEqual({
      kind: "command",
      command: { kind: "session-preview", index: 3 },
    });
    expect(routeIncomingText("/sessions preview ses_abc")).toEqual({
      kind: "command",
      command: { kind: "session-preview", sessionId: "ses_abc" },
    });
    expect(routeIncomingText("3 个文件要处理")).toEqual({
      kind: "message",
      text: "3 个文件要处理",
    });
  });

  it("routes /switch <index> to session selection", () => {
    expect(routeIncomingText("/switch 2")).toEqual({
      kind: "command",
      command: { kind: "sessions-select", index: 2 },
    });
    expect(routeIncomingText("/preview 2")).toEqual({
      kind: "command",
      command: { kind: "session-preview", index: 2 },
    });
    expect(routeIncomingText("/preview ses_abc")).toEqual({
      kind: "command",
      command: { kind: "session-preview", sessionId: "ses_abc" },
    });
    expect(routeIncomingText("/switch 日常聊天")).toEqual({
      kind: "command",
      command: { kind: "sessions-select", query: "日常聊天" },
    });
  });

  it("routes close and delete session commands", () => {
    expect(routeIncomingText("/sessions all")).toEqual({
      kind: "command",
      command: { kind: "sessions-all" },
    });
    expect(routeIncomingText("/close")).toEqual({
      kind: "command",
      command: { kind: "close" },
    });
    expect(routeIncomingText("/close all")).toEqual({
      kind: "command",
      command: { kind: "close", all: true },
    });
    expect(routeIncomingText("/close 2")).toEqual({
      kind: "command",
      command: { kind: "close", index: 2 },
    });
    expect(routeIncomingText("/close 1-10")).toEqual({
      kind: "command",
      command: { kind: "close", range: { start: 1, end: 10 } },
    });
    expect(routeIncomingText("/delete")).toEqual({
      kind: "command",
      command: { kind: "delete", confirm: false },
    });
    expect(routeIncomingText("/delete all")).toEqual({
      kind: "command",
      command: { kind: "delete", all: true, confirm: false },
    });
    expect(routeIncomingText("/delete all confirm")).toEqual({
      kind: "command",
      command: { kind: "delete", all: true, confirm: true },
    });
    expect(routeIncomingText("/delete 2")).toEqual({
      kind: "command",
      command: { kind: "delete", index: 2, confirm: false },
    });
    expect(routeIncomingText("/delete 2-6")).toEqual({
      kind: "command",
      command: { kind: "delete", range: { start: 2, end: 6 }, confirm: false },
    });
    expect(routeIncomingText("/delete confirm")).toEqual({
      kind: "command",
      command: { kind: "delete", confirm: true },
    });
    expect(routeIncomingText("/delete 2 confirm")).toEqual({
      kind: "command",
      command: { kind: "delete", index: 2, confirm: true },
    });
    expect(routeIncomingText("/delete 2-6 confirm")).toEqual({
      kind: "command",
      command: { kind: "delete", range: { start: 2, end: 6 }, confirm: true },
    });
  });

  it("routes permission commands", () => {
    expect(routeIncomingText("/allow once")).toEqual({
      kind: "command",
      command: { kind: "allow", policy: "once" },
    });
    expect(routeIncomingText("/允许一次")).toEqual({
      kind: "command",
      command: { kind: "allow", policy: "once" },
    });
    expect(routeIncomingText("/始终允许")).toEqual({
      kind: "command",
      command: { kind: "allow", policy: "always" },
    });
    expect(routeIncomingText("/deny")).toEqual({
      kind: "command",
      command: { kind: "deny" },
    });
    expect(routeIncomingText("/拒绝")).toEqual({
      kind: "command",
      command: { kind: "deny" },
    });
  });

  it("treats removed and unknown commands as passthrough", () => {
    expect(routeIncomingText("/who")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "who", arguments: [] },
    });
    expect(routeIncomingText("/leave")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "leave", arguments: [] },
    });
    expect(routeIncomingText("/unknown-command")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "unknown-command", arguments: [] },
    });
  });

  it("routes knowledge base commands", () => {
    expect(routeIncomingText("/kb-ingest")).toEqual({
      kind: "command",
      command: { kind: "knowledge-ingest" },
    });
    expect(routeIncomingText("/kb-ingest-start")).toEqual({
      kind: "command",
      command: { kind: "knowledge-ingest" },
    });
    expect(routeIncomingText("/kb-ingest-end")).toEqual({
      kind: "command",
      command: { kind: "knowledge-ingest-end" },
    });
    expect(routeIncomingText("/知识入库结束")).toEqual({
      kind: "command",
      command: { kind: "knowledge-ingest-end" },
    });
    expect(routeIncomingText("/知识入库完成")).toEqual({
      kind: "command",
      command: { kind: "knowledge-ingest-end" },
    });
    expect(routeIncomingText("/法律咨询开始")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "法律咨询开始", arguments: [] },
    });
    expect(routeIncomingText("/法律咨询结束")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "法律咨询结束", arguments: [] },
    });
    expect(routeIncomingText("/法律问答 员工试用期最长多久？")).toEqual({
      kind: "command",
      command: { kind: "knowledge-query", question: "员工试用期最长多久？", explicit: true },
    });
    expect(routeIncomingText("/法律咨询 员工试用期最长多久？")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "法律咨询", arguments: ["员工试用期最长多久？"] },
    });
    expect(routeIncomingText("/kb-query 员工试用期最长多久？")).toEqual({
      kind: "command",
      command: { kind: "knowledge-query", question: "员工试用期最长多久？", explicit: true },
    });
    expect(routeIncomingText("/知识入库")).toEqual({
      kind: "command",
      command: { kind: "knowledge-ingest" },
    });
    expect(routeIncomingText("/legal-query-start")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "legal-query-start", arguments: [] },
    });
    expect(routeIncomingText("/legal-query-end")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "legal-query-end", arguments: [] },
    });
    expect(routeIncomingText("/legal-query 员工试用期最长多久？")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "legal-query", arguments: ["员工试用期最长多久？"] },
    });
  });

  it("routes /models to provider listing and model switch commands to bridge-owned window overrides", () => {
    expect(routeIncomingText("/models")).toEqual({
      kind: "command",
      command: { kind: "models" },
    });
    expect(routeIncomingText("/models openai")).toEqual({
      kind: "command",
      command: { kind: "models", provider: "openai" },
    });
    expect(routeIncomingText("/sessions all 劳动")).toEqual({
      kind: "command",
      command: { kind: "sessions-all", query: "劳动" },
    });
    expect(routeIncomingText("/sessions find 劳动 争议")).toEqual({
      kind: "command",
      command: { kind: "sessions-all", query: "劳动 争议" },
    });
    expect(routeIncomingText("/model")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "model", arguments: [] },
    });
    expect(routeIncomingText("/model openai")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "model", arguments: ["openai"] },
    });
    expect(routeIncomingText("/model use openai/gpt-5.4")).toEqual({
      kind: "command",
      command: { kind: "model-use", model: "openai/gpt-5.4" },
    });
    expect(routeIncomingText("/model reset")).toEqual({
      kind: "command",
      command: { kind: "model-reset" },
    });
  });

  it("routes direct session id deletion commands", () => {
    expect(routeIncomingText("/delete ses_123")).toEqual({
      kind: "command",
      command: { kind: "delete", sessionId: "ses_123", confirm: false },
    });
    expect(routeIncomingText("/delete ses_123 confirm")).toEqual({
      kind: "command",
      command: { kind: "delete", sessionId: "ses_123", confirm: true },
    });
    expect(routeIncomingText("/delete 2-6 confirm")).toEqual({
      kind: "command",
      command: { kind: "delete", range: { start: 2, end: 6 }, confirm: true },
    });
  });

  it("routes slash commands with a visible mention prefix", () => {
    expect(routeIncomingText("@机器人 /who")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "who", arguments: [] },
    });
    expect(routeIncomingText("@OpenCode /who")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "who", arguments: [] },
    });
    expect(routeIncomingText("@Open Code /status")).toEqual({
      kind: "command",
      command: { kind: "status" },
    });
  });

  it("passes unknown slash commands through", () => {
    expect(routeIncomingText("/compact fast now")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "compact", arguments: ["fast", "now"] },
    });
  });
});
