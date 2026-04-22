/**
 * 职责: 承载知识库核心业务，负责摄入、检索与结果编排。
 * 关注点:
 * - 解析文档并生成可检索的知识条目。
 * - 执行语义检索、结果排序和引用组织。
 * - 作为运行时模块与存储层之间的业务接口。
 */
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import { OpenAICompatibleEmbeddingClient, type EmbeddingProviderClient } from "../memory/embedding-retriever.js";
import type { OpenCodeClient, OpenCodeModelRef, OpenCodePromptRequest } from "../opencode/client.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import {
  chunkKnowledgeSections,
  groupKnowledgeSectionsByChapter,
  parseKnowledgeFile,
  type KnowledgeParserUsed,
} from "./parser.js";
import {
  KnowledgeDb,
  type KnowledgeDocumentSummary,
  type KnowledgeEntryCandidate,
  type KnowledgeEntryRecord,
} from "./db.js";

export type { KnowledgeDocumentSummary, KnowledgeEntryRecord } from "./db.js";

export type KnowledgeQueryResult = {
  question: string;
  results: KnowledgeEntryCandidate[];
  bitableUrl?: string | undefined;
};

export type KnowledgeIngestResult = {
  sourceFile: string;
  rawExtractedCount?: number | undefined;
  dedupedCount?: number | undefined;
  extractedCount: number;
  tagCounts: Record<string, number>;
  durationMs: number;
  bitableUrl?: string | undefined;
  warning?: string | undefined;
};

export type KnowledgeParsedFileResult = {
  sourceFile: string;
  markdown: string;
  sectionCount: number;
  parserUsed: KnowledgeParserUsed;
};

export type KnowledgeExtractPreviewResult = {
  sourceFile: string;
  parserUsed: KnowledgeParserUsed;
  sectionCount: number;
  chunkCount: number;
  rawExtractedCount: number;
  dedupedCount: number;
  extractedCount: number;
  warning?: string | undefined;
  items: Array<ExtractedQaCandidate>;
};

export type KnowledgeDocumentDetail = KnowledgeDocumentSummary & {
  tagCounts: Record<string, number>;
  sampleEntries: KnowledgeEntryRecord[];
};

export type KnowledgeStatsResult = {
  documentCount: number;
  entryCount: number;
  statusCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  recentDocuments: KnowledgeDocumentSummary[];
};

export type KnowledgeFileRef = {
  messageId: string;
  fileKey: string;
  fileName: string;
  size?: number | undefined;
};

export type KnowledgeWebPageIngestRequest = {
  url: string;
  instruction?: string | undefined;
  messageId?: string | undefined;
};

export type KnowledgeIngestProgressStep = "read" | "extract" | "write";

export type KnowledgeIngestProgressStatus = "pending" | "running" | "completed" | "error";

export type KnowledgeIngestProgressUpdate = {
  step: KnowledgeIngestProgressStep;
  status: KnowledgeIngestProgressStatus;
  detail?: string | undefined;
};

export type KnowledgeIngestOptions = {
  onProgress?: ((update: KnowledgeIngestProgressUpdate) => Promise<void> | void) | undefined;
};

export interface KnowledgeBasePort {
  query(question: string): Promise<KnowledgeQueryResult>;
  ingestFile(file: KnowledgeFileRef, options?: KnowledgeIngestOptions): Promise<KnowledgeIngestResult>;
  ingestLocalFile?(filePath: string, options?: KnowledgeIngestOptions): Promise<KnowledgeIngestResult>;
  ingestWebPage?(request: KnowledgeWebPageIngestRequest, options?: KnowledgeIngestOptions): Promise<KnowledgeIngestResult>;
  parseLocalFile?(filePath: string): Promise<KnowledgeParsedFileResult>;
  previewLocalFileExtraction?(filePath: string, options?: { maxQas?: number | undefined; onProgress?: KnowledgeIngestOptions["onProgress"] }): Promise<KnowledgeExtractPreviewResult>;
  listDocuments?(options?: { limit?: number | undefined; status?: string | undefined }): Promise<KnowledgeDocumentSummary[]>;
  getDocument?(id: number): Promise<KnowledgeDocumentDetail | null>;
  getStats?(): Promise<KnowledgeStatsResult>;
  syncMirror(): Promise<void>;
  close(): void;
}

type OpenCodePort = Pick<OpenCodeClient, "createSession" | "postMessageSync" | "deleteSession">;

