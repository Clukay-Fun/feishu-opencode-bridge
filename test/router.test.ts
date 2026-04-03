import { describe, expect, it } from "vitest";

import { routeIncomingText } from "../src/bridge/router.js";

describe("routeIncomingText", () => {
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

  it("passes unknown slash commands through", () => {
    expect(routeIncomingText("/compact fast now")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "compact", arguments: ["fast", "now"] },
    });
  });
});
