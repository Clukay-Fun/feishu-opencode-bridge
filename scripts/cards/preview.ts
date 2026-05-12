#!/usr/bin/env tsx
/**
 * 职责: 发送当前保留用户侧飞书卡片的 mock 预览。
 * 关注点:
 * - 复用真实卡片 builder 生成预览，避免验收脚本和产品卡片漂移。
 * - 默认通过 bot 私聊发送给当前 lark-cli 登录用户，支持指定 chat/user 和 dry-run。
 * - 仅覆盖用户侧保留卡片，不发送已弃用的群聊、旧通用提醒和 Harness 独立报告卡。
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import type { CaseCreateResult, ContractDraftProgressStage, InvoiceRecognizeResult } from "../../src/contract-assistant/index.js";
import {
  buildCaseCreateCompletedPayload,
  buildCaseCreateProcessingPayload,
  buildCaseTodoReminderPayload,
  buildCaseWorkbenchPayload,
  buildContractDraftCompletedPayload,
  buildContractDraftProgressPayload,
  buildInvoiceRecognizeCompletedPayload,
  buildInvoiceRecognizeProgressPayload,
  type ContractDraftProgressView,
} from "../../src/feishu/contract-cards.js";
import {
  buildKnowledgeIngestCompletedPayload,
  buildKnowledgeIngestFailurePayload,
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestQueuedPayload,
  buildKnowledgeIngestReadyPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
} from "../../src/feishu/knowledge-cards.js";
import {
  buildLaborAnalysisCompletedPayload,
  buildLaborAnalysisProgressPayload,
  buildLaborFinalReviewPayload,
  buildLaborMaterialCollectionPayload,
  buildLaborReviewCompletedPayload,
} from "../../src/feishu/labor-cards.js";
import {
  buildButtonCallbackTestCardPayload,
  buildCostCommandCardPayload,
  buildGuideCardPayload,
  buildModelListCardPayload,
  buildPermissionRequestCardPayload,
  buildSessionListCardPayload,
  buildSessionTransitionCardPayload,
  buildStatusCommandCardPayload,
  buildTurnStatusCardPayload,
} from "../../src/feishu/runtime-cards.js";
import { buildNoticeCardPayload, type FeishuPostPayload, type ToolUpdateView } from "../../src/feishu/shared-primitives.js";
import type { KnowledgeIngestResult, KnowledgeQueryResult } from "../../src/knowledge/index.js";

type PreviewCard = {
  group: "运行时" | "合同/发票/案件" | "劳动分析" | "知识库";
  name: string;
  aliases: readonly string[];
  payload: FeishuPostPayload;
};

type CliOptions = {
  chatId?: string | undefined;
  userId?: string | undefined;
  only?: string | undefined;
  dryRun: boolean;
  list: boolean;
};

const PREVIEW_CHAT_ID_ENV = "LARK_CARD_PREVIEW_CHAT_ID";
const PREVIEW_USER_ID_ENV = "LARK_CARD_PREVIEW_USER_ID";

main();

function main(): void {
  const options = parseCliOptions();
  const cards = filterCards(createPreviewCards(), options.only);

  if (options.list || options.dryRun) {
    printCardList(cards);
  }
  if (options.dryRun || options.list) {
    return;
  }

  const target = resolveTarget(options);
  sendText(target, `卡片预览开始发送：共 ${cards.length} 张。当前不包含已弃用的群聊、旧通用提醒、Harness 独立报告卡。`);

  let currentGroup = "";
  let sent = 0;
  for (const card of cards) {
    if (card.group !== currentGroup) {
      currentGroup = card.group;
      sendText(target, `【${currentGroup}】卡片预览`);
    }
    sendCard(target, card);
    sent += 1;
    console.log(`sent ${sent}/${cards.length}: ${card.group} / ${card.name}`);
  }

  sendText(target, `卡片预览发送完成，共 ${sent} 张。请按 PDF 规范逐张看效果，把要调的点发回来继续收口。`);
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      "chat-id": { type: "string" },
      "user-id": { type: "string" },
      only: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    chatId: values["chat-id"] ?? process.env[PREVIEW_CHAT_ID_ENV],
    userId: values["user-id"] ?? process.env[PREVIEW_USER_ID_ENV],
    only: values.only,
    dryRun: values["dry-run"] ?? false,
    list: values.list ?? false,
  };
}

function printHelp(): void {
  console.log(`
用法:
  npm run cards:preview
  npm run cards:preview -- --dry-run
  npm run cards:preview -- --only 知识库
  npm run cards:preview -- --chat-id oc_xxx
  npm run cards:preview -- --user-id ou_xxx

说明:
  默认使用 lark-cli auth status 读取当前登录用户 open_id，并通过 bot 私聊发送。
  也可以通过 ${PREVIEW_CHAT_ID_ENV} 或 ${PREVIEW_USER_ID_ENV} 指定默认目标。
`);
}

function resolveTarget(options: CliOptions): { kind: "chat" | "user"; id: string } {
  if (options.chatId) {
    return { kind: "chat", id: options.chatId };
  }
  if (options.userId) {
    return { kind: "user", id: options.userId };
  }

  const status = runJsonCommand(["lark-cli", "auth", "status"]);
  const userOpenId = typeof status.userOpenId === "string" ? status.userOpenId : undefined;
  if (!userOpenId) {
    throw new Error("无法从 lark-cli auth status 读取 userOpenId，请传 --user-id 或 --chat-id。");
  }
  return { kind: "user", id: userOpenId };
}

function filterCards(cards: PreviewCard[], only: string | undefined): PreviewCard[] {
  if (!only) {
    return cards;
  }
  const keyword = only.toLowerCase();
  const filtered = cards.filter((card) => {
    const haystack = [card.group, card.name, ...card.aliases].join(" ").toLowerCase();
    return haystack.includes(keyword);
  });
  if (filtered.length === 0) {
    throw new Error(`没有匹配 --only ${only} 的卡片。可用 --list 查看名称。`);
  }
  return filtered;
}

function printCardList(cards: PreviewCard[]): void {
  for (const card of cards) {
    console.log(`${card.group}\t${card.name}\t${card.aliases.join(",")}`);
  }
}

function sendText(target: { kind: "chat" | "user"; id: string }, text: string): void {
  runLarkMessageCommand(target, "text", JSON.stringify({ text }));
}

function sendCard(target: { kind: "chat" | "user"; id: string }, card: PreviewCard): void {
  runLarkMessageCommand(target, card.payload.msg_type, card.payload.content, card.name);
}

function runLarkMessageCommand(
  target: { kind: "chat" | "user"; id: string },
  msgType: "text" | FeishuPostPayload["msg_type"],
  content: string,
  label = "text",
): void {
  const targetArgs = target.kind === "chat" ? ["--chat-id", target.id] : ["--user-id", target.id];
  const result = spawnSync("lark-cli", [
    "im",
    "+messages-send",
    "--as",
    "bot",
    ...targetArgs,
    "--msg-type",
    msgType,
    "--content",
    content,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`发送 ${label} 失败：${result.stderr || result.stdout}`);
  }
}

function runJsonCommand(args: string[]): Record<string, unknown> {
  const result = spawnSync(args[0]!, args.slice(1), { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${args.join(" ")} 执行失败`);
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${args.join(" ")} 未返回 JSON：${result.stdout.slice(0, 500)}`);
  }
}

function createPreviewCards(): PreviewCard[] {
  const now = Date.now();
  const demoUrl = "https://example.com";
  const steps: ToolUpdateView[] = [
    { label: "读取材料", detail: "已完成", status: "completed" },
    { label: "结构化分析", detail: "进行中…", status: "running" },
    { label: "生成结果", detail: "等待中", status: "pending" },
  ];
  const doneSteps = steps.map((step) => ({ ...step, detail: "已完成", status: "completed" as const }));
  const contractDraftView = createContractDraftPreviewView();
  const contractDraftDoneView = {
    ...contractDraftView,
    steps: contractDraftView.steps.map((step) => ({ ...step, status: "completed" as const, detail: "已完成" })),
  };
  const tagCounts = { 违法解除: 8, 经济补偿: 6, 工资基数: 5, 程序规定: 3, 记薪规则: 2 };

  return [
    card("运行时", "提示卡：信息", ["notice", "info"], buildNoticeCardPayload({ title: "信息提示", level: "info", message: "任务已进入处理队列，请稍候。" })),
    card("运行时", "提示卡：警告", ["notice", "warning"], buildNoticeCardPayload({ title: "需要注意", level: "warning", message: "当前材料缺少签署页，结果可能需要人工复核。" })),
    card("运行时", "提示卡：失败", ["notice", "error"], buildNoticeCardPayload({ title: "操作失败", level: "error", message: "文件解析失败，请重新上传清晰版本。" })),
    card("运行时", "提示卡：空状态", ["notice", "neutral"], buildNoticeCardPayload({ title: "暂无待处理项", level: "neutral", message: "当前没有排队任务。" })),
    card("运行时", "处理中", ["turn", "running"], buildTurnStatusCardPayload({ title: "处理中", status: "运行中", sessionId: "sess_abc123456789", durationText: "32s", progressUpdates: [], toolUpdates: steps, output: { text: "正在整理材料结构，请稍候。", paths: [], commands: [] }, costSummary: "本次约 ¥0.018" })),
    card("运行时", "已完成", ["turn", "completed"], buildTurnStatusCardPayload({ title: "已完成", status: "完成", sessionId: "sess_abc123456789", durationText: "1m 12s", progressUpdates: [], toolUpdates: doneSteps, output: { text: "分析已完成，已生成摘要和后续建议。", paths: ["/tmp/demo-report.md"], commands: ["/status"] }, costSummary: "本次约 ¥0.042" })),
    card("运行时", "执行失败", ["turn", "failed"], buildTurnStatusCardPayload({ title: "执行失败", status: "失败", sessionId: "sess_abc123456789", durationText: "18s", progressUpdates: [], toolUpdates: [{ label: "读取材料", detail: "文件损坏", status: "error" }], output: { text: "无法读取材料，请重新上传。", paths: [], commands: [] }, costSummary: "本次约 ¥0.006" })),
    card("运行时", "权限请求", ["permission"], buildPermissionRequestCardPayload({ permissionName: "npm run test", expiresInSeconds: 180, buttons: [{ label: "允许一次", type: "primary", value: { kind: "permission", action: "allow-once" } }, { label: "始终允许", type: "default", value: { kind: "permission", action: "allow-always" } }, { label: "拒绝", type: "danger", value: { kind: "permission", action: "deny" } }] })),
    card("运行时", "会话状态", ["status"], buildStatusCommandCardPayload({ currentSession: { sessionId: "sess_abc123456789", label: "劳动争议案件分析" }, connectionState: "已连接", sessionMode: "默认", interactionMode: "普通模式", sessionState: "空闲", queueState: "空闲", pendingCount: 0, windowCount: 3, costStatus: "成本正常" })),
    card("运行时", "会话列表", ["sessions"], buildSessionListCardPayload({ items: [{ index: 1, title: "劳动争议案件分析", current: true, meta: "当前", shortId: "abc123456789" }, { index: 2, title: "合同起草", meta: "2 分钟前", shortId: "def987654321" }, { index: 3, title: "知识库入库", archived: true, meta: "已归档", shortId: "ghi456789012" }], footer: "发送 `/switch <编号>` 切换 · 3 分钟内有效" })),
    card("运行时", "会话切换", ["switch"], buildSessionTransitionCardPayload({ title: "已切换会话", iconToken: "chat_filled", previousLabel: "上一会话", previousTitle: "合同起草", currentLabel: "当前会话", currentTitle: "劳动争议案件分析", review: { meta: "刚刚分析了劳动合同解除材料", recentMessages: ["用户上传了劳动合同.pdf", "系统生成了材料分析卡"] }, footer: "会话已切换，可继续发送材料或问题。" })),
    card("运行时", "AI 成本摘要", ["cost"], buildCostCommandCardPayload({ todayTokens: 45231, todayCostCny: 1.2388, monthTokens: 812340, monthCostCny: 26.4821, dailyLimitCny: 20, recent: [{ createdAt: "2026-05-09 00:20", provider: "openai", model: "gpt-5.3-codex", totalTokens: 18231, estimatedCostCny: 0.7421, source: "estimated" }, { createdAt: "2026-05-09 00:28", provider: "openai", model: "embedding", totalTokens: 3910, estimatedCostCny: 0.0312, source: "external-call", tool: "kb", operation: "embed" }] })),
    card("运行时", "快速上手", ["guide"], buildGuideCardPayload({ windowLabel: "当前窗口" })),
    card("运行时", "按钮回调测试", ["callback"], buildButtonCallbackTestCardPayload({ nonce: "preview-20260509", callbackPath: "/feishu/card-action" })),
    card("运行时", "可用模型", ["models"], buildModelListCardPayload({ currentModelLabel: "openai/gpt-5.3-codex", providers: [{ id: "openai", name: "OpenAI", models: [{ id: "gpt-5.3-codex", current: true }, { id: "gpt-5.4" }, { id: "gpt-5.4-mini" }] }], footer: "发送 `/model use <provider>/<model>` 切换。" })),
    card("合同/发票/案件", "案件工作台已开启", ["workbench", "case"], buildCaseWorkbenchPayload({ domains: ["劳动法", "公司法", "合同审查"], chatType: "p2p", conversationKey: "preview-case-workbench", requesterOpenId: "ou_preview" })),
    card("合同/发票/案件", "案件信息录入中", ["case", "processing"], buildCaseCreateProcessingPayload("委托人张三，对方某科技有限公司，案由违法解除劳动合同争议，程序阶段劳动仲裁。")),
    card("合同/发票/案件", "案件已录入", ["case", "completed"], buildCaseCreateCompletedPayload(createCaseCreateResult(), demoUrl, "委托人张三，对方某科技有限公司，案由违法解除劳动合同争议。")),
    card("合同/发票/案件", "案件待办", ["case", "todo", "reminder"], buildCaseTodoReminderPayload({ items: [
      { line: "（2026）沪01民初123号｜一审｜进行中\n日期：开庭日 2026-05-16；举证截止日 2026-05-12\n待办：补充工资流水证据", url: demoUrl },
      { line: "张三 vs 某科技有限公司 劳动争议\n待办：联系当事人确认解除通知送达时间\n进展：证据清单待复核", url: demoUrl },
    ] })),
    card("合同/发票/案件", "合同起草", ["contract", "draft"], buildContractDraftProgressPayload(contractDraftView)),
    card("合同/发票/案件", "合同起草完成", ["contract", "draft"], buildContractDraftCompletedPayload(contractDraftDoneView, { wordPath: "/Users/clukay/Documents/劳动合同解除协议.docx", recordId: "rec_contract_demo", warnings: ["建议人工复核竞业限制条款。"] }, { elapsedMs: 45000, recordUrl: demoUrl })),
    card("合同/发票/案件", "发票识别", ["invoice"], buildInvoiceRecognizeProgressPayload({ currentFile: "增值税专用发票.pdf", completedFiles: ["服务费发票.pdf"], failedFiles: [{ fileName: "模糊发票.jpg", reason: "图片过暗" }], steps: [{ label: "OCR 识别发票内容", status: "running" }, { label: "填写表格", status: "pending" }] })),
    card("合同/发票/案件", "发票识别完成", ["invoice"], buildInvoiceRecognizeCompletedPayload(createInvoiceRecognizeResult(), { elapsedMs: 32000, recordUrl: demoUrl })),
    card("劳动分析", "材料收集中", ["labor", "collection"], buildLaborMaterialCollectionPayload({ title: "张三诉某科技有限公司劳动争议", conversationKey: "preview-labor-case" })),
    card("劳动分析", "材料分析进行中", ["labor", "analysis"], buildLaborAnalysisProgressPayload({ sourceLabel: "劳动合同法问答.pdf", steps, progressText: "正在抽取证据与争议焦点。", startedAt: now - 32000 })),
    card("劳动分析", "材料分析完成", ["labor", "analysis"], buildLaborAnalysisCompletedPayload({ title: "张三诉某科技有限公司劳动争议", materialCount: 5, evidenceCount: 12, issueCount: 4, tagCounts })),
    card("劳动分析", "二次审查进行中", ["labor", "review"], buildLaborFinalReviewPayload({ title: "张三诉某科技有限公司劳动争议", statusText: "正在进行二次审查", detail: "校验法条引用与请求权基础。", level: "info" })),
    card("劳动分析", "二次审查完成", ["labor", "review"], buildLaborReviewCompletedPayload({ title: "张三诉某科技有限公司劳动争议", materialCount: 5, evidenceCount: 12, issueCount: 4, tagCounts, reviewStatus: "二审通过：法条引用和请求权基础一致。", findingsCount: 2, humanReviewCount: 1, docUrl: demoUrl, ledgerUrl: demoUrl, keyEvidenceViewUrl: demoUrl, missingEvidenceViewUrl: demoUrl, syncedEvidenceCount: 12, syncedGapCount: 3 })),
    card("知识库", "知识入库已开启", ["knowledge", "ready"], buildKnowledgeIngestReadyPayload()),
    card("知识库", "知识入库排队中", ["knowledge", "queued"], buildKnowledgeIngestQueuedPayload({ sourceLabel: "经济补偿计算规则.docx", queuedAhead: 2, startedAt: now - 12000 })),
    card("知识库", "知识入库进行中", ["knowledge", "processing"], buildKnowledgeIngestProcessingPayload({ sourceLabel: "劳动合同法问答.pdf", steps, startedAt: now - 45000, completedItems: [{ sourceFile: "劳动争议指导案例.pdf", extractedCount: 18 }, { sourceFile: "赔偿金计算规则.md", extractedCount: 24 }], failedItems: [{ sourceFile: "损坏文件.pdf", reason: "解析失败" }], queuedLabels: ["经济补偿计算规则.docx"] })),
    card("知识库", "知识入库完成", ["knowledge", "completed"], buildKnowledgeIngestCompletedPayload({ completedCount: 4, failedCount: 1, queuedCount: 0, totalExtractedCount: 71, totalDedupedCount: 14, elapsedMs: 45000, bitableUrl: demoUrl, results: createKnowledgeIngestResults(), failures: [{ sourceFile: "损坏文件.pdf", reason: "解析失败" }] })),
    card("知识库", "入库失败", ["knowledge", "failed"], buildKnowledgeIngestFailurePayload({ sourceLabel: "损坏文件.pdf", reason: "PDF 文件损坏，无法读取文本层。", suggestion: "请重新导出 PDF 后上传，或改传 DOCX/图片版本。" })),
    card("知识库", "法律咨询", ["knowledge", "query"], buildKnowledgeQueryPayload(createKnowledgeQueryResult(demoUrl))),
    card("知识库", "法律咨询：无结果", ["knowledge", "query"], buildKnowledgeQueryEmptyPayload({ question: "这个内部制度是否有历史版本？" })),
  ];
}

function card(group: PreviewCard["group"], name: string, aliases: readonly string[], payload: FeishuPostPayload): PreviewCard {
  return { group, name, aliases, payload };
}

function createContractDraftPreviewView(): ContractDraftProgressView {
  const steps: Array<{ stage: ContractDraftProgressStage; label: string; status: "pending" | "running" | "completed"; detail: string }> = [
    { stage: "parse-request", label: "解析起草需求", status: "completed", detail: "已识别合同类型与核心条款" },
    { stage: "match-template", label: "匹配模板", status: "completed", detail: "已选用解除协议模板" },
    { stage: "prepare-fields", label: "准备字段", status: "running", detail: "正在补齐付款与违约条款" },
    { stage: "generate-word", label: "生成 Word", status: "pending", detail: "等待字段完成" },
    { stage: "sync-artifacts", label: "同步台账", status: "pending", detail: "等待文档生成" },
  ];
  return {
    title: "劳动合同解除协议",
    tagLine: "劳动法｜解除协议｜标准条款",
    feeLine: "预计费用：¥2,000",
    steps,
  };
}

function createCaseCreateResult(): CaseCreateResult {
  return {
    summary: "已写入案件管理表。",
    recordId: "rec_case_demo",
    record: {
      委托人: "张三",
      对方当事人: "某科技有限公司",
      类型: "劳动争议",
      程序阶段: "劳动仲裁",
      案由: "违法解除劳动合同争议",
    },
  };
}

function createInvoiceRecognizeResult(): InvoiceRecognizeResult {
  return {
    summary: "增值税专用发票｜¥12,800.00｜上海某科技有限公司",
    recordId: "rec_invoice_demo",
    record: {
      文件名: "增值税专用发票.pdf",
      发票号: "25492000000012345678",
      发票类型: "增值税专用发票",
      开票日期: "2026-05-08",
      价税合计: "¥12,800.00",
      购买方: "上海某科技有限公司",
    },
  };
}

function createKnowledgeIngestResults(): KnowledgeIngestResult[] {
  return [
    { sourceFile: "劳动合同法问答.pdf", extractedCount: 18, rawExtractedCount: 22, dedupedCount: 4, tagCounts: { 违法解除: 8, 经济补偿: 6 }, durationMs: 18000 },
    { sourceFile: "赔偿金计算规则.md", extractedCount: 24, rawExtractedCount: 30, dedupedCount: 6, tagCounts: { 工资基数: 5, 程序规定: 3 }, durationMs: 22000 },
    { sourceFile: "劳动争议指导案例.pdf", extractedCount: 16, rawExtractedCount: 18, dedupedCount: 2, tagCounts: { 记薪规则: 2 }, durationMs: 16000 },
  ];
}

function createKnowledgeQueryResult(bitableUrl: string): KnowledgeQueryResult {
  return {
    question: "违法解除劳动合同如何计算赔偿金？",
    bitableUrl,
    results: [
      createKnowledgeCandidate({
        id: 1,
        sourceFile: "劳动合同法问答.pdf",
        pageSection: "第 3 章",
        answer: "用人单位解除劳动合同应满足法定情形，并履行通知或说明程序。",
        statute: "《劳动合同法》第三十九条、第四十条",
        bitableRecordId: "rec_demo_1",
      }),
      createKnowledgeCandidate({
        id: 2,
        sourceFile: "赔偿金计算规则.md",
        pageSection: "赔偿金",
        answer: "违法解除通常按经济补偿标准的二倍计算赔偿金。",
        statute: "《劳动合同法》第八十七条",
        bitableRecordId: "rec_demo_2",
      }),
    ],
  };
}

function createKnowledgeCandidate(input: {
  id: number;
  sourceFile: string;
  pageSection: string;
  answer: string;
  statute: string;
  bitableRecordId: string;
}): KnowledgeQueryResult["results"][number] {
  return {
    ...input,
    documentId: input.id,
    question: "违法解除劳动合同如何计算赔偿金？",
    tags: ["劳动法", "违法解除"],
    createdAt: Date.now(),
    score: 0.92,
    source: "keyword",
  };
}
