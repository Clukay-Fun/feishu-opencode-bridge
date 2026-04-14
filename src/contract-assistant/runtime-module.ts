import { DEFAULT_CONTRACT_ASSISTANT_CONFIG, type AppConfig, type ContractAssistantConfig } from "../config/schema.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  type FeishuPostPayload,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { RoutedText } from "../bridge/router.js";
import type {
  ContractAssistantService,
  ContractAssistantFileRef,
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

type PendingInteraction = PendingUploadInteraction | PendingDraftInteraction;

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
    if (routed?.kind === "command") {
      const claimed = await this.handleCommand(message, routed.command);
      return { claimed };
    }

    const pending = this.interactions.get(message.conversationKey) ?? null;
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
          : "请由当前发起人继续上传文件，或等待任务处理结束。",
      });
      return { claimed: true };
    }

    if (pending.kind === "contract-draft-onboard") {
      const handled = await this.handlePendingDraft(message, pending);
      return { claimed: handled };
    }

    const handled = await this.handlePendingUpload(message, pending);
    return { claimed: handled };
  }

  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">,
    command: ContractAssistantCommand,
  ): Promise<boolean> {
    if (command.kind !== "passthrough") {
      return false;
    }

    const normalized = command.name.trim().toLowerCase();
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

  private async handleContractDraft(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    request: string,
  ): Promise<void> {
    const processing = await this.sendNotice(message, {
      title: "合同起草中",
      template: "blue",
      icon: "edit_outlined",
      message: "正在生成合同草稿，并同步写入飞书文档与合同台账。",
    });
    try {
      const result = await this.deps.service!.draftContract(request);
      const summary = [
        `Word 文件：${result.wordPath}`,
        result.docUrl ? `飞书文档：[打开飞书文档](${result.docUrl})` : "飞书文档：未创建",
        result.recordId ? `合同台账记录：${result.recordId}` : "合同台账记录：未写入",
        ...(result.warnings.length > 0 ? ["", ...result.warnings.map((item) => `- ${item}`)] : []),
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草完成",
        template: "green",
        iconToken: "yes_outlined",
        message: summary,
      }), {
        event: "contract draft completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
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
        `合同台账记录：${result.recordId}`,
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
    const processing = await this.sendNotice(message, {
      title: "发票识别中",
      template: "blue",
      icon: "bill_outlined",
      message: `正在识别《${file.fileName}》中的发票字段，并写入发票记录。`,
    });
    try {
      const result = await this.deps.service!.recognizeInvoice(file);
      const summary = [
        `文件：${file.fileName}`,
        `发票记录：${result.recordId}`,
        result.matchedContract ? `关联合同：${result.matchedContract}` : "关联合同：未匹配到，待人工确认",
        result.summary,
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "发票识别完成",
        template: "green",
        iconToken: "yes_outlined",
        message: summary,
      }), {
        event: "invoice recognize completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
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
    const processing = await this.sendNotice(message, {
      title: "案件录入中",
      template: "blue",
      icon: "file-task_outlined",
      message: "正在整理案件字段并写入案件管理表。",
    });
    try {
      const result = await this.deps.service!.createCase(request);
      const summary = [
        `案件记录：${result.recordId}`,
        result.summary,
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件录入完成",
        template: "green",
        iconToken: "yes_outlined",
        message: summary,
      }), {
        event: "case create completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
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
          : "长时间未收到文件，当前任务已自动结束。重新发送命令即可继续。",
        messageIconToken: "time_outlined",
        messageIconColor: "grey",
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
      const result = await this.deps.service!.listReminderItems(this.featureConfig.reminder.lookaheadDays);
      const markdown = renderReminderMarkdown(result);
      for (const chatId of this.featureConfig.reminder.targetChatIds) {
        await this.deps.sendPayload(chatId, buildPostMarkdownPayload(markdown), {
          event: "contract assistant reminder sent",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(markdown),
          len: markdown.length,
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

function renderReminderMarkdown(result: {
  contractLines: string[];
  invoiceLines: string[];
  caseLines: string[];
}): string {
  const sections = [
    "### 合同助手提醒",
    "",
    "#### 合同台账",
    ...renderList(result.contractLines),
    "",
    "#### 发票记录",
    ...renderList(result.invoiceLines),
    "",
    "#### 案件管理",
    ...renderList(result.caseLines),
  ];
  return sections.join("\n");
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

function renderList(lines: string[]): string[] {
  if (lines.length === 0) {
    return ["- 当前无需要提醒的事项"];
  }
  return lines.map((line) => `- ${line}`);
}
