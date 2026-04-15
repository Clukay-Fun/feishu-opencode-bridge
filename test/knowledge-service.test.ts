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
  });
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
