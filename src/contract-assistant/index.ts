import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

import type { ContractAssistantConfig } from "../config/schema.js";
import { parseKnowledgeFile } from "../knowledge/parser.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeModelRef, OpenCodePromptRequest } from "../opencode/client.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import {
  EvidenceExtractService,
  type EvidenceExtractResourcePort,
  type EvidenceFileRef,
} from "../workflows/evidence-extract.js";
import {
  buildCaseCreatePrompt,
  buildCaseUpdatePrompt,
  buildContractDraftPrompt,
  buildContractExtractPrompt,
  buildInvoiceRecognizePrompt,
} from "./prompts.js";

type OpenCodePort = Pick<OpenCodeClient, "createSession" | "postMessageSync" | "deleteSession">;

type ContractAssistantResourcePort = EvidenceExtractResourcePort & {
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
  listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
  updateBitableRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
};

export type ContractAssistantFileRef = EvidenceFileRef;

export type ContractDraftResult = {
  docTitle: string;
  wordPath: string;
  docUrl?: string | undefined;
  markdown: string;
  recordId?: string | undefined;
  warnings: string[];
};

export type ContractExtractResult = {
  summary: string;
  record: Record<string, unknown>;
  recordId: string;
};

export type InvoiceRecognizeResult = {
  summary: string;
  record: Record<string, unknown>;
  recordId: string;
  matchedContract?: string | undefined;
};

export type CaseCreateResult = {
  summary: string;
  record: Record<string, unknown>;
  recordId: string;
};

export type CaseUpdateResult = {
  matchedLabel: string;
  fields: Record<string, unknown>;
};

type ContractTemplate = {
  name: string;
  docxPath: string;
  fieldGuidePath?: string | undefined;
};

export class ContractAssistantService {
  private readonly evidenceExtractor: EvidenceExtractService;

  constructor(
    private readonly config: ContractAssistantConfig,
    private readonly dataDir: string,
    private readonly resources: ContractAssistantResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
  ) {
    this.evidenceExtractor = new EvidenceExtractService(resources, opencode, logger);
  }

  async draftContract(request: string): Promise<ContractDraftResult> {
    const template = await this.resolveDraftTemplate(request);
    const templateContent = await this.loadTemplateContent(template);
    const parsed = await this.askForJson(buildContractDraftPrompt(
      request,
      template.name,
      templateContent.mainText,
      templateContent.riskNoticeText,
      templateContent.fieldGuideText,
    ), resolveModel(this.config, "draft"));
    const docTitle = readString(parsed, "docTitle") ?? "合同草稿";
    const feeMode = readString(parsed, "feeMode") ?? inferFeeModeFromRequest(request);
    const rawMarkdown = readString(parsed, "markdown") ?? `### 合同草稿\n\n${request}`;
    const markdown = postProcessContractDraftMarkdown(rawMarkdown, feeMode);
    const record = readRecord(parsed, "record");
    const templateData = readRecord(parsed, "templateData");
    const warnings: string[] = [];
    const fileNameTitle = buildContractWordFileTitle(request, record, template.name);
    const wordPath = await createLocalWordDoc(
      this.dataDir,
      template.docxPath,
      fileNameTitle,
      markdown,
      buildContractTemplateRenderData(request, record, templateData, feeMode),
    );
    const docUrl = await createLarkDoc(docTitle, markdown).catch((error) => {
      warnings.push(`飞书文档创建失败：${error instanceof Error ? error.message : String(error)}`);
      this.logger.log("contract-assistant", "create lark doc failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return undefined;
    });
    const recordId = record
      ? await this.resources.createBitableRecord(
        this.config.storage.baseToken,
        this.config.storage.contractTableId,
        normalizeContractRecord(record),
      ).catch((error) => {
        warnings.push(`合同台账写入失败：${error instanceof Error ? error.message : String(error)}`);
        this.logger.log("contract-assistant", "create contract record failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
        return undefined;
      })
      : undefined;
    return { docTitle, wordPath, docUrl, markdown, recordId, warnings };
  }

  async listDraftTemplates(): Promise<string[]> {
    const templateDir = path.resolve(process.cwd(), "templates/contracts");
    const entries = await readdir(templateDir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".docx"))
      .map((entry) => entry.name.replace(/\.docx$/i, ""))
      .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  }

  async extractContract(file: ContractAssistantFileRef): Promise<ContractExtractResult> {
    const { result } = await this.evidenceExtractor.extractJson({
      file,
      allowedExtensions: this.config.ingest.contractAllowedExtensions,
      maxFileSizeMb: this.config.ingest.maxFileSizeMb,
      maxExtractedTextLength: 20_000,
      model: resolveModel(this.config, "extract"),
      createSessionTitle: "[bridge] contract-extract",
      buildPrompt: ({ fileName, extractedText }) => buildContractExtractPrompt(fileName, extractedText ?? ""),
    });
    const record = normalizeContractRecord(readRecord(result, "record"));
    const summary = readString(result, "summary") ?? "已提取合同台账信息。";
    const recordId = await this.resources.createBitableRecord(
      this.config.storage.baseToken,
      this.config.storage.contractTableId,
      record,
    );
    return { summary, record, recordId };
  }

  async recognizeInvoice(file: ContractAssistantFileRef): Promise<InvoiceRecognizeResult> {
    const { result } = await this.evidenceExtractor.extractJson({
      file,
      allowedExtensions: this.config.ingest.invoiceAllowedExtensions,
      maxFileSizeMb: this.config.ingest.maxFileSizeMb,
      maxExtractedTextLength: 12_000,
      model: resolveModel(this.config, "invoice"),
      createSessionTitle: "[bridge] invoice-recognize",
      buildPrompt: ({ fileName, localPath, extractedText }) => buildInvoiceRecognizePrompt(fileName, localPath, extractedText || undefined),
    });
    const record = normalizeInvoiceRecord(readRecord(result, "record"));
    const summary = readString(result, "summary") ?? "已识别发票信息。";
    const recordId = await this.resources.createBitableRecord(
      this.config.storage.baseToken,
      this.config.storage.invoiceTableId,
      record,
    );

    const matchHints = readRecord(result, "matchHints");
    const matched = await this.tryMatchContract(matchHints, record);
    if (matched) {
      await this.resources.updateBitableRecord(
        this.config.storage.baseToken,
        this.config.storage.invoiceTableId,
        recordId,
        { 关联合同: [{ id: matched.recordId }] },
      );
    }

    return {
      summary,
      record,
      recordId,
      matchedContract: matched?.label,
    };
  }

  async createCase(request: string): Promise<CaseCreateResult> {
    const result = await this.askForJson(buildCaseCreatePrompt(request), resolveModel(this.config, "caseManage"));
    const record = normalizeCaseRecord(readRecord(result, "record"));
    const summary = readString(result, "summary") ?? "已整理案件管理字段。";
    const recordId = await this.resources.createBitableRecord(
      this.config.storage.baseToken,
      this.config.storage.caseTableId,
      record,
    );
    return { summary, record, recordId };
  }

  async updateCase(request: string): Promise<CaseUpdateResult> {
    const result = await this.askForJson(buildCaseUpdatePrompt(request), resolveModel(this.config, "caseManage"));
    const caseNo = readString(result, "caseNo");
    const clientName = readString(result, "clientName");
    const fields = normalizeCaseRecord(readRecord(result, "fields"));
    const records = await this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.caseTableId);
    const matched = records.find((item) => {
      const recordCaseNo = readFieldString(item.fields, "案号");
      const recordClient = readFieldString(item.fields, "委托人");
      if (caseNo && recordCaseNo === caseNo) {
        return true;
      }
      if (clientName && recordClient === clientName) {
        return true;
      }
      return false;
    });
    if (!matched) {
      throw new Error("未找到可更新的案件，请提供更明确的案号或委托人。");
    }
    await this.resources.updateBitableRecord(
      this.config.storage.baseToken,
      this.config.storage.caseTableId,
      matched.recordId,
      fields,
    );
    return {
      matchedLabel: readFieldString(matched.fields, "案号") ?? readFieldString(matched.fields, "委托人") ?? matched.recordId,
      fields,
    };
  }

