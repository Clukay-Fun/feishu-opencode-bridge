import path from "node:path";

import type {
  CaseCreateResult,
  CaseReminderAddResult,
  ContractDraftProgressStage,
  InvoiceRecognizeResult,
} from "../contract-assistant/index.js";
import { buildNoticeCardPayload, type FeishuPostPayload } from "./shared-primitives.js";

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
  steps: Array<{
    label: string;
    status: "pending" | "running" | "completed";
  }>;
};

export type ReminderListResult = {
  contractLines: string[];
  invoiceLines: string[];
  caseLines: string[];
};

export function buildCaseCreateProcessingPayload(request: string): FeishuPostPayload {
  return buildInteractiveCardPayload({
    title: "案件信息录入中",
    template: "blue",
    iconToken: "loading_outlined",
    headerPadding: "12px 8px 12px 8px",
    bodyElements: [
      caseMarkdown("**正在解析案件信息**"),
      caseColumnSet([
        caseColumn([
          caseMarkdown(escapeCardMarkdown(truncateCardText(request, 80))),
        ], { bg: "blue-50", padding: "12px 12px 12px 12px", weight: 1 }),
      ], { spacing: "12px", stretch: true }),
      caseDivider(),
      caseColumnSet([
        caseColumn([
          caseMarkdown("提取字段：进行中…", {
            size: "normal_v2",
            icon: { token: "loading_outlined", color: "blue" },
          }),
          caseMarkdown("写入案件管理表：等待中", {
            size: "normal_v2",
            icon: { token: "loading_outlined", color: "blue" },
          }),
        ], { bg: "grey-50", padding: "12px 12px 12px 12px", weight: 1 }),
      ], { spacing: "12px", stretch: true }),
    ],
  });
}

export function buildContractDraftProgressPayload(view: ContractDraftProgressView): FeishuPostPayload {
  return buildInteractiveCardPayload({
    title: "合同起草",
    template: "blue",
    iconToken: "file-link-docx_outlined",
    headerPadding: "12px 12px 12px 12px",
    bodyElements: [
      caseColumnSet([
        caseColumn([
          caseMarkdown(`**${escapeCardMarkdown(view.title)}**`, { size: "heading" }),
        ], { weight: 1, padding: "0px 0px 0px 0px" }),
      ], { spacing: "8px" }),
      ...buildContractDraftMetaRows(view),
      caseColumnSet([
        caseColumn(view.steps.map((step) => caseMarkdown(buildContractDraftStepText(step), {
          size: "normal",
          icon: mapContractDraftStepIcon(step.status),
        })), {
          bg: "grey-50",
          padding: "8px 8px 8px 8px",
          weight: 1,
        }),
      ], { spacing: "8px", stretch: true }),
    ],
  });
}

export function buildContractDraftCompletedPayload(
  view: ContractDraftProgressView,
  result: { wordPath: string; recordId?: string | undefined; warnings: string[] },
  options: { elapsedMs: number; recordUrl?: string | undefined },
): FeishuPostPayload {
  return buildInteractiveCardPayload({
    title: "合同起草完成",
    template: "green",
    iconToken: "yes_filled",
    headerPadding: "12px 12px 12px 12px",
    bodyElements: [
      caseColumnSet([
        caseColumn([
          caseMarkdown(`**${escapeCardMarkdown(view.title)}**`, { size: "heading" }),
        ], { weight: 1, padding: "0px 0px 0px 0px" }),
      ], { spacing: "8px" }),
      ...buildContractDraftMetaRows(view),
      caseColumnSet([
        caseColumn(view.steps.map((step) => caseMarkdown(buildContractDraftStepText(step), {
          size: "normal",
          icon: mapContractDraftStepIcon(step.status),
        })), {
          bg: "grey-50",
          padding: "8px 8px 8px 8px",
          weight: 1,
        }),
      ], { spacing: "8px", stretch: true }),
      caseColumnSet([
        caseColumn([
          caseMarkdown(`本地文件：\`${escapeCardMarkdown(shortProjectPath(result.wordPath))}\``, { size: "normal_v2" }),
        ], { weight: 1, padding: "0px 0px 0px 0px" }),
      ], { spacing: "8px" }),
      caseColumnSet([
        caseColumn([
          caseMarkdown(options.recordUrl ? `[合同台账记录：打开记录](${options.recordUrl})` : "合同台账记录：未写入", { size: "normal_v2" }),
        ], { weight: 1, padding: "0px 0px 0px 0px" }),
      ], { spacing: "8px" }),
      ...(result.warnings.length > 0
        ? [
          caseDivider(),
          caseColumnSet([
            caseColumn(result.warnings.map((warning) => caseMarkdown(`- ${escapeCardMarkdown(warning)}`, { size: "normal_v2" })), {
              weight: 1,
              padding: "0px 0px 0px 0px",
            }),
          ], { spacing: "8px" }),
        ]
        : []),
      caseDivider(),
      buildElapsedDiv(options.elapsedMs),
    ],
  });
}

