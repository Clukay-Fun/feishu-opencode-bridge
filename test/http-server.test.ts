/**
 * 职责: 覆盖HTTP callback 服务和健康检查接口。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import http from "node:http";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const actionResults = vi.hoisted(() => ({
  nextResult: { card: { title: "ok" } } as Record<string, unknown>,
  handlerParams: [] as Array<Record<string, string>>,
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class CardActionHandler {
    constructor(
      params: Record<string, string>,
      public readonly handler: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) {
      actionResults.handlerParams.push(params);
    }
  }

  function adaptDefault(
    _path: string,
    dispatcher: CardActionHandler,
  ) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const body = await readJsonBody(req);
      if (body.__sdkError) {
        throw new Error("signature check failed");
      }
      const result = await dispatcher.handler(body);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result ?? actionResults.nextResult));
    };
  }

  return { CardActionHandler, adaptDefault };
});

import { startBridgeHttpServer, type BridgeHttpServer } from "../src/http/server.js";
import type { AppConfig } from "../src/config/schema.js";
import { APP_VERSION } from "../src/version.js";

const testDataDir = path.join(os.tmpdir(), "bridge-http-test-fixed");

describe("startBridgeHttpServer", () => {
  beforeAll(async () => {
    await mkdir(testDataDir, { recursive: true });
  });

  const servers: BridgeHttpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await server?.close();
    }
  });

  it("returns 200 on /healthz", async () => {
    const port = await reservePort();
    const server = await startBridgeHttpServer(
      createConfig(port),
      { handlePermissionCardAction: vi.fn(async () => ({ ok: true })) },
      logger(),
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      bridgeVersion: APP_VERSION,
      queueLimit: 3,
      cardActionsEnabled: false,
      cardActionsPath: "/webhook/card",
      uptimeSec: expect.any(Number),
      rssBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
    }));
  });

  it("returns 404 for unknown routes", async () => {
    const port = await reservePort();
    const server = await startBridgeHttpServer(
      createConfig(port),
      { handlePermissionCardAction: vi.fn(async () => ({ ok: true })) },
      logger(),
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/missing`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("returns a JSON diagnostic response for card action GET probes", async () => {
    const port = await reservePort();
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction: vi.fn(async () => ({ ok: true })) },
      logger(),
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      cardActionsEnabled: true,
      cardActionsPath: "/webhook/card",
    }));
  });

  it("delegates card action callbacks to the permission handler", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      logger(),
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        open_id: "ou_requester",
        open_message_id: "om_permission_1",
        action: { value: { kind: "permission" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).toHaveBeenCalledWith("ou_requester", "om_permission_1", { kind: "permission" });
    expect(await response.json()).toEqual({ card: { title: "权限已处理" } });
  });

  it("delegates permission callbacks when action value is a JSON string", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      logger(),
    );
    servers.push(server);

    const value = {
      kind: "permission",
      conversationKey: "oc_p2p_1:main",
      turnId: "turn_1",
      sessionId: "ses_1",
      permissionId: "perm_1",
      policy: "once",
      nonce: "nonce_1",
    };
    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: { operator_id: { open_id: "ou_requester" } },
        context: { open_message_id: "om_permission_1" },
        action: { value: JSON.stringify(value) },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).toHaveBeenCalledWith("ou_requester", "om_permission_1", value);
    expect(await response.json()).toEqual({ card: { title: "权限已处理" } });
  });

  it("delegates non-permission card actions to the generic handler", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const handleCardAction = vi.fn(async () => ({ toast: { type: "success", content: "已处理" } }));
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction, handleCardAction },
      logger(),
    );
    servers.push(server);

    const value = {
      kind: "labor-authority-search",
      action: "confirm",
      conversationKey: "chat-1:thread-1",
      nonce: "nonce_labor",
    };
    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        open_id: "ou_requester",
        open_message_id: "om_labor_1",
        action: { value },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).not.toHaveBeenCalled();
    expect(handleCardAction).toHaveBeenCalledWith("ou_requester", "om_labor_1", value);
    expect(await response.json()).toEqual({ toast: { type: "success", content: "已处理" } });
  });

  it("extracts nested callback identifiers for permission actions", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const httpLogger = logger();
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      httpLogger,
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: { operator_id: { open_id: "ou_nested" } },
        context: { open_message_id: "om_nested" },
        action: { value: { kind: "permission" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).toHaveBeenCalledWith("ou_nested", "om_nested", { kind: "permission" });
    const callbackLog = httpLogger.log.mock.calls.find((call) => call[1] === "callback event parsed");
    expect(callbackLog).toBeDefined();
    expect(callbackLog?.[0]).toBe("http/server");
    expect(callbackLog?.[2]).toEqual(expect.objectContaining({
      actorPresent: true,
      openMessageId: "om_nested",
      actionKind: "permission",
      nonce: "",
      permissionId: "",
    }));
    expect(JSON.stringify(callbackLog?.[2])).not.toContain("ou_nested");
  });

  it("passes encryptKey to the card action sdk handler", async () => {
    actionResults.handlerParams.length = 0;
    const port = await reservePort();
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true, verificationToken: "token", encryptKey: "encrypt-key" }),
      { handlePermissionCardAction: vi.fn(async () => ({ ok: true })) },
      logger(),
    );
    servers.push(server);

    expect(actionResults.handlerParams.at(-1)).toEqual(expect.objectContaining({
      verificationToken: "token",
      encryptKey: "encrypt-key",
    }));
  });

  it("extracts nested operator ids and tolerates missing open_message_id", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      logger(),
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: {
          operator_id: {
            open_id: "ou_requester_nested",
          },
        },
        context: {
          open_id: "ou_requester_context",
        },
        action: { value: { kind: "permission", source: "nested" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).toHaveBeenCalledWith("ou_requester_nested", "", { kind: "permission", source: "nested" });
    expect(await response.json()).toEqual({ card: { title: "权限已处理" } });
  });

  it("finds permission action values from nested card 2.0 callback payloads", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      logger(),
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: { operator_id: { open_id: "ou_requester" } },
        context: { open_message_id: "om_nested_action", open_chat_id: "oc_group_123456789" },
        card: {
          elements: [
            {
              actions: [
                { value: { kind: "permission", permissionId: "perm_nested", nonce: "nonce_nested" } },
              ],
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).toHaveBeenCalledWith(
      "ou_requester",
      "om_nested_action",
      { kind: "permission", permissionId: "perm_nested", nonce: "nonce_nested" },
    );
  });

  it("stops nested permission action lookup after depth 5", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      logger(),
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        open_id: "ou_requester",
        deep: { a: { b: { c: { d: { e: { f: { kind: "permission", permissionId: "too_deep" } } } } } } },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).toHaveBeenCalledWith("ou_requester", "", {});
  });

  it("does not enter permission handling when actor open id is missing", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const httpLogger = logger();
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      httpLogger,
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { open_message_id: "om_missing_actor" },
        action: { value: { kind: "permission", permissionId: "perm_1" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).not.toHaveBeenCalled();
    expect(await response.text()).toContain("无法识别操作者");
    expect(httpLogger.log).toHaveBeenCalledWith("http/server", "callback actor missing", expect.objectContaining({
      actorPresent: false,
    }), "warn");
  });

  it("handles callback demo buttons without entering permission handling", async () => {
    const port = await reservePort();
    const handlePermissionCardAction = vi.fn(async () => ({ card: { title: "权限已处理" } }));
    const httpLogger = logger();
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true }),
      { handlePermissionCardAction },
      httpLogger,
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: { operator_id: { open_id: "ou_demo" } },
        context: { open_message_id: "om_demo", open_chat_id: "oc_demo_chat" },
        action: { value: { kind: "callback-demo", nonce: "nonce_demo" } },
      }),
    });

    expect(response.status).toBe(200);
    expect(handlePermissionCardAction).not.toHaveBeenCalled();
    expect(await response.text()).toContain("按钮回调已到达 Bridge");
    expect(httpLogger.log).toHaveBeenCalledWith("http/server", "callback demo action handled", expect.objectContaining({
      actionKind: "callback-demo",
      nonce: "nonce_demo",
    }));
  });

  it("returns 400 with safe diagnostics when SDK adapter fails", async () => {
    const port = await reservePort();
    const httpLogger = logger();
    const server = await startBridgeHttpServer(
      createConfig(port, { enabled: true, verificationToken: "secret-token", encryptKey: "secret-encrypt-key" }),
      { handlePermissionCardAction: vi.fn(async () => ({ ok: true })) },
      httpLogger,
    );
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/webhook/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "lark-test" },
      body: JSON.stringify({ __sdkError: true, token: "secret-token", encrypt: "secret-encrypt-key" }),
    });

    expect(response.status).toBe(400);
    const logText = JSON.stringify(httpLogger.log.mock.calls);
    expect(logText).toContain("callback adapter failed");
    expect(logText).not.toContain("secret-token");
    expect(logText).not.toContain("secret-encrypt-key");
  });
});

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function createConfig(
  port: number,
  cardActions?: Partial<AppConfig["feishu"]["cardActions"]>,
): AppConfig {
  return {
    profile: "legal",
    caseWorkbench: { enabled: false },
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
        encryptKey: "encrypt-key",
        ...cardActions,
      },
    },
    opencode: {
      baseUrl: new URL("http://127.0.0.1:4096/"),
      directory: process.cwd(),
    },
    storage: {
      dataDir: testDataDir,
      mappingsFile: "mappings.json",
    },
    server: {
      host: "127.0.0.1",
      port,
      publicBaseUrl: new URL(`http://127.0.0.1:${port}/`),
    },
    whitelist: {
      storePath: path.join(testDataDir, "whitelist.json"),
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
      dbPath: path.join(testDataDir, "memory.db"),
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
        sqlitePath: path.join(testDataDir, "knowledge-base.db"),
        bitable: { appToken: "", tableId: "", documentTableId: undefined },
      },
      embeddingProvider: undefined,
      models: {},
      ingest: { allowedExtensions: [".pdf", ".docx", ".txt"], maxFileSizeMb: 20, pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500 },
    },
    logging: {
      dir: testDataDir,
      level: "info",
      enableTranscript: true,
      enableConsole: true,
      enableColor: true,
      rotateDaily: true,
    },
  };
}

function logger() {
  return {
    log: vi.fn(),
  };
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to reserve port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
