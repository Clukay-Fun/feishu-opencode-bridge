import type { AppConfig } from "../config/schema.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import { parseKnowledgeFile } from "../knowledge/parser.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import { buildLaborCaseAnalysisPrompt, buildLaborMaterialExtractionPrompt } from "./prompts.js";
import { buildLaborDocTitle, buildLaborEvidenceMapMermaid, buildLaborTimelineMermaid, renderLaborAnalysisMarkdown } from "./renderer.js";
import type {
  LaborAnalysisReport,
  LaborAnalysisResult,
  LaborAnalyzeOptions,
  LaborCaseContext,
  LaborDownloadedMaterial,
  LaborFailedMaterial,
  LaborKnowledgeSupport,
  LaborMaterialExtraction,
  LaborMaterialInput,
  LaborOpenCodePort,
  LaborParsedMaterial,
  LaborProgressUpdate,
} from "./types.js";

type LaborResourcePort = {
  downloadMessageResource(messageId: string, fileKey: string, type: "file"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
};

export class LaborSkillService {
  constructor(
    private readonly config: AppConfig,
    private readonly resources: LaborResourcePort,
    private readonly opencode: LaborOpenCodePort,
    private readonly knowledge: KnowledgeBasePort,
  ) {}

  async analyze(
    materials: LaborMaterialInput[],
    context: LaborCaseContext,
    options?: LaborAnalyzeOptions,
  ): Promise<LaborAnalysisResult> {
    await this.reportProgress(options, { step: "parse", status: "running", detail: `正在解析材料（0/${materials.length}）` });
    const parsed = await this.parseMaterials(materials, options);
    if (parsed.items.length === 0) {
      await this.reportProgress(options, { step: "parse", status: "error", detail: "全部材料解析失败" });
      throw new LaborAnalysisAllMaterialsFailedError(parsed.failed);
    }
    await this.reportProgress(options, { step: "parse", status: "completed", detail: `已解析 ${parsed.items.length} 份材料` });

    await this.reportProgress(options, { step: "extract", status: "running", detail: `正在提取材料信息（0/${parsed.items.length}）` });
    const extracted = await this.extractMaterials(parsed.items, options);
    if (extracted.items.length === 0) {
      await this.reportProgress(options, { step: "extract", status: "error", detail: "全部材料提取失败" });
      throw new LaborAnalysisAllMaterialsFailedError([...parsed.failed, ...extracted.failed]);
    }
    await this.reportProgress(options, { step: "extract", status: "completed", detail: `已提取 ${extracted.items.length} 份材料` });

    await this.reportProgress(options, { step: "analyze", status: "running", detail: "正在聚合案件证据链" });
    const report = await this.analyzeCase(context, extracted.items);
    await this.reportProgress(options, { step: "analyze", status: "completed", detail: "已形成案件分析" });

    await this.reportProgress(options, { step: "knowledge", status: "running", detail: "正在查询劳动法知识库" });
    const supports = await this.enrichWithKnowledge(report);
    await this.reportProgress(options, { step: "knowledge", status: "completed", detail: `已补强 ${supports.length} 个争议点` });

    const failedMaterials = [...parsed.failed, ...extracted.failed];
    const markdown = renderLaborAnalysisMarkdown({ report, supports, failedMaterials });
    const docTitle = buildLaborDocTitle(report);
    const timelineWhiteboardMermaid = buildLaborTimelineMermaid(report);
    const evidenceMapWhiteboardMermaid = buildLaborEvidenceMapMermaid(report);
    return { report, markdown, docTitle, timelineWhiteboardMermaid, evidenceMapWhiteboardMermaid, supports, failedMaterials };
  }

  private async parseMaterials(
    materials: LaborMaterialInput[],
    options?: LaborAnalyzeOptions,
  ): Promise<{ items: LaborParsedMaterial[]; failed: LaborFailedMaterial[] }> {
    const items: LaborParsedMaterial[] = [];
    const failed: LaborFailedMaterial[] = [];
    let completed = 0;
    await runWithConcurrency(materials, getLaborConfig(this.config).ingest.concurrency, async (material) => {
      try {
        const downloaded = await this.downloadMaterial(material);
        this.validateMaterial(downloaded.sourceFile, downloaded.buffer.byteLength);
        const parsed = await parseKnowledgeFile(downloaded.sourceFile, downloaded.buffer);
        items.push({
          ...downloaded,
          markdown: parsed.normalizedMarkdown,
          parserUsed: parsed.parserUsed,
        });
      } catch (error) {
        failed.push({ sourceFile: material.sourceFile, reason: normalizeError(error) });
      } finally {
        completed += 1;
        await this.reportProgress(options, {
          step: "parse",
          status: "running",
          detail: `正在解析材料（${completed}/${materials.length}）`,
        });
      }
    });
    return { items, failed };
  }

  private async extractMaterials(
    materials: LaborParsedMaterial[],
    options?: LaborAnalyzeOptions,
  ): Promise<{ items: LaborMaterialExtraction[]; failed: LaborFailedMaterial[] }> {
    const items: LaborMaterialExtraction[] = [];
    const failed: LaborFailedMaterial[] = [];
    let completed = 0;
    await runWithConcurrency(materials, getLaborConfig(this.config).ingest.concurrency, async (material) => {
      try {
        items.push(await this.extractMaterial(material));
      } catch (error) {
        failed.push({ sourceFile: material.sourceFile, reason: normalizeError(error) });
      } finally {
        completed += 1;
        await this.reportProgress(options, {
          step: "extract",
          status: "running",
          detail: `正在提取材料信息（${completed}/${materials.length}）`,
        });
      }
    });
    return { items, failed };
  }

  private async downloadMaterial(material: LaborMaterialInput): Promise<LaborDownloadedMaterial> {
    const downloaded = await this.resources.downloadMessageResource(material.messageId, material.fileKey, "file");
    return {
      ...material,
      sourceFile: downloaded.fileName || material.sourceFile,
      mimeType: downloaded.mimeType,
      buffer: downloaded.buffer,
    };
  }

  private async extractMaterial(material: LaborParsedMaterial): Promise<LaborMaterialExtraction> {
    const text = await this.runLaborPrompt(
      "[bridge] labor-material-extract",
      buildLaborMaterialExtractionPrompt({
        sourceFile: material.sourceFile,
        materialMarkdown: material.markdown,
      }),
      resolveLaborModel(this.config, "extract"),
    );
    return normalizeMaterialExtraction(parseJsonObject(text), material.sourceFile);
  }

  private async analyzeCase(
    context: LaborCaseContext,
    materialExtractions: LaborMaterialExtraction[],
  ): Promise<LaborAnalysisReport> {
    const text = await this.runLaborPrompt(
      "[bridge] labor-case-analyze",
      buildLaborCaseAnalysisPrompt({ caseContext: context, materialExtractions }),
      resolveLaborModel(this.config, "analyze"),
    );
    return normalizeAnalysisReport(parseJsonObject(text), context.caseTitle, materialExtractions.length);
  }

  private async enrichWithKnowledge(report: LaborAnalysisReport): Promise<LaborKnowledgeSupport[]> {
    const issues = report.issues.filter((issue) => issue.knowledgeQuery.trim()).slice(0, 3);
    const supports: LaborKnowledgeSupport[] = [];
    for (const issue of issues) {
      const result = await this.knowledge.query(issue.knowledgeQuery).catch(() => ({
        question: issue.knowledgeQuery,
        results: [],
      }));
      supports.push({ issue: issue.issue, query: issue.knowledgeQuery, result });
    }
    return supports;
  }

  private async runLaborPrompt(sessionTitle: string, prompt: string, model?: string | undefined): Promise<string> {
    const session = await this.opencode.createSession(sessionTitle);
    try {
      const response = await this.opencode.postMessageSync(session.id, {
        ...(model ? { model: parseOpenCodeModelRef(model) } : {}),
        parts: [{ type: "text", text: prompt }],
      });
      const text = extractAssistantText(response as Parameters<typeof extractAssistantText>[0]);
      if (!text.trim()) {
        throw new Error("OpenCode 未返回可用内容");
      }
      return text;
    } finally {
      await this.opencode.deleteSession(session.id).catch(() => false);
    }
  }

  private validateMaterial(fileName: string, sizeBytes: number): void {
    const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    const laborConfig = getLaborConfig(this.config);
    if (!laborConfig.ingest.allowedExtensions.includes(extension)) {
      throw new Error(`仅支持 ${laborConfig.ingest.allowedExtensions.join(" / ")} 文件`);
    }
    const maxSizeBytes = laborConfig.ingest.maxFileSizeMb * 1024 * 1024;
    if (sizeBytes > maxSizeBytes) {
      throw new Error(`文件过大，请控制在 ${laborConfig.ingest.maxFileSizeMb}MB 以内`);
    }
  }

  private async reportProgress(options: LaborAnalyzeOptions | undefined, update: LaborProgressUpdate): Promise<void> {
    await options?.onProgress?.(update);
  }
}

export class LaborAnalysisAllMaterialsFailedError extends Error {
  constructor(readonly failedMaterials: LaborFailedMaterial[]) {
    super("全部劳动案件材料解析或提取失败");
  }
}

function resolveLaborModel(config: AppConfig, step: "extract" | "analyze" | "render"): string | undefined {
  return getLaborConfig(config).models[step]
    ?? config.knowledgeBase.models.extract
    ?? config.knowledgeBase.models.default;
}

function getLaborConfig(config: AppConfig): NonNullable<AppConfig["laborSkill"]> {
  return config.laborSkill ?? {
    enabled: false,
    models: {},
    ingest: {
      allowedExtensions: [".pdf", ".docx", ".txt", ".md"],
      maxFileSizeMb: 20,
      pendingTtlMs: 600_000,
      concurrency: 3,
    },
  };
}

function parseOpenCodeModelRef(value: string): { providerID: string; modelID: string } {
  const [providerID, ...modelParts] = value.split("/");
  return { providerID: providerID ?? "", modelID: modelParts.join("/") };
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    }
  }
  throw new Error("模型未返回 JSON 对象");
}

