/**
 * 职责: 承载知识库核心业务，负责摄入、检索与结果编排。
 * 关注点:
 * - 解析文档并生成可检索的知识条目。
 * - 执行语义检索、结果排序和引用组织。
 * - 作为运行时模块与存储层之间的业务接口。
 */
import crypto from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { expandArchiveMaterialEntries, isArchiveFileName } from "../document-pipeline/archive.js";
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
  buildCaseDigestPrompt,
  detectJudicialDocument,
  normalizeCaseDigestItems,
  type CaseDigestCandidate,
} from "./extractors/case-digest.js";
import type { KnowledgeBaseConfig } from "./config.js";
import { exportKnowledgeObsidianNote, resolveKnowledgeObsidianNotePath } from "./obsidian-export.js";
import {
  KnowledgeDb,
  type KnowledgeDocumentRecord,
  type KnowledgeDocumentSummary,
  type KnowledgeEntryCandidate,
  type KnowledgeEntryRecord,
} from "./db.js";
import { rerankWithConfiguredProvider } from "./rerank-provider.js";
import { parseStatuteReferences } from "./statute-ref.js";
import type { WorkspaceService } from "../workspace/service.js";

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
  resourceType?: "file" | "image" | "folder" | undefined;
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
  downloadMessageResource(messageId: string, fileKey: string, type: "file" | "image" | "folder"): Promise<{
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
  entryType?: "article" | "case_digest" | "practice_note" | "case_reflow" | undefined;
  confidence?: number | undefined;
  reviewRequired?: boolean | undefined;
  effectiveStatus?: "current" | "unknown" | "expired" | undefined;
  dedupKey?: string | undefined;
  fieldsJson?: string | undefined;
};

type KnowledgeExtractQaPromptVariables = {
  fileName: string;
  pageSection: string;
  chunk: string;
  prevContext?: string | undefined;
};

