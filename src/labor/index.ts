/**
 * 职责: 提供劳动争议材料分析领域服务。
 * 关注点:
 * - 提取单份材料中的证据属性、关键事实和时间线线索。
 * - 汇总多份材料形成完整的分析结果与风险判断。
 */
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LaborSkillConfig } from "../config/schema.js";
import { expandArchiveMaterialEntries, isArchiveFileName } from "../document-pipeline/archive.js";
import { SUPPORTED_DOCUMENT_EXTENSIONS } from "../document-pipeline/material-support.js";
import type { DocumentParserOptions } from "../document-pipeline/index.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type {
  PkulawAuthorityItem,
  PkulawAuthoritySearchResult,
  PkulawAuthorityService,
  PkulawCaseNumberItem,
  PkulawCitationValidationInput,
  PkulawCitationValidationItem,
  PkulawLawRecognitionItem,
  PkulawToolResult,
} from "../knowledge/pkulaw-authority.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeModelRef, OpenCodePromptRequest } from "../opencode/client.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import { redactEvidenceRecord, redactEvidenceText } from "../runtime/sanitize.js";
import {
  EvidenceExtractService,
  type EvidenceExtractResourcePort,
  type EvidenceMaterialInput,
} from "../workflows/evidence-extract.js";
import { syncEvidenceLedger, type EvidenceLedgerResourcePort } from "../workflows/evidence-ledger.js";
import { generateCaseWorkflowWorkbench } from "../workflows/case-workflow.js";
import { updateWorkbenchDocument } from "../workflows/workbench-generate.js";
import { buildTimelineMermaid, escapeMermaidLabel } from "../workflows/timeline-build.js";
import { checkLaborLegalCitations, formatCitationReviewText } from "./legal-citation.js";
import { buildLaborAggregatePrompt, buildLaborMaterialExtractPrompt, buildLaborReviewPrompt } from "./prompts.js";

type OpenCodePort = Pick<OpenCodeClient, "createSession" | "postMessageSync" | "deleteSession">;
type LaborSkillResourcePort = EvidenceExtractResourcePort & EvidenceLedgerResourcePort;

export type LaborMaterialExtraction = {
  sourceFileName?: string | undefined;
  materialType: string;
  summary: string;
  facts: string[];
  timelineEvents: Array<{ date?: string | undefined; event: string; evidence?: string | undefined }>;
  evidenceRows: Array<{ name: string; type?: string | undefined; proves: string; support?: string | undefined; strength?: string | undefined; risk?: string | undefined; remarks?: string | undefined }>;
  riskPoints: string[];
  missingEvidenceHints: string[];
};

export type LaborAggregateResult = {
  caseTitle: string;
  disputeStage: string;
  summary: string;
  coreJudgment: string[];
  evidenceRows: Array<{ name: string; type?: string | undefined; proves: string; support?: string | undefined; strength?: string | undefined; risk?: string | undefined; remarks?: string | undefined }>;
  timeline: Array<{ date?: string | undefined; event: string; evidence?: string | undefined }>;
  issues: Array<{ issue: string; analysis: string; riskLevel?: string | undefined }>;
  missingEvidence: string[];
  nextActions: string[];
  legalSupports: Array<{ issue: string; rule: string; relation: string }>;
  keyIssues: string[];
  claimBasis: ClaimBasisItem[];
  strategy: { litigation: string[]; mediation: string[]; response: string[] };
  draftDocuments: Array<{ type: string; summary: string; content?: string | undefined }>;
};

export type ClaimBasisItem = {
  claim: string;
  basis: string;
  evidence: string[];
  risk?: string | undefined;
  reviewNote?: string | undefined;
};

export type LaborAnalyzeResult = {
  title: string;
  markdown: string;
  docUrl?: string | undefined;
  ledgerUrl?: string | undefined;
  keyEvidenceViewUrl?: string | undefined;
  missingEvidenceViewUrl?: string | undefined;
  syncedEvidenceCount: number;
  syncedGapCount: number;
  extractedMaterials: LaborMaterialExtraction[];
  aggregate: LaborAggregateResult;
  warnings: string[];
};

export type LaborAuthoritySearchDraft = {
  mainQuery: string;
  alternatives: string[];
  reason: string;
};

export type LaborAuthorityAppendResult = {
  markdown: string;
  search: PkulawAuthoritySearchResult;
  lawRecognition?: PkulawToolResult<PkulawLawRecognitionItem> | undefined;
  citationValidation?: PkulawToolResult<PkulawCitationValidationItem> | undefined;
  caseNumberRecognition?: PkulawToolResult<PkulawCaseNumberItem> | undefined;
};

export type LaborMaterialExtractResult = {
  fileName: string;
  extraction: LaborMaterialExtraction;
  cached: boolean;
};

export type LaborMaterialInput = EvidenceMaterialInput;

export type LaborReviewSourceType =
  | "material"
  | "local_kb:article"
  | "local_kb:digest"
  | "local_kb:reflow"
  | "local_kb:practice"
  | "authority"
  | null;

export type SourceRef =
  | { type: "material"; ref: string }
  | { type: "local_kb:article"; ref: string }
  | { type: "local_kb:digest"; ref: string }
  | { type: "local_kb:reflow"; ref: string }
  | { type: "local_kb:practice"; ref: string }
  | { type: "local_kb"; ref: string } // 兼容旧格式
  | { type: "authority"; ref: string }
  | { type: null; ref?: string };

/** 将旧 local_kb 映射为 local_kb:practice */
export function normalizeSourceType(source: SourceRef): SourceRef {
  if (source.type === "local_kb") {
    return { type: "local_kb:practice", ref: source.ref };
  }
  return source;
}

/** 判断是否为硬依据（authority 或 local_kb:article） */
export function isHardEvidence(source: SourceRef): boolean {
  return source.type === "authority" || source.type === "local_kb:article";
}

/** 判断是否为软参考 */
export function isSoftReference(source: SourceRef): boolean {
  return source.type === "local_kb:digest"
    || source.type === "local_kb:reflow"
    || source.type === "local_kb:practice"
    || source.type === "material";
}

export interface LaborFinalReviewReport {
  status: "pass" | "needs_revision" | "needs_human_review";
  findings: Array<{
    severity: "low" | "medium" | "high";
    type: string;
    message: string;
    relatedSection?: string;
    source: SourceRef;
  }>;
  unsupportedClaims: string[];
  authorityCoverage: Array<{
    issue: string;
    status: "sufficient" | "partial" | "missing" | "skipped";
    source: SourceRef;
  }>;
  suggestedEdits: string[];
  warnings: Array<{ code: string; message: string }>;
}

/** 二审时提供的权威检索上下文，决定依据标准是否放宽。 */
export type LaborReviewAuthorityContext = {
  status: "pending" | "skipped" | "completed";
  searchResult?: PkulawAuthoritySearchResult | undefined;
  lawRecognition?: PkulawToolResult<PkulawLawRecognitionItem> | undefined;
  citationValidation?: PkulawToolResult<PkulawCitationValidationItem> | undefined;
  caseNumberRecognition?: PkulawToolResult<PkulawCaseNumberItem> | undefined;
};

type LaborSkillCacheFile = {
  version: 1;
  materials: Record<string, LaborMaterialExtraction>;
  aggregates: Record<string, LaborAggregateResult>;
};

export class LaborSkillService {
  private readonly evidenceExtractor: EvidenceExtractService;
  private readonly cacheFilePath: string;

  constructor(
    private readonly config: LaborSkillConfig,
    dataDir: string,
    private readonly resources: LaborSkillResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
    private readonly knowledge: KnowledgeBasePort | null,
    private readonly authority: Pick<PkulawAuthorityService, "searchLawSemantic" | "recognizeLawReferences" | "validateCitations" | "recognizeCaseNumbers"> | null = null,
    parserOptions?: DocumentParserOptions | undefined,
  ) {
    this.evidenceExtractor = new EvidenceExtractService(resources, opencode, logger, parserOptions);
    this.cacheFilePath = path.join(dataDir, "labor-skill-cache.json");
  }

