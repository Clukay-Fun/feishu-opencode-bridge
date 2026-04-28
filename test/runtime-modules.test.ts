/**
 * 职责: 覆盖运行时模块组合和挂载流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFeishuTransport } from "../src/runtime/feishu-transport.js";
import { createRuntimeModules } from "../src/runtime/runtime-modules.js";
import type { AppConfig } from "../src/config/schema.js";

const tempDirs: string[] = [];

describe("createRuntimeModules", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("assembles modules with the complete outbound resource port", () => {
    expect(() => {
      createRuntimeModules({
        config: createConfig({ knowledgeEnabled: false, contractEnabled: false, laborEnabled: false }),
        outbound: createOutbound(),
        transport: createTransport(),
        logger: { log: vi.fn() } as never,
        opencode: createOpenCode(),
        whitelist: { bind: vi.fn(async () => {}) },
        getSessionWindow: () => ({ mode: "single", interactionMode: "default", activeSessionId: null, sessions: [] }),
        saveSessionWindow: vi.fn(async () => {}),
        createAndBindSession: vi.fn(async () => ({ sessionId: "ses_1", label: "会话", createdAt: 1, lastUsedAt: 1 })),
      });
    }).not.toThrow();
  });

  it("creates the knowledge module through the knowledge service port when enabled", async () => {
    const result = createRuntimeModules({
      config: createConfig({ knowledgeEnabled: true, contractEnabled: false, laborEnabled: false }),
      outbound: createOutbound(),
      transport: createTransport(),
      logger: { log: vi.fn() } as never,
      opencode: createOpenCode(),
      whitelist: { bind: vi.fn(async () => {}) },
      getSessionWindow: () => ({ mode: "single", interactionMode: "default", activeSessionId: null, sessions: [] }),
      saveSessionWindow: vi.fn(async () => {}),
      createAndBindSession: vi.fn(async () => ({ sessionId: "ses_1", label: "会话", createdAt: 1, lastUsedAt: 1 })),
    });

    expect(result.moduleManager.list().map((module) => module.name)).toContain("knowledge");
    await result.moduleManager.stop();
  });

  it("adapts external extension modules through the public runtime context", async () => {
    const result = createRuntimeModules({
      config: {
        ...createConfig({ knowledgeEnabled: false, contractEnabled: false, laborEnabled: false }),
        extensions: {
          demo: { enabled: true },
        },
      },
      outbound: createOutbound(),
      transport: createTransport(),
      logger: { log: vi.fn() } as never,
      opencode: createOpenCode(),
      whitelist: { bind: vi.fn(async () => {}) },
      getSessionWindow: () => ({ mode: "single", interactionMode: "default", activeSessionId: null, sessions: [] }),
      saveSessionWindow: vi.fn(async () => {}),
      createAndBindSession: vi.fn(async () => ({ sessionId: "ses_1", label: "会话", createdAt: 1, lastUsedAt: 1 })),
      externalExtensions: [{
        id: "demo",
        createModule(context) {
          expect(context.config.demo).toEqual({ enabled: true });
          expect("transport" in context).toBe(false);
          return {
            name: "external-demo",
            priority: 120,
            async handleMessage(messageContext) {
              expect(messageContext.window.activeSessionId).toBe("ses_1");
              expect(messageContext.pendingInteraction).toEqual({ kind: "session-select" });
              return { claimed: false };
            },
            async claimFileInstruction(pending) {
              expect(pending).toEqual({
                kind: "file-await-instruction",
                file: {
                  fileKey: "file_1",
                  fileName: "contract.pdf",
                  size: 123,
                },
              });
              return false;
            },
            async beforeTurn(turnContext) {
              expect(turnContext.window.activeSessionId).toBe("ses_1");
              return { systemBlocks: ["external block"] };
            },
          };
        },
      }],
    });

    const message = {
      chatId: "oc_chat",
      chatType: "p2p" as const,
      senderOpenId: "ou_1",
      messageId: "om_1",
      rawContent: "hi",
      plainText: "hi",
      threadKey: "thread",
      conversationKey: "conv",
      messageType: "text" as const,
    };
    const window = {
      mode: "single" as const,
      activeSessionId: "ses_1",
      sessions: [{ sessionId: "ses_1", label: "会话", createdAt: 1, lastUsedAt: 1 }],
    };

    await result.moduleManager.handleMessage({
      message,
      routed: { kind: "message", text: "hi" },
      window,
      pendingInteraction: {
        kind: "session-select",
        options: [{ index: 1, sessionId: "ses_1", title: "真实标题" }],
        expiresAt: Date.now() + 60_000,
      },
    });
    await result.moduleManager.claimFileInstruction({
      kind: "file-await-instruction",
      chatId: "oc_chat",
      conversationKey: "conv",
      requesterOpenId: "ou_1",
      replyToMessageId: "om_file",
      file: {
        messageId: "om_file",
        fileKey: "file_1",
        fileName: "contract.pdf",
        size: 123,
      },
    }, message);

    const blocks = await result.moduleManager.collectBeforeTurnBlocks({
      turn: {
        turnId: "turn_1",
        chatId: "oc_chat",
        conversationKey: "conv",
        threadKey: "thread",
        senderOpenId: "ou_1",
        inboundMessageId: "om_1",
        plainText: "hi",
        text: "hi",
        sessionId: "ses_1",
      },
      window,
    });

    expect(result.moduleManager.list().map((module) => module.name)).toContain("external-demo");
    expect(blocks).toContain("external block");
  });

  it("skips an external extension when createModule throws", () => {
    const logger = { log: vi.fn() };
    const result = createRuntimeModules({
      config: {
        ...createConfig({ knowledgeEnabled: false, contractEnabled: false, laborEnabled: false }),
        extensions: {
          broken: { enabled: true },
        },
      },
      outbound: createOutbound(),
      transport: createTransport(),
      logger: logger as never,
      opencode: createOpenCode(),
      whitelist: { bind: vi.fn(async () => {}) },
      getSessionWindow: () => ({ mode: "single", interactionMode: "default", activeSessionId: null, sessions: [] }),
      saveSessionWindow: vi.fn(async () => {}),
      createAndBindSession: vi.fn(async () => ({ sessionId: "ses_1", label: "会话", createdAt: 1, lastUsedAt: 1 })),
      externalExtensions: [{
        id: "broken",
        createModule() {
          throw new Error("init failed");
        },
      }],
    });

    expect(result.moduleManager.list().map((module) => module.name)).not.toContain("broken");
    expect(logger.log).toHaveBeenCalledWith("runtime/modules", "external extension skipped", expect.objectContaining({
      extensionId: "broken",
      detail: "init failed",
    }));
  });
});

function createOutbound() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "om_send" })),
    replyMessage: vi.fn(async () => ({ messageId: "om_reply" })),
    updateMessage: vi.fn(async () => ({ messageId: "om_update" })),
    downloadMessageResource: vi.fn(async () => ({
      fileName: "fixture.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fixture"),
    })),
    createBitableRecord: vi.fn(async () => "rec_1"),
    listBitableRecords: vi.fn(async () => []),
    updateBitableRecord: vi.fn(async () => {}),
  };
}

function createTransport() {
  return createFeishuTransport({
    sendPayload: vi.fn(async () => ({ messageId: "om_reply" })),
    updatePayload: vi.fn(async () => ({ messageId: "om_update" })),
  });
}

function createOpenCode() {
  return {
    createSession: vi.fn(async () => ({ id: "ses_1", title: "会话", time: { created: 1, updated: 1 } })),
    getSessionMessages: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    postMessageSync: vi.fn(async () => ({
      info: { id: "msg_1", role: "assistant", sessionID: "ses_1", finish: "stop", time: { created: 1, completed: 1 } },
      parts: [],
    })),
    promptAsync: vi.fn(async () => ({ accepted: true as const })),
    replyPermission: vi.fn(async () => true),
    replyQuestion: vi.fn(async () => {}),
    runCommand: vi.fn(async () => ({
      info: { id: "msg_1", role: "assistant", sessionID: "ses_1", finish: "stop", time: { created: 1, completed: 1 } },
      parts: [],
    })),
  };
}

function createConfig(options: { knowledgeEnabled: boolean; contractEnabled: boolean; laborEnabled: boolean }): AppConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "runtime-modules-test-"));
  tempDirs.push(dataDir);
  return {
    storage: {
      dataDir,
      mappingsFile: "mappings.json",
      logsDir: join(dataDir, "logs"),
    },
    bridge: {
      queueLimit: 1,
      maxSessionsPerWindow: 5,
      sessionModes: { p2p: "single", group: "multi" },
      injectSystemState: true,
      firstEventTimeoutMs: 1_000,
      eventGapTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    },
    feishu: {
      appId: "app",
      appSecret: "secret",
      botOpenIds: new Set(),
      botMentionNames: new Set(),
      selfBotOpenIds: new Set(),
      wsUrl: new URL("wss://example.com"),
      allowedOpenIds: new Set(),
      behavior: {
        enableP2p: true,
        enableGroup: true,
        requireBotMentionInGroup: false,
        strictBotMention: false,
        ignoreNonUserSenders: true,
        replyInThread: true,
      },
      cardActions: {
        enabled: false,
        path: "/card",
        verificationToken: "",
        encryptKey: "",
      },
    },
    opencode: {
      baseUrl: new URL("http://127.0.0.1:4096"),
      directory: "/tmp/runtime-modules-test",
    },
    knowledgeBase: {
      enabled: options.knowledgeEnabled,
      autoDetect: { enabled: true, minConfidence: 0.75 },
      query: { topK: 5, finalTopN: 3, keywordFallbackLimit: 5 },
      storage: {
        sqlitePath: join(dataDir, "knowledge.db"),
        bitable: {
          appToken: "app",
          tableId: "tbl",
          documentTableId: "tbl_docs",
        },
      },
      embeddingProvider: {
        baseUrl: new URL("https://example.com/v1/"),
        apiKey: "token",
        model: "text-embedding",
      },
      models: {},
      ingest: {
        maxFileSizeMb: 20,
        pendingTtlMs: 60_000,
        allowedExtensions: [".txt"],
        sessionIdleMs: 1_800_000,
        concurrency: 3,
        maxExtractChunks: 30,
        maxExtractQas: 500,
      },
    },
    memory: {
      enabled: false,
      provider: "obsidian",
      vaultPath: "/tmp/runtime-modules-test/vault",
      syncToObsidian: false,
      appendTranscript: false,
    },
    extensions: {},
    contractAssistant: {
      enabled: options.contractEnabled,
      storage: {
        baseToken: "app",
        contractTableId: "tbl_contract",
        invoiceTableId: "tbl_invoice",
        caseTableId: "tbl_case",
      },
      models: {},
      ingest: {
        contractAllowedExtensions: [".docx"],
        invoiceAllowedExtensions: [".pdf"],
        maxFileSizeMb: 20,
        pendingTtlMs: 60_000,
      },
      reminder: {
        enabled: false,
        targetChatIds: [],
        hour: 9,
        minute: 0,
        lookaheadDays: 7,
      },
    },
    laborSkill: {
      enabled: options.laborEnabled,
      ingest: {
        pendingTtlMs: 60_000,
        allowedExtensions: [".pdf"],
        maxFileSizeMb: 20,
      },
    },
  } as unknown as AppConfig;
}