  async listReminderItems(lookaheadDays: number): Promise<{ contractLines: string[]; invoiceLines: string[]; caseLines: string[] }> {
    const [contracts, invoices, cases] = await Promise.all([
      this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.contractTableId),
      this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.invoiceTableId),
      this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.caseTableId),
    ]);
    const now = Date.now();
    const lookaheadMs = lookaheadDays * 24 * 60 * 60 * 1000;

    const contractLines = contracts
      .map((item) => {
        const name = readFieldString(item.fields, "项目名称") ?? readFieldString(item.fields, "律所合同号");
        const unpaid = readFieldNumber(item.fields, "未收款");
        const uninvoiced = readFieldNumber(item.fields, "未开票金额");
        const paymentNodes = readFieldString(item.fields, "付款节点");
        if (!name) return null;
        if ((unpaid ?? 0) <= 0 && (uninvoiced ?? 0) <= 0) return null;
        return `${name}：未收款 ¥${formatNumber(unpaid)}，未开票 ¥${formatNumber(uninvoiced)}${paymentNodes ? `；付款节点：${paymentNodes}` : ""}`;
      })
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);

    const invoiceLines = invoices
      .map((item) => {
        const contractNo = readFieldString(item.fields, "合同号") ?? "未填合同号";
        const amount = readFieldNumber(item.fields, "发票金额");
        const issueDate = readFieldString(item.fields, "开票日期");
        const linked = Array.isArray(item.fields["关联合同"]) ? item.fields["关联合同"] : [];
        if (linked.length > 0) return null;
        return `${contractNo}：发票金额 ¥${formatNumber(amount)}${issueDate ? `，开票日期 ${issueDate}` : ""}`;
      })
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);

    const caseLines = cases
      .map((item) => {
        const label = readFieldString(item.fields, "案号") ?? readFieldString(item.fields, "委托人");
        const status = readFieldString(item.fields, "案件状态");
        const deadline = pickNearestDeadline(item.fields, now, lookaheadMs);
        if (!label || !deadline) return null;
        return `${label}：${deadline.label} ${deadline.value}${status ? `；当前状态 ${status}` : ""}`;
      })
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);

    return { contractLines, invoiceLines, caseLines };
  }

  private async tryMatchContract(
    matchHints: Record<string, unknown> | null,
    invoiceRecord: Record<string, unknown>,
  ): Promise<{ recordId: string; label: string } | null> {
    const contractNo = readString(matchHints, "contractNo") ?? readFieldString(invoiceRecord, "合同号");
    const payer = readString(matchHints, "payer") ?? readFieldString(invoiceRecord, "付款方");
    const amount = readNumber(matchHints, "amount") ?? readFieldNumber(invoiceRecord, "发票金额");
    const contracts = await this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.contractTableId);
    const matched = contracts.find((item) => {
      if (contractNo && readFieldString(item.fields, "律所合同号") === contractNo) {
        return true;
      }
      if (payer && readFieldString(item.fields, "客户名称") === payer) {
        return true;
      }
      if (typeof amount === "number" && Math.abs((readFieldNumber(item.fields, "合同金额") ?? 0) - amount) < 0.01) {
        return true;
      }
      return false;
    });
    if (!matched) {
      return null;
    }
    return {
      recordId: matched.recordId,
      label: readFieldString(matched.fields, "律所合同号") ?? readFieldString(matched.fields, "项目名称") ?? matched.recordId,
    };
  }

  private async askForJson(prompt: string, model?: OpenCodeModelRef): Promise<Record<string, unknown>> {
    const session = await this.opencode.createSession("[bridge] contract-assistant");
    try {
      const response = await this.opencode.postMessageSync(session.id, buildPromptRequest(prompt, model));
      return parseJsonObject(extractAssistantText(response));
    } finally {
      await this.opencode.deleteSession(session.id).catch((error) => {
        this.logger.log("contract-assistant", "delete temp session failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }
  }

  private async resolveDraftTemplate(request: string): Promise<ContractTemplate> {
    const templateDir = path.resolve(process.cwd(), "templates/contracts");
    const templateNames = await this.listDraftTemplates();
    const docxFiles = templateNames.map((name) => `${name}.docx`);
    if (docxFiles.length === 0) {
      throw new Error("未找到本地合同模板，请先在 templates/contracts 下放置 .docx 模板。");
    }

    const normalizedRequest = request.replace(/\s+/g, "");
    const matchedFile = docxFiles.find((file) => {
      const baseName = file.replace(/\.docx$/i, "");
      const relaxed = baseName.replace(/[-—_（）()·\s]/g, "");
      return normalizedRequest.includes(baseName) || normalizedRequest.includes(relaxed);
    }) ?? docxFiles[0]!;

    const baseName = matchedFile.replace(/\.docx$/i, "");
    const fieldGuidePath = path.join(templateDir, `${baseName}.md`);
    return {
      name: baseName,
      docxPath: path.join(templateDir, matchedFile),
      fieldGuidePath,
    };
  }

  private async loadTemplateContent(template: ContractTemplate): Promise<{
    mainText: string;
    riskNoticeText?: string | undefined;
    fieldGuideText?: string | undefined;
  }> {
    const buffer = await readFile(template.docxPath);
    const parsed = await parseKnowledgeFile(template.docxPath, buffer);
    const normalized = parsed.normalizedMarkdown.trim();
    const split = splitRiskNotice(normalized);
    const fieldGuideText = template.fieldGuidePath
      ? await readFile(template.fieldGuidePath, "utf8").catch(() => undefined)
      : undefined;
    return {
      mainText: split.mainText,
      riskNoticeText: split.riskNoticeText,
      fieldGuideText,
    };
  }
}

function buildPromptRequest(prompt: string, model?: OpenCodeModelRef): OpenCodePromptRequest {
  return model
    ? { model, parts: [{ type: "text", text: prompt }] }
    : { parts: [{ type: "text", text: prompt }] };
}

export function splitRiskNotice(templateText: string): { mainText: string; riskNoticeText?: string | undefined } {
  const marker = "风险代理告知书";
  const index = templateText.indexOf(marker);
  if (index < 0) {
    return { mainText: templateText.trim() };
  }
  const prefix = templateText.slice(0, index);
  const start = prefix.lastIndexOf("附件");
  if (start < 0) {
    return { mainText: templateText.trim() };
  }
  return {
    mainText: templateText.slice(0, start).trim(),
    riskNoticeText: templateText.slice(start).trim(),
  };
}

export function inferFeeModeFromRequest(request: string): string {
  const normalized = request.replace(/\s+/g, "");
  if (/(风险代理|风险收费|风险费|回款比例|按回款|胜诉回款)/.test(normalized)) {
    return "base_plus_risk";
  }
  return "stage_fixed";
}

export function postProcessContractDraftMarkdown(markdown: string, feeMode: string): string {
  if (feeMode === "base_plus_risk") {
    return markdown;
  }
  const lines = markdown.split("\n");
  const markerIndex = lines.findIndex((line) => /风险代理告知书/.test(line));
  if (markerIndex < 0) {
    return markdown;
  }
  let attachmentIndex = -1;
  for (let index = markerIndex; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^附件/.test(line?.trim() ?? "")) {
      attachmentIndex = index;
      break;
    }
  }
  const cutIndex = attachmentIndex >= 0 ? attachmentIndex : markerIndex;
  return lines.slice(0, cutIndex).join("\n").trim();
}

function resolveModel(config: ContractAssistantConfig, step: "draft" | "extract" | "invoice" | "caseManage"): OpenCodeModelRef | undefined {
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

function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const target = value[key];
  return target && typeof target === "object" && !Array.isArray(target)
    ? target as Record<string, unknown>
    : null;
}

function readString(value: Record<string, unknown> | null, key: string): string | undefined {
  if (!value) return undefined;
  const target = value[key];
  return typeof target === "string" && target.trim() ? target.trim() : undefined;
}

function readNumber(value: Record<string, unknown> | null, key: string): number | undefined {
  if (!value) return undefined;
  const target = value[key];
  if (typeof target === "number" && Number.isFinite(target)) {
    return target;
  }
  if (typeof target === "string" && target.trim()) {
    const parsed = Number(target);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(value: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!value) return undefined;
  const target = value[key];
  if (typeof target === "boolean") {
    return target;
  }
  if (typeof target === "string") {
    const normalized = target.trim().toLowerCase();
    if (["true", "yes", "1", "是", "有"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0", "否", "无"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function readFieldString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim()) as string | undefined;
    return first?.trim();
  }
  return undefined;
}

function readFieldNumber(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeContractRecord(record: Record<string, unknown> | null): Record<string, unknown> {
  const input = record ?? {};
  const fields: Record<string, unknown> = {};
  copyString(input, fields, "项目名称");
  copyString(input, fields, "律所合同号");
  copyString(input, fields, "客户名称");
  copyString(input, fields, "合同类型");
  copyString(input, fields, "具体类型/案由");
  copyDate(input, fields, "签约日期");
  copyNumber(input, fields, "合同金额");
  copyString(input, fields, "付款节点");
  copyString(input, fields, "联系人");
  copyString(input, fields, "联系方式");
  copyString(input, fields, "客户收件地址");
  copyString(input, fields, "信用代码/身份证");
  return fields;
}

function normalizeInvoiceRecord(record: Record<string, unknown> | null): Record<string, unknown> {
  const input = record ?? {};
  const fields: Record<string, unknown> = {};
  copyString(input, fields, "合同号");
  copyString(input, fields, "付款方");
  copyString(input, fields, "发票号");
  copyString(input, fields, "开票日期");
  copyNumber(input, fields, "发票金额");
  return fields;
}

function normalizeCaseRecord(record: Record<string, unknown> | null): Record<string, unknown> {
  const input = record ?? {};
  const fields: Record<string, unknown> = {};
  copyString(input, fields, "类型");
  copyString(input, fields, "案由");
  copyString(input, fields, "委托人");
  copyString(input, fields, "对方当事人");
  copyString(input, fields, "联系人");
  copyString(input, fields, "联系方式");
  copyString(input, fields, "案号");
  copyString(input, fields, "审理法院");
  copyStringArray(input, fields, "程序阶段");
  copyString(input, fields, "案件状态");
  copyString(input, fields, "重要紧急程度");
  copyString(input, fields, "日期");
  copyString(input, fields, "开庭日");
  copyString(input, fields, "开庭地点");
  copyString(input, fields, "举证截止日");
  copyString(input, fields, "反诉截止日");
  copyString(input, fields, "管辖权异议截止日");
  copyString(input, fields, "上诉截止日");
  copyString(input, fields, "待做事项");
  copyString(input, fields, "进展");
  copyString(input, fields, "备注");
  return fields;
}

function copyString(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (typeof value === "string" && value.trim()) {
    target[key] = value.trim();
  }
}

function copyNumber(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
    return;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      target[key] = parsed;
    }
  }
}

function copyDate(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const normalized = normalizeBitableDateValue(source[key]);
  if (typeof normalized === "number") {
    target[key] = normalized;
  }
}

function copyStringArray(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (Array.isArray(value)) {
    const normalized = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    if (normalized.length > 0) {
      target[key] = normalized;
    }
    return;
  }
  if (typeof value === "string" && value.trim()) {
    target[key] = [value.trim()];
  }
}

async function createLarkDoc(title: string, markdown: string): Promise<string | undefined> {
  const output = await runLarkCli(["docs", "+create", "--title", title, "--markdown", "-"], markdown);
  const parsed = parseJsonObject(output);
  return readString(parsed, "doc_url") ?? readString(readRecord(parsed, "data"), "doc_url");
}

type ContractTemplateRenderData = {
  client_name: string;
  client_representative: string;
  client_id_code: string;
  client_address: string;
  client_email: string;
  client_phone: string;
  counterparty_name: string;
  case_cause: string;
  lead_lawyer: string;
  sign_date_text: string;
  risk_notice_date_text: string;
  arbitration_checkbox: string;
  first_instance_checkbox: string;
  second_instance_checkbox: string;
  enforcement_checkbox: string;
  settlement_checkbox: string;
  stage_fee_checkbox: string;
  risk_fee_checkbox: string;
  attachment_notice_title: string;
  attachment_notice_suffix: string;
  dispute_resolution_clause: string;
  special_terms_clause: string;
  has_special_terms: boolean;
  is_stage_fixed: boolean;
  is_risk_fee: boolean;
  show_risk_notice: boolean;
  fee_arbitration_clause: string;
  fee_first_instance_clause: string;
  fee_second_instance_clause: string;
  fee_enforcement_clause: string;
  base_fee_clause: string;
  risk_fee_clause: string;
  risk_fee_followup_clause_1: string;
  risk_fee_followup_clause_2: string;
};

async function createLocalWordDoc(
  dataDir: string,
  templatePath: string,
  title: string,
  markdown: string,
  renderData: ContractTemplateRenderData,
): Promise<string> {
  try {
    return await createLocalWordDocWithDocxtemplater(dataDir, templatePath, title, renderData);
  } catch {
    return await createLocalWordDocFromHtml(dataDir, title, markdown);
  }
}

async function createLocalWordDocWithDocxtemplater(
  dataDir: string,
  templatePath: string,
  title: string,
  renderData: ContractTemplateRenderData,
): Promise<string> {
  const outputDir = path.join(dataDir, "contract-drafts");
  await mkdir(outputDir, { recursive: true });
  const safeName = sanitizeFileName(title || "合同草稿");
  const docxPath = await resolveNumberedOutputPath(outputDir, safeName, ".docx");
  const taggedTemplatePath = await ensureTaggedContractTemplate(dataDir, templatePath);
  const templateBuffer = await readFile(taggedTemplatePath);
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });
  doc.render(renderData);
  const output = doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  await writeFile(docxPath, output);
  return docxPath;
}

async function ensureTaggedContractTemplate(dataDir: string, templatePath: string): Promise<string> {
  const templateDir = path.join(dataDir, "contract-template-cache");
  await mkdir(templateDir, { recursive: true });
  const cachePath = path.join(
    templateDir,
    `${path.basename(templatePath, path.extname(templatePath))}.docxtpl.docx`,
  );
  const [sourceStat, cacheStat] = await Promise.all([
    stat(templatePath),
    stat(cachePath).catch(() => null),
  ]);
  if (cacheStat && cacheStat.mtimeMs >= sourceStat.mtimeMs) {
    return cachePath;
  }
  const templateBuffer = await readFile(templatePath);
  const zip = new PizZip(templateBuffer);
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) {
    throw new Error("模板缺少 word/document.xml");
  }
  const sourceXml = documentFile.asText();
  zip.file("word/document.xml", buildTaggedContractTemplateXml(sourceXml));
  const output = zip.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  await writeFile(cachePath, output);
  return cachePath;
}

function buildTaggedContractTemplateXml(sourceXml: string): string {
  let xml = sourceXml;
  xml = replaceRegexOnce(
    xml,
    /(<w:t[^>]*>)地址（必填）：[\s\S]*?(<\/w:t>)/,
    "$1地址（必填）：{client_address}$2",
  );
  xml = replaceRegexOnce(
    xml,
    /(<w:t[^>]*>)电子邮箱：\s*(<\/w:t>)/,
    "$1电子邮箱：{client_email}$2",
  );
  xml = replaceRegexOnce(
    xml,
    /(<w:t[^>]*>)联系电话（必填）：(<\/w:t>)/,
    "$1联系电话（必填）：{client_phone}$2",
  );
  xml = replaceRegexOnce(
    xml,
    /【案件当事人】\s*【案由】纠纷\s*/,
    "{counterparty_name}{case_cause}纠纷",
  );
  xml = replaceRegexOnce(
    xml,
    /（一）乙方指派<\/w:t><\/w:r><w:r[\s\S]*?<w:t xml:space="preserve">\s+\*\*\*\s+<\/w:t><\/w:r><w:r[\s\S]*?<w:t>/,
    "（一）乙方指派</w:t></w:r><w:r><w:t>{lead_lawyer}</w:t></w:r><w:r><w:t>",
  );
  const replacements: Array<[string, string, string]> = [
    ["甲方（必填）：                                                        ", "甲方（必填）：{client_name}", "client_name"],
    ["法定代表人/负责人：                                               ", "法定代表人/负责人：{client_representative}", "client_representative"],
    ["证件号/社会统一信用代码（必填）：                                         ", "证件号/社会统一信用代码（必填）：{client_id_code}", "client_id_code"],
    ["地址（必填）：              ", "地址（必填）：{client_address}", "client_address"],
    ["电子邮箱：                   ", "电子邮箱：{client_email}", "client_email"],
    ["联系电话（必填）：                         ", "联系电话（必填）：{client_phone}", "client_phone"],
    ["甲方因与【案件当事人】【案由】纠纷          案件，委托乙方代理，经双方协商，订立下列各条款，共同遵照履行。", "甲方因与{counterparty_name}{case_cause}纠纷案件，委托乙方代理，经双方协商，订立下列各条款，共同遵照履行。", "case_intro"],
    ["□仲裁阶段；", "{arbitration_checkbox}仲裁阶段；", "engage_arbitration"],
    ["□一审诉讼；", "{first_instance_checkbox}一审诉讼；", "engage_first_instance"],
    ["□二审诉讼；", "{second_instance_checkbox}二审诉讼；", "engage_second_instance"],
    ["□执行程序；", "{enforcement_checkbox}执行程序；", "engage_enforcement"],
    ["□上述案件代理程序中，有关调解、和解事宜。", "{settlement_checkbox}上述案件代理程序中，有关调解、和解事宜。", "engage_settlement"],
    ["（一）乙方指派  ***  律师作为案件中甲方的委托代理人，甲方同意上述律师指派其他律师和助理配合完成辅助工作，但乙方更换代理律师应取得甲方认可。", "（一）乙方指派 {lead_lawyer} 律师作为案件中甲方的委托代理人，甲方同意上述律师指派其他律师和助理配合完成辅助工作，但乙方更换代理律师应取得甲方认可。", "lead_lawyer"],
    ["□按阶段收费", "{stage_fee_checkbox}按阶段收费", "stage_fee_checkbox"],
    ["甲乙双方约定乙方律师费如下：", "{#is_stage_fixed}甲乙双方约定乙方律师费如下：", "stage_fee_intro"],
    ["1.仲裁阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），甲方在本合同签署后", "{fee_arbitration_clause}", "fee_arbitration_clause"],
    ["三日内一次性向乙方支付。", "", "fee_arbitration_clause_tail"],
    ["2.一审阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），甲方在本合同签署后三日内一次性向乙方支付。", "{fee_first_instance_clause}", "fee_first_instance_clause"],
    ["3.二审阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），若二审由甲方提起，则在甲方确定提起上诉之前一次性向乙方支付；若二审由其他诉讼当事人提起，则在收到上诉状之日起三日内一次性向乙方支付。", "{fee_second_instance_clause}", "fee_second_instance_clause"],
    ["4.执行阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），在甲方确定乙方代理执行程序之前一次性支付。", "{fee_enforcement_clause}{/is_stage_fixed}", "fee_enforcement_clause"],
    ["□基础收费+风险收费", "{risk_fee_checkbox}基础收费+风险收费", "risk_fee_checkbox"],
    ["甲乙双方选择风险代理收费方式，即律师费由基础费用和风险收费两部分组成：", "{#is_risk_fee}甲乙双方选择风险代理收费方式，即律师费由基础费用和风险收费两部分组成：", "risk_fee_intro"],
    ["1.基础费用：￥***00.00元（大写***元整），在签订合同后三日内支付。", "{base_fee_clause}", "base_fee_clause"],
    ["2.风险收费：按照案件胜诉并收回款项金额的*%（百分之*）收取，即甲方在案件中以任何形式（包括债务人主动给付、和解、调解或判决后给付以及通过法院强制执行等）收回的与案件有关的款项、有形资产或其他财产权益，甲方按实际收回的本金、违约金、利息以及所获得的其他有形资产或财产权益（如有）价值金额的*%（百分之*）向乙方支付律师费，甲方应在每次收回款项或权益之日起三日内向乙方支付该律师费。对于作为被告的案件，乙方代理后甲方胜诉或调解结案的，甲方按照被减免债务金额的*%（百分之*）向乙方支付律师费，该律师费甲方应在收到生效裁判文书之日起三日内向乙方支付。", "{risk_fee_clause}", "risk_fee_clause"],
    ["如果甲方实际收到的是现金以外的有形资产或财产权益，乙方有权选择以评估金额或实际变现金额为依据计算律师费。", "{risk_fee_followup_clause_1}", "risk_fee_followup_clause_1"],
    ["对于风险收费，甲方只要有回款或有回收其他有形资产或财产权益，就应按照约定支付律师费，无需等案件的全部标的额收回再支付律师费。", "{risk_fee_followup_clause_2}{/is_risk_fee}", "risk_fee_followup_clause_2"],
    ["甲、乙双方如果发生争议，应当友好协商解决。如协商不成，任何一方均有权将争议提交至深圳国际仲裁院仲裁，按照提交仲裁时深圳国际仲裁院现行有效的仲裁规则进行仲裁。仲裁裁决是终局的，对双方当事人均有约束力。", "{dispute_resolution_clause}", "dispute_resolution_clause"],
    ["附：《风险代理告知书》", "{attachment_notice_title}", "attachment_notice_title"],
    ["（以下无正文，为本合同签署处及附件）", "{attachment_notice_suffix}", "attachment_notice_suffix"],
    ["甲方：                                   乙方：北京市隆安（深圳）律师事务所", "甲方：{client_name}                                   乙方：北京市隆安（深圳）律师事务所", "sign_client_name"],
    ["法定代表人/负责人/授权代表：__________   承办律师：_________________                                          ", "法定代表人/负责人/授权代表：{client_representative}   承办律师：{lead_lawyer}                                          ", "signature_line"],
    ["签约时间：  202 年   月     日           ", "签约时间：{sign_date_text}           ", "sign_date_text"],
    ["<w:t>附件</w:t>", "<w:t>{#show_risk_notice}附件</w:t>", "show_risk_notice_open"],
    ["委托人：", "委托人：{client_name}", "risk_notice_client_name"],
    ["<w:t>日  期：   年  月  日</w:t>", "<w:t>日  期：{risk_notice_date_text}{/show_risk_notice}</w:t>", "show_risk_notice_close"],
  ];

  for (const [from, to] of replacements) {
    xml = replaceOnce(xml, from, to);
  }

  xml = xml.replace(
    "<w:p w14:paraId=\"231452C9\"><w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"5400\"/><w:tab w:val=\"left\" w:pos=\"5580\"/></w:tabs><w:spacing w:line=\"380\" w:lineRule=\"exact\"/><w:ind w:firstLine=\"482\" w:firstLineChars=\"200\"/><w:rPr><w:rFonts w:hint=\"eastAsia\" w:ascii=\"仿宋\" w:hAnsi=\"仿宋\" w:eastAsia=\"仿宋\" w:cs=\"仿宋\"/><w:b/><w:bCs/><w:sz w:val=\"24\"/></w:rPr></w:pPr></w:p>",
    "<w:p w14:paraId=\"231452C9\"><w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"5400\"/><w:tab w:val=\"left\" w:pos=\"5580\"/></w:tabs><w:spacing w:line=\"380\" w:lineRule=\"exact\"/><w:ind w:firstLine=\"482\" w:firstLineChars=\"200\"/><w:rPr><w:rFonts w:hint=\"eastAsia\" w:ascii=\"仿宋\" w:hAnsi=\"仿宋\" w:eastAsia=\"仿宋\" w:cs=\"仿宋\"/><w:b/><w:bCs/><w:sz w:val=\"24\"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:hint=\"eastAsia\" w:ascii=\"仿宋\" w:hAnsi=\"仿宋\" w:eastAsia=\"仿宋\" w:cs=\"仿宋\"/><w:b/><w:bCs/><w:sz w:val=\"24\"/></w:rPr><w:t>{#has_special_terms}3.{special_terms_clause}{/has_special_terms}</w:t></w:r></w:p>",
  );
  return xml;
}

function replaceOnce(source: string, from: string, to: string): string {
  if (!source.includes(from)) {
    return source;
  }
  return source.replace(from, to);
}

function replaceRegexOnce(source: string, pattern: RegExp, replacement: string): string {
  return pattern.test(source)
    ? source.replace(pattern, replacement)
    : source;
}

async function createLocalWordDocFromHtml(dataDir: string, title: string, markdown: string): Promise<string> {
  const outputDir = path.join(dataDir, "contract-drafts");
  await mkdir(outputDir, { recursive: true });
  const safeName = sanitizeFileName(title || "合同草稿");
  const docxPath = await resolveNumberedOutputPath(outputDir, safeName, ".docx");
  const htmlPath = docxPath.replace(/\.docx$/i, ".html");
  const html = renderMarkdownAsHtmlDocument(title, markdown);
  await writeFile(htmlPath, html, "utf8");
  try {
    await runTextUtilConvert(htmlPath, docxPath, title);
    await unlink(htmlPath).catch(() => undefined);
  } finally {
    // Keep the intermediate HTML for debugging only if docx generation fails.
  }
  return docxPath;
}

async function runTextUtilConvert(inputPath: string, outputPath: string, title: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/textutil", [
      "-convert",
      "docx",
      inputPath,
      "-output",
      outputPath,
      "-title",
      title,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || stdout || `textutil exited with code ${code ?? -1}`));
    });
  });
}

