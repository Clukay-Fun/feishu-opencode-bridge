import { spawn } from "node:child_process";

import type { ContractAssistantConfig } from "../config/schema.js";
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
  docUrl?: string | undefined;
  markdown: string;
  recordId?: string | undefined;
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

export class ContractAssistantService {
  private readonly evidenceExtractor: EvidenceExtractService;

  constructor(
    private readonly config: ContractAssistantConfig,
    private readonly resources: ContractAssistantResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
  ) {
    this.evidenceExtractor = new EvidenceExtractService(resources, opencode, logger);
  }

  async draftContract(request: string): Promise<ContractDraftResult> {
    const parsed = await this.askForJson(buildContractDraftPrompt(request), resolveModel(this.config, "draft"));
    const docTitle = readString(parsed, "docTitle") ?? "合同草稿";
    const markdown = readString(parsed, "markdown") ?? `### 合同草稿\n\n${request}`;
    const record = readRecord(parsed, "record");
    const docUrl = await createLarkDoc(docTitle, markdown);
    const recordId = record
      ? await this.resources.createBitableRecord(
        this.config.storage.baseToken,
        this.config.storage.contractTableId,
        normalizeContractRecord(record),
      )
      : undefined;
    return { docTitle, docUrl, markdown, recordId };
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
}

function buildPromptRequest(prompt: string, model?: OpenCodeModelRef): OpenCodePromptRequest {
  return model
    ? { model, parts: [{ type: "text", text: prompt }] }
    : { parts: [{ type: "text", text: prompt }] };
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
  copyString(input, fields, "签约日期");
  copyNumber(input, fields, "合同金额");
  copyString(input, fields, "付款节点");
  copyString(input, fields, "联系人");
  copyString(input, fields, "联系方式");
  copyString(input, fields, "客户收件地址");
  copyString(input, fields, "信用代码/身份证");
  copyString(input, fields, "备注");
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
  copyString(input, fields, "备注");
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
