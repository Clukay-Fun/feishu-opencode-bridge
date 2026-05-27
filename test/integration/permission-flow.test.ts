/**
 * 职责: 覆盖权限申请到回调处理的集成路径。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config/schema.js";
import { BridgeApp, type IncomingChatMessage, type PermissionCardActionValue } from "../../src/runtime/app.js";
import { createLogger, createOutbound, createWhitelist, FakeOpenCodeClient, FakeOpenCodeEventStream } from "./fakes.js";

const tempDirs: string[] = [];

describe("integration/permission-flow", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles permission flow end-to-end with allow once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-permission-integration-"));
    tempDirs.push(dir);

    const stream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(stream, {
      kind: "permission-flow",
      permissionName: "shell",
      permissionId: "perm_1",
      finalText: "权限确认后继续执行完成",
    });
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(dir), outbound, createLogger(), createWhitelist(), {
      opencode,
      eventStream: stream,
      memory: null,
    });

    const run = app.handleIncomingMessage(createDirectMessage("执行需要权限的操作"));

    const permissionCard = await waitForPermissionCard(outbound);
    const actionValue = extractPermissionActionValue(permissionCard.payload);
    expect(actionValue.policy).toBe("once");

    const cardResult = await app.handlePermissionCardAction("ou_123", permissionCard.messageId, actionValue);
    expect(JSON.stringify(cardResult)).toContain("已授权");

    await run;

    await vi.waitFor(() => {
      expect(opencode.permissionReplies).toContainEqual({
        sessionId: "ses_1",
        permissionId: "perm_1",
        response: "once",
        remember: false,
      });
      expect(outbound.updateMessage).toHaveBeenCalled();
    });

    expect(JSON.stringify(outbound.updateMessage.mock.calls.map((call) => call[1]))).toContain("权限确认后继续执行完成");

    const appAny = app as unknown as {
      queues: { get(key: string): { current(): unknown } };
    };
    expect(appAny.queues.get("oc_p2p_1").current()).toBeNull();
  });
});

async function waitForPermissionCard(outbound: ReturnType<typeof createOutbound>): Promise<{ payload: { content: string }; messageId: string }> {
  return await vi.waitFor(async () => {
    const calls = outbound.replyMessage.mock.calls as Array<[string, { content: string }] >;
    for (const [index, call] of calls.entries()) {
      const payload = call[1];
      if (JSON.stringify(payload).includes("shell") && JSON.stringify(payload).includes("permission")) {
        const result = await outbound.replyMessage.mock.results[index]?.value;
        return { payload, messageId: result.messageId as string };
      }
    }
    throw new Error("permission card not sent yet");
  });
}

function extractPermissionActionValue(payload: { content: string }): PermissionCardActionValue {
  const parsed = JSON.parse(payload.content) as Record<string, unknown>;
  const value = findPermissionActionValue(parsed);
  if (!value) {
    throw new Error("permission action value not found");
  }
  return value;
}

function findPermissionActionValue(value: unknown): PermissionCardActionValue | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "permission"
    && typeof record.conversationKey === "string"
    && typeof record.turnId === "string"
    && typeof record.sessionId === "string"
    && typeof record.permissionId === "string"
    && typeof record.nonce === "string"
    && (record.policy === "once" || record.policy === "always" || record.policy === "deny")) {
    return record as PermissionCardActionValue;
  }

  for (const nested of Object.values(record)) {
    const found = findPermissionActionValue(nested);
    if (found) {
      return found;
    }
  }
  return null;
}

function baseConfig(dir: string): AppConfig {
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
        enabled: true,
        path: "/webhook/card",
        verificationToken: "",
        encryptKey: "",
      },
    },
    opencode: {
      baseUrl: new URL("http://127.0.0.1:4096/"),
      directory: process.cwd(),
    },
    storage: {
      dataDir: dir,
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
      dbPath: join(dir, "memory.db"),
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
        sqlitePath: join(dir, "knowledge-base.db"),
        bitable: { appToken: "", tableId: "", documentTableId: undefined },
      },
      embeddingProvider: undefined,
      models: {},
      ingest: { allowedExtensions: [".pdf", ".docx", ".txt"], maxFileSizeMb: 20, pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500 },
    },
    logging: {
      dir: dir,
      level: "info",
      enableTranscript: true,
      enableConsole: false,
      enableColor: false,
      rotateDaily: true,
    },
  };
}

function createDirectMessage(text: string): IncomingChatMessage {
  return {
    chatId: "oc_p2p_1",
    chatType: "p2p",
    senderOpenId: "ou_123",
    messageId: "om_1",
    messageType: "text",
    rawContent: text,
    plainText: text,
    threadKey: "om_1",
    conversationKey: "oc_p2p_1",
  };
}