type KnowledgeEnrichQaPromptVariables = {
  fileName: string;
  inputJson: string;
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
    private readonly config: KnowledgeBaseConfig,
    private readonly resources: KnowledgeResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
    private readonly workspaceService?: WorkspaceService,
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
    const statuteRefs = parseStatuteReferences(question);
    if (statuteRefs.length > 0) {
      const exactMatches = this.db.searchByStatuteReferences(statuteRefs, this.config.query.finalTopN);
      if (exactMatches.length > 0) {
        // V1: exact 命中即返回；V2 可考虑注入 hybrid 候选后统一 rerank。
        return {
          question,
          results: exactMatches.map((candidate) => this.enrichQueryCandidateLinks(candidate)),
          bitableUrl: resolveKnowledgeBitableViewUrl(this.config),
        };
      }
    }

    let embeddingMatches: KnowledgeEntryCandidate[] = [];
    try {
      const queryEmbedding = await this.embeddingClient.embed(question);
      embeddingMatches = this.db.searchByEmbedding(queryEmbedding, this.embeddingClient.model, this.config.query.topK);
    } catch (error) {
      this.logger.log("knowledge", "embedding query failed, falling back to keyword search", {
        errorKind: error instanceof Error ? error.name : "unknown",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const keywordMatches = this.db.searchByKeyword(question, this.config.query.keywordFallbackLimit);
    const merged = dedupeCandidates([...embeddingMatches, ...keywordMatches]);
    const reranked = await this.rerank(question, merged);
    const uniqueResults = dedupeEquivalentCandidates(reranked);
    return {
      question,
      results: uniqueResults.slice(0, this.config.query.finalTopN).map((candidate) => this.enrichQueryCandidateLinks(candidate)),
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
    const downloaded = await this.resources.downloadMessageResource(file.messageId, file.fileKey, file.resourceType ?? "file");
    const fileName = resolveDownloadedKnowledgeFileName(downloaded.fileName, file.fileName);
    validateUploadedFile(fileName, downloaded.buffer, this.config.ingest.allowedExtensions, this.config.ingest.maxFileSizeMb);
    if (isArchiveFileName(fileName)) {
      return await this.ingestArchiveBuffer(fileName, downloaded.buffer, {
        sourceType: "message-archive",
        messageId: file.messageId,
        fileKey: file.fileKey,
      }, options);
    }
    return await this.ingestBuffer({
      fileName,
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
    const parsed = await parseKnowledgeFile(fileName, buffer, this.config.parser, this.workspaceService);
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
    const parsedDocument = await parseKnowledgeFile(fileName, buffer, this.config.parser, this.workspaceService);
    const chapterGrouping = groupKnowledgeSectionsByChapter(parsedDocument.sections);
    const extractionSections = chapterGrouping.chapters.length > 0
      ? chapterGrouping.chapters.filter((chapter) => !chapter.skipped).flatMap((chapter) => chapter.sections)
      : parsedDocument.sections;
    const extractionMarkdown = extractionSections.map((section) => section.text).join("\n\n");
    const judicialDocument = this.config.judicialIngest?.enabled !== false
      ? detectJudicialDocument(extractionMarkdown || parsedDocument.normalizedMarkdown, extractionSections)
      : { matched: false as const, sections: {} };
    if (!judicialDocument.matched && judicialDocument.reason === "sensitive-material") {
      throw new Error("司法文书包含未脱敏敏感信息，已停止自动入库");
    }
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
    if (isExtractQaLimitEnabled(maxQas) && finalCandidates.length > maxQas) {
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
    const parsedDocument = await parseKnowledgeFile(input.fileName, input.buffer, this.config.parser, this.workspaceService);
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
    const judicialDocument = this.config.judicialIngest?.enabled !== false
      ? detectJudicialDocument(extractionMarkdown || parsedDocument.normalizedMarkdown, extractionSections)
      : { matched: false as const, sections: {} };
    if (!judicialDocument.matched && judicialDocument.reason === "sensitive-material") {
      throw new Error("司法文书包含未脱敏敏感信息，已停止自动入库");
    }
    const qaDocument = detectStructuredQaDocument(extractionMarkdown, extractionSections);
    const concurrency = this.config.ingest.concurrency;
    let rawExtractedCount = 0;
    let dedupedCount = 0;
    let finalCandidates: ExtractedQaCandidate[] = [];
    let warning = joinWarnings(
      chapterGrouping.skippedTitles.length > 0 ? buildSkippedChaptersWarning(chapterGrouping.skippedTitles) : undefined,
    );

    if (judicialDocument.matched) {
      this.db.clearExtractedChunks(document.id);
      await this.reportProgress(options, {
        step: "extract",
        status: "running",
        detail: `已识别司法文书（${judicialDocument.caseNumber}），正在提取类案要旨`,
      });
      const caseDigestCandidates = await this.extractCaseDigests(input.fileName, judicialDocument, extractionMarkdown);
      rawExtractedCount = caseDigestCandidates.length;
      finalCandidates = caseDigestCandidates;
      dedupedCount = 0;
    } else if (qaDocument.matched) {
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
      const extractPromptCacheKey = await this.resolveExtractQaPromptCacheKey();
      const cachedChunks = this.restoreChunkExtractions(document.id, chunks, extractPromptCacheKey);
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
            chunkHash: buildChunkExtractionHash(chunk, resolveKnowledgeModelKey(this.config, "extract"), extractPromptCacheKey),
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

    if (isExtractQaLimitEnabled(this.config.ingest.maxExtractQas) && finalCandidates.length > this.config.ingest.maxExtractQas) {
      finalCandidates = [...finalCandidates]
        .sort((left, right) => scoreExtractedCandidate(right) - scoreExtractedCandidate(left))
        .slice(0, this.config.ingest.maxExtractQas);
      warning = joinWarnings(warning, buildMaxExtractQasWarning(this.config.ingest.maxExtractQas));
    }

    const beforeDedupKeyFilterCount = finalCandidates.length;
    finalCandidates = this.filterExistingDedupKeyCandidates(finalCandidates);
    dedupedCount += beforeDedupKeyFilterCount - finalCandidates.length;

    const totalExtracted = finalCandidates.length;
    this.db.updateDocumentStatus(document.id, totalExtracted > 0 ? "writing" : "extracted");
    await this.reportProgress(options, {
      step: "extract",
      status: "completed",
      detail: totalExtracted > 0
        ? `已提取 ${totalExtracted} 条知识（原始 ${rawExtractedCount} 条，去重合并 ${dedupedCount} 条）`
        : "未提取到可入库知识",
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
        const sourceFieldValue = fields[resolveSourceFileFieldName(this.config)];
        const statuteFieldValue = fields[resolveStatuteFieldName(this.config)];
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
          sourceUrl: readUrlValue(sourceFieldValue),
          statuteUrl: readUrlValue(statuteFieldValue),
          bitableRecordId,
          embedding,
          embeddingModel: this.embeddingClient.model,
          entryType: item.entryType,
          confidence: item.confidence,
          reviewRequired: item.reviewRequired,
          effectiveStatus: item.effectiveStatus,
          dedupKey: item.dedupKey,
          fieldsJson: item.fieldsJson,
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
    const obsidianPath = await exportKnowledgeObsidianNote(this.config.obsidian ?? {
      enabled: false,
      baseDir: "Legal Knowledge",
      enableWikiLinks: true,
    }, {
      sourceType: input.sourceType,
      fileName: input.fileName,
      checksum,
      domain: "劳动争议",
      tags: [...tagCounts.keys()],
      entries: finalCandidates.map((item) => ({
        question: item.question,
        answer: item.answer,
        tags: item.tags,
        statute: item.statute,
        pageSection: item.pageSection,
      })),
      sqliteDocumentId: document.id,
      bitableUrl: resolveKnowledgeBitableViewUrl(this.config),
    }).catch((error) => {
      this.logger.log("knowledge", "obsidian export skipped", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return null;
    });
    if (obsidianPath) {
      this.db.updateDocumentObsidianPath(document.id, obsidianPath);
    }
    await this.reportProgress(options, {
      step: "write",
      status: "completed",
      detail: totalExtracted > 0
        ? `已写入 ${writeCompleted} 条知识${obsidianPath ? "，已导出 Obsidian 笔记" : ""}`
        : "没有可写入的知识",
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

  private async ingestArchiveBuffer(
    archiveFileName: string,
    buffer: Buffer,
    context: {
      sourceType: string;
      messageId?: string | undefined;
      fileKey?: string | undefined;
    },
    options?: KnowledgeIngestOptions,
  ): Promise<KnowledgeIngestResult> {
    await this.reportProgress(options, {
      step: "read",
      status: "running",
      detail: "正在展开文件夹压缩包",
    });
    const entries = expandArchiveMaterialEntries(archiveFileName, buffer, this.config.ingest.allowedExtensions);
    if (entries.length === 0) {
      throw new Error(`压缩包内未找到可入库文件；支持 ${this.config.ingest.allowedExtensions.filter((extension) => extension !== ".zip").join(" / ")} 文件`);
    }
    const startedAt = Date.now();
    const aggregateTags = new Map<string, number>();
    const failures: string[] = [];
    let rawExtractedCount = 0;
    let dedupedCount = 0;
    let extractedCount = 0;
    let bitableUrl: string | undefined;
    for (const [index, entry] of entries.entries()) {
      await this.reportProgress(options, {
        step: "read",
        status: "running",
        detail: `正在处理压缩包内文件（${index + 1}/${entries.length}）：${entry.fileName}`,
      });
      try {
        const result = await this.ingestBuffer({
          fileName: entry.fileName,
          buffer: entry.buffer,
          sourceType: context.sourceType,
          messageId: context.messageId,
          fileKey: context.fileKey,
        }, options);
        rawExtractedCount += result.rawExtractedCount ?? result.extractedCount;
        dedupedCount += result.dedupedCount ?? 0;
        extractedCount += result.extractedCount;
        bitableUrl = result.bitableUrl ?? bitableUrl;
        for (const [tag, count] of Object.entries(result.tagCounts)) {
          aggregateTags.set(tag, (aggregateTags.get(tag) ?? 0) + count);
        }
      } catch (error) {
        failures.push(`${entry.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (extractedCount === 0 && failures.length > 0) {
      throw new Error(`压缩包内文件全部入库失败。首个错误：${failures[0]}`);
    }
    return {
      sourceFile: `${archiveFileName}（${entries.length} 个文件）`,
      rawExtractedCount,
      dedupedCount,
      extractedCount,
      tagCounts: Object.fromEntries([...aggregateTags.entries()].sort((left, right) => right[1] - left[1])),
      durationMs: Date.now() - startedAt,
      bitableUrl,
      warning: failures.length > 0 ? `压缩包内 ${failures.length} 个文件入库失败：${failures.slice(0, 3).join("；")}` : undefined,
    };
  }

  // #endregion

  // #region 外部同步与关闭

  /** 从 Bitable 反向同步已有知识记录到本地数据库。 */
  async syncMirror(): Promise<void> {
    const localRecordIds = new Set(this.db.listEntryBitableRecordIds());
    const records = await this.resources.listBitableRecords(
      this.config.storage.bitable.appToken,
      this.config.storage.bitable.tableId,
    );
    const remoteRecordIds = new Set(records.map((record) => record.recordId).filter((value) => value.length > 0));
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
        sourceUrl: readUrlField(record.fields, sourceFieldName) ?? readUrlField(record.fields, "源文件"),
        statuteUrl: readUrlField(record.fields, resolveStatuteFieldName(this.config)) ?? readUrlField(record.fields, "法条"),
        bitableRecordId: record.recordId,
        embedding,
        embeddingModel: this.embeddingClient.model,
      });
    }
    const removedRecordIds = [...localRecordIds].filter((recordId) => !remoteRecordIds.has(recordId));
    if (removedRecordIds.length > 0) {
      const affectedDocuments = this.db.listDocumentsByEntryBitableRecordIds(removedRecordIds);
      this.db.deleteEntriesByBitableRecordIds(removedRecordIds);
      const orphanDocuments = this.db.listOrphanDocumentsByIds(affectedDocuments.map((document) => document.id));
      await this.deleteObsidianNotesForDocuments(orphanDocuments);
      this.db.deleteOrphanDocumentsByIds(orphanDocuments.map((document) => document.id));
      this.db.deleteOrphanSyncedDocuments();
    }
  }

  /** 关闭知识库数据库连接。 */
  close(): void {
    this.db.close();
  }

  /** 删除由知识库自动导出的 Obsidian 笔记；只删除可由本地文档元数据反查的系统笔记。 */
  private async deleteObsidianNotesForDocuments(documents: KnowledgeDocumentRecord[]): Promise<void> {
    const config = this.config.obsidian;
    if (!config?.enabled || !config.vaultPath) {
      return;
    }
    const notePaths = new Set<string>();
    for (const document of documents) {
      notePaths.add(document.obsidianPath ?? resolveKnowledgeObsidianNotePath(config, {
        fileName: document.fileName,
        checksum: document.checksum,
        sqliteDocumentId: document.id,
      }));
    }
    for (const notePath of notePaths) {
      if (!isPathInsideDirectory(notePath, path.join(config.vaultPath, config.baseDir))) {
        this.logger.log("knowledge", "skip obsidian note delete outside knowledge dir", { notePath }, "warn");
        continue;
      }
      await unlink(notePath).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") {
          return;
        }
        this.logger.log("knowledge", "obsidian note delete failed", {
          notePath,
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }
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

  /** 从司法文书中提取可检索的类案要旨。 */
  private async extractCaseDigests(
    fileName: string,
    detection: Parameters<typeof buildCaseDigestPrompt>[0]["detection"],
    sourceText: string,
  ): Promise<CaseDigestCandidate[]> {
    const session = await this.opencode.createSession("[bridge] knowledge-case-digest");
    try {
      const response = await this.opencode.postMessageSync(session.id, buildKnowledgePromptRequest(
        [{
          type: "text",
          text: buildCaseDigestPrompt({
            fileName,
            detection,
          }),
        }],
        resolveKnowledgeModel(this.config, "extract"),
      ));
      return normalizeCaseDigestItems({
        rawItems: parseJsonArray(extractAssistantText(response)),
        detection,
        sourceText,
      });
    } finally {
      await this.opencode.deleteSession(session.id).catch(() => undefined);
    }
  }

  /** 从单个文本分段中提取可入库的问答对。 */
  private async extractQa(fileName: string, pageSection: string, chunk: string, prevContext?: string | undefined): Promise<ExtractedQa[]> {
    const session = await this.opencode.createSession("[bridge] knowledge-extract");
    try {
      const prompt = await this.buildExtractQaPrompt({
        fileName,
        pageSection,
        chunk,
        prevContext,
      });
      const response = await this.opencode.postMessageSync(session.id, buildKnowledgePromptRequest(
        [{
          type: "text",
          text: prompt,
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
      const inputJson = JSON.stringify(batch, null, 2);
      const prompt = await this.buildEnrichQaPrompt({
        fileName,
        inputJson,
      });
      const response = await this.opencode.postMessageSync(session.id, buildKnowledgePromptRequest(
        [{
          type: "text",
          text: prompt,
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

  /** 已存在 dedupKey 的条目不再重复写入，保护同案同争议焦点不会堆出副本。 */
  private filterExistingDedupKeyCandidates<T extends ExtractedQaCandidate>(candidates: T[]): T[] {
    return candidates.filter((candidate) => !candidate.dedupKey || !this.db.findByDedupKey(candidate.dedupKey));
  }

  /** 用模型对候选检索结果做二次重排。 */
  private async rerank(question: string, candidates: KnowledgeEntryCandidate[]): Promise<KnowledgeEntryCandidate[]> {
    if (candidates.length <= 1) {
      return candidates;
    }

    try {
      const providerResult = await rerankWithConfiguredProvider(this.config, question, candidates);
      if (providerResult.usedProvider) {
        return providerResult.candidates;
      }
    } catch (error) {
      this.logger.log("knowledge/query", "configured rerank provider failed, falling back to llm", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
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
          reranked: true,
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

  private enrichQueryCandidateLinks(candidate: KnowledgeEntryCandidate): KnowledgeEntryCandidate {
    const statuteTemplateUrl = buildStatuteUrl(this.config, {
      fileName: candidate.sourceFile,
      pageSection: candidate.pageSection,
      sourceUrl: candidate.sourceUrl,
      statute: candidate.statute,
    });
    return {
      ...candidate,
      sourceUrl: candidate.sourceUrl ?? buildKnowledgeRecordUrl(resolveKnowledgeBitableViewUrl(this.config), candidate.bitableRecordId),
      statuteUrl: resolveDisplayStatuteUrl(candidate.statuteUrl, statuteTemplateUrl),
    };
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
    extractPromptCacheKey: string,
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
      const expectedHash = buildChunkExtractionHash(chunk, expectedModel, extractPromptCacheKey);
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

  private async resolveExtractQaPromptCacheKey(): Promise<string> {
    const override = await readKnowledgePromptOverride(this.config.prompts?.extractQaPath);
    return override ? hashText(override) : "builtin-extract-qa-v1";
  }

  private async buildExtractQaPrompt(variables: KnowledgeExtractQaPromptVariables): Promise<string> {
    const override = await readKnowledgePromptOverride(this.config.prompts?.extractQaPath);
    return override
      ? renderKnowledgePromptTemplate(override, {
        fileName: variables.fileName,
        pageSection: variables.pageSection,
        chunk: variables.chunk,
        prevContext: variables.prevContext ?? "",
      })
      : buildDefaultExtractQaPrompt(variables);
  }

  private async buildEnrichQaPrompt(variables: KnowledgeEnrichQaPromptVariables): Promise<string> {
    const override = await readKnowledgePromptOverride(this.config.prompts?.enrichQaPath);
    return override
      ? renderKnowledgePromptTemplate(override, {
        fileName: variables.fileName,
        inputJson: variables.inputJson,
      })
      : buildDefaultEnrichQaPrompt(variables);
  }
}

function resolveSourceFileFieldName(config: KnowledgeBaseConfig): string {
  return config.storage.bitable.sourceFileField?.name ?? "源文件";
}

function resolveStatuteFieldName(config: KnowledgeBaseConfig): string {
  return config.storage.bitable.statuteField?.name ?? "法条";
}

function buildDefaultExtractQaPrompt(variables: KnowledgeExtractQaPromptVariables): string {
  return [
    "你是法律知识提取专家。",
    "阅读以下文本片段，提取可以直接回答用户法律咨询的问答对。",
    "规则：",
    "1. 问题必须是用户真实会提出的法律实务问题，范围覆盖劳动用工、合同纠纷、公司治理、知识产权、婚姻家事、侵权责任、行政合规、税务、数据与平台合规、诉讼仲裁和执行等场景。",
    "2. 同一知识点只提取一个问答对，答案中列举所有关键情形，不要拆成多条相近问题。",
    "3. 答案忠于原文，长度控制在 50-300 字，涵盖核心结论、适用条件和例外情形，不要整段照抄原文。",
    "4. 不要提取目录、课程介绍、检索方法、转载说明、免责声明、作者信息、统计图表、地域分布、学习建议、关键词列表等非咨询内容。",
    "5. 如果片段主要是说明性或信息性内容，而不是可直接回答咨询的问题，返回空数组 []。",
    "字段说明：",
    "- question: 字符串，口语化的法律咨询问题",
    "- answer: 字符串，基于原文的回答",
    "- tags: 数组，1-3 个核心法律主题标签",
    "- statute: 字符串或 null；无明确法条引用时填 null",
    variables.prevContext ? `前文上下文（仅供理解，不要从这里单独提取问答）：\n${variables.prevContext}` : "",
    `源文件：${variables.fileName}`,
    `页码/章节：${variables.pageSection}`,
    "---正文开始---",
    variables.chunk,
    "---正文结束---",
    "示例输出：",
    JSON.stringify([
      {
        question: "合同一方迟延付款时，守约方可以主张哪些违约责任？",
        answer: "守约方通常可以依据合同约定和法律规定主张继续履行、支付违约金、赔偿损失等责任；如迟延付款导致合同目的不能实现，还可结合约定和法定条件评估解除合同。",
        tags: ["合同纠纷", "违约责任"],
        statute: "《民法典》第 577 条",
      },
      {
        question: "股东会决议程序存在瑕疵时，公司应如何评估决议效力？",
        answer: "需要结合召集程序、表决方式、表决比例和瑕疵程度判断。轻微瑕疵通常不当然影响效力，严重违反法律或章程并影响表决结果的，可能面临撤销或无效风险。",
        tags: ["公司治理", "股东会决议"],
        statute: null,
      },
      {
        question: "未经许可使用他人注册商标会有哪些侵权风险？",
        answer: "未经许可在相同或类似商品服务上使用相同或近似商标，容易导致混淆的，可能构成商标侵权，需要承担停止侵害、赔偿损失等责任。",
        tags: ["知识产权", "商标侵权"],
        statute: "《商标法》第 57 条",
      },
    ], null, 2),
    "只输出 JSON 数组，不要输出其他内容。",
  ].filter(Boolean).join("\n\n");
}

function buildDefaultEnrichQaPrompt(variables: KnowledgeEnrichQaPromptVariables): string {
  return [
    "你是法律知识补充助手。",
    "用户已经从问答体文档中本地抽取了 question 和 answer。",
    "不要重写、改写、扩写或合并 question / answer，只补充 tags 和 statute。",
    "返回 JSON 数组，每个元素包含 question、answer、tags、statute。",
    "其中：",
    "- question: 必须与输入完全一致",
    "- answer: 必须与输入完全一致",
    "- tags: 1-3 个核心法律主题标签",
    "- statute: 无明确法条时填 null",
    `源文件：${variables.fileName}`,
    `输入：${variables.inputJson}`,
    "只输出 JSON 数组，不要输出其他内容。",
  ].join("\n\n");
}

async function readKnowledgePromptOverride(filePath?: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }
  const content = (await readFile(filePath, "utf8")).trim();
  return content || undefined;
}

function renderKnowledgePromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? "");
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function buildSourceFileFieldValue(
  config: KnowledgeBaseConfig,
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
  config: KnowledgeBaseConfig,
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

function buildKnowledgeRecordUrl(bitableUrl: string | undefined, recordId: string | undefined): string | undefined {
  if (!bitableUrl || !recordId) {
    return undefined;
  }
  try {
    const url = new URL(bitableUrl);
    url.searchParams.set("record", recordId);
    return url.toString();
  } catch {
    return undefined;
  }
}

function buildStatuteUrl(config: KnowledgeBaseConfig, context: StatuteTemplateContext): string | undefined {
  const fieldConfig = config.storage.bitable.statuteField;
  if (!context.statute || !fieldConfig?.urlTemplate) {
    return undefined;
  }
  return normalizeBitableUrl(renderStatuteTemplate(fieldConfig.urlTemplate, {
    fileName: context.fileName,
    pageSection: context.pageSection,
    sourceUrl: context.sourceUrl,
    statute: context.statute,
  }));
}

function resolveDisplayStatuteUrl(recordedUrl: string | undefined, fallbackUrl: string | undefined): string | undefined {
  if (!recordedUrl) {
    return fallbackUrl;
  }
  // 旧数据可能把法条字段链接到飞书知识库，或写入不可搜索的北大法宝 keyword 链接；展示时统一回退到当前法条搜索模板。
  if (isStaleStatuteUrl(recordedUrl)) {
    return fallbackUrl ?? recordedUrl;
  }
  return recordedUrl;
}

function isStaleStatuteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname.endsWith("feishu.cn") || hostname.endsWith("larksuite.com")) {
      return true;
    }
    return hostname.endsWith("pkulaw.com") && url.searchParams.has("keyword");
  } catch {
    return false;
  }
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

function isExtractQaLimitEnabled(limit: number): boolean {
  return limit > 0;
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

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function resolveDownloadedKnowledgeFileName(downloadedFileName: string, messageFileName: string): string {
  if (path.extname(downloadedFileName)) {
    return downloadedFileName;
  }
  if (!path.extname(messageFileName)) {
    return downloadedFileName;
  }
  // 飞书下载接口偶尔只返回资源 key 或无扩展名名称；入库校验以消息卡片上的原始文件名兜底。
  return messageFileName;
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

function readUrlField(fields: Record<string, unknown>, key: string): string | undefined {
  return readUrlValue(fields[key]);
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

function readUrlValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = readUrlValue(item);
      if (url) {
        return url;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as { link?: unknown; url?: unknown };
    const link = typeof record.link === "string" && record.link.trim() ? record.link.trim() : undefined;
    const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : undefined;
    return link ?? url;
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

function resolveKnowledgeBitableViewUrl(config: KnowledgeBaseConfig): string | undefined {
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

function resolveKnowledgeModel(config: KnowledgeBaseConfig, step: "webRead" | "extract" | "rerank"): OpenCodeModelRef | undefined {
  return toOpenCodeModelRef(config.models[step] ?? config.models.default);
}

function resolveKnowledgeModelKey(config: KnowledgeBaseConfig, step: "webRead" | "extract" | "rerank"): string {
  return config.models[step] ?? config.models.default ?? "__opencode_default__";
}

function buildKnowledgePromptRequest(parts: OpenCodePromptRequest["parts"], model?: OpenCodeModelRef | undefined): OpenCodePromptRequest {
  return model ? { model, parts } : { parts };
}

function buildChunkExtractionHash(
  chunk: { location: string; text: string; prevContext?: string | undefined },
  modelKey: string,
  promptKey: string,
): string {
  return crypto
    .createHash("sha256")
    .update(EXTRACTION_CACHE_VERSION)
    .update("\n")
    .update(modelKey)
    .update("\n")
    .update(promptKey)
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

const NOISE_PATTERN = /目录|课程|学习|免责声明|转载说明|引用|检索|关键词|文书类型|地域分布|案件分布|胜诉率|上诉率|文章|作者|课程学习|法律意见|全文检索|文章来源|资料来源|转载来源/;
const LEGAL_SIGNAL_PATTERN = /劳动|合同|解除|赔偿|补偿|仲裁|诉讼|执行|调岗|调薪|培训|绩效|规章制度|通知|工会|证据|违法|合法|试用期|经济补偿|代通知金|岗位|用人单位|员工|职工|工伤|加班费|社会保险|社保|公司治理|股东|股权|董事|章程|决议|知识产权|著作权|商标|专利|侵权|婚姻|离婚|夫妻|继承|行政处罚|行政复议|行政诉讼|税务|纳税|数据合规|个人信息|平台合规|违约|担保|债权|债务|买卖|租赁|借款|民法典|商标法|公司法|行政法|民事/;