export function buildCaseCreateCompletedPayload(result: CaseCreateResult, recordUrl: string, request: string): FeishuPostPayload {
  const record = result.record;
  const fallback = parseCaseCreateRequestPreview(request);
  const clientName = readCaseField(record, "委托人") ?? fallback.clientName ?? "委托人";
  const counterpartyName = readCaseField(record, "对方当事人") ?? fallback.counterpartyName ?? "对方当事人";
  const type = readCaseField(record, "类型") ?? fallback.type;
  const stage = readCaseField(record, "程序阶段") ?? fallback.stage;
  const headline = `${clientName} vs ${counterpartyName}`;
  const tagLine = [type, stage].filter(Boolean).join("｜");
  const chips = buildCaseDisplayItems(record, fallback);

  return buildInteractiveCardPayload({
    title: "案件已录入",
    template: "green",
    iconToken: "succeed-hollow_filled",
    headerPadding: "12px 12px 12px 12px",
    bodyElements: [
      caseColumnSet([
        caseColumn([
          caseMarkdown(`**${escapeCardMarkdown(headline)}**`, { size: "normal_v2" }),
        ], { weight: 1, padding: "0px 0px 0px 0px" }),
      ], { spacing: "8px" }),
      ...(tagLine
        ? [
          caseColumnSet([
            caseColumn([
              casePlainDiv(tagLine, "notation", "grey"),
            ], { bg: "grey-50", padding: "4px 4px 4px 4px" }),
          ], { spacing: "8px" }),
        ]
        : []),
      caseDivider(),
      caseMarkdown("**结构化信息**", { size: "normal" }),
      buildCaseChipRow(chips.length > 0 ? chips : [result.summary]),
      caseDivider(),
      caseMarkdown(`[案件管理表](${recordUrl})`, { size: "normal_v2" }),
    ],
  });
}

export function buildInvoiceRecognizeProgressPayload(view: InvoiceRecognizeProgressView): FeishuPostPayload {
  return buildInteractiveCardPayload({
    title: "发票识别",
    template: "blue",
    iconToken: "group-card_outlined",
    headerPadding: "12px 12px 12px 12px",
    bodyElements: [
      caseColumnSet([
        caseColumn(view.steps.map((step) => caseMarkdown(buildInvoiceStepText(step), {
          size: "normal",
          icon: mapInvoiceStepIcon(step.status),
        })), {
          bg: "grey-50",
          padding: "8px 8px 8px 8px",
          weight: 1,
        }),
      ], { spacing: "8px", stretch: true }),
    ],
  });
}

export function buildInvoiceRecognizeCompletedPayload(
  result: InvoiceRecognizeResult,
  options: { elapsedMs: number; recordUrl: string },
): FeishuPostPayload {
  const payer = readCaseField(result.record, "付款方");
  const invoiceNo = readCaseField(result.record, "发票号");
  const invoiceDate = readCaseField(result.record, "开票日期");
  const amount = readInvoiceAmount(result.record);
  const summaryBits = splitInvoiceSummary(result.summary);
  const buyerChips = [payer, summaryBits.identity].filter((item): item is string => Boolean(item));
  const invoiceChips = [
    invoiceNo,
    summaryBits.invoiceType,
    amount,
    invoiceDate,
    summaryBits.itemName,
  ].filter((item): item is string => Boolean(item));

  return buildInteractiveCardPayload({
    title: "发票识别完成",
    template: "green",
    iconToken: "group-card_outlined",
    headerPadding: "12px 12px 12px 12px",
    bodyElements: [
      ...(buyerChips.length > 0
        ? [
          caseMarkdown("购买方信息", { size: "normal_v2" }),
          buildInvoiceChipGroup(buyerChips, false),
        ]
        : []),
      ...(invoiceChips.length > 0
        ? [
          caseMarkdown("发票信息", { size: "normal_v2" }),
          buildInvoiceChipGroup(invoiceChips, true),
        ]
        : []),
      caseColumnSet([
        caseColumn([
          caseMarkdown(`[查看发票表 →](${options.recordUrl})`, { size: "normal_v2" }),
        ], { weight: 1, padding: "4px 4px 4px 4px" }),
      ], { spacing: "8px" }),
      caseDivider(),
      buildElapsedDiv(options.elapsedMs),
    ],
  });
}

