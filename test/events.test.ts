import { afterEach, describe, expect, it, vi } from "vitest";

import { getEventSessionId, OpenCodeEventStream } from "../src/opencode/events.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("events", () => {
  it("reads session id from event", () => {
    expect(getEventSessionId({ sessionId: null, properties: { sessionID: "ses_1" } })).toBe("ses_1");
  });

  it("supports lowercase sessionId", () => {
    expect(getEventSessionId({ sessionId: null, properties: { sessionId: "ses_2" } })).toBe("ses_2");
  });

  it("emits subscribed events", async () => {
    const stream = new OpenCodeEventStream(new URL("http://127.0.0.1:4096/"), { log() {} });
    let called = false;
    stream.subscribe(async () => { called = true; });
    await stream.emit({ type: "x", properties: {}, sessionId: null, receivedAt: Date.now(), streamEndpoint: "/event", raw: {} });
    expect(called).toBe(true);
  });

  it("normalizes /event payloads", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(createSseBody([
      'data: {"type":"server.connected","properties":{}}',
      'data: {"type":"message.part.delta","properties":{"sessionID":"ses_1","field":"text","delta":"Hi"}}',
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const events: string[] = [];
    const stream = new OpenCodeEventStream(new URL("http://127.0.0.1:4096/"), { log() {} });
    stream.subscribe(async (event) => {
      events.push(`${event.streamEndpoint}:${event.type}:${event.sessionId ?? "-"}`);
    });

    await stream.start();
    await vi.waitFor(() => expect(events).toContain("/event:message.part.delta:ses_1"));
    await stream.stop();
  });

  it("falls back to /global/event and unwraps payload", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(new Response(createSseBody([
        'data: {"payload":{"type":"server.connected","properties":{}}}',
        'data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses_2"}}}',
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const seen: string[] = [];
    const logger = { log: vi.fn() };
    const stream = new OpenCodeEventStream(new URL("http://127.0.0.1:4096/"), logger);
    stream.subscribe(async (event) => {
      seen.push(`${event.streamEndpoint}:${event.type}:${event.sessionId ?? "-"}`);
    });

    await stream.start();
    await vi.waitFor(() => expect(seen).toContain("/global/event:session.idle:ses_2"));
    await stream.stop();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function createSseBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${event}\n\n`));
      }
      controller.close();
    },
    cancel() {},
  });
}
