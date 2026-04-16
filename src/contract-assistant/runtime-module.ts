import { DEFAULT_CONTRACT_ASSISTANT_CONFIG, type AppConfig, type ContractAssistantConfig } from "../config/schema.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import {
  buildNoticeCardPayload,
  type FeishuPostPayload,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import type { IncomingChatMessage, IncomingFileMessage } from "../runtime/app.js";
import type { RoutedText } from "../bridge/router.js";
import type {
  ContractAssistantService,
  ContractClause,
  ContractAssistantFileRef,
  CaseCreateResult,
  InvoiceRecognizeResult,
  ContractState,
  ContractDraftProgressStage,
  ContractWorkbenchModelResult,
} from "./index.js";

type SendPayload = (
  chatId: string,
  payload: FeishuPostPayload,
  options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
  delivery?: { replyToMessageId: string; replyInThread?: boolean },
) => Promise<{ messageId: string }>;

type UpdatePayload = (
  chatId: string,
  messageId: string,
  payload: FeishuPostPayload,
  options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
) => Promise<{ messageId: string }>;

type ContractAssistantRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  service: ContractAssistantService | null;
  sendPayload: SendPayload;
  updatePayload: UpdatePayload;
};

type ContractAssistantCommand = Extract<RoutedText, { kind: "command" }>["command"];

type PendingUploadKind = "contract-extract" | "invoice-recognize";
type DraftTemplateField = {
  templateName?: string;
  stages: Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement">;
  authorizationType?: "general" | "special";
  specialAuthorizationScope?: string;
  feeMode?: "stage_fixed" | "base_plus_risk";
  feeArbitration?: number;
  feeFirstInstance?: number;
  feeSecondInstance?: number;
  feeEnforcement?: number;
  baseFee?: number;
  riskFeeRate?: string;
  expenseMode?: "lump_sum" | "reimbursement";
  clientName?: string;
  counterpartyName?: string;
  caseCause?: string;
  leadLawyer?: string;
  specialTerms?: string;
};
type DraftWizardStep =
  | "template"
  | "stages"
  | "authorization"
  | "authorization-scope"
  | "fee-mode"
  | "fees"
  | "expense-mode"
  | "case-basics"
  | "lead-lawyer"
  | "special-terms";

type PendingUploadInteraction = {
  kind: PendingUploadKind;
  chatId: string;
  conversationKey: string;
  requesterOpenId: string;
  anchorMessageId: string;
  expiresAt: number;
};

type PendingDraftInteraction = {
  kind: "contract-draft-onboard";
  chatId: string;
  conversationKey: string;
  requesterOpenId: string;
  anchorMessageId: string;
  expiresAt: number;
  step: DraftWizardStep;
  templates: string[];
  fields: DraftTemplateField;
};

type PendingWorkbenchInteraction = {
  kind: "contract-workbench";
  chatId: string;
  conversationKey: string;
  requesterOpenId: string;
  anchorMessageId: string;
  expiresAt: number;
  state: ContractState | null;
  recentMessages: string[];
};

type PendingInteraction = PendingUploadInteraction | PendingDraftInteraction | PendingWorkbenchInteraction;