  buildAuthoritySearchDraft(result: LaborAnalyzeResult): LaborAuthoritySearchDraft {
    const aggregate = result.aggregate;
    const seeds = [
      ...aggregate.keyIssues,
      ...aggregate.issues.map((item) => item.issue),
      ...aggregate.claimBasis.map((item) => item.claim),
      ...aggregate.missingEvidence.slice(0, 2),
    ]
      .map((item) => item.trim())
      .filter(Boolean);
    const uniqueSeeds = [...new Set(seeds)].slice(0, 5);
    const mainQuery = uniqueSeeds[0]
      ? `劳动争议 ${uniqueSeeds[0]}`
      : "劳动争议 违法解除劳动合同";
    const alternatives = uniqueSeeds.slice(1, 5).map((item) => `劳动争议 ${item}`);
    return {
      mainQuery,
      alternatives,
      reason: "根据劳动分析报告中的争议焦点、请求项和证据缺口生成；确认后只追加权威法规区块，不重跑分析。",
    };
  }

  async appendAuthoritySearch(
    result: LaborAnalyzeResult,
    input: {
      query: string;
      turnId: string;
      sessionId: string;
    },
  ): Promise<LaborAuthorityAppendResult> {
    const disabledSearch = {
      status: "disabled" as const,
      query: input.query,
      items: [],
      durationMs: 0,
      message: "pkulaw 未启用。",
    };
    const disabledToolResult = {
      status: "disabled" as const,
      input: result.markdown,
      items: [],
      durationMs: 0,
      message: "pkulaw 未启用。",
    };
    const citationParam = buildPkulawCitationValidationParam(result);
    const [search, lawRecognition, citationValidation, caseNumberRecognition] = this.authority
      ? await Promise.all([
        this.authority.searchLawSemantic(input),
        this.authority.recognizeLawReferences({
          text: buildPkulawSourceText(result),
          turnId: input.turnId,
          sessionId: input.sessionId,
        }),
        this.authority.validateCitations({
          param: citationParam,
          turnId: input.turnId,
          sessionId: input.sessionId,
        }),
        this.authority.recognizeCaseNumbers({
          text: buildPkulawSourceText(result),
          turnId: input.turnId,
          sessionId: input.sessionId,
        }),
      ])
      : [disabledSearch, disabledToolResult, disabledToolResult, disabledToolResult];
    return {
      search,
      lawRecognition,
      citationValidation,
      caseNumberRecognition,
      markdown: renderPkulawAuthorityAppendMarkdown(result.title, search),
    };
  }

  // #region 对外分析入口

