/**
 * 职责: 提供合同助手领域服务，承载合同、案件和发票相关业务流程。
 * 关注点:
 * - 基于模板起草合同文档。
 * - 从合同与发票文件中提取结构化信息。
 * - 处理案件台账与提醒类操作。
 */
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

import type { ContractAssistantConfig } from "../config/schema.js";
import { parseKnowledgeFile } from "../knowledge/parser.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeModelRef, OpenCodePromptRequest } from "../opencode/client.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import { spawnPythonTool } from "../utils/python-tool.js";
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
  buildContractWorkbenchApplyPrompt,
  buildContractWorkbenchInitFromDocumentPrompt,
  buildContractWorkbenchInitFromPromptPrompt,
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

export type CaseTodoResult = {
  lines: string[];
};

export type CaseReminderResult = {
  lines: string[];
};

export type CaseReminderAddResult = {
  matchedLabel: string;
  recordId: string;
  reminderLabel: string;
  reminderDate: string;
  todo?: string | undefined;
  fields: Record<string, unknown>;
};

export type ContractClause = {
  id: string;
  number: string;
  title: string;
  content: string;
};

export type ContractAppendix = {
  id: string;
  title: string;
  content: string;
};

export type ContractPartyInfo = {
  clientName?: string | undefined;
  counterpartyName?: string | undefined;
  agencyName?: string | undefined;
  leadLawyer?: string | undefined;
  signDate?: string | undefined;
};

export type ContractHistoryEntry = {
  version: number;
  summary: string;
  at: string;
};

export type ContractState = {
  sessionId: string;
  sourceMode: "template_upload" | "freeform_prompt" | "existing_contract_upload";
  title: string;
  parties: ContractPartyInfo;
  clauses: ContractClause[];
  appendices: ContractAppendix[];
  templatePath?: string | undefined;
  sourceFilePath?: string | undefined;
  draftPath?: string | undefined;
  version: number;
  history: ContractHistoryEntry[];
  lastRenderedAt?: string | undefined;
};

export type ContractWorkbenchModelResult = {
  action: "view" | "update" | "export" | "reject";
  message: string;
  updatedState?: ContractState | undefined;
  viewPayload?: {
    title?: string | undefined;
    content: string;
  } | undefined;
  exportHint?: {
    suggestedFileName?: string | undefined;
  } | undefined;
};

export type ContractEditOperation =
  | {
    type: "delete_clause";
    clauseNumber?: string | undefined;
    heading?: string | undefined;
  }
  | {
    type: "replace_content";
    clauseNumber?: string | undefined;
    heading?: string | undefined;
    newContent: string;
  }
  | {
    type: "delete_pages";
    pageRange: [number, number];
  }
  | {
    type: "delete_by_heading";
    heading: string;
  };

type ContractTemplate = {
  name: string;
  docxPath: string;
  fieldGuidePath?: string | undefined;
};

export type ContractDraftProgressStage =
  | "parse-request"
  | "match-template"
  | "prepare-fields"
  | "generate-word"
  | "sync-artifacts";

type ContractDraftProgressCallback = (stage: ContractDraftProgressStage, detail?: string) => Promise<void> | void;

export class ContractAssistantService {
  private readonly evidenceExtractor: EvidenceExtractService;

  // Wire contract-domain resources, model access, and workflow helpers together.
  constructor(
    private readonly config: ContractAssistantConfig,
    private readonly dataDir: string,
    private readonly resources: ContractAssistantResourcePort,
    private readonly opencode: OpenCodePort,
    private readonly logger: Logger,
  ) {
    this.evidenceExtractor = new EvidenceExtractService(resources, opencode, logger);
  }