function renderMarkdownAsHtmlDocument(title: string, markdown: string): string {
  const body = renderMarkdownBlocks(markdown);
  return [
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body { font-family: 'PingFang SC', 'Helvetica Neue', sans-serif; font-size: 12pt; line-height: 1.7; color: #111827; padding: 24px; }",
    "h1 { font-size: 22pt; margin: 0 0 16px; }",
    "h2 { font-size: 16pt; margin: 20px 0 10px; }",
    "h3 { font-size: 14pt; margin: 16px 0 8px; }",
    "p { margin: 8px 0; }",
    "ol, ul { margin: 8px 0 8px 24px; }",
    "li { margin: 4px 0; }",
    "pre { white-space: pre-wrap; font-family: Menlo, monospace; background: #f3f4f6; padding: 12px; border-radius: 6px; }",
    "blockquote { margin: 12px 0; padding-left: 12px; border-left: 4px solid #d1d5db; color: #374151; }",
    "table { border-collapse: collapse; width: 100%; margin: 12px 0; }",
    "th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }",
    "th { background: #f9fafb; }",
    "</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

function renderMarkdownBlocks(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inCode = false;
  let codeLines: string[] = [];
  let tableBuffer: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join("<br />"))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (listItems.length === 0 || !listType) return;
    blocks.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listItems = [];
    listType = null;
  };
  const flushCode = (): void => {
    if (!inCode) return;
    blocks.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
    codeLines = [];
    inCode = false;
  };
  const flushTable = (): void => {
    if (tableBuffer.length === 0) return;
    blocks.push(renderMarkdownTable(tableBuffer));
    tableBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      flushTable();
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    if (line.includes("|") && /^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      tableBuffer.push(line);
      continue;
    }
    flushTable();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = (heading[1] ?? "#").length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(`<li>${renderInlineMarkdown(bullet[1] ?? "")}</li>`);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(`<li>${renderInlineMarkdown(ordered[1] ?? "")}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote>${renderInlineMarkdown(quote[1] ?? "")}</blockquote>`);
      continue;
    }
    paragraph.push(escapeHtml(line));
  }

  flushParagraph();
  flushList();
  flushTable();
  flushCode();
  return blocks.join("\n");
}