type KnowledgeResourcePort = {
  downloadMessageResource(messageId: string, fileKey: string, type: "file"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
  listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
};

type ExtractedQa = {
  question: string;
  answer: string;
  tags: string[];
  statute?: string | undefined;
};

type ExtractedQaCandidate = ExtractedQa & {
  pageSection: string;
  embedding?: number[] | undefined;
};

type ChunkExtractionState = {
  chunk: {
    location: string;
    text: string;
    prevContext?: string | undefined;
  };
  items: ExtractedQa[];
};

type DetectedQaPair = {
  question: string;
  answer: string;
  pageSection: string;
};

type SourceFileTemplateContext = {
  fileName: string;
  messageId?: string | undefined;
  fileKey?: string | undefined;
  checksum?: string | undefined;
  pageSection?: string | undefined;
  sourceUrl?: string | undefined;
};

type StatuteTemplateContext = SourceFileTemplateContext & {
  statute?: string | undefined;
};

type BitableFieldValue = string | number | boolean | string[] | { text: string; link: string } | undefined;
const EXTRACTION_CACHE_VERSION = "v1";

export class KnowledgeBaseService implements KnowledgeBasePort {
  private readonly db: KnowledgeDb;
  private readonly embeddingClient: EmbeddingProviderClient;

  constructor(
    private readonly config: AppConfig["knowledgeBase"],
    private readonly resources: KnowledgeResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
  ) {
    if (!config.embeddingProvider) {
      throw new Error("knowledgeBase.embeddingProvider 未配置");
    }
    this.db = new KnowledgeDb(config.storage.sqlitePath);
    this.embeddingClient = new OpenAICompatibleEmbeddingClient(
      config.embeddingProvider.baseUrl,
      config.embeddingProvider.apiKey,
      config.embeddingProvider.model,
    );
  }

  // #region 查询与入库入口

  /** 查询知识库，并返回重排后的候选结果。 */
  async query(question: string): Promise<KnowledgeQueryResult> {
    const queryEmbedding = await this.embeddingClient.embed(question);
    const embeddingMatches = this.db.searchByEmbedding(queryEmbedding, this.embeddingClient.model, this.config.query.topK);
    const keywordMatches = this.db.searchByKeyword(question, this.config.query.keywordFallbackLimit);
    const merged = dedupeCandidates([...embeddingMatches, ...keywordMatches]);
    const reranked = await this.rerank(question, merged);
    const uniqueResults = dedupeEquivalentCandidates(reranked);
    return {
      question,
      results: uniqueResults.slice(0, this.config.query.finalTopN),
      bitableUrl: resolveKnowledgeBitableViewUrl(this.config),
    };
  }

  /** 从飞书消息附件下载文件并执行入库。 */
  async ingestFile(file: KnowledgeFileRef, options?: KnowledgeIngestOptions): Promise<KnowledgeIngestResult> {
    await this.reportProgress(options, {
      step: "read",
      status: "running",
      detail: "正在下载并解析文件",
    });
    const downloaded = await this.resources.downloadMessageResource(file.messageId, file.fileKey, "file");
    validateUploadedFile(downloaded.fileName, downloaded.buffer, this.config.ingest.allowedExtensions, this.config.ingest.maxFileSizeMb);
    return await this.ingestBuffer({
      fileName: downloaded.fileName,
      buffer: downloaded.buffer,
      sourceType: "message-file",
      messageId: file.messageId,
      fileKey: file.fileKey,
    }, options);
  }

  /** 读取公开网页正文并按文档入库流程处理。 */
  async ingestWebPage(request: KnowledgeWebPageIngestRequest, options?: KnowledgeIngestOptions): Promise<KnowledgeIngestResult> {
    await this.reportProgress(options, {
      step: "read",
      status: "running",
      detail: "正在读取网页正文",
    });
    const markdown = await this.readWebPageMarkdown(request.url, request.instruction);
    const fileName = buildWebFileName(request.url, markdown);
    const buffer = Buffer.from(markdown, "utf8");
    validateUploadedFile(fileName, buffer, [...new Set([...this.config.ingest.allowedExtensions, ".md"])], this.config.ingest.maxFileSizeMb);
    return await this.ingestBuffer({
      fileName,
      buffer,
      sourceType: "web-url",
      sourceUrl: request.url,
      messageId: request.messageId,
    }, options);
  }

  /** 对本地文件执行入库流程。 */
  async ingestLocalFile(filePath: string, options?: KnowledgeIngestOptions): Promise<KnowledgeIngestResult> {
    const resolvedPath = path.resolve(filePath);
    const fileName = path.basename(resolvedPath);
    await this.reportProgress(options, {
      step: "read",
      status: "running",
      detail: "正在读取本地文件",
    });
    const buffer = await readFile(resolvedPath);
    validateUploadedFile(fileName, buffer, this.config.ingest.allowedExtensions, this.config.ingest.maxFileSizeMb);
    return await this.ingestBuffer({
      fileName,
      buffer,
      sourceType: "local-file",
    }, options);
  }

  /** 仅解析本地文件，返回抽取后的 Markdown 与章节统计。 */
  async parseLocalFile(filePath: string): Promise<KnowledgeParsedFileResult> {
    const resolvedPath = path.resolve(filePath);
    const fileName = path.basename(resolvedPath);
    const buffer = await readFile(resolvedPath);
    validateUploadedFile(fileName, buffer, this.config.ingest.allowedExtensions, this.config.ingest.maxFileSizeMb);
    const parsed = await parseKnowledgeFile(fileName, buffer);
    return {
      sourceFile: fileName,
      markdown: parsed.normalizedMarkdown,
      sectionCount: parsed.sections.length,
      parserUsed: parsed.parserUsed,
    };
  }

  /** 预览本地文件的提取效果，但不真正写入知识库。 */
  async previewLocalFileExtraction(
    filePath: string,
    options?: { maxQas?: number | undefined; onProgress?: KnowledgeIngestOptions["onProgress"] },
  ): Promise<KnowledgeExtractPreviewResult> {
    const resolvedPath = path.resolve(filePath);
    const fileName = path.basename(resolvedPath);
    const buffer = await readFile(resolvedPath);
    validateUploadedFile(fileName, buffer, this.config.ingest.allowedExtensions, this.config.ingest.maxFileSizeMb);
    const parsedDocument = await parseKnowledgeFile(fileName, buffer);
    const chapterGrouping = groupKnowledgeSectionsByChapter(parsedDocument.sections);
    const extractionSections = chapterGrouping.chapters.length > 0
      ? chapterGrouping.chapters.filter((chapter) => !chapter.skipped).flatMap((chapter) => chapter.sections)
      : parsedDocument.sections;
    const extractionMarkdown = extractionSections.map((section) => section.text).join("\n\n");
    const qaDocument = detectStructuredQaDocument(extractionMarkdown, extractionSections);
    let rawExtractedCount = 0;
    let dedupedCount = 0;
    let finalCandidates: ExtractedQaCandidate[] = [];
    let chunkCount = 0;
    let warning = joinWarnings(
      chapterGrouping.skippedTitles.length > 0 ? buildSkippedChaptersWarning(chapterGrouping.skippedTitles) : undefined,
    );

    if (qaDocument.matched) {
      await this.reportProgress({ onProgress: options?.onProgress }, {
        step: "extract",
        status: "running",
        detail: `已识别问答体文档（共 ${qaDocument.pairs.length} 组）`,
      });
      const enrichedCandidates = await this.enrichDetectedQaPairs(fileName, qaDocument.pairs, { onProgress: options?.onProgress });
      rawExtractedCount = enrichedCandidates.length;
      const dedupedCandidates = dedupeExtractedCandidates(enrichedCandidates);
      finalCandidates = await this.semanticDedupeCandidates(dedupedCandidates, { onProgress: options?.onProgress });
      dedupedCount = rawExtractedCount - finalCandidates.length;
    } else {
      const allChunks = chapterGrouping.chapters.length > 0
        ? chapterGrouping.chapters
          .filter((chapter) => !chapter.skipped)
          .flatMap((chapter) => chunkKnowledgeSections(chapter.sections))
        : chunkKnowledgeSections(extractionSections);
      chunkCount = allChunks.length;
      const maxExtractChunks = this.config.ingest.maxExtractChunks;
      const batchCount = Math.max(1, Math.ceil(allChunks.length / maxExtractChunks));
      if (batchCount > 1) {
        warning = joinWarnings(warning, buildChunkBatchingWarning(maxExtractChunks, allChunks.length, batchCount));
      }
      const extractedByChunk: Array<ChunkExtractionState> = new Array(allChunks.length);
      const chunkBatches = sliceIntoBatches(allChunks.map((chunk, index) => ({ chunk, index })), maxExtractChunks);
      for (const [batchIndex, batch] of chunkBatches.entries()) {
        await this.reportProgress({ onProgress: options?.onProgress }, {
          step: "extract",
          status: "running",
          detail: batchCount > 1
            ? `正在提交第 ${batchIndex + 1}/${batchCount} 批模型提取任务（本批 ${batch.length} 段，并发 ${this.config.ingest.concurrency}）`
            : `正在提交模型提取任务（共 ${batch.length} 段，并发 ${this.config.ingest.concurrency}）`,
        });
        await runWithConcurrency(batch, this.config.ingest.concurrency, async ({ chunk, index }) => {
          const items = await this.extractQaWithRetry(
            fileName,
            chunk.location,
            chunk.text,
            chunk.prevContext,
            index,
            allChunks.length,
            { onProgress: options?.onProgress },
          );
          extractedByChunk[index] = { chunk, items };
        });
      }
      rawExtractedCount = extractedByChunk.reduce((sum, item) => sum + item.items.length, 0);
      const dedupedCandidates = dedupeExtractedCandidates(extractedByChunk.flatMap((item) => item.items.map((qa) => ({
        ...qa,
        pageSection: item.chunk.location,
      }))));
      finalCandidates = await this.semanticDedupeCandidates(dedupedCandidates, { onProgress: options?.onProgress });
      dedupedCount = rawExtractedCount - finalCandidates.length;
    }

    const maxQas = options?.maxQas ?? this.config.ingest.maxExtractQas;
    if (finalCandidates.length > maxQas) {
      finalCandidates = [...finalCandidates]
        .sort((left, right) => scoreExtractedCandidate(right) - scoreExtractedCandidate(left))
        .slice(0, maxQas);
      warning = joinWarnings(warning, buildMaxExtractQasWarning(maxQas));
    }

    return {
      sourceFile: fileName,
      parserUsed: parsedDocument.parserUsed,
      sectionCount: parsedDocument.sections.length,
      chunkCount,
      rawExtractedCount,
      dedupedCount,
      extractedCount: finalCandidates.length,
      warning,
      items: finalCandidates,
    };
  }

  /** 列出知识库中的文档摘要。 */
  async listDocuments(options?: { limit?: number | undefined; status?: string | undefined }): Promise<KnowledgeDocumentSummary[]> {
    return this.db.listDocuments({
      limit: options?.limit,
      statuses: normalizeDocumentStatusFilter(options?.status),
    });
  }

  /** 获取单篇文档及其样例条目。 */
  async getDocument(id: number): Promise<KnowledgeDocumentDetail | null> {
    const document = this.db.getDocumentById(id);
    if (!document) {
      return null;
    }
    const entries = this.db.listEntriesByDocument(id);
    const sampleEntries = entries.slice(0, 10);
    const tagCounts = summarizeTagCounts(entries);
    return {
      ...document,
      tagCounts,
      sampleEntries,
    };
  }

  /** 返回知识库的整体统计信息。 */
  async getStats(): Promise<KnowledgeStatsResult> {
    const documents = this.db.listAllDocuments();
    const entries = this.db.listAllEntries();
    const statusCounts = summarizeStatusCounts(documents);
    const tagCounts = summarizeTagCounts(entries);
    return {
      documentCount: documents.length,
      entryCount: entries.length,
      statusCounts,
      tagCounts,
      recentDocuments: this.db.listDocuments({ limit: 5 }),
    };
  }

  // #endregion

  // #region 入库主流程

  /** 执行统一入库流程：解析、提取、去重、写入。 */
  private async ingestBuffer(input: {
    fileName: string;
    buffer: Buffer;
    sourceType: string;
    messageId?: string | undefined;
    fileKey?: string | undefined;
    sourceUrl?: string | undefined;
  }, options?: KnowledgeIngestOptions): Promise<KnowledgeIngestResult> {
    const startedAt = Date.now();
    const parsedDocument = await parseKnowledgeFile(input.fileName, input.buffer);
    if (parsedDocument.normalizedMarkdown) {
      await this.reportProgress(options, {
        step: "read",
        status: "running",
        detail: "已转换为 Markdown",
      });
    }
    if (parsedDocument.sections.length === 0) {
      await this.reportProgress(options, {
        step: "read",
        status: "error",
        detail: "文件中未提取到可用文本",
      });
      throw new Error("文件中未提取到可用文本");
    }
    await this.reportProgress(options, {
      step: "read",
      status: "completed",
      detail: `已提取 ${parsedDocument.sections.length} 段正文`,
    });

    const checksum = createChecksum(input.buffer);
    const document = this.db.saveDocument({
      sourceType: input.sourceType,
      title: input.fileName,
      fileName: input.fileName,
      checksum,
      status: "extracting",
      bitableRecordId: await this.saveDocumentRecord(input.fileName, checksum, input.sourceType, input.sourceUrl),
    });

    const chapterGrouping = groupKnowledgeSectionsByChapter(parsedDocument.sections);
    const extractionSections = chapterGrouping.chapters.length > 0
      ? chapterGrouping.chapters.filter((chapter) => !chapter.skipped).flatMap((chapter) => chapter.sections)
      : parsedDocument.sections;
    const extractionMarkdown = extractionSections.map((section) => section.text).join("\n\n");
    const qaDocument = detectStructuredQaDocument(extractionMarkdown, extractionSections);
    const concurrency = this.config.ingest.concurrency;
    let rawExtractedCount = 0;
    let dedupedCount = 0;
    let finalCandidates: ExtractedQaCandidate[] = [];
    let warning = joinWarnings(
      chapterGrouping.skippedTitles.length > 0 ? buildSkippedChaptersWarning(chapterGrouping.skippedTitles) : undefined,
    );

    if (qaDocument.matched) {
      this.db.clearExtractedChunks(document.id);
      await this.reportProgress(options, {
        step: "extract",
        status: "running",
        detail: `已识别问答体文档（共 ${qaDocument.pairs.length} 组）`,
      });
      const enrichedCandidates = await this.enrichDetectedQaPairs(input.fileName, qaDocument.pairs, options);
      rawExtractedCount = enrichedCandidates.length;
      const dedupedCandidates = dedupeExtractedCandidates(enrichedCandidates);
      await this.reportProgress(options, {
        step: "extract",
        status: "running",
        detail: `已补充标签与法条（${rawExtractedCount} 条），正在合并重复问答`,
      });
      finalCandidates = await this.semanticDedupeCandidates(dedupedCandidates, options);
      dedupedCount = rawExtractedCount - finalCandidates.length;
    } else {
      const allChunks = chapterGrouping.chapters.length > 0
        ? chapterGrouping.chapters
          .filter((chapter) => !chapter.skipped)
          .flatMap((chapter) => chunkKnowledgeSections(chapter.sections))
        : chunkKnowledgeSections(extractionSections);
      const chunks = allChunks;
      const maxExtractChunks = this.config.ingest.maxExtractChunks;
      const batchCount = Math.max(1, Math.ceil(chunks.length / maxExtractChunks));
      if (batchCount > 1) {
        warning = joinWarnings(warning, buildChunkBatchingWarning(maxExtractChunks, chunks.length, batchCount));
      }
      await this.reportProgress(options, {
        step: "extract",
        status: "running",
        detail: batchCount > 1
          ? `文本切块完成（共 ${chunks.length} 段，自动分 ${batchCount} 批处理），开始提取问答`
          : `文本切块完成（共 ${chunks.length} 段），开始提取问答`,
      });

      const extractedByChunk: Array<ChunkExtractionState> = new Array(chunks.length);
      const cachedChunks = this.restoreChunkExtractions(document.id, chunks);
      let extractCompleted = cachedChunks.completedCount;
      if (cachedChunks.completedCount > 0) {
        for (const [index, cached] of cachedChunks.completed.entries()) {
          extractedByChunk[index] = cached;
        }
        await this.reportProgress(options, {
          step: "extract",
          status: "running",
          detail: `已恢复 ${cachedChunks.completedCount}/${chunks.length} 段历史提取结果，继续处理剩余分段`,
        });
      }
      const chunkBatches = sliceIntoBatches(chunks.map((chunk, index) => ({ chunk, index })), maxExtractChunks);
      for (const [batchIndex, batch] of chunkBatches.entries()) {
        const pendingInBatch = batch.filter(({ index }) => !extractedByChunk[index]).length;
        if (pendingInBatch === 0) {
          continue;
        }
        await this.reportProgress(options, {
          step: "extract",
          status: "running",
          detail: batchCount > 1
            ? `正在提交第 ${batchIndex + 1}/${batchCount} 批模型提取任务（本批 ${pendingInBatch} 段，并发 ${concurrency}）`
            : `正在提交模型提取任务（共 ${pendingInBatch} 段，并发 ${concurrency}）`,
        });
        await runWithConcurrency(batch, concurrency, async ({ chunk, index }) => {
          if (extractedByChunk[index]) {
            return;
          }
          const items = await this.extractQaWithRetry(
            input.fileName,
            chunk.location,
            chunk.text,
            chunk.prevContext,
            index,
            chunks.length,
            options,
          );
          extractedByChunk[index] = { chunk, items };
          this.db.saveExtractedChunk({
            documentId: document.id,
            chunkIndex: index,
            chunkHash: buildChunkExtractionHash(chunk, resolveKnowledgeModelKey(this.config, "extract")),
            pageSection: chunk.location,
            extractedJson: JSON.stringify(items),
          });
          extractCompleted += 1;
          if (shouldReportProgress(extractCompleted - 1, chunks.length) || extractCompleted === chunks.length) {
            await this.reportProgress(options, {
              step: "extract",
              status: "running",
              detail: `正在调用模型提取（${extractCompleted}/${chunks.length}）`,
            });
          }
        });
      }

      rawExtractedCount = extractedByChunk.reduce((sum, item) => sum + item.items.length, 0);
      const dedupedCandidates = dedupeExtractedCandidates(extractedByChunk.flatMap((item) => item.items.map((qa) => ({
        ...qa,
        pageSection: item.chunk.location,
      }))));
      await this.reportProgress(options, {
        step: "extract",
        status: "running",
        detail: `提取完成（${rawExtractedCount} 条），正在合并重复问答`,
      });
      finalCandidates = await this.semanticDedupeCandidates(dedupedCandidates, options);
      dedupedCount = rawExtractedCount - finalCandidates.length;
    }

    if (finalCandidates.length > this.config.ingest.maxExtractQas) {
      finalCandidates = [...finalCandidates]
        .sort((left, right) => scoreExtractedCandidate(right) - scoreExtractedCandidate(left))
        .slice(0, this.config.ingest.maxExtractQas);
      warning = joinWarnings(warning, buildMaxExtractQasWarning(this.config.ingest.maxExtractQas));
    }

    const totalExtracted = finalCandidates.length;
    this.db.updateDocumentStatus(document.id, totalExtracted > 0 ? "writing" : "extracted");
    await this.reportProgress(options, {
      step: "extract",
      status: "completed",
      detail: totalExtracted > 0
        ? `已提取 ${totalExtracted} 条问答（原始 ${rawExtractedCount} 条，去重合并 ${dedupedCount} 条）`
        : "未提取到可入库问答",
    });

    const tagCounts = new Map<string, number>();
    let writeCompleted = 0;
    if (totalExtracted > 0) {
      await this.reportProgress(options, {
        step: "write",
        status: "running",
        detail: `正在写入知识库（0/${totalExtracted}）`,
      });
    }

    const writeErrors: string[] = [];
    await runWithConcurrency(finalCandidates, concurrency, async (item) => {
      try {
        const embedding = item.embedding ?? await this.embeddingClient.embed(`${item.question}\n${item.answer}`);
        const fields = compactBitableFields({
          问题: item.question,
          答案: item.answer,
          标签: item.tags,
          [resolveStatuteFieldName(this.config)]: buildStatuteFieldValue(this.config, {
            statute: item.statute,
            fileName: input.fileName,
            messageId: input.messageId,
            fileKey: input.fileKey,
            checksum,
            pageSection: item.pageSection,
            sourceUrl: input.sourceUrl,
          }),
          [resolveSourceFileFieldName(this.config)]: buildSourceFileFieldValue(this.config, {
            fileName: input.fileName,
            messageId: input.messageId,
            fileKey: input.fileKey,
            checksum,
            pageSection: item.pageSection,
            sourceUrl: input.sourceUrl,
          }),
          "页码/章节": item.pageSection,
          embedding: JSON.stringify(embedding),
          入库时间: Date.now(),
        });
        const bitableRecordId = await this.resources.createBitableRecord(
          this.config.storage.bitable.appToken,
          this.config.storage.bitable.tableId,
          fields,
        );
        this.db.saveEntry({
          documentId: document.id,
          question: item.question,
          answer: item.answer,
          tags: item.tags,
          statute: item.statute,
          sourceFile: input.fileName,
          pageSection: item.pageSection,
          bitableRecordId,
          embedding,
          embeddingModel: this.embeddingClient.model,
        });
        writeCompleted += 1;
        for (const tag of item.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
        if (shouldReportProgress(writeCompleted - 1, totalExtracted) || writeCompleted === totalExtracted) {
          await this.reportProgress(options, {
            step: "write",
            status: "running",
            detail: `正在写入知识库（${writeCompleted}/${totalExtracted}）`,
          });
        }
      } catch (error) {
        writeErrors.push(error instanceof Error ? error.message : String(error));
      }
    });

    if (writeErrors.length > 0) {
      this.db.updateDocumentStatus(document.id, "write-failed");
      await this.reportProgress(options, {
        step: "write",
        status: "error",
        detail: `成功写入 ${writeCompleted} 条，失败 ${writeErrors.length} 条`,
      });
      throw new Error(`知识入库部分失败：成功写入 ${writeCompleted} 条，失败 ${writeErrors.length} 条。首个错误：${writeErrors[0]}`);
    }

    this.db.clearExtractedChunks(document.id);
    this.db.updateDocumentStatus(document.id, "ingested");
    await this.reportProgress(options, {
      step: "write",
      status: "completed",
      detail: totalExtracted > 0 ? `已写入 ${writeCompleted} 条问答` : "没有可写入的问答",
    });

    return {
      sourceFile: input.fileName,
      rawExtractedCount,
      dedupedCount,
      extractedCount: writeCompleted,
      tagCounts: Object.fromEntries([...tagCounts.entries()].sort((left, right) => right[1] - left[1])),
      durationMs: Date.now() - startedAt,
      bitableUrl: resolveKnowledgeBitableViewUrl(this.config),
      warning: joinWarnings(warning, buildIngestWarning(writeCompleted)),
    };
  }

  // #endregion

  // #region 外部同步与关闭

  /** 从 Bitable 反向同步已有知识记录到本地数据库。 */
  async syncMirror(): Promise<void> {
    const records = await this.resources.listBitableRecords(
      this.config.storage.bitable.appToken,
      this.config.storage.bitable.tableId,
    );
    for (const record of records) {
      const question = readStringField(record.fields, "问题");
      const answer = readStringField(record.fields, "答案");
      const sourceFieldName = resolveSourceFileFieldName(this.config);
      const sourceFile = readStringField(record.fields, sourceFieldName) ?? readStringField(record.fields, "源文件");
      if (!question || !answer || !sourceFile) {
        continue;
      }
      const checksum = createChecksum(Buffer.from(sourceFile, "utf8"));
      const document = this.db.saveDocument({
        sourceType: "bitable-sync",
        title: sourceFile,
        fileName: sourceFile,
        checksum,
        status: "synced",
      });
      const embeddingJson = readStringField(record.fields, "embedding");
      let embedding: number[] | undefined;
      if (embeddingJson) {
        try {
          const parsed = JSON.parse(embeddingJson) as unknown;
          if (Array.isArray(parsed) && parsed.every((item) => typeof item === "number")) {
            embedding = parsed as number[];
          }
        } catch {
          embedding = undefined;
        }
      }
      if (!embedding) {
        embedding = await this.embeddingClient.embed(`${question}\n${answer}`);
      }
      this.db.saveEntry({
        documentId: document.id,
        question,
        answer,
        tags: readStringListField(record.fields, "标签"),
        statute: readStringField(record.fields, resolveStatuteFieldName(this.config)) ?? readStringField(record.fields, "法条"),
        sourceFile,
        pageSection: readStringField(record.fields, "页码/章节"),
        bitableRecordId: record.recordId,
        embedding,
        embeddingModel: this.embeddingClient.model,
      });
    }
  }

  /** 关闭知识库数据库连接。 */
  close(): void {
    this.db.close();
  }

  // #endregion

  // #region 模型辅助步骤

  /** 读取网页正文并整理成可入库的 Markdown。 */
  private async readWebPageMarkdown(url: string, instruction?: string | undefined): Promise<string> {
    const session = await this.opencode.createSession("[bridge] knowledge-web-ingest");
    try {
      const response = await this.opencode.postMessageSync(session.id, buildKnowledgePromptRequest(
        [{
          type: "text",
          text: [
            "你是网页资料入库助手。",
            "请使用你可用的原生能力读取用户提供的公开网页 URL，并把适合入库的正文内容整理成 Markdown。",
            "如果环境中可用 web-knowledge-ingest skill，可以优先使用该 skill；如果不可用，就使用你原本可用的网页读取能力。",
            "只输出 Markdown 正文，不要输出解释、计划、命令日志或 JSON。",
            "必须忠于网页内容，不要补充网页之外的推断。",
            "保留标题、来源 URL 和关键小节；如果网页无法读取，请简短说明无法读取的原因。",
            `URL：${url}`,
            instruction ? `用户入库要求：${instruction}` : "",
          ].filter(Boolean).join("\n\n"),
        }],
        resolveKnowledgeModel(this.config, "webRead"),
      ));
      const markdown = stripOuterMarkdownFence(extractAssistantText(response)).trim();
      if (!markdown || markdown.length < 20) {
        throw new Error("OpenCode 未返回可入库的网页正文");
      }
      if (/无法读取|不能读取|无法访问|access denied|forbidden|captcha|登录/i.test(markdown) && markdown.length < 300) {
        throw new Error(`OpenCode 未能读取网页：${markdown}`);
      }
      return markdown;
    } finally {
      await this.opencode.deleteSession(session.id).catch(() => undefined);
    }
  }

  /** 从单个文本分段中提取可入库的问答对。 */
  private async extractQa(fileName: string, pageSection: string, chunk: string, prevContext?: string | undefined): Promise<ExtractedQa[]> {
    const session = await this.opencode.createSession("[bridge] knowledge-extract");
    try {
      const response = await this.opencode.postMessageSync(session.id, buildKnowledgePromptRequest(
        [{
          type: "text",
          text: [
            "你是法律知识提取专家。",
            "阅读以下文本片段，提取可以直接回答用户法律咨询的问答对。",
            "规则：",
            "1. 问题必须是用户真实会提出的法律实务问题，范围限定在劳动用工、合同履行、争议处理、合规操作等法律咨询场景。",
            "2. 同一知识点只提取一个问答对，答案中列举所有关键情形，不要拆成多条相近问题。",
            "3. 答案忠于原文，长度控制在 50-300 字，涵盖核心结论、适用条件和例外情形，不要整段照抄原文。",
            "4. 不要提取目录、课程介绍、检索方法、转载说明、免责声明、作者信息、案例来源、地域统计、学习建议、关键词列表等非咨询内容。",
            "5. 如果片段主要是说明性或信息性内容，而不是可直接回答咨询的问题，返回空数组 []。",
            "字段说明：",
            "- question: 字符串，口语化的法律咨询问题",
            "- answer: 字符串，基于原文的回答",
            "- tags: 数组，1-3 个核心法律主题标签",
            "- statute: 字符串或 null；无明确法条引用时填 null",
            prevContext ? `前文上下文（仅供理解，不要从这里单独提取问答）：\n${prevContext}` : "",
            `源文件：${fileName}`,
            `页码/章节：${pageSection}`,
            "---正文开始---",
            chunk,
            "---正文结束---",
            "示例输出：",
            JSON.stringify([{
              question: "公司不续签劳动合同，员工能拿到补偿吗？",
              answer: "劳动合同期满，用人单位不续签或降低条件续签导致劳动者不续签的，应按工作年限支付经济补偿，每满一年支付一个月工资。",
              tags: ["劳动"],
              statute: "《劳动合同法》第 46 条",
            }], null, 2),
            "只输出 JSON 数组，不要输出其他内容。",
          ].filter(Boolean).join("\n\n"),
        }],
        resolveKnowledgeModel(this.config, "extract"),
      ));
      return normalizeExtractedQa(parseJsonArray(extractAssistantText(response)));
    } finally {
      await this.opencode.deleteSession(session.id).catch(() => undefined);
    }
  }

  /** 带重试地执行单段问答提取。 */
  private async extractQaWithRetry(
    fileName: string,
    pageSection: string,
    chunk: string,
    prevContext: string | undefined,
    chunkIndex: number,
    chunkCount: number,
    options?: KnowledgeIngestOptions,
  ): Promise<ExtractedQa[]> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.extractQa(fileName, pageSection, chunk, prevContext);
      } catch (error) {
        if (!isRetryableKnowledgeExtractError(error) || attempt === maxAttempts) {
          throw wrapKnowledgeExtractError(error, chunkIndex, chunkCount);
        }
        await this.reportProgress(options, {
          step: "extract",
          status: "running",
          detail: `第 ${chunkIndex + 1}/${chunkCount} 段提取中断，正在重试（${attempt}/${maxAttempts - 1}）`,
        });
        await delay(extractRetryDelayMs(attempt));
      }
    }
    throw new Error("知识提取重试失败");
  }

  /** 为结构化问答文档补充标签和法条信息。 */
  private async enrichDetectedQaPairs(
    fileName: string,
    pairs: DetectedQaPair[],
    options?: KnowledgeIngestOptions,
  ): Promise<ExtractedQaCandidate[]> {
    const batchSize = 10;
    const batches = sliceIntoBatches(pairs, batchSize);
    const enriched: ExtractedQaCandidate[] = [];
    let completed = 0;
    await runWithConcurrency(batches, this.config.ingest.concurrency, async (batch) => {
      const items = await this.enrichDetectedQaBatch(fileName, batch);
      enriched.push(...items);
      completed += 1;
      if (shouldReportProgress(completed - 1, batches.length) || completed === batches.length) {
        await this.reportProgress(options, {
          step: "extract",
          status: "running",
          detail: `正在补充标签与法条（${completed}/${batches.length}）`,
        });
      }
    });
    return enriched;
  }

  /** 批量补充结构化问答的 tags 与 statute 字段。 */
  private async enrichDetectedQaBatch(
    fileName: string,
    batch: DetectedQaPair[],
  ): Promise<ExtractedQaCandidate[]> {
    const session = await this.opencode.createSession("[bridge] knowledge-qa-enrich");
    try {
      const response = await this.opencode.postMessageSync(session.id, buildKnowledgePromptRequest(
        [{
          type: "text",
          text: [
            "你是法律知识补充助手。",
            "用户已经从问答体文档中本地抽取了 question 和 answer。",
            "不要重写、改写、扩写或合并 question / answer，只补充 tags 和 statute。",
            "返回 JSON 数组，每个元素包含 question、answer、tags、statute。",
            "其中：",
            "- question: 必须与输入完全一致",
            "- answer: 必须与输入完全一致",
            "- tags: 1-3 个核心法律主题标签",
            "- statute: 无明确法条时填 null",
            `源文件：${fileName}`,
            `输入：${JSON.stringify(batch, null, 2)}`,
            "只输出 JSON 数组，不要输出其他内容。",
          ].join("\n\n"),
        }],
        resolveKnowledgeModel(this.config, "extract"),
      ));
      const normalized = normalizeExtractedQa(parseJsonArray(extractAssistantText(response)));
      return batch.map((item, index) => ({
        question: item.question,
        answer: item.answer,
        tags: normalized[index]?.tags ?? [],
        statute: normalized[index]?.statute,
        pageSection: item.pageSection,
      }));
    } finally {
      await this.opencode.deleteSession(session.id).catch(() => undefined);
    }
  }

  /** 用模型对候选检索结果做二次重排。 */
  private async rerank(question: string, candidates: KnowledgeEntryCandidate[]): Promise<KnowledgeEntryCandidate[]> {
    if (candidates.length <= 1) {
      return candidates;
    }

    const session = await this.opencode.createSession("[bridge] knowledge-rerank");
    try {
      const response = await this.opencode.postMessageSync(session.id, buildKnowledgePromptRequest(
        [{
          type: "text",
          text: [
            "你是法律知识库检索重排器。",
            "请根据用户问题，对候选条目按相关性排序。",
            "只输出 JSON 数组，格式为 [{\"id\": 1, \"score\": 0.98}]。",
            "无关条目不要返回。",
            `用户问题：${question}`,
            `候选条目：${JSON.stringify(candidates.map((candidate) => ({
              id: candidate.id,
              question: candidate.question,
              answer: candidate.answer,
              statute: candidate.statute,
              sourceFile: candidate.sourceFile,
              pageSection: candidate.pageSection,
            })))}`,
          ].join("\n\n"),
        }],
        resolveKnowledgeModel(this.config, "rerank"),
      ));
      const ranking = parseJsonArray(extractAssistantText(response))
        .map((item) => normalizeRankingItem(item))
        .filter((item): item is { id: number; score: number } => item !== null);
      if (ranking.length === 0) {
        return candidates;
      }
      const rankedIds = new Map(ranking.map((item, index) => [item.id, { score: item.score, order: index }]));
      return candidates
        .filter((candidate) => rankedIds.has(candidate.id))
        .map((candidate) => ({
          ...candidate,
          score: rankedIds.get(candidate.id)?.score ?? candidate.score,
        }))
        .sort((left, right) => {
          const leftRank = rankedIds.get(left.id)?.order ?? Number.MAX_SAFE_INTEGER;
          const rightRank = rankedIds.get(right.id)?.order ?? Number.MAX_SAFE_INTEGER;
          return leftRank - rightRank;
        });
    } catch (error) {
      this.logger.log("knowledge/query", "rerank failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return candidates;
    } finally {
      await this.opencode.deleteSession(session.id).catch(() => undefined);
    }
  }

  // #endregion

  private async saveDocumentRecord(
    fileName: string,
    checksum: string,
    sourceType = "message-file",
    sourceUrl?: string | undefined,
  ): Promise<string | undefined> {
    const documentTableId = this.config.storage.bitable.documentTableId;
    if (!documentTableId) {
      return undefined;
    }
    return await this.resources.createBitableRecord(
      this.config.storage.bitable.appToken,
      documentTableId,
      {
        标题: fileName,
        文件名: fileName,
        checksum,
        来源类型: sourceType,
        来源链接: sourceUrl ?? "",
        状态: "已入库",
        入库时间: Date.now(),
      },
    );
  }

  private async reportProgress(options: KnowledgeIngestOptions | undefined, update: KnowledgeIngestProgressUpdate): Promise<void> {
    await options?.onProgress?.(update);
  }

  private async semanticDedupeCandidates(
    candidates: ExtractedQaCandidate[],
    options?: KnowledgeIngestOptions,
  ): Promise<ExtractedQaCandidate[]> {
    const kept: Array<ExtractedQaCandidate & { semanticEmbedding: number[] }> = [];
    for (const [index, candidate] of candidates.entries()) {
      if (candidates.length > 20 && shouldReportProgress(index, candidates.length)) {
        await this.reportProgress(options, {
          step: "extract",
          status: "running",
          detail: `正在去重问答（${index + 1}/${candidates.length}）`,
        });
      }
      const semanticEmbedding = candidate.embedding ?? await this.embeddingClient.embed(`${candidate.question}\n${candidate.answer}`);
      const duplicateIndex = kept.findIndex((item) => cosineSimilarity(item.semanticEmbedding, semanticEmbedding) >= 0.9);
      if (duplicateIndex < 0) {
        kept.push({ ...candidate, embedding: semanticEmbedding, semanticEmbedding });
        continue;
      }
      if (scoreExtractedCandidate(candidate) > scoreExtractedCandidate(kept[duplicateIndex]!)) {
        kept[duplicateIndex] = { ...candidate, embedding: semanticEmbedding, semanticEmbedding };
      }
    }
    return kept.map((item) => {
      const candidate = { ...item };
      delete (candidate as { semanticEmbedding?: number[] }).semanticEmbedding;
      return candidate;
    });
  }

  private restoreChunkExtractions(
    documentId: number,
    chunks: Array<{ location: string; text: string; prevContext?: string | undefined }>,
  ): { completed: Map<number, ChunkExtractionState>; completedCount: number } {
    const cachedRows = this.db.listExtractedChunks(documentId);
    const completed = new Map<number, ChunkExtractionState>();
    const expectedModel = resolveKnowledgeModelKey(this.config, "extract");
    const validIndexes = new Set(chunks.map((_chunk, index) => index));

    for (const row of cachedRows) {
      if (!validIndexes.has(row.chunkIndex)) {
        continue;
      }
      const chunk = chunks[row.chunkIndex];
      if (!chunk) {
        continue;
      }
      const expectedHash = buildChunkExtractionHash(chunk, expectedModel);
      if (row.chunkHash !== expectedHash) {
        continue;
      }
      completed.set(row.chunkIndex, {
        chunk,
        items: normalizeExtractedQa(parseJsonArray(row.extractedJson)),
      });
    }

    return {
      completed,
      completedCount: completed.size,
    };
  }
}

