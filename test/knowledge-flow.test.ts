import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
      ...createIngestReplyMessage("劳动合同.txt", "om_file_1"),
      messageId: "om_file_1",
      messageType: "file",
      file: {
        fileKey: "file_1",
        fileName: "劳动合同.txt",
      },
    });
    await app.handleIncomingMessage({
      ...createIngestReplyMessage("劳动合同2.txt", "om_file_2"),
      messageType: "file",
      file: {
        fileKey: "file_2",
        fileName: "劳动合同2.txt",
      },
    });
    await app.handleIncomingMessage(createIngestReplyMessage("/kb-ingest-end", "om_end"));
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(2);
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("知识入库处理中");
    expect(JSON.stringify(updatedPayloads)).toContain("正在提取问答（1/1）");
    expect(JSON.stringify(updatedPayloads)).toContain("正在写入知识库（2/4）");
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    expect(JSON.stringify(updatedPayloads)).toContain("原始提取");
    expect(JSON.stringify(updatedPayloads)).toContain("去重合并");
    expect(JSON.stringify(updatedPayloads)).toContain("劳动合同.txt");
    expect(JSON.stringify(replyPayloads)).toContain("本次共处理");
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

  it("rejects unsupported file types before entering the normal file flow", async () => {
    const outbound = {
      ...createOutbound(),
      downloadMessageResource: vi.fn(),
    };
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: null,
      memory: null,
    });
    const appAny = app as unknown as { pendingInteractions: Map<string, unknown> };

    await app.handleIncomingMessage({
      ...createTextMessage("归档.zip", "om_file_zip"),
      messageType: "file",
      file: {
        fileKey: "file_zip",
        fileName: "归档.zip",
        size: 1_024,
      },
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("仅支持 .pdf / .docx / .txt / .md 文件");
    expect(appAny.pendingInteractions.has("oc_p2p_1")).toBe(false);
    expect(outbound.downloadMessageResource).not.toHaveBeenCalled();
  });

  it("rejects oversized files before entering the normal file flow", async () => {
    const outbound = {
      ...createOutbound(),
      downloadMessageResource: vi.fn(),
    };
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: null,
      memory: null,
    });
    const appAny = app as unknown as { pendingInteractions: Map<string, unknown> };

    await app.handleIncomingMessage({
      ...createTextMessage("超大文件.pdf", "om_file_large"),
      messageType: "file",
      file: {
        fileKey: "file_large",
        fileName: "超大文件.pdf",
        size: 25 * 1024 * 1024,
      },
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("文件过大，请控制在 20MB 以内");
    expect(appAny.pendingInteractions.has("oc_p2p_1")).toBe(false);
    expect(outbound.downloadMessageResource).not.toHaveBeenCalled();
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
    await app.handleIncomingMessage(createIngestReplyMessage("读取 https://example.com/law 这个网页并入库", "om_web"));
    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    });

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
    await app.handleIncomingMessage(createIngestReplyMessage("https://example.com/law", "om_web"));

    expect(ingestWebPage).toHaveBeenCalledWith({
      url: "https://example.com/law",
      instruction: "https://example.com/law",
      messageId: "om_web",
    }, expect.any(Object));
  });

  it("keeps P2P mainline file and URL messages out of an active ingest chain", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "主线继续聊天。" });
    const ingestFile = vi.fn(async () => ({
      sourceFile: "劳动合同.txt",
      rawExtractedCount: 1,
      dedupedCount: 0,
      extractedCount: 1,
      tagCounts: { 劳动: 1 },
      durationMs: 1,
    }));
    const ingestWebPage = vi.fn(async () => ({
      sourceFile: "网页.md",
      rawExtractedCount: 1,
      dedupedCount: 0,
      extractedCount: 1,
      tagCounts: { 劳动: 1 },
      durationMs: 1,
    }));
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query() {
          return { question: "", results: [] };
        },
        ingestFile,
        ingestWebPage,
        async syncMirror() {},
        close() {},
      },
      opencode,
      eventStream,
      memory: null,
    });
    const appAny = app as unknown as {
      pendingInteractions: Map<string, unknown>;
      knowledgeIngestInteractions: Map<string, unknown>;
    };

    await app.handleIncomingMessage(createTextMessage("/kb-ingest-start"));
    await app.handleIncomingMessage(createTextMessage("https://example.com/law", "om_mainline_url"));
    await app.handleIncomingMessage({
      ...createTextMessage("劳动合同.txt", "om_mainline_file"),
      messageType: "file",
      file: {
        fileKey: "file_1",
        fileName: "劳动合同.txt",
      },
    });

    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(ingestFile).not.toHaveBeenCalled();
    expect(ingestWebPage).not.toHaveBeenCalled();
    expect(appAny.pendingInteractions.get("oc_p2p_1")).toEqual(expect.objectContaining({
      kind: "file-await-instruction",
      file: expect.objectContaining({ messageId: "om_mainline_file" }),
    }));
    expect(appAny.knowledgeIngestInteractions.has("oc_p2p_1")).toBe(true);
    expect(JSON.stringify(updatedPayloads)).toContain("主线继续聊天");
  });

  it("allows the requester to end P2P ingest from the mainline when the reply chain is hard to find", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: {
        async query() {
          return { question: "", results: [] };
        },
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
    const appAny = app as unknown as { pendingInteractions: Map<string, unknown> };

    await app.handleIncomingMessage(createTextMessage("/kb-ingest-start"));
    await app.handleIncomingMessage(createTextMessage("/kb-ingest-end", "om_mainline_end"));

    const replyCalls = outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>;
    expect(appAny.pendingInteractions.has("oc_p2p_1")).toBe(false);
    expect(replyCalls.at(-1)?.[0]).toBe("om_mainline_end");
    expect(JSON.stringify(replyCalls.at(-1)?.[1])).toContain("已退出知识入库模式");
  });

  it("only accepts the requester in a group ingest thread", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const ingestFile = vi.fn(async () => ({
      sourceFile: "劳动合同.txt",
      rawExtractedCount: 1,
      dedupedCount: 0,
      extractedCount: 1,
      tagCounts: { 劳动: 1 },
      durationMs: 1_000,
    }));
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

    await app.handleIncomingMessage(createGroupTextMessage("/kb-ingest-start", "om_group_start", "ou_123"));
    await app.handleIncomingMessage({
      ...createGroupThreadMessage("别人上传.txt", "om_group_file_other", "ou_456"),
      messageType: "file",
      file: {
        fileKey: "file_other",
        fileName: "别人上传.txt",
      },
    });
    await app.handleIncomingMessage({
      ...createGroupThreadMessage("劳动合同.txt", "om_group_file_requester", "ou_123"),
      messageType: "file",
      file: {
        fileKey: "file_requester",
        fileName: "劳动合同.txt",
      },
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }, { replyInThread?: boolean } | undefined]>);
    expect(replyPayloads[0]?.[2]?.replyInThread).toBe(true);
    expect(ingestFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replyPayloads.map((call) => call[1]))).toContain("当前入库任务仅允许发起人继续上传文件");
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
      ...createIngestReplyMessage("劳动合同.txt", "om_file_1"),
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

  it("rejects new ingest material when the ingest queue is full", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    let resolveIngest: (() => void) | undefined;
    const ingestFile = vi.fn(async (_file, options?: KnowledgeIngestOptions) => {
      await options?.onProgress?.({ step: "read", status: "running", detail: "正在下载并解析文件" });
      await new Promise<void>((resolve) => {
        resolveIngest = resolve;
      });
      return {
        sourceFile: "劳动合同.txt",
        rawExtractedCount: 1,
        dedupedCount: 0,
        extractedCount: 1,
        tagCounts: { 劳动: 1 },
        durationMs: 1_000,
      };
    });
    const app = new BridgeApp(baseConfig({ queueLimit: 1 }), outbound, logger(), createWhitelist(), {
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
      ...createIngestReplyMessage("劳动合同.txt", "om_file_1"),
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
    await app.handleIncomingMessage({
      ...createIngestReplyMessage("劳动合同2.txt", "om_file_2"),
      messageType: "file",
      file: {
        fileKey: "file_2",
        fileName: "劳动合同2.txt",
      },
    });
    resolveIngest?.();
    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(ingestFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replyPayloads)).toContain("已达上限，请等待当前文件处理完成");
  });

  it("marks persisted active ingest sessions interrupted on restart", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bridge-active-ingest-"));
    await writeFile(path.join(dataDir, "mappings.json"), JSON.stringify({
      version: 4,
      mappings: {
        oc_p2p_1: {
          mode: "multi",
          interactionMode: "default",
          activeSessionId: "ses_ingest",
          sessions: [
            { sessionId: "ses_ingest", label: "知识入库", createdAt: 1, lastUsedAt: 2 },
            { sessionId: "ses_chat", label: "普通会话", createdAt: 1, lastUsedAt: 1 },
          ],
        },
      },
    }), "utf8");
    await writeFile(path.join(dataDir, "active-knowledge-ingests.json"), JSON.stringify({
      version: 1,
      records: {
        oc_p2p_1: {
          chatId: "oc_p2p_1",
          chatType: "p2p",
          conversationKey: "oc_p2p_1",
          requesterOpenId: "ou_123",
          rootMessageId: "om_start",
          anchorMessageId: "om_anchor",
          deliveryMode: "p2p_reply",
          ingestSessionId: "ses_ingest",
          previousActiveSessionId: "ses_chat",
          expiresAt: Date.now() + 600_000,
        },
      },
    }), "utf8");
    const config = baseConfig();
    config.storage.dataDir = dataDir;
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const ingestFile = vi.fn();
    const app = new BridgeApp(config, outbound, logger(), createWhitelist(), {
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

    await app.start();
    await app.stop();

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const activeStore = JSON.parse(await readFile(path.join(dataDir, "active-knowledge-ingests.json"), "utf8"));
    const mappings = JSON.parse(await readFile(path.join(dataDir, "mappings.json"), "utf8"));
    expect(JSON.stringify(replyPayloads)).toContain("入库任务因服务重启中断");
    expect(activeStore.records).toEqual({});
    expect(mappings.mappings.oc_p2p_1.activeSessionId).toBe("ses_chat");
    expect(ingestFile).not.toHaveBeenCalled();
  });
});

function baseConfig(options?: { autoDetect?: boolean; queueLimit?: number }): AppConfig {
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
      queueLimit: options?.queueLimit ?? 3,
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
        pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
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

function createIngestReplyMessage(text: string, messageId: string): IncomingChatMessage {
  return {
    ...createTextMessage(text, messageId),
    rootId: "om_reply",
    parentId: "om_reply",
  };
}

function createGroupTextMessage(text: string, messageId: string, senderOpenId: string): IncomingChatMessage {
  return {
    chatId: "oc_group_1",
    chatType: "group",
    senderOpenId,
    messageId,
    messageType: "text",
    rawContent: text,
    plainText: text,
    threadKey: messageId,
    conversationKey: `oc_group_1:${messageId}`,
  };
}

function createGroupThreadMessage(text: string, messageId: string, senderOpenId: string): IncomingChatMessage {
  return {
    ...createGroupTextMessage(text, messageId, senderOpenId),
    rootId: "om_group_start",
    parentId: "om_reply",
    threadKey: "om_group_start",
    conversationKey: "oc_group_1:om_group_start",
  };
}