  //#region Contract and document workflows
  // Draft a contract from free-form requirements and an internal Word template.
  async draftContract(
    request: string,
    optionsOrProgress?: { requesterOpenId?: string | undefined } | ContractDraftProgressCallback,
    maybeOnProgress?: ContractDraftProgressCallback,
  ): Promise<ContractDraftResult> {
    const options = typeof optionsOrProgress === "function" ? {} : (optionsOrProgress ?? {});
    const onProgress = typeof optionsOrProgress === "function" ? optionsOrProgress : maybeOnProgress;
    await onProgress?.("parse-request", "正在识别模板、程序和收费条件");
    await onProgress?.("match-template", "正在匹配本地 Word 模板");
    const template = await this.resolveDraftTemplate(request);
    validateContractDraftRequest(template.name, request);
    const templateContent = await this.loadTemplateContent(template);
    await onProgress?.("prepare-fields", `已匹配模板：${template.name}，正在整理关键字段`);
    const warnings: string[] = [];
    const parsed = await this.askForJson(buildContractDraftPrompt(
      request,
      template.name,
      templateContent.mainText,
      templateContent.riskNoticeText,
      templateContent.fieldGuideText,
    ), resolveModel(this.config, "draft")).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push("模型暂不可用，已按本地规则生成合同初稿。");
      this.logger.log("contract-assistant", "draft contract model fallback", {
        detail,
        templateName: template.name,
      }, "warn");
      return buildLocalContractDraftFallback(request, template.name);
    });
    const docTitle = readString(parsed, "docTitle") ?? "合同草稿";
    const feeMode = readString(parsed, "feeMode") ?? inferFeeModeFromRequest(request);
    const rawMarkdown = readString(parsed, "markdown") ?? `### 合同草稿\n\n${request}`;
    const markdown = postProcessContractDraftMarkdown(rawMarkdown, feeMode);
    const record = readRecord(parsed, "record");
    const templateData = readRecord(parsed, "templateData");
    const fileNameTitle = buildContractWordFileTitle(request, record, template.name);
    await onProgress?.("generate-word", "正在生成 Word 合同草稿");
    const wordPath = await createLocalWordDoc(
      this.dataDir,
      template.docxPath,
      fileNameTitle,
      markdown,
      buildContractTemplateRenderData(request, record, templateData, feeMode),
    );
    await onProgress?.("sync-artifacts", "正在同步合同台账");
    const recordId = record
      ? await this.resources.createBitableRecord(
        this.config.storage.baseToken,
        this.config.storage.contractTableId,
        normalizeContractRecordForDraft(record, request, options.requesterOpenId),
      ).catch((error) => {
        warnings.push(`合同台账写入失败：${error instanceof Error ? error.message : String(error)}`);
        this.logger.log("contract-assistant", "create contract record failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
        return undefined;
      })
      : undefined;
    return { docTitle, wordPath, markdown, recordId, warnings };
  }

  // List locally available draft templates that can be matched during contract drafting.
  async listDraftTemplates(): Promise<string[]> {
    const templateDir = path.resolve(process.cwd(), "templates/contracts");
    const entries = await readdir(templateDir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".docx"))
      .map((entry) => entry.name.replace(/\.docx$/i, ""))
      .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  }

  // Extract structured contract information from an uploaded document.
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

  // Recognize invoice fields from an uploaded invoice file and match related contract context.
  async recognizeInvoice(file: ContractAssistantFileRef): Promise<InvoiceRecognizeResult> {
    const { result } = await this.evidenceExtractor.extractJson({
      file,
      allowedExtensions: this.config.ingest.invoiceAllowedExtensions,
      maxFileSizeMb: this.config.ingest.maxFileSizeMb,
      maxExtractedTextLength: 12_000,
      model: resolveModel(this.config, "invoice"),
      createSessionTitle: "[bridge] invoice-recognize",
      buildPrompt: ({ fileName, localPath, extractedText }) => resolveInvoiceRecognizePrompt({
        fileName,
        localPath,
        extractedText: extractedText || undefined,
      }),
    });
    const summary = readString(result, "summary") ?? "已识别发票信息。";
    const record = normalizeInvoiceRecord(readRecord(result, "record"), {
      matchHints: readRecord(result, "matchHints"),
      summary,
    });
    const recordId = await this.resources.createBitableRecord(
      this.config.storage.baseToken,
      this.config.storage.invoiceTableId,
      record,
    );

    return {
      summary,
      record,
      recordId,
    };
  }
  //#endregion

  //#region Case workflows
  // Create a new case record from free-form user instructions.
  async createCase(request: string): Promise<CaseCreateResult> {
    const result = await this.askForJson(await resolveCaseCreatePrompt(request), resolveModel(this.config, "caseManage"));
    const record = normalizeCaseRecord(readRecord(result, "record"));
    const summary = readString(result, "summary") ?? "已整理案件管理字段。";
    const recordId = await this.resources.createBitableRecord(
      this.config.storage.baseToken,
      this.config.storage.caseTableId,
      record,
    );
    return { summary, record, recordId };
  }

  // Update an existing case record by matching the target and patching its fields.
  async updateCase(request: string): Promise<CaseUpdateResult> {
    const result = await this.askForJson(await resolveCaseUpdatePrompt(request), resolveModel(this.config, "caseManage"));
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

  // List case todo items, optionally filtered by a free-form query.
  async listCaseTodos(query = ""): Promise<CaseTodoResult> {
    const records = await this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.caseTableId);
    const normalizedQuery = query.trim();
    const lines = records
      .map((item) => {
        const todo = readFieldString(item.fields, "待做事项");
        if (!todo) {
          return null;
        }
        const status = readFieldString(item.fields, "案件状态");
        if (status === "已结案") {
          return null;
        }
        const label = buildCaseRecordLabel(item.fields);
        const stage = readFieldString(item.fields, "程序阶段");
        const progress = readFieldString(item.fields, "进展");
        const haystack = [label, stage, status, todo, progress].filter(Boolean).join(" ");
        if (normalizedQuery && !haystack.includes(normalizedQuery)) {
          return null;
        }
        return `${label}${stage ? `｜${stage}` : ""}${status ? `｜${status}` : ""}\n待办：${todo}${progress ? `\n进展：${progress}` : ""}`;
      })
      .filter((value): value is string => Boolean(value))
      .slice(0, 10);
    return { lines };
  }

  // List upcoming case reminders within the configured lookahead window.
  async listCaseReminders(query = "", lookaheadDays = 7): Promise<CaseReminderResult> {
    const records = await this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.caseTableId);
    const now = Date.now();
    const lookaheadMs = lookaheadDays * 24 * 60 * 60 * 1000;
    const normalizedQuery = query.trim();
    const lines = records
      .flatMap((item) => buildCaseReminderCandidates(item.fields, now, lookaheadMs))
      .filter((item) => {
        if (!normalizedQuery) {
          return true;
        }
        return item.haystack.includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return left.priority - right.priority;
        }
        if (left.time !== right.time) {
          return left.time - right.time;
        }
        return right.recency - left.recency;
      })
      .map((item) => item.line)
      .slice(0, 10);
    return { lines };
  }

  // Add a reminder to a matched case record and return the updated fields.
  async addCaseReminder(request: string): Promise<CaseReminderAddResult> {
    const parsed = parseCaseReminderRequest(request);
    const records = await this.resources.listBitableRecords(this.config.storage.baseToken, this.config.storage.caseTableId);
    const matched = selectCaseRecordForReminder(records, parsed.target);
    if (!matched) {
      throw new Error(parsed.target
        ? `未找到匹配“${parsed.target}”的案件，请换用案号、委托人或对方当事人。`
        : "案件表暂无可添加提醒的记录，请先录入案件。");
    }

    const fields: Record<string, unknown> = {
      [parsed.dateField]: parsed.dateValue,
    };
    if (parsed.todo) {
      fields["待做事项"] = mergeCaseTodo(readFieldString(matched.fields, "待做事项"), parsed.todo);
    }

    await this.resources.updateBitableRecord(
      this.config.storage.baseToken,
      this.config.storage.caseTableId,
      matched.recordId,
      fields,
    );

    return {
      matchedLabel: buildCaseRecordLabel(matched.fields),
      recordId: matched.recordId,
      reminderLabel: parsed.dateField,
      reminderDate: parsed.dateDisplay,
      todo: parsed.todo,
      fields,
    };
  }

  // Merge reminder candidates across contract, invoice, and case dimensions.
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

  async initializeWorkbenchFromPrompt(sessionId: string, request: string): Promise<{ state: ContractState; message: string }> {
    const result = await this.askForJson(
      buildContractWorkbenchInitFromPromptPrompt(request),
      resolveModel(this.config, "draft"),
    );
    const state = normalizeContractState(readRecord(result, "state"), {
      sessionId,
      sourceMode: "freeform_prompt",
      title: "合同草稿",
    });
    return {
      state,
      message: readString(result, "message") ?? `已根据文字描述初始化合同，共整理 ${state.clauses.length} 条条款。`,
    };
  }

  async initializeWorkbenchFromDocument(
    sessionId: string,
    file: ContractAssistantFileRef,
  ): Promise<{ state: ContractState; message: string }> {
    const preparedFile = await this.evidenceExtractor.prepareFile(file, {
      allowedExtensions: this.config.ingest.contractAllowedExtensions,
      maxFileSizeMb: this.config.ingest.maxFileSizeMb,
      maxExtractedTextLength: 30_000,
      parseTextExtensions: [".pdf", ".docx", ".txt", ".md"],
    });
    let state: ContractState | null = null;
    let summary: string | undefined;

    if (preparedFile.extension === ".docx") {
      const parsed = await spawnPythonTool<{
        title?: string;
        parties?: Record<string, unknown>;
        clauses?: Array<Record<string, unknown>>;
        appendices?: Array<Record<string, unknown>>;
        rawText?: string;
        sourceModeHint?: "template_upload" | "existing_contract_upload";
      }>("contract_parse", {
        inputPath: preparedFile.localPath,
      });
      if (parsed.ok) {
        const sourceModeHint = parsed.data.sourceModeHint === "template_upload" || parsed.data.sourceModeHint === "existing_contract_upload"
          ? parsed.data.sourceModeHint
          : "existing_contract_upload";
        state = normalizeContractState({
          title: parsed.data.title,
          parties: parsed.data.parties,
          clauses: parsed.data.clauses,
          appendices: parsed.data.appendices,
        }, {
          sessionId,
          sourceMode: sourceModeHint,
          title: path.basename(preparedFile.fileName, path.extname(preparedFile.fileName)),
          sourceFilePath: preparedFile.localPath,
          templatePath: sourceModeHint === "template_upload" ? preparedFile.localPath : undefined,
        });
        summary = `已根据《${preparedFile.fileName}》初始化合同，共整理 ${state.clauses.length} 条条款。`;
      }
    }

    if (!state) {
      const content = preparedFile.extractedText.trim();
      if (!content) {
        throw new Error("未能从上传文件中提取到可编辑的合同文本，请尝试上传可复制文本的 Word、PDF 或文本文件。");
      }
      const result = await this.askForJson(
        buildContractWorkbenchInitFromDocumentPrompt(preparedFile.fileName, content),
        resolveModel(this.config, "draft"),
      );
      const sourceMode = readString(readRecord(result, "state"), "sourceMode");
      const normalizedSourceMode = sourceMode === "template_upload" || sourceMode === "existing_contract_upload"
        ? sourceMode
        : "existing_contract_upload";
      state = normalizeContractState(readRecord(result, "state"), {
        sessionId,
        sourceMode: normalizedSourceMode,
        title: path.basename(preparedFile.fileName, path.extname(preparedFile.fileName)),
        sourceFilePath: preparedFile.localPath,
        templatePath: normalizedSourceMode === "template_upload" ? preparedFile.localPath : undefined,
      });
      summary = readString(result, "message") ?? `已根据《${preparedFile.fileName}》初始化合同，共整理 ${state.clauses.length} 条条款。`;
    }

    return {
      state,
      message: summary ?? `已根据《${preparedFile.fileName}》初始化合同，共整理 ${state.clauses.length} 条条款。`,
    };
  }

  async applyWorkbenchMessage(
    state: ContractState,
    recentMessages: string[],
    userMessage: string,
  ): Promise<ContractWorkbenchModelResult> {
    const result = await this.askForJson(
      buildContractWorkbenchApplyPrompt(
        JSON.stringify(state, null, 2),
        recentMessages,
        userMessage,
      ),
      resolveModel(this.config, "draft"),
    );
    return normalizeWorkbenchModelResult(result, state);
  }

  async exportWorkbenchWord(
    state: ContractState,
    hint?: { suggestedFileName?: string | undefined },
  ): Promise<{ wordPath: string }> {
    const outputDir = path.join(this.dataDir, "contract-drafts");
    await mkdir(outputDir, { recursive: true });

    const desiredBaseName = sanitizeFileName(
      hint?.suggestedFileName?.trim()
      || state.title.trim()
      || `合同草稿-v${state.version}`,
    );
    const outputPath = await resolveNumberedOutputPath(outputDir, desiredBaseName, ".docx");
    const result = await spawnPythonTool<{ outputPath: string }>("contract_render", {
      state,
      outputPath,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return { wordPath: result.data.outputPath || outputPath };
  }

  async editWorkbenchWord(
    inputPath: string,
    operations: ContractEditOperation[],
    hint?: { suggestedFileName?: string | undefined },
  ): Promise<{ wordPath: string; appliedOps: number; skippedOps: Array<Record<string, unknown>> }> {
    const outputDir = path.join(this.dataDir, "contract-drafts");
    await mkdir(outputDir, { recursive: true });

    const desiredBaseName = sanitizeFileName(
      hint?.suggestedFileName?.trim()
      || path.basename(inputPath, path.extname(inputPath))
      || "合同草稿-编辑版",
    );
    const outputPath = await resolveNumberedOutputPath(outputDir, desiredBaseName, ".docx");
    const result = await spawnPythonTool<{
      outputPath: string;
      appliedOps: number;
      skippedOps?: Array<Record<string, unknown>>;
    }>("contract_edit", {
      inputPath,
      outputPath,
      operations,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return {
      wordPath: result.data.outputPath || outputPath,
      appliedOps: typeof result.data.appliedOps === "number" ? result.data.appliedOps : 0,
      skippedOps: Array.isArray(result.data.skippedOps) ? result.data.skippedOps : [],
    };
  }
}

function normalizeWorkbenchModelResult(
  value: Record<string, unknown>,
  currentState: ContractState,
): ContractWorkbenchModelResult {
  const action = readString(value, "action");
  const normalizedAction = action === "view" || action === "update" || action === "export" || action === "reject"
    ? action
    : "reject";
  const message = readString(value, "message") ?? (
    normalizedAction === "reject"
      ? "当前在合同工作会话中，仅处理合同相关操作；如需其他内容请新开话题。"
      : "已处理你的合同操作。"
  );
  const result: ContractWorkbenchModelResult = {
    action: normalizedAction,
    message,
  };
  const updatedState = normalizedAction === "update"
    ? normalizeContractState(readRecord(value, "updatedState"), {
      sessionId: currentState.sessionId,
      sourceMode: currentState.sourceMode,
      title: currentState.title,
      templatePath: currentState.templatePath,
      sourceFilePath: currentState.sourceFilePath,
      draftPath: currentState.draftPath,
      version: currentState.version,
      history: currentState.history,
      lastRenderedAt: currentState.lastRenderedAt,
    })
    : undefined;
  if (updatedState) {
    result.updatedState = updatedState;
  }
  const viewPayload = readRecord(value, "viewPayload");
  const viewContent = readString(viewPayload, "content");
  if (viewContent) {
    result.viewPayload = {
      title: readString(viewPayload, "title"),
      content: viewContent,
    };
  }
  const exportHint = readRecord(value, "exportHint");
  const suggestedFileName = readString(exportHint, "suggestedFileName");
  if (suggestedFileName) {
    result.exportHint = { suggestedFileName };
  }
  return result;
}

type NormalizeContractStateOptions = {
  sessionId: string;
  sourceMode: ContractState["sourceMode"];
  title: string;
  templatePath?: string | undefined;
  sourceFilePath?: string | undefined;
  draftPath?: string | undefined;
  version?: number | undefined;
  history?: ContractHistoryEntry[] | undefined;
  lastRenderedAt?: string | undefined;
};

function normalizeContractState(
  value: Record<string, unknown> | null,
  options: NormalizeContractStateOptions,
): ContractState {
  const title = readString(value, "title") ?? options.title;
  const sourceMode = readString(value, "sourceMode");
  const parties = value ? readRecord(value, "parties") : null;
  const clauses = normalizeClauseArray(value?.["clauses"]);
  const appendices = normalizeAppendixArray(value?.["appendices"]);
  const version = readNumber(value, "version") ?? options.version ?? 1;
  const history = normalizeHistoryArray(value?.["history"]);

  return {
    sessionId: options.sessionId,
    sourceMode: sourceMode === "template_upload" || sourceMode === "freeform_prompt" || sourceMode === "existing_contract_upload"
      ? sourceMode
      : options.sourceMode,
    title: title.trim() || options.title,
    parties: {
      clientName: readString(parties, "clientName") ?? readString(parties, "client") ?? "【待补】",
      counterpartyName: readString(parties, "counterpartyName") ?? readString(parties, "counterparty") ?? "【待补】",
      agencyName: readString(parties, "agencyName") ?? readString(parties, "agency"),
      leadLawyer: readString(parties, "leadLawyer"),
      signDate: readString(parties, "signDate"),
    },
    clauses: clauses.length > 0 ? clauses : [{
      id: "clause-1",
      number: "第一条",
      title: "合同主要内容",
      content: "【待补】",
    }],
    appendices,
    templatePath: readString(value, "templatePath") ?? options.templatePath,
    sourceFilePath: readString(value, "sourceFilePath") ?? options.sourceFilePath,
    draftPath: readString(value, "draftPath") ?? options.draftPath,
    version,
    history: history.length > 0 ? history : (options.history ?? []),
    lastRenderedAt: readString(value, "lastRenderedAt") ?? options.lastRenderedAt,
  };
}

function normalizeClauseArray(value: unknown): ContractClause[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const number = readString(record, "number") ?? `第${index + 1}条`;
      const title = readString(record, "title") ?? "未命名条款";
      const content = readString(record, "content") ?? readString(record, "text") ?? "";
      return {
        id: readString(record, "id") ?? `clause-${index + 1}`,
        number,
        title,
        content: content.trim() || "【待补】",
      } satisfies ContractClause;
    })
    .filter((item): item is ContractClause => Boolean(item));
}

function normalizeAppendixArray(value: unknown): ContractAppendix[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const title = readString(record, "title") ?? `附件${index + 1}`;
      const content = readString(record, "content") ?? "";
      if (!content.trim()) {
        return null;
      }
      return {
        id: readString(record, "id") ?? `appendix-${index + 1}`,
        title,
        content: content.trim(),
      } satisfies ContractAppendix;
    })
    .filter((item): item is ContractAppendix => Boolean(item));
}

