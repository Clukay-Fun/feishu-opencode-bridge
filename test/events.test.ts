/**
 * 职责: 覆盖OpenCode 事件解析和事件类型工具。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getEventSessionId, OpenCodeEventStream } from "../src/opencode/events.js";

afterEach(() => {
  vi.useRealTimers();
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

  it("reconnects after the event stream closes", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(createSseBody([
        'data: {"type":"session.idle","properties":{"sessionID":"ses_1"}}',
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(createSseBody([
        'data: {"type":"session.idle","properties":{"sessionID":"ses_2"}}',
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const seen: string[] = [];
    const logger = { log: vi.fn() };
    const stream = new OpenCodeEventStream(new URL("http://127.0.0.1:4096/"), logger);
    stream.subscribe(async (event) => {
      seen.push(event.sessionId ?? "-");
    });

    await stream.start();
    await vi.waitFor(() => expect(seen).toContain("ses_1"));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(seen).toContain("ses_2"));
    await stream.stop();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith("opencode/events", "event stream disconnected", expect.objectContaining({ endpoint: "/event" }), "warn");
  });

  it("skips malformed JSON in SSE block without crashing", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(createSseBody([
      'data: {NOT VALID JSON}',
      'data: {"type":"message.part.delta","properties":{"sessionID":"ses_ok","field":"text","delta":"Hi"}}',
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const events: string[] = [];
    const logger = { log: vi.fn() };
    const stream = new OpenCodeEventStream(new URL("http://127.0.0.1:4096/"), logger);
    stream.subscribe(async (event) => {
      events.push(`${event.type}:${event.sessionId ?? "-"}`);
    });

    await stream.start();
    await vi.waitFor(() => expect(events).toContain("message.part.delta:ses_ok"));
    await stream.stop();

    // The malformed block should have been logged as a warning
    expect(logger.log).toHaveBeenCalledWith(
      "opencode/events",
      "unparseable SSE block skipped",
      expect.objectContaining({ preview: expect.any(String) }),
      "warn",
    );
  });

  it("skips SSE block with missing type field without crashing", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(createSseBody([
      'data: {"foo":"bar"}',
      'data: {"type":"session.idle","properties":{"sessionID":"ses_ok2"}}',
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const events: string[] = [];
    const logger = { log: vi.fn() };
    const stream = new OpenCodeEventStream(new URL("http://127.0.0.1:4096/"), logger);
    stream.subscribe(async (event) => {
      events.push(`${event.type}:${event.sessionId ?? "-"}`);
    });

    await stream.start();
    await vi.waitFor(() => expect(events).toContain("session.idle:ses_ok2"));
    await stream.stop();

    // The block with missing type should have been logged
    expect(logger.log).toHaveBeenCalledWith(
      "opencode/events",
      "unparseable SSE block skipped",
      expect.objectContaining({ preview: expect.any(String) }),
      "warn",
    );
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