function resolveSourceFileFieldName(config: AppConfig["knowledgeBase"]): string {
  return config.storage.bitable.sourceFileField?.name ?? "源文件";
}

function resolveStatuteFieldName(config: AppConfig["knowledgeBase"]): string {
  return config.storage.bitable.statuteField?.name ?? "法条";
}

function buildSourceFileFieldValue(
  config: AppConfig["knowledgeBase"],
  context: SourceFileTemplateContext,
): string | { text: string; link: string } {
  const fieldConfig = config.storage.bitable.sourceFileField;
  const text = renderSourceFileTemplate(fieldConfig?.textTemplate ?? "{{fileName}}", context).trim() || context.fileName;
  if (fieldConfig?.type !== "hyperlink") {
    return text;
  }
  if (!fieldConfig.urlTemplate) {
    throw new Error("knowledgeBase.storage.bitable.sourceFileField.urlTemplate 未配置");
  }
  if (context.sourceUrl) {
    return {
      text,
      link: normalizeBitableUrl(context.sourceUrl),
    };
  }
  return {
    text,
    link: normalizeBitableUrl(renderSourceFileTemplate(fieldConfig.urlTemplate, context)),
  };
}

function buildStatuteFieldValue(
  config: AppConfig["knowledgeBase"],
  context: StatuteTemplateContext,
): string | { text: string; link: string } | undefined {
  const fieldConfig = config.storage.bitable.statuteField;
  const statute = context.statute ?? "";
  const text = renderStatuteTemplate(fieldConfig?.textTemplate ?? "{{statute}}", context).trim() || statute;
  if (fieldConfig?.type !== "hyperlink") {
    return text;
  }
  if (!statute) {
    return undefined;
  }
  if (!fieldConfig.urlTemplate) {
    throw new Error("knowledgeBase.storage.bitable.statuteField.urlTemplate 未配置");
  }
  return {
    text,
    link: normalizeBitableUrl(renderStatuteTemplate(fieldConfig.urlTemplate, context)),
  };
}