function normalizeMaterialExtraction(value: Record<string, unknown>, sourceFile: string): LaborMaterialExtraction {
  return {
    sourceFile: readString(value, "sourceFile") || sourceFile,
    materialType: readEnum(value, "materialType", ["contract", "payroll", "attendance", "chat", "notice", "resignation", "arbitration", "other"], "other"),
    summary: readString(value, "summary"),
    facts: readRecordArray(value, "facts").map((item) => ({
      fact: readString(item, "fact"),
      sourceLocation: readString(item, "sourceLocation") || "unknown",
      confidence: readEnum(item, "confidence", ["high", "medium", "low"], "medium"),
    })),
    timelineEvents: readRecordArray(value, "timelineEvents").map((item) => ({
      date: readString(item, "date"),
      event: readString(item, "event"),
      sourceLocation: readString(item, "sourceLocation") || "unknown",
      confidence: readEnum(item, "confidence", ["high", "medium", "low"], "medium"),
    })),
    evidenceRows: readEvidenceRows(value, "evidenceRows"),
    contractRisks: readRecordArray(value, "contractRisks").map((item) => ({
      clauseOrContent: readString(item, "clauseOrContent"),
      risk: readString(item, "risk"),
      possibleConsequence: readString(item, "possibleConsequence"),
      suggestion: readString(item, "suggestion"),
    })),
    riskPoints: readStringArray(value, "riskPoints"),
    missingEvidenceHints: readStringArray(value, "missingEvidenceHints"),
  };
}

