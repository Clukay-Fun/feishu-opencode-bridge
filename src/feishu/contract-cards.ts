/**
 * 职责: 构建合同助手相关的飞书卡片视图与消息载荷。
 * 关注点:
 * - 覆盖合同起草、发票识别、案件管理和提醒等场景。
 * - 统一进度卡、结果卡与按钮区的输出结构。
 */
import path from "node:path";

import type {
  CaseCreateResult,
  CaseCreateProgressStage,
  ContractDraftProgressStage,
  InvoiceRecognizeResult,
} from "../contract-assistant/index.js";
import { buildDesignerCardPayload, setDesignerButtonValue } from "./designer-card-renderer.js";
import { type FeishuPostPayload } from "./shared-primitives.js";

export type ContractDraftProgressView = {
  title: string;
  tagLine?: string | undefined;
  feeLine?: string | undefined;
  steps: Array<{
    stage: ContractDraftProgressStage;
    label: string;
    status: "pending" | "running" | "completed";
    detail?: string | undefined;
  }>;
};

export type InvoiceRecognizeProgressView = {
  currentFile?: string | undefined;
  completedFiles?: readonly string[] | undefined;
  failedFiles?: ReadonlyArray<{ fileName: string; reason?: string | undefined }> | undefined;
  steps: Array<{
    label: string;
    status: "pending" | "running" | "completed";
  }>;
};

export type CaseWorkbenchCardView = {
  domains?: readonly string[] | undefined;
  chatId?: string | undefined;
  chatType?: string | undefined;
  conversationKey?: string | undefined;
  requesterOpenId?: string | undefined;
};

export type CaseCreateProgressView = {
  request: string;
  steps: Array<{
    stage: CaseCreateProgressStage;
    label: string;
    status: "pending" | "running" | "completed";
    detail?: string | undefined;
  }>;
};

export type CaseTodoReminderCardView = {
  items: ReadonlyArray<{
    line: string;
    url?: string | undefined;
  }>;
};

// #region 进度与结果卡

/** 构建案件录入进行中卡。 */
export function buildCaseCreateProcessingPayload(view: CaseCreateProgressView | string): FeishuPostPayload {
  const progressView = typeof view === "string" ? createCaseCreateProgressState(view) : view;
  const preview = parseCaseCreateRequestPreview(progressView.request);
  return buildDesignerCardPayload("案件信息录入中", [
    { from: "委托人：张三", to: `委托人：${preview.clientName ?? "待识别"}` },
    { from: "对方当事人：某科技公司", to: `对方当事人：${preview.counterpartyName ?? "待识别"}` },
    { from: "案由：劳动争议", to: `案由：${preview.cause ?? preview.type ?? "待识别"}` },
    { from: "程序阶段：劳动仲裁", to: `程序阶段：${preview.stage ?? preview.status ?? "待识别"}` },
    { from: "案号：xxx", to: `案号：${preview.caseNo ?? "待识别"}` },
    { from: "审理法院：xx法院", to: `审理法院：${preview.court ?? "待识别"}` },
    ...renderCaseCreateStepReplacements(progressView),
  ], (card) => {
    applyCaseCreateStepStyles(card, progressView);
  });
}

/** 构建合同起草进度卡。 */
export function buildContractDraftProgressPayload(view: ContractDraftProgressView): FeishuPostPayload {
  return buildDesignerCardPayload("合同起草", [
    { from: "委托代理合同（张三 vs 北京XX科技）", to: view.title },
    { from: "劳动争议", to: view.tagLine?.split("｜")[0] ?? "合同起草" },
    { from: "标准代理", to: view.tagLine?.split("｜")[1] ?? "标准模板" },
    { from: "律师费：¥20,000", to: view.feeLine ?? "律师费：待确认" },
  ]);
}

/** 构建合同起草完成卡。 */
export function buildContractDraftCompletedPayload(
  view: ContractDraftProgressView,
  result: { wordPath: string; recordId?: string | undefined; warnings: string[] },
  options: { elapsedMs: number; recordUrl?: string | undefined },
): FeishuPostPayload {
  return buildDesignerCardPayload("合同起草完成", [
    { from: "委托代理合同（张三 vs 北京XX科技）", to: view.title },
    { from: "劳动争议", to: view.tagLine?.split("｜")[0] ?? "合同起草" },
    { from: "标准代理", to: view.tagLine?.split("｜")[1] ?? "标准模板" },
    { from: "律师费：¥20,000", to: view.feeLine ?? "律师费：已确认" },
    { from: "/contract-drafts/委托代理合同（张三vs相关单位）.docx", to: shortProjectPath(result.wordPath) },
  ], (card) => {
    setDesignerButtonValue(card, "打开合同台账", { kind: "contract-draft-action", action: "open-contract-record", url: options.recordUrl });
  });
}