function compactBitableFields(fields: Record<string, BitableFieldValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function normalizeBitableUrl(value: string): string {
  const trimmed = value.trim();
  return encodeURI(trimmed);
}

function renderSourceFileTemplate(template: string, context: SourceFileTemplateContext): string {
  return template.replace(/\{\{\s*(fileName|messageId|fileKey|checksum|pageSection|sourceUrl)\s*\}\}/g, (_match, key: keyof SourceFileTemplateContext) => {
    const value = context[key];
    return value === undefined ? "" : String(value);
  });
}

function renderStatuteTemplate(template: string, context: StatuteTemplateContext): string {
  return template.replace(/\{\{\s*(statute|fileName|messageId|fileKey|checksum|pageSection|sourceUrl)\s*\}\}/g, (_match, key: keyof StatuteTemplateContext) => {
    const value = context[key];
    return value === undefined ? "" : String(value);
  });
}

export function formatKnowledgeRecallBlock(results: KnowledgeEntryCandidate[]): string {
  if (results.length === 0) {
    return "";
  }
  return [
    "[Knowledge Recall]",
    ...results.map((item, index) => `${index + 1}. ${item.question}｜${item.sourceFile}${item.pageSection ? `｜${item.pageSection}` : ""}`),
  ].join("\n");
}

function dedupeCandidates(candidates: KnowledgeEntryCandidate[]): KnowledgeEntryCandidate[] {
  const seen = new Map<number, KnowledgeEntryCandidate>();
  for (const candidate of candidates) {
    const current = seen.get(candidate.id);
    if (!current || candidate.score > current.score) {
      seen.set(candidate.id, candidate);
    }
  }
  return [...seen.values()].sort((left, right) => right.score - left.score);
}

function dedupeEquivalentCandidates(candidates: KnowledgeEntryCandidate[]): KnowledgeEntryCandidate[] {
  const seen = new Map<string, KnowledgeEntryCandidate>();
  for (const candidate of candidates) {
    const key = [
      normalizeCandidateText(candidate.answer),
      normalizeCandidateText(candidate.sourceFile),
      normalizeCandidateText(candidate.pageSection ?? ""),
      normalizeCandidateText(candidate.statute ?? ""),
    ].join("|");
    const current = seen.get(key);
    if (!current) {
      seen.set(key, candidate);
      continue;
    }
    if (candidate.score > current.score) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()].sort((left, right) => right.score - left.score);
}

function normalizeCandidateText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function shouldReportProgress(index: number, total: number): boolean {
  if (total <= 5) {
    return true;
  }
  const step = Math.max(1, Math.ceil(total / 5));
  return index === 0 || (index + 1) % step === 0;
}

function validateUploadedFile(fileName: string, buffer: Buffer, allowedExtensions: string[], maxFileSizeMb: number): void {
  const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (!allowedExtensions.includes(extension)) {
    throw new Error(`仅支持 ${allowedExtensions.join(" / ")} 文件`);
  }
  const sizeMb = buffer.byteLength / 1024 / 1024;
  if (sizeMb > maxFileSizeMb) {
    throw new Error(`文件过大，请控制在 ${maxFileSizeMb}MB 以内`);
  }
}

function createChecksum(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function buildWebFileName(url: string, markdown: string): string {
  const title = extractMarkdownTitle(markdown) || new URL(url).hostname;
  return `${slugifyFileName(title)}.md`;
}

function extractMarkdownTitle(markdown: string): string | undefined {
  const heading = markdown.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }
  const titleLine = markdown.match(/^\s*标题[:：]\s*(.+)$/m)?.[1]?.trim();
  return titleLine || undefined;
}

function stripOuterMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1] ?? trimmed;
}

