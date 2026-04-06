import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCodeMemoryExtractor } from "../src/memory/extractor.js";
import { OpenCodeClient } from "../src/opencode/client.js";

describe("OpenCodeMemoryExtractor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to async polling when postMessageSync does not return usable text", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "ses_sync" }))
      .mockResolvedValueOnce(jsonResponse({
        info: { role: "assistant" },
        parts: [],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: "ses_async" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{
        info: { role: "assistant", finish: "stop" },
        parts: [{ type: "text", text: "用户偏好 TypeScript" }],
      }]));
    vi.stubGlobal("fetch", fetch);

    const extractor = new OpenCodeMemoryExtractor(
      new OpenCodeClient(new URL("http://127.0.0.1:4096/")),
      { log() {}, logTranscript() {} } as any,
    );

    const facts = await extractor.extract("我喜欢 TypeScript", "好的");

    expect(facts).toEqual(["用户偏好 TypeScript"]);
    expect(fetch.mock.calls.some((call) => String(call[0]).includes("/prompt_async"))).toBe(true);
    expect(fetch.mock.calls.filter((call) => String(call[0]).includes("/message?limit=50")).length).toBeGreaterThanOrEqual(2);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
