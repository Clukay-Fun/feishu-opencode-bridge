import { DEFAULT_CONTRACT_ASSISTANT_CONFIG, type AppConfig, type ContractAssistantConfig } from "../config/schema.js";
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

type PendingUploadInteraction = {
  kind: PendingUploadKind;
  chatId: string;
  conversationKey: string;
  requesterOpenId: string;
  anchorMessageId: string;
  expiresAt: number;
};

export class ContractAssistantRuntimeModule implements RuntimeModule {
  readonly name = "contract-assistant";
  readonly priority = 30;

  private readonly interactions = new Map<string, PendingUploadInteraction>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private reminderTimer: NodeJS.Timeout | null = null;
  private lastReminderSlot = "";
  private readonly featureConfig: ContractAssistantConfig;

  constructor(private readonly deps: ContractAssistantRuntimeModuleDeps) {
    this.featureConfig = deps.config.contractAssistant ?? DEFAULT_CONTRACT_ASSISTANT_CONFIG;
  }

  async start(): Promise<void> {
    if (!this.featureConfig.enabled || !this.featureConfig.reminder.enabled || !this.deps.service) {
      return;
    }
    this.reminderTimer = setInterval(() => {
      void this.tickReminders();
    }, 60_000);
    await this.tickReminders();
  }

  async stop(): Promise<void> {
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

    if (pending) {
      if (message.senderOpenId !== pending.requesterOpenId) {
        await this.sendNotice(message, {
          title: "当前任务仅限发起人继续",
          template: "yellow",
          icon: "maybe_outlined",
          message: "请由当前发起人继续上传文件，或等待任务处理结束。",
        });
        return { claimed: true };
      }
      const handled = await this.handlePendingUpload(message, pending);
      if (handled) {
        return { claimed: true };
      }
    }

    if (routed?.kind !== "command") {
      return { claimed: false };
    }

    const claimed = await this.handleCommand(message, routed.command);
    return { claimed };
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
          message: "示例：`/起草合同 起草一份软件开发服务合同，甲方杭州某科技公司，乙方张三工作室，金额 20 万`",
        });
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
          message: "示例：`/案件录入 民间借贷，委托人李四，对方王五，浦东法院，一审立案中，举证截止 2026-04-30`",
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
      const markdown = [
        `### ${result.docTitle}`,
        "",
        result.docUrl ? `文档链接：[打开飞书文档](${result.docUrl})` : "文档创建失败，已保留 Markdown 草稿。",
        result.recordId ? `合同台账记录：\`${result.recordId}\`` : "合同台账记录：未写入",
        "",
        "### 草稿预览",
        "",
        result.markdown,
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildPostMarkdownPayload(markdown), {
        event: "contract draft completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(markdown),
        len: markdown.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
        messageIconToken: "error_filled",
        messageIconColor: "red",
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
      const markdown = [
        "### 合同录入完成",
        "",
        `文件：${file.fileName}`,
        `合同台账记录：\`${result.recordId}\``,
        "",
        result.summary,
        "",
        "```json",
        JSON.stringify(result.record, null, 2),
        "```",
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildPostMarkdownPayload(markdown), {
        event: "contract extract completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(markdown),
        len: markdown.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同录入失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
        messageIconToken: "error_filled",
        messageIconColor: "red",
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
      const lines = [
        "### 发票识别完成",
        "",
        `文件：${file.fileName}`,
        `发票记录：\`${result.recordId}\``,
        result.matchedContract ? `关联合同：${result.matchedContract}` : "关联合同：未匹配到，待人工确认",
        "",
        result.summary,
        "",
        "```json",
        JSON.stringify(result.record, null, 2),
        "```",
      ];
      const markdown = lines.join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildPostMarkdownPayload(markdown), {
        event: "invoice recognize completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(markdown),
        len: markdown.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "发票识别失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
        messageIconToken: "error_filled",
        messageIconColor: "red",
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
      const markdown = [
        "### 案件录入完成",
        "",
        `案件记录：\`${result.recordId}\``,
        result.summary,
        "",
        "```json",
        JSON.stringify(result.record, null, 2),
        "```",
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildPostMarkdownPayload(markdown), {
        event: "case create completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(markdown),
        len: markdown.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件录入失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
        messageIconToken: "error_filled",
        messageIconColor: "red",
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
      const markdown = [
        "### 案件更新完成",
        "",
        `匹配案件：${result.matchedLabel}`,
        "",
        "```json",
        JSON.stringify(result.fields, null, 2),
        "```",
      ].join("\n");
      await this.deps.updatePayload(message.chatId, processing.messageId, buildPostMarkdownPayload(markdown), {
        event: "case update completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(markdown),
        len: markdown.length,
      });
    } catch (error) {
      await this.deps.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件更新失败",
        template: "red",
        iconToken: "error_filled",
        message: error instanceof Error ? error.message : String(error),
        messageIconToken: "error_filled",
        messageIconColor: "red",
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
        message: "长时间未收到文件，当前任务已自动结束。重新发送命令即可继续。",
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
      messageIconToken: options.icon,
      messageIconColor: options.template,
    }), {
      event: "contract assistant notice sent",
      transcriptType: "outbound-final",
      textPreview: options.message,
      len: options.message.length,
    }, { replyToMessageId: message.messageId });
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

function renderList(lines: string[]): string[] {
  if (lines.length === 0) {
    return ["- 当前无需要提醒的事项"];
  }
  return lines.map((line) => `- ${line}`);
}
