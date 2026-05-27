/**
 * 职责: 覆盖知识库摄入、查询和存储协作流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import type { KnowledgeIngestOptions } from "../src/knowledge/index.js";
import { BridgeApp, type IncomingChatMessage } from "../src/runtime/app.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";
import { FakeOpenCodeClient, FakeOpenCodeEventStream } from "./integration/fakes.js";

const testDataDir = path.join(os.tmpdir(), "bridge-kb-test-fixed");

describe("knowledge base bridge flow", () => {
  beforeAll(async () => {
    await mkdir(testDataDir, { recursive: true });
  });

  it("keeps private legal-looking questions on the normal OpenCode path without /法律问答", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "这是普通 OpenCode 回复。" });
    const knowledgeQuery = vi.fn(async (question: string) => ({
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
    }));
    const app = new BridgeApp(baseConfig({ autoDetect: true }), outbound, logger(), createWhitelist(), {
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

    await app.handleIncomingMessage(createTextMessage("劳动合同试用期最长多久？"));

    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("这是普通 OpenCode 回复。");
    });
    expect(knowledgeQuery).not.toHaveBeenCalled();
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).not.toContain("知识检索进行中");
  });

  it("does not probe knowledge results for natural legal questions", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "这是普通 OpenCode 回复。" });
    const knowledgeQuery = vi.fn(async (question: string) => ({
      question,
      results: [],
    }));
    const app = new BridgeApp(baseConfig({ autoDetect: true }), outbound, logger(), createWhitelist(), {
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

    await app.handleIncomingMessage(createTextMessage("劳动合同试用期最长多久？"));

    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("这是普通 OpenCode 回复。");
    });
    expect(knowledgeQuery).not.toHaveBeenCalled();
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).not.toContain("法律咨询");
  });

  it("keeps copied knowledge-base questions on the normal OpenCode path without /法律问答", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "这是普通 OpenCode 回复。" });
    const knowledgeQuery = vi.fn(async (question: string) => ({
      question,
      results: [{
        id: 1,
        documentId: 1,
        question,
        answer: "员工试用期最长不超过六个月。",
        tags: ["劳动"],
        statute: "《劳动合同法》第 19 条",
        sourceFile: "劳动合同法手册.pdf",
        pageSection: "第 23 页",
        createdAt: Date.now(),
        score: 0.95,
      }],
    }));
    const app = new BridgeApp(baseConfig({ autoDetect: true }), outbound, logger(), createWhitelist(), {
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

    await app.handleIncomingMessage(createTextMessage("员工试用期最长多久？"));

    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("这是普通 OpenCode 回复。");
    });
    expect(knowledgeQuery).not.toHaveBeenCalled();
    expect(opencode.sessions.size).toBe(1);
  });

  it("routes /法律问答 through bridge-side knowledge lookup in private chat", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const knowledgeQuery = vi.fn(async (question: string) => ({
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
    }));
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

    await app.handleIncomingMessage(createTextMessage("/法律问答 劳动合同试用期最长多久？"));

    expect(knowledgeQuery).toHaveBeenCalledWith("劳动合同试用期最长多久？");
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("知识检索进行中");
    expect(JSON.stringify(updatedPayloads)).toContain("法律咨询");
    expect(JSON.stringify(updatedPayloads)).toContain("试用期最长不超过六个月");
  });

  it("does not route bare 法律问答 text through bridge-side knowledge lookup", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const knowledgeQuery = vi.fn(async (question: string) => ({
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
    }));
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

    await app.handleIncomingMessage(createTextMessage("法律问答 劳动合同试用期最长多久？"));

    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("not used");
    });
    expect(knowledgeQuery).not.toHaveBeenCalled();
  });

  it("starts ingest mode and keeps consuming files until /kb-ingest-end", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const ingestFile = vi.fn(async (_file, options?: KnowledgeIngestOptions) => {
      await options?.onProgress?.({ step: "read", status: "running", detail: "正在下载并解析文件" });
      await options?.onProgress?.({ step: "read", status: "completed", detail: "已提取 1 段正文" });
      await options?.onProgress?.({ step: "extract", status: "running", detail: "提取关键信息：进行中" });
      await options?.onProgress?.({ step: "extract", status: "completed", detail: "已提取 4 条问答" });
      await options?.onProgress?.({ step: "write", status: "running", detail: "生成结果：等待中" });
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
        fileName: "劳动合同2.zip",
      },
      resourceType: "folder",
    });
    expect(ingestFile).not.toHaveBeenCalled();
    await app.handleIncomingMessage(createIngestReplyMessage("/知识入库完成", "om_end"));
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(2);
    });
    expect(ingestFile.mock.calls[1]?.[0]).toMatchObject({
      fileName: "劳动合同2.zip",
      resourceType: "folder",
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库进行中");
    expect(JSON.stringify(updatedPayloads)).toContain("提取问答：进行中");
    expect(JSON.stringify(updatedPayloads)).toContain("写入知识库：等待中");
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    expect(JSON.stringify(updatedPayloads)).toContain("提取 12");
    expect(JSON.stringify(updatedPayloads)).toContain("去重 4");
    expect(JSON.stringify(updatedPayloads)).toContain("劳动合同.txt");
    expect(JSON.stringify(replyPayloads)).not.toContain("已收到结束指令，将处理完当前队列后结束");
    expect(JSON.stringify(replyPayloads)).not.toContain("已收到结束指令，将处理完当前队列后结束");
  });

  it("accepts /完成上传 as the active knowledge ingest finish command", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const ingestFile = vi.fn(async (_file, options?: KnowledgeIngestOptions) => {
      await options?.onProgress?.({ step: "read", status: "completed", detail: "已读取正文" });
      await options?.onProgress?.({ step: "extract", status: "completed", detail: "已提取 1 条问答" });
      await options?.onProgress?.({ step: "write", status: "completed", detail: "已写入知识库" });
      return {
        sourceFile: "劳动法.pdf",
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

    await app.handleIncomingMessage(createTextMessage("/知识入库"));
    await app.handleIncomingMessage(createUploadedFileMessage("劳动法.pdf", "om_file", "file_1"));
    await app.handleIncomingMessage(createTextMessage("/完成上传", "om_finish"));

    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    });
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const serializedUpdates = JSON.stringify(updatedPayloads);
    expect(serializedUpdates).toContain("知识入库进行中");
    expect(serializedUpdates).toContain("知识入库完成");
    expect(serializedUpdates).not.toContain("当前没有进行中的材料收集");
  });

  it("dedupes the same uploaded file while it is already queued or processing", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    let releaseIngest!: () => void;
    let markIngestStarted!: () => void;
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const ingestFile = vi.fn(async (_file, options?: KnowledgeIngestOptions) => {
      await options?.onProgress?.({ step: "read", status: "completed", detail: "已读取正文" });
      markIngestStarted();
      await release;
      await options?.onProgress?.({ step: "extract", status: "completed", detail: "已提取 1 条问答" });
      await options?.onProgress?.({ step: "write", status: "completed", detail: "已写入知识库" });
      return {
        sourceFile: "劳动法.pdf",
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

    await app.handleIncomingMessage(createTextMessage("/知识入库"));
    const file = createUploadedFileMessage("劳动法.pdf", "om_file", "file_1");
    await app.handleIncomingMessage(file);
    await app.handleIncomingMessage(file);
    await app.handleIncomingMessage(createTextMessage("/完成上传", "om_finish"));
    await ingestStarted;
    await app.handleIncomingMessage(file);
    releaseIngest();

    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(1);
    });
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(updatedPayloads)).not.toContain("排队中 1");
  });

  it("does not start ingest mode from natural language 知识入库", async () => {
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

    await app.handleIncomingMessage(createTextMessage("知识入库"));

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).not.toContain("知识入库已开启");
    expect(JSON.stringify(replyPayloads)).not.toContain("发送文件或 URL 即可入库");
  });

  it("does not ingest recently uploaded files from a natural language request", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "文件总结完成。" });
    const ingestFile = vi.fn(async (file) => ({
      sourceFile: file.fileName,
      rawExtractedCount: 2,
      dedupedCount: 0,
      extractedCount: 2,
      tagCounts: { 通用法律: 2 },
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

    await app.handleIncomingMessage(createUploadedFileMessage("公司法实务.pdf", "om_book_1", "file_book_1"));
    await app.handleIncomingMessage(createUploadedFileMessage("合同法案例.pdf", "om_book_2", "file_book_2"));
    await app.handleIncomingMessage(createUploadedFileMessage("知产合规.pdf", "om_book_3", "file_book_3"));
    expect(ingestFile).not.toHaveBeenCalled();

    await app.handleIncomingMessage(createTextMessage("把刚才上传的三本书收入知识库", "om_ingest_recent"));

    expect(ingestFile).not.toHaveBeenCalled();
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).not.toContain("知识入库已开启");
    expect(JSON.stringify(updatedPayloads)).not.toContain("知识入库完成");
  });

  it("does not hijack recent uploaded files when the next message only asks for a summary", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "普通总结完成。" });
    const ingestFile = vi.fn();
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

    await app.handleIncomingMessage(createUploadedFileMessage("说明.txt", "om_recent_file", "file_recent"));
    await app.handleIncomingMessage(createTextMessage("帮我总结一下刚才的文件", "om_summary_recent"));

    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("普通总结完成");
    });
    expect(ingestFile).not.toHaveBeenCalled();
  });

  it("keeps regular files as local-path inputs for OpenCode and adds a lightweight text preview", async () => {
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
    const promptAsync = vi.spyOn(opencode, "promptAsync");
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

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatePayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("处理中");
    expect(outbound.downloadMessageResource).toHaveBeenCalledWith("om_file_plain", "file_plain", "file");
    const request = promptAsync.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const promptText = request?.parts.map((part) => part.text ?? "").join("\n") ?? "";
    const localPath = promptText.match(/本地路径：(.+)/)?.[1]?.trim();
    expect(promptText).toContain("本地路径：");
    expect(promptText).toContain("说明.txt");
    expect(promptText).toContain("请直接识别并总结这个文件的内容");
    expect(promptText).toContain("如果是发票");
    expect(promptText).toContain("不要默认把文件写入知识库");
    expect(promptText).toContain("已提取内容预览");
    expect(promptText).toContain("这是一个需要总结的普通文件。");
    expect(JSON.stringify(updatePayloads)).toContain("文件总结完成");
    expect(localPath).toBeTruthy();
    await expect(readFile(localPath!, "utf8")).rejects.toThrow();
  });

  it("sends uploaded images to OpenCode as file parts for immediate recognition", async () => {
    const outbound = {
      ...createOutbound(),
      downloadMessageResource: vi.fn(async () => ({
        fileName: "img_v3_abc123",
        mimeType: "image/png",
        buffer: Buffer.from("fake image bytes", "utf8"),
      })),
    };
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "这是一张发票图片。" });
    const promptAsync = vi.spyOn(opencode, "promptAsync");
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: null,
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage({
      ...createTextMessage("[图片]", "om_image"),
      messageType: "image",
      file: {
        fileKey: "img_v3_abc123",
        fileName: "img_v3_abc123.png",
      },
      resourceType: "image",
    });

    expect(outbound.downloadMessageResource).toHaveBeenCalledWith("om_image", "img_v3_abc123", "image");
    const request = promptAsync.mock.calls[0]?.[1];
    const promptText = request?.parts.map((part) => part.text ?? "").join("\n") ?? "";
    expect(promptText).toContain("请直接识别并总结这个图片的内容");
    expect(promptText).toContain("文件名：img_v3_abc123.png");
    const imagePart = request?.parts.find((part) => part.type === "file");
    expect(imagePart).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "img_v3_abc123.png",
    });
    expect(String(imagePart?.url)).toMatch(/^data:image\/png;base64,/);
    expect(request?.parts.some((part) => part.type === "image_url")).toBe(false);
  });

  it("cleans temporary regular-file resources even when the turn fails", async () => {
    const outbound = {
      ...createOutbound(),
      downloadMessageResource: vi.fn(async () => ({
        fileName: "说明.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("这是一个需要总结的普通文件。", "utf8"),
      })),
    };
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "unused" });
    let localPath = "";
    vi.spyOn(opencode, "promptAsync").mockImplementation(async (_sessionId, request) => {
      localPath = request.parts.map((part) => part.text ?? "").join("\n").match(/本地路径：(.+)/)?.[1]?.trim() ?? "";
      throw new Error("服务暂时不可用");
    });
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

    expect(localPath).toContain("bridge-turn-file-");
    await expect(readFile(localPath, "utf8")).rejects.toThrow();
    const updatePayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(updatePayloads)).toContain("执行失败");
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
      ...createTextMessage("归档.exe", "om_file_exe"),
      messageType: "file",
      file: {
        fileKey: "file_exe",
        fileName: "归档.exe",
        size: 1_024,
      },
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("仅支持 .pdf / .docx / .txt / .md / .png / .jpg / .jpeg / .webp / .xls / .xlsx / .csv / .zip 文件");
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

  it("rejects zero-byte files before entering the normal file flow", async () => {
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
      ...createTextMessage("空文件.txt", "om_file_empty"),
      messageType: "file",
      file: {
        fileKey: "file_empty",
        fileName: "空文件.txt",
        size: 0,
      },
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("文件为空，请重新上传包含内容的文件");
    expect(appAny.pendingInteractions.has("oc_p2p_1")).toBe(false);
    expect(outbound.downloadMessageResource).not.toHaveBeenCalled();
  });

  it("rejects files that become zero-byte after download", async () => {
    const outbound = {
      ...createOutbound(),
      downloadMessageResource: vi.fn(async () => ({
        fileName: "空文件.txt",
        mimeType: "text/plain",
        buffer: Buffer.alloc(0),
      })),
    };
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "unused" });
    const promptAsync = vi.spyOn(opencode, "promptAsync");
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: null,
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage({
      ...createTextMessage("空文件.txt", "om_file_empty"),
      messageType: "file",
      file: {
        fileKey: "file_empty",
        fileName: "空文件.txt",
        size: 1,
      },
    });

    expect(outbound.downloadMessageResource).toHaveBeenCalledWith("om_file_empty", "file_empty", "file");
    expect(promptAsync).not.toHaveBeenCalled();
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("文件读取失败");
    expect(JSON.stringify(replyPayloads)).toContain("文件为空，请重新上传包含内容的文件");
  });

  it("reports Feishu download failures before starting a file-backed turn", async () => {
    const outbound = {
      ...createOutbound(),
      downloadMessageResource: vi.fn(async () => {
        throw new Error("Feishu downloadMessageResource failed: 404 Not Found");
      }),
    };
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "unused" });
    const promptAsync = vi.spyOn(opencode, "promptAsync");
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist(), {
      knowledge: null,
      opencode,
      eventStream,
      memory: null,
    });

    await app.handleIncomingMessage({
      ...createTextMessage("说明.txt", "om_file_missing"),
      messageType: "file",
      file: {
        fileKey: "file_missing",
        fileName: "说明.txt",
        size: 1,
      },
    });

    expect(outbound.downloadMessageResource).toHaveBeenCalledWith("om_file_missing", "file_missing", "file");
    expect(promptAsync).not.toHaveBeenCalled();
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("文件读取失败");
    expect(JSON.stringify(replyPayloads)).toContain("404 Not Found");
  });

  it("retires /legal-query* aliases in private chat and keeps later messages on the normal OpenCode path", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "这是普通 OpenCode 回复。" });
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
    await app.handleIncomingMessage(createTextMessage("/legal-query 劳动合同试用期最长多久？", "om_2"));
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

    expect(knowledgeQuery).not.toHaveBeenCalled();
    expect(outboundTexts[0]).toContain("命令已更新");
    expect(outboundTexts[0]).toContain("`/legal-query-start`");
    expect(outboundTexts[1]).toContain("命令已更新");
    expect(outboundTexts[1]).toContain("`/法律问答 <问题>`");
    expect(outboundTexts[2]).toContain("命令已更新");
    expect(outboundTexts[2]).toContain("`/legal-query-end`");
    expect(JSON.stringify(allPayloads)).toContain("这是普通 OpenCode 回复");
    expect(appAny.sessionMap["oc_p2p_1"]?.interactionMode ?? "default").toBe("default");
    expect(appAny.sessionMap["oc_p2p_1"]?.sessions).toHaveLength(1);
  });

  it("does not let the retired /legal-query-start alias affect private chat mode", async () => {
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
    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads[0])).toContain("命令已更新");
    const appAny = app as unknown as { sessionMap: Record<string, { interactionMode?: string }> };
    expect(appAny.sessionMap["oc_p2p_1"]?.interactionMode ?? "default").toBe("default");
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
    expect(ingestWebPage).not.toHaveBeenCalled();
    await app.handleIncomingMessage(createIngestReplyMessage("/kb-ingest-end", "om_web_end"));
    await vi.waitFor(() => {
      const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
      expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    });

    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(ingestWebPage).toHaveBeenCalledWith({
      url: "https://example.com/law",
      instruction: "读取 https://example.com/law 这个网页并入库",
      messageId: "om_web",
    }, expect.any(Object));
    expect(knowledgeQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    expect(JSON.stringify(updatedPayloads)).toContain("入库 2");
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
    expect(ingestWebPage).not.toHaveBeenCalled();
    await app.handleIncomingMessage(createIngestReplyMessage("/kb-ingest-end", "om_web_end"));
    await vi.waitFor(() => {
      expect(ingestWebPage).toHaveBeenCalledTimes(1);
    });

    expect(ingestWebPage).toHaveBeenCalledWith({
      url: "https://example.com/law",
      instruction: "https://example.com/law",
      messageId: "om_web",
    }, expect.any(Object));
  });

  it("accepts P2P mainline files into the active ingest chain but keeps plain URLs on the mainline", async () => {
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

    expect(ingestFile).not.toHaveBeenCalled();
    await app.handleIncomingMessage(createTextMessage("/kb-ingest-end", "om_mainline_end"));
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(1);
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(ingestWebPage).not.toHaveBeenCalled();
    expect(appAny.pendingInteractions.has("oc_p2p_1")).toBe(false);
    expect(appAny.knowledgeIngestInteractions.has("oc_p2p_1")).toBe(true);
    expect(JSON.stringify(replyPayloads)).not.toContain("已收到文件");
    expect(JSON.stringify(updatedPayloads)).toContain("主线继续聊天");
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
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
    expect(ingestFile).not.toHaveBeenCalled();
    await app.handleIncomingMessage(createGroupThreadMessage("/kb-ingest-end", "om_group_end", "ou_123"));
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(1);
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }, { replyInThread?: boolean } | undefined]>);
    expect(replyPayloads[0]?.[2]?.replyInThread).toBe(true);
    expect(JSON.stringify(replyPayloads.map((call) => call[1]))).toContain("当前入库任务仅允许发起人继续上传文件");
  });

  it("falls back to the requester's only active group ingest when file thread anchors are unstable", async () => {
    const outbound = createOutbound();
    const eventStream = new FakeOpenCodeEventStream();
    const opencode = new FakeOpenCodeClient(eventStream, { kind: "message-flow", finalText: "not used" });
    const ingestFile = vi.fn(async () => ({
      sourceFile: "劳动法知识库演示材料.md",
      rawExtractedCount: 3,
      dedupedCount: 1,
      extractedCount: 2,
      tagCounts: { 劳动: 2 },
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
      ...createGroupTextMessage("劳动法知识库演示材料.md", "om_group_file_weird", "ou_123"),
      conversationKey: "oc_group_1:detached-topic",
      threadKey: "detached-topic",
      rootId: "om_other_root",
      parentId: "om_other_parent",
      messageType: "file",
      file: {
        fileKey: "file_weird",
        fileName: "劳动法知识库演示材料.md",
      },
    });
    expect(ingestFile).not.toHaveBeenCalled();
    await app.handleIncomingMessage({
      ...createGroupTextMessage("/kb-ingest-end", "om_group_end_weird", "ou_123"),
      conversationKey: "oc_group_1:detached-topic",
      threadKey: "detached-topic",
      rootId: "om_other_root",
      parentId: "om_other_parent",
    });
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(1);
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(updatedPayloads)).toContain("知识入库完成");
    expect(JSON.stringify(replyPayloads)).not.toContain("已收到文件");
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
    await app.handleIncomingMessage({
      ...createIngestReplyMessage("劳动合同.txt", "om_file_1"),
      messageType: "file",
      file: {
        fileKey: "file_1",
        fileName: "劳动合同.txt",
      },
    });
    expect(ingestFile).not.toHaveBeenCalled();
    await app.handleIncomingMessage(createTextMessage("我现在还想问别的问题", "om_busy"));
    await app.handleIncomingMessage(createIngestReplyMessage("/kb-ingest-end", "om_end"));
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(1);
      expect(resolveIngest).toBeTypeOf("function");
    });
    resolveIngest?.();

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    const updatedPayloads = (outbound.updateMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).not.toContain("当前正在处理知识入库任务");
    expect(JSON.stringify(updatedPayloads)).toContain("普通对话继续处理");
  });

  it("keeps accepting queued ingest material even when bridge queueLimit is small", async () => {
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
    expect(ingestFile).not.toHaveBeenCalled();
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
      expect(ingestFile).toHaveBeenCalledTimes(1);
      expect(resolveIngest).toBeTypeOf("function");
    });
    resolveIngest?.();
    await vi.waitFor(() => {
      expect(ingestFile).toHaveBeenCalledTimes(2);
    });

    const replyPayloads = (outbound.replyMessage.mock.calls as unknown as Array<[string, { content: string }]>).map((call) => call[1]);
    expect(JSON.stringify(replyPayloads)).toContain("劳动合同2.txt");
    expect(JSON.stringify(replyPayloads)).not.toContain("已达上限，请等待当前文件处理完成");
  });

  it("marks persisted active ingest sessions interrupted on restart", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "bridge-active-ingest-"));
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
        verificationToken: "",
        encryptKey: "",
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
      port: 3000,
      publicBaseUrl: new URL("http://127.0.0.1:3000/"),
    },
    whitelist: {
      storePath: path.join(testDataDir, "whitelist.json"),
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
      enabled: true,
      autoDetect: { enabled: options?.autoDetect ?? false, minConfidence: 0.75 },
      query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
      storage: {
        sqlitePath: path.join(testDataDir, "knowledge-base.db"),
        bitable: { appToken: "app_token", tableId: "tbl_1", documentTableId: undefined },
      },
      embeddingProvider: {
        baseUrl: new URL("https://example.com/v1/"),
        apiKey: "token",
        model: "text-embedding",
      },
      models: {},
      ingest: {
        allowedExtensions: [".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".xls", ".xlsx", ".csv", ".zip"],
        maxFileSizeMb: 20,
        pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
      },
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

function createUploadedFileMessage(fileName: string, messageId: string, fileKey: string): IncomingChatMessage {
  return {
    ...createTextMessage(fileName, messageId),
    messageType: "file",
    file: {
      fileKey,
      fileName,
      size: 1_024,
    },
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
    threadKey: "main",
    conversationKey: "oc_group_1:main",
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