function slugifyFileName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[\\/:"*?<>|]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "web-page";
}

function parseJsonArray(text: string): unknown[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeExtractedQa(values: unknown[]): ExtractedQa[] {
  const results: ExtractedQa[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const answer = typeof record.answer === "string" ? record.answer.trim() : "";
    if (!question || !answer || !isRelevantLegalQuestion(question, answer)) {
      continue;
    }
    results.push({
      question,
      answer,
      tags: normalizeTags(Array.isArray(record.tags) ? record.tags.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []),
      statute: record.statute === null ? undefined : typeof record.statute === "string" && record.statute.trim() ? record.statute.trim() : undefined,
    });
  }
  return results;
}

function normalizeRankingItem(value: unknown): { id: number; score: number } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "number" ? record.id : Number(record.id);
  const score = typeof record.score === "number" ? record.score : Number(record.score);
  if (!Number.isFinite(id) || !Number.isFinite(score)) {
    return null;
  }
  return { id, score };
}

function readStringField(fields: Record<string, unknown>, key: string): string | undefined {
  return readStringValue(fields[key]);
}

function readStringListField(fields: Record<string, unknown>, key: string): string[] {
  const value = fields[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const joined = value.map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        return ((item as { text: string }).text).trim();
      }
      return "";
    }).filter(Boolean).join("");
    return joined || undefined;
  }
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
    const text = ((value as { text: string }).text).trim();
    return text || undefined;
  }
  return undefined;
}