/** 构建案件录入完成卡。 */
export function buildCaseCreateCompletedPayload(result: CaseCreateResult, recordUrl: string, request: string): FeishuPostPayload {
  const record = result.record;
  const fallback = parseCaseCreateRequestPreview(request);
  const clientName = readCaseField(record, "委托人") ?? fallback.clientName ?? "委托人";
  const counterpartyName = readCaseField(record, "对方当事人") ?? fallback.counterpartyName ?? "对方当事人";
  const type = readCaseField(record, "类型") ?? fallback.type;
  const stage = readCaseField(record, "程序阶段") ?? fallback.stage;
  const headline = `${clientName} vs ${counterpartyName}`;
  const tagLine = [type, stage].filter(Boolean).join("｜");

  return buildDesignerCardPayload("案件已录入", [
    { from: "张三 vs 某科技公司", to: headline },
    { from: "劳动争议", to: type ?? "案件" },
    { from: "仲裁阶段", to: stage ?? tagLine ?? "已录入" },
  ], (card) => {
    setDesignerButtonValue(card, "打开案件管理表", { kind: "contract-case-action", action: "open-case-table", url: recordUrl });
  });
}

/** 构建发票识别进度卡。 */
export function buildInvoiceRecognizeProgressPayload(view: InvoiceRecognizeProgressView): FeishuPostPayload {
  const completedFiles = view.completedFiles ?? [];
  const failedFiles = view.failedFiles ?? [];
  return buildDesignerCardPayload("发票识别", [
    { from: "260324_291.94_上海稀宇科技有限公司.pdf", to: view.currentFile ?? "发票文件.pdf" },
    { from: "260405_635.00_深圳市南山区肖三胖甲鱼院子.pdf", to: completedFiles[0] ?? "已完成发票.pdf" },
    { from: "260415_875.00_广东徐记海鲜餐饮有限公司.pdf", to: failedFiles[0]?.fileName ?? "识别失败发票.pdf" },
  ]);
}

/** 构建发票识别完成卡。 */
export function buildInvoiceRecognizeCompletedPayload(
  result: InvoiceRecognizeResult,
  options: { elapsedMs: number; recordUrl: string },
): FeishuPostPayload {
  const payer = readCaseField(result.record, "购买方") ?? readCaseField(result.record, "付款方");
  const invoiceNo = readCaseField(result.record, "发票号");
  const summaryBits = splitInvoiceSummary(result.summary);
  const invoiceType = readCaseField(result.record, "发票类型") ?? summaryBits.invoiceType;
  const invoiceDate = readCaseField(result.record, "开票日期");
  const amount = readInvoiceAmount(result.record);
  const fileName = readCaseField(result.record, "文件名") ?? "发票文件";

  return buildDesignerCardPayload("发票识别完成", [
    { from: "260324_291.94_上海稀宇科技有限公司.pdf", to: fileName },
    { from: "26312000001781272876", to: invoiceNo ?? "未识别" },
    { from: "服务", to: invoiceType ?? "未识别" },
    { from: "291.94", to: amount ?? "未识别" },
    { from: "2026/03/24", to: invoiceDate ?? "未识别" },
    { from: "xx合同.pdf", to: payer ?? "非发票文件" },
  ], (card) => {
    setDesignerButtonValue(card, "查看发票表", { kind: "invoice-action", action: "open-invoice-table", url: options.recordUrl });
  });
}

/** 构建案件工作台开启卡。 */
export function buildCaseWorkbenchPayload(view: CaseWorkbenchCardView = {}): FeishuPostPayload {
  return buildDesignerCardPayload("案件工作台开启", [], (card) => {
    setDesignerButtonValue(card, "点击开始收集材料", buildCaseWorkbenchActionValue(view, "start-material-collection"));
    setDesignerButtonValue(card, "取消", buildCaseWorkbenchActionValue(view, "cancel"));
  });
}

