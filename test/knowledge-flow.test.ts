import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import type { KnowledgeIngestOptions } from "../src/knowledge/index.js";
import { BridgeApp, type IncomingChatMessage } from "../src/runtime/app.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";
import { FakeOpenCodeClient, FakeOpenCodeEventStream } from "./integration/fakes.js";

describe("knowledge base bridge flow", () => {
  it("uses knowledge results for auto-detected legal questions without creating an OpenCode turn", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig({ autoDetect: true }), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query(question: string) {
          return {
            question,
            results: [{
              id: 1,
              documentId: 1,
              question,
              answer: "试用期最长不超过六个月。",
              tags: ["劳动"],
              statute: "《劳动合同法》第 19 条",
              sourceFile: "劳动合同法手册.pdf",
              pageSection: "第 23 页",
              createdAt: Date.now(),
              score: 0.95,
            }],
          };
        },
        async ingestFile() {
          throw new Error("not used");
        },
        async syncMirror() {},
        close() {},
      },
      memory: null,
    });

    await app.handleIncomingMessage(createTextMessage("劳动合同试用期最长多久？"));

    const appAny = app as unknown as { sessionMap: Record<string, unknown> };
    expect(appAny.sessionMap).toEqual({});
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("劳动合同法手册.pdf");
  });

  it("starts ingest mode and keeps consuming files until /kb-ingest-end", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const ingestFile = vi.fn(async (_file, options?: KnowledgeIngestOptions) => {
      await options?.onProgress?.({ step: "read", status: "running", detail: "正在下载并解析文件" });
      await options?.onProgress?.({ step: "read", status: "completed", detail: "已提取 1 段正文" });
      await options?.onProgress?.({ step: "extract", status: "running", detail: "正在提取问答（1/1）" });
      await options?.onProgress?.({ step: "extract", status: "completed", detail: "已提取 4 条问答" });
      await options?.onProgress?.({ step: "write", status: "running", detail: "正在写入知识库（2/4）" });
      await options?.onProgress?.({ step: "write", status: "completed", detail: "已写入 4 条问答" });
      return {
        sourceFile: "劳动合同.txt",
        rawExtractedCount: 6,
        dedupedCount: 2,
        extractedCount: 4,
        tagCounts: { 劳动: 4 },
        durationMs: 5_000,
      };
    });
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query() {
          return { question: "", results: [] };
        },
        ingestFile,
        async syncMirror() {},
        close() {},
      },
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage(createTextMessage("/kb-ingest-start"));
    await app.handleIncomingMessage({
      ...createTextMessage("劳动合同.txt"),
      messageId: "om_file_1",
      messageType: "file",
      file: {
        fileKey: "file_1",
        fileName: "劳动合同.txt",
      },
    });
    await app.handleIncomingMessage({
      ...createTextMessage("劳动合同2.txt", "om_file_2"),
      messageType: "file",
      file: {
        fileKey: "file_2",
        fileName: "劳动合同2.txt",
      },
    });
    await app.handleIncomingMessage(createTextMessage("/kb-ingest-end", "om_end"));

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(ingestFile).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(replyPayloads)).toContain("知识入库处理中");
    expect(JSON.stringify(updatedPayloads)).toContain("正在提取问答（1/1）");
    expect(JSON.stringify(updatedPayloads)).toContain("正在写入知识库（2/4）");
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    expect(JSON.stringify(updatedPayloads)).toContain("原始提取");
    expect(JSON.stringify(updatedPayloads)).toContain("去重合并");
    expect(JSON.stringify(updatedPayloads)).toContain("劳动合同.txt");
    expect(JSON.stringify(replyPayloads)).toContain("已退出知识入库模式");
  });

  it("asks for intent when receiving a file outside ingest mode and can process it as a normal turn", async () => {
    const outbound = {
      ...createOutbound(),
      downloadMessageResource: vi.fn(async () => ({
        fileName: "说明.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("这是一个需要总结的普通文件。", "utf8"),
      })),
    };
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "文件总结完成。" });
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: null,
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage({
      ...createTextMessage("说明.txt", "om_file_plain"),
      messageType: "file",
      file: {
        fileKey: "file_plain",
        fileName: "说明.txt",
      },
    });
    await app.handleIncomingMessage(createTextMessage("总结这个文件", "om_instruction"));

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatePayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("已收到文件");
    expect(JSON.stringify(replyPayloads)).toContain("/kb-ingest-start");
    expect(outbound.downloadMessageResource).toHaveBeenCalledWith("om_file_plain", "file_plain", "file");
    expect(JSON.stringify(updatePayloads)).toContain("文件总结完成");
  });

  it("queries the knowledge base directly while knowledge mode is enabled, then falls back to OpenCode after exit", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "这是普通 OpenCode 回复。" });
    const knowledgeQuery = vi.fn(async (question: string) => (
      question.includes("试用期")
        ? {
          question,
          results: [{
            id: 1,
            documentId: 1,
            question,
            answer: "试用期最长不超过六个月。",
            tags: ["劳动"],
            statute: "《劳动合同法》第 19 条",
            sourceFile: "劳动合同法手册.pdf",
            pageSection: "第 23 页",
            createdAt: Date.now(),
            score: 0.95,
          }],
        }
        : { question, results: [] }
    ));
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        query: knowledgeQuery,
        async ingestFile() {
          throw new Error("not used");
        },
        async syncMirror() {},
        close() {},
      },
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage(createTextMessage("/legal-query-start"));
    await app.handleIncomingMessage(createTextMessage("劳动合同试用期最长多久？", "om_2"));
    await app.handleIncomingMessage(createTextMessage("解除劳动合同这个问题知识库里没有吗？", "om_3"));
    await app.handleIncomingMessage(createTextMessage("/legal-query-end", "om_4"));
    await app.handleIncomingMessage(createTextMessage("帮我总结一下今天的工作", "om_5"));

    const appAny = app as unknown as { sessionMap: Record<string, { interactionMode?: string; sessions: Array<{ sessionId: string }> }> };
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const outboundTexts = replyPayloads.map((payload) => JSON.stringify(payload));
    const allPayloads = [
      ...(outbound.sendMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]),
      ...(outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]),
      ...(outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]),
    ];

    expect(knowledgeQuery).toHaveBeenCalledTimes(2);
    expect(outboundTexts[0]).toContain("已进入知识库模式");
    expect(outboundTexts[1]).toContain("劳动合同法手册.pdf");
    expect(outboundTexts[2]).toContain("未找到与");
    expect(outboundTexts[3]).toContain("已退出知识库模式");
    expect(JSON.stringify(allPayloads)).toContain("这是普通 OpenCode 回复");
    expect(appAny.sessionMap["oc_p2p_1"]?.interactionMode).toBe("default");
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions).toHaveLength(1);
  });

  it("lets non-legal text use normal chat while knowledge query mode is enabled", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "你好，我在。" });
    const knowledgeQuery = vi.fn(async () => ({ question: "", results: [] }));
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        query: knowledgeQuery,
        async ingestFile() {
          throw new Error("not used");
        },
        async syncMirror() {},
        close() {},
      },
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage(createTextMessage("/legal-query-start"));
    await app.handleIncomingMessage(createTextMessage("你好", "om_hello"));

    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("你好，我在。");
    });
    expect(knowledgeQuery).not.toHaveBeenCalled();
  });

  it("uses OpenCode-assisted web ingestion from natural language while ingest mode is enabled", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const knowledgeQuery = vi.fn(async () => ({ question: "", results: [] }));
    const ingestWebPage = vi.fn(async () => ({
      sourceFile: "劳动合同法网页.md",
      rawExtractedCount: 3,
      dedupedCount: 1,
      extractedCount: 2,
      tagCounts: { 劳动: 2 },
      durationMs: 3_000,
    }));
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        query: knowledgeQuery,
        async ingestFile() {
          throw new Error("not used");
        },
        ingestWebPage,
        async syncMirror() {},
        close() {},
      },
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage(createTextMessage("/kb-ingest-start"));
    await app.handleIncomingMessage(createTextMessage("读取 https://example.com/law 这个网页并入库", "om_web"));

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(ingestWebPage).toHaveBeenCalledWith({
      url: "https://example.com/law",
      instruction: "读取 https://example.com/law 这个网页并入库",
      messageId: "om_web",
    }, expect.any(Object));
    expect(knowledgeQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(replyPayloads)).toContain("知识入库处理中");
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    expect(JSON.stringify(updatedPayloads)).toContain("最终入库");
    expect(JSON.stringify(updatedPayloads)).toContain("劳动合同法网页.md");
  });

  it("ingests plain URLs directly inside ingest mode", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const ingestWebPage = vi.fn(async () => ({
      sourceFile: "劳动合同法网页.md",
      rawExtractedCount: 2,
      dedupedCount: 0,
      extractedCount: 2,
      tagCounts: { 劳动: 2 },
      durationMs: 3_000,
    }));
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query() {
          return { question: "", results: [] };
        },
        async ingestFile() {
          throw new Error("not used");
        },
        ingestWebPage,
        async syncMirror() {},
        close() {},
      },
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage(createTextMessage("/kb-ingest-start"));
    await app.handleIncomingMessage(createTextMessage("https://example.com/law", "om_web"));

    expect(ingestWebPage).toHaveBeenCalledWith({
      url: "https://example.com/law",
      instruction: "https://example.com/law",
      messageId: "om_web",
    }, expect.any(Object));
  });

  it("allows regular messages while ingest is running", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "普通对话继续处理。" });
    let resolveIngest: (() => void) | undefined;
    const ingestFile = vi.fn(async (_file, options?: KnowledgeIngestOptions) => {
      await options?.onProgress?.({ step: "read", status: "running", detail: "正在下载并解析文件" });
      await new Promise<void>((resolve) => {
        resolveIngest = resolve;
      });
      await options?.onProgress?.({ step: "write", status: "completed", detail: "已写入 1 条问答" });
      return {
        sourceFile: "劳动合同.txt",
        rawExtractedCount: 1,
        dedupedCount: 0,
        extractedCount: 1,
        tagCounts: { 劳动: 1 },
        durationMs: 1_000,
      };
    });
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query() {
          return { question: "", results: [] };
        },
        ingestFile,
        async syncMirror() {},
        close() {},
      },
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage(createTextMessage("/kb-ingest-start"));
    const ingestPromise = app.handleIncomingMessage({
      ...createTextMessage("劳动合同.txt", "om_file_1"),
      messageType: "file",
      file: {
        fileKey: "file_1",
        fileName: "劳动合同.txt",
      },
    });
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(1);
      expect(resolveIngest).toBeTypeOf("function");
    });
    await app.handleIncomingMessage(createTextMessage("我现在还想问别的问题", "om_busy"));
    resolveIngest?.();
    await ingestPromise;

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).not.toContain("当前正在处理知识入库任务");
    expect(JSON.stringify(updatedPayloads)).toContain("普通对话继续处理");
  });
});

