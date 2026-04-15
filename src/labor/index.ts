import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LaborSkillConfig } from "../config/schema.js";
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
import { buildLaborAggregatePrompt, buildLaborMaterialExtractPrompt } from "./prompts.js";

type OpenCodePort = Pick<OpenCodeClient, "createSession" | "postMessageSync" | "deleteSession">;

export type LaborMaterialExtraction = {
  materialType: string;
  summary: string;
  facts: string[];
  timelineEvents: Array<{ date?: string | undefined; event: string; evidence?: string | undefined }>;
  evidenceRows: Array<{ name: string; type?: string | undefined; proves: string; support?: string | undefined; strength?: string | undefined; risk?: string | undefined; remarks?: string | undefined }>;
  riskPoints: string[];
  missingEvidenceHints: string[];
};

type LaborAggregateResult = {
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
  extractedMaterials: LaborMaterialExtraction[];
  aggregate: LaborAggregateResult;
  warnings: string[];
};

export type LaborMaterialExtractResult = {
  fileName: string;
  extraction: LaborMaterialExtraction;
  cached: boolean;
};

type LarkDocCreateResult = {
  docUrl?: string | undefined;
  boardTokens: string[];
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
    resources: EvidenceExtractResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
    private readonly knowledge: KnowledgeBasePort | null,
  ) {
    this.evidenceExtractor = new EvidenceExtractService(resources, opencode, logger);
    this.cacheFilePath = path.join(dataDir, "labor-skill-cache.json");
  }

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
      parseTextExtensions: [".pdf", ".docx", ".txt", ".md", ".xls", ".xlsx", ".csv"],
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
      normalizedAggregate.caseTitle = redactEvidenceText(input.preferredTitle.trim());
    }

    await onProgress?.("正在生成飞书工作台文档");
    const title = redactEvidenceText(normalizedAggregate.caseTitle || "劳动争议案件分析工作台");
    const markdown = renderLaborWorkbenchMarkdown(normalizedAggregate, input.materialCount, input.warnings);
    const docResult = await createLarkDoc(title, markdown).catch((error) => {
      this.logger.log("labor-skill", "create lark doc failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return undefined;
    });
    if (docResult?.boardTokens?.length) {
      await onProgress?.("正在生成时间线、关系图和思维导图");
      await updateLaborBoards(docResult.boardTokens, normalizedAggregate).catch((error) => {
        this.logger.log("labor-skill", "update labor boards failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }

    return {
      title,
      markdown,
      docUrl: docResult?.docUrl,
      extractedMaterials: input.extractedMaterials,
      aggregate: normalizedAggregate,
      warnings: input.warnings,
    };
  }

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

  private async writeCache(cache: LaborSkillCacheFile): Promise<void> {
    await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
    await writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2), "utf8");
  }
}

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

function renderLaborWorkbenchMarkdown(result: LaborAggregateResult, materialCount: number, warnings: string[]): string {
  const lines: string[] = [
    `<callout emoji="💡" background-color="light-blue" border-color="light-blue">`,
    "",
    result.summary || "这是根据当前劳动争议材料生成的案件工作台，包含证据链、时间线、风险与后续动作。",
    "",
    "</callout>",
    "",
    "<grid cols=\"2\">",
    "",
    "  <column width=\"50\">",
    "    ### 案件总览",
    `    - 案件主题：${redactEvidenceText(result.caseTitle)}`,
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
        `<callout emoji="🎁" background-color="light-yellow" border-color="light-yellow">`,
        "",
        `关键缺口：${redactEvidenceText(result.missingEvidence.slice(0, 3).join("；"))}`,
        "",
        "</callout>",
        "",
      ]
      : []),
    "### 核心判断",
    ...renderQuoteBlock(result.coreJudgment.length > 0 ? result.coreJudgment : [result.summary || "待补充核心判断"]),
    "",
    "### 证据链总表",
    "",
    renderEvidenceTable(result.evidenceRows),
    "",
    "### 时间线画板",
    "",
    "<whiteboard type=\"blank\"></whiteboard>",
    "",
    "### 证据关系图画板",
    "",
    "<whiteboard type=\"blank\"></whiteboard>",
    "",
    "### 请求项思维导图",
    "",
    "<whiteboard type=\"blank\"></whiteboard>",
    "",
    "### 补证流程图",
    "",
    "<whiteboard type=\"blank\"></whiteboard>",
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
    renderLegalSupportTable(result.legalSupports),
    "",
    "### 待补材料与下一步建议",
    "",
    "**待补材料**",
    ...renderBulletList(result.missingEvidence),
    "",
    "**下一步建议**",
    ...renderBulletList(result.nextActions),
  ];
  return lines.join("\n");
}

