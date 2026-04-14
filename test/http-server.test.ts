import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("startBridgeHttpServer", () => {
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
      actorOpenId: "ou_nested",
      openMessageId: "om_nested",
      actionValueKind: "permission",
      "callback.operator.operator_id.open_id": "ou_nested",
      "callback.context.open_message_id": "om_nested",
      "callback.action.value.kind": "permission",
    }));
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
      dataDir: process.cwd(),
      mappingsFile: "mappings.json",
    },
    server: {
      host: "127.0.0.1",
      port,
      publicBaseUrl: new URL(`http://127.0.0.1:${port}/`),
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