function baseConfig(options?: { autoDetect?: boolean }): AppConfig {
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
        verificationToken: "",
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
    embeddings: {
      provider: undefined,
      similarityThreshold: 0.75,
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
      enabled: true,
      autoDetect: { enabled: options?.autoDetect ?? false, minConfidence: 0.75 },
      query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
      storage: {
        sqlitePath: "knowledge-base.db",
        bitable: { appToken: "app_token", tableId: "tbl_1", documentTableId: undefined },
      },
      embeddingProvider: {
        baseUrl: new URL("https://example.com/v1/"),
        apiKey: "token",
        model: "text-embedding",
      },
      models: {},
      ingest: {
        allowedExtensions: [".pdf", ".docx", ".txt", ".md"],
        maxFileSizeMb: 20,
        pendingTtlMs: 600_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
      },
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

function createOutbound() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "om_send" })),
    replyMessage: vi.fn(async () => ({ messageId: "om_reply" })),
    updateMessage: vi.fn(async () => ({ messageId: "om_update" })),
  };
}

function createWhitelist(): ChatWhitelist {
  return {
    isBound() {
      return false;
    },
    async bind() {},
    async unbind() {
      return false;
    },
    count() {
      return 0;
    },
  };
}

function logger() {
  return {
    log() {},
    logTranscript() {},
  };
}

function createTextMessage(text: string, messageId = "om_1"): IncomingChatMessage {
  return {
    chatId: "oc_p2p_1",
    chatType: "p2p",
    senderOpenId: "ou_123",
    messageId,
    messageType: "text",
    rawContent: text,
    plainText: text,
    threadKey: messageId,
    conversationKey: "oc_p2p_1",
  };
}