function renderEvidenceTable(rows: LaborAggregateResult["evidenceRows"]): string {
  const visible = rows.length > 0 ? rows.slice(0, 8) : [{ name: "暂无", type: "-", proves: "-", support: "-", strength: "-", risk: "-", remarks: "-" }];
  const columnWidths = "116,116,146,96,96,146,116";
  const body = [
    "<lark-table rows=\"" + (visible.length + 1) + "\" cols=\"7\" header-row=\"true\" column-widths=\"" + columnWidths + "\">",
    "",
    ...buildLarkTableRow(["证据名称", "类型", "证明事实", "支持方向", "证明力", "风险/缺口", "备注"]),
    ...visible.flatMap((row) => buildLarkTableRow([
      row.name,
      row.type ?? "-",
      row.proves,
      localizeSupport(row.support),
      localizeStrength(row.strength),
      row.risk ?? "-",
      row.remarks ?? "-",
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

async function createLarkDoc(title: string, markdown: string): Promise<LarkDocCreateResult> {
  const output = await runLarkCli(["docs", "+create", "--title", title, "--markdown", "-"], markdown);
  const parsed = parseJsonObject(output);
  const boardTokens = readStringArray(parsed, "board_tokens");
  const data = readRecord(parsed, "data");
  return {
    docUrl: readString(parsed, "doc_url") ?? readString(data, "doc_url"),
    boardTokens: boardTokens.length > 0 ? boardTokens : readStringArray(data, "board_tokens"),
  };
}

async function runLarkCli(args: string[], stdinText?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("lark-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || stdout || `lark-cli exited with code ${code ?? -1}`));
    });
    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function readRecord(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!value) return null;
  const target = value[key];
  return target && typeof target === "object" && !Array.isArray(target)
    ? target as Record<string, unknown>
    : null;
}

async function updateLaborBoards(boardTokens: string[], result: LaborAggregateResult): Promise<void> {
  const diagrams = [
    withWhiteboardDslInstruction(buildTimelineMermaid(result.timeline)),
    withWhiteboardDslInstruction(buildEvidenceMapMermaid(result)),
    withWhiteboardDslInstruction(buildClaimsMindmapMermaid(result)),
    withWhiteboardDslInstruction(buildNextActionsFlowMermaid(result)),
  ];
  for (const [index, boardToken] of boardTokens.slice(0, diagrams.length).entries()) {
    const source = diagrams[index] ?? "";
    if (!source.trim()) {
      continue;
    }
    await runLarkCli([
      "whiteboard",
      "+update",
      "--whiteboard-token",
      boardToken,
      "--input_format",
      "mermaid",
      "--overwrite",
      "--yes",
      "--source",
      "-",
    ], source);
  }
}

function withWhiteboardDslInstruction(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return trimmed;
  }
  return `%% 使用飞书白板内置DSL精确控制样式\n${trimmed}`;
}

function buildTimelineMermaid(rows: LaborAggregateResult["timeline"]): string {
  const sorted = [...rows]
    .filter((item) => item.event)
    .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? ""));
  if (sorted.length === 0) {
    return "flowchart TD\n    N1[\"暂无明确时间线\"]";
  }
  const lines = ["flowchart TD"];
  sorted.slice(0, 8).forEach((row, index) => {
    const nodeId = `N${index + 1}`;
    const label = escapeMermaidLabel(`${row.date ?? "日期待补"}｜${row.event}`);
    lines.push(`    ${nodeId}["${label}"]`);
    if (index > 0) {
      lines.push(`    N${index} --> ${nodeId}`);
    }
  });
  return lines.join("\n");
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

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, "'").replace(/\n/g, " ").trim();
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
