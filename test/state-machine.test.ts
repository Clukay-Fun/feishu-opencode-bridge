/**
 * 职责: 覆盖Bridge turn 状态机行为。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import type { BridgeTurn } from "../src/bridge/turn.js";
import { transitionTurn } from "../src/bridge/state-machine.js";

function makeTurn(overrides: Partial<BridgeTurn> = {}): BridgeTurn {
  return {
    turnId: "1",
    chatId: "c",
    conversationKey: "c:thread",
    threadKey: "thread",
    senderOpenId: "u",
    inboundMessageId: "m",
    plainText: "hi",
    text: "hi",
    ...overrides,
  };
}

describe("transitionTurn", () => {
  it("sets running state and startedAt", () => {
    const turn = transitionTurn(makeTurn(), "running");
    expect(turn.state).toBe("running");
    expect(typeof turn.startedAt).toBe("number");
  });

  it("preserves existing startedAt", () => {
    const turn = transitionTurn(makeTurn({ startedAt: 1 }), "running");
    expect(turn.startedAt).toBe(1);
  });

  it("keeps startedAt when transitioning to awaiting-sse", () => {
    const turn = transitionTurn(makeTurn({ startedAt: 1 }), "awaiting-sse");
    expect(turn.state).toBe("awaiting-sse");
    expect(turn.startedAt).toBe(1);
  });
});