function normalizeTags(tags: string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.replace(/\s+/g, " ").trim();
    if (!normalized || isNoisyTag(normalized)) {
      continue;
    }
    unique.add(normalized);
    if (unique.size >= 3) {
      break;
    }
  }
  return [...unique];
}

function dedupeExtractedCandidates(candidates: ExtractedQaCandidate[]): ExtractedQaCandidate[] {
  const seen = new Map<string, ExtractedQaCandidate>();
  for (const candidate of candidates) {
    const key = normalizeQuestionKey(candidate.question);
    const current = seen.get(key);
    if (!current || scoreExtractedCandidate(candidate) > scoreExtractedCandidate(current)) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()];
}

function isRelevantLegalQuestion(question: string, answer: string): boolean {
  const normalizedQuestion = question.replace(/\s+/g, "").trim();
  const normalizedAnswer = answer.replace(/\s+/g, " ").trim();
  if (normalizedQuestion.length < 8 || normalizedAnswer.length < 12) {
    return false;
  }
  if (NOISE_PATTERN.test(normalizedQuestion)) {
    return false;
  }
  return LEGAL_SIGNAL_PATTERN.test(normalizedQuestion) || LEGAL_SIGNAL_PATTERN.test(normalizedAnswer);
}

function normalizeQuestionKey(question: string): string {
  return question
    .replace(/[？?！!。，“”、；;：:\s]/g, "")
    .replace(/^(请问|想问|我想问|咨询一下|咨询|如果|关于)/, "")
    .trim();
}