/** 构建案件提醒卡，复用设计器的今日待办模板但填入案件待办真实数据。 */
export function buildCaseTodoReminderPayload(view: CaseTodoReminderCardView): FeishuPostPayload {
  return buildDesignerCardPayload("今日待办", [], (card) => {
    const header = getDesignerRecord(card.header);
    const title = getDesignerRecord(header?.title);
    if (title) {
      title.content = "案件提醒";
    }
    const tags = Array.isArray(header?.text_tag_list) ? header.text_tag_list : [];
    const countTag = getDesignerRecord(tags[0]);
    const countText = getDesignerRecord(countTag?.text);
    if (countText) {
      countText.content = `${view.items.length} 项`;
    }

    const rows = getDesignerBodyElements(card).filter((element) => element.tag === "column_set");
    const nextItems = view.items.length > 0 ? view.items.slice(0, rows.length) : [{ line: "当前没有待做事项。" }];
    rows.forEach((row, index) => {
      if (index >= nextItems.length) {
        row.__remove = true;
        return;
      }
      const item = nextItems[index]!;
      row.background_style = resolveTodoRowBackground(index, item.line);
      const columns = Array.isArray(row.columns) ? row.columns : [];
      const firstColumn = getDesignerRecord(columns[0]);
      const actionColumn = getDesignerRecord(columns[1]);
      const markdownElement = getFirstMarkdownElement(firstColumn);
      if (markdownElement) {
        markdownElement.content = formatCaseTodoLine(item.line);
      }
      const button = getFirstButtonElement(actionColumn);
      if (button && item.url) {
        button.value = { kind: "contract-case-action", action: "open-case-record", url: item.url };
        row.columns = firstColumn && actionColumn ? [firstColumn, actionColumn] : [firstColumn].filter(Boolean);
      } else {
        // 没有 record 链接时仍移除按钮，避免假按钮。
        row.columns = firstColumn ? [firstColumn] : [];
      }
    });
    removeMarkedDesignerElements(card);
  });
}

function buildCaseWorkbenchActionValue(view: CaseWorkbenchCardView, action: "start-material-collection" | "cancel"): Record<string, unknown> {
  return {
    kind: "case-workbench-action",
    action,
    chatId: view.chatId,
    chatType: view.chatType,
    conversationKey: view.conversationKey,
    requesterOpenId: view.requesterOpenId,
  };
}

function formatCaseTodoLine(line: string): string {
  const parts = line.split("\n").map((item) => item.trim()).filter(Boolean);
  const title = parts[0] ?? "案件提醒";
  const date = parts.find((item) => item.startsWith("日期："))?.replace(/^日期：/, "");
  const todo = parts.find((item) => item.startsWith("待办："))?.replace(/^待办：/, "");
  const progress = parts.find((item) => item.startsWith("进展："))?.replace(/^进展：/, "");
  const headline = date ? `**案件节点** ${date}` : "**案件提醒**";
  const detail = [title, todo, progress].filter(Boolean).join(" · ");
  return detail ? `${headline}\n${detail}` : headline;
}

function resolveTodoRowBackground(index: number, line: string): string {
  if (/截止|上诉|开庭|今日|今天/.test(line)) {
    return index === 0 ? "red-50" : "yellow-50";
  }
  return ["wathet-50", "grey-50", "blue-50", "green-50"][index] ?? "grey-50";
}

function getDesignerBodyElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = getDesignerRecord(card.body);
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  return elements.filter(getDesignerRecord);
}

function getFirstMarkdownElement(input: unknown): Record<string, unknown> | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = getFirstMarkdownElement(item);
      if (found) return found;
    }
    return null;
  }
  const record = getDesignerRecord(input);
  if (!record) {
    return null;
  }
  if (record.tag === "markdown" && typeof record.content === "string") {
    return record;
  }
  for (const value of Object.values(record)) {
    const found = getFirstMarkdownElement(value);
    if (found) return found;
  }
  return null;
}

function getFirstButtonElement(input: unknown): Record<string, unknown> | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = getFirstButtonElement(item);
      if (found) return found;
    }
    return null;
  }
  const record = getDesignerRecord(input);
  if (!record) {
    return null;
  }
  if (record.tag === "button") {
    return record;
  }
  for (const value of Object.values(record)) {
    const found = getFirstButtonElement(value);
    if (found) return found;
  }
  return null;
}

function removeMarkedDesignerElements(input: unknown): void {
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (getDesignerRecord(item)?.__remove) {
        input.splice(index, 1);
        continue;
      }
      removeMarkedDesignerElements(item);
    }
    return;
  }
  const record = getDesignerRecord(input);
  if (!record) {
    return;
  }
  for (const value of Object.values(record)) {
    removeMarkedDesignerElements(value);
  }
}

function getDesignerRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// #endregion

export function createInvoiceRecognizeProgressState(): InvoiceRecognizeProgressView {
  return {
    steps: [
      { label: "OCR 识别发票内容", status: "pending" },
      { label: "填写表格", status: "pending" },
    ],
  };
}

export function createCaseCreateProgressState(request: string): CaseCreateProgressView {
  return {
    request,
    steps: [
      { stage: "extract-fields", label: "提取案件字段", status: "running", detail: "正在根据案情提取案件字段" },
      { stage: "write-record", label: "写入案件管理表", status: "pending" },
    ],
  };
}

export function applyCaseCreateProgress(
  view: CaseCreateProgressView,
  currentStage: CaseCreateProgressStage,
  detail?: string,
): void {
  const currentIndex = view.steps.findIndex((step) => step.stage === currentStage);
  if (currentIndex < 0) {
    return;
  }
  view.steps.forEach((step, index) => {
    if (index < currentIndex) {
      step.status = "completed";
      step.detail = undefined;
      return;
    }
    if (index === currentIndex) {
      step.status = "running";
      step.detail = detail;
      return;
    }
    if (step.status !== "completed") {
      step.status = "pending";
      step.detail = undefined;
    }
  });
}

export function completeCaseCreateProgress(view: CaseCreateProgressView): void {
  view.steps.forEach((step) => {
    step.status = "completed";
    step.detail = undefined;
  });
}

export function applyInvoiceRecognizeStep(view: InvoiceRecognizeProgressView, currentIndex: number): void {
  view.steps.forEach((step, index) => {
    if (index < currentIndex) {
      step.status = "completed";
    } else if (index === currentIndex) {
      step.status = "running";
    } else {
      step.status = "pending";
    }
  });
}

export function completeInvoiceRecognizeProgress(view: InvoiceRecognizeProgressView): void {
  view.steps.forEach((step) => {
    step.status = "completed";
  });
}

export function createContractDraftProgressState(request: string): ContractDraftProgressView {
  const meta = inferContractDraftMeta(request);
  const steps = contractDraftSteps().map((step, index) => ({
    ...step,
    status: index === 0 ? "running" : "pending" as "running" | "pending",
  }));
  return {
    ...meta,
    steps,
  };
}

export function applyContractDraftProgress(
  view: ContractDraftProgressView,
  currentStage: ContractDraftProgressStage,
  detail?: string,
): void {
  const currentIndex = view.steps.findIndex((step) => step.stage === currentStage);
  if (currentIndex < 0) {
    return;
  }
  view.steps.forEach((step, index) => {
    if (index < currentIndex) {
      step.status = "completed";
      step.detail = undefined;
      return;
    }
    if (index === currentIndex) {
      step.status = "running";
      step.detail = detail;
      return;
    }
    if (step.status !== "completed") {
      step.status = "pending";
      step.detail = undefined;
    }
  });
}

export function completeContractDraftProgress(view: ContractDraftProgressView): void {
  view.steps.forEach((step) => {
    step.status = "completed";
    step.detail = undefined;
  });
}

function renderCaseCreateStepReplacements(view: CaseCreateProgressView): Array<{ from: string; to: string }> {
  const first = view.steps[0];
  const second = view.steps[1];
  return [
    { from: "提取字段：进行中...", to: formatCaseCreateStep(first, first?.status === "running" ? first.detail : undefined) },
    { from: "写入案件管理表：等待中", to: `生成结果卡：${second?.status === "completed" ? "进行中" : "等待中"}` },
    { from: "提取字段：已完成", to: formatCaseCreateStep(second, second?.status === "running" ? second.detail : undefined) },
  ];
}

function applyCaseCreateStepStyles(card: Record<string, unknown>, view: CaseCreateProgressView): void {
  const first = view.steps[0]?.status ?? "pending";
  const second = view.steps[1]?.status ?? "pending";
  const resultStatus = second === "completed" ? "running" : "pending";
  updateStepDiv(card, "提取案件字段：", first);
  updateStepDiv(card, "写入案件管理表：", second);
  updateStepDiv(card, "生成结果卡：", resultStatus);
}