function normalizeHistoryArray(value: unknown): ContractHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const summary = readString(record, "summary");
      if (!summary) {
        return null;
      }
      return {
        version: readNumber(record, "version") ?? 1,
        summary,
        at: readString(record, "at") ?? new Date().toISOString(),
      } satisfies ContractHistoryEntry;
    })
    .filter((item): item is ContractHistoryEntry => Boolean(item));
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

function resolveInvoiceRecognizePrompt(input: {
  fileName: string;
  localPath: string;
  extractedText?: string | undefined;
}): string {
  return buildPromptFromSkillOverride(
    "invoice-recognize",
    ["references/runtime-prompt.txt", "references/prompt.txt"],
    {
      fileName: input.fileName,
      localPath: input.localPath,
      extractedText: input.extractedText ?? "",
      extractedTextBlock: input.extractedText
        ? `补充可提取文本：\n---\n${input.extractedText}\n---`
        : "补充可提取文本：无",
    },
    () => buildInvoiceRecognizePrompt(input.fileName, input.localPath, input.extractedText),
  );
}

async function resolveCaseCreatePrompt(request: string): Promise<string> {
  return await buildPromptFromSkillOverrideAsync(
    "case-manage",
    ["references/create-prompt.txt", "references/runtime-create-prompt.txt"],
    { request },
    () => buildCaseCreatePrompt(request),
  );
}

async function resolveCaseUpdatePrompt(request: string): Promise<string> {
  return await buildPromptFromSkillOverrideAsync(
    "case-manage",
    ["references/update-prompt.txt", "references/runtime-update-prompt.txt"],
    { request },
    () => buildCaseUpdatePrompt(request),
  );
}

function buildPromptFromSkillOverride(
  skillName: string,
  relativePaths: string[],
  variables: Record<string, string>,
  fallback: () => string,
): string {
  const template = loadSkillPromptTemplateSync(skillName, relativePaths);
  return template ? renderPromptTemplate(template, variables) : fallback();
}

async function buildPromptFromSkillOverrideAsync(
  skillName: string,
  relativePaths: string[],
  variables: Record<string, string>,
  fallback: () => string,
): Promise<string> {
  const template = await loadSkillPromptTemplate(skillName, relativePaths);
  return template ? renderPromptTemplate(template, variables) : fallback();
}

