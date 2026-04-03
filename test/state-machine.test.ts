import { describe, expect, it } from "vitest";

import { transitionTurn } from "../src/bridge/state-machine.js";

describe("transitionTurn", () => {
  it("sets running state and startedAt", () => {
    const turn = transitionTurn({ turnId: "1", chatId: "c", senderOpenId: "u", inboundMessageId: "m", text: "hi" }, "running");
    expect(turn.state).toBe("running");
    expect(typeof turn.startedAt).toBe("number");
  });

  it("preserves existing startedAt", () => {
    const turn = transitionTurn({ turnId: "1", chatId: "c", senderOpenId: "u", inboundMessageId: "m", text: "hi", startedAt: 1 }, "running");
    expect(turn.startedAt).toBe(1);
  });
});
