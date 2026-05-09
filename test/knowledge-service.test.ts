/**
 * 职责: 覆盖知识库服务主流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KnowledgeBaseService } from "../src/knowledge/index.js";

const tempDirs: string[] = [];

describe("KnowledgeBaseService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("ingests a txt file and queries it back", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const createdRecords: Array<Record<string, unknown>> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。劳动合同期限不满三个月的，不得约定试用期。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId, fields) {
          createdRecords.push({ tableId, fields });
          return `${tableId}_${createdRecords.length}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    const ingest = await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    });
    const query = await service.query("员工试用期最长多久？");

    expect(ingest.rawExtractedCount).toBe(1);
    expect(ingest.dedupedCount).toBe(0);
    expect(ingest.extractedCount).toBe(1);
    expect(query.results[0]?.answer).toContain("试用期最长不超过六个月");
    expect(createdRecords).toHaveLength(2);
    service.close();
  });

  it("falls back to keyword search when query embedding fails", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const serviceLogger = { log: vi.fn(), logTranscript: vi.fn() };
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。劳动合同期限不满三个月的，不得约定试用期。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_rec`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      serviceLogger,
    );

    await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider down", { status: 503 })) as typeof fetch);

    const query = await service.query("员工试用期最长多久？");

    expect(query.results[0]?.answer).toContain("试用期最长不超过六个月");
    expect(serviceLogger.log).toHaveBeenCalledWith("knowledge", "embedding query failed, falling back to keyword search", expect.objectContaining({
      detail: expect.stringContaining("embedding request failed"),
    }));
    service.close();
  });

  it("reports write failure when Bitable rejects knowledge entries", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const progress: string[] = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          if (tableId === "tbl_docs") {
            return "doc_rec";
          }
          throw new Error("Bitable 429 rate limited");
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await expect(service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    }, {
      onProgress: async (event) => {
        progress.push(`${event.step}:${event.status}:${event.detail}`);
      },
    })).rejects.toThrow("Bitable 429 rate limited");

    expect(progress).toContain("write:error:成功写入 0 条，失败 1 条");
    service.close();
  });

  it("reports ingest progress by stage", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const progress: Array<{ step: string; status: string; detail?: string | undefined }> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    }, {
      onProgress(update) {
        progress.push(update);
      },
    });

    expect(progress.some((item) => item.step === "read" && item.status === "running")).toBe(true);
    expect(progress.some((item) => item.step === "read" && item.status === "completed")).toBe(true);
    expect(progress.some((item) => item.step === "extract" && item.status === "completed")).toBe(true);
    expect(progress.some((item) => item.step === "write" && item.status === "completed")).toBe(true);
    service.close();
  });

  it("sends knowledge model as an OpenCode model object", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const requests: Array<unknown> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: "tbl_docs",
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {
          default: "minimax-cn-coding-plan/MiniMax-M2.7",
        },
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({ requests }),
      logger(),
    );

    await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    });

    expect(requests[0]).toMatchObject({
      model: {
        providerID: "minimax-cn-coding-plan",
        modelID: "MiniMax-M2.7",
      },
    });
    service.close();
  });

  it("filters noisy extracted questions and limits tags", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("关于解除劳动合同的规则说明。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({
        extract: [
          {
            question: "员工不能胜任工作时，公司可以解除劳动合同吗？",
            answer: "满足法定条件且程序合规时，可以依法解除。",
            tags: ["劳动合同解除", "不能胜任工作", "免责声明", "检索关键词"],
            statute: "《劳动合同法》第 40 条",
          },
          {
            question: "这篇文章的免责声明是什么？",
            answer: "本文仅供学习交流。",
            tags: ["免责声明", "课程学习"],
            statute: "",
          },
        ],
      }),
      logger(),
    );

    const ingest = await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    });

    expect(ingest.rawExtractedCount).toBe(1);
    expect(ingest.dedupedCount).toBe(0);
    expect(ingest.extractedCount).toBe(1);
    expect(ingest.tagCounts).toEqual({
      劳动合同解除: 1,
      不能胜任工作: 1,
    });
    service.close();
  });

  it("keeps broad legal fixtures while filtering non-consulting noise", async () => {
    stubEmbeddingFetchWideSequence();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const requests: Array<{ parts: Array<{ text?: string }> }> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "通用法律知识.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("通用法律知识固定回归样本。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({
        requests,
        extract: [
          ...createLaborLegalFixture(),
          ...createGeneralLegalFixture(),
          ...createNoiseLegalFixture(),
        ],
      }),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_general_legal",
      fileKey: "file_general_legal",
      fileName: "通用法律知识.txt",
    });
    const extractPrompt = requests.find((request) => request.parts[0]?.text?.includes("法律知识提取专家"))?.parts[0]?.text ?? "";

    expect(result.rawExtractedCount).toBe(20);
    expect(result.extractedCount).toBe(20);
    expect(result.tagCounts).toEqual(expect.objectContaining({
      劳动争议: 1,
      公司治理: 2,
      知识产权: 2,
      行政合规: 1,
      案由: 1,
      审理程序: 1,
      案例来源: 1,
    }));
    expect(result.tagCounts).not.toHaveProperty("免责声明");
    expect(result.tagCounts).not.toHaveProperty("课程学习");
    expect(extractPrompt).toContain("合同纠纷、公司治理、知识产权");
    expect(extractPrompt).toContain("股东会决议程序存在瑕疵");
    expect(extractPrompt).toContain("未经许可使用他人注册商标");
    expect(extractPrompt).not.toContain("范围限定在劳动用工");
    expect(extractPrompt).not.toContain("劳动合同期满，用人单位不续签");
    service.close();
  });

  it("writes source file as a hyperlink field when configured", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const createdRecords: Array<Record<string, unknown>> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: "tbl_docs",
            sourceFileField: {
              name: "资料链接",
              type: "hyperlink",
              urlTemplate: "https://example.com/files/{{messageId}}/{{fileKey}}",
              textTemplate: "{{fileName}}",
            },
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId, fields) {
          createdRecords.push({ tableId, fields });
          return `${tableId}_${createdRecords.length}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    });

    expect(createdRecords[1]?.fields).toEqual(expect.objectContaining({
      资料链接: {
        text: "劳动合同.txt",
        link: "https://example.com/files/om_file_1/file_1",
      },
    }));
    service.close();
  });

  it("writes statute as a hyperlink field when configured", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const createdRecords: Array<Record<string, unknown>> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: "tbl_docs",
            statuteField: {
              name: "法条",
              type: "hyperlink",
              urlTemplate: "https://example.com/law?keyword={{statute}}",
              textTemplate: "{{statute}}",
            },
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId, fields) {
          createdRecords.push({ tableId, fields });
          return `${tableId}_${createdRecords.length}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    });

    expect(createdRecords[1]?.fields).toEqual(expect.objectContaining({
      法条: {
        text: "《劳动合同法》第 19 条",
        link: "https://example.com/law?keyword=%E3%80%8A%E5%8A%B3%E5%8A%A8%E5%90%88%E5%90%8C%E6%B3%95%E3%80%8B%E7%AC%AC%2019%20%E6%9D%A1",
      },
    }));
    service.close();
  });

  it("omits empty hyperlink statute fields", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const createdRecords: Array<Record<string, unknown>> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: "tbl_docs",
            statuteField: {
              name: "法条",
              type: "hyperlink",
              urlTemplate: "https://example.com/law?keyword={{statute}}",
              textTemplate: "{{statute}}",
            },
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId, fields) {
          createdRecords.push({ tableId, fields });
          return `${tableId}_${createdRecords.length}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({ statute: "" }),
      logger(),
    );

    await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "劳动合同.txt",
    });

    expect(createdRecords[1]?.fields).not.toHaveProperty("法条");
    service.close();
  });

  it("uses OpenCode to ingest a webpage as markdown", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const createdRecords: Array<Record<string, unknown>> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: true, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: "tbl_docs",
            sourceFileField: {
              name: "来源链接",
              type: "hyperlink",
              urlTemplate: "https://example.com/files/{{messageId}}",
              textTemplate: "{{fileName}}",
            },
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt", ".md"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord(_appToken, tableId, fields) {
          createdRecords.push({ tableId, fields });
          return `${tableId}_${createdRecords.length}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    const ingest = await service.ingestWebPage({
      url: "https://example.com/law",
      instruction: "读取这个网页并入库",
      messageId: "om_web_1",
    });

    expect(ingest.sourceFile).toBe("劳动合同法网页.md");
    expect(ingest.rawExtractedCount).toBe(1);
    expect(ingest.dedupedCount).toBe(0);
    expect(ingest.extractedCount).toBe(1);
    expect(createdRecords[0]?.fields).toEqual(expect.objectContaining({
      来源类型: "web-url",
      来源链接: "https://example.com/law",
    }));
    expect(createdRecords[1]?.fields).toEqual(expect.objectContaining({
      来源链接: {
        text: "劳动合同法网页.md",
        link: "https://example.com/law",
      },
    }));
    service.close();
  });

  it("syncs existing bitable records into the local mirror", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: undefined,
            sourceFileField: {
              name: "资料链接",
              type: "hyperlink",
              urlTemplate: "https://example.com/files/{{messageId}}/{{fileKey}}",
              textTemplate: "{{fileName}}",
            },
            statuteField: {
              name: "法条",
              type: "hyperlink",
              urlTemplate: "https://example.com/law?keyword={{statute}}",
              textTemplate: "{{statute}}",
            },
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord() {
          throw new Error("not used");
        },
        async listBitableRecords() {
          return [{
            recordId: "rec_1",
            fields: {
              问题: "员工试用期最长多久？",
              答案: "最长不超过六个月。",
              标签: ["劳动"],
              法条: {
                text: "《劳动合同法》第 19 条",
                link: "https://example.com/law?keyword=劳动合同法",
              },
              资料链接: {
                text: "劳动合同法手册.pdf",
                link: "https://example.com/files/om_1/file_1",
              },
              "页码/章节": "第 23 页",
            },
          }];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.syncMirror();
    const result = await service.query("员工试用期最长多久？");
    expect(result.results).toHaveLength(1);
    expect(result.bitableUrl).toBe("https://feishu.cn/base/app_token?table=tbl_entries");
    expect(result.results[0]?.sourceFile).toBe("劳动合同法手册.pdf");
    expect(result.results[0]?.statute).toBe("《劳动合同法》第 19 条");
    service.close();
  });

  it("removes local mirrored entries after the corresponding Bitable records are deleted", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    let remoteRecords = [
      {
        recordId: "rec_1",
        fields: {
          问题: "员工试用期最长多久？",
          答案: "最长不超过六个月。",
          标签: ["劳动"],
          源文件: "劳动合同法手册.pdf",
          "页码/章节": "第 23 页",
        },
      },
      {
        recordId: "rec_2",
        fields: {
          问题: "公司不续签需要支付补偿吗？",
          答案: "符合条件时应支付经济补偿。",
          标签: ["劳动"],
          源文件: "经济补偿指引.pdf",
          "页码/章节": "第 8 页",
        },
      },
    ];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: undefined,
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord() {
          throw new Error("not used");
        },
        async listBitableRecords() {
          return remoteRecords;
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.syncMirror();
    let stats = await service.getStats?.();
    expect(stats?.documentCount).toBe(2);
    expect(stats?.entryCount).toBe(2);
    let documents = await service.listDocuments?.({ limit: 10 });
    expect(documents?.some((item) => item.fileName === "经济补偿指引.pdf")).toBe(true);

    remoteRecords = [remoteRecords[0]!];
    await service.syncMirror();

    stats = await service.getStats?.();
    expect(stats?.documentCount).toBe(1);
    expect(stats?.entryCount).toBe(1);
    documents = await service.listDocuments?.({ limit: 10 });
    expect(documents?.some((item) => item.fileName === "经济补偿指引.pdf")).toBe(false);
    service.close();
  });

  it("deduplicates equivalent query answers from the same source", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const answer = "经济补偿按工作年限计算；违法解除的赔偿金按经济补偿标准的二倍计算。";
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: undefined,
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord() {
          throw new Error("not used");
        },
        async listBitableRecords() {
          return [1, 2, 3].map((index) => ({
            recordId: `rec_${index}`,
            fields: {
              问题: `赔偿金如何计算 ${index}`,
              答案: answer,
              标签: ["劳动"],
              法条: "《劳动合同法》第 47 条、第 87 条",
              源文件: "劳动法知识库演示材料.md",
              "页码/章节": "文本 7-10",
            },
          }));
        },
      },
      {
        async createSession() {
          return { id: "ses_1", title: "rerank" };
        },
        async deleteSession() {
          return true;
        },
        async postMessageSync() {
          return assistantMessage(JSON.stringify([
            { id: 1, score: 0.99 },
            { id: 2, score: 0.98 },
            { id: 3, score: 0.97 },
          ]));
        },
      },
      logger(),
    );

    await service.syncMirror();
    const result = await service.query("违法解除赔偿金怎么计算？");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.answer).toBe(answer);
    service.close();
  });

  it("returns exact statute matches before embedding and rerank", async () => {
    const fetchSpy = stubEmbeddingFetchCounter();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const createdSessions: string[] = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: undefined,
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord() {
          throw new Error("not used");
        },
        async listBitableRecords() {
          return [
            {
              recordId: "rec_1",
              fields: {
                问题: "试用期可以约定多久？",
                答案: "《劳动合同法》第十九条规定，试用期应当与劳动合同期限匹配。",
                标签: ["劳动"],
                法条: "《劳动合同法》第 19 条",
                源文件: "劳动合同法条文.md",
                "页码/章节": "第十九条",
              },
            },
            {
              recordId: "rec_2",
              fields: {
                问题: "违法解除赔偿金怎么计算？",
                答案: "赔偿金通常按经济补偿标准的二倍计算。",
                标签: ["劳动"],
                法条: "《劳动合同法》第 87 条",
                源文件: "劳动合同法条文.md",
                "页码/章节": "第八十七条",
              },
            },
          ];
        },
      },
      {
        async createSession(title: string) {
          createdSessions.push(title);
          return { id: `ses_${createdSessions.length}`, title };
        },
        async deleteSession() {
          return true;
        },
        async postMessageSync() {
          throw new Error("exact statute query should not use llm rerank");
        },
      },
      logger(),
    );

    await service.syncMirror();
    fetchSpy.mockClear();
    const result = await service.query("劳动合同法第十九条");

    expect(result.results[0]?.statute).toBe("《劳动合同法》第 19 条");
    expect(result.results[0]?.source).toBe("exact_article");
    expect(result.results[0]?.reranked).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createdSessions).not.toContain("[bridge] knowledge-rerank");
    service.close();
  });

  it("falls back to article markers in answer and page section when statute is empty", async () => {
    stubEmbeddingFetchCounter();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: undefined,
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord() {
          throw new Error("not used");
        },
        async listBitableRecords() {
          return [{
            recordId: "rec_1",
            fields: {
              问题: "试用期条款有哪些限制？",
              答案: "劳动合同法第十九条要求试用期期限与合同期限匹配。",
              标签: ["劳动"],
              法条: "",
              源文件: "劳动合同法问答.md",
              "页码/章节": "第十九条解读",
            },
          }];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.syncMirror();
    const result = await service.query("劳动合同法第19条");

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.source).toBe("exact_article");
    expect(result.results[0]?.answer).toContain("第十九条");
    service.close();
  });

  it("uses jina-compatible rerank provider before falling back to llm rerank", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.95 },
            { index: 0, relevance_score: 0.7 },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        data: [{ embedding: [1, 0, 0, 0] }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy as typeof fetch);
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 2, keywordFallbackLimit: 10 },
        rerank: {
          provider: "jina-compatible",
          endpoint: "https://rerank.example.com/",
          model: "BAAI/bge-reranker-v2-m3",
          topN: 2,
          timeoutMs: 5_000,
        },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: undefined,
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord() {
          throw new Error("not used");
        },
        async listBitableRecords() {
          return [
            {
              recordId: "rec_1",
              fields: {
                问题: "违法解除劳动合同怎么赔？",
                答案: "一般问题答案。",
                标签: ["劳动"],
                源文件: "劳动问答.md",
                embedding: JSON.stringify([1, 0, 0, 0]),
              },
            },
            {
              recordId: "rec_2",
              fields: {
                问题: "违法解除劳动合同赔偿金怎么计算？",
                答案: "赔偿金通常按经济补偿标准二倍计算。",
                标签: ["劳动"],
                源文件: "劳动问答.md",
                embedding: JSON.stringify([1, 0, 0, 0]),
              },
            },
          ];
        },
      },
      {
        async createSession() {
          throw new Error("configured rerank provider should avoid llm rerank");
        },
        async deleteSession() {
          return true;
        },
        async postMessageSync() {
          throw new Error("configured rerank provider should avoid llm rerank");
        },
      },
      logger(),
    );

    await service.syncMirror();
    const result = await service.query("违法解除赔偿金怎么计算？");

    expect(result.results[0]?.reranked).toBe(true);
    expect(result.results[0]?.score).toBe(0.95);
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL("rerank", "https://rerank.example.com/"),
      expect.objectContaining({ method: "POST" }),
    );
    service.close();
  });

  it("does not fail keyword fallback for slash-heavy questions", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            documentTableId: undefined,
          },
        },
        embeddingProvider: {
          baseUrl: new URL("https://example.com/v1/"),
          apiKey: "token",
          model: "text-embedding",
        },
        models: {},
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord() {
          throw new Error("not used");
        },
        async listBitableRecords() {
          return [{
            recordId: "rec_1",
            fields: {
              问题: "网页入库怎么操作？",
              答案: "发送 /legal-query-start 后，可以要求读取网页并入库。",
              标签: ["知识库"],
              源文件: "操作说明.md",
              "页码/章节": "文本 1",
            },
          }];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.syncMirror();
    const result = await service.query("https://example.com/a/b 怎么入库？");
    expect(result.results.length).toBeGreaterThan(0);
    service.close();
  });

  it("detects structured QA documents and enriches them without chunk extraction", async () => {
    stubEmbeddingFetchSequence();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const requests: Array<{ parts: Array<{ text?: string }> }> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "faq.txt",
            mimeType: "text/plain",
            buffer: Buffer.from([
              "问：试用期最长多久？",
              "答：最长不超过六个月。",
              "",
              "问：试用期工资可以低于最低工资吗？",
              "答：不得低于本单位相同岗位最低档工资或者劳动合同约定工资的百分之八十，也不得低于最低工资标准。",
              "",
              "问：医疗期内能解除劳动合同吗？",
              "答：一般不得解除。",
              "",
              "问：公司不续签要补偿吗？",
              "答：符合条件的，应支付经济补偿。",
              "",
              "问：试用期可以随意辞退吗？",
              "答：不可以，仍需符合法定条件。",
            ].join("\n"), "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({ requests }),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "faq.txt",
    });

    expect(result.extractedCount).toBe(5);
    expect(requests.some((request) => (request.parts[0]?.text ?? "").includes("法律知识补充助手"))).toBe(true);
    expect(requests.some((request) => (request.parts[0]?.text ?? "").includes("法律知识提取专家"))).toBe(false);
    service.close();
  });

  it("detects numbered question plus answer documents as structured QA", async () => {
    stubEmbeddingFetchSequence();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const requests: Array<{ parts: Array<{ text?: string }> }> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "numbered-faq.txt",
            mimeType: "text/plain",
            buffer: Buffer.from([
              "0001 用人单位自何时起与劳动者建立劳动关系？",
              "答：用人单位自用工之日起与劳动者建立劳动关系。",
              "依据：《劳动合同法》第 7 条",
              "",
              "0002 在认定是否具有劳动关系时，需要考虑哪些因素？",
              "答：需要考虑主体资格、劳动管理和业务组成部分等因素。",
              "依据：《关于确立劳动关系有关事项的通知》",
              "",
              "0003 用人单位能否招用未满16周岁的未成年人？",
              "答：原则上禁止招用。",
              "",
              "0004 台湾地区、香港特别行政区、澳门特别行政区居民能否成为劳动关系主体？",
              "答：可以。",
              "",
              "0005 外国人能否成为劳动关系主体？",
              "答：依法取得就业证件的，可以依法建立劳动关系。",
            ].join("\n"), "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({ requests }),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_file_2",
      fileKey: "file_2",
      fileName: "numbered-faq.txt",
    });

    expect(result.extractedCount).toBe(5);
    expect(requests.some((request) => (request.parts[0]?.text ?? "").includes("法律知识补充助手"))).toBe(true);
    expect(requests.some((request) => (request.parts[0]?.text ?? "").includes("法律知识提取专家"))).toBe(false);
    service.close();
  });

  it("skips ignored chapters before normal extraction", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const requests: Array<{ parts: Array<{ text?: string }> }> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "chapters.txt",
            mimeType: "text/plain",
            buffer: Buffer.from([
              "# 目录",
              "",
              "目录内容不应进入提取",
              "",
              "第一章 招聘与录用",
              "",
              "这是正文第一章，涉及劳动合同订立与录用管理。",
              "",
              "一、背景调查",
              "",
              "这是正文第二章，涉及背景调查与告知义务。",
              "",
              "附录",
              "",
              "附录内容不应进入提取",
            ].join("\n\n"), "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({ requests }),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_file_1",
      fileKey: "file_1",
      fileName: "chapters.txt",
    });

    const extractRequests = requests.filter((request) => (request.parts[0]?.text ?? "").includes("法律知识提取专家"));
    expect(extractRequests.length).toBeGreaterThan(0);
    const joinedPrompts = extractRequests.map((request) => request.parts[0]?.text ?? "").join("\n");
    expect(joinedPrompts).toContain("劳动合同订立与录用管理");
    expect(joinedPrompts).toContain("背景调查与告知义务");
    expect(joinedPrompts).not.toContain("目录内容不应进入提取");
    expect(joinedPrompts).not.toContain("附录内容不应进入提取");
    expect(result.warning).toContain("已跳过无效章节");
    service.close();
  });

  it("caps extracted qa count by maxExtractQas and adds a warning", async () => {
    stubEmbeddingFetchSequence();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 3,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "faq.txt",
            mimeType: "text/plain",
            buffer: Buffer.from([
              "问：试用期最长多久？",
              "答：最长不超过六个月。",
              "",
              "问：试用期工资可以低于最低工资吗？",
              "答：不得低于本单位相同岗位最低档工资或者劳动合同约定工资的百分之八十，也不得低于最低工资标准。",
              "",
              "问：医疗期内能解除劳动合同吗？",
              "答：一般不得解除。",
              "",
              "问：公司不续签要补偿吗？",
              "答：符合条件的，应支付经济补偿。",
              "",
              "问：试用期可以随意辞退吗？",
              "答：不可以，仍需符合法定条件。",
            ].join("\n"), "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_file_3",
      fileKey: "file_3",
      fileName: "faq.txt",
    });

    expect(result.extractedCount).toBe(3);
    expect(result.warning).toContain("已按质量评分保留前 3 条问答");
    service.close();
  });

  it("retries transient terminated errors during extraction", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const progress: Array<{ step: string; status: string; detail?: string | undefined }> = [];
    const requests: Array<unknown> = [];
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 1, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "retry.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({ extractFailures: 1, requests }),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_file_retry",
      fileKey: "file_retry",
      fileName: "retry.txt",
    }, {
      onProgress(update) {
        progress.push(update);
      },
    });

    expect(result.extractedCount).toBe(1);
    expect(progress.some((item) => item.detail?.includes("正在重试"))).toBe(true);
    expect(requests.filter((request) => ((request as { parts?: Array<{ text?: string }> }).parts?.[0]?.text ?? "").includes("法律知识提取专家"))).toHaveLength(2);
    service.close();
  });

  it("exposes document detail and stats views after ingest", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "劳动合同.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("试用期最长不超过六个月。", "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    await service.ingestFile({
      messageId: "om_file_stats",
      fileKey: "file_stats",
      fileName: "劳动合同.txt",
    });

    const documents = await service.listDocuments({ limit: 10 });
    const detail = await service.getDocument(documents[0]!.id);
    const stats = await service.getStats();

    expect(documents[0]).toEqual(expect.objectContaining({
      fileName: "劳动合同.txt",
      status: "ingested",
      entryCount: 1,
    }));
    expect(detail).toEqual(expect.objectContaining({
      fileName: "劳动合同.txt",
      tagCounts: { 劳动: 1 },
    }));
    expect(stats).toEqual(expect.objectContaining({
      documentCount: 1,
      entryCount: 1,
      statusCounts: expect.objectContaining({ ingested: 1 }),
      tagCounts: expect.objectContaining({ 劳动: 1 }),
    }));
    service.close();
  });

  it("previews extraction from a local file without writing knowledge records", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const localPath = join(dir, "preview.txt");
    writeFileSync(localPath, "试用期最长不超过六个月。", "utf8");
    const createBitableRecord = vi.fn(async (_appToken: string, tableId: string) => `${tableId}_${Date.now()}`);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        createBitableRecord,
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    const preview = await service.previewLocalFileExtraction(localPath, { maxQas: 5 });
    const stats = await service.getStats();

    expect(preview).toEqual(expect.objectContaining({
      sourceFile: "preview.txt",
      extractedCount: 1,
      rawExtractedCount: 1,
      dedupedCount: 0,
    }));
    expect(createBitableRecord).not.toHaveBeenCalled();
    expect(stats.documentCount).toBe(0);
    service.close();
  });

  it("auto-batches long extraction chunks by maxExtractChunks and adds a warning", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const requests: Array<unknown> = [];
    const firstBlock = "第一段：试用期最长不超过六个月。".repeat(80);
    const secondBlock = "第二段：劳动合同期限不满三个月的，不得约定试用期。".repeat(80);
    const thirdBlock = "第三段：试用期工资不得低于法定标准。".repeat(80);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 1, maxExtractChunks: 2, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "long.txt",
            mimeType: "text/plain",
            buffer: Buffer.from([firstBlock, "", secondBlock, "", thirdBlock].join("\n\n"), "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub({ requests }),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_file_long",
      fileKey: "file_long",
      fileName: "long.txt",
    });

    const extractRequests = requests.filter((request) => ((request as { parts?: Array<{ text?: string }> }).parts?.[0]?.text ?? "").includes("法律知识提取专家"));
    expect(extractRequests.length).toBeGreaterThan(2);
    expect(result.warning).toContain("已自动按每批 2 段分");
    service.close();
  });

  it("resumes extraction from staged chunks after interruption", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const firstRunRequests: Array<unknown> = [];
    const secondRunRequests: Array<unknown> = [];
    const firstBlock = "第一段：试用期最长不超过六个月。".repeat(80);
    const secondBlock = "第二段：劳动合同期限不满三个月的，不得约定试用期。".repeat(80);
    const thirdBlock = "第三段：试用期工资不得低于法定标准。".repeat(80);
    const config = {
      enabled: true,
      autoDetect: { enabled: false, minConfidence: 0.75 },
      query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
      storage: {
        sqlitePath: join(dir, "knowledge.db"),
        bitable: {
          appToken: "app_token",
          tableId: "tbl_entries",
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
        allowedExtensions: [".txt"],
        maxFileSizeMb: 20,
        pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 1, maxExtractChunks: 2, maxExtractQas: 500,
      },
    };
    const resources = {
      async downloadMessageResource() {
        return {
          fileName: "resume.txt",
          mimeType: "text/plain",
          buffer: Buffer.from([firstBlock, "", secondBlock, "", thirdBlock].join("\n\n"), "utf8"),
        };
      },
      async createBitableRecord(_appToken: string, tableId: string) {
        return `${tableId}_${Date.now()}`;
      },
      async listBitableRecords() {
        return [];
      },
    };

    const firstRunService = new KnowledgeBaseService(
      config,
      resources,
      createOpenCodeStub({ requests: firstRunRequests, extractFailCallNumbers: [2, 3, 4] }),
      logger(),
    );

    await expect(firstRunService.ingestFile({
      messageId: "om_file_resume",
      fileKey: "file_resume",
      fileName: "resume.txt",
    })).rejects.toThrow(/第 2\/7 段被中断/);
    firstRunService.close();

    const secondRunProgress: Array<{ step: string; status: string; detail?: string | undefined }> = [];
    const secondRunService = new KnowledgeBaseService(
      config,
      resources,
      createOpenCodeStub({ requests: secondRunRequests }),
      logger(),
    );

    const result = await secondRunService.ingestFile({
      messageId: "om_file_resume",
      fileKey: "file_resume",
      fileName: "resume.txt",
    }, {
      onProgress(update) {
        secondRunProgress.push(update);
      },
    });

    const secondExtractRequests = secondRunRequests.filter((request) => ((request as { parts?: Array<{ text?: string }> }).parts?.[0]?.text ?? "").includes("法律知识提取专家"));
    expect(firstRunRequests.filter((request) => ((request as { parts?: Array<{ text?: string }> }).parts?.[0]?.text ?? "").includes("法律知识提取专家"))).toHaveLength(4);
    expect(secondExtractRequests).toHaveLength(6);
    expect(result.extractedCount).toBe(1);
    secondRunService.close();
  });

  it("reuses semantic dedupe embeddings during write", async () => {
    const fetchSpy = stubEmbeddingFetchCounter();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
    tempDirs.push(dir);
    const service = new KnowledgeBaseService(
      {
        enabled: true,
        autoDetect: { enabled: false, minConfidence: 0.75 },
        query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
        storage: {
          sqlitePath: join(dir, "knowledge.db"),
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
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
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 600_000, sessionIdleMs: 1_800_000, concurrency: 3, maxExtractChunks: 30, maxExtractQas: 500,
        },
      },
      {
        async downloadMessageResource() {
          return {
            fileName: "faq.txt",
            mimeType: "text/plain",
            buffer: Buffer.from([
              "问：试用期最长多久？",
              "答：最长不超过六个月。",
              "",
              "问：试用期工资可以低于最低工资吗？",
              "答：不得低于本单位相同岗位最低档工资或者劳动合同约定工资的百分之八十，也不得低于最低工资标准。",
              "",
              "问：医疗期内能解除劳动合同吗？",
              "答：一般不得解除。",
              "",
              "问：公司不续签要补偿吗？",
              "答：符合条件的，应支付经济补偿。",
              "",
              "问：试用期可以随意辞退吗？",
              "答：不可以，仍需符合法定条件。",
            ].join("\n"), "utf8"),
          };
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(),
      logger(),
    );

    const result = await service.ingestFile({
      messageId: "om_file_4",
      fileKey: "file_4",
      fileName: "faq.txt",
    });

    expect(result.extractedCount).toBe(5);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    service.close();
  }, 10_000);
});

function createOpenCodeStub(options?: {
  statute?: string | undefined;
  extract?: Array<Record<string, unknown>>;
  requests?: unknown[];
  extractFailures?: number | undefined;
  extractFailCallNumbers?: number[] | undefined;
}) {
  let counter = 0;
  let extractFailuresRemaining = options?.extractFailures ?? 0;
  let extractCallCount = 0;
  return {
    async createSession(title: string) {
      counter += 1;
      return { id: `ses_${counter}`, title };
    },
    async deleteSession() {
      return true;
    },
    async postMessageSync(_sessionId: string, request: { model?: unknown; parts: Array<{ text?: string }> }) {
      options?.requests?.push(request);
      const prompt = request.parts[0]?.text ?? "";
      if (prompt.includes("网页资料入库助手")) {
        return assistantMessage([
          "# 劳动合同法网页",
          "",
          "来源：https://example.com/law",
          "",
          "试用期最长不超过六个月。劳动合同期限不满三个月的，不得约定试用期。",
        ].join("\n"));
      }
      if (prompt.includes("法律知识补充助手")) {
        const inputMatch = prompt.match(/输入：([\s\S]+?)\n\n只输出 JSON 数组/);
        const parsedInput = inputMatch?.[1] ? JSON.parse(inputMatch[1]) as Array<Record<string, unknown>> : [];
        return assistantMessage(JSON.stringify(parsedInput.map((item) => ({
          question: item.question,
          answer: item.answer,
          tags: ["劳动"],
          statute: options?.statute ?? "《劳动合同法》第 19 条",
        }))));
      }
      if (prompt.includes("知识提取专家")) {
        extractCallCount += 1;
        if (options?.extractFailCallNumbers?.includes(extractCallCount)) {
          throw new Error("terminated");
        }
        if (extractFailuresRemaining > 0) {
          extractFailuresRemaining -= 1;
          throw new Error("terminated");
        }
        return assistantMessage(JSON.stringify(options?.extract ?? [
          {
            question: "员工试用期最长多久？",
            answer: "试用期最长不超过六个月。",
            tags: ["劳动"],
            statute: options?.statute ?? "《劳动合同法》第 19 条",
          },
        ]));
      }
      return assistantMessage(JSON.stringify([
        { id: 1, score: 0.99 },
      ]));
    },
  };
}

function createLaborLegalFixture(): Array<Record<string, unknown>> {
  return [
    {
      question: "劳动合同试用期最长可以约定多久？",
      answer: "试用期期限应当与劳动合同期限相匹配，最长不得超过六个月，同一用人单位与同一劳动者只能约定一次试用期。",
      tags: ["劳动争议"],
      statute: "《劳动合同法》第 19 条",
    },
    {
      question: "公司违法解除劳动合同时员工可以主张什么责任？",
      answer: "公司违法解除劳动合同的，劳动者可以要求继续履行；不能继续履行或劳动者不要求继续履行的，可以主张赔偿金。",
      tags: ["劳动合同解除"],
      statute: "《劳动合同法》第 48 条",
    },
    {
      question: "用人单位未缴社保会产生哪些劳动用工风险？",
      answer: "未依法缴纳社会保险可能引发补缴、行政处理和劳动争议风险，劳动者也可能据此主张解除劳动合同及经济补偿。",
      tags: ["社保"],
      statute: null,
    },
    {
      question: "员工加班费争议通常需要准备哪些证据？",
      answer: "加班费争议通常需要结合考勤记录、加班审批、工作系统记录、工资流水和聊天记录等证明加班事实与工资支付情况。",
      tags: ["加班费"],
      statute: null,
    },
    {
      question: "不能胜任工作解除前公司需要履行哪些程序？",
      answer: "公司通常需要证明劳动者不能胜任工作，并经过培训或调整岗位后仍不能胜任，解除时还应注意通知和补偿安排。",
      tags: ["不能胜任工作"],
      statute: "《劳动合同法》第 40 条",
    },
    {
      question: "经济补偿金计算时月工资口径如何确定？",
      answer: "经济补偿一般按照劳动者解除或终止前十二个月平均工资计算，工作每满一年支付一个月工资。",
      tags: ["经济补偿"],
      statute: "《劳动合同法》第 47 条",
    },
    {
      question: "劳动仲裁时效通常从什么时候开始计算？",
      answer: "劳动争议申请仲裁的时效通常为一年，从当事人知道或者应当知道其权利被侵害之日起计算。",
      tags: ["劳动仲裁"],
      statute: null,
    },
    {
      question: "竞业限制补偿未支付会影响协议履行吗？",
      answer: "用人单位未按约支付竞业限制经济补偿的，劳动者可结合约定和司法规则主张解除或不再履行竞业限制义务。",
      tags: ["竞业限制"],
      statute: null,
    },
    {
      question: "规章制度能否作为解除劳动合同依据？",
      answer: "规章制度作为解除依据通常要求内容合法、经过民主程序制定并向劳动者公示或告知，同时还要证明劳动者存在严重违纪事实。",
      tags: ["规章制度"],
      statute: null,
    },
    {
      question: "工伤停工留薪期内工资应当如何支付？",
      answer: "职工因工伤需要暂停工作接受治疗的，停工留薪期内原工资福利待遇通常不变，由所在单位按月支付。",
      tags: ["工伤"],
      statute: null,
    },
  ];
}

function createGeneralLegalFixture(): Array<Record<string, unknown>> {
  return [
    {
      question: "合同一方迟延付款时守约方可以主张哪些违约责任？",
      answer: "守约方可以结合合同约定和法律规定主张继续履行、违约金、损失赔偿；迟延导致合同目的不能实现时，还可评估解除权。",
      tags: ["合同纠纷"],
      statute: "《民法典》第 577 条",
    },
    {
      question: "买卖合同标的物质量不合格时如何主张救济？",
      answer: "买受人可以根据质量瑕疵程度和合同约定主张修理、更换、退货、减少价款或赔偿损失等救济。",
      tags: ["买卖合同"],
      statute: null,
    },
    {
      question: "股东会决议程序存在瑕疵时效力如何判断？",
      answer: "应结合召集程序、表决方式、表决比例和瑕疵是否影响表决结果判断，严重违反法律或章程的可能被撤销或认定无效。",
      tags: ["公司治理"],
      statute: null,
    },
    {
      question: "董事违反忠实义务给公司造成损失时如何处理？",
      answer: "董事违反忠实义务造成公司损失的，公司可以要求其承担赔偿责任，相关收益也可能依法归公司所有。",
      tags: ["公司治理"],
      statute: "《公司法》",
    },
    {
      question: "未经许可使用他人注册商标会有哪些侵权风险？",
      answer: "未经许可在相同或类似商品服务上使用相同或近似商标并容易导致混淆的，可能构成商标侵权并承担停止侵害和赔偿责任。",
      tags: ["知识产权"],
      statute: "《商标法》第 57 条",
    },
    {
      question: "作品转载未获得授权是否可能构成著作权侵权？",
      answer: "未经许可复制、传播他人作品，且不属于合理使用或法定许可情形的，可能构成著作权侵权并承担停止侵害、赔偿损失等责任。",
      tags: ["知识产权"],
      statute: "《著作权法》",
    },
    {
      question: "行政处罚决定不服可以选择哪些救济路径？",
      answer: "当事人不服行政处罚决定的，可以依法申请行政复议或提起行政诉讼，并注意法定申请期限和起诉期限。",
      tags: ["行政合规"],
      statute: "《行政处罚法》",
    },
    {
      question: "平台收集个人信息应当重点关注哪些合规要求？",
      answer: "平台收集个人信息应遵循合法、正当、必要和诚信原则，明示处理规则，取得相应同意，并落实安全保护义务。",
      tags: ["数据合规"],
      statute: "《个人信息保护法》",
    },
    {
      question: "离婚案件中夫妻共同债务通常如何认定？",
      answer: "夫妻共同债务通常结合共同意思表示、家庭日常生活需要、共同生产经营用途等因素判断，不能仅凭婚姻关系当然认定。",
      tags: ["婚姻家事", "案由"],
      statute: "《民法典》",
    },
    {
      question: "民事二审审理程序中法院会重点审查哪些内容？",
      answer: "二审通常围绕上诉请求及相关事实和法律适用进行审查，并结合一审程序是否合法、证据采信是否适当作出裁判。",
      tags: ["诉讼仲裁", "审理程序", "案例来源"],
      statute: null,
    },
  ];
}

function createNoiseLegalFixture(): Array<Record<string, unknown>> {
  return [
    {
      question: "本课程目录包含哪些章节安排？",
      answer: "第一章为课程介绍，第二章为案例阅读方法，第三章为课后练习安排。",
      tags: ["课程学习"],
      statute: null,
    },
    {
      question: "这篇文章的免责声明是什么内容？",
      answer: "本文仅供学习交流，不构成法律意见，读者应自行核验相关材料。",
      tags: ["免责声明"],
      statute: null,
    },
    {
      question: "作者转载说明主要写了哪些事项？",
      answer: "转载时应注明文章来源和作者信息，不得擅自修改标题或正文。",
      tags: ["转载说明"],
      statute: null,
    },
    {
      question: "案例汇编引言介绍了哪些编辑背景？",
      answer: "引言主要说明案例汇编的资料来源、编排方式和阅读建议。",
      tags: ["资料来源"],
      statute: null,
    },
    {
      question: "全文检索关键词应当如何填写？",
      answer: "可以使用合同、侵权、公司等关键词组合检索，也可以按年份筛选。",
      tags: ["关键词"],
      statute: null,
    },
    {
      question: "培训讲义中的学习目标是什么？",
      answer: "学习目标包括了解课程结构、掌握检索方法和完成章节练习。",
      tags: ["课程学习"],
      statute: null,
    },
    {
      question: "文书类型统计图如何阅读？",
      answer: "统计图展示判决书、裁定书、调解书的数量分布，用于课程资料概览。",
      tags: ["文书类型"],
      statute: null,
    },
    {
      question: "地域分布表格展示了哪些地区？",
      answer: "表格列出华东、华南、华北等地区的案例数量，不直接回答法律咨询。",
      tags: ["地域分布"],
      statute: null,
    },
    {
      question: "胜诉率图表说明了什么统计口径？",
      answer: "图表说明样本选择、统计年份和口径限制，仅用于课程展示。",
      tags: ["胜诉率"],
      statute: null,
    },
    {
      question: "章节学习建议包含哪些阅读顺序？",
      answer: "建议先阅读导论，再阅读案例摘要，最后完成课后自测题。",
      tags: ["学习建议"],
      statute: null,
    },
  ];
}

function assistantMessage(text: string) {
  return {
    info: {
      id: "msg_1",
      role: "assistant",
      sessionID: "ses_1",
      finish: "stop",
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: [{ id: "part_1", type: "text", text }],
  };
}

function logger() {
  return {
    log() {},
    logTranscript() {},
  };
}

function stubEmbeddingFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    data: [{
      embedding: [0.1, 0.2, 0.3],
    }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch);
}

function stubEmbeddingFetchSequence() {
  let counter = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    counter += 1;
    const dimension = 6;
    const embedding = Array.from({ length: dimension }, (_, index) => (index === ((counter - 1) % dimension) ? 1 : 0));
    return new Response(JSON.stringify({
      data: [{
        embedding,
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
}

function stubEmbeddingFetchWideSequence() {
  let counter = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    counter += 1;
    const dimension = 128;
    const embedding = Array.from({ length: dimension }, (_, index) => (index === ((counter - 1) % dimension) ? 1 : 0));
    return new Response(JSON.stringify({
      data: [{
        embedding,
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
}

function stubEmbeddingFetchCounter() {
  let counter = 0;
  const spy = vi.fn(async () => {
    counter += 1;
    const dimension = 8;
    const embedding = Array.from({ length: dimension }, (_, index) => (index === ((counter - 1) % dimension) ? 1 : 0));
    return new Response(JSON.stringify({
      data: [{
        embedding,
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy as typeof fetch);
  return spy;
}
