/**
 * 职责: 覆盖文件上传意图确认（File Upload Intent Gate v1）。
 * 关注点: 单独上传文件不自动总结，建立材料上下文并询问处理方式。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeApp } from "../src/runtime/app.js";

function createTempConfig(dir: string) {
  return {
    profile: "legal",
    feishu: {
      appId: "cli_a94e2854da7a1bcd",
      appSecret: "s5XMw5HEDXqudEP0Yicxpe5cJiqDlrLZ",
      botOpenId: "ou_df2fcf83048d7e373f694465c45e7cbf",
      wsUrl: "wss://open.feishu.cn/open-apis/ws/v2",
      allowedOpenIds: new Set(),
      behavior: { enableP2p: true, enableGroup: true, requireBotMentionInGroup: true, strictBotMention: true, ignoreNonUserSenders: true, replyInThread: true },
      cardActions: { enabled: true, path: "/webhook/card", verificationToken: "3pUYcd0m1vwk2vgMaa5Qabh1RzLOjuCK", encryptKey: "" },
    },
    opencode: { baseUrl: new URL("http://127.0.0.1:4096/"), directory: dir },
    storage: { dataDir: path.join(dir, "data"), mappingsFile: "mappings.json" },
    server: { host: "127.0.0.1", port: 3000, publicBaseUrl: new URL("http://127.0.0.1:3000/") },
    whitelist: { storePath: path.join(dir, "whitelist.json") },
    bridge: { queueLimit: 3, sessionModes: { p2p: "multi", group: "single", topicGroup: "single" }, maxSessionsPerWindow: 20, sessionListLimit: 10, injectSystemState: true, firstEventTimeoutMs: 30000, eventGapTimeoutMs: 600000, totalTurnTimeoutMs: 600000 },
    memory: { enabled: false, dbPath: path.join(dir, "memory.db"), maxMemoriesPerUser: 500, searchLimit: 5, extractQueueLimit: 100, sourcePreviewLength: 50, shutdownDrainTimeoutMs: 5000, retriever: "recent" as const, obsidian: { enabled: false, enableWikiLinks: false } },
    knowledgeBase: { enabled: false, ingest: { maxFileSizeMb: 20 } },
    contractAssistant: { enabled: false },
    laborSkill: { enabled: false },
    caseWorkbench: { enabled: false },
    scheduler: { enabled: true, maxConcurrentRuns: 1 },
    logging: { dir: path.join(dir, "logs"), level: "info" as const, enableTranscript: false, enableConsole: false, enableColor: false, rotateDaily: false },
  } as any;
}

function createMockLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };
}

function createMockOutbound(sentPayloads: any[]) {
  return {
    sendPayload: vi.fn().mockImplementation(async (...args: any[]) => {
      const payload = args[1];
      sentPayloads.push(payload);
      return { messageId: `msg-${sentPayloads.length}` };
    }),
    sendMessage: vi.fn().mockImplementation(async (chatId: string, payload: any) => {
      sentPayloads.push(payload);
      return { messageId: `msg-${sentPayloads.length}` };
    }),
    replyMessage: vi.fn().mockImplementation(async (messageId: string, payload: any) => {
      sentPayloads.push(payload);
      return { messageId: `msg-${sentPayloads.length}` };
    }),
    updateMessage: vi.fn().mockImplementation(async (messageId: string, payload: any) => {
      sentPayloads.push(payload);
      return { messageId: `msg-${sentPayloads.length}` };
    }),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    updatePayload: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockOpencode() {
  return {
    health: vi.fn().mockResolvedValue({ ok: true }),
    createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
    postMessageSync: vi.fn().mockResolvedValue({ parts: [{ type: "text", text: "test" }] }),
    promptAsync: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(true),
    replyPermission: vi.fn().mockResolvedValue(undefined),
  };
}

function createFileMessage(fileName = "委托代理合同.pdf", size?: number): any {
  const actualSize = arguments.length >= 2 ? size : 102400;
  return {
    chatId: "oc_test",
    chatType: "p2p",
    senderOpenId: "ou_user1",
    messageId: "msg-file-1",
    rawContent: "",
    plainText: "",
    threadKey: undefined,
    conversationKey: "oc_test:main",
    rootId: undefined,
    parentId: undefined,
    messageType: "file",
    file: { fileKey: "file_key_1", fileName, size: actualSize },
    resourceType: "file",
  };
}

function createTextMessage(text: string): any {
  return {
    chatId: "oc_test",
    chatType: "p2p",
    senderOpenId: "ou_user1",
    messageId: "msg-text-" + Date.now(),
    rawContent: text,
    plainText: text,
    threadKey: undefined,
    conversationKey: "oc_test:main",
    rootId: undefined,
    parentId: undefined,
    messageType: "text",
  };
}

describe("File Upload Intent Gate v1", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "file-intent-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("file upload sends intent gate card instead of auto-summary", async () => {
    const config = createTempConfig(tmpDir);
    const sentPayloads: any[] = [];
    const app = new BridgeApp(config, createMockOutbound(sentPayloads), createMockLogger(), vi.fn() as any, {
      opencode: createMockOpencode() as any,
    });

    await app.handleIncomingMessage(createFileMessage());

    expect(sentPayloads.length).toBeGreaterThan(0);
    const cardContent = JSON.stringify(sentPayloads[0]);
    expect(cardContent).toContain("委托代理合同.pdf");
    expect(cardContent).toContain("已收到文件");
    expect(cardContent).toContain("文件名：委托代理合同.pdf");
    expect(cardContent).toContain("大小：100 KB");
    expect(cardContent).not.toContain("**已收到文件：**");

    const pendingMap = (app as any).pendingInteractions;
    const pending = pendingMap.get("oc_test:main");
    expect(pending).toBeDefined();
    expect(pending?.kind).toBe("file-await-instruction");

    const materialsPath = path.join(config.storage.dataDir, "agent-visibility", "recent-materials.json");
    const materials = JSON.parse(await readFile(materialsPath, "utf-8"));
    expect(materials.materials[0].window_key).toBe("oc_test:main");
    expect(materials.materials[0].message_id).toBe("msg-file-1");
    expect(materials.materials[0].file_name).toBe("委托代理合同.pdf");
  });

  it("file upload intent card handles missing size without showing 0 KB", async () => {
    const config = createTempConfig(tmpDir);
    const sentPayloads: any[] = [];
    const app = new BridgeApp(config, createMockOutbound(sentPayloads), createMockLogger(), vi.fn() as any, {
      opencode: createMockOpencode() as any,
    });

    await app.handleIncomingMessage(createFileMessage("dzfp_26952000002268819436.pdf", undefined));

    const cardContent = JSON.stringify(sentPayloads[0]);
    expect(cardContent).toContain("大小：未上报");
    expect(cardContent).not.toContain("大小：0 KB");
  });

  it("text reply after file upload processes normally", async () => {
    const config = createTempConfig(tmpDir);
    const sentPayloads: any[] = [];
    const app = new BridgeApp(config, createMockOutbound(sentPayloads), createMockLogger(), vi.fn() as any, {
      opencode: createMockOpencode() as any,
    });

    await app.handleIncomingMessage(createFileMessage());
    sentPayloads.length = 0;

    await app.handleIncomingMessage(createTextMessage("帮我审查合同风险"));

    const pendingMap = (app as any).pendingInteractions;
    const pending = pendingMap.get("oc_test:main");
    // Pending should be consumed (key deleted from map)
    expect(pending).toBeUndefined();
  });

  it("slash command after file upload is handled as command", async () => {
    const config = createTempConfig(tmpDir);
    const sentPayloads: any[] = [];
    const app = new BridgeApp(config, createMockOutbound(sentPayloads), createMockLogger(), vi.fn() as any, {
      opencode: createMockOpencode() as any,
    });

    await app.handleIncomingMessage(createFileMessage());
    sentPayloads.length = 0;

    await app.handleIncomingMessage(createTextMessage("/知识入库"));

    const pendingMap = (app as any).pendingInteractions;
    const slashPending = pendingMap.get("oc_test:main");
    expect(slashPending?.kind).not.toBe("file-await-instruction");
  });

  it("file upload with explicit instruction sends directly", async () => {
    const config = createTempConfig(tmpDir);
    const sentPayloads: any[] = [];
    const app = new BridgeApp(config, createMockOutbound(sentPayloads), createMockLogger(), vi.fn() as any, {
      opencode: createMockOpencode() as any,
    });

    await app.handleIncomingMessage({
      ...createFileMessage(),
      plainText: "帮我审查这份合同",
      rawContent: "帮我审查这份合同",
    });

    const pendingMap = (app as any).pendingInteractions;
    expect(pendingMap.get("oc_test:main")).toBeUndefined();
    expect(JSON.stringify(sentPayloads)).not.toContain("你可以直接告诉我你想让我怎么处理");
  });
});