function updateStepDiv(input: unknown, prefix: string, status: "pending" | "running" | "completed"): boolean {
  if (Array.isArray(input)) {
    return input.some((item) => updateStepDiv(item, prefix, status));
  }
  if (!input || typeof input !== "object") {
    return false;
  }
  const record = input as Record<string, unknown>;
  const text = record.text;
  if (record.tag === "div" && text && typeof text === "object" && !Array.isArray(text)) {
    const textRecord = text as Record<string, unknown>;
    if (typeof textRecord.content === "string" && textRecord.content.startsWith(prefix)) {
      const style = stepStyle(status);
      textRecord.text_color = style.color;
      record.icon = {
        tag: "standard_icon",
        token: style.token,
        color: style.color,
      };
      return true;
    }
  }
  return Object.values(record).some((value) => updateStepDiv(value, prefix, status));
}

function stepStyle(status: "pending" | "running" | "completed"): { token: string; color: string } {
  if (status === "completed") {
    return { token: "yes_outlined", color: "green" };
  }
  if (status === "running") {
    return { token: "loading_outlined", color: "blue" };
  }
  return { token: "ellipse_outlined", color: "grey" };
}

function formatCaseCreateStep(
  step: CaseCreateProgressView["steps"][number] | undefined,
  detail?: string | undefined,
): string {
  if (!step) {
    return "等待处理";
  }
  const statusLabel = step.status === "completed" ? "已完成" : step.status === "running" ? "进行中" : "等待中";
  return `${step.label}：${detail ?? statusLabel}`;
}

function parseCaseCreateRequestPreview(request: string): {
  clientName?: string | undefined;
  counterpartyName?: string | undefined;
  cause?: string | undefined;
  court?: string | undefined;
  lawyer?: string | undefined;
  status?: string | undefined;
  type?: string | undefined;
  stage?: string | undefined;
  caseNo?: string | undefined;
} {
  const text = request.trim();
  const clientName = matchFirst(text, [/委托人[：:\s]*([^，。,；;\n]+)/]);
  const counterpartyName = matchFirst(text, [/对方当事人[：:\s]*([^，。,；;\n]+)/]);
  const cause = matchFirst(text, [/案由[：:\s]*([^，。,；;\n]+)/]);
  const court = matchFirst(text, [/受理机构[：:\s]*([^，。,；;\n]+)/, /审理法院[：:\s]*([^，。,；;\n]+)/]);
  const caseNo = matchFirst(text, [/案号[：:\s]*([^，。,；;\n]+)/]);
  const rawLawyer = matchFirst(text, [/承办律师[：:\s]*([^，。,；;\n]+)/, /主办律师[：:\s]*([^，。,；;\n]+)/]);
  const lawyer = rawLawyer?.replace(/律师$/u, "").trim() || undefined;
  const status = normalizeCaseCreateStatus(matchFirst(text, [/案件状态[：:\s]*([^，。,；;\n]+)/]));
  const type = matchFirst(text, [/类型[：:\s]*([^，。,；;\n]+)/]);
  const stage = normalizeCaseCreateStage(matchFirst(text, [/程序阶段[：:\s]*([^，。,；;\n]+)/]));
  return {
    ...(clientName ? { clientName } : {}),
    ...(counterpartyName ? { counterpartyName } : {}),
    ...(cause ? { cause: normalizeCaseCreateCause(cause) } : {}),
    ...(court ? { court } : {}),
    ...(lawyer ? { lawyer } : {}),
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(stage ? { stage } : {}),
    ...(caseNo ? { caseNo } : {}),
  };
}

function normalizeCaseCreateCause(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return /劳动/.test(value) ? "劳动争议" : value.trim();
}

function normalizeCaseCreateStage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/劳动仲裁|仲裁/.test(value)) {
    return "仲裁阶段";
  }
  if (/一审/.test(value)) {
    return "一审阶段";
  }
  if (/二审/.test(value)) {
    return "二审阶段";
  }
  if (/执行/.test(value)) {
    return "执行阶段";
  }
  return value.trim();
}

function normalizeCaseCreateStatus(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/证据整理中|处理中|进行中|在办/.test(value)) {
    return "进行中";
  }
  return value.trim();
}

function contractDraftSteps(): Array<{ stage: ContractDraftProgressStage; label: string }> {
  return [
    { stage: "parse-request", label: "解析起草需求" },
    { stage: "match-template", label: "匹配合同模板" },
    { stage: "prepare-fields", label: "整理关键字段" },
    { stage: "generate-word", label: "使用模板填充变量并生成文档" },
    { stage: "sync-artifacts", label: "同步合同台账记录" },
  ];
}