  /** 执行完整劳动分析流程：逐份提取后再统一汇总。 */
  async analyze(
    files: LaborMaterialInput[],
    notes: string[],
    options?: { onProgress?: ((step: string) => Promise<void> | void) | undefined },
  ): Promise<LaborAnalyzeResult> {
    const onProgress = options?.onProgress;
    const extractedMaterials: LaborMaterialExtraction[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      try {
        const expandedFiles = await this.expandMaterialFile(file);
        for (const expandedFile of expandedFiles) {
          const extracted = await this.extractMaterial(expandedFile, {
            onProgress,
          });
          extractedMaterials.push(extracted.extraction);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const warning = `已跳过《${getLaborMaterialInputFileName(file)}》：${detail}`;
        warnings.push(warning);
        await onProgress?.(warning);
      }
    }

    if (extractedMaterials.length === 0) {
      throw new Error(warnings.length > 0
        ? `所有材料都未能成功解析。\n${warnings.join("\n")}`
        : "当前没有可用于劳动分析的材料。");
    }

    return await this.finalizeAnalysis({
      extractedMaterials,
      notes,
      materialCount: extractedMaterials.length,
      warnings,
    }, { onProgress });
  }

  /** 提取单份材料中的事实、证据和风险信息。 */
  async expandMaterialFile(file: LaborMaterialInput): Promise<LaborMaterialInput[]> {
    const fileName = getLaborMaterialInputFileName(file);
    if (!isArchiveFileName(fileName)) {
      return [file];
    }
    const downloaded = await this.readArchiveMaterial(file);
    const archiveFileName = path.extname(downloaded.fileName) ? downloaded.fileName : fileName;
    const entries = expandArchiveMaterialEntries(archiveFileName, downloaded.buffer, this.config.ingest.allowedExtensions);
    if (entries.length === 0) {
      throw new Error(`文件夹压缩包内未找到可分析材料；支持 ${this.config.ingest.allowedExtensions.filter((extension) => extension !== ".zip").join(" / ")} 文件`);
    }
    return entries.map((entry) => ({
      fileName: entry.fileName,
      buffer: entry.buffer,
      mimeType: extensionToMimeType(path.extname(entry.fileName).toLowerCase()),
      size: entry.buffer.byteLength,
    }));
  }

  private async readArchiveMaterial(file: LaborMaterialInput): Promise<{ fileName: string; buffer: Buffer }> {
    if ("buffer" in file) {
      return { fileName: file.fileName, buffer: file.buffer };
    }
    if ("localPath" in file) {
      return {
        fileName: file.fileName?.trim() || path.basename(file.localPath),
        buffer: await readFile(file.localPath),
      };
    }
    const downloaded = await this.resources.downloadMessageResource(file.messageId, file.fileKey, file.resourceType ?? "file");
    return { fileName: downloaded.fileName, buffer: downloaded.buffer };
  }

  async extractMaterial(
    file: LaborMaterialInput,
    options?: { onProgress?: ((step: string) => Promise<void> | void) | undefined },
  ): Promise<LaborMaterialExtractResult> {
    const onProgress = options?.onProgress;
    const displayFileName = getLaborMaterialInputFileName(file);
    await onProgress?.(`准备解析《${displayFileName}》`);
    const preparedFile = await this.evidenceExtractor.prepareFile(file, {
      allowedExtensions: this.config.ingest.allowedExtensions,
      maxFileSizeMb: this.config.ingest.maxFileSizeMb,
      maxExtractedTextLength: 20_000,
      parseTextExtensions: [...SUPPORTED_DOCUMENT_EXTENSIONS],
    });
    const cache = await this.readCache();
    const fileHash = buildLaborCacheKey(preparedFile.buffer);
    const cached = cache.materials[fileHash];
    if (cached) {
      await onProgress?.(`命中缓存，已复用《${displayFileName}》的历史提取结果`);
      return {
        fileName: preparedFile.fileName,
        extraction: {
          ...cached,
          sourceFileName: preparedFile.fileName,
        },
        cached: true,
      };
    }

    await onProgress?.(
      preparedFile.extractedText
        ? `已提取文本预览，正在识别《${displayFileName}》的关键事实`
        : `未提取到稳定文本，正在结合原文件识别《${displayFileName}》`,
    );
    const result = await this.evidenceExtractor.extractPreparedJson(preparedFile, {
      model: resolveModel(this.config, "extract"),
      createSessionTitle: "[bridge] labor-material-extract",
      buildPrompt: ({ fileName, extractedText, localPath }) => buildLaborMaterialExtractPrompt(fileName, extractedText ?? "", localPath),
    });
    const extraction = {
      ...normalizeMaterialExtraction(result),
      sourceFileName: preparedFile.fileName,
    };
    cache.materials[fileHash] = extraction;
    await this.writeCache(cache);
    await onProgress?.(`《${displayFileName}》提取完成`);
    return {
      fileName: preparedFile.fileName,
      extraction,
      cached: false,
    };
  }

  /** 汇总多份材料，生成工作台 Markdown 和可选的飞书文档。 */
  async finalizeAnalysis(
    input: {
      extractedMaterials: LaborMaterialExtraction[];
      notes: string[];
      materialCount: number;
      warnings: string[];
      preferredTitle?: string | undefined;
    },
    options?: {
      onProgress?: ((step: string) => Promise<void> | void) | undefined;
      onWorkbenchPreviewCreated?: ((docUrl: string) => Promise<void> | void) | undefined;
    },
  ): Promise<LaborAnalyzeResult> {
    const onProgress = options?.onProgress;
    await onProgress?.("正在汇总证据链并识别争议焦点");
    const legalSupports = await this.queryKnowledgeSupports(input.extractedMaterials);
    const aggregateCacheKey = buildLaborCacheKey(JSON.stringify({
      extractedMaterials: input.extractedMaterials,
      notes: input.notes,
      legalSupports,
    }));
    const cache = await this.readCache();
    const cachedAggregate = cache.aggregates[aggregateCacheKey];
    const normalizedAggregate = cachedAggregate
      ? normalizeAggregateResult(cachedAggregate, legalSupports)
      : normalizeAggregateResult(await this.askAggregateJson(
        buildLaborAggregatePrompt(
          JSON.stringify(input.extractedMaterials, null, 2),
          input.notes.join("\n"),
          JSON.stringify(legalSupports, null, 2),
        ),
        resolveModel(this.config, "analyze"),
      ), legalSupports);
    if (cachedAggregate) {
      await onProgress?.("命中缓存，已复用历史证据链汇总结果");
    } else {
      cache.aggregates[aggregateCacheKey] = normalizedAggregate;
      await this.writeCache(cache);
    }

    if (input.preferredTitle?.trim()) {
      normalizedAggregate.caseTitle = input.preferredTitle.trim();
    }

    const title = normalizedAggregate.caseTitle || "劳动争议案件分析工作台";
    const markdown = renderLaborWorkbenchMarkdown(normalizedAggregate, input.materialCount, input.warnings, input.extractedMaterials);
    const workbench = await generateCaseWorkflowWorkbench({
      title,
      markdown,
      diagrams: buildLaborWorkbenchDiagrams(normalizedAggregate),
      logger: this.logger,
      logScope: "labor-skill",
      onProgress,
      onPreviewCreated: options?.onWorkbenchPreviewCreated,
    });
    const ledger = await this.syncEvidenceLedger(title, normalizedAggregate, onProgress);

    return {
      title,
      markdown,
      docUrl: workbench.docUrl,
      ledgerUrl: ledger?.ledgerUrl,
      keyEvidenceViewUrl: ledger?.keyEvidenceViewUrl,
      missingEvidenceViewUrl: ledger?.missingEvidenceViewUrl,
      syncedEvidenceCount: ledger?.syncedEvidenceCount ?? 0,
      syncedGapCount: ledger?.syncedGapCount ?? 0,
      extractedMaterials: input.extractedMaterials,
      aggregate: normalizedAggregate,
      warnings: input.warnings,
    };
  }

  // #endregion

  // #region 二审链路

  async finalizeAnalysisAndReview(
    input: {
      extractedMaterials: LaborMaterialExtraction[];
      notes: string[];
      materialCount: number;
      warnings: string[];
      preferredTitle?: string | undefined;
    },
    options?: {
      onProgress?: ((step: string) => Promise<void> | void) | undefined;
      authorityContext?: LaborReviewAuthorityContext | undefined;
    },
  ): Promise<{ result: LaborAnalyzeResult; reviewReport: LaborFinalReviewReport | null; reviewSkippedReason?: string }> {
    const onProgress = options?.onProgress;
    const result = await this.finalizeAnalysis(input, { onProgress });

    const reviewOutcome = await this.finalizeReviewOnly(result, options?.authorityContext, {
      onProgress: async (step) => await onProgress?.(`二审: ${step}`),
    });
    return { result, ...reviewOutcome };
  }

  /** 仅执行二审，不重复分析。供权威检索确认后二次调用。 */
  async finalizeReviewOnly(
    result: LaborAnalyzeResult,
    authorityContext?: LaborReviewAuthorityContext | undefined,
    options?: { onProgress?: ((step: string) => Promise<void> | void) | undefined },
  ): Promise<{ reviewReport: LaborFinalReviewReport | null; reviewSkippedReason?: string }> {
    const reviewModel = resolveModel(this.config, "review");
    const analyzeModel = resolveModel(this.config, "analyze");

    if (!reviewModel) {
      return { reviewReport: null, reviewSkippedReason: "review_skipped_no_config" };
    }
    if (analyzeModel && reviewModel.providerID === analyzeModel.providerID && reviewModel.modelID === analyzeModel.modelID) {
      return { reviewReport: null, reviewSkippedReason: "review_skipped_same_as_analyze" };
    }

    const effectiveContext = authorityContext ?? { status: "pending" as const };
    try {
      const reviewReport = await this.performFinalReview(result, effectiveContext, options);
      return { reviewReport };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("labor-skill", "review call failed", { detail }, "warn");
      return { reviewReport: null, reviewSkippedReason: "review_call_failed" };
    }
  }

  /** 将二审意见追加到工作台文档，便于律师在正文旁边直接复核。 */
  async appendReviewToWorkbench(result: LaborAnalyzeResult, reviewReport: LaborFinalReviewReport | null | undefined): Promise<string | undefined> {
    if (!result.docUrl) {
      return undefined;
    }
    const reviewMarkdown = renderLaborReviewAppendMarkdown(reviewReport);
    if (!reviewMarkdown) {
      return undefined;
    }
    try {
      const updated = await updateWorkbenchDocument(result.docUrl, result.title, [
        result.markdown.trim(),
        "",
        reviewMarkdown,
      ].join("\n"));
      return updated.docUrl ?? result.docUrl;
    } catch (error) {
      this.logger.log("labor-skill", "append review to workbench failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return undefined;
    }
  }

  private async performFinalReview(
    result: LaborAnalyzeResult,
    authorityContext: LaborReviewAuthorityContext,
    options?: { onProgress?: ((step: string) => Promise<void> | void) | undefined },
  ): Promise<LaborFinalReviewReport> {
    await options?.onProgress?.("正在执行二审模型");
    const prompt = buildLaborReviewPrompt(result, authorityContext);
    const reviewModel = resolveModel(this.config, "review");
    const session = await this.opencode.createSession("[bridge] labor-review");
    try {
      await options?.onProgress?.("正在等待二审模型返回");
      const response = await this.opencode.postMessageSync(session.id, buildPromptRequest(prompt, reviewModel));
      const parsed = parseJsonObject(extractAssistantText(response));
      return normalizeReviewReport(parsed);
    } finally {
      await this.opencode.deleteSession(session.id).catch((error) => {
        this.logger.log("labor-skill", "delete review session failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }
  }

  // #endregion

  // #region 内部辅助

  /** 用知识库为劳动争议风险点补充规则支撑。 */
  private async queryKnowledgeSupports(materials: LaborMaterialExtraction[]): Promise<Array<{ issue: string; rule: string; relation: string }>> {
    if (!this.knowledge) {
      return [];
    }
    const issueSeeds = materials
      .flatMap((item) => item.riskPoints.slice(0, 2))
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .slice(0, 3);
    const supports: Array<{ issue: string; rule: string; relation: string }> = [];
    for (const issue of issueSeeds) {
      try {
        const result = await this.knowledge.query(`劳动争议 ${issue}`);
        for (const candidate of result.results.slice(0, 2)) {
          supports.push({
            issue: redactEvidenceText(issue),
            rule: redactEvidenceText(candidate.question),
            relation: redactEvidenceText(candidate.answer.slice(0, 120)),
          });
        }
      } catch (error) {
        this.logger.log("labor-skill", "knowledge query skipped", {
          issue,
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      }
    }
    return supports;
  }

  private async syncEvidenceLedger(
    caseTitle: string,
    aggregate: LaborAggregateResult,
    onProgress?: ((step: string) => Promise<void> | void) | undefined,
  ) {
    const ledgerConfig = this.config.storage.evidenceLedger;
    if (!ledgerConfig?.appToken || !ledgerConfig.tableId) {
      return undefined;
    }

    await onProgress?.("正在同步证据台账与缺口视图");
    return await syncEvidenceLedger(this.resources, ledgerConfig, [
      ...aggregate.evidenceRows.map((row) => ({
        kind: "evidence" as const,
        caseTitle,
        disputeStage: aggregate.disputeStage,
        name: row.name,
        evidenceType: row.type,
        proves: row.proves,
        support: row.support,
        strength: row.strength,
        risk: row.risk,
        remarks: row.remarks,
        status: "已识别",
      })),
      ...aggregate.missingEvidence.map((item) => ({
        kind: "gap" as const,
        caseTitle,
        disputeStage: aggregate.disputeStage,
        name: item,
        proves: item,
        remarks: "来源：AI 证据链分析缺口提示",
        status: "待补充",
      })),
    ]);
  }

  /** 调用模型生成聚合分析 JSON。 */
  private async askAggregateJson(prompt: string, model?: OpenCodeModelRef): Promise<Record<string, unknown>> {
    const session = await this.opencode.createSession("[bridge] labor-analyze");
    try {
      const response = await this.opencode.postMessageSync(session.id, buildPromptRequest(prompt, model));
      return parseJsonObject(extractAssistantText(response));
    } finally {
      await this.opencode.deleteSession(session.id).catch((error) => {
        this.logger.log("labor-skill", "delete temp session failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }
  }

  /** 读取本地缓存；不存在时返回空缓存结构。 */
  private async readCache(): Promise<LaborSkillCacheFile> {
    try {
      const raw = await readFile(this.cacheFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LaborSkillCacheFile>;
      return {
        version: 1,
        materials: parsed.materials ?? {},
        aggregates: parsed.aggregates ?? {},
      };
    } catch {
      return {
        version: 1,
        materials: {},
        aggregates: {},
      };
    }
  }

  /** 写回材料提取与汇总分析缓存。 */
  private async writeCache(cache: LaborSkillCacheFile): Promise<void> {
    await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
    await writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2), "utf8");
  }

  // #endregion
}

/** 规范化单份材料提取结果，并统一做脱敏。 */
function normalizeMaterialExtraction(value: Record<string, unknown>): LaborMaterialExtraction {
  return {
    materialType: readString(value, "materialType") ?? "其他",
    summary: redactEvidenceText(readString(value, "summary") ?? ""),
    facts: readStringArray(value, "facts").map(redactEvidenceText),
    timelineEvents: readRecordArray(value, "timelineEvents").map((item) => omitUndefined({
      date: readString(item, "date"),
      event: redactEvidenceText(readString(item, "event") ?? ""),
      evidence: redactEvidenceText(readString(item, "evidence") ?? ""),
    })),
    evidenceRows: readRecordArray(value, "evidenceRows").map((item) => redactEvidenceRecord(omitUndefined({
      name: readString(item, "name") ?? "未命名证据",
      type: readString(item, "type"),
      proves: readString(item, "proves") ?? "",
      support: readString(item, "support"),
      strength: readString(item, "strength"),
      risk: readString(item, "risk"),
      remarks: readString(item, "remarks"),
    }))),
    riskPoints: readStringArray(value, "riskPoints").map(redactEvidenceText),
    missingEvidenceHints: readStringArray(value, "missingEvidenceHints").map(redactEvidenceText),
  };
}

/** 规范化聚合分析结果，并在缺失时回退到知识库支撑。 */
function normalizeAggregateResult(
  value: Record<string, unknown>,
  fallbackSupports: Array<{ issue: string; rule: string; relation: string }>,
): LaborAggregateResult {
  const legalSupports = readRecordArray(value, "legalSupports")
    .map((item) => ({
      issue: redactEvidenceText(readString(item, "issue") ?? ""),
      rule: redactEvidenceText(readString(item, "rule") ?? ""),
      relation: redactEvidenceText(readString(item, "relation") ?? ""),
    }))
    .filter((item) => item.issue || item.rule || item.relation);
  return {
    caseTitle: readString(value, "caseTitle") ?? "劳动争议案件分析工作台",
    disputeStage: readString(value, "disputeStage") ?? "仲裁前评估",
    summary: redactEvidenceText(readString(value, "summary") ?? ""),
    coreJudgment: readStringArray(value, "coreJudgment").map(redactEvidenceText),
    evidenceRows: readRecordArray(value, "evidenceRows").map((item) => redactEvidenceRecord(omitUndefined({
      name: readString(item, "name") ?? "未命名证据",
      type: readString(item, "type"),
      proves: readString(item, "proves") ?? "",
      support: readString(item, "support"),
      strength: readString(item, "strength"),
      risk: readString(item, "risk"),
      remarks: readString(item, "remarks"),
    }))),
    timeline: readRecordArray(value, "timeline").map((item) => omitUndefined({
      date: readString(item, "date"),
      event: redactEvidenceText(readString(item, "event") ?? ""),
      evidence: redactEvidenceText(readString(item, "evidence") ?? ""),
    })),
    issues: readRecordArray(value, "issues").map((item) => omitUndefined({
      issue: redactEvidenceText(readString(item, "issue") ?? ""),
      analysis: redactEvidenceText(readString(item, "analysis") ?? ""),
      riskLevel: readString(item, "riskLevel"),
    })),
    missingEvidence: readStringArray(value, "missingEvidence").map(redactEvidenceText),
    nextActions: readStringArray(value, "nextActions").map(redactEvidenceText),
    legalSupports: legalSupports.length > 0 ? legalSupports : fallbackSupports,
    keyIssues: readStringArray(value, "keyIssues").map(redactEvidenceText),
    claimBasis: readRecordArray(value, "claimBasis").map((item) => omitUndefined({
      claim: redactEvidenceText(readString(item, "claim") ?? "待明确请求项"),
      basis: redactEvidenceText(readString(item, "basis") ?? "需人工补核"),
      evidence: readStringArray(item, "evidence").map(redactEvidenceText),
      risk: redactEvidenceText(readString(item, "risk") ?? ""),
      reviewNote: redactEvidenceText(readString(item, "reviewNote") ?? ""),
    })),
    strategy: normalizeLaborStrategy(readRecord(value, "strategy")),
    draftDocuments: readRecordArray(value, "draftDocuments").map((item) => omitUndefined({
      type: redactEvidenceText(readString(item, "type") ?? "待定文书"),
      summary: redactEvidenceText(readString(item, "summary") ?? ""),
      content: redactEvidenceText(readString(item, "content") ?? ""),
    })),
  };
}

/** 把聚合结果渲染为飞书工作台 Markdown。 */
export function renderLaborWorkbenchMarkdown(
  result: LaborAggregateResult,
  materialCount: number,
  warnings: string[],
  materials: readonly LaborMaterialExtraction[] = [],
): string {
  const title = result.caseTitle || "劳动争议案件";
  const timelineDiagram = buildTimelineMermaid(result.timeline);
  const evidenceDiagram = buildEvidenceMapMermaid(result);
  const claimsDiagram = buildClaimsMindmapMermaid(result);
  const nextActionsDiagram = buildNextActionsFlowMermaid(result);
  const partyInfo = extractPartyInfoFromMaterials(materials);
  const lines: string[] = [
    `# ${title}｜证据链分析工作底稿`,
    "",
    `<callout emoji="📌" background-color="light-blue" border-color="light-blue">`,
    "",
    `**律师复核提示**：本工作底稿由 AI 根据已提交材料整理生成，仅用于案件分析、证据梳理和文书准备。事实认定、法律适用、诉请金额和提交版本必须由承办律师复核确认。`,
    "",
    "</callout>",
    "",
    "<grid cols=\"2\">",
    "",
    "  <column width=\"50\">",
    "    ### 案件总览",
    `    - 案件主题：${title}`,
    `    - 当前阶段：${redactEvidenceText(result.disputeStage)}`,
    `    - 风险等级：${renderOverallRisk(result.issues)}`,
    `    - 材料数量：${materialCount}`,
    `    - 当前结论：${redactEvidenceText(result.coreJudgment[0] ?? (result.summary || "待补充"))}`,
    "  </column>",
    "  <column width=\"50\">",
    "    ### 当前动作",
    ...renderIndentedBulletList(result.nextActions.slice(0, 4), "    "),
    "  </column>",
    "",
    "</grid>",
    "",
    ...(partyInfo.length > 0
      ? [
        "### 当事人信息",
        "",
        "> 本节来自当事人信息材料或材料中的身份字段，用于后续生成仲裁申请书、起诉状、证据清单等文书时引用；正式提交前仍需核对身份证号、地址、联系方式和主体名称。",
        "",
        ...renderBulletList(partyInfo),
        "",
      ]
      : []),
    ...(warnings.length > 0
      ? [
        `<callout emoji="⚠️" background-color="light-yellow" border-color="light-yellow">`,
        "",
        `处理提示：${warnings.map((item) => redactEvidenceText(item)).join("；")}`,
        "",
        "</callout>",
        "",
      ]
      : []),
    ...(result.missingEvidence.length > 0
      ? [
        `<callout emoji="🧩" background-color="light-yellow" border-color="light-yellow">`,
        "",
        `关键缺口：${redactEvidenceText(result.missingEvidence.slice(0, 3).join("；"))}`,
        "",
        "</callout>",
        "",
      ]
      : []),
    `<callout emoji="⚖️" background-color="light-red" border-color="light-red">`,
    "",
    "**法律依据复核提示**：法律依据仅可来自知识库命中、明确法条或承办律师确认的信息；如本节显示“需人工补核”，不得直接作为正式法律意见引用。",
    "",
    "</callout>",
    "",
    "### 核心判断",
    ...renderQuoteBlock(result.coreJudgment.length > 0 ? result.coreJudgment : [result.summary || "待补充核心判断"]),
    "",
    "### 可视化分析区",
    "",
    "以下图示按律师办案优先级排列，便于录屏时先看到核心成果。",
    "",
    "#### 1. 关键时间线图",
    "",
    "用于快速确认入职、履职、沟通、解除、仲裁准备等关键节点。",
    "",
    renderMermaidBlock(timelineDiagram),
    "",
    "#### 2. 证据关系图",
    "",
    "用于核对争议焦点、证明事实、现有证据和缺口是否形成闭环。",
    "",
    renderMermaidBlock(evidenceDiagram),
    "",
    "#### 3. 请求项结构图",
    "",
    "用于拆解仲裁请求、事实依据、证据支撑和待核实金额。",
    "",
    renderMermaidBlock(claimsDiagram),
    "",
    "#### 4. 补证流程图",
    "",
    "用于安排后续补证、发函、仲裁申请和律师复核动作。",
    "",
    renderMermaidBlock(nextActionsDiagram),
    "",
    "### 证据链总表",
    "",
    renderEvidenceTable(result.evidenceRows),
    "",
    "### 争议焦点",
    "",
    ...renderBulletList(result.keyIssues.length > 0 ? result.keyIssues : result.issues.map((item) => item.issue)),
    "",
    "### 请求权基础审核",
    "",
    renderClaimBasisTable(result.claimBasis, result.evidenceRows),
    "",
    "### 关键事实时间线",
    "",
    renderTimelineTable(result.timeline),
    "",
    "### 争议焦点与风险",
    "",
    "<quote-container>",
    "",
    ...renderIssueQuoteSections(result.issues),
    "",
    "</quote-container>",
    "",
    "### 法律依据与知识库支撑",
    "",
    "> 本节仅展示可辅助分析的规则线索。正式法律依据、裁判规则和适用结论必须由律师复核，不得凭空引用。",
    "",
    renderLegalSupportTable(result.legalSupports),
    "",
    "**法条引用风险**",
    ...renderBulletList(formatCitationReviewText(checkLaborLegalCitations(JSON.stringify(result)))),
    "",
    "### 策略与文书草稿摘要",
    "",
    "**诉讼/仲裁推进策略**",
    ...renderBulletList(result.strategy.litigation),
    "",
    "**调解谈判策略**",
    ...renderBulletList(result.strategy.mediation),
    "",
    "**庭审回应策略**",
    ...renderBulletList(result.strategy.response),
    "",
    "**文书草稿摘要**",
    ...renderDraftDocumentList(result.draftDocuments),
    "",
    "### 待补材料与下一步建议",
    "",
    "**待补材料**",
    ...renderBulletList(result.missingEvidence),
    "",
    "**下一步建议**",
    ...renderBulletList(result.nextActions),
    "",
    "### 人机分工与复核清单",
    "",
    "- AI 已完成：材料摘要、关键事实提取、证据链初步梳理、风险与缺口提示。",
    "- 律师需复核：事实真实性、证据原件、诉请金额、仲裁时效、法律依据和最终提交文本。",
    "- 输出限制：本底稿不构成正式法律意见，不能替代律师独立判断。",
  ];
  return lines.join("\n");
}

export function renderPkulawAuthorityAppendMarkdown(title: string, search: PkulawAuthoritySearchResult): string {
  const lines = [
    `### ${title}｜权威法规补充`,
    "",
    "> 本区块来自北大法宝 law-semantic 检索，只作为权威法规线索并列展示；不替换本地知识库结论，也未触发劳动分析二次生成。",
    "",
    `- 检索词：${redactEvidenceText(search.query || "未生成")}`,
    `- 检索状态：${localizePkulawStatus(search.status)}`,
    `- 耗时：${search.durationMs}ms`,
    "",
  ];
  if (search.items.length === 0) {
    lines.push(search.status === "timeout" ? "权威检索超时，原劳动分析报告仍可使用。" : ("message" in search ? search.message : "未检索到权威法规。"));
    return lines.join("\n");
  }
  lines.push(renderPkulawAuthorityTable(search.items));
  lines.push("");
  lines.push("### 需人工复核");
  lines.push("- 权威法规与本地知识库出现差异时，由承办律师判断适用版本和引用范围。");
  lines.push("- 法规时效性、地域适用和案件事实匹配度需人工复核。");
  return lines.join("\n");
}

function renderPkulawAuthorityTable(rows: PkulawAuthorityItem[]): string {
  const visible = rows.slice(0, 5);
  return [
    "<lark-table rows=\"" + (visible.length + 1) + "\" cols=\"4\" header-row=\"true\" column-widths=\"220,330,120,180\">",
    "",
    ...buildLarkTableRow(["法规/文件", "命中内容", "时效性", "来源"]),
    ...visible.flatMap((row) => buildLarkTableRow([
      row.title,
      row.excerpt,
      row.timeliness ?? "-",
      [row.sourceUpdatedAt ? `更新时间：${row.sourceUpdatedAt}` : "", row.url ?? ""].filter(Boolean).join("\n") || "-",
    ])),
    "</lark-table>",
  ].join("\n");
}

function localizePkulawStatus(status: PkulawAuthoritySearchResult["status"]): string {
  switch (status) {
    case "success":
      return "已检索";
    case "cache-hit":
      return "命中缓存";
    case "timeout":
      return "权威检索超时";
    case "disabled":
      return "pkulaw 未启用";
    case "empty":
      return "未检索到权威法规";
    case "error":
      return "权威检索不可用";
  }
}

function renderMermaidBlock(source: string): string {
  const trimmed = source.trim();
  return trimmed ? ["```mermaid", trimmed, "```"].join("\n") : "暂无可展示图示。";
}

function renderEvidenceTable(rows: LaborAggregateResult["evidenceRows"]): string {
  const visible = rows.length > 0 ? rows.slice(0, 8) : [{ name: "暂无", type: "-", proves: "-", support: "-", strength: "-", risk: "-", remarks: "-" }];
  const columnWidths = "130,110,210,110,120,190";
  const body = [
    "<lark-table rows=\"" + (visible.length + 1) + "\" cols=\"6\" header-row=\"true\" column-widths=\"" + columnWidths + "\">",
    "",
    ...buildLarkTableRow(["证据名称", "类型", "证明事实", "支持方向", "证明力", "风险/备注"]),
    ...visible.flatMap((row) => buildLarkTableRow([
      row.name,
      row.type ?? "-",
      row.proves,
      localizeSupport(row.support),
      localizeStrength(row.strength),
      [row.risk, row.remarks].filter(Boolean).join("；") || "-",
    ])),
    "</lark-table>",
  ];
  return body.join("\n");
}

function renderTimelineTable(rows: LaborAggregateResult["timeline"]): string {
  const visible = rows.length > 0 ? rows.slice(0, 8) : [{ date: "-", event: "暂无明确时间线", evidence: "-" }];
  const body = [
    "<lark-table rows=\"" + (visible.length + 1) + "\" cols=\"3\" header-row=\"true\" column-widths=\"180,320,220\">",
    "",
    ...buildLarkTableRow(["日期", "事件", "对应证据"]),
    ...visible.flatMap((row) => buildLarkTableRow([
      row.date ?? "-",
      row.event,
      row.evidence ?? "-",
    ])),
    "</lark-table>",
  ];
  return body.join("\n");
}

function renderIssueQuoteSections(rows: LaborAggregateResult["issues"]): string[] {
  if (rows.length === 0) {
    return ["### 争议焦点", "", "- 当前暂无明确争议焦点，需要人工补充。"];
  }
  return rows.slice(0, 4).flatMap((row, index) => [
    `### 争议焦点 ${index + 1}`,
    "",
    `- ${redactEvidenceText(row.issue)}`,
    `- 风险等级：${localizeRiskLevel(row.riskLevel)}`,
    `- 分析：${redactEvidenceText(row.analysis || "待补充分析")}`,
    "",
  ]);
}

function renderLegalSupportTable(rows: LaborAggregateResult["legalSupports"]): string {
  const visible = rows.length > 0 ? rows.slice(0, 6) : [{ issue: "暂无明确命中", rule: "当前未检索到明确依据", relation: "需人工补核" }];
  const body = [
    "<lark-table rows=\"" + (visible.length + 1) + "\" cols=\"3\" header-row=\"true\" column-widths=\"220,220,260\">",
    "",
    ...buildLarkTableRow(["争议点", "对应规则/知识点", "与本案关系"]),
    ...visible.flatMap((row) => buildLarkTableRow([
      row.issue,
      row.rule,
      row.relation,
    ])),
    "</lark-table>",
  ];
  return body.join("\n");
}

function renderClaimBasisTable(rows: LaborAggregateResult["claimBasis"], evidenceRows: LaborAggregateResult["evidenceRows"] = []): string {
  const visible = rows.length > 0
    ? rows.slice(0, 8)
    : [{ claim: "待明确请求项", basis: "需人工补核", evidence: [], risk: "待补充", reviewNote: "需人工复核" }];
  const body = [
    "<lark-table rows=\"" + (visible.length + 1) + "\" cols=\"5\" header-row=\"true\" column-widths=\"160,220,220,180,180\">",
    "",
    ...buildLarkTableRow(["请求项", "请求权基础", "证据支撑", "风险", "复核提示"]),
    ...visible.flatMap((row) => buildLarkTableRow([
      row.claim,
      row.basis,
      formatClaimEvidenceCell(row, evidenceRows),
      row.risk ?? "-",
      row.reviewNote ?? "-",
    ])),
    "</lark-table>",
  ];
  return body.join("\n");
}

function formatClaimEvidenceCell(row: ClaimBasisItem, evidenceRows: LaborAggregateResult["evidenceRows"]): string {
  const directEvidence = row.evidence.map((item) => item.trim()).filter(Boolean);
  if (directEvidence.length > 0) {
    return directEvidence.join("；");
  }
  const relatedEvidence = evidenceRows
    .filter((item) => isEvidenceRelatedToClaim(row, item))
    .map((item) => item.name.trim())
    .filter(Boolean);
  if (relatedEvidence.length > 0) {
    return [...new Set(relatedEvidence)].slice(0, 3).join("；");
  }
  return "未绑定具体证据，需回看证据链总表补核";
}

function isEvidenceRelatedToClaim(row: ClaimBasisItem, evidence: LaborAggregateResult["evidenceRows"][number]): boolean {
  const claimText = [row.claim, row.basis, row.risk ?? "", row.reviewNote ?? ""].join(" ");
  const evidenceText = [evidence.name, evidence.proves, evidence.risk ?? "", evidence.remarks ?? ""].join(" ");
  if (!claimText.trim() || !evidenceText.trim()) {
    return false;
  }
  return evidence.name.length > 1 && claimText.includes(evidence.name)
    || evidence.proves.length > 1 && claimText.includes(evidence.proves)
    || row.claim.length > 1 && evidenceText.includes(row.claim);
}

function renderDraftDocumentList(rows: LaborAggregateResult["draftDocuments"]): string[] {
  if (rows.length === 0) {
    return ["- 暂无文书草稿摘要；建议先补充事实与证据后再生成正式文书。"];
  }
  return rows.slice(0, 5).map((item) => `- ${redactEvidenceText(item.type)}：${redactEvidenceText(item.summary || "待补充摘要")}`);
}

export function extractPartyInfoFromMaterials(materials: readonly LaborMaterialExtraction[]): string[] {
  const lines: string[] = [];
  for (const material of materials) {
    const source = [material.sourceFileName, material.materialType, material.summary, ...material.facts].filter(Boolean).join("\n");
    if (!isPartyInfoMaterial(source)) {
      continue;
    }
    const label = material.sourceFileName || material.materialType || "当事人信息";
    const facts = material.facts.length > 0 ? material.facts.slice(0, 8).join("；") : material.summary;
    const line = `${label}：${facts}`.trim();
    if (line && !lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines.slice(0, 8);
}

function isPartyInfoMaterial(text: string): boolean {
  return /当事人信息|申请人|被申请人|委托人|对方当事人|身份证号|统一社会信用代码|联系电话|联系地址|住所地|法定代表人/.test(text);
}

function renderBulletList(items: string[]): string[] {
  if (items.length === 0) {
    return ["- 暂无"];
  }
  return items.map((item) => `- ${redactEvidenceText(item)}`);
}

function renderIndentedBulletList(items: string[], indent: string): string[] {
  if (items.length === 0) {
    return [`${indent}- 暂无`];
  }
  return items.map((item) => `${indent}- ${redactEvidenceText(item)}`);
}

function renderQuoteBlock(items: string[]): string[] {
  return items.flatMap((item, index) => index === items.length - 1
    ? [`> ${redactEvidenceText(item)}`]
    : [`> ${redactEvidenceText(item)}`, ">"]);
}

function buildLarkTableRow(values: string[]): string[] {
  return [
    "  <lark-tr>",
    ...values.flatMap((value) => [
      "    <lark-td>",
      `      ${escapeCell(value)}`,
      "    </lark-td>",
    ]),
    "  </lark-tr>",
  ];
}

function renderOverallRisk(issues: LaborAggregateResult["issues"]): string {
  const levels = issues.map((item) => (item.riskLevel ?? "").toLowerCase());
  if (levels.some((item) => item.includes("high") || item.includes("高"))) {
    return "高";
  }
  if (levels.some((item) => item.includes("medium") || item.includes("中"))) {
    return "中";
  }
  if (levels.some((item) => item.includes("low") || item.includes("低"))) {
    return "低";
  }
  return "中";
}

function localizeSupport(value?: string): string {
  switch ((value ?? "").toLowerCase()) {
    case "supports_worker":
      return "支持劳动者";
    case "supports_employer":
      return "支持用人单位";
    case "neutral":
      return "中性";
    default:
      return value?.trim() || "-";
  }
}

function localizeStrength(value?: string): string {
  switch ((value ?? "").toLowerCase()) {
    case "strong":
      return "强";
    case "medium":
      return "中";
    case "weak":
      return "弱";
    default:
      return value?.trim() || "-";
  }
}

function localizeRiskLevel(value?: string): string {
  switch ((value ?? "").toLowerCase()) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    default:
      return value?.trim() || "中";
  }
}

function buildPromptRequest(prompt: string, model?: OpenCodeModelRef): OpenCodePromptRequest {
  return model
    ? { model, parts: [{ type: "text", text: prompt }] }
    : { parts: [{ type: "text", text: prompt }] };
}

function buildPkulawCitationValidationParam(result: LaborAnalyzeResult): PkulawCitationValidationInput {
  const legalTextBlocks = [
    ...result.aggregate.legalSupports.flatMap((item) => [item.rule, item.relation]),
    ...result.aggregate.claimBasis.flatMap((item) => [item.basis, item.reviewNote ?? ""]),
    result.markdown,
  ].filter((item) => item.trim().length > 0);
  const seen = new Set<string>();
  const answerlaw: NonNullable<PkulawCitationValidationInput["answerlaw"]> = [];
  for (const block of legalTextBlocks) {
    for (const ref of extractLawArticleRefs(block)) {
      const key = `${ref.title}#${ref.article_number}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      answerlaw.push({
        ...ref,
        text: block.slice(0, 500),
      });
    }
  }
  return {
    answerlaw: answerlaw.slice(0, 12),
    prompt: [
      result.aggregate.caseTitle,
      result.aggregate.summary,
      ...result.aggregate.keyIssues.slice(0, 5),
    ].filter(Boolean).join("\n").slice(0, 1200),
  };
}

function buildPkulawSourceText(result: LaborAnalyzeResult): string {
  return [
    result.aggregate.caseTitle,
    result.aggregate.summary,
    ...result.aggregate.keyIssues,
    ...result.aggregate.issues.flatMap((item) => [item.issue, item.analysis]),
    ...result.aggregate.claimBasis.flatMap((item) => [item.claim, item.basis, item.reviewNote ?? ""]),
    ...result.aggregate.legalSupports.flatMap((item) => [item.issue, item.rule, item.relation]),
  ].filter((item) => item.trim().length > 0).join("\n").slice(0, 6000);
}

function extractLawArticleRefs(text: string): Array<{ title: string; article_number: string }> {
  const refs: Array<{ title: string; article_number: string }> = [];
  const pattern = /《([^》]{2,80})》\s*第?\s*([一二三四五六七八九十百千万零〇\d]+)\s*条/g;
  for (const match of text.matchAll(pattern)) {
    const title = match[1]?.trim();
    const article = match[2]?.trim();
    if (title && article) {
      refs.push({ title, article_number: article });
    }
  }
  return refs;
}

function resolveModel(config: LaborSkillConfig, step: "extract" | "analyze" | "review"): OpenCodeModelRef | undefined {
  const normalized = (config.models[step] ?? config.models.default)?.trim();
  if (!normalized) {
    return undefined;
  }
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return {
    providerID: normalized.slice(0, slashIndex),
    modelID: normalized.slice(slashIndex + 1),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readString(value: Record<string, unknown> | null, key: string): string | undefined {
  if (!value) return undefined;
  const target = value[key];
  return typeof target === "string" && target.trim() ? target.trim() : undefined;
}

function readStringArray(value: Record<string, unknown> | null, key: string): string[] {
  if (!value) return [];
  const target = value[key];
  if (!Array.isArray(target)) {
    return [];
  }
  return target.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function readRecordArray(value: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  if (!value) return [];
  const target = value[key];
  if (!Array.isArray(target)) {
    return [];
  }
  return target.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function readRecord(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!value) return null;
  const target = value[key];
  return target && typeof target === "object" && !Array.isArray(target)
    ? target as Record<string, unknown>
    : null;
}

function normalizeLaborStrategy(value: Record<string, unknown> | null): LaborAggregateResult["strategy"] {
  return {
    litigation: readStringArray(value, "litigation").map(redactEvidenceText),
    mediation: readStringArray(value, "mediation").map(redactEvidenceText),
    response: readStringArray(value, "response").map(redactEvidenceText),
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function formatLaborReviewFindingText(finding: Pick<LaborFinalReviewReport["findings"][number], "message" | "relatedSection" | "type" | "source">): string {
  const original = finding.message.replace(/\s+/g, " ").trim();
  let text = original
    .replace(/marked as ['"]需人工补核['"] with no legal source provided\s*[—-]\s*source\.type is null.*$/i, "缺少可核验来源，已标记为“需人工补核”，需要人工复核。")
    .replace(/flagged as ['"]需人工复核['"] in 法条引用风险;?\s*no individual article verification in 修正生成幻觉 results?/i, "在法条引用风险中被标记为“需人工复核”，本次未完成逐条校验。")
    .replace(/only whole-law identification available via 法条识别与溯源,?\s*specific articles not individually verified in 修正生成幻觉/i, "目前只有法规名称识别，具体条文尚未逐条校验。")
    .replace(/which is not individually verified in 修正生成幻觉;?\s*only 第([^\s，。；;]+)条 is verified/i, "本次未完成逐条校验，仅校验到第$1条。")
    .replace(/\s+relies on\s+/i, "引用")
    .replace(/\s+cites\s+/i, "引用")
    .replace(/\s+cited for\s+/i, "被用于支撑")
    .replace(/\s+claim\s+/i, "请求")
    .replace(/no individual article verification in 修正生成幻觉 results?/i, "本次未完成逐条校验。")
    .replace(/source\.type is null.*$/i, "来源为空，需要人工复核。")
    .replace(/\s*[—-]\s*/g, "；")
    .replace(/\s+/g, " ")
    .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2")
    .trim();

  if (!text) {
    text = fallbackReviewFindingText(finding);
  }
  const section = finding.relatedSection?.trim();
  return section ? `${section}：${text}` : text;
}

export function renderLaborReviewAppendMarkdown(reviewReport: LaborFinalReviewReport | null | undefined): string {
  if (!reviewReport || reviewReport.findings.length === 0) {
    return "";
  }
  const groups = groupReviewFindingsForMarkdown(reviewReport);
  const sections = [
    renderReviewRiskCallout("高风险问题", "high", groups.high),
    renderReviewRiskCallout("中风险问题", "medium", groups.medium),
    renderReviewRiskCallout("低风险问题", "low", groups.low),
  ].filter(Boolean);
  if (sections.length === 0) {
    return "";
  }
  return [
    "### 二次审查意见",
    "",
    "> 以下意见由二审模型与法条校验生成，用于定位需要人工复核的结论、依据和引用位置。",
    "",
    ...sections,
  ].join("\n");
}

function groupReviewFindingsForMarkdown(reviewReport: LaborFinalReviewReport): Record<"high" | "medium" | "low", string[]> {
  const groups = {
    high: [] as string[],
    medium: [] as string[],
    low: [] as string[],
  };
  for (const finding of reviewReport.findings) {
    groups[finding.severity].push(formatLaborReviewFindingText(finding));
  }
  return groups;
}

function renderReviewRiskCallout(
  title: string,
  severity: "high" | "medium" | "low",
  findings: readonly string[],
): string {
  if (findings.length === 0) {
    return "";
  }
  const style = severity === "high"
    ? { emoji: "🔴", color: "light-red" }
    : severity === "medium"
      ? { emoji: "🔵", color: "light-blue" }
      : { emoji: "🟢", color: "light-green" };
  return [
    `<callout emoji="${style.emoji}" background-color="${style.color}" border-color="${style.color}">`,
    "",
    `**${title}（${findings.length}项）**`,
    "",
    ...findings.map((item, index) => `${index + 1}. ${redactEvidenceText(item)}`),
    "",
    "</callout>",
    "",
  ].join("\n");
}

function fallbackReviewFindingText(finding: Pick<LaborFinalReviewReport["findings"][number], "type" | "source">): string {
  const sourceText = finding.source.type === null
    ? "来源为空"
    : `来源类型：${finding.source.type}`;
  return `${localizeReviewFindingType(finding.type)}，${sourceText}，需要人工复核。`;
}

function localizeReviewFindingType(type: string): string {
  switch (type) {
    case "missing_authority":
      return "缺少权威依据";
    case "null_source":
      return "缺少来源字段";
    case "citation":
      return "法条引用需要复核";
    case "unsupported_claim":
      return "请求项缺少支撑";
    default:
      return type ? `审查项 ${type}` : "相关结论需要复核";
  }
}

function buildLaborWorkbenchDiagrams(result: LaborAggregateResult) {
  return [
    { source: buildTimelineMermaid(result.timeline) },
    { source: buildEvidenceMapMermaid(result) },
    { source: buildClaimsMindmapMermaid(result) },
    { source: buildNextActionsFlowMermaid(result) },
  ];
}

function buildEvidenceMapMermaid(result: LaborAggregateResult): string {
  const issues = result.issues.slice(0, 3);
  if (issues.length === 0) {
    return "flowchart TD\n    I1[\"暂无明确争议焦点\"]";
  }
  const lines = ["flowchart TD"];
  issues.forEach((issue, issueIndex) => {
    const issueId = `I${issueIndex + 1}`;
    lines.push(`    ${issueId}["${escapeMermaidLabel(issue.issue)}"]`);
    const relatedRows = result.evidenceRows
      .filter((row) => row.proves.includes(issue.issue) || (row.risk ?? "").includes(issue.issue))
      .slice(0, 3);
    relatedRows.forEach((row, rowIndex) => {
      const evidenceId = `E${issueIndex + 1}${rowIndex + 1}`;
      lines.push(`    ${issueId} --> ${evidenceId}["${escapeMermaidLabel(row.name)}"]`);
    });
    if (relatedRows.length === 0) {
      const gapId = `G${issueIndex + 1}`;
      lines.push(`    ${issueId} --> ${gapId}["缺口：待补证据"]`);
    }
  });
  return lines.join("\n");
}

function buildClaimsMindmapMermaid(result: LaborAggregateResult): string {
  const root = escapeMermaidLabel(result.caseTitle || "劳动争议案件分析");
  const issues = result.issues.slice(0, 4);
  const lines = ["mindmap", `  root((${root}))`];
  if (issues.length === 0) {
    lines.push("    核心判断");
    result.coreJudgment.slice(0, 3).forEach((item) => {
      lines.push(`      ${escapeMermaidLabel(item)}`);
    });
    return lines.join("\n");
  }
  issues.forEach((issue) => {
    lines.push(`    ${escapeMermaidLabel(issue.issue)}`);
    lines.push(`      ${escapeMermaidLabel(issue.analysis || "待补充分析")}`);
  });
  return lines.join("\n");
}

function buildNextActionsFlowMermaid(result: LaborAggregateResult): string {
  const actions = result.nextActions.length > 0 ? result.nextActions : ["补充关键证据", "复核争议焦点", "形成提交版本"];
  const lines = ["flowchart TD"];
  actions.slice(0, 6).forEach((action, index) => {
    const nodeId = `A${index + 1}`;
    lines.push(`    ${nodeId}["${escapeMermaidLabel(action)}"]`);
    if (index > 0) {
      lines.push(`    A${index} --> ${nodeId}`);
    }
  });
  return lines.join("\n");
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      next[key] = item;
    }
  }
  return next as T;
}

function normalizeReviewReport(value: Record<string, unknown>): LaborFinalReviewReport {
  const rawStatus = readString(value, "status") ?? "needs_human_review";
  const modelStatus: LaborFinalReviewReport["status"] =
    rawStatus === "pass" || rawStatus === "needs_revision" ? rawStatus : "needs_human_review";

  const rawFindings = readRecordArray(value, "findings");
  const findings: LaborFinalReviewReport["findings"] = rawFindings.map((item): LaborFinalReviewReport["findings"][number] => {
    const rawRelated: string | undefined = readString(item, "relatedSection");
    return {
      severity: normalizeSeverity(readString(item, "severity")),
      type: readString(item, "type") ?? "unknown",
      message: readString(item, "message") ?? "",
      ...(rawRelated !== undefined ? { relatedSection: rawRelated } : {}),
      source: normalizeSourceRef(item),
    };
  });

  const authorityCoverage: LaborFinalReviewReport["authorityCoverage"] = readRecordArray(value, "authorityCoverage").map((item): LaborFinalReviewReport["authorityCoverage"][number] => ({
    issue: readString(item, "issue") ?? "",
    status: normalizeAuthorityStatus(readString(item, "status")),
    source: normalizeSourceRef(item),
  }));

  const warnings: LaborFinalReviewReport["warnings"] = readRecordArray(value, "warnings").map((item): LaborFinalReviewReport["warnings"][number] => ({
    code: readString(item, "code") ?? "unknown",
    message: readString(item, "message") ?? "",
  }));
  const hasNullSource = findings.some((item) => item.source.type === null)
    || authorityCoverage.some((item) => item.source.type === null);

  // 硬依据检查：authority 或 local_kb:article
  const hasHardEvidence = findings.some((item) => item.source.type === "authority" || item.source.type === "local_kb:article")
    || authorityCoverage.some((item) => item.source.type === "authority" || item.source.type === "local_kb:article");

  // 如果模型说 pass 但没有硬依据，降级为 needs_revision
  let finalStatus = hasNullSource ? "needs_human_review" : modelStatus;
  if (finalStatus === "pass" && !hasHardEvidence) {
    finalStatus = "needs_revision";
  }

  return {
    status: finalStatus,
    findings,
    unsupportedClaims: readStringArray(value, "unsupportedClaims"),
    authorityCoverage,
    suggestedEdits: readStringArray(value, "suggestedEdits"),
    warnings,
  };
}

function normalizeSeverity(value: string | undefined): "low" | "medium" | "high" {
  switch ((value ?? "").toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

function normalizeAuthorityStatus(value: string | undefined): "sufficient" | "partial" | "missing" | "skipped" {
  switch (value) {
    case "sufficient":
    case "partial":
    case "missing":
    case "skipped":
      return value;
    default:
      return "missing";
  }
}

/** type 白名单，不在此范围内的值归为 { type: null } 触发 needs_human_review。 */
const VALID_SOURCE_TYPES = new Set<string>([
  "material",
  "local_kb",
  "local_kb:article",
  "local_kb:digest",
  "local_kb:reflow",
  "local_kb:practice",
  "authority",
]);

function normalizeSourceRef(item: Record<string, unknown>): SourceRef {
  const rawSource = item["source"];
  if (!rawSource || typeof rawSource !== "object") {
    return { type: null };
  }
  const source = rawSource as Record<string, unknown>;
  const typeValue = readString(source, "type");
  const refValue = readString(source, "ref");
  if (!typeValue || !VALID_SOURCE_TYPES.has(typeValue)) {
    return { type: null, ...(refValue !== undefined ? { ref: refValue } : {}) } as SourceRef;
  }
  // 旧 local_kb 兼容映射
  if (typeValue === "local_kb") {
    return { type: "local_kb:practice", ...(refValue !== undefined ? { ref: refValue } : {}) } as SourceRef;
  }
  return { type: typeValue as SourceRef["type"], ...(refValue !== undefined ? { ref: refValue } : {}) } as SourceRef;
}

function getLaborMaterialInputFileName(file: LaborMaterialInput): string {
  if ("fileName" in file && file.fileName?.trim()) {
    return file.fileName.trim();
  }
  if ("localPath" in file) {
    return path.basename(file.localPath);
  }
  return "未命名材料";
}

function extensionToMimeType(extension: string): string {
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function buildLaborCacheKey(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
