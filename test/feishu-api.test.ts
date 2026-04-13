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

  it("retries createBitableRecord with a single-select tag value when 标签 is configured as single select", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "token_1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 1001, msg: "SingleSelectFieldConvFail" }, 400))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { record: { record_id: "rec_ok" } } }));
    vi.stubGlobal("fetch", fetch);
    const client = new FeishuApiClient("app", "secret");

    await expect(client.createBitableRecord("app_token", "tbl_1", {
      问题: "Q",
      标签: ["劳动", "合同"],
    })).resolves.toBe("rec_ok");

    expect(fetch).toHaveBeenCalledTimes(3);
    const retryCall = fetch.mock.calls[2];
    expect(retryCall).toBeDefined();
    const retryBody = JSON.parse(retryCall?.[1]?.body as string);
    expect(retryBody.fields.标签).toBe("劳动");
  });

  it("keeps 标签 as an array when the bitable field accepts multi-select values", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "token_1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { record: { record_id: "rec_ok" } } }));
    vi.stubGlobal("fetch", fetch);
    const client = new FeishuApiClient("app", "secret");

    await expect(client.createBitableRecord("app_token", "tbl_1", {
      问题: "Q",
      标签: ["劳动", "合同"],
    })).resolves.toBe("rec_ok");

    expect(fetch).toHaveBeenCalledTimes(2);
    const createCall = fetch.mock.calls[1];
    expect(createCall).toBeDefined();
    const requestBody = JSON.parse(createCall?.[1]?.body as string);
    expect(requestBody.fields.标签).toEqual(["劳动", "合同"]);
  });

  it("repairs mojibake filenames when downloading message resources", async () => {
    vi.useFakeTimers();
    const fileBytes = new Uint8Array([1, 2, 3]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "token_1" }))
      .mockResolvedValueOnce(new Response(fileBytes, {
        status: 200,
        headers: {
          "content-disposition": `attachment; filename="${encodeURIComponent("ä»¥ä¸è½.txt")}"`,
          "content-type": "text/plain",
        },
      }));
    vi.stubGlobal("fetch", fetch);
    const client = new FeishuApiClient("app", "secret");

    await expect(client.downloadMessageResource("om_1", "file_1", "file")).resolves.toMatchObject({
      fileName: "以不能.txt",
      mimeType: "text/plain",
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