export function buildReminderProgressPayload(): FeishuPostPayload {
  return buildInteractiveCardPayload({
    title: "案件提醒",
    template: "blue",
    iconToken: "info_outlined",
    headerPadding: "12px 12px 12px 12px",
    bodyElements: [
      caseColumnSet([
        caseColumn([
          caseMarkdown("已完成合同与发票台账扫描", {
            size: "normal",
            icon: { token: "yes_outlined", color: "green" },
          }),
          caseMarkdown("正在检索关联案件与待办事项…", {
            size: "normal",
            icon: { token: "loading_outlined", color: "blue" },
          }),
        ], {
          bg: "grey-50",
          padding: "8px 8px 8px 8px",
          weight: 1,
        }),
      ], { spacing: "8px", stretch: true }),
    ],
  });
}

export function buildTodayTodoPayload(result: ReminderListResult): FeishuPostPayload {
  const items = buildReminderItems(result);
  return buildInteractiveCardPayload({
    title: "今日待办",
    template: "orange",
    iconToken: "info_outlined",
    headerPadding: "12px 12px 12px 12px",
    bodyElements: [
      ...(items.length > 0
        ? items.map((item) => buildReminderTodoRow(item))
        : [buildReminderTodoRow({
          title: "暂无待办",
          detail: "当前无需要提醒的事项",
          due: "",
          bg: "grey-50",
        })]),
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "发送 /提醒 详情 查看全部 · /提醒 完成 1 标记完成",
          text_size: "notation",
          text_align: "left",
          text_color: "grey",
        },
        icon: {
          tag: "standard_icon",
          token: "info_outlined",
          color: "light_grey",
        },
      },
    ],
  });
}

export function buildCaseReminderAddCompletedPayload(result: CaseReminderAddResult, recordUrl: string): FeishuPostPayload {
  const body = [
    `案件：${result.matchedLabel}`,
    `提醒：${result.reminderLabel} ${result.reminderDate}`,
    result.todo ? `待做事项：${result.todo}` : undefined,
    "已写入案件管理表。",
    "",
    `[查看案件记录](${recordUrl})`,
    "发送 `/案件提醒` 可查看最近提醒。",
  ].filter((line): line is string => typeof line === "string").join("\n");
  return buildNoticeCardPayload({
    title: "案件提醒已添加",
    template: "green",
    iconToken: "alarm-clock_outlined",
    message: body,
  });
}