function scoreExtractedCandidate(candidate: Pick<ExtractedQaCandidate, "answer" | "statute" | "tags">): number {
  return candidate.answer.length + (candidate.statute ? 100 : 0) + candidate.tags.length * 10;
}

function isNoisyTag(tag: string): boolean {
  return NOISE_PATTERN.test(tag);
}

function detectStructuredQaDocument(markdown: string, sections: Array<{ location: string; text: string }>): {
  matched: boolean;
  pairs: DetectedQaPair[];
} {
  const pairs = extractStructuredQaPairs(markdown, sections);
  const qaRatio = sections.length > 0 ? pairs.length / sections.length : 0;
  const hasFaqTitle = /^\s{0,3}(?:#+\s*)?(?:FAQ|常见问题|答疑)\b/im.test(markdown);
  return {
    matched: pairs.length >= 5 || qaRatio >= 0.4 || (hasFaqTitle && pairs.length >= 3),
    pairs,
  };
}

function extractStructuredQaPairs(markdown: string, sections: Array<{ location: string; text: string }>): DetectedQaPair[] {
  if (!markdown.trim() || sections.length === 0) {
    return [];
  }

  const pairs: DetectedQaPair[] = [];
  const seenQuestions = new Set<string>();
  let currentQuestion = "";
  let currentAnswer = "";
  let currentLocation = "";

  const flush = (): void => {
    const question = normalizeStructuredQuestion(currentQuestion);
    const answer = normalizeStructuredAnswer(currentAnswer);
    if (question && answer && !seenQuestions.has(question)) {
      pairs.push({ question, answer, pageSection: currentLocation || "文本" });
      seenQuestions.add(question);
    }
    currentQuestion = "";
    currentAnswer = "";
    currentLocation = "";
  };

  for (const section of sections) {
    const sectionLevelPair = parseSectionLevelStructuredQa(section);
    if (sectionLevelPair) {
      flush();
      if (!seenQuestions.has(sectionLevelPair.question)) {
        pairs.push(sectionLevelPair);
        seenQuestions.add(sectionLevelPair.question);
      }
      continue;
    }
    const lines = section.text.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const questionMatch = line.match(/^(?:问|问题|Q)[：:]\s*(.+)$/i);
      const numberedQuestionMatch = line.match(/^(?:\d{1,4}[.、\s\u3000]+)?(.+[？?])$/);
      const answerMatch = line.match(/^(?:答|解答|A)[：:]\s*(.+)$/i);
      if (questionMatch) {
        flush();
        currentQuestion = questionMatch[1] ?? "";
        currentLocation = section.location;
        continue;
      }
      if (numberedQuestionMatch && !currentAnswer && !currentQuestionLooksNonQuestion(line)) {
        flush();
        currentQuestion = numberedQuestionMatch[1] ?? "";
        currentLocation = section.location;
        continue;
      }
      if (answerMatch) {
        if (!currentQuestion) {
          continue;
        }
        currentAnswer = currentAnswer ? `${currentAnswer}\n${answerMatch[1]}` : (answerMatch[1] ?? "");
        continue;
      }
      if (currentAnswer) {
        currentAnswer = `${currentAnswer}\n${line}`;
        continue;
      }
      if (currentQuestion) {
        currentQuestion = `${currentQuestion} ${line}`.trim();
      }
    }
  }

  flush();
  return pairs;
}