function renderMarkdownTable(lines: string[]): string {
  const rows = lines
    .filter((line) => !/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line))
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  if (rows.length === 0) {
    return "";
  }
  const [header, ...body] = rows;
  if (!header) {
    return "";
  }
  const thead = `<tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr>`;
  const tbody = body.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("");
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeFileName(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-");
  return normalized || "合同草稿";
}

export async function resolveNumberedOutputPath(outputDir: string, baseName: string, extension: string): Promise<string> {
  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(outputDir, `${baseName}${suffix}${extension}`);
    const exists = await stat(candidate).then(() => true).catch(() => false);
    if (!exists) {
      return candidate;
    }
  }
}

function buildContractWordFileTitle(
  request: string,
  record: Record<string, unknown> | null,
  templateName: string,
): string {
  const clientName = readString(record, "客户名称")
    ?? extractPartyFromText(request, /甲方(?:为|是)?[:：]?\s*([^\n；;，,。]+)/)
    ?? "XXX";
  const counterparty = extractPartyFromText(request, /(?:对方当事人|对方|乙方)(?:为|是)?[:：]?\s*([^\n；;，,。]+)/)
    ?? "XXX公司";

  if (/委托代理合同/.test(templateName)) {
    return `委托代理合同（${normalizePartyForFileName(clientName)}vs${normalizePartyForFileName(counterparty)}）`;
  }
  return `${templateName}（${normalizePartyForFileName(clientName)}vs${normalizePartyForFileName(counterparty)}）`;
}

