import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import { runStartupPreflight } from "../src/runtime/preflight.js";

describe("runStartupPreflight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes with healthy upstream dependencies", async () => {
    stubHealthyFetch();

    const feishu = {
      getTenantToken: vi.fn(async () => "tenant-token"),
    };
    const report = vi.fn();

    await runStartupPreflight(baseConfig(), feishu, report);

    expect(feishu.getTenantToken).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("已通过 模型提供方");
  });

  it("fails when button mode is enabled without a verification token", async () => {
    stubHealthyFetch();

    const config = baseConfig();
    config.feishu.cardActions.enabled = true;
    config.feishu.cardActions.verificationToken = "";

    await expect(runStartupPreflight(config, {
      getTenantToken: async () => "tenant-token",
    }, () => {})).rejects.toThrow("缺少 feishu.cardActions.verificationToken");
  });

  it("fails when button mode is enabled without an encrypt key", async () => {
    stubHealthyFetch();

    const config = baseConfig();
    config.feishu.cardActions.enabled = true;
    config.feishu.cardActions.encryptKey = "";

    await expect(runStartupPreflight(config, {
      getTenantToken: async () => "tenant-token",
    }, () => {})).rejects.toThrow("缺少 feishu.cardActions.encryptKey");
  });

  it("passes when card actions have both verificationToken and encryptKey", async () => {
    stubHealthyFetch();

    const config = baseConfig();
    config.feishu.cardActions.enabled = true;
    config.feishu.cardActions.verificationToken = "token";
    config.feishu.cardActions.encryptKey = "encrypt-key";

    await expect(runStartupPreflight(config, {
      getTenantToken: async () => "tenant-token",
    }, () => {})).resolves.toBeUndefined();
  });

  it("fails when data dir is not writable", async () => {
    stubHealthyFetch();

    const config = baseConfig();
    config.storage.dataDir = "/definitely/missing/bridge-data-dir";

    await expect(runStartupPreflight(config, {
      getTenantToken: async () => "tenant-token",
    }, () => {})).rejects.toThrow(/数据目录/i);
  });

  it("fails when a dotted data directory exists but is not writable", async () => {
    stubHealthyFetch();

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "preflight-"));
    const dataDir = path.join(tempRoot, "data.v1");
    await mkdir(dataDir);
    await chmod(dataDir, 0o555);

    try {
      const config = baseConfig();
      config.storage.dataDir = dataDir;

      await expect(runStartupPreflight(config, {
        getTenantToken: async () => "tenant-token",
      }, () => {})).rejects.toThrow(/数据目录/i);
    } finally {
      await chmod(dataDir, 0o755);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails when Feishu credentials are invalid", async () => {
    stubHealthyFetch();

    await expect(runStartupPreflight(baseConfig(), {
      getTenantToken: async () => {
        throw new Error("invalid app credentials");
      },
    }, () => {})).rejects.toThrow(/飞书鉴权/i);
  });

  it("fails when OpenCode is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/global/health")) {
        throw new Error("connect ECONNREFUSED");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await expect(runStartupPreflight(baseConfig(), {
      getTenantToken: async () => "tenant-token",
    }, () => {})).rejects.toThrow(/OpenCode 健康检查/i);
  });

  it("fails when worktree mismatches", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/global/health")) {
        return jsonResponse({ healthy: true, version: "1.0.0" });
      }
      if (url.includes("/project/current")) {
        return jsonResponse({
          id: "project_1",
          worktree: "/tmp/other-project",
          sandboxes: [],
          time: { created: Date.now(), updated: Date.now() },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await expect(runStartupPreflight(baseConfig(), {
      getTenantToken: async () => "tenant-token",
    }, () => {})).rejects.toThrow(/工作目录/i);
  });

  it("fails when card actions are enabled without publicBaseUrl", async () => {
    stubHealthyFetch();

    const config = baseConfig();
    config.feishu.cardActions.enabled = true;
    config.feishu.cardActions.encryptKey = "encrypt-key";
    config.server.publicBaseUrl = null as unknown as URL;

    await expect(runStartupPreflight(config, {
      getTenantToken: async () => "tenant-token",
    }, () => {})).rejects.toThrow(/publicBaseUrl/i);
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
    memory: {
      enabled: false,
      dbPath: "memory.db",
      maxMemoriesPerUser: 500,
      searchLimit: 5,
      extractQueueLimit: 100,
      sourcePreviewLength: 50,
      shutdownDrainTimeoutMs: 5_000,
      retriever: "recent",
      embeddingProvider: undefined,
      obsidian: {
        enabled: false,
        vaultPath: undefined,
        syncCron: "0 2 * * *",
        enableWikiLinks: false,
      },
    },
    knowledgeBase: {
      enabled: false,
      autoDetect: { enabled: false, minConfidence: 0.75 },
      query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
      storage: {
        sqlitePath: "knowledge-base.db",
        bitable: { appToken: "", tableId: "", documentTableId: undefined },
      },
      embeddingProvider: undefined,
      models: {},
      ingest: { allowedExtensions: [".pdf", ".docx", ".txt"], maxFileSizeMb: 20, pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500 },
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

function stubHealthyFetch(): void {
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
}