function parseSectionLevelStructuredQa(section: { location: string; text: string }): DetectedQaPair | null {
  const normalized = section.text.replace(/\r\n/g, "\n").trim();
  const prefixedMatch = normalized.match(/^(?:问|问题|Q)[：:]\s*(.+?[？?])\s*\n(?:答|解答|A)[：:]\s*([\s\S]+)$/i);
  if (prefixedMatch) {
    return {
      question: normalizeStructuredQuestion(prefixedMatch[1] ?? ""),
      answer: normalizeStructuredAnswer(prefixedMatch[2] ?? ""),
      pageSection: section.location,
    };
  }
  const numberedMatch = normalized.match(/^(?:\d{1,4}[.、\s\u3000]+)?(.+?[？?])\s*\n(?:答|解答|A)[：:]\s*([\s\S]+)$/i);
  if (!numberedMatch) {
    return null;
  }
  return {
    question: normalizeStructuredQuestion(numberedMatch[1] ?? ""),
    answer: normalizeStructuredAnswer(numberedMatch[2] ?? ""),
    pageSection: section.location,
  };
}

function normalizeStructuredQuestion(value: string): string {
  return value.replace(/^\d{1,4}[.、\s\u3000]+/, "").replace(/\s+/g, " ").trim();
}

function normalizeStructuredAnswer(value: string): string {
  return value
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function sliceIntoBatches<T>(items: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

function buildSkippedChaptersWarning(titles: string[]): string {
  const visible = titles.slice(0, 4).join("、");
  const omitted = titles.length > 4 ? ` 等 ${titles.length} 个章节` : "";
  return `已跳过无效章节：${visible}${omitted}。`;
}

function buildMaxExtractQasWarning(limit: number): string {
  return `内容较长，已按质量评分保留前 ${limit} 条问答。`;
}

function buildChunkBatchingWarning(limit: number, total: number, batchCount: number): string {
  return `内容较长，共切分 ${total} 段，已自动按每批 ${limit} 段分 ${batchCount} 批处理。`;
}

function currentQuestionLooksNonQuestion(value: string): boolean {
  return /^(?:依据|来源|注|说明)[：:]/.test(value);
}

function joinWarnings(...warnings: Array<string | undefined>): string | undefined {
  const parts = warnings.filter((warning): warning is string => Boolean(warning && warning.trim()));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isRetryableKnowledgeExtractError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /terminated|abort|aborted|ECONNRESET|socket|timed out|fetch failed/i.test(message);
}

function wrapKnowledgeExtractError(error: unknown, chunkIndex: number, chunkCount: number): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/terminated/i.test(message)) {
    return new Error(`OpenCode 提取在第 ${chunkIndex + 1}/${chunkCount} 段被中断（terminated）。建议拆分文件或降低 maxExtractChunks 后重试。`);
  }
  return error instanceof Error ? error : new Error(message);
}

function extractRetryDelayMs(attempt: number): number {
  return attempt === 1 ? 500 : 1500;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveKnowledgeBitableViewUrl(config: AppConfig["knowledgeBase"]): string | undefined {
  const candidates = [
    config.storage.bitable.sourceFileField?.urlTemplate,
    config.storage.bitable.statuteField?.urlTemplate,
  ].filter((value): value is string => Boolean(value && value.startsWith("http") && !value.includes("{{")));
  if (candidates.length > 0) {
    return candidates[0];
  }
  if (!config.storage.bitable.appToken || !config.storage.bitable.tableId) {
    return undefined;
  }
  return `https://feishu.cn/base/${config.storage.bitable.appToken}?table=${config.storage.bitable.tableId}`;
}

function resolveKnowledgeModel(config: AppConfig["knowledgeBase"], step: "webRead" | "extract" | "rerank"): OpenCodeModelRef | undefined {
  return toOpenCodeModelRef(config.models[step] ?? config.models.default);
}

function resolveKnowledgeModelKey(config: AppConfig["knowledgeBase"], step: "webRead" | "extract" | "rerank"): string {
  return config.models[step] ?? config.models.default ?? "__opencode_default__";
}

function buildKnowledgePromptRequest(parts: OpenCodePromptRequest["parts"], model?: OpenCodeModelRef | undefined): OpenCodePromptRequest {
  return model ? { model, parts } : { parts };
}

function buildChunkExtractionHash(
  chunk: { location: string; text: string; prevContext?: string | undefined },
  modelKey: string,
): string {
  return crypto
    .createHash("sha256")
    .update(EXTRACTION_CACHE_VERSION)
    .update("\n")
    .update(modelKey)
    .update("\n")
    .update(chunk.location)
    .update("\n")
    .update(chunk.prevContext ?? "")
    .update("\n")
    .update(chunk.text)
    .digest("hex");
}

function toOpenCodeModelRef(model: string | undefined): OpenCodeModelRef | undefined {
  const normalized = model?.trim();
  if (!normalized) {
    return undefined;
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    throw new Error("knowledgeBase.models.* 必须使用 <provider>/<model> 格式");
  }

  return {
    providerID: normalized.slice(0, slashIndex),
    modelID: normalized.slice(slashIndex + 1),
  };
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function buildIngestWarning(extractedCount: number): string | undefined {
  if (extractedCount > 150) {
    return `该文件提取了 ${extractedCount} 条问答，建议人工抽查质量。`;
  }
  return undefined;
}

function normalizeDocumentStatusFilter(status: string | undefined): string[] | undefined {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "active") {
    return ["ingested", "synced"];
  }
  if (normalized === "failed") {
    return ["write-failed"];
  }
  if (normalized === "extracting") {
    return ["extracting", "writing", "extracted"];
  }
  return [status!.trim()];
}

function summarizeTagCounts(entries: Array<Pick<KnowledgeEntryRecord, "tags">>): Record<string, number> {
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      if (!tag.trim()) {
        continue;
      }
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...tagCounts.entries()].sort((left, right) => right[1] - left[1]));
}

function summarizeStatusCounts(documents: Array<Pick<KnowledgeDocumentSummary, "status">>): Record<string, number> {
  const statusCounts = new Map<string, number>();
  for (const document of documents) {
    statusCounts.set(document.status, (statusCounts.get(document.status) ?? 0) + 1);
  }
  return Object.fromEntries([...statusCounts.entries()].sort((left, right) => right[1] - left[1]));
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const errors: unknown[] = [];
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await fn(items[index]!, index);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  if (errors.length > 0) {
    throw errors[0];
  }
}

const NOISE_PATTERN = /目录|课程|学习|免责声明|转载|引用|检索|关键词|案由|文书类型|地域分布|案件分布|胜诉率|上诉率|审理程序|文章|作者|来源|课程学习|法律意见|全文检索|案例来源/;
const LEGAL_SIGNAL_PATTERN = /劳动|合同|解除|赔偿|补偿|仲裁|诉讼|调岗|调薪|培训|绩效|规章制度|通知|工会|证据|违法|合法|试用期|经济补偿|代通知金|岗位|用人单位|员工/;