function buildContractTemplateRenderData(
  request: string,
  record: Record<string, unknown> | null,
  templateData: Record<string, unknown> | null,
  feeMode: string,
): ContractTemplateRenderData {
  const resolvedFeeMode = readString(templateData, "fee_mode") ?? feeMode;
  const isRiskFee = resolvedFeeMode === "base_plus_risk";
  const isStageFixed = !isRiskFee;
  const clientName = readString(templateData, "client_name")
    ?? readString(record, "客户名称")
    ?? extractPartyFromText(request, /甲方(?:为|是)?[:：]?\s*([^\n；;，,。]+)/)
    ?? "【待补】";
  const clientRepresentative = readString(templateData, "client_representative") ?? "【待补】";
  const clientIdCode = readString(templateData, "client_id_code")
    ?? readString(record, "信用代码/身份证")
    ?? "【待补】";
  const clientAddress = readString(templateData, "client_address")
    ?? readString(record, "客户收件地址")
    ?? "【待补】";
  const clientEmail = readString(templateData, "client_email") ?? "【待补】";
  const clientPhone = readString(templateData, "client_phone")
    ?? readString(record, "联系方式")
    ?? "【待补】";
  const counterpartyName = readString(templateData, "counterparty_name")
    ?? extractPartyFromText(request, /(?:对方当事人|对方|乙方)(?:为|是)?[:：]?\s*([^\n；;。]+)/)
    ?? "【待补】";
  const caseCause = readString(templateData, "case_cause")
    ?? readString(record, "具体类型/案由")
    ?? extractPartyFromText(request, /案由(?:为|是)?[:：]?\s*([^\n；;。]+)/)
    ?? "【待补】";
  const leadLawyer = readString(templateData, "lead_lawyer")
    ?? extractPartyFromText(request, /承办律师(?:为|是)?[:：]?\s*([^\n；;，,。]+)/)
    ?? "【待补】";
  const signDateText = formatContractSignDate(readString(templateData, "sign_date"));
  const engageArbitration = readBoolean(templateData, "engage_arbitration") ?? /仲裁/.test(request);
  const engageFirstInstance = readBoolean(templateData, "engage_first_instance") ?? /一审/.test(request);
  const engageSecondInstance = readBoolean(templateData, "engage_second_instance") ?? /二审/.test(request);
  const engageEnforcement = readBoolean(templateData, "engage_enforcement") ?? /执行/.test(request);
  const engageSettlement = readBoolean(templateData, "engage_settlement") ?? /(调解|和解)/.test(request);
  const specialTerms = readString(templateData, "special_terms") ?? "";

  return {
    client_name: clientName,
    client_representative: clientRepresentative,
    client_id_code: clientIdCode,
    client_address: clientAddress,
    client_email: clientEmail,
    client_phone: clientPhone,
    counterparty_name: counterpartyName,
    case_cause: caseCause,
    lead_lawyer: leadLawyer,
    sign_date_text: signDateText,
    risk_notice_date_text: signDateText,
    arbitration_checkbox: engageArbitration ? "☑" : "☐",
    first_instance_checkbox: engageFirstInstance ? "☑" : "☐",
    second_instance_checkbox: engageSecondInstance ? "☑" : "☐",
    enforcement_checkbox: engageEnforcement ? "☑" : "☐",
    settlement_checkbox: engageSettlement ? "☑" : "☐",
    stage_fee_checkbox: isStageFixed ? "☑" : "☐",
    risk_fee_checkbox: isRiskFee ? "☑" : "☐",
    attachment_notice_title: isRiskFee ? "附：《风险代理告知书》" : "",
    attachment_notice_suffix: isRiskFee ? "（以下无正文，为本合同签署处及附件）" : "（以下无正文，为本合同签署处）",
    dispute_resolution_clause: readString(templateData, "dispute_resolution_clause")
      ?? "甲、乙双方如果发生争议，应当友好协商解决。如协商不成，任何一方均有权将争议提交至深圳国际仲裁院仲裁，按照提交仲裁时深圳国际仲裁院现行有效的仲裁规则进行仲裁。仲裁裁决是终局的，对双方当事人均有约束力。",
    special_terms_clause: specialTerms || "",
    has_special_terms: Boolean(specialTerms),
    is_stage_fixed: isStageFixed,
    is_risk_fee: isRiskFee,
    show_risk_notice: isRiskFee,
    fee_arbitration_clause: readString(templateData, "fee_arbitration_clause") ?? "1.仲裁阶段：律师代理费为【待补】，甲方在本合同签署后三日内一次性向乙方支付。",
    fee_first_instance_clause: readString(templateData, "fee_first_instance_clause") ?? "2.一审阶段：律师代理费为【待补】，甲方在本合同签署后三日内一次性向乙方支付。",
    fee_second_instance_clause: readString(templateData, "fee_second_instance_clause") ?? "3.二审阶段：律师代理费为【待补】，若二审由甲方提起，则在甲方确定提起上诉之前一次性向乙方支付；若二审由其他诉讼当事人提起，则在收到上诉状之日起三日内一次性向乙方支付。",
    fee_enforcement_clause: readString(templateData, "fee_enforcement_clause") ?? "4.执行阶段：律师代理费为【待补】，在甲方确定乙方代理执行程序之前一次性支付。",
    base_fee_clause: readString(templateData, "base_fee_clause") ?? "甲乙双方选择风险代理收费方式，即律师费由基础费用和风险收费两部分组成：",
    risk_fee_clause: readString(templateData, "risk_fee_clause") ?? "2.风险收费：按照双方另行确认的比例和条件执行。",
    risk_fee_followup_clause_1: readString(templateData, "risk_fee_followup_clause_1") ?? "如果甲方实际收到的是现金以外的有形资产或财产权益，乙方有权选择以评估金额或实际变现金额为依据计算律师费。",
    risk_fee_followup_clause_2: readString(templateData, "risk_fee_followup_clause_2") ?? "对于风险收费，甲方只要有回款或回收其他有形资产或财产权益，就应按照约定支付律师费，无需等案件的全部标的额收回再支付律师费。",
  };
}