export function createInvoiceRecognizeProgressState(): InvoiceRecognizeProgressView {
  return {
    steps: [
      { label: "OCR 识别发票内容", status: "pending" },
      { label: "填写表格", status: "pending" },
    ],
  };
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

function parseCaseCreateRequestPreview(request: string): {
  clientName?: string | undefined;
  counterpartyName?: string | undefined;
  cause?: string | undefined;
  court?: string | undefined;
  lawyer?: string | undefined;
  status?: string | undefined;
  type?: string | undefined;
  stage?: string | undefined;
} {
  const text = request.trim();
  const clientName = matchFirst(text, [/委托人[：:\s]*([^，。,；;\n]+)/]);
  const counterpartyName = matchFirst(text, [/对方当事人[：:\s]*([^，。,；;\n]+)/]);
  const cause = matchFirst(text, [/案由[：:\s]*([^，。,；;\n]+)/]);
  const court = matchFirst(text, [/受理机构[：:\s]*([^，。,；;\n]+)/, /审理法院[：:\s]*([^，。,；;\n]+)/]);
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

function buildContractDraftMetaRows(view: ContractDraftProgressView): Array<Record<string, unknown>> {
  const chips = [view.tagLine, view.feeLine].filter((item): item is string => Boolean(item));
  if (chips.length === 0) {
    return [];
  }
  return [
    caseColumnSet(chips.map((chip) => caseColumn([
      casePlainDiv(chip, "notation", "grey"),
    ], { bg: "grey-50", padding: "4px 4px 4px 4px" })), { spacing: "8px" }),
  ];
}

function buildInteractiveCardPayload(options: {
  title: string;
  template: "blue" | "green" | "red" | "wathet" | "grey" | "orange" | "yellow" | "purple" | "indigo";
  iconToken: string;
  bodyElements: Array<Record<string, unknown>>;
  headerPadding?: string;
}): FeishuPostPayload {
  return {
    msg_type: "interactive",
    content: JSON.stringify({
      schema: "2.0",
      config: {
        update_multi: true,
        style: {
          text_size: {
            normal_v2: {
              default: "normal",
              pc: "normal",
              mobile: "heading",
            },
          },
        },
      },
      body: {
        direction: "vertical",
        elements: options.bodyElements,
      },
      header: {
        title: {
          tag: "plain_text",
          content: options.title,
        },
        subtitle: {
          tag: "plain_text",
          content: "",
        },
        template: options.template,
        icon: {
          tag: "standard_icon",
          token: options.iconToken,
        },
        padding: options.headerPadding ?? "12px 12px 12px 12px",
      },
    }),
  };
}

function caseMarkdown(
  content: string,
  opts: { size?: string; icon?: { token: string; color?: string }; align?: string } = {},
): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
    text_align: opts.align ?? "left",
    text_size: opts.size ?? "normal_v2",
    margin: "0px 0px 0px 0px",
    ...(opts.icon
      ? {
        icon: {
          tag: "standard_icon",
          token: opts.icon.token,
          color: opts.icon.color,
        },
      }
      : {}),
  };
}

function casePlainDiv(content: string, textSize: string, textColor: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content,
      text_size: textSize,
      text_align: "left",
      text_color: textColor,
    },
    margin: "0px 0px 0px 0px",
  };
}

function caseColumnSet(
  columns: Array<Record<string, unknown>>,
  opts: { spacing?: string; stretch?: boolean; flow?: boolean } = {},
): Record<string, unknown> {
  return {
    tag: "column_set",
    ...(opts.stretch ? { flex_mode: "stretch" } : {}),
    ...(opts.flow ? { flex_mode: "flow" } : {}),
    horizontal_spacing: opts.spacing ?? "8px",
    horizontal_align: "left",
    columns,
    margin: "0px 0px 0px 0px",
  };
}

function caseColumn(
  elements: Array<Record<string, unknown>>,
  opts: { bg?: string; padding?: string; weight?: number } = {},
): Record<string, unknown> {
  return {
    tag: "column",
    width: opts.weight ? "weighted" : "auto",
    ...(opts.bg ? { background_style: opts.bg } : {}),
    elements,
    padding: opts.padding ?? "0px 0px 0px 0px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: opts.padding ? "4px" : "8px",
    horizontal_align: opts.weight ? "left" : "center",
    vertical_align: opts.weight ? "top" : "center",
    ...(opts.weight ? { weight: opts.weight } : {}),
    margin: "0px 0px 0px 0px",
  };
}

function buildCaseChipRow(values: string[]): Record<string, unknown> {
  const rows = chunkCaseChipValues(values, 5);
  return caseColumnSet([
    caseColumn(rows.map((row) => caseColumnSet(row.map((value) => caseColumn([
      caseMarkdown(escapeCardMarkdown(value), { size: "normal" }),
    ], {
      bg: "grey-50",
      padding: "4px 4px 4px 4px",
    })), { spacing: "8px" })), {
      weight: 1,
      padding: "0px 0px 0px 0px",
    }),
  ], { spacing: "8px" });
}

