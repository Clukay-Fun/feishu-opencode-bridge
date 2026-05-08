/**
 * 职责: 覆盖已下线群聊白名单命令的路由回归。
 * 关注点:
 * - /who 与 /leave 不再作为 bridge-owned command 处理。
 * - 旧命令应稳定降级到 passthrough，避免绕过群聊 mention / 白名单规则。
 */
import { describe, expect, it } from "vitest";

import { routeIncomingText } from "../src/bridge/router.js";

describe("retired group whitelist commands", () => {
  it("routes /who and /leave as passthrough commands", () => {
    expect(routeIncomingText("/who")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "who", arguments: [] },
    });
    expect(routeIncomingText("/leave")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "leave", arguments: [] },
    });
  });
});
