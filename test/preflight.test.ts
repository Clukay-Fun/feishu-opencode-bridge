import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import { runStartupPreflight } from "../src/runtime/preflight.js";

describe("runStartupPreflight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes with healthy upstream dependencies", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/global/health")) {
        return jsonResponse({ healthy: true, version: "1.0.0" });
      }
      if (url.includes("/project/current")) {
        return jsonResponse({
          id: "project_1",
          worktree: process.cwd(),
          sandboxes: [],
          time: { created: Date.now(), updated: Date.now() },
        });
      }
      if (url.includes("/config/providers")) {
        return jsonResponse({
          providers: [{ id: "openai", name: "OpenAI" }],
          default: { openai: "gpt-5.4-mini" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const feishu = {
      getTenantToken: vi.fn(async () => "tenant-token"),
    };
    const report = vi.fn();

    await runStartupPreflight(baseConfig(), feishu, report);

    expect(feishu.getTenantToken).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("已通过 模型提供方");
  });

  it("fails when button mode is enabled without a verification token", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/global/health")) {
        return jsonResponse({ healthy: true, version: "1.0.0" });
      }
      if (url.includes("/project/current")) {
        return jsonResponse({
          id: "project_1",
          worktree: process.cwd(),
          sandboxes: [],
          time: { created: Date.now(), updated: Date.now() },
        });
      }
      if (url.includes("/config/providers")) {
        return jsonResponse({
          providers: [{ id: "openai", name: "OpenAI" }],
          default: { openai: "gpt-5.4-mini" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const config = baseConfig();
    config.feishu.cardActions.enabled = true;
    config.feishu.cardActions.verificationToken = "";

    await expect(runStartupPreflight(config, {
      getTenantToken: async () => "tenant-token",
    }, () => {})).rejects.toThrow("缺少 feishu.cardActions.verificationToken");
  });
});

function baseConfig(): AppConfig {
  return {
    feishu: {
      appId: "app",
      appSecret: "secret",
      botOpenIds: new Set(["ou_bot"]),
      botMentionNames: new Set(["opencode"]),
      selfBotOpenIds: new Set(["ou_bot"]),
      wsUrl: new URL("wss://open.feishu.cn/open-apis/ws/v2"),
      allowedOpenIds: new Set(),
      behavior: {
        enableP2p: true,
        enableGroup: true,
        requireBotMentionInGroup: true,
        strictBotMention: true,
        ignoreNonUserSenders: true,
        replyInThread: true,
      },
      cardActions: {
        enabled: false,
        path: "/webhook/card",
        verificationToken: "token",
        encryptKey: "",
      },
    },
    opencode: {
      baseUrl: new URL("http://127.0.0.1:4096/"),
      directory: process.cwd(),
    },
    storage: {
      dataDir: process.cwd(),
      mappingsFile: "mappings.json",
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: new URL("http://127.0.0.1:3000/"),
    },
    whitelist: {
      storePath: "whitelist.json",
    },
    bridge: {
      queueLimit: 3,
      sessionModes: {
        p2p: "multi",
        group: "single",
        topicGroup: "single",
      },
      maxSessionsPerWindow: 20,
      sessionListLimit: 10,
      injectSystemState: true,
      firstEventTimeoutMs: 30_000,
      eventGapTimeoutMs: 120_000,
      totalTimeoutMs: 300_000,
    },
    logging: {
      dir: process.cwd(),
      level: "info",
      enableTranscript: true,
      enableConsole: true,
      enableColor: true,
      rotateDaily: true,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
