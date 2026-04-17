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
  });

  it("routes /sessions <index> without accepting bare numbers", () => {
    expect(routeIncomingText("/sessions 3")).toEqual({
      kind: "command",
      command: { kind: "sessions-select", index: 3 },
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
    expect(routeIncomingText("/deny")).toEqual({
      kind: "command",
      command: { kind: "deny" },
    });
  });

  it("routes group whitelist commands", () => {
    expect(routeIncomingText("/who")).toEqual({
      kind: "command",
      command: { kind: "who" },
    });
    expect(routeIncomingText("/leave")).toEqual({
      kind: "command",
      command: { kind: "leave" },
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
    expect(routeIncomingText("/legal-query-start")).toEqual({
      kind: "command",
      command: { kind: "knowledge-mode-start" },
    });
    expect(routeIncomingText("/legal-query-end")).toEqual({
      kind: "command",
      command: { kind: "knowledge-mode-end" },
    });
    expect(routeIncomingText("/legal-query 员工试用期最长多久？")).toEqual({
      kind: "command",
      command: { kind: "knowledge-query", question: "员工试用期最长多久？" },
    });
    expect(routeIncomingText("/kb-query 员工试用期最长多久？")).toEqual({
      kind: "command",
      command: { kind: "knowledge-query", question: "员工试用期最长多久？", explicit: true },
    });
    expect(routeIncomingText("/知识入库")).toEqual({
      kind: "command",
      command: { kind: "knowledge-ingest" },
    });
    expect(routeIncomingText("/法律咨询 员工试用期最长多久？")).toEqual({
      kind: "command",
      command: { kind: "knowledge-query", question: "员工试用期最长多久？" },
    });
  });

  it("routes /model to the provider listing command and keeps model subcommands as passthrough", () => {
    expect(routeIncomingText("/model")).toEqual({
      kind: "command",
      command: { kind: "models" },
    });
    expect(routeIncomingText("/model openai")).toEqual({
      kind: "command",
      command: { kind: "models", provider: "openai" },
    });
    expect(routeIncomingText("/model use openai/gpt-5.4")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "model", arguments: ["use", "openai/gpt-5.4"] },
    });
    expect(routeIncomingText("/model reset")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "model", arguments: ["reset"] },
    });
  });

  it("routes slash commands with a visible mention prefix", () => {
    expect(routeIncomingText("@机器人 /who")).toEqual({
      kind: "command",
      command: { kind: "who" },
    });
    expect(routeIncomingText("@OpenCode /who")).toEqual({
      kind: "command",
      command: { kind: "who" },
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