type ContractDraftProgressView = {
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

type InvoiceRecognizeProgressView = {
  steps: Array<{
    label: string;
    status: "pending" | "running" | "completed";
  }>;
};

type ReminderListResult = {
  contractLines: string[];
  invoiceLines: string[];
  caseLines: string[];
};

export class ContractAssistantRuntimeModule implements RuntimeModule {
  readonly name = "contract-assistant";
  readonly priority = 30;

  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly stateFilePath: string;
  private persistChain: Promise<void> = Promise.resolve();
  private reminderTimer: NodeJS.Timeout | null = null;
  private lastReminderSlot = "";
  private readonly featureConfig: ContractAssistantConfig;

  constructor(private readonly deps: ContractAssistantRuntimeModuleDeps) {
    this.featureConfig = deps.config.contractAssistant ?? DEFAULT_CONTRACT_ASSISTANT_CONFIG;
    this.stateFilePath = path.join(deps.config.storage.dataDir, "contract-assistant-state.json");
  }

  async start(): Promise<void> {
    await this.restoreState();
    if (!this.featureConfig.enabled || !this.featureConfig.reminder.enabled || !this.deps.service) {
      return;
    }
    this.reminderTimer = setInterval(() => {
      void this.tickReminders();
    }, 60_000);
    await this.tickReminders();
  }

  async stop(): Promise<void> {
    await this.flushPersist();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.interactions.clear();
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    const pending = this.interactions.get(message.conversationKey) ?? null;
    const workbench = pending?.kind === "contract-workbench" ? pending : null;
    if (routed?.kind === "command") {
      const claimed = await this.handleCommand(message, routed.command, workbench);
      return { claimed };
    }

    if (!pending) {
      return { claimed: false };
    }
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendNotice(message, {
        title: "当前任务仅限发起人继续",
        template: "yellow",
        icon: "maybe_outlined",
        message: pending.kind === "contract-draft-onboard"
          ? "请由当前发起人继续填写起草信息，或重新发送 /起草合同 引导 开启新的引导。"
          : pending.kind === "contract-workbench"
            ? "请由当前发起人继续编辑当前合同；如需处理其他合同，请新开话题并发送 /合同起草开始。"
          : "请由当前发起人继续上传文件，或等待任务处理结束。",
      });
      return { claimed: true };
    }

    if (pending.kind === "contract-draft-onboard") {
      const handled = await this.handlePendingDraft(message, pending);
      return { claimed: handled };
    }

    if (pending.kind === "contract-workbench") {
      const handled = await this.handleWorkbenchMessage(message, pending);
      return { claimed: handled };
    }

    const handled = await this.handlePendingUpload(message, pending);
    return { claimed: handled };
  }

  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
    command: ContractAssistantCommand,
    workbench: PendingWorkbenchInteraction | null,
  ): Promise<boolean> {
    if (command.kind !== "passthrough") {
      if (workbench) {
        await this.sendWorkbenchReject(message);
        return true;
      }
      return false;
    }

    const normalized = command.name.trim().toLowerCase();
    if (normalized === "合同工作台结束" || normalized === "合同起草结束" || normalized === "contract-workbench") {
      const endRequested = normalized === "合同工作台结束"
        || normalized === "合同起草结束"
        || (normalized === "contract-workbench" && command.arguments[0]?.trim().toLowerCase() === "end");
      if (endRequested) {
        if (!workbench) {
          await this.sendNotice(message, {
            title: "当前没有进行中的合同起草会话",
            template: "grey",
            icon: "maybe_outlined",
            message: "发送 `/合同起草开始` 或 `/contract-workbench` 可开启新的合同起草会话。",
          });
          return true;
        }
        this.clearInteraction(message.conversationKey);
        await this.sendNotice(message, {
          title: "合同起草会话已结束",
          template: "grey",
          icon: "switch_outlined",
          message: "当前合同起草会话已结束。如需继续其他合同，请新开话题或重新发送 `/合同起草开始`。",
        });
        return true;
      }
    }

    if (normalized === "合同工作台" || normalized === "合同起草开始" || normalized === "contract-workbench") {
      if (!this.featureConfig.enabled || !this.deps.service) {
        await this.sendNotice(message, {
          title: "合同助手未启用",
          template: "yellow",
          icon: "maybe_outlined",
          message: "当前未启用 contract assistant，请先补充 `contractAssistant` 配置。",
        });
        return true;
      }
      const request = command.arguments.join(" ").trim();
      await this.startContractWorkbench(message, request || undefined);
      return true;
    }

    if (workbench) {
      await this.sendWorkbenchReject(message);
      return true;
    }

    if (![
      "contract-draft",
      "起草合同",
      "contract-extract",
      "合同录入",
      "invoice-recognize",
      "识别发票",
      "case-manage",
      "案件录入",
      "案件更新",
      "case-update",
    ].includes(normalized)) {
      return false;
    }

    if (!this.featureConfig.enabled || !this.deps.service) {
      await this.sendNotice(message, {
        title: "合同助手未启用",
        template: "yellow",
        icon: "maybe_outlined",
        message: "当前未启用 contract assistant，请先补充 `contractAssistant` 配置。",
      });
      return true;
    }

    if (normalized === "contract-draft" || normalized === "起草合同") {
      const request = command.arguments.join(" ").trim();
      if (!request) {
        await this.sendNotice(message, {
          title: "请补充起草需求",
          template: "blue",
          icon: "edit_outlined",
          message: "可以直接描述需求，或发送 `/起草合同 引导` 进入分步填写。示例：`/起草合同 使用《委托代理合同-民事》模板，甲方 XXX，对方 XXX 公司，劳动仲裁阶段，律师费 8000 元，实报实销，承办律师 XXX 律师`",
        });
        return true;
      }
      if (request === "引导" || request.toLowerCase() === "onboard") {
        await this.startContractDraftOnboard(message);
        return true;
      }
      await this.handleContractDraft(message, request);
      return true;
    }

    if (normalized === "contract-extract" || normalized === "合同录入") {
      await this.startPendingUpload(message, "contract-extract", "请直接上传 1 份合同文件，我会提取字段并写入合同台账。");
      return true;
    }

    if (normalized === "invoice-recognize" || normalized === "识别发票") {
      await this.startPendingUpload(message, "invoice-recognize", "请直接上传 1 份发票文件，我会识别字段并写入发票记录。");
      return true;
    }

    if (normalized === "case-manage" || normalized === "案件录入") {
      const request = command.arguments.join(" ").trim();
      if (!request) {
        await this.sendNotice(message, {
          title: "请补充案件信息",
          template: "blue",
          icon: "file-task_outlined",
          message: "示例：`/案件录入 民间借贷，委托人 XXX，对方 XXX，浦东法院，一审立案中，举证截止 2026-04-30`",
        });
        return true;
      }
      await this.handleCaseCreate(message, request);
      return true;
    }

    if (normalized === "case-update" || normalized === "案件更新") {
      const request = command.arguments.join(" ").trim();
      if (!request) {
        await this.sendNotice(message, {
          title: "请补充更新内容",
          template: "blue",
          icon: "edit_outlined",
          message: "示例：`/案件更新 案号(2026)沪01民初123号，案件状态改为已开庭，开庭日 2026-04-20，进展 已完成证据交换`",
        });
        return true;
      }
      await this.handleCaseUpdate(message, request);
      return true;
    }

    return false;
  }

  private async handlePendingUpload(
    message: IncomingChatMessage,
    pending: PendingUploadInteraction,
  ): Promise<boolean> {
    if (message.messageType !== "file") {
      await this.sendNotice(message, {
        title: "当前正在等待文件",
        template: "blue",
        icon: "file-link-docx_outlined",
        message: pending.kind === "contract-extract"
          ? "请上传合同文件，我会提取字段并写入合同台账。"
          : "请上传发票文件，我会识别字段并写入发票记录。",
      });
      return true;
    }

    this.clearInteraction(message.conversationKey);
    if (pending.kind === "contract-extract") {
      await this.handleContractExtract(message, {
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
      });
      return true;
    }
    await this.handleInvoiceRecognize(message, {
      messageId: message.messageId,
      fileKey: message.file.fileKey,
      fileName: message.file.fileName,
      size: message.file.size,
    });
    return true;
  }

  private async startContractDraftOnboard(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey" | "senderOpenId">,
  ): Promise<void> {
    this.clearInteraction(message.conversationKey);
    const templates = await this.deps.service!.listDraftTemplates();
    if (templates.length === 0) {
      await this.sendNotice(message, {
        title: "未找到合同模板",
        template: "yellow",
        icon: "maybe_outlined",
        message: "请先在 templates/contracts 下放置 .docx 模板，再发送 `/起草合同 引导`。",
      });
      return;
    }
    const interaction: PendingDraftInteraction = {
      kind: "contract-draft-onboard",
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      anchorMessageId: message.messageId,
      expiresAt: Date.now() + this.featureConfig.ingest.pendingTtlMs,
      step: "template",
      templates,
      fields: {
        stages: [],
      },
    };
    this.interactions.set(message.conversationKey, interaction);
    this.schedulePersist();
    const timer = setTimeout(() => {
      void this.expireInteraction(message.conversationKey);
    }, this.featureConfig.ingest.pendingTtlMs);
    this.timers.set(message.conversationKey, timer);
    await this.sendNotice(message, {
      title: "合同起草引导",
      template: "blue",
      icon: "edit_outlined",
      message: this.renderWizardPrompt(interaction),
    });
  }

  private async handlePendingDraft(
    message: IncomingChatMessage,
    pending: PendingDraftInteraction,
  ): Promise<boolean> {
    if (message.messageType === "file") {
      await this.sendNotice(message, {
        title: "请回复文字",
        template: "blue",
        icon: "edit_outlined",
        message: `当前正在进行合同起草引导，请直接回复数字或文字。\n\n${this.renderWizardPrompt(pending)}`,
      });
      return true;
    }

    const rawAnswer = message.plainText.trim();
    if (!rawAnswer) {
      await this.sendNotice(message, {
        title: "请补充回答",
        template: "blue",
        icon: "edit_outlined",
        message: this.renderWizardPrompt(pending),
      });
      return true;
    }

    const merged = this.mergeDraftFields(pending.fields, rawAnswer, pending.step);
    const next = { ...pending, fields: merged };
    const consumed = this.applyStepAnswer(next, rawAnswer);
    if (!consumed) {
      await this.sendNotice(message, {
        title: "暂时没识别到有效答案",
        template: "yellow",
        icon: "maybe_outlined",
        message: `${this.renderWizardPrompt(pending)}\n\n你也可以直接一次性说明剩余条件，例如：甲方 XXX，对方 XXX，案由劳动争议，仲裁阶段律师费 8000 元。`,
      });
      return true;
    }

    this.advanceDraftWizard(next);

    if (this.isDraftWizardReady(next)) {
      this.clearInteraction(message.conversationKey);
      await this.handleContractDraft(message, this.buildDraftRequestFromFields(next.fields));
      return true;
    }

    this.interactions.set(message.conversationKey, next);
    this.schedulePersist();
    await this.sendNotice(message, {
      title: "继续补充合同起草信息",
      template: "blue",
      icon: "edit_outlined",
      message: this.renderWizardPrompt(next),
    });
    return true;
  }

  private async startContractWorkbench(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey" | "senderOpenId">,
    initialRequest?: string | undefined,
  ): Promise<void> {
    this.clearWorkbenchSessionsForRequester(message.chatId, message.senderOpenId);
    const opening = await this.sendNotice(message, {
      title: "已进入合同起草会话",
      template: "blue",
      icon: "edit_outlined",
      message: [
        "当前会话仅处理本份合同的查看、删改、补充和导出。",
        "你现在可以上传模板 Word、上传已有合同，或直接发送文字描述。",
        "示例：显示第九条 / 删除风险收费部分 / 把争议解决改成法院诉讼 / 重新导出 Word",
        "如需结束当前会话，请发送 `/合同起草结束`。",
      ].join("\n"),
    });

    const interaction: PendingWorkbenchInteraction = {
      kind: "contract-workbench",
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      anchorMessageId: opening.messageId,
      expiresAt: Date.now() + this.featureConfig.ingest.pendingTtlMs,
      state: null,
      recentMessages: [],
    };
    this.interactions.set(message.conversationKey, interaction);
    this.restoreTimer(message.conversationKey, this.featureConfig.ingest.pendingTtlMs);
    this.schedulePersist();

    if (initialRequest) {
      await this.initializeWorkbenchFromText(message, interaction, initialRequest);
    }
  }

  private async handleWorkbenchMessage(
    message: IncomingChatMessage,
    pending: PendingWorkbenchInteraction,
  ): Promise<boolean> {
    this.touchInteractionTimeout(message.conversationKey);

    if (!pending.state) {
      if (message.messageType === "file") {
        await this.initializeWorkbenchFromFile(message, pending);
        return true;
      }
      const prompt = message.plainText.trim();
      if (!prompt) {
        await this.sendNotice(message, {
          title: "请先提供合同起点",
          template: "blue",
          icon: "edit_outlined",
          message: "可以上传模板 Word、上传已有合同，或直接发送一段合同需求描述。",
        });
        return true;
      }
      await this.initializeWorkbenchFromText(message, pending, prompt);
      return true;
    }

    if (message.messageType === "file") {
      await this.sendNotice(message, {
        title: "当前会话已绑定一份合同",
        template: "yellow",
        icon: "maybe_outlined",
        message: "当前合同起草会话已经有正在编辑的合同。如需基于新文件继续，请结束当前会话后重新发送 `/合同起草开始`。",
      });
      return true;
    }

    const userInput = message.plainText.trim();
    if (!userInput) {
      await this.sendNotice(message, {
        title: "请继续输入合同操作",
        template: "blue",
        icon: "edit_outlined",
        message: "你可以直接说：显示第九条、删除风险收费部分、把争议解决改成法院诉讼、重新导出 Word。",
      });
      return true;
    }

    const processing = await this.sendNotice(message, {
      title: "合同起草处理中",
      template: "blue",
      icon: "edit_outlined",
      message: "正在理解你的合同操作并准备执行。",
    });

    try {
      const result = await this.deps.service!.applyWorkbenchMessage(
        pending.state,
        pending.recentMessages,
        userInput,
      );
      await this.applyWorkbenchResult(message, pending, userInput, result);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草已处理",
        template: "green",
        iconToken: "yes_outlined",
        message: result.message,
      }), {
        event: "contract workbench processed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.message),
        len: result.message.length,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草处理失败",
        template: "red",
        iconToken: "error_filled",
        message: detail,
      }), {
        event: "contract workbench failed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(detail),
        len: detail.length,
      });
    }
    return true;
  }

  private async handleContractDraft(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    request: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const progressState = createContractDraftProgressState(request);
    const processing = await this.deps.sendPayload(message.chatId, buildContractDraftProgressPayload(progressState), {
      event: "contract draft started",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(request),
      len: request.length,
    }, { replyToMessageId: message.messageId });
    try {
      const result = await this.deps.service!.draftContract(request, async (stage, detail) => {
        applyContractDraftProgress(progressState, stage, detail);
        await this.deps.updatePayload(message.chatId, processing.messageId, buildContractDraftProgressPayload(progressState), {
          event: "contract draft progress updated",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(detail ?? stage),
          len: (detail ?? stage).length,
        });
      });
      completeContractDraftProgress(progressState);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildContractDraftCompletedPayload(
        progressState,
        result,
        {
          elapsedMs: Date.now() - startedAt,
          recordUrl: result.recordId
            ? buildBitableRecordUrl(this.featureConfig.storage.baseToken, this.featureConfig.storage.contractTableId, result.recordId)
            : undefined,
        },
      ), {
        event: "contract draft completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.docTitle),
        len: result.docTitle.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
      }), {
        event: "contract draft failed",
        transcriptType: "outbound-final",
        textPreview: error instanceof Error ? error.message : String(error),
        len: (error instanceof Error ? error.message : String(error)).length,
      });
    }
  }

  private async handleContractExtract(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    file: ContractAssistantFileRef,
  ): Promise<void> {
    const processing = await this.sendNotice(message, {
      title: "合同录入中",
      template: "blue",
      icon: "file-link-docx_outlined",
      message: `正在提取《${file.fileName}》中的合同字段，并写入合同台账。`,
    });
    try {
      const result = await this.deps.service!.extractContract(file);
      const summary = [
        `文件：${file.fileName}`,
        `合同台账记录：[打开记录](${buildBitableRecordUrl(this.featureConfig.storage.baseToken, this.featureConfig.storage.contractTableId, result.recordId)})`,
        result.summary,
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同录入完成",
        template: "green",
        iconToken: "yes_outlined",
        message: summary,
      }), {
        event: "contract extract completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同录入失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
      }), {
        event: "contract extract failed",
        transcriptType: "outbound-final",
        textPreview: error instanceof Error ? error.message : String(error),
        len: (error instanceof Error ? error.message : String(error)).length,
      });
    }
  }

  private async handleInvoiceRecognize(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    file: ContractAssistantFileRef,
  ): Promise<void> {
    const startedAt = Date.now();
    const progressState = createInvoiceRecognizeProgressState();
    const processing = await this.deps.sendPayload(message.chatId, buildInvoiceRecognizeProgressPayload(progressState), {
      event: "invoice recognize started",
      transcriptType: "outbound-final",
      textPreview: file.fileName,
      len: file.fileName.length,
    }, { replyToMessageId: message.messageId });
    try {
      applyInvoiceRecognizeStep(progressState, 0);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeProgressPayload(progressState), {
        event: "invoice recognize ocr started",
        transcriptType: "outbound-final",
        textPreview: file.fileName,
        len: file.fileName.length,
      });
      const result = await this.deps.service!.recognizeInvoice(file);
      applyInvoiceRecognizeStep(progressState, 1);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeProgressPayload(progressState), {
        event: "invoice recognize record write started",
        transcriptType: "outbound-final",
        textPreview: result.summary,
        len: result.summary.length,
      });
      completeInvoiceRecognizeProgress(progressState);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeCompletedPayload(
        result,
        {
          elapsedMs: Date.now() - startedAt,
          recordUrl: buildBitableRecordUrl(this.featureConfig.storage.baseToken, this.featureConfig.storage.invoiceTableId, result.recordId),
        },
      ), {
        event: "invoice recognize completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.summary),
        len: result.summary.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "发票识别失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
      }), {
        event: "invoice recognize failed",
        transcriptType: "outbound-final",
        textPreview: error instanceof Error ? error.message : String(error),
        len: (error instanceof Error ? error.message : String(error)).length,
      });
    }
  }

  private async handleCaseCreate(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    request: string,
  ): Promise<void> {
    const processing = await this.deps.sendPayload(message.chatId, buildCaseCreateProcessingPayload(request), {
      event: "case create processing",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(request),
      len: request.length,
    }, { replyToMessageId: message.messageId });
    try {
      const result = await this.deps.service!.createCase(request);
      const recordUrl = buildBitableRecordUrl(this.featureConfig.storage.baseToken, this.featureConfig.storage.caseTableId, result.recordId);
      const payload = buildCaseCreateCompletedPayload(result, recordUrl);
      await this.deps.updatePayload(message.chatId, processing.messageId, payload, {
        event: "case create completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.summary),
        len: result.summary.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件录入失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
      }), {
        event: "case create failed",
        transcriptType: "outbound-final",
        textPreview: error instanceof Error ? error.message : String(error),
        len: (error instanceof Error ? error.message : String(error)).length,
      });
    }
  }

  private async handleCaseUpdate(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    request: string,
  ): Promise<void> {
    const processing = await this.sendNotice(message, {
      title: "案件更新中",
      template: "blue",
      icon: "edit_outlined",
      message: "正在定位案件并更新案件管理表。",
    });
    try {
      const result = await this.deps.service!.updateCase(request);
      const summary = `匹配案件：${result.matchedLabel}`;
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件更新完成",
        template: "green",
        iconToken: "yes_outlined",
        message: summary,
      }), {
        event: "case update completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件更新失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
      }), {
        event: "case update failed",
        transcriptType: "outbound-final",
        textPreview: error instanceof Error ? error.message : String(error),
        len: (error instanceof Error ? error.message : String(error)).length,
      });
    }
  }

  private async initializeWorkbenchFromText(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey">,
    pending: PendingWorkbenchInteraction,
    prompt: string,
  ): Promise<void> {
    const processing = await this.sendNotice(message, {
      title: "合同起草初始化中",
      template: "blue",
      icon: "edit_outlined",
      message: "正在根据文字描述初始化合同结构。",
    });
    try {
      const sessionId = `${message.conversationKey}-${Date.now()}`;
      const { state, message: summary } = await this.deps.service!.initializeWorkbenchFromPrompt(sessionId, prompt);
      const updated: PendingWorkbenchInteraction = {
        ...pending,
        state: {
          ...state,
          history: state.history.length > 0
            ? state.history
            : [{ version: 1, summary: "已根据文字描述初始化合同。", at: new Date().toISOString() }],
        },
        recentMessages: pushRecentMessages(pending.recentMessages, prompt),
      };
      this.interactions.set(message.conversationKey, updated);
      this.schedulePersist();
      await this.updateWorkbenchAnchor(updated);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同已载入工作会话",
        template: "green",
        iconToken: "yes_outlined",
        message: summary,
      }), {
        event: "contract workbench init from text",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同初始化失败",
        template: "red",
        iconToken: "error_filled",
        message: detail,
      }), {
        event: "contract workbench init from text failed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(detail),
        len: detail.length,
      });
    }
  }

  private async initializeWorkbenchFromFile(
    message: IncomingFileMessage,
    pending: PendingWorkbenchInteraction,
  ): Promise<void> {
    const processing = await this.sendNotice(message, {
      title: "合同起草初始化中",
      template: "blue",
      icon: "file-link-docx_outlined",
      message: `正在解析《${message.file.fileName}》并生成合同结构。`,
    });
    try {
      const sessionId = `${message.conversationKey}-${Date.now()}`;
      const { state, message: summary } = await this.deps.service!.initializeWorkbenchFromDocument(sessionId, {
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
      });
      const updated: PendingWorkbenchInteraction = {
        ...pending,
        state: {
          ...state,
          history: state.history.length > 0
            ? state.history
            : [{ version: 1, summary: `已从《${message.file.fileName}》初始化合同。`, at: new Date().toISOString() }],
        },
        recentMessages: pushRecentMessages(pending.recentMessages, `[文件] ${message.file.fileName}`),
      };
      this.interactions.set(message.conversationKey, updated);
      this.schedulePersist();
      await this.updateWorkbenchAnchor(updated);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同已载入工作会话",
        template: "green",
        iconToken: "yes_outlined",
        message: summary,
      }), {
        event: "contract workbench init from file",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同初始化失败",
        template: "red",
        iconToken: "error_filled",
        message: detail,
      }), {
        event: "contract workbench init from file failed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(detail),
        len: detail.length,
      });
    }
  }

  private async applyWorkbenchResult(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey">,
    pending: PendingWorkbenchInteraction,
    userInput: string,
    result: ContractWorkbenchModelResult,
  ): Promise<void> {
    if (result.action === "reject") {
      await this.sendWorkbenchReject(message);
      return;
    }

    if (result.action === "view") {
      const title = result.viewPayload?.title?.trim() || "合同条款查看";
      const content = result.viewPayload?.content?.trim() || result.message;
      const updated: PendingWorkbenchInteraction = {
        ...pending,
        recentMessages: pushRecentMessages(pushRecentMessages(pending.recentMessages, userInput), `查看结果：${title}`),
      };
      this.interactions.set(message.conversationKey, updated);
      this.schedulePersist();
      await this.sendNotice(message, {
        title,
        template: "grey",
        icon: "doc_outlined",
        message: content,
      });
      return;
    }

    if (result.action === "export") {
      const exportProcessing = await this.sendNotice(message, {
        title: "正在导出 Word",
        template: "blue",
        icon: "upload_outlined",
        message: "正在根据当前合同结构生成 Word 草稿。",
      });
      try {
        const { wordPath } = await this.deps.service!.exportWorkbenchWord(
          pending.state!,
          result.exportHint,
        );
        const updatedState: ContractState = {
          ...pending.state!,
          draftPath: wordPath,
          lastRenderedAt: new Date().toISOString(),
        };
        const updated: PendingWorkbenchInteraction = {
          ...pending,
          state: updatedState,
          recentMessages: pushRecentMessages(pushRecentMessages(pending.recentMessages, userInput), "已导出 Word"),
        };
        this.interactions.set(message.conversationKey, updated);
        this.schedulePersist();
        await this.updateWorkbenchAnchor(updated);
        const summary = `Word 草稿已导出：${wordPath}`;
        await this.deps.updatePayload(message.chatId, exportProcessing.messageId, buildNoticeCardPayload({
          title: "Word 导出完成",
          template: "green",
          iconToken: "yes_outlined",
          message: summary,
        }), {
          event: "contract workbench export completed",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(summary),
          len: summary.length,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.deps.updatePayload(message.chatId, exportProcessing.messageId, buildNoticeCardPayload({
          title: "Word 导出失败",
          template: "red",
          iconToken: "error_filled",
          message: detail,
        }), {
          event: "contract workbench export failed",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(detail),
          len: detail.length,
        });
      }
      return;
    }

    if (result.action === "update" && result.updatedState) {
      const nextVersion = (pending.state?.version ?? 1) + 1;
      const updatedState: ContractState = {
        ...result.updatedState,
        sessionId: pending.state?.sessionId ?? result.updatedState.sessionId,
        sourceMode: pending.state?.sourceMode ?? result.updatedState.sourceMode,
        templatePath: pending.state?.templatePath ?? result.updatedState.templatePath,
        sourceFilePath: pending.state?.sourceFilePath ?? result.updatedState.sourceFilePath,
        draftPath: pending.state?.draftPath ?? result.updatedState.draftPath,
        version: nextVersion,
        history: [
          ...(pending.state?.history ?? []),
          { version: nextVersion, summary: result.message, at: new Date().toISOString() },
        ].slice(-20),
      };
      const updated: PendingWorkbenchInteraction = {
        ...pending,
        state: updatedState,
        recentMessages: pushRecentMessages(pushRecentMessages(pending.recentMessages, userInput), `修改结果：${result.message}`),
      };
      this.interactions.set(message.conversationKey, updated);
      this.schedulePersist();
      await this.updateWorkbenchAnchor(updated);
      await this.sendNotice(message, {
        title: "合同已更新",
        template: "green",
        icon: "yes_outlined",
        message: result.message,
      });
      return;
    }

    await this.sendNotice(message, {
      title: "合同起草返回了无效结果",
      template: "red",
      icon: "error_filled",
      message: "模型未返回可执行的合同操作结果，请重试一次或换一种说法。",
    });
  }

  private async updateWorkbenchAnchor(pending: PendingWorkbenchInteraction): Promise<void> {
    await this.deps.updatePayload(pending.chatId, pending.anchorMessageId, buildNoticeCardPayload({
      title: "合同起草会话",
      template: "blue",
      iconToken: "edit_outlined",
      message: renderWorkbenchSummaryMessage(pending.state),
    }), {
      event: "contract workbench summary updated",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(renderWorkbenchSummaryMessage(pending.state)),
      len: renderWorkbenchSummaryMessage(pending.state).length,
    });
  }

  private async startPendingUpload(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey" | "senderOpenId">,
    kind: PendingUploadKind,
    prompt: string,
  ): Promise<void> {
    this.clearInteraction(message.conversationKey);
    const interaction: PendingUploadInteraction = {
      kind,
      chatId: message.chatId,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      anchorMessageId: message.messageId,
      expiresAt: Date.now() + this.featureConfig.ingest.pendingTtlMs,
    };
    this.interactions.set(message.conversationKey, interaction);
    this.schedulePersist();
    const timer = setTimeout(() => {
      void this.expireInteraction(message.conversationKey);
    }, this.featureConfig.ingest.pendingTtlMs);
    this.timers.set(message.conversationKey, timer);
    await this.sendNotice(message, {
      title: kind === "contract-extract" ? "等待上传合同文件" : "等待上传发票文件",
      template: "blue",
      icon: "upload_outlined",
      message: prompt,
    });
  }

  private async expireInteraction(conversationKey: string): Promise<void> {
    const pending = this.interactions.get(conversationKey);
    if (!pending) {
      return;
    }
    this.clearInteraction(conversationKey);
    try {
      await this.deps.sendPayload(pending.chatId, buildNoticeCardPayload({
        title: "任务已超时",
        template: "grey",
        iconToken: "time_outlined",
        message: pending.kind === "contract-draft-onboard"
          ? "长时间未收到新的填写内容，当前合同起草引导已自动结束。重新发送 `/起草合同 引导` 即可继续。"
          : pending.kind === "contract-workbench"
            ? "长时间未收到新的合同操作，当前合同起草会话已自动结束。重新发送 `/合同起草开始` 即可继续。"
          : "长时间未收到文件，当前任务已自动结束。重新发送命令即可继续。",
      }), {
        event: "contract assistant pending expired",
        transcriptType: "outbound-final",
        textPreview: "任务已超时",
        len: 5,
      }, { replyToMessageId: pending.anchorMessageId });
    } catch (error) {
      this.deps.logger.log("contract-assistant/expire", "send timeout notice failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private clearInteraction(conversationKey: string): void {
    this.interactions.delete(conversationKey);
    const timer = this.timers.get(conversationKey);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(conversationKey);
    }
    this.schedulePersist();
  }

  private clearWorkbenchSessionsForRequester(chatId: string, requesterOpenId: string): void {
    for (const [conversationKey, interaction] of this.interactions.entries()) {
      if (interaction.kind !== "contract-workbench") {
        continue;
      }
      if (interaction.chatId === chatId && interaction.requesterOpenId === requesterOpenId) {
        this.clearInteraction(conversationKey);
      }
    }
  }

  private touchInteractionTimeout(conversationKey: string): void {
    const interaction = this.interactions.get(conversationKey);
    if (!interaction) {
      return;
    }
    interaction.expiresAt = Date.now() + this.featureConfig.ingest.pendingTtlMs;
    this.restoreTimer(conversationKey, this.featureConfig.ingest.pendingTtlMs);
    this.schedulePersist();
  }

  private async sendWorkbenchReject(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
  ): Promise<void> {
    await this.sendNotice(message, {
      title: "当前在合同起草会话中",
      template: "yellow",
      icon: "maybe_outlined",
      message: "当前在合同起草会话中，仅处理合同相关操作；如需其他内容请新开话题。",
    });
  }

  private async tickReminders(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    if (hour !== this.featureConfig.reminder.hour || minute !== this.featureConfig.reminder.minute) {
      return;
    }
    const slot = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${hour}-${minute}`;
    if (slot === this.lastReminderSlot) {
      return;
    }
    this.lastReminderSlot = slot;
    try {
      const processingMessages = await Promise.all(this.featureConfig.reminder.targetChatIds.map(async (chatId) => ({
        chatId,
        ...(await this.deps.sendPayload(chatId, buildReminderProgressPayload(), {
          event: "contract assistant reminder progress sent",
          transcriptType: "outbound-final",
          textPreview: "案件提醒",
          len: 4,
        })),
      })));
      const result = await this.deps.service!.listReminderItems(this.featureConfig.reminder.lookaheadDays);
      const payload = buildTodayTodoPayload(result);
      for (const item of processingMessages) {
        await this.deps.updatePayload(item.chatId, item.messageId, payload, {
          event: "contract assistant reminder sent",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(renderReminderPlainText(result)),
          len: renderReminderPlainText(result).length,
        });
      }
    } catch (error) {
      this.deps.logger.log("contract-assistant/reminder", "send reminder failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private async sendNotice(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    options: {
      title: string;
      template: "yellow" | "grey" | "blue" | "red" | "orange" | "green" | "indigo";
      icon: string;
      message: string;
    },
  ): Promise<{ messageId: string }> {
    return await this.deps.sendPayload(message.chatId, buildNoticeCardPayload({
      title: options.title,
      template: options.template,
      iconToken: options.icon,
      message: options.message,
    }), {
      event: "contract assistant notice sent",
      transcriptType: "outbound-final",
      textPreview: options.message,
      len: options.message.length,
    }, { replyToMessageId: message.messageId });
  }

  private async restoreState(): Promise<void> {
    const interactions = await this.readPersistedInteractions();
    const now = Date.now();
    let changed = false;
    for (const interaction of interactions) {
      if (interaction.expiresAt <= now) {
        changed = true;
        continue;
      }
      this.interactions.set(interaction.conversationKey, interaction);
      this.restoreTimer(interaction.conversationKey, interaction.expiresAt - now);
    }
    if (changed) {
      this.schedulePersist();
      await this.flushPersist();
    }
  }

  private restoreTimer(conversationKey: string, timeoutMs: number): void {
    const existing = this.timers.get(conversationKey);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      void this.expireInteraction(conversationKey);
    }, Math.max(1, timeoutMs));
    this.timers.set(conversationKey, timer);
  }

  private async readPersistedInteractions(): Promise<PendingInteraction[]> {
    try {
      const raw = await readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: number; interactions?: PendingInteraction[] };
      return Array.isArray(parsed.interactions) ? parsed.interactions : [];
    } catch {
      return [];
    }
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.stateFilePath), { recursive: true });
        await writeFile(this.stateFilePath, JSON.stringify({
          version: 1,
          interactions: [...this.interactions.values()],
        }, null, 2), "utf8");
      })
      .catch((error) => {
        this.deps.logger.log("contract-assistant/state", "persist state failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
  }

  private async flushPersist(): Promise<void> {
    await this.persistChain;
  }

  private renderWizardPrompt(pending: PendingDraftInteraction): string {
    const selectedStages = formatStages(pending.fields.stages);
    const summary = [
      pending.fields.templateName ? `模板：${pending.fields.templateName}` : null,
      pending.fields.stages.length > 0 ? `委托程序：${selectedStages}` : null,
      pending.fields.authorizationType ? `授权方式：${pending.fields.authorizationType === "general" ? "一般授权" : "特别授权"}` : null,
      pending.fields.feeMode ? `收费模式：${pending.fields.feeMode === "stage_fixed" ? "按阶段收费" : "基础收费 + 风险收费"}` : null,
      pending.fields.expenseMode ? `办案费用：${pending.fields.expenseMode === "lump_sum" ? "包干" : "实报实销"}` : null,
      pending.fields.clientName ? `甲方：${pending.fields.clientName}` : null,
      pending.fields.counterpartyName ? `对方当事人：${pending.fields.counterpartyName}` : null,
      pending.fields.caseCause ? `案由：${pending.fields.caseCause}` : null,
      pending.fields.leadLawyer ? `承办律师：${pending.fields.leadLawyer}` : null,
    ].filter((item): item is string => Boolean(item));

    const sections = [
      pending.step === "template"
        ? [
          "请选择模板：",
          ...pending.templates.map((name, index) => `${index + 1}. ${name}`),
          "",
          "可直接回复数字或模板名。",
        ]
        : pending.step === "stages"
          ? [
            "请选择委托程序：",
            "1. 仲裁阶段",
            "2. 一审诉讼",
            "3. 二审诉讼",
            "4. 执行程序",
            "5. 调解/和解",
            "",
            "可多选，回复 `1,5` 或 `仲裁、调解和解` 都可以。",
          ]
          : pending.step === "authorization"
            ? [
              "请选择授权方式：",
              "1. 一般授权",
              "2. 特别授权",
            ]
            : pending.step === "authorization-scope"
              ? [
                "请补充特别授权事项：",
                "例如：代为承认、放弃、变更诉讼请求，进行调解和和解，提起上诉，签收法律文书。",
              ]
              : pending.step === "fee-mode"
                ? [
                  "请选择收费模式：",
                  "1. 按阶段收费",
                  "2. 基础收费 + 风险收费",
                ]
                : pending.step === "fees"
                  ? pending.fields.feeMode === "base_plus_risk"
                    ? [
                      "请补充收费信息：",
                      "示例：基础费用 10000，风险收费比例 12%",
                    ]
                    : [
                      "请补充各阶段律师费：",
                      `已选程序：${selectedStages || "未填写"}`,
                      "示例：仲裁 8000，一审 12000，执行 6000",
                    ]
                  : pending.step === "expense-mode"
                    ? [
                      "请选择办案费用承担方式：",
                      "1. 包干",
                      "2. 实报实销",
                    ]
                    : pending.step === "case-basics"
                      ? [
                        "请补充案件基础信息：",
                        "示例：甲方 XXX；对方 XXX 公司、XXX 公司；案由劳动争议",
                      ]
                      : pending.step === "lead-lawyer"
                        ? [
                          "请补充承办律师：",
                          "示例：XXX 律师",
                        ]
                        : [
                          "请补充特别约定：",
                          "可回复具体内容，也可回复 `跳过`。",
                        ],
    ].flat();

    if (summary.length === 0) {
      return sections.join("\n");
    }
    return [
      ...sections,
      "",
      "当前已填写：",
      ...summary.map((line) => `- ${line}`),
      "",
      "你也可以一次性补充完整条件，我会自动识别已填写内容。",
    ].join("\n");
  }

  private mergeDraftFields(current: DraftTemplateField, answer: string, step: DraftWizardStep): DraftTemplateField {
    const next: DraftTemplateField = {
      ...current,
      stages: [...current.stages],
    };
    const normalized = answer.trim();

    if (!next.templateName && /委托代理合同-民事/.test(normalized)) {
      next.templateName = "委托代理合同-民事";
    }

    const detectedStages = detectStages(normalized);
    if (detectedStages.length > 0) {
      next.stages = uniqueStages([...next.stages, ...detectedStages]);
    }

    if (!next.authorizationType) {
      if (/一般授权/.test(normalized)) {
        next.authorizationType = "general";
      } else if (/特别授权/.test(normalized)) {
        next.authorizationType = "special";
      }
    }

    if (!next.feeMode) {
      if (/(风险收费|风险代理|风险费|回款比例|基础费用)/.test(normalized)) {
        next.feeMode = "base_plus_risk";
      } else if (/按阶段收费/.test(normalized)) {
        next.feeMode = "stage_fixed";
      }
    }

    if (!next.expenseMode) {
      if (/实报实销/.test(normalized)) {
        next.expenseMode = "reimbursement";
      } else if (/包干/.test(normalized)) {
        next.expenseMode = "lump_sum";
      }
    }

    if (!next.clientName) {
      const matched = normalized.match(/甲方(?:为|是)?[:：]?\s*([^\n；;。]+)/);
      if (matched?.[1]) {
        next.clientName = matched[1].trim();
      }
    }

    if (!next.counterpartyName) {
      const matched = normalized.match(/(?:对方当事人|对方)(?:为|是)?[:：]?\s*([^\n；;。]+)/);
      if (matched?.[1]) {
        next.counterpartyName = matched[1].trim();
      }
    }

    if (!next.caseCause) {
      const matched = normalized.match(/案由(?:为|是)?[:：]?\s*([^\n；;。]+)/);
      if (matched?.[1]) {
        next.caseCause = matched[1].trim();
      }
    }

    if (!next.leadLawyer) {
      const matched = normalized.match(/承办律师(?:为|是)?[:：]?\s*([^\n；;。]+)/);
      if (matched?.[1]) {
        next.leadLawyer = matched[1].trim();
      }
    }

    if (step === "fees" || /仲裁|一审|二审|执行|基础费用|风险收费比例/.test(normalized)) {
      const stageFees = parseStageFees(normalized, next.stages);
      if (typeof stageFees.arbitration === "number") {
        next.feeArbitration = stageFees.arbitration;
      }
      if (typeof stageFees.firstInstance === "number") {
        next.feeFirstInstance = stageFees.firstInstance;
      }
      if (typeof stageFees.secondInstance === "number") {
        next.feeSecondInstance = stageFees.secondInstance;
      }
      if (typeof stageFees.enforcement === "number") {
        next.feeEnforcement = stageFees.enforcement;
      }

      const baseFeeMatch = normalized.match(/基础(?:费用|律师费)?\s*[:：]?\s*(\d+(?:\.\d+)?)/);
      if (baseFeeMatch?.[1]) {
        next.baseFee = Number(baseFeeMatch[1]);
      }
      const riskRateMatch = normalized.match(/风险(?:收费)?比例\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%?/);
      if (riskRateMatch?.[1]) {
        next.riskFeeRate = `${riskRateMatch[1]}%`;
      }
    }

    if (!next.specialAuthorizationScope && next.authorizationType === "special" && /承认|放弃|变更|和解|调解|上诉|签收/.test(normalized)) {
      next.specialAuthorizationScope = normalized;
    }

    if (!next.specialTerms && /特别约定(?:为|是)?[:：]/.test(normalized)) {
      next.specialTerms = normalized.replace(/^.*特别约定(?:为|是)?[:：]?\s*/, "").trim();
    }

    return next;
  }

  private applyStepAnswer(pending: PendingDraftInteraction, answer: string): boolean {
    const value = answer.trim();
    switch (pending.step) {
      case "template": {
        const selected = pickTemplate(value, pending.templates);
        if (!selected && !pending.fields.templateName) {
          return false;
        }
        if (selected) {
          pending.fields.templateName = selected;
        }
        pending.step = "stages";
        return true;
      }
      case "stages": {
        if (pending.fields.stages.length === 0) {
          const selected = pickStageNumbers(value);
          if (selected.length === 0) {
            return false;
          }
          pending.fields.stages = uniqueStages([...pending.fields.stages, ...selected]);
        }
        pending.step = "authorization";
        return true;
      }
      case "authorization": {
        if (!pending.fields.authorizationType) {
          if (value === "1") {
            pending.fields.authorizationType = "general";
          } else if (value === "2") {
            pending.fields.authorizationType = "special";
          } else if (/一般授权/.test(value)) {
            pending.fields.authorizationType = "general";
          } else if (/特别授权/.test(value)) {
            pending.fields.authorizationType = "special";
          } else {
            return false;
          }
        }
        pending.step = pending.fields.authorizationType === "special" ? "authorization-scope" : "fee-mode";
        return true;
      }
      case "authorization-scope": {
        if (!value || value === "跳过") {
          return false;
        }
        pending.fields.specialAuthorizationScope = value;
        pending.step = "fee-mode";
        return true;
      }
      case "fee-mode": {
        if (!pending.fields.feeMode) {
          if (value === "1") {
            pending.fields.feeMode = "stage_fixed";
          } else if (value === "2") {
            pending.fields.feeMode = "base_plus_risk";
          } else if (/按阶段收费/.test(value)) {
            pending.fields.feeMode = "stage_fixed";
          } else if (/(基础收费|风险收费|风险代理)/.test(value)) {
            pending.fields.feeMode = "base_plus_risk";
          } else {
            return false;
          }
        }
        pending.step = "fees";
        return true;
      }
      case "fees": {
        if (pending.fields.feeMode === "base_plus_risk") {
          if (!pending.fields.baseFee || !pending.fields.riskFeeRate) {
            return false;
          }
        } else if (!hasStageFees(pending.fields)) {
          return false;
        }
        pending.step = "expense-mode";
        return true;
      }
      case "expense-mode": {
        if (!pending.fields.expenseMode) {
          if (value === "1") {
            pending.fields.expenseMode = "lump_sum";
          } else if (value === "2") {
            pending.fields.expenseMode = "reimbursement";
          } else if (/包干/.test(value)) {
            pending.fields.expenseMode = "lump_sum";
          } else if (/实报实销/.test(value)) {
            pending.fields.expenseMode = "reimbursement";
          } else {
            return false;
          }
        }
        pending.step = "case-basics";
        return true;
      }
      case "case-basics": {
        if (!pending.fields.clientName || !pending.fields.counterpartyName || !pending.fields.caseCause) {
          return false;
        }
        pending.step = "lead-lawyer";
        return true;
      }
      case "lead-lawyer": {
        if (!pending.fields.leadLawyer) {
          pending.fields.leadLawyer = value;
        }
        pending.step = "special-terms";
        return true;
      }
      case "special-terms": {
        if (value && value !== "跳过") {
          pending.fields.specialTerms = value;
        }
        return true;
      }
      default:
        return false;
    }
  }

  private isDraftWizardReady(pending: PendingDraftInteraction): boolean {
    if (pending.step !== "special-terms") {
      return false;
    }
    return Boolean(
      pending.fields.templateName
      && pending.fields.authorizationType
      && pending.fields.feeMode
      && pending.fields.expenseMode
      && pending.fields.clientName
      && pending.fields.counterpartyName
      && pending.fields.caseCause
      && pending.fields.leadLawyer
      && pending.fields.stages.length > 0
      && (
        pending.fields.feeMode === "base_plus_risk"
          ? pending.fields.baseFee && pending.fields.riskFeeRate
          : hasStageFees(pending.fields)
      ),
    );
  }

  private advanceDraftWizard(pending: PendingDraftInteraction): void {
    let advanced = true;
    while (advanced) {
      advanced = false;
      if (pending.step === "template" && pending.fields.templateName) {
        pending.step = "stages";
        advanced = true;
        continue;
      }
      if (pending.step === "stages" && pending.fields.stages.length > 0) {
        pending.step = "authorization";
        advanced = true;
        continue;
      }
      if (pending.step === "authorization" && pending.fields.authorizationType) {
        pending.step = pending.fields.authorizationType === "special" ? "authorization-scope" : "fee-mode";
        advanced = true;
        continue;
      }
      if (pending.step === "authorization-scope" && pending.fields.specialAuthorizationScope) {
        pending.step = "fee-mode";
        advanced = true;
        continue;
      }
      if (pending.step === "fee-mode" && pending.fields.feeMode) {
        pending.step = "fees";
        advanced = true;
        continue;
      }
      if (pending.step === "fees") {
        if (pending.fields.feeMode === "base_plus_risk" && pending.fields.baseFee && pending.fields.riskFeeRate) {
          pending.step = "expense-mode";
          advanced = true;
          continue;
        }
        if (pending.fields.feeMode === "stage_fixed" && hasStageFees(pending.fields)) {
          pending.step = "expense-mode";
          advanced = true;
          continue;
        }
      }
      if (pending.step === "expense-mode" && pending.fields.expenseMode) {
        pending.step = "case-basics";
        advanced = true;
        continue;
      }
      if (pending.step === "case-basics" && pending.fields.clientName && pending.fields.counterpartyName && pending.fields.caseCause) {
        pending.step = "lead-lawyer";
        advanced = true;
        continue;
      }
      if (pending.step === "lead-lawyer" && pending.fields.leadLawyer) {
        pending.step = "special-terms";
        advanced = true;
        continue;
      }
      return;
    }
  }

  private buildDraftRequestFromFields(fields: DraftTemplateField): string {
    const lines = [
      `使用《${fields.templateName ?? "委托代理合同-民事"}》模板`,
      `甲方为${fields.clientName ?? "【待补】"}`,
      `对方当事人为${fields.counterpartyName ?? "【待补】"}`,
      `案由为${fields.caseCause ?? "【待补】"}`,
      `委托程序选择：${formatStages(fields.stages) || "【待补】"}`,
      `授权方式选择：${fields.authorizationType === "special" ? "特别授权" : "一般授权"}`,
      fields.authorizationType === "special" && fields.specialAuthorizationScope
        ? `特别授权事项：${fields.specialAuthorizationScope}`
        : null,
      fields.feeMode === "base_plus_risk"
        ? `收费模式选择：基础收费+风险收费，基础费用 ${formatMoney(fields.baseFee)} 元，风险收费比例 ${fields.riskFeeRate ?? "【待补】"}`
        : `收费模式选择：按阶段收费，${formatStageFeeSummary(fields)}`,
      `办案费用承担方式选择：${fields.expenseMode === "lump_sum" ? "包干" : "实报实销"}`,
      `承办律师为${fields.leadLawyer ?? "【待补】"}`,
      "签约地点为深圳，签约日期为今天",
      fields.specialTerms ? `特别约定：${fields.specialTerms}` : null,
    ].filter((item): item is string => Boolean(item));
    return lines.join("，");
  }
}

function renderReminderPlainText(result: ReminderListResult): string {
  return [
    ...result.caseLines,
    ...result.contractLines,
    ...result.invoiceLines,
  ].join("\n") || "当前无需要提醒的事项";
}

function pickTemplate(answer: string, templates: string[]): string | undefined {
  if (/^\d+$/.test(answer)) {
    const index = Number(answer) - 1;
    return templates[index];
  }
  const normalized = answer.replace(/\s+/g, "");
  return templates.find((name) => normalized.includes(name.replace(/\s+/g, "")));
}

function detectStages(answer: string): Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement"> {
  const stages: Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement"> = [];
  if (/仲裁/.test(answer)) stages.push("arbitration");
  if (/一审/.test(answer)) stages.push("first_instance");
  if (/二审/.test(answer)) stages.push("second_instance");
  if (/执行/.test(answer)) stages.push("enforcement");
  if (/(调解|和解)/.test(answer)) stages.push("settlement");
  return stages;
}

function pickStageNumbers(answer: string): Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement"> {
  const mapping: Record<string, "arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement"> = {
    "1": "arbitration",
    "2": "first_instance",
    "3": "second_instance",
    "4": "enforcement",
    "5": "settlement",
  };
  const values = answer.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean);
  const stages = values.map((value) => mapping[value]).filter((value): value is "arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement" => Boolean(value));
  return uniqueStages([...stages, ...detectStages(answer)]);
}

function uniqueStages(stages: Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement">): Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement"> {
  return [...new Set(stages)];
}

function parseStageFees(answer: string, stages: Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement">): {
  arbitration?: number;
  firstInstance?: number;
  secondInstance?: number;
  enforcement?: number;
} {
  const read = (pattern: RegExp): number | undefined => {
    const matched = answer.match(pattern);
    return matched?.[1] ? Number(matched[1]) : undefined;
  };
  const result: {
    arbitration?: number;
    firstInstance?: number;
    secondInstance?: number;
    enforcement?: number;
  } = {};
  const arbitration = read(/仲裁(?:阶段)?(?:律师费)?\s*[:：]?\s*(\d+(?:\.\d+)?)/);
  const firstInstance = read(/一审(?:阶段|诉讼)?(?:律师费)?\s*[:：]?\s*(\d+(?:\.\d+)?)/);
  const secondInstance = read(/二审(?:阶段|诉讼)?(?:律师费)?\s*[:：]?\s*(\d+(?:\.\d+)?)/);
  const enforcement = read(/执行(?:阶段|程序)?(?:律师费)?\s*[:：]?\s*(\d+(?:\.\d+)?)/);
  if (typeof arbitration === "number") result.arbitration = arbitration;
  if (typeof firstInstance === "number") result.firstInstance = firstInstance;
  if (typeof secondInstance === "number") result.secondInstance = secondInstance;
  if (typeof enforcement === "number") result.enforcement = enforcement;
  const onlyOneStage = stages.filter((stage) => stage !== "settlement").length === 1;
  const bareAmountMatch = answer.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (onlyOneStage && bareAmountMatch?.[1]) {
    const amount = Number(bareAmountMatch[1]);
    if (stages.includes("arbitration")) result.arbitration = amount;
    if (stages.includes("first_instance")) result.firstInstance = amount;
    if (stages.includes("second_instance")) result.secondInstance = amount;
    if (stages.includes("enforcement")) result.enforcement = amount;
  }
  return result;
}

function hasStageFees(fields: DraftTemplateField): boolean {
  return Boolean(
    (fields.stages.includes("arbitration") && fields.feeArbitration)
    || (fields.stages.includes("first_instance") && fields.feeFirstInstance)
    || (fields.stages.includes("second_instance") && fields.feeSecondInstance)
    || (fields.stages.includes("enforcement") && fields.feeEnforcement),
  );
}

function formatStages(stages: Array<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement">): string {
  const labels: Record<"arbitration" | "first_instance" | "second_instance" | "enforcement" | "settlement", string> = {
    arbitration: "仲裁阶段",
    first_instance: "一审诉讼",
    second_instance: "二审诉讼",
    enforcement: "执行程序",
    settlement: "调解/和解",
  };
  return stages.map((stage) => labels[stage]).join("、");
}

function formatStageFeeSummary(fields: DraftTemplateField): string {
  const lines: string[] = [];
  if (fields.stages.includes("arbitration") && fields.feeArbitration) {
    lines.push(`仲裁阶段律师费 ${formatMoney(fields.feeArbitration)} 元`);
  }
  if (fields.stages.includes("first_instance") && fields.feeFirstInstance) {
    lines.push(`一审阶段律师费 ${formatMoney(fields.feeFirstInstance)} 元`);
  }
  if (fields.stages.includes("second_instance") && fields.feeSecondInstance) {
    lines.push(`二审阶段律师费 ${formatMoney(fields.feeSecondInstance)} 元`);
  }
  if (fields.stages.includes("enforcement") && fields.feeEnforcement) {
    lines.push(`执行阶段律师费 ${formatMoney(fields.feeEnforcement)} 元`);
  }
  if (fields.stages.includes("settlement")) {
    lines.push("包含调解/和解事宜");
  }
  return lines.join("，");
}

function formatMoney(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}` : "【待补】";
}

function buildCaseCreateProcessingPayload(request: string): FeishuPostPayload {
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

function buildContractDraftProgressPayload(view: ContractDraftProgressView): FeishuPostPayload {
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

function buildContractDraftCompletedPayload(
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

function buildCaseCreateCompletedPayload(result: CaseCreateResult, recordUrl: string): FeishuPostPayload {
  const record = result.record;
  const clientName = readCaseField(record, "委托人") ?? "委托人";
  const counterpartyName = readCaseField(record, "对方当事人") ?? "对方当事人";
  const type = readCaseField(record, "类型");
  const stage = readCaseField(record, "程序阶段");
  const headline = `${clientName} vs ${counterpartyName}`;
  const tagLine = [type, stage].filter(Boolean).join("｜");
  const chips = [
    readCaseField(record, "委托人"),
    readCaseField(record, "对方当事人"),
    readCaseField(record, "案由"),
    readCaseField(record, "审理法院"),
    readCaseField(record, "承办律师"),
    readCaseField(record, "案件状态"),
  ].filter((item): item is string => Boolean(item));

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

function buildInvoiceRecognizeProgressPayload(view: InvoiceRecognizeProgressView): FeishuPostPayload {
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

function buildInvoiceRecognizeCompletedPayload(
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

function buildReminderProgressPayload(): FeishuPostPayload {
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

function buildTodayTodoPayload(result: ReminderListResult): FeishuPostPayload {
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
  return caseColumnSet(values.map((value) => caseColumn([
    caseMarkdown(escapeCardMarkdown(value), { size: "normal" }),
  ], {
    bg: "grey-50",
    padding: "4px 4px 4px 4px",
  })), { spacing: "8px", flow: true });
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

function createInvoiceRecognizeProgressState(): InvoiceRecognizeProgressView {
  return {
    steps: [
      { label: "OCR 识别发票内容", status: "pending" },
      { label: "填写表格", status: "pending" },
    ],
  };
}

function applyInvoiceRecognizeStep(view: InvoiceRecognizeProgressView, currentIndex: number): void {
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

function completeInvoiceRecognizeProgress(view: InvoiceRecognizeProgressView): void {
  view.steps.forEach((step) => {
    step.status = "completed";
  });
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
  const due = matchFirst(rest, [/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/]) ?? "";
  const title = localizeReminderTitle(rest);
  const detailTail = rest
    .replace(due, "")
    .replace(/；?当前状态\s*[^；;]+/, "")
    .replace(/^\S+\s*/, "")
    .trim();
  return {
    title,
    detail: [caseLabel.trim(), detailTail || status].filter(Boolean).join(" · "),
    due: formatReminderDue(due),
    bg: title.includes("截止") ? "red-50" : title.includes("开庭") ? "yellow-50" : "grey-50",
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

function localizeReminderTitle(text: string): string {
  if (text.includes("举证")) return "举证期限截止";
  if (text.includes("开庭")) return "开庭提醒";
  if (text.includes("上诉")) return "上诉期限截止";
  if (text.includes("反诉")) return "反诉期限截止";
  if (text.includes("管辖权异议")) return "管辖权异议期限截止";
  return "案件提醒";
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
      return `正在${step.label}…`;
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

function createContractDraftProgressState(request: string): ContractDraftProgressView {
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

function applyContractDraftProgress(
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

function completeContractDraftProgress(view: ContractDraftProgressView): void {
  view.steps.forEach((step) => {
    step.status = "completed";
    step.detail = undefined;
  });
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
  const client = matchFirst(compact, [/甲方[：:\s]*([^，。,；;\n]+)/, /委托人[：:\s]*([^，。,；;\n]+)/]) ?? "委托人";
  const counterparty = matchFirst(compact, [/对方[：:\s]*([^，。,；;\n]+)/, /乙方[：:\s]*([^，。,；;\n]+)/]) ?? "相关单位";
  const cause = matchFirst(compact, [/案由[：:\s]*([^，。,；;\n]+)/]);
  const stage = matchFirst(compact, [/(劳动仲裁|仲裁|一审|二审|执行)/]);
  const fee = matchFirst(compact, [/律师费[：:\s]*([0-9,.]+)\s*元?/, /(仲裁|一审|二审|执行)\s*([0-9,.]+)\s*元/]);

  return {
    title: `委托代理合同（${client} vs ${counterparty}）`,
    ...([cause, stage].filter(Boolean).length > 0 ? { tagLine: [cause, stage].filter(Boolean).join("｜") } : {}),
    ...(fee ? { feeLine: `律师费：¥${normalizeMoneyText(fee)}` } : {}),
  };
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

function normalizeMoneyText(value: string): string {
  const digits = value.replace(/[^\d.]/g, "");
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

function buildBitableRecordUrl(baseToken: string, tableId: string, recordId: string): string {
  const base = `https://feishu.cn/base/${encodeURIComponent(baseToken)}?table=${encodeURIComponent(tableId)}`;
  return `${base}&recordId=${encodeURIComponent(recordId)}`;
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

function renderWorkbenchSummaryMessage(state: ContractState | null): string {
  if (!state) {
    return [
      "当前会话仅处理本份合同的查看、删改、补充和导出。",
      "你现在可以上传模板 Word、上传已有合同，或直接发送文字描述。",
      "如需结束当前会话，请发送 `/合同起草结束`。",
    ].join("\n");
  }
  const latestHistory = state.history.at(-1);
  const latestClauses = state.clauses.slice(0, 3).map((clause) => `- ${formatClauseLabel(clause)}`).join("\n");
  return [
    `当前合同：${state.title}`,
    `来源：${formatSourceMode(state.sourceMode)}`,
    `当前版本：v${state.version}`,
    `条款数量：${state.clauses.length}`,
    latestHistory ? `最近修改：${latestHistory.summary}` : "最近修改：初始化完成",
    state.draftPath ? `当前 Word 草稿：${state.draftPath}` : "当前 Word 草稿：尚未导出",
    "",
    "示例操作：",
    "显示第九条 / 删除风险收费部分 / 把争议解决改成法院诉讼 / 重新导出 Word",
    latestClauses ? `\n当前条款预览：\n${latestClauses}` : "",
  ].filter(Boolean).join("\n");
}

function formatSourceMode(sourceMode: ContractState["sourceMode"]): string {
  switch (sourceMode) {
    case "template_upload":
      return "模板导入";
    case "existing_contract_upload":
      return "已有合同导入";
    default:
      return "文字描述起草";
  }
}

function formatClauseLabel(clause: ContractClause): string {
  const title = clause.title.trim();
  return `${clause.number}${title ? ` ${title}` : ""}`.trim();
}

function pushRecentMessages(current: string[], next: string): string[] {
  return [...current, next.trim()].filter((item) => item.length > 0).slice(-8);
}
