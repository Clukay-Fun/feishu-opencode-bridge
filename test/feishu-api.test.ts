import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuApiClient } from "../src/feishu/api.js";

describe("FeishuApiClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries sendMessage once after a 500 response", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "token_1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 1, msg: "server busy" }, 500))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "om_ok" } }));
    vi.stubGlobal("fetch", fetch);
    const client = new FeishuApiClient("app", "secret");

    const promise = client.sendMessage("oc_1", {
      msg_type: "post",
      content: JSON.stringify({ text: "hello" }),
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ messageId: "om_ok" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries updateMessage once after a 429 response", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "token_1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 99991663, msg: "rate limited" }, 429))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "om_updated" } }));
    vi.stubGlobal("fetch", fetch);
    const client = new FeishuApiClient("app", "secret");

    const promise = client.updateMessage("om_1", {
      msg_type: "post",
      content: JSON.stringify({ text: "updated" }),
    });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ messageId: "om_updated" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry sendMessage on non-retryable business errors", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "token_1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 230006, msg: "chat not found" }, 400));
    vi.stubGlobal("fetch", fetch);
    const client = new FeishuApiClient("app", "secret");

    await expect(client.sendMessage("oc_missing", {
      msg_type: "post",
      content: JSON.stringify({ text: "hello" }),
    })).rejects.toThrow("Feishu sendMessage failed: chat not found");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