function inferContractDraftMeta(request: string): { title: string; tagLine?: string; feeLine?: string } {
  const compact = request.replace(/\s+/g, " ").trim();
  const client = extractLabeledValue(compact, ["甲方", "委托人"]);
  const counterparty = extractLabeledValue(compact, ["对方当事人", "对方"])
    ?? matchFirst(compact, [/因与([^，。,；;\n]+?)(?:发生|的)?(?:劳动争议|纠纷|争议)/]);
  const cause = extractLabeledValue(compact, ["案由"])
    ?? matchFirst(compact, [/(劳动争议|劳动仲裁|民间借贷纠纷|合同纠纷|买卖合同纠纷|服务合同纠纷)/]);
  const stage = matchFirst(compact, [/(劳动仲裁|仲裁|一审|二审|执行)/]);
  const fee = extractContractDraftFee(compact);
  const parties = [client, counterparty].filter(Boolean);

  return {
    title: parties.length === 2 ? `委托代理合同（${parties[0]} vs ${parties[1]}）` : "委托代理合同",
    ...([cause, stage].filter(Boolean).length > 0 ? { tagLine: [cause, stage].filter(Boolean).join("｜") } : {}),
    ...(fee ? { feeLine: `律师费：¥${normalizeMoneyText(fee)}` } : {}),
  };
}

function extractLabeledValue(text: string, labels: string[]): string | undefined {
  const labelPattern = labels
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const explicit = text.match(new RegExp(`(?:${labelPattern})(?:（[^）]+）)?\\s*(?:为|是|[:：])\\s*([^，。,；;\\n]+)`));
  if (explicit?.[1]?.trim()) {
    return cleanupDraftMetaValue(explicit[1]);
  }
  const compact = text.match(new RegExp(`(?:${labelPattern})(?:（[^）]+）)?\\s*([^，。,；;\\n]+)`));
  if (compact?.[1]?.trim() && !/^(因|与|为|是|[:：])/.test(compact[1].trim())) {
    return cleanupDraftMetaValue(compact[1]);
  }
  return undefined;
}

function cleanupDraftMetaValue(value: string): string {
  return value
    .replace(/^(?:为|是|[:：])\s*/, "")
    .replace(/^(?:发生|关于)/, "")
    .trim();
}

function extractContractDraftFee(text: string): string | undefined {
  const patterns = [
    /(?:律师费|代理费用|代理费|基础费用)\s*(?:为|是|[:：])?\s*(?:人民币|¥)?\s*([0-9][0-9,.]*)\s*元?/,
    /(?:仲裁|一审|二审|执行)(?:阶段|程序)?(?:律师费|代理费)?\s*(?:为|是|[:：])?\s*(?:人民币|¥)?\s*([0-9][0-9,.]*)\s*元?/,
  ];
  return matchFirst(text, patterns);
}

function matchFirst(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    const value = matched?.slice(1).find((item) => item && item.trim()) ?? matched?.[1] ?? matched?.[0];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMoneyText(value: string): string {
  const digits = value.replace(/[^\d.]/g, "");
  if (!digits) {
    return value;
  }
  const amount = Number(digits);
  if (!Number.isFinite(amount)) {
    return value;
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount);
}

function readCaseField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return parts.length > 0 ? parts.join("、") : undefined;
  }
  return undefined;
}

function readInvoiceAmount(record: Record<string, unknown>): string | undefined {
  const value = record["发票金额"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return `¥${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function splitInvoiceSummary(summary: string): { invoiceType?: string; itemName?: string; identity?: string } {
  const invoiceType = matchFirst(summary, [/(增值税专用发票|增值税普通发票|电子发票|普通发票)/]);
  const itemName = matchFirst(summary, [/项目[：:\s]*([^，。,；;\n]+)/, /内容[：:\s]*([^，。,；;\n]+)/]);
  const identity = matchFirst(summary, [/(?:税号|身份证号|信用代码)[：:\s]*([A-Za-z0-9]+)/]);
  return {
    ...(invoiceType ? { invoiceType } : {}),
    ...(itemName ? { itemName } : {}),
    ...(identity ? { identity } : {}),
  };
}

function shortProjectPath(targetPath: string): string {
  const cwd = process.cwd();
  const repoName = path.basename(cwd);
  const relative = path.relative(cwd, targetPath);
  if (!relative || relative.startsWith("..")) {
    return targetPath;
  }
  return path.join(repoName, relative);
}
