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
