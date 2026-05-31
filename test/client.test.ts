/**
 * 职责: 覆盖OpenCode 客户端 HTTP/SSE 行为。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
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
    vi.useRealTimers();
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

    await expect(client.replyPermission("ses_9", "per_7", "always", true)).resolves.toBe(true);

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:4096/session/ses_9/permissions/per_7");
    expect(init.body).toBe(JSON.stringify({ response: "always", remember: true }));
  });

  it("uses the documented question reply path and nested answer payload", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("true", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    await client.replyQuestion("que_7", ["answer"]);

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:4096/question/que_7/reply");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ answers: [["answer"]] }));
  });

  it("sends command arguments as the OpenCode string payload", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ info: {}, parts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    await client.runCommand("ses_7", { command: "model", arguments: "use provider/model" });

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:4096/session/ses_7/command");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ command: "model", arguments: "use provider/model" }));
  });

  it("times out stuck OpenCode requests", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"), 50);

    const request = expect(client.listProviders()).rejects.toThrow("OpenCode 请求超时");
    await vi.advanceTimersByTimeAsync(50);

    await request;
  });

  it("summarizes html responses instead of surfacing the OpenCode web page", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("<!doctype html><html><head><title>OpenCode</title></head></html>", {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    let thrown: unknown;
    try {
      await client.replyQuestion("que_7", ["answer"]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("OpenCode 返回了前端页面");
    expect((thrown as Error).message).not.toContain("<!doctype html>");
  });

  it("returns false when permission reply is no longer accepted by OpenCode", async () => {
    for (const status of [404, 409, 410]) {
      const fetch = vi.fn().mockResolvedValue(new Response("expired", { status }));
      vi.stubGlobal("fetch", fetch);
      const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

      await expect(client.replyPermission("ses_9", "per_7", "once", false)).resolves.toBe(false);
    }
  });

  it("keeps other permission reply failures as errors", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500, statusText: "Server Error" }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    await expect(client.replyPermission("ses_9", "per_7", "once", false)).rejects.toThrow("500");
  });

  it("uses DELETE /session/:id when removing a session", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("true", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new OpenCodeClient(new URL("http://127.0.0.1:4096/"));

    await client.deleteSession("ses_delete_1");

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:4096/session/ses_delete_1");
    expect(init.method).toBe("DELETE");
  });
});
