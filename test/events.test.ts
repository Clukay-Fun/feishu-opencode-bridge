import { describe, expect, it } from "vitest";

import { getEventSessionId, OpenCodeEventStream } from "../src/opencode/events.js";

describe("events", () => {
  it("reads session id from event", () => {
    expect(getEventSessionId({ type: "x", properties: { sessionID: "ses_1" } })).toBe("ses_1");
  });

  it("supports lowercase sessionId", () => {
    expect(getEventSessionId({ type: "x", properties: { sessionId: "ses_2" } })).toBe("ses_2");
  });

  it("emits subscribed events", async () => {
    const stream = new OpenCodeEventStream(new URL("http://127.0.0.1:4096/"), ".", { log() {} });
    let called = false;
    stream.subscribe(async () => { called = true; });
    await stream.emit({ type: "x", properties: {} });
    expect(called).toBe(true);
  });
});