function loadSkillPromptTemplateSync(skillName: string, relativePaths: string[]): string | undefined {
  const baseDir = path.join(homedir(), ".opencode", "skills", skillName);
  for (const relativePath of relativePaths) {
    const fullPath = path.join(baseDir, relativePath);
    try {
      const content = readFileSync(fullPath, "utf8").trim();
      if (content) {
        return content;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

async function loadSkillPromptTemplate(skillName: string, relativePaths: string[]): Promise<string | undefined> {
  const baseDir = path.join(homedir(), ".opencode", "skills", skillName);
  for (const relativePath of relativePaths) {
    const fullPath = path.join(baseDir, relativePath);
    try {
      const content = (await readFile(fullPath, "utf8")).trim();
      if (content) {
        return content;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? "");
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

function buildLocalContractDraftFallback(request: string, templateName: string): Record<string, unknown> {
  const parsed = parseContractDraftRequest(request);
  const feeMode = inferFeeModeFromRequest(request);
  const contractAmount = parsed.arbitrationFee ?? parsed.baseFee;
  const record: Record<string, unknown> = {
    项目名称: buildDraftProjectName(request) ?? templateName,
    客户名称: parsed.clientName ?? "【待补】",
    合同类型: templateName,
    "具体类型/案由": parsed.caseCause ?? "【待补】",
    联系方式: parsed.clientPhone ?? "",
    客户收件地址: parsed.clientAddress ?? "",
    "信用代码/身份证": parsed.clientIdCode ?? "",
  };
  if (contractAmount !== undefined) {
    record["合同金额"] = contractAmount;
  }
  return {
    docTitle: templateName,
    feeMode,
    markdown: `### ${templateName}\n\n根据已提供信息生成合同初稿。`,
    templateData: {},
    record,
  };
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

function buildCaseRecordLabel(fields: Record<string, unknown>): string {
  const caseNo = readFieldString(fields, "案号");
  const client = readFieldString(fields, "委托人");
  const counterparty = readFieldString(fields, "对方当事人");
  const cause = readFieldString(fields, "案由");
  if (caseNo) {
    return caseNo;
  }
  if (client && counterparty) {
    return `${client} vs ${counterparty}${cause ? ` ${cause}` : ""}`;
  }
  return client ?? counterparty ?? cause ?? "未命名案件";
}

function readCaseRecencyTime(fields: Record<string, unknown>): number {
  return readFieldTime(fields, "创建时间")
    ?? readFieldTime(fields, "日期")
    ?? readFieldTime(fields, "开庭日")
    ?? readFieldTime(fields, "举证截止日")
    ?? 0;
}

function readFieldTime(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return normalizeTimestampMs(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return normalizeTimestampMs(numeric);
    }
    const parsed = Date.parse(value.replace(/\//g, "-"));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeTimestampMs(value: number): number {
  return value < 10_000_000_000 ? value * 1_000 : value;
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
  copyUserArray(input, fields, "承揽人");
  copyUserArray(input, fields, "承办人");
  return fields;
}

function normalizeContractRecordForDraft(
  record: Record<string, unknown> | null,
  request: string,
  requesterOpenId?: string,
): Record<string, unknown> {
  const fields = normalizeContractRecord(record);
  const projectName = buildDraftProjectName(request, fields);
  if (projectName) {
    fields["项目名称"] = projectName;
  }
  return withDefaultContractOwners(fields, requesterOpenId);
}

export function normalizeInvoiceRecord(
  record: Record<string, unknown> | null,
  options: { matchHints?: Record<string, unknown> | null; summary?: string | undefined } = {},
): Record<string, unknown> {
  const input = record ?? {};
  const fields: Record<string, unknown> = {};
  copyString(input, fields, "合同号");
  copyInvoicePayer(input, fields, options);
  copyString(input, fields, "发票号");
  copyDate(input, fields, "开票日期");
  copyNumber(input, fields, "发票金额");
  return fields;
}

export function normalizeCaseRecord(record: Record<string, unknown> | null): Record<string, unknown> {
  const input = record ?? {};
  const fields: Record<string, unknown> = {};
  copyNormalizedString(input, fields, "类型", normalizeCaseTypeValue);
  copyNormalizedString(input, fields, "案由", normalizeCaseCauseValue);
  copyString(input, fields, "委托人");
  copyString(input, fields, "对方当事人");
  copyString(input, fields, "联系人");
  copyString(input, fields, "联系方式");
  copyString(input, fields, "案号");
  copyString(input, fields, "审理法院");
  copyAliasString(input, fields, "受理机构", "审理法院");
  copyNormalizedStringArray(input, fields, "程序阶段", normalizeCaseStageValue);
  copyNormalizedString(input, fields, "案件状态", normalizeCaseStatusValue);
  copyNormalizedString(input, fields, "重要紧急程度", normalizeCasePriorityValue);
  copyDate(input, fields, "日期");
  copyDate(input, fields, "开庭日");
  copyString(input, fields, "开庭地点");
  copyDate(input, fields, "举证截止日");
  copyDate(input, fields, "反诉截止日");
  copyDate(input, fields, "管辖权异议截止日");
  copyDate(input, fields, "上诉截止日");
  copyNormalizedStringArray(input, fields, "主办律师", normalizeCaseLawyerValue);
  copyAliasNormalizedStringArray(input, fields, "承办律师", "主办律师", normalizeCaseLawyerValue);
  copyString(input, fields, "待做事项");
  copyString(input, fields, "进展");
  appendCaseStatusDetail(input, fields);
  copyString(input, fields, "备注");
  return fields;
}

type CaseReminderDateField =
  | "开庭日"
  | "举证截止日"
  | "反诉截止日"
  | "管辖权异议截止日"
  | "上诉截止日"
  | "查封到期日";

type CaseReminderDateMatch = {
  raw: string;
  timestamp: number;
  display: string;
  start: number;
  end: number;
};

type ParsedCaseReminderRequest = {
  target?: string | undefined;
  dateField: CaseReminderDateField;
  dateValue: number;
  dateDisplay: string;
  todo?: string | undefined;
};

function parseCaseReminderRequest(request: string, now = new Date()): ParsedCaseReminderRequest {
  const text = request.trim();
  if (!text) {
    throw new Error("请补充提醒内容。示例：/添加案件提醒 举证截止日 2026-04-18 待做事项 补充工资流水证据");
  }

  const dateField = inferCaseReminderDateField(text);
  if (!dateField) {
    throw new Error("请说明提醒类型，例如：举证截止日、开庭日、上诉截止日。");
  }

  const date = extractCaseReminderDate(text, now);
  if (!date) {
    throw new Error("请提供提醒日期，例如：2026-04-18、04-18 09:30、明天 17:00。");
  }

  return {
    target: extractCaseReminderTarget(text, date),
    dateField,
    dateValue: date.timestamp,
    dateDisplay: date.display,
    todo: extractCaseReminderTodo(text, date),
  };
}

function inferCaseReminderDateField(text: string): CaseReminderDateField | undefined {
  const candidates: Array<{ field: CaseReminderDateField; patterns: RegExp[] }> = [
    { field: "管辖权异议截止日", patterns: [/管辖权异议/] },
    { field: "反诉截止日", patterns: [/反诉/] },
    { field: "上诉截止日", patterns: [/上诉/] },
    { field: "查封到期日", patterns: [/查封/] },
    { field: "举证截止日", patterns: [/举证/, /证据截止/] },
    { field: "开庭日", patterns: [/开庭/, /庭审/] },
  ];
  return candidates.find((candidate) => candidate.patterns.some((pattern) => pattern.test(text)))?.field;
}

function extractCaseReminderDate(text: string, now: Date): CaseReminderDateMatch | undefined {
  const relative = text.match(/(今天|今日|明天|后天)(?:\s*(\d{1,2}[:：]\d{2}(?::\d{2})?))?/);
  if (relative?.index !== undefined) {
    const timestamp = parseRelativeCaseReminderDate(relative[1]!, relative[2], now);
    if (typeof timestamp === "number") {
      return {
        raw: relative[0],
        timestamp,
        display: formatCaseDeadlineDisplay(timestamp),
        start: relative.index,
        end: relative.index + relative[0].length,
      };
    }
  }

  const absolute = text.match(/(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2}(?::\d{2})?)?|\d{1,2}[./-]\d{1,2}(?:\s+\d{1,2}[:：]\d{2}(?::\d{2})?)?)/);
  if (absolute?.index === undefined) {
    return undefined;
  }

  const normalized = normalizeCaseReminderDateText(absolute[1]!, now);
  const timestamp = normalizeBitableDateValue(normalized, now);
  if (typeof timestamp !== "number") {
    return undefined;
  }
  return {
    raw: absolute[0],
    timestamp,
    display: formatCaseDeadlineDisplay(timestamp),
    start: absolute.index,
    end: absolute.index + absolute[0].length,
  };
}

function parseRelativeCaseReminderDate(keyword: string, timeText: string | undefined, now: Date): number | undefined {
  const dayOffset = keyword === "明天" ? 1 : keyword === "后天" ? 2 : 0;
  const [hour = 0, minute = 0, second = 0] = (timeText ?? "00:00:00")
    .replace("：", ":")
    .split(":")
    .map((value) => Number(value));
  if (![hour, minute, second].every((value) => Number.isFinite(value))) {
    return undefined;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, second).getTime();
}

function normalizeCaseReminderDateText(value: string, now: Date): string {
  const normalized = value
    .replace(/年/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .replace(/[./]/g, "-")
    .replace(/：/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  if (/^\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(normalized)) {
    return `${now.getFullYear()}-${normalized}`;
  }
  return normalized;
}

function extractCaseReminderTarget(text: string, date: CaseReminderDateMatch): string | undefined {
  const explicit = text.match(/(?:案号|案件编号|案件|委托人|客户|当事人)[:：]?\s*([^，,；;\s]+)/);
  const explicitTarget = cleanupCaseReminderTarget(explicit?.[1]);
  if (explicitTarget) {
    return explicitTarget;
  }

  const prefix = cleanupCaseReminderTarget(text.slice(0, date.start));
  return prefix;
}

function cleanupCaseReminderTarget(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/^(给|为|把|将|最近|最新|当前|这个|该)\s*/, "")
    .replace(/[，,；;：:\s]+$/g, "")
    .replace(/(?:管辖权异议截止日?|反诉截止日?|上诉截止日?|举证截止日?|查封到期日?|开庭日?|庭审|截止|到期)+$/g, "")
    .replace(/[，,；;：:\s]+$/g, "")
    .trim();
  if (!cleaned || /^(案件|最近案件|最新案件|当前案件)$/.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function extractCaseReminderTodo(text: string, date: CaseReminderDateMatch): string | undefined {
  const explicit = text.match(/(?:待做事项|待办事项|待办|提醒内容|内容|事项)[:：]?\s*(.+)$/);
  if (explicit?.[1]) {
    return cleanupCaseReminderTodo(explicit[1], date.raw);
  }
  return cleanupCaseReminderTodo(text.slice(date.end), date.raw);
}

function cleanupCaseReminderTodo(value: string, dateRaw: string): string | undefined {
  const cleaned = value
    .replace(dateRaw, "")
    .replace(/^(提醒|待做事项|待办事项|待办|提醒内容|内容|事项|为|：|:|，|,|；|;|\s)+/g, "")
    .replace(/[，,；;\s]+$/g, "")
    .trim();
  return cleaned || undefined;
}

function selectCaseRecordForReminder(
  records: Array<{ recordId: string; fields: Record<string, unknown> }>,
  target: string | undefined,
): { recordId: string; fields: Record<string, unknown> } | undefined {
  const sorted = [...records].sort((left, right) => readCaseRecencyTime(right.fields) - readCaseRecencyTime(left.fields));
  if (!target) {
    return sorted[0];
  }
  const normalizedTarget = normalizeCaseSearchText(target);
  return sorted.find((item) => {
    const haystack = normalizeCaseSearchText([
      buildCaseRecordLabel(item.fields),
      readFieldString(item.fields, "案号"),
      readFieldString(item.fields, "委托人"),
      readFieldString(item.fields, "对方当事人"),
      readFieldString(item.fields, "案由"),
      readFieldString(item.fields, "程序阶段"),
      readFieldString(item.fields, "案件状态"),
    ].filter(Boolean).join(" "));
    return haystack.includes(normalizedTarget);
  });
}

function normalizeCaseSearchText(value: string): string {
  return value.replace(/[案\s,，;；:：()（）【】[\]《》-]/g, "").trim();
}

function mergeCaseTodo(existing: string | undefined, todo: string): string {
  if (!existing) {
    return todo;
  }
  if (existing.includes(todo)) {
    return existing;
  }
  return `${existing}、${todo}`;
}

function copyString(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (typeof value === "string" && value.trim()) {
    target[key] = value.trim();
  }
}

function copyAliasString(source: Record<string, unknown>, target: Record<string, unknown>, sourceKey: string, targetKey: string): void {
  if (target[targetKey]) {
    return;
  }
  const value = source[sourceKey];
  if (typeof value === "string" && value.trim()) {
    target[targetKey] = value.trim();
  }
}

function copyInvoicePayer(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  options: { matchHints?: Record<string, unknown> | null; summary?: string | undefined } = {},
): void {
  const direct = readFirstString(source, ["付款方", "购买方", "购方名称", "购买方名称", "买方", "客户名称", "委托人"]);
  const alias = readFirstString(source, ["购买方", "购方名称", "购买方名称", "买方", "客户名称", "委托人"]);
  const hintClient = readFirstString(options.matchHints ?? {}, ["clientName", "payer", "buyerName", "customerName"]);
  const summaryClient = extractInvoiceClientFromSummary(options.summary ?? "");
  const fallback = [alias, hintClient, summaryClient].find((item) => item && !isLawFirmName(item));
  const payer = direct && isLawFirmName(direct) ? fallback : (direct ?? fallback);
  if (payer) {
    target["付款方"] = payer;
  }
}

function extractInvoiceClientFromSummary(summary: string): string | undefined {
  const match = summary.match(/(?:付款方|购买方|购方|客户|委托人)\s*[：:]?\s*([^，,；;\n]+)/);
  const value = match?.[1]?.trim();
  return value && !isLawFirmName(value) ? value : undefined;
}

function readFirstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isLawFirmName(value: string): boolean {
  return /律师事务所|律所|隆安/.test(value);
}

function copyNormalizedString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  normalize: (value: string) => string | undefined,
): void {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  const normalized = normalize(value.trim());
  if (normalized) {
    target[key] = normalized;
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

function copyUserArray(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const users = normalizeUserFieldValue(source[key]);
  if (users.length > 0) {
    target[key] = users;
  }
}

function copyNormalizedStringArray(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  normalize: (value: string) => string | undefined,
): void {
  const values = readStringArrayValue(source[key])
    .map((item) => normalize(item))
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (values.length > 0) {
    target[key] = Array.from(new Set(values));
  }
}

function copyAliasNormalizedStringArray(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
  normalize: (value: string) => string | undefined,
): void {
  if (target[targetKey]) {
    return;
  }
  const values = readStringArrayValue(source[sourceKey])
    .map((item) => normalize(item))
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (values.length > 0) {
    target[targetKey] = Array.from(new Set(values));
  }
}

function readStringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/[、,，/]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function normalizeUserFieldValue(value: unknown): Array<{ id: string }> {
  if (typeof value === "string" && value.trim()) {
    return [{ id: value.trim() }];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const users = value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) {
      return [{ id: item.trim() }];
    }
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && (item as { id: string }).id.trim()) {
      return [{ id: (item as { id: string }).id.trim() }];
    }
    return [];
  });
  return dedupeUserFieldValue(users);
}

function withDefaultContractOwners(fields: Record<string, unknown>, requesterOpenId?: string): Record<string, unknown> {
  if (!requesterOpenId?.trim()) {
    return fields;
  }
  const fallback = [{ id: requesterOpenId.trim() }];
  return {
    ...fields,
    承揽人: hasUserFieldValue(fields["承揽人"]) ? fields["承揽人"] : fallback,
    承办人: hasUserFieldValue(fields["承办人"]) ? fields["承办人"] : fallback,
  };
}

function hasUserFieldValue(value: unknown): value is Array<{ id: string }> {
  return Array.isArray(value)
    && value.some((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && (item as { id: string }).id.trim().length > 0);
}

function dedupeUserFieldValue(users: Array<{ id: string }>): Array<{ id: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ id: string }> = [];
  for (const user of users) {
    if (seen.has(user.id)) {
      continue;
    }
    seen.add(user.id);
    deduped.push(user);
  }
  return deduped;
}

function appendCaseStatusDetail(source: Record<string, unknown>, target: Record<string, unknown>): void {
  if (target["进展"]) {
    return;
  }
  const rawStatus = typeof source["案件状态"] === "string" ? source["案件状态"].trim() : "";
  if (!rawStatus) {
    return;
  }
  const normalizedStatus = normalizeCaseStatusValue(rawStatus);
  if (normalizedStatus && normalizedStatus !== rawStatus) {
    target["进展"] = rawStatus;
  }
}

function normalizeCaseTypeValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("劳动仲裁")) {
    return "劳动仲裁";
  }
  return normalized;
}

function normalizeCaseCauseValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "违法解除劳动合同争议" || normalized.includes("劳动合同") || normalized.includes("劳动争议")) {
    return "劳动争议";
  }
  return normalized;
}

function normalizeCaseStageValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "劳动仲裁" || normalized === "仲裁") {
    return "仲裁阶段";
  }
  return normalized;
}

function normalizeCaseStatusValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (["进行中", "未结", "执行中", "已结案"].includes(normalized)) {
    return normalized;
  }
  if (normalized.includes("证据") || normalized.includes("整理") || normalized.includes("开庭") || normalized.includes("处理中")) {
    return "进行中";
  }
  if (normalized.includes("执行")) {
    return "执行中";
  }
  if (normalized.includes("结案") || normalized.includes("已结")) {
    return "已结案";
  }
  return normalized;
}

function normalizeCasePriorityValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (["重要紧急", "紧急不重要", "重要不紧急", "不紧急不重要"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "高") {
    return "重要紧急";
  }
  if (normalized === "中") {
    return "重要不紧急";
  }
  if (normalized === "低") {
    return "不紧急不重要";
  }
  return normalized;
}

function normalizeCaseLawyerValue(value: string): string | undefined {
  const normalized = value.trim().replace(/律师$/u, "");
  return normalized || undefined;
}

type ContractTemplateRenderData = {
  client_name: string;
  client_representative: string;
  client_representative_line: string;
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
  arbitration_line: string;
  first_instance_line: string;
  second_instance_line: string;
  enforcement_line: string;
  settlement_line: string;
  stage_fee_line: string;
  risk_fee_line: string;
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
  stage_fee_intro: string;
  risk_fee_intro: string;
  base_fee_clause: string;
  risk_fee_clause: string;
  risk_fee_followup_clause_1: string;
  risk_fee_followup_clause_2: string;
  sign_client_line: string;
  sign_date_line: string;
  signature_line: string;
  risk_notice_client_name: string;
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
  const finalizeResult = await spawnPythonTool<{
    outputPath: string;
  }>("contract_finalize", {
    inputPath: docxPath,
    outputPath: docxPath,
    data: {
      client_name: renderData.client_name,
      client_id_code: renderData.client_id_code,
      client_address: renderData.client_address,
      client_phone: renderData.client_phone,
      client_representative: renderData.client_representative,
      lead_lawyer: renderData.lead_lawyer,
      counterparty_name: renderData.counterparty_name,
      case_cause: renderData.case_cause,
      is_company: Boolean(renderData.client_representative_line),
      show_risk_notice: renderData.show_risk_notice,
      is_stage_fixed: renderData.is_stage_fixed,
      engage_arbitration: renderData.arbitration_line.length > 0,
      engage_first_instance: renderData.first_instance_line.length > 0,
      engage_second_instance: renderData.second_instance_line.length > 0,
      engage_enforcement: renderData.enforcement_line.length > 0,
      engage_settlement: renderData.settlement_line.length > 0,
      fee_arbitration_clause: renderData.fee_arbitration_clause,
      fee_first_instance_clause: renderData.fee_first_instance_clause,
      fee_second_instance_clause: renderData.fee_second_instance_clause,
      fee_enforcement_clause: renderData.fee_enforcement_clause,
    },
  });
  if (!finalizeResult.ok) {
    throw new Error(finalizeResult.error);
  }
  return docxPath;
}

async function ensureTaggedContractTemplate(dataDir: string, templatePath: string): Promise<string> {
  const TEMPLATE_CACHE_VERSION = "v2";
  const templateDir = path.join(dataDir, "contract-template-cache");
  await mkdir(templateDir, { recursive: true });
  const cachePath = path.join(
    templateDir,
    `${path.basename(templatePath, path.extname(templatePath))}.${TEMPLATE_CACHE_VERSION}.docxtpl.docx`,
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
    /(<w:t[^>]*>聘请方（甲方）：)[\s\S]*?(<\/w:t>)/,
    "$1{client_name}$2",
  );
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
    ["法定代表人/负责人：                                               ", "{client_representative_line}", "client_representative_line"],
    ["证件号/社会统一信用代码（必填）：                                         ", "证件号/社会统一信用代码（必填）：{client_id_code}", "client_id_code"],
    ["地址（必填）：              ", "地址（必填）：{client_address}", "client_address"],
    ["电子邮箱：                   ", "电子邮箱：{client_email}", "client_email"],
    ["联系电话（必填）：                         ", "联系电话（必填）：{client_phone}", "client_phone"],
    ["甲方因与【案件当事人】【案由】纠纷          案件，委托乙方代理，经双方协商，订立下列各条款，共同遵照履行。", "甲方因与{counterparty_name}{case_cause}纠纷案件，委托乙方代理，经双方协商，订立下列各条款，共同遵照履行。", "case_intro"],
    ["□仲裁阶段；", "{arbitration_line}", "engage_arbitration"],
    ["□一审诉讼；", "{first_instance_line}", "engage_first_instance"],
    ["□二审诉讼；", "{second_instance_line}", "engage_second_instance"],
    ["□执行程序；", "{enforcement_line}", "engage_enforcement"],
    ["□上述案件代理程序中，有关调解、和解事宜。", "{settlement_line}", "engage_settlement"],
    ["（一）乙方指派  ***  律师作为案件中甲方的委托代理人，甲方同意上述律师指派其他律师和助理配合完成辅助工作，但乙方更换代理律师应取得甲方认可。", "（一）乙方指派 {lead_lawyer} 律师作为案件中甲方的委托代理人，甲方同意上述律师指派其他律师和助理配合完成辅助工作，但乙方更换代理律师应取得甲方认可。", "lead_lawyer"],
    ["□按阶段收费", "{stage_fee_line}", "stage_fee_line"],
    ["甲乙双方约定乙方律师费如下：", "{stage_fee_intro}", "stage_fee_intro"],
    ["1.仲裁阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），甲方在本合同签署后", "{fee_arbitration_clause}", "fee_arbitration_clause"],
    ["三日内一次性向乙方支付。", "", "fee_arbitration_clause_tail"],
    ["2.一审阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），甲方在本合同签署后三日内一次性向乙方支付。", "{fee_first_instance_clause}", "fee_first_instance_clause"],
    ["3.二审阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），若二审由甲方提起，则在甲方确定提起上诉之前一次性向乙方支付；若二审由其他诉讼当事人提起，则在收到上诉状之日起三日内一次性向乙方支付。", "{fee_second_instance_clause}", "fee_second_instance_clause"],
    ["4.执行阶段：律师代理费为￥*0,000.00元（大写人民币*万元整），在甲方确定乙方代理执行程序之前一次性支付。", "{fee_enforcement_clause}", "fee_enforcement_clause"],
    ["□基础收费+风险收费", "{risk_fee_line}", "risk_fee_line"],
    ["甲乙双方选择风险代理收费方式，即律师费由基础费用和风险收费两部分组成：", "{risk_fee_intro}", "risk_fee_intro"],
    ["1.基础费用：￥***00.00元（大写***元整），在签订合同后三日内支付。", "{base_fee_clause}", "base_fee_clause"],
    ["2.风险收费：按照案件胜诉并收回款项金额的*%（百分之*）收取，即甲方在案件中以任何形式（包括债务人主动给付、和解、调解或判决后给付以及通过法院强制执行等）收回的与案件有关的款项、有形资产或其他财产权益，甲方按实际收回的本金、违约金、利息以及所获得的其他有形资产或财产权益（如有）价值金额的*%（百分之*）向乙方支付律师费，甲方应在每次收回款项或权益之日起三日内向乙方支付该律师费。对于作为被告的案件，乙方代理后甲方胜诉或调解结案的，甲方按照被减免债务金额的*%（百分之*）向乙方支付律师费，该律师费甲方应在收到生效裁判文书之日起三日内向乙方支付。", "{risk_fee_clause}", "risk_fee_clause"],
    ["如果甲方实际收到的是现金以外的有形资产或财产权益，乙方有权选择以评估金额或实际变现金额为依据计算律师费。", "{risk_fee_followup_clause_1}", "risk_fee_followup_clause_1"],
    ["对于风险收费，甲方只要有回款或有回收其他有形资产或财产权益，就应按照约定支付律师费，无需等案件的全部标的额收回再支付律师费。", "{risk_fee_followup_clause_2}", "risk_fee_followup_clause_2"],
    ["甲、乙双方如果发生争议，应当友好协商解决。如协商不成，任何一方均有权将争议提交至深圳国际仲裁院仲裁，按照提交仲裁时深圳国际仲裁院现行有效的仲裁规则进行仲裁。仲裁裁决是终局的，对双方当事人均有约束力。", "{dispute_resolution_clause}", "dispute_resolution_clause"],
    ["附：《风险代理告知书》", "{attachment_notice_title}", "attachment_notice_title"],
    ["（以下无正文，为本合同签署处及附件）", "{attachment_notice_suffix}", "attachment_notice_suffix"],
    ["甲方：                                   乙方：北京市隆安（深圳）律师事务所", "{sign_client_line}", "sign_client_name"],
    ["法定代表人/负责人/授权代表：__________   承办律师：_________________                                          ", "{signature_line}", "signature_line"],
    ["签约时间：  202 年   月     日           ", "{sign_date_line}", "sign_date_line"],
    ["<w:t>附件</w:t>", "<w:t>{#show_risk_notice}附件</w:t>", "show_risk_notice_open"],
    ["委托人：", "委托人：{risk_notice_client_name}", "risk_notice_client_name"],
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
  const parsed = parseContractDraftRequest(request);
  const counterparty = parsed.counterpartyName
    ?? extractPartyFromText(request, /(?:对方当事人|对方)(?:为|是)?[:：]?\s*([^\n；;，,。]+)/)
    ?? "XXX公司";

  if (/委托代理合同/.test(templateName)) {
    return `委托代理合同（${normalizePartyForFileName(clientName)}vs${normalizePartyForFileName(counterparty)}）`;
  }
  return `${templateName}（${normalizePartyForFileName(clientName)}vs${normalizePartyForFileName(counterparty)}）`;
}

export function buildContractTemplateRenderData(
  request: string,
  record: Record<string, unknown> | null,
  templateData: Record<string, unknown> | null,
  feeMode: string,
): ContractTemplateRenderData {
  const parsed = parseContractDraftRequest(request);
  const resolvedFeeMode = feeMode || readString(templateData, "fee_mode") || "stage_fixed";
  const isRiskFee = resolvedFeeMode === "base_plus_risk";
  const isStageFixed = !isRiskFee;
  const clientName = parsed.clientName
    ?? readString(templateData, "client_name")
    ?? readString(record, "客户名称")
    ?? extractPartyFromText(request, /甲方(?:为|是)?[:：]?\s*([^\n；;，,。]+)/)
    ?? "【待补】";
  const clientRepresentative = parsed.clientRepresentative ?? readString(templateData, "client_representative") ?? "";
  const clientIdCode = parsed.clientIdCode
    ?? readString(templateData, "client_id_code")
    ?? readString(record, "信用代码/身份证")
    ?? "【待补】";
  const clientAddress = parsed.clientAddress
    ?? readString(templateData, "client_address")
    ?? readString(record, "客户收件地址")
    ?? "【待补】";
  const clientEmail = readString(templateData, "client_email") ?? "";
  const clientPhone = parsed.clientPhone
    ?? readString(templateData, "client_phone")
    ?? readString(record, "联系方式")
    ?? "【待补】";
  const counterpartyName = parsed.counterpartyName
    ?? readString(templateData, "counterparty_name")
    ?? extractPartyFromText(request, /(?:对方当事人|对方)(?:为|是)?[:：]?\s*([^\n；;。]+)/)
    ?? "【待补】";
  const caseCause = parsed.caseCause
    ?? readString(templateData, "case_cause")
    ?? readString(record, "具体类型/案由")
    ?? extractPartyFromText(request, /案由(?:为|是)?[:：]?\s*([^\n；;。]+)/)
    ?? "【待补】";
  const leadLawyer = parsed.leadLawyer
    ?? readString(templateData, "lead_lawyer")
    ?? extractPartyFromText(request, /承办律师(?:为|是)?[:：]?\s*([^\n；;，,。]+)/)
    ?? "【待补】";
  const signDateText = formatContractSignDate(readString(templateData, "sign_date"));
  const engageArbitration = parsed.engageArbitration ?? readBoolean(templateData, "engage_arbitration") ?? /仲裁/.test(request);
  const engageFirstInstance = parsed.engageFirstInstance ?? readBoolean(templateData, "engage_first_instance") ?? /一审/.test(request);
  const engageSecondInstance = parsed.engageSecondInstance ?? readBoolean(templateData, "engage_second_instance") ?? /二审/.test(request);
  const engageEnforcement = parsed.engageEnforcement ?? readBoolean(templateData, "engage_enforcement") ?? /执行/.test(request);
  const engageSettlement = parsed.engageSettlement ?? readBoolean(templateData, "engage_settlement") ?? /(调解|和解)/.test(request);
  const specialTerms = [
    parsed.expenseModeText,
    parsed.specialTerms ?? readString(templateData, "special_terms"),
  ].filter((item): item is string => Boolean(item?.trim())).join("；");
  const isCompany = inferIsCompany(clientName, clientIdCode, clientRepresentative);
  const arbitrationAmount = parsed.arbitrationFee ?? extractMoneyFromClause(readString(templateData, "fee_arbitration_clause"));
  const firstInstanceAmount = parsed.firstInstanceFee ?? extractMoneyFromClause(readString(templateData, "fee_first_instance_clause"));
  const secondInstanceAmount = parsed.secondInstanceFee ?? extractMoneyFromClause(readString(templateData, "fee_second_instance_clause"));
  const enforcementAmount = parsed.enforcementFee ?? extractMoneyFromClause(readString(templateData, "fee_enforcement_clause"));
  const riskBaseAmount = parsed.baseFee ?? extractMoneyFromClause(readString(templateData, "base_fee_clause"));
  const arbitrationChinese = parsed.arbitrationFeeChinese;
  const representativeLine = isCompany ? `法定代表人/负责人：${clientRepresentative}` : "";
  const signClientLine = "甲方：                                   乙方：北京市隆安（深圳）律师事务所";
  const signDateLine = "签约时间：  202 年   月     日           ";
  const signatureLine = "法定代表人/负责人/授权代表：__________   承办律师：_____________                                          ";

  return {
    client_name: clientName,
    client_representative: clientRepresentative,
    client_representative_line: representativeLine,
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
    arbitration_line: engageArbitration ? "☑仲裁阶段；" : "",
    first_instance_line: engageFirstInstance ? "☑一审诉讼；" : "",
    second_instance_line: engageSecondInstance ? "☑二审诉讼；" : "",
    enforcement_line: engageEnforcement ? "☑执行程序；" : "",
    settlement_line: engageSettlement ? "☑上述案件代理程序中，有关调解、和解事宜。" : "",
    stage_fee_line: isStageFixed ? "☑按阶段收费" : "",
    risk_fee_line: isRiskFee ? "☑基础收费+风险收费" : "",
    attachment_notice_title: isRiskFee ? "附：《风险代理告知书》" : "",
    attachment_notice_suffix: isRiskFee ? "（以下无正文，为本合同签署处及附件）" : "（以下无正文，为本合同签署处）",
    sign_client_line: signClientLine,
    sign_date_line: signDateLine,
    dispute_resolution_clause: readString(templateData, "dispute_resolution_clause")
      ?? "甲、乙双方如果发生争议，应当友好协商解决。如协商不成，任何一方均有权将争议提交至深圳国际仲裁院仲裁，按照提交仲裁时深圳国际仲裁院现行有效的仲裁规则进行仲裁。仲裁裁决是终局的，对双方当事人均有约束力。",
    special_terms_clause: specialTerms || "",
    has_special_terms: Boolean(specialTerms),
    is_stage_fixed: isStageFixed,
    is_risk_fee: isRiskFee,
    show_risk_notice: isRiskFee,
    stage_fee_intro: isStageFixed ? "甲乙双方约定乙方律师费如下：" : "",
    risk_fee_intro: isRiskFee ? "甲乙双方选择风险代理收费方式，即律师费由基础费用和风险收费两部分组成：" : "",
    fee_arbitration_clause: engageArbitration && arbitrationAmount
      ? buildStageFeeClause("1.仲裁阶段", arbitrationAmount, arbitrationChinese ?? formatChineseMoney(arbitrationAmount), "甲方在本合同签署后三日内一次性向乙方支付。")
      : "",
    fee_first_instance_clause: engageFirstInstance && firstInstanceAmount
      ? buildStageFeeClause("2.一审阶段", firstInstanceAmount, formatChineseMoney(firstInstanceAmount), "甲方在本合同签署后三日内一次性向乙方支付。")
      : "",
    fee_second_instance_clause: engageSecondInstance && secondInstanceAmount
      ? buildStageFeeClause("3.二审阶段", secondInstanceAmount, formatChineseMoney(secondInstanceAmount), "若二审由甲方提起，则在甲方确定提起上诉之前一次性向乙方支付；若二审由其他诉讼当事人提起，则在收到上诉状之日起三日内一次性向乙方支付。")
      : "",
    fee_enforcement_clause: engageEnforcement && enforcementAmount
      ? buildStageFeeClause("4.执行阶段", enforcementAmount, formatChineseMoney(enforcementAmount), "在甲方确定乙方代理执行程序之前一次性支付。")
      : "",
    base_fee_clause: isRiskFee && riskBaseAmount
      ? `1.基础费用：￥${formatMoney(riskBaseAmount)}元（大写${formatChineseMoney(riskBaseAmount)}），在签订合同后三日内支付。`
      : "",
    risk_fee_clause: isRiskFee ? (readString(templateData, "risk_fee_clause") ?? "2.风险收费：按照双方另行确认的比例和条件执行。") : "",
    risk_fee_followup_clause_1: isRiskFee ? (readString(templateData, "risk_fee_followup_clause_1") ?? "如果甲方实际收到的是现金以外的有形资产或财产权益，乙方有权选择以评估金额或实际变现金额为依据计算律师费。") : "",
    risk_fee_followup_clause_2: isRiskFee ? (readString(templateData, "risk_fee_followup_clause_2") ?? "对于风险收费，甲方只要有回款或回收其他有形资产或财产权益，就应按照约定支付律师费，无需等案件的全部标的额收回再支付律师费。") : "",
    signature_line: signatureLine,
    risk_notice_client_name: "",
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

type ParsedContractDraftRequest = {
  clientName?: string | undefined;
  clientIdCode?: string | undefined;
  clientAddress?: string | undefined;
  clientPhone?: string | undefined;
  clientRepresentative?: string | undefined;
  counterpartyName?: string | undefined;
  caseCause?: string | undefined;
  leadLawyer?: string | undefined;
  engageArbitration?: boolean | undefined;
  engageFirstInstance?: boolean | undefined;
  engageSecondInstance?: boolean | undefined;
  engageEnforcement?: boolean | undefined;
  engageSettlement?: boolean | undefined;
  arbitrationFee?: number | undefined;
  arbitrationFeeChinese?: string | undefined;
  firstInstanceFee?: number | undefined;
  secondInstanceFee?: number | undefined;
  enforcementFee?: number | undefined;
  baseFee?: number | undefined;
  expenseModeText?: string | undefined;
  specialTerms?: string | undefined;
};

export function parseContractDraftRequest(text: string): ParsedContractDraftRequest {
  const normalized = text.replace(/\r\n/g, "\n");
  const clientName = firstMatch(normalized, [
    /甲方（委托人）[:：]\s*([^\n；;，,。]+)/,
    /甲方[:：]\s*([^\n；;，,。]+)/,
    /甲方(?:为|是)\s*([^\n；;，,。]+)/,
    /甲方(?:（委托人）)?\s*([^\n；;，,。]+?)(?=，(?:身份证号|证件号|统一社会信用代码|社会统一信用代码|住址|地址|联系电话|联系方式|手机号码|手机号)|[；;。]|$)/,
    /委托人[:：]\s*([^\n；;，,。]+)/,
    /委托人\s*([^\n；;，,。]+?)(?=，(?:身份证号|证件号|统一社会信用代码|社会统一信用代码|住址|地址|联系电话|联系方式|手机号码|手机号)|[；;。]|$)/,
  ]);
  const clientIdCode = firstMatch(normalized, [
    /(?:身份证号|证件号|统一社会信用代码|社会统一信用代码)[:：]\s*([0-9A-Za-zXx*]+)/,
    /(?:身份证号|证件号|统一社会信用代码|社会统一信用代码)\s*([0-9A-Za-zXx*]+)/,
  ]);
  const clientAddress = firstMatch(normalized, [
    /(?:住址|地址)[:：]\s*([^\n；;。]+?)(?=，(?:联系电话|联系方式|手机号码|手机号)|[。；;\n]|$)/,
    /(?:住址|地址)\s*([^\n；;。]+?)(?=，(?:联系电话|联系方式|手机号码|手机号)|[。；;\n]|$)/,
  ]);
  const clientPhone = firstMatch(normalized, [
    /(?:联系电话|联系方式|手机号码|手机号)[:：]\s*([0-9-+（）() ]{6,})/,
    /(?:联系电话|联系方式|手机号码|手机号)\s*([0-9-+（）() ]{6,})/,
  ])?.replace(/\s+/g, "");
  const clientRepresentative = firstMatch(normalized, [
    /(?:法定代表人|负责人)[:：]\s*([^\n；;，,。]+)/,
  ]);
  const counterpartyName = firstMatch(normalized, [
    /因与([^，,。；;\n]+?)发生[^，,。；;\n]*(?:纠纷|争议)/,
    /对方当事人(?:为|是)?[:：]\s*([^\n；;。]+)/,
    /对方当事人(?:为|是)?\s*([^\n；;，,。]+)/,
    /对方(?:为|是)?[:：]\s*([^\n；;。]+)/,
    /对方(?:为|是)?\s*([^\n；;，,。]+)/,
  ]);
  const caseCause = firstMatch(normalized, [
    /发生([^，,。；;\n]*?(?:纠纷|争议))/,
    /案由(?:为|是)?[:：]\s*([^\n；;。]+)/,
    /案由(?:为|是)?\s*([^\n；;，,。]+)/,
  ]);
  const leadLawyer = firstMatch(normalized, [
    /承办律师(?:为|是)?[:：]\s*([^\n；;，,。]+)/,
    /承办律师(?:为|是)?\s*([^\n；;，,。]+)/,
  ]);
  const expenseModeText = firstMatch(normalized, [
    /(办案费用实报实销)/,
    /(办案费用包干)/,
  ]);
  const specialTerms = firstMatch(normalized, [
    /特别约定[:：]\s*([^\n]+)/,
    /特别约定\s*([^\n]+)/,
  ]);

  const arbitrationFee = extractFeeForStage(normalized, "仲裁");
  const firstInstanceFee = extractFeeForStage(normalized, "一审");
  const secondInstanceFee = extractFeeForStage(normalized, "二审");
  const enforcementFee = extractFeeForStage(normalized, "执行");
  const baseFee = extractFeeForStage(normalized, "基础");
  const arbitrationFeeChinese = firstMatch(normalized, [
    /代理费用为人民币[\d,，.]+元（大写[:：]?\s*([^）)]+)）/,
    /仲裁[^。；;\n]*大写[:：]?\s*([^，,。；;\n]+)/,
  ]);

  return {
    clientName,
    clientIdCode,
    clientAddress,
    clientPhone,
    clientRepresentative,
    counterpartyName,
    caseCause,
    leadLawyer,
    expenseModeText,
    specialTerms,
    engageArbitration: /仲裁/.test(normalized),
    engageFirstInstance: /一审/.test(normalized),
    engageSecondInstance: /二审/.test(normalized),
    engageEnforcement: /执行/.test(normalized),
    engageSettlement: /(调解|和解)/.test(normalized),
    arbitrationFee,
    arbitrationFeeChinese,
    firstInstanceFee,
    secondInstanceFee,
    enforcementFee,
    baseFee,
  };
}

export function validateContractDraftRequest(templateName: string, request: string): void {
  if (!/委托代理合同/.test(templateName)) {
    return;
  }
  const parsed = parseContractDraftRequest(request);
  const missing: string[] = [];
  if (!parsed.clientName) missing.push("甲方/委托人");
  if (!parsed.clientIdCode) missing.push("证件号/身份证号/统一社会信用代码");
  if (!parsed.clientAddress) missing.push("地址/住址");
  if (!parsed.clientPhone) missing.push("联系电话");
  if (missing.length > 0) {
    throw new Error(`委托代理合同起草缺少必填信息：${missing.join("、")}。请补充后重试。`);
  }
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    const value = matched?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractFeeForStage(text: string, stage: string): number | undefined {
  const direct = text.match(new RegExp(`${stage}[^\\d]{0,12}([\\d,，]+(?:\\.\\d{1,2})?)\\s*元`));
  if (direct?.[1]) {
    return parseMoneyValue(direct[1]);
  }
  if (stage === "仲裁") {
    const general = text.match(/代理费用为人民币\s*([\d,，]+(?:\.\d{1,2})?)\s*元/);
    if (general?.[1]) {
      return parseMoneyValue(general[1]);
    }
  }
  return undefined;
}

function parseMoneyValue(value: string): number | undefined {
  const normalized = value.replace(/[，,]/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatMoney(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatChineseMoney(value: number): string {
  const integer = Math.round(value);
  const digits = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const units = ["", "拾", "佰", "仟"];
  const bigUnits = ["", "万", "亿"];
  const source = String(integer);
  const groups: string[] = [];
  for (let index = 0; index < source.length; index += 4) {
    groups.unshift(source.slice(Math.max(0, source.length - index - 4), source.length - index));
  }
  const rendered = groups.map((group, groupIndex) => {
    const chars = group.split("");
    let block = "";
    chars.forEach((char, index) => {
      const digit = Number(char);
      const unitIndex = chars.length - index - 1;
      if (digit === 0) {
        if (!block.endsWith("零") && block !== "") {
          block += "零";
        }
        return;
      }
      block += `${digits[digit]}${units[unitIndex]}`;
    });
    block = block.replace(/零+$/g, "");
    return block ? `${block}${bigUnits[groups.length - groupIndex - 1]}` : "";
  }).join("").replace(/零+/g, "零").replace(/零(万|亿)/g, "$1").replace(/零+$/g, "");
  return `${rendered || "零"}元整`;
}

function buildStageFeeClause(prefix: string, amount: number, chineseAmount: string, tail: string): string {
  return `${prefix}：律师代理费为￥${formatMoney(amount)}元（大写人民币${chineseAmount}），${tail}`;
}

function extractMoneyFromClause(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const matched = value.match(/￥\s*([\d,，]+(?:\.\d{1,2})?)\s*元/);
  return matched?.[1] ? parseMoneyValue(matched[1]) : undefined;
}

function inferIsCompany(clientName: string, clientIdCode: string, clientRepresentative: string): boolean {
  if (clientRepresentative.trim()) {
    return true;
  }
  if (/公司|事务所|中心|机构|集团|有限/.test(clientName)) {
    return true;
  }
  const normalizedId = clientIdCode.trim();
  if (/^\d{17}[\dXx]$/.test(normalizedId)) {
    return false;
  }
  return /^[0-9A-Z]{18}$/i.test(normalizedId);
}

function normalizePartyForFileName(value: string): string {
  return value
    .replace(/[《》“”"'`]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 30) || "XXX";
}

function buildDraftProjectName(request: string, record?: Record<string, unknown> | null): string | undefined {
  const parsed = parseContractDraftRequest(request);
  const clientName = parsed.clientName
    ?? readString(record ?? null, "客户名称")
    ?? readString(record ?? null, "甲方")
    ?? undefined;
  const counterpartyName = parsed.counterpartyName
    ?? readString(record ?? null, "对方当事人")
    ?? readString(record ?? null, "乙方")
    ?? undefined;
  if (!clientName || !counterpartyName) {
    return undefined;
  }
  const stageLabel = inferDraftProjectStageLabel(parsed, readString(record ?? null, "具体类型/案由"));
  return `${clientName} vs ${counterpartyName}${stageLabel}`;
}

function inferDraftProjectStageLabel(parsed: ParsedContractDraftRequest, caseCause?: string | undefined): string {
  if (parsed.engageArbitration) {
    return "劳动仲裁";
  }
  if (parsed.engageFirstInstance) {
    return "劳动争议一审";
  }
  if (parsed.engageSecondInstance) {
    return "劳动争议二审";
  }
  if (parsed.engageEnforcement) {
    return "劳动争议执行";
  }
  if ((caseCause ?? parsed.caseCause ?? "").includes("劳动")) {
    return "劳动争议";
  }
  return parsed.caseCause?.trim() || caseCause?.trim() || "委托事项";
}

function pickNearestDeadline(fields: Record<string, unknown>, now: number, lookaheadMs: number): { label: string; value: string } | null {
  const candidates = [
    "开庭日",
    "举证截止日",
    "反诉截止日",
    "管辖权异议截止日",
    "上诉截止日",
    "查封到期日",
  ].map((key) => {
    const time = readFieldTime(fields, key);
    if (typeof time !== "number") return null;
    if (time < now || time > now + lookaheadMs) return null;
    return { label: key, value: formatCaseDeadlineDisplay(time), time };
  }).filter((item): item is { label: string; value: string; time: number } => Boolean(item));
  candidates.sort((left, right) => left.time - right.time);
  return candidates[0]
    ? { label: candidates[0].label, value: candidates[0].value }
    : null;
}

function buildCaseReminderCandidates(
  fields: Record<string, unknown>,
  now: number,
  lookaheadMs: number,
): Array<{ line: string; haystack: string; priority: number; time: number; recency: number }> {
  const status = readFieldString(fields, "案件状态");
  if (status === "已结案") {
    return [];
  }

  const label = buildCaseRecordLabel(fields);
  const stage = readFieldString(fields, "程序阶段");
  const todo = readFieldString(fields, "待做事项");
  const recency = readCaseRecencyTime(fields);
  const nearestDeadline = pickNearestDeadline(fields, now, lookaheadMs);
  const lines: Array<{ line: string; haystack: string; priority: number; time: number; recency: number }> = [];

  for (const key of ["开庭日", "举证截止日", "反诉截止日", "管辖权异议截止日", "上诉截止日", "查封到期日"] as const) {
    const time = readFieldTime(fields, key);
    if (typeof time !== "number") {
      continue;
    }
    if (time < now || time > now + lookaheadMs) {
      continue;
    }
    const value = formatCaseDeadlineDisplay(time);
    const line = `${label}：${key} ${value}${status ? `；当前状态 ${status}` : ""}${stage ? `；程序阶段 ${stage}` : ""}${todo ? `；待做事项 ${todo}` : ""}`;
    lines.push({
      line,
      haystack: [label, key, value, status, stage, todo].filter(Boolean).join(" "),
      priority: 0,
      time,
      recency,
    });
  }

  for (const item of splitCaseTodoItems(todo)) {
    const line = `${label}：待做事项 ${item}${nearestDeadline ? `；截止 ${nearestDeadline.value}` : ""}${status ? `；当前状态 ${status}` : ""}${stage ? `；程序阶段 ${stage}` : ""}`;
    lines.push({
      line,
      haystack: [label, item, nearestDeadline?.value, nearestDeadline?.label, status, stage, todo].filter(Boolean).join(" "),
      priority: 1,
      time: nearestDeadline ? Date.parse(nearestDeadline.value.replace(/\//g, "-")) : (recency || now + lookaheadMs + 1),
      recency,
    });
  }

  return lines;
}

function splitCaseTodoItems(todo: string | undefined): string[] {
  if (!todo) {
    return [];
  }
  const items = todo
    .split(/[、；;\n]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : [todo.trim()];
}

function formatCaseDeadlineDisplay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();
  if (hour === 0 && minute === 0 && second === 0) {
    return `${year}-${month}-${day}`;
  }
  return `${year}-${month}-${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "0.00";
}
