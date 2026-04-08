import { describe, expect, it } from "vitest";

import { routeIncomingText } from "../src/bridge/router.js";

describe("routeIncomingText", () => {
  it("routes built-in session and status commands", () => {
    expect(routeIncomingText("/status")).toEqual({
      kind: "command",
      command: { kind: "status" },
    });
    expect(routeIncomingText("/current")).toEqual({
      kind: "command",
      command: { kind: "status" },
    });
    expect(routeIncomingText("/new")).toEqual({
      kind: "command",
      command: { kind: "new" },
    });
    expect(routeIncomingText("/model")).toEqual({
      kind: "command",
      command: { kind: "models" },
    });
  });

  it("routes model subcommands", () => {
    expect(routeIncomingText("/model openai")).toEqual({
      kind: "command",
      command: { kind: "models", provider: "openai" },
    });
    expect(routeIncomingText("/models opencode")).toEqual({
      kind: "command",
      command: { kind: "models", provider: "opencode" },
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

  it("rejects invalid built-in command arguments before passthrough", () => {
    expect(routeIncomingText("/model use")).toEqual({
      kind: "command",
      command: { kind: "invalid", message: "用法：/model use <provider/model>" },
    });
    expect(routeIncomingText("/close abc")).toEqual({
      kind: "command",
      command: { kind: "invalid", message: "用法：/close [编号]" },
    });
    expect(routeIncomingText("/rename")).toEqual({
      kind: "command",
      command: { kind: "invalid", message: "用法：/rename <新名称>" },
    });
  });

  it("routes rename and close aliases", () => {
    expect(routeIncomingText("/rename 代码审查")).toEqual({
      kind: "command",
      command: { kind: "rename", label: "代码审查" },
    });
    expect(routeIncomingText("/close")).toEqual({
      kind: "command",
      command: { kind: "close" },
    });
    expect(routeIncomingText("/close 2")).toEqual({
      kind: "command",
      command: { kind: "close", index: 2 },
    });
    expect(routeIncomingText("/delete 3")).toEqual({
      kind: "command",
      command: { kind: "close", index: 3 },
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
