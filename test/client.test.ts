import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenCodeClient } from "../src/opencode/client.js";

describe("OpenCodeClient", () => {
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const originalUsername = process.env.OPENCODE_SERVER_USERNAME;

  beforeEach(() => {
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    process.env.OPENCODE_SERVER_USERNAME = "tester";
  });

  afterEach(() => {
    process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
    process.env.OPENCODE_SERVER_USERNAME = originalUsername;
    vi.unstubAllGlobals();
  });

  it("sends basic auth and prompt_async body", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    const result = await client.promptAsync("ses_123", {
      parts: [{ type: "text", text: "hello" }],
    });

    expect(result.accepted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:4096/session/ses_123/prompt_async");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("tester:secret").toString("base64")}`);
    expect(init.body).toBe(JSON.stringify({ parts: [{ type: "text", text: "hello" }] }));
  });

  it("adds query params when listing messages", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    await client.getSessionMessages("ses_1", 20);

    const [url] = fetch.mock.calls[0] as [URL];
    expect(String(url)).toBe("http://127.0.0.1:4096/session/ses_1/message?limit=20");
  });

  it("uses the documented permission path and payload", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("true", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    await client.replyPermission("ses_9", "per_7", "always", true);

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:4096/session/ses_9/permissions/per_7");
    expect(init.body).toBe(JSON.stringify({ response: "always", remember: true }));
  });
});
