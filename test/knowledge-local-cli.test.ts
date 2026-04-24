/**
 * 职责: 覆盖知识库本地 CLI 命令行为。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import type {
  KnowledgeDocumentDetail,
  KnowledgeDocumentSummary,
  KnowledgeExtractPreviewResult,
  KnowledgeIngestResult,
  KnowledgeParsedFileResult,
  KnowledgeQueryResult,
  KnowledgeStatsResult,
} from "../src/knowledge/index.js";
import { createKnowledgeCliRuntime as createKnowledgeCliRuntimeFromFactory } from "../src/knowledge/factory.js";
import {
  createKnowledgeCliRuntime,
  runKnowledgeCli,
  runKnowledgeIngestFileCli,
  runKnowledgeIngestUrlCli,
  runKnowledgeQueryCli,
} from "../src/knowledge/local-cli.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("local knowledge CLI", () => {
  it("reuses the knowledge module factory for the default CLI runtime", () => {
    expect(createKnowledgeCliRuntime).toBe(createKnowledgeCliRuntimeFromFactory);
  });

  it("routes knowledge queries through the unified dispatcher", async () => {
    const createRuntime = vi.fn(async () => createRuntimeStub({
      service: {
        async query(question: string) {
          return { question, results: [] };
        },
      },
    }));

    const result = await runKnowledgeQueryCli(["--json", "--question", "劳动合同试用期最长多久？"], { createRuntime });

    expect(createRuntime).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      result: {
        question: "劳动合同试用期最长多久？",
        results: [],
      },
      error: null,
    });
  });

  it("keeps alias scripts compatible with the unified file ingest command", async () => {
    const createRuntime = vi.fn(async () => createRuntimeStub({
      service: {
        async ingestLocalFile(filePath: string) {
          return {
            sourceFile: path.basename(filePath),
            extractedCount: 2,
            rawExtractedCount: 2,
            dedupedCount: 0,
            tagCounts: { 劳动: 2 },
            durationMs: 120,
          };
        },
      },
    }));

    const result = await runKnowledgeIngestFileCli(["--json", "--path", "/tmp/demo.pdf"], { createRuntime });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      error: null,
      result: expect.objectContaining({
        sourceFile: "demo.pdf",
      }),
    }));
  });

  it("returns a validation error when the file path is missing", async () => {
    const createRuntime = vi.fn(async () => createRuntimeStub());

    const result = await runKnowledgeIngestFileCli(["--json"], { createRuntime });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("--path");
  });

  it("passes url and instruction through to the ingest runtime", async () => {
    const ingestWebPage = vi.fn(async ({ url, instruction }: { url: string; instruction?: string }) => ({
      sourceFile: url,
      extractedCount: 2,
      rawExtractedCount: 2,
      dedupedCount: 0,
      tagCounts: { 劳动: 2 },
      durationMs: 100,
      warning: instruction,
    }));
    const createRuntime = vi.fn(async () => createRuntimeStub({
      service: {
        ingestWebPage,
      },
    }));

    const result = await runKnowledgeIngestUrlCli([
      "--json",
      "--url",
      "https://example.com/law",
      "--instruction",
      "读取并入库",
    ], { createRuntime });

    expect(ingestWebPage).toHaveBeenCalledWith({
      url: "https://example.com/law",
      instruction: "读取并入库",
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      error: null,
    }));
  });

  it("ingests directories serially, filters by extension, and continues after file failures by default", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "kb-cli-dir-"));
    tempDirs.push(rootDir);
    writeFileSync(path.join(rootDir, "a.txt"), "A");
    writeFileSync(path.join(rootDir, "b.pdf"), "B");
    writeFileSync(path.join(rootDir, "ignore.zip"), "Z");
    const nestedDir = path.join(rootDir, "nested");
    writeFileSync(path.join(rootDir, "nested.tmp"), "tmp");
    mkdirSync(nestedDir);
    writeFileSync(path.join(nestedDir, "c.txt"), "C");

    const ingestLocalFile = vi.fn(async (filePath: string) => {
      if (filePath.endsWith("b.pdf")) {
        throw new Error("broken pdf");
      }
      return {
        sourceFile: path.basename(filePath),
        extractedCount: 1,
        rawExtractedCount: 2,
        dedupedCount: 1,
        tagCounts: { 劳动: 1 },
        durationMs: 50,
      };
    });
    const createRuntime = vi.fn(async () => createRuntimeStub({
      config: createConfig({ allowedExtensions: [".txt", ".pdf"] }),
      service: {
        ingestLocalFile,
      },
    }));

    const result = await runKnowledgeCli([
      "ingest",
      "dir",
      "--path",
      rootDir,
      "--recursive",
    ], { createRuntime });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      error: null,
      result: expect.objectContaining({
        totalFiles: 3,
        successCount: 2,
        failureCount: 1,
        totalExtractedCount: 2,
      }),
    }));
    expect(ingestLocalFile).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("ignore.zip");
  });

  it("routes parse, extract, doc, stats, and doctor commands through the unified dispatcher", async () => {
    const createRuntime = vi.fn(async () => createRuntimeStub({
      service: {
        async parseLocalFile(filePath: string) {
          return {
            sourceFile: path.basename(filePath),
            markdown: "# 标题",
            sectionCount: 1,
            parserUsed: "pymupdf4llm",
          };
        },
        async previewLocalFileExtraction() {
          return {
            sourceFile: "demo.pdf",
            parserUsed: "pymupdf4llm",
            sectionCount: 2,
            chunkCount: 1,
            rawExtractedCount: 2,
            dedupedCount: 1,
            extractedCount: 1,
            items: [{
              question: "Q",
              answer: "A",
              tags: ["劳动"],
              pageSection: "段落 1",
            }],
          };
        },
        async listDocuments() {
          return [{
            id: 1,
            sourceType: "local-file",
            title: "demo.pdf",
            fileName: "demo.pdf",
            checksum: "sha",
            status: "ingested",
            createdAt: 1,
            entryCount: 3,
            extractChunkCount: 0,
          }];
        },
        async getDocument(id: number) {
          return {
            id,
            sourceType: "local-file",
            title: "demo.pdf",
            fileName: "demo.pdf",
            checksum: "sha",
            status: "ingested",
            createdAt: 1,
            entryCount: 3,
            extractChunkCount: 0,
            tagCounts: { 劳动: 3 },
            sampleEntries: [],
          };
        },
        async getStats() {
          return {
            documentCount: 1,
            entryCount: 3,
            statusCounts: { ingested: 1 },
            tagCounts: { 劳动: 3 },
            recentDocuments: [],
          };
        },
      },
    }));
    const inspectDoctor = vi.fn(async () => ({
      online: true,
      checks: [{ name: "mock", ok: true, detail: "ok" }],
    }));

    const parseResult = await runKnowledgeCli(["parse", "pdf", "--path", "/tmp/demo.pdf"], { createRuntime });
    const parseMaterialResult = await runKnowledgeCli(["parse", "material", "--path", "/tmp/demo.png"], { createRuntime });
    const extractResult = await runKnowledgeCli(["extract", "--path", "/tmp/demo.pdf", "--max-qas", "5"], { createRuntime });
    const listResult = await runKnowledgeCli(["doc", "list", "--limit", "10"], { createRuntime });
    const showResult = await runKnowledgeCli(["doc", "show", "--id", "1"], { createRuntime });
    const statsResult = await runKnowledgeCli(["stats"], { createRuntime });
    const doctorResult = await runKnowledgeCli(["doctor", "--online"], { createRuntime, inspectDoctor });

    expect(parseResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ parserUsed: "pymupdf4llm" }),
    }));
    expect(parseMaterialResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ sourceFile: "demo.png" }),
    }));
    expect(extractResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ extractedCount: 1 }),
    }));
    expect(listResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.arrayContaining([expect.objectContaining({ fileName: "demo.pdf" })]),
    }));
    expect(showResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ id: 1 }),
    }));
    expect(statsResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ documentCount: 1 }),
    }));
    expect(doctorResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ online: true }),
    }));
    expect(inspectDoctor).toHaveBeenCalledOnce();
  });

  it("honors glob, limit, and fail-fast for directory ingest", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "kb-cli-glob-"));
    tempDirs.push(rootDir);
    writeFileSync(path.join(rootDir, "a.txt"), "A");
    writeFileSync(path.join(rootDir, "b.txt"), "B");
    writeFileSync(path.join(rootDir, "note.md"), "M");

    const ingestLocalFile = vi.fn(async (filePath: string) => {
      throw new Error(`failed: ${path.basename(filePath)}`);
    });
    const createRuntime = vi.fn(async () => createRuntimeStub({
      config: createConfig({ allowedExtensions: [".txt", ".md"] }),
      service: {
        ingestLocalFile,
      },
    }));

    const result = await runKnowledgeCli([
      "ingest",
      "dir",
      "--path",
      rootDir,
      "--glob",
      "*.txt",
      "--limit",
      "2",
      "--fail-fast",
    ], { createRuntime });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        totalFiles: 2,
        successCount: 0,
        failureCount: 1,
      }),
    }));
    expect(ingestLocalFile).toHaveBeenCalledTimes(1);
  });
});

function createRuntimeStub(overrides?: {
  config?: AppConfig;
  service?: Partial<ServiceStub>;
}) {
  return {
    config: overrides?.config ?? createConfig(),
    service: createServiceStub(overrides?.service),
    opencode: {
      async health() {
        return { healthy: true as const, version: "test" };
      },
    },
    bitable: {
      async listBitableRecords() {
        return [];
      },
    },
    close() {},
  };
}

type ServiceStub = {
  query(question: string): Promise<KnowledgeQueryResult>;
  ingestLocalFile(filePath: string): Promise<KnowledgeIngestResult>;
  ingestWebPage(request: { url: string; instruction?: string }): Promise<KnowledgeIngestResult>;
  parseLocalFile(filePath: string): Promise<KnowledgeParsedFileResult>;
  previewLocalFileExtraction(filePath?: string, options?: { maxQas?: number }): Promise<KnowledgeExtractPreviewResult>;
  listDocuments(options?: { limit?: number; status?: string }): Promise<KnowledgeDocumentSummary[]>;
  getDocument(id: number): Promise<KnowledgeDocumentDetail | null>;
  getStats(): Promise<KnowledgeStatsResult>;
  close(): void;
};

function createServiceStub(overrides?: Partial<ServiceStub>): ServiceStub {
  return {
    async query(question: string) {
      return { question, results: [] };
    },
    async ingestLocalFile(filePath: string) {
      return {
        sourceFile: path.basename(filePath),
        extractedCount: 1,
        rawExtractedCount: 1,
        dedupedCount: 0,
        tagCounts: {},
        durationMs: 1,
      };
    },
    async ingestWebPage(request: { url: string }) {
      return {
        sourceFile: request.url,
        extractedCount: 1,
        rawExtractedCount: 1,
        dedupedCount: 0,
        tagCounts: {},
        durationMs: 1,
      };
    },
    async parseLocalFile(filePath: string) {
      return {
        sourceFile: path.basename(filePath),
        markdown: "",
        sectionCount: 0,
        parserUsed: "plain-text" as const,
      };
    },
    async previewLocalFileExtraction() {
      return {
        sourceFile: "demo.txt",
        parserUsed: "plain-text" as const,
        sectionCount: 0,
        chunkCount: 0,
        rawExtractedCount: 0,
        dedupedCount: 0,
        extractedCount: 0,
        items: [],
      };
    },
    async listDocuments() {
      return [];
    },
    async getDocument(id: number) {
      void id;
      return null;
    },
    async getStats() {
      return {
        documentCount: 0,
        entryCount: 0,
        statusCounts: {},
        tagCounts: {},
        recentDocuments: [],
      };
    },
    close() {},
    ...overrides,
  };
}

function createConfig(options?: { allowedExtensions?: string[] }): AppConfig {
  return {
    knowledgeBase: {
      enabled: true,
      autoDetect: { enabled: false, minConfidence: 0.75 },
      query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
      models: {},
      ingest: {
        allowedExtensions: options?.allowedExtensions ?? [".txt"],
        maxFileSizeMb: 20,
        pendingTtlMs: 600_000,
        sessionIdleMs: 1_800_000,
        concurrency: 3,
        maxExtractChunks: 30,
        maxExtractQas: 500,
      },
      storage: {
        sqlitePath: "/tmp/test-knowledge.db",
        bitable: {
          appToken: "app",
          tableId: "tbl",
        },
      },
      embeddingProvider: {
        baseUrl: new URL("https://example.com/v1/"),
        apiKey: "token",
        model: "embedding",
      },
    } as unknown as AppConfig["knowledgeBase"],
  } as AppConfig;
}