function formatContractSignDate(value: string | undefined): string {
  if (!value) {
    return "【待补】";
  }
  const normalized = value.replace(/\//g, "-").trim();
  const matched = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!matched) {
    return value;
  }
  const year = matched[1] ?? "【待补】";
  const month = matched[2] ?? "01";
  const day = matched[3] ?? "01";
  return `${year}年${month.padStart(2, "0")}月${day.padStart(2, "0")}日`;
}

export function normalizeBitableDateValue(value: unknown, now: Date = new Date()): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^(今天|今日)$/.test(trimmed)) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  const normalized = trimmed
    .replace(/[./]/g, "-")
    .replace(/年/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const matched = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?: (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!matched) {
    const fallback = Date.parse(trimmed);
    return Number.isFinite(fallback) ? fallback : undefined;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const hour = Number(matched[4] ?? "0");
  const minute = Number(matched[5] ?? "0");
  const second = Number(matched[6] ?? "0");
  const timestamp = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function extractPartyFromText(text: string, pattern: RegExp): string | undefined {
  const matched = text.match(pattern);
  return matched?.[1]?.trim() || undefined;
}

function normalizePartyForFileName(value: string): string {
  return value
    .replace(/[《》“”"'`]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 30) || "XXX";
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

function pickNearestDeadline(fields: Record<string, unknown>, now: number, lookaheadMs: number): { label: string; value: string } | null {
  const candidates = [
    "开庭日",
    "举证截止日",
    "反诉截止日",
    "管辖权异议截止日",
    "上诉截止日",
  ].map((key) => {
    const value = readFieldString(fields, key);
    if (!value) return null;
    const time = Date.parse(value.replace(/\//g, "-"));
    if (!Number.isFinite(time)) return null;
    if (time < now || time > now + lookaheadMs) return null;
    return { label: key, value, time };
  }).filter((item): item is { label: string; value: string; time: number } => Boolean(item));
  candidates.sort((left, right) => left.time - right.time);
  return candidates[0]
    ? { label: candidates[0].label, value: candidates[0].value }
    : null;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "0.00";
}