function buildCaseDisplayItems(
  record: Record<string, unknown>,
  fallback: ReturnType<typeof parseCaseCreateRequestPreview>,
): string[] {
  const items = [
    readCaseField(record, "委托人") ?? fallback.clientName,
    readCaseField(record, "对方当事人") ?? fallback.counterpartyName,
    readCaseField(record, "案由") ?? fallback.cause,
    readCaseField(record, "审理法院") ?? fallback.court,
    readCaseField(record, "主办律师") ?? readCaseField(record, "承办律师") ?? fallback.lawyer,
    readCaseField(record, "案件状态") ?? fallback.status,
    formatCaseDisplayItem("日期", readCaseDisplayField(record, "日期")),
    formatCaseDisplayItem("开庭日", readCaseDisplayField(record, "开庭日")),
    formatCaseDisplayItem("举证截止日", readCaseDisplayField(record, "举证截止日")),
    formatCaseDisplayItem("待做事项", readCaseField(record, "待做事项")),
  ];
  return items.filter((item): item is string => Boolean(item));
}

function formatCaseDisplayItem(label: string, value: string | undefined): string | undefined {
  return value ? `${label} ${value}` : undefined;
}

function readCaseDisplayField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatCaseDateTime(value, field === "开庭日");
  }
  return readCaseField(record, field);
}

function formatCaseDateTime(timestamp: number, includeTime: boolean): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const formatted = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return includeTime ? `${formatted} ${pad(date.getHours())}:${pad(date.getMinutes())}` : formatted;
}

function chunkCaseChipValues(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function buildInvoiceChipGroup(values: string[], flow: boolean): Record<string, unknown> {
  return caseColumnSet(values.map((value) => caseColumn([
    caseMarkdown(escapeCardMarkdown(value), { size: "normal_v2" }),
  ], {
    bg: "grey-50",
    padding: "4px 4px 4px 4px",
  })), { spacing: "8px", flow });
}

function buildReminderTodoRow(item: { title: string; detail: string; due: string; bg: string }): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    background_style: item.bg,
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: [
          caseMarkdown(`**${escapeCardMarkdown(item.title)}**\n${escapeCardMarkdown(item.detail)}`, { size: "normal" }),
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
      ...(item.due
        ? [{
          tag: "column",
          width: "auto",
          elements: [
            caseMarkdown(escapeCardMarkdown(item.due), { size: "normal" }),
          ],
          padding: "8px 8px 8px 8px",
          direction: "vertical",
          horizontal_spacing: "8px",
          vertical_spacing: "8px",
          horizontal_align: "center",
          vertical_align: "center",
          margin: "0px 0px 0px 0px",
        }]
        : []),
    ],
    margin: "0px 0px 0px 0px",
  };
}

function caseDivider(): Record<string, unknown> {
  return {
    tag: "hr",
    margin: "0px 0px 0px 0px",
  };
}

function buildElapsedDiv(elapsedMs: number): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content: `耗时：${formatElapsedSeconds(elapsedMs)}`,
      text_size: "notation",
      text_align: "left",
      text_color: "grey",
    },
    icon: {
      tag: "standard_icon",
      token: "alarm-clock_outlined",
      color: "light_grey",
    },
    margin: "0px 0px 0px 0px",
  };
}

function buildReminderItems(result: ReminderListResult): Array<{ title: string; detail: string; due: string; bg: string }> {
  return [
    ...result.caseLines.map(parseCaseReminderLine),
    ...result.contractLines.map(parseContractReminderLine),
    ...result.invoiceLines.map(parseInvoiceReminderLine),
  ].slice(0, 8);
}

function parseCaseReminderLine(line: string): { title: string; detail: string; due: string; bg: string } {
  const [caseLabel = "案件", rest = line] = line.split(/：(.+)/);
  const status = matchFirst(rest, [/当前状态\s*([^；;]+)/]);
  const todo = matchFirst(rest, [/待做事项\s*([^；;]+)/]);
  const due = matchFirst(rest, [/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/]) ?? "";
  const title = localizeReminderTitle(rest, todo);
  const detailTail = rest
    .replace(due, "")
    .replace(/；?截止\s*[^；;]+/, "")
    .replace(/；?当前状态\s*[^；;]+/, "")
    .replace(/；?程序阶段\s*[^；;]+/, "")
    .replace(/；?待做事项\s*[^；;]+/, "")
    .replace(/^\S+\s*/, "")
    .trim();
  return {
    title,
    detail: [caseLabel.trim(), todo || detailTail || status].filter(Boolean).join(" · "),
    due: formatReminderDue(due),
    bg: reminderBackground(title),
  };
}

