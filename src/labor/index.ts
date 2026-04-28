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
import type { DocumentParserOptions } from "../document-pipeline/index.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeModelRef, OpenCodePromptRequest } from "../opencode/client.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import { redactEvidenceRecord, redactEvidenceText } from "../runtime/sanitize.js";
import {
  EvidenceExtractService,
  type EvidenceExtractResourcePort,
  type EvidenceFileRef,
} from "../workflows/evidence-extract.js";
import { syncEvidenceLedger, type EvidenceLedgerResourcePort } from "../workflows/evidence-ledger.js";
import { generateCaseWorkflowWorkbench } from "../workflows/case-workflow.js";
import { buildTimelineMermaid, escapeMermaidLabel } from "../workflows/timeline-build.js";
import { buildLaborAggregatePrompt, buildLaborMaterialExtractPrompt } from "./prompts.js";

type OpenCodePort = Pick<OpenCodeClient, "createSession" | "postMessageSync" | "deleteSession">;
type LaborSkillResourcePort = EvidenceExtractResourcePort & EvidenceLedgerResourcePort;

export type LaborMaterialExtraction = {
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

export type LaborMaterialExtractResult = {
  fileName: string;
  extraction: LaborMaterialExtraction;
  cached: boolean;
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
    parserOptions?: DocumentParserOptions | undefined,
  ) {
    this.evidenceExtractor = new EvidenceExtractService(resources, opencode, logger, parserOptions);
    this.cacheFilePath = path.join(dataDir, "labor-skill-cache.json");
  }

  // #region 对外分析入口

  /** 执行完整劳动分析流程：逐份提取后再统一汇总。 */
  async analyze(
    files: EvidenceFileRef[],
    notes: string[],
    options?: { onProgress?: ((step: string) => Promise<void> | void) | undefined },
  ): Promise<LaborAnalyzeResult> {
    const onProgress = options?.onProgress;
    const extractedMaterials: LaborMaterialExtraction[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      try {
        const extracted = await this.extractMaterial(file, {
          onProgress,
        });
        extractedMaterials.push(extracted.extraction);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const warning = `已跳过《${file.fileName}》：${detail}`;
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
      materialCount: files.length,
      warnings,
    }, { onProgress });
  }

  /** 提取单份材料中的事实、证据和风险信息。 */
  async extractMaterial(
    file: EvidenceFileRef,
    options?: { onProgress?: ((step: string) => Promise<void> | void) | undefined },
  ): Promise<LaborMaterialExtractResult> {
    const onProgress = options?.onProgress;
    await onProgress?.(`准备解析《${file.fileName}》`);
    const preparedFile = await this.evidenceExtractor.prepareFile(file, {
      allowedExtensions: this.config.ingest.allowedExtensions,
      maxFileSizeMb: this.config.ingest.maxFileSizeMb,
      maxExtractedTextLength: 20_000,
      parseTextExtensions: [".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".xls", ".xlsx", ".csv"],
    });
    const cache = await this.readCache();
    const fileHash = buildLaborCacheKey(preparedFile.buffer);
    const cached = cache.materials[fileHash];
    if (cached) {
      await onProgress?.(`命中缓存，已复用《${file.fileName}》的历史提取结果`);
      return {
        fileName: preparedFile.fileName,
        extraction: cached,
        cached: true,
      };
    }

    await onProgress?.(
      preparedFile.extractedText
        ? `已提取文本预览，正在识别《${file.fileName}》的关键事实`
        : `未提取到稳定文本，正在结合原文件识别《${file.fileName}》`,
    );
    const result = await this.evidenceExtractor.extractPreparedJson(preparedFile, {
      model: resolveModel(this.config, "extract"),
      createSessionTitle: "[bridge] labor-material-extract",
      buildPrompt: ({ fileName, extractedText, localPath }) => buildLaborMaterialExtractPrompt(fileName, extractedText ?? "", localPath),
    });
    const extraction = normalizeMaterialExtraction(result);
    cache.materials[fileHash] = extraction;
    await this.writeCache(cache);
    await onProgress?.(`《${file.fileName}》提取完成`);
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
    options?: { onProgress?: ((step: string) => Promise<void> | void) | undefined },
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
    const markdown = renderLaborWorkbenchMarkdown(normalizedAggregate, input.materialCount, input.warnings);
    const workbench = await generateCaseWorkflowWorkbench({
      title,
      markdown,
      diagrams: buildLaborWorkbenchDiagrams(normalizedAggregate),
      logger: this.logger,
      logScope: "labor-skill",
      onProgress,
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
  };
}

/** 把聚合结果渲染为飞书工作台 Markdown。 */
export function renderLaborWorkbenchMarkdown(result: LaborAggregateResult, materialCount: number, warnings: string[]): string {
  const title = result.caseTitle || "劳动争议案件";
  const timelineDiagram = buildTimelineMermaid(result.timeline);
  const evidenceDiagram = buildEvidenceMapMermaid(result);
  const claimsDiagram = buildClaimsMindmapMermaid(result);
  const nextActionsDiagram = buildNextActionsFlowMermaid(result);
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

function resolveModel(config: LaborSkillConfig, step: "extract" | "analyze"): OpenCodeModelRef | undefined {
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

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
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

function buildLaborCacheKey(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