function normalizeAnalysisReport(value: Record<string, unknown>, fallbackTitle: string | undefined, materialCount: number): LaborAnalysisReport {
  const summary = readRecord(value, "summary");
  return {
    caseTitle: readString(value, "caseTitle") || fallbackTitle || `劳动争议案件分析工作台 ${new Date().toISOString().slice(0, 10)}`,
    disputeStage: readEnum(value, "disputeStage", ["咨询中", "仲裁前", "仲裁中", "诉讼中", "未知"], "未知"),
    summary: {
      materialCount: readNumber(summary, "materialCount") || materialCount,
      currentConclusion: readString(summary, "currentConclusion"),
      riskLevel: readEnum(summary, "riskLevel", ["high", "medium", "low", "unknown"], "unknown"),
      recommendedAction: readString(summary, "recommendedAction"),
    },
    coreJudgment: readStringArray(value, "coreJudgment"),
    evidenceRows: readEvidenceRows(value, "evidenceRows"),
    timeline: readRecordArray(value, "timeline").map((item) => ({
      date: readString(item, "date"),
      event: readString(item, "event"),
      evidence: readString(item, "evidence"),
      confidence: readEnum(item, "confidence", ["high", "medium", "low"], "medium"),
    })),
    issues: readRecordArray(value, "issues").map((item) => ({
      issue: readString(item, "issue"),
      proofBurden: readString(item, "proofBurden"),
      supportingEvidence: readStringArray(item, "supportingEvidence"),
      weakness: readString(item, "weakness"),
      riskLevel: readEnum(item, "riskLevel", ["high", "medium", "low"], "medium"),
      knowledgeQuery: readString(item, "knowledgeQuery"),
    })),
    riskItems: readRecordArray(value, "riskItems").map((item) => ({
      item: readString(item, "item"),
      reason: readString(item, "reason"),
      possibleConsequence: readString(item, "possibleConsequence"),
      suggestion: readString(item, "suggestion"),
    })),
    missingEvidence: readRecordArray(value, "missingEvidence").map((item) => ({
      evidence: readString(item, "evidence"),
      whyNeeded: readString(item, "whyNeeded"),
      priority: readEnum(item, "priority", ["high", "medium", "low"], "medium"),
    })),
    nextActions: readStringArray(value, "nextActions"),
  };
}

function readEvidenceRows(value: Record<string, unknown>, key: string): LaborMaterialExtraction["evidenceRows"] {
  return readRecordArray(value, key).map((item) => ({
    evidenceName: readString(item, "evidenceName"),
    evidenceType: readString(item, "evidenceType") || "其他",
    proves: readString(item, "proves"),
    supportDirection: readEnum(item, "supportDirection", ["supports_worker", "supports_employer", "neutral", "unclear"], "unclear"),
    probativeStrength: readEnum(item, "probativeStrength", ["strong", "medium", "weak"], "medium"),
    riskOrGap: readString(item, "riskOrGap"),
    note: readString(item, "note"),
  }));
}

function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : {};
}

function readRecordArray(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate.filter(isRecord) : [];
}

function readString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function readStringArray(value: Record<string, unknown>, key: string): string[] {
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function readEnum<const T extends string>(value: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const candidate = value[key];
  return typeof candidate === "string" && (allowed as readonly string[]).includes(candidate) ? candidate as T : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