function parseContractReminderLine(line: string): { title: string; detail: string; due: string; bg: string } {
  const [name = "合同", rest = line] = line.split(/：(.+)/);
  const due = matchFirst(rest, [/付款节点[：:]\s*([^；;]+)/]) ?? "";
  return {
    title: "合同付款",
    detail: `${name.trim()} · ${rest.replace(/；?付款节点[：:]\s*[^；;]+/, "").trim()}`,
    due: formatReminderDue(due),
    bg: "wathet-50",
  };
}

function parseInvoiceReminderLine(line: string): { title: string; detail: string; due: string; bg: string } {
  const [contractNo = "发票记录", rest = line] = line.split(/：(.+)/);
  const due = matchFirst(rest, [/开票日期\s*([^，,；;]+)/]) ?? "";
  return {
    title: "发票匹配",
    detail: `${contractNo.trim()} · ${rest.replace(/，?开票日期\s*[^，,；;]+/, "").trim()}`,
    due: formatReminderDue(due),
    bg: "yellow-50",
  };
}

function localizeReminderTitle(text: string, todo?: string): string {
  if (text.includes("举证")) return "举证期限截止";
  if (text.includes("开庭")) return "开庭提醒";
  if (text.includes("上诉")) return "上诉期限截止";
  if (text.includes("反诉")) return "反诉期限截止";
  if (text.includes("管辖权异议")) return "管辖权异议期限截止";
  if (text.includes("待做事项")) return classifyCaseTodoTitle(todo);
  return "案件提醒";
}

function classifyCaseTodoTitle(todo: string | undefined): string {
  if (!todo) {
    return "案件待办";
  }
  if (/(证据|社保|工资流水|考勤|聊天记录|录音|证明|材料)/.test(todo)) {
    return "证据补充";
  }
  if (/(申请书|起诉状|答辩状|代理词|文书|起草|准备仲裁申请书)/.test(todo)) {
    return "文书准备";
  }
  if (/(沟通|联系|通知|协调|确认)/.test(todo)) {
    return "沟通跟进";
  }
  if (/(开庭|庭审|出庭)/.test(todo)) {
    return "开庭准备";
  }
  return "案件待办";
}

function reminderBackground(title: string): string {
  if (title.includes("截止")) {
    return "red-50";
  }
  if (title.includes("开庭")) {
    return "yellow-50";
  }
  if (title.includes("合同付款")) {
    return "wathet-50";
  }
  return "grey-50";
}

function formatReminderDue(value: string): string {
  return value.trim();
}

function buildInvoiceStepText(step: InvoiceRecognizeProgressView["steps"][number]): string {
  switch (step.status) {
    case "completed":
      return `已完成${step.label}`;
    case "running":
      return `正在 ${step.label}…`;
    default:
      return `等待${step.label}…`;
  }
}

function mapInvoiceStepIcon(status: InvoiceRecognizeProgressView["steps"][number]["status"]): { token: string; color: string } {
  switch (status) {
    case "completed":
      return { token: "yes_outlined", color: "green" };
    default:
      return { token: "loading_outlined", color: "blue" };
  }
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

function buildContractDraftStepText(step: ContractDraftProgressView["steps"][number]): string {
  switch (step.status) {
    case "completed":
      return `已完成${step.label}…`;
    case "running":
      return `正在${step.label}…`;
    default:
      return `等待${step.label}…`;
  }
}

function mapContractDraftStepIcon(status: ContractDraftProgressView["steps"][number]["status"]): { token: string; color: string } {
  switch (status) {
    case "completed":
      return { token: "yes_outlined", color: "green" };
    case "running":
      return { token: "loading_outlined", color: "blue" };
    default:
      return { token: "loading_outlined", color: "blue" };
  }
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

function formatElapsedSeconds(elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain > 0 ? `${minutes} 分 ${remain} 秒` : `${minutes} 分`;
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

function truncateCardText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function escapeCardMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
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
