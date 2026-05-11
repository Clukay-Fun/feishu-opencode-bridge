/**
 * 职责: 将合同助手能力接入运行时模块体系。
 * 关注点:
 * - 拦截合同、案件、发票相关命令并启动对应流程。
 * - 管理上传态交互和进度卡的桥接逻辑。
 * - 协调领域服务、卡片构建和会话上下文。
 */
import { DEFAULT_CONTRACT_ASSISTANT_CONFIG, type AppConfig, type ContractAssistantConfig } from "../config/schema.js";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import { routeIncomingText } from "../bridge/router.js";
import type { PendingFileInstructionInteraction } from "../bridge/state.js";
import { buildNoticeCardPayload, resolveNoticeLevelFromTemplate } from "../feishu/shared-primitives.js";
import {
  applyContractDraftProgress,
  applyCaseCreateProgress,
  applyInvoiceRecognizeStep,
  buildCaseCreateCompletedPayload,
  buildCaseCreateProcessingPayload,
  buildCaseTodoReminderPayload,
  buildContractDraftCompletedPayload,
  buildContractDraftProgressPayload,
  buildInvoiceRecognizeCompletedPayload,
  buildInvoiceRecognizeProgressPayload,
  completeContractDraftProgress,
  completeCaseCreateProgress,
  completeInvoiceRecognizeProgress,
  createCaseCreateProgressState,
  createContractDraftProgressState,
  createInvoiceRecognizeProgressState,
} from "../feishu/contract-cards.js";
import { createTextPreview, type Logger } from "../logging/logger.js";
import type { IncomingChatMessage, IncomingFileMessage } from "../runtime/app.js";
import type { RoutedText } from "../bridge/router.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import { PersistedInteractionManager } from "../runtime/persisted-interaction-manager.js";
import type {
  ContractAssistantService,
  ContractClause,
  ContractAssistantFileInput,
  ContractAssistantFileRef,
  ContractState,
  ContractWorkbenchModelResult,
  InvoiceRecognizeProgressEvent,
  InvoiceRecognizeResult,
  InvoiceLedgerListResult,
} from "./index.js";

type ContractAssistantRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  service: ContractAssistantService | null;
  transport: FeishuTransport;
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
  files?: ContractAssistantFileRef[] | undefined;
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

const CONTRACT_EXTRACT_COMMAND_ALIASES = new Set(["contract-extract", "合同录入"]);
const INVOICE_RECOGNIZE_COMMAND_ALIASES = new Set(["invoice-recognize", "识别发票"]);

export class ContractAssistantRuntimeModule implements RuntimeModule {
  readonly name = "contract-assistant";
  readonly priority = 30;

  private readonly interactions: PersistedInteractionManager<PendingInteraction>;
  private readonly featureConfig: ContractAssistantConfig;

  constructor(private readonly deps: ContractAssistantRuntimeModuleDeps) {
    this.featureConfig = deps.config.contractAssistant ?? DEFAULT_CONTRACT_ASSISTANT_CONFIG;
    this.interactions = new PersistedInteractionManager({
      stateFilePath: path.join(deps.config.storage.dataDir, "contract-assistant-state.json"),
      logger: deps.logger,
      logScope: "contract-assistant/state",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
      onExpire: async (interaction) => {
        await this.handleExpiredInteraction(interaction);
      },
    });
  }

  // #region 生命周期与入口

  /** 恢复交互状态。 */
  async start(): Promise<void> {
    await this.interactions.restore();
  }

  /** 停止状态管理器。 */
  async stop(): Promise<void> {
    await this.interactions.stop();
  }

  /** 在普通对话前注入发票台账真实数据，让最终回复仍走标准 OpenCode 卡片。 */
  async beforeTurn(context: { turn: { plainText: string } }): Promise<{ systemBlocks?: string[] } | void> {
    if (!this.featureConfig.enabled || !this.deps.service || !isInvoiceLedgerQuery(context.turn.plainText)) {
      return;
    }
    try {
      const ledger = await this.deps.service.listRecentInvoices(10);
      return {
        systemBlocks: [renderInvoiceLedgerSystemBlock(ledger)],
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.log("contract-assistant", "invoice ledger context skipped", { detail }, "warn");
      return {
        systemBlocks: [
          [
            "[Invoice Ledger Context]",
            "用户正在询问发票表格/台账中的发票情况，但本轮读取发票表失败。",
            `读取错误：${detail}`,
            "请明确说明当前无法读取发票表，不要根据聊天记录或上传历史推断台账数据。",
          ].join("\n"),
        ],
      };
    }
  }

  async handleCardAction(
    _actorOpenId: string,
    _openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (value.kind !== "contract-case-action") {
      return null;
    }
    const action = typeof value.action === "string" ? value.action : "";
    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (action !== "open-case-table" && action !== "open-case-record") {
      return buildContractActionToast("未识别的案件卡片操作。", "warning");
    }
    if (!url) {
      return buildContractActionToast("案件链接缺失，请从案件管理表中打开。", "warning");
    }
    return buildContractActionToast("正在打开案件管理表。", "success");
  }

  /** 处理合同助手命令、上传态交互和工作台对话。 */
  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    const pending = this.interactions.get(message.conversationKey) ?? null;
    const workbench = pending?.kind === "contract-workbench" ? pending : null;
    if (pending && message.senderOpenId !== pending.requesterOpenId) {
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

    if (pending && routed?.kind === "command" && isContractReentryCommand(routed.command, pending.kind)) {
      await this.sendNotice(message, {
        title: pending.kind === "contract-workbench" ? "已有合同起草会话" : "已有合同起草引导",
        template: "yellow",
        icon: "maybe_outlined",
        message: pending.kind === "contract-workbench"
          ? "请继续编辑当前合同，或发送 `/合同起草结束` 后再开始新的合同起草会话。"
          : "请继续填写当前引导，或等待引导超时后重新发送 `/起草合同 引导`。",
      });
      return { claimed: true };
    }

    if (pending?.kind === "invoice-recognize" && routed?.kind === "command" && isUploadFinishCommand(routed.command)) {
      const handled = await this.handlePendingUpload(message, pending, routed);
      return { claimed: handled };
    }

    if (routed?.kind === "command") {
      const claimed = await this.handleCommand(message, routed.command, workbench);
      return { claimed };
    }

    if (!pending) {
      return { claimed: false };
    }

    if (pending.kind === "contract-draft-onboard") {
      const handled = await this.handlePendingDraft(message, pending);
      return { claimed: handled };
    }

    if (pending.kind === "contract-workbench") {
      const handled = await this.handleWorkbenchMessage(message, pending);
      return { claimed: handled };
    }

    const handled = await this.handlePendingUpload(message, pending, routed);
    return { claimed: handled };
  }

  async claimFileInstruction(
    pending: PendingFileInstructionInteraction,
    message: IncomingChatMessage,
  ): Promise<boolean> {
    if (message.messageType === "file" || message.senderOpenId !== pending.requesterOpenId) {
      return false;
    }
    const pendingKind = detectPendingUploadKind(message.plainText);
    if (!pendingKind) {
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
    if (!this.isFileAcceptableFor(pendingKind, pending.file.fileName)) {
      await this.startPendingUpload(
        message,
        pendingKind,
        pendingKind === "contract-extract"
          ? `最近上传的《${pending.file.fileName}》不像合同文件，请重新上传 1 份合同文件，我会提取字段并写入合同台账。`
          : `最近上传的《${pending.file.fileName}》不像发票文件，请重新上传发票文件；可连续上传多份，完成后发送 /完成上传。`,
      );
      return true;
    }
    const fileRef: ContractAssistantFileRef = {
      messageId: pending.file.messageId,
      fileKey: pending.file.fileKey,
      fileName: pending.file.fileName,
      size: pending.file.size,
    };
    if (pendingKind === "contract-extract") {
      await this.handleContractExtract(message, fileRef);
      return true;
    }
    await this.handleInvoiceRecognize(message, fileRef);
    return true;
  }

  /** 处理合同、案件、发票和工作台相关命令。 */
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
    const commandText = [command.name, ...command.arguments].join(" ").trim();
    const localInvoiceFiles = await this.resolveLocalInvoiceFilesFromText(commandText);
    if (localInvoiceFiles.length > 0) {
      if (localInvoiceFiles.length === 1) {
        await this.handleInvoiceRecognize(message, buildLocalContractFileInput(localInvoiceFiles[0]!));
      } else {
        await this.handleInvoiceRecognizeBatch(message, localInvoiceFiles.map(buildLocalContractFileInput));
      }
      return true;
    }
    if (normalized === "contract-workbench") {
      await this.sendNotice(message, {
        title: "命令已更新",
        template: "yellow",
        icon: "maybe_outlined",
        message: command.arguments[0]?.trim().toLowerCase() === "end"
          ? "合同起草结束命令已从 `/contract-workbench end` 迁移到 `/合同起草结束`。"
          : "合同起草入口已从 `/contract-workbench` 迁移到 `/合同起草开始`。",
      });
      return true;
    }

    if (normalized === "合同起草结束") {
      if (!workbench) {
        await this.sendNotice(message, {
          title: "当前没有进行中的合同起草会话",
          template: "grey",
          icon: "maybe_outlined",
          message: "发送 `/合同起草开始` 可开启新的合同起草会话。",
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

    if (normalized === "合同起草开始") {
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
      "案件待办",
      "case-todos",
      "案件更新待办",
      "case-update-todos",
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
      const localPath = extractLocalPath(command.arguments.join(" ").trim());
      if (localPath) {
        await this.handleContractExtract(message, buildLocalContractFileInput(localPath));
        return true;
      }
      await this.startPendingUpload(message, "contract-extract", "请直接上传 1 份合同文件，我会提取字段并写入合同台账。");
      return true;
    }

    if (normalized === "invoice-recognize" || normalized === "识别发票") {
      const localPath = extractLocalPath(command.arguments.join(" ").trim());
      if (localPath) {
        await this.handleInvoiceRecognize(message, buildLocalContractFileInput(localPath));
        return true;
      }
      await this.startPendingUpload(message, "invoice-recognize", "可连续上传一份或多份发票文件。上传完成后发送 `/完成上传`，我会统一识别字段并写入发票记录。");
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

    if (normalized === "案件待办" || normalized === "case-todos") {
      await this.handleCaseTodos(message, command.arguments.join(" ").trim());
      return true;
    }

    if (normalized === "案件更新待办" || normalized === "case-update-todos") {
      await this.sendNotice(message, {
        title: "命令已下线",
        template: "yellow",
        icon: "maybe_outlined",
        message: "兼容命令 `/案件更新待办` 已下线。请改用 `/案件更新 案号XXX 待做事项 ...` 更新案件记录。",
      });
      return true;
    }

    return false;
  }

  private async handlePendingUpload(
    message: IncomingChatMessage,
    pending: PendingUploadInteraction,
    routed: RoutedText | null | undefined,
  ): Promise<boolean> {
    if (pending.kind === "invoice-recognize" && routed?.kind === "command" && isUploadFinishCommand(routed.command)) {
      const files = pending.files ?? [];
      if (files.length === 0) {
        await this.sendNotice(message, {
          title: "还没有收到发票文件",
          template: "yellow",
          icon: "maybe_outlined",
          message: "请先上传一份或多份发票文件，再发送 `/完成上传`。",
        });
        return true;
      }
      this.clearInteraction(message.conversationKey);
      if (files.length === 1) {
        await this.handleInvoiceRecognize(message, files[0]!);
      } else {
        await this.handleInvoiceRecognizeBatch(message, files);
      }
      return true;
    }

    if (message.messageType !== "file") {
      if (pending.kind === "invoice-recognize") {
        const localInvoiceFiles = await this.resolveLocalInvoiceFilesFromText(message.plainText);
        if (localInvoiceFiles.length > 0) {
          this.clearInteraction(message.conversationKey);
          if (localInvoiceFiles.length === 1) {
            await this.handleInvoiceRecognize(message, buildLocalContractFileInput(localInvoiceFiles[0]!));
          } else {
            await this.handleInvoiceRecognizeBatch(message, localInvoiceFiles.map(buildLocalContractFileInput));
          }
          return true;
        }
      }
      await this.sendNotice(message, {
        title: "当前正在等待文件",
        template: "blue",
        icon: "file-link-docx_outlined",
        message: pending.kind === "contract-extract"
          ? "请上传合同文件，我会提取字段并写入合同台账。"
          : "请继续上传发票文件；上传完成后发送 `/完成上传`，我会统一识别字段并写入发票记录。",
      });
      return true;
    }

    if (pending.kind === "contract-extract") {
      this.clearInteraction(message.conversationKey);
      await this.handleContractExtract(message, {
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
      });
      return true;
    }

    if (!this.isFileAcceptableFor("invoice-recognize", message.file.fileName)) {
      await this.sendNotice(message, {
        title: "发票文件格式暂不支持",
        template: "yellow",
        icon: "maybe_outlined",
        message: `已忽略《${message.file.fileName}》。请上传支持的发票文件格式：${this.featureConfig.ingest.invoiceAllowedExtensions.join(" / ")}。`,
      });
      return true;
    }

    const nextFiles = [
      ...(pending.files ?? []),
      {
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
      },
    ];
    pending.files = nextFiles;
    pending.expiresAt = Date.now() + this.featureConfig.ingest.pendingTtlMs;
    this.interactions.touch(pending.conversationKey, pending.expiresAt);
    return true;
  }

  private async resolveLocalInvoiceFilesFromText(text: string): Promise<string[]> {
    if (!/(发票|票据)/.test(text) || !/(识别|录入|写入|填入|填写|处理)/.test(text)) {
      return [];
    }
    const explicitPath = extractLocalPath(text);
    const candidatePath = explicitPath ?? inferDesktopInvoicePath(text);
    if (!candidatePath) {
      return [];
    }
    const targetStat = await stat(candidatePath).catch(() => null);
    if (!targetStat) {
      return [];
    }
    if (targetStat.isFile()) {
      return this.isFileAcceptableFor("invoice-recognize", candidatePath) ? [candidatePath] : [];
    }
    if (!targetStat.isDirectory()) {
      return [];
    }
    const entries = await readdir(candidatePath, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && this.isFileAcceptableFor("invoice-recognize", entry.name))
      .map((entry) => path.join(candidatePath, entry.name))
      .sort((left, right) => path.basename(left).localeCompare(path.basename(right), "zh-Hans-CN"));
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
    this.interactions.set(interaction);
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

    this.interactions.set(next);
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
    this.interactions.set(interaction);

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
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草已处理",
        level: "info",
        message: result.message,
      }), {
        event: "contract workbench processed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.message),
        len: result.message.length,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草处理失败",
        level: "error",
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
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "senderOpenId">,
    request: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const progressState = createContractDraftProgressState(request);
    const processing = await this.deps.transport.sendPayload(message.chatId, buildContractDraftProgressPayload(progressState), {
      event: "contract draft started",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(request),
      len: request.length,
    }, { replyToMessageId: message.messageId });
    try {
      const result = await this.deps.service!.draftContract(request, { requesterOpenId: message.senderOpenId }, async (stage, detail) => {
        applyContractDraftProgress(progressState, stage, detail);
        await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildContractDraftProgressPayload(progressState), {
          event: "contract draft progress updated",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(detail ?? stage),
          len: (detail ?? stage).length,
        });
      });
      completeContractDraftProgress(progressState);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildContractDraftCompletedPayload(
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
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同起草失败",
        level: "error",
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
    file: ContractAssistantFileInput,
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
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同录入完成",
        level: "info",
        message: summary,
      }), {
        event: "contract extract completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同录入失败",
        level: "error",
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
    file: ContractAssistantFileInput,
  ): Promise<void> {
    const startedAt = Date.now();
    const progressState = createInvoiceRecognizeProgressState();
    progressState.currentFile = getContractFileName(file);
    applyInvoiceRecognizeStep(progressState, 0);
    const processing = await this.deps.transport.sendPayload(message.chatId, buildInvoiceRecognizeProgressPayload(progressState), {
      event: "invoice recognize started",
      transcriptType: "outbound-final",
      textPreview: getContractFileName(file),
      len: getContractFileName(file).length,
    }, { replyToMessageId: message.messageId });
    try {
      const updateProgressCard = async (event: string, textPreview: string) => {
        await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeProgressPayload(progressState), {
          event,
          transcriptType: "outbound-final",
          textPreview,
          len: textPreview.length,
        });
      };
      const updateProgress = async (event: InvoiceRecognizeProgressEvent) => {
        const stepIndex = progressState.steps.findIndex((step) => step.label === event.label);
        if (stepIndex >= 0) {
          applyInvoiceRecognizeStep(progressState, stepIndex);
        }
        await updateProgressCard(`invoice recognize ${event.stage}`, event.label);
        this.deps.logger.log("contract-assistant/invoice", "invoice progress", {
          stage: event.stage,
          label: event.label,
          elapsedMs: Date.now() - startedAt,
        });
      };
      const result = await this.deps.service!.recognizeInvoice(file, updateProgress);
      progressState.completedFiles = [getContractFileName(file)];
      completeInvoiceRecognizeProgress(progressState);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeCompletedPayload(
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
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "发票识别失败",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      }), {
        event: "invoice recognize failed",
        transcriptType: "outbound-final",
        textPreview: error instanceof Error ? error.message : String(error),
        len: (error instanceof Error ? error.message : String(error)).length,
      });
    }
  }

  private async handleInvoiceRecognizeBatch(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    files: ContractAssistantFileInput[],
  ): Promise<void> {
    const startedAt = Date.now();
    const progressState = createInvoiceRecognizeProgressState();
    const processing = await this.deps.transport.sendPayload(message.chatId, buildInvoiceRecognizeProgressPayload(progressState), {
      event: "invoice batch recognize started",
      transcriptType: "outbound-final",
      textPreview: `批量识别 ${files.length} 份发票`,
      len: files.length,
    }, { replyToMessageId: message.messageId });
    let firstResult: InvoiceRecognizeResult | null = null;
    const completedResults: InvoiceRecognizeResult[] = [];
    for (const file of files) {
      const fileName = getContractFileName(file);
      progressState.currentFile = fileName;
      applyInvoiceRecognizeStep(progressState, 0);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeProgressPayload(progressState), {
        event: "invoice batch file started",
        transcriptType: "outbound-final",
        textPreview: fileName,
        len: fileName.length,
      });
      try {
        const updateProgress = async (event: InvoiceRecognizeProgressEvent) => {
          const stepIndex = progressState.steps.findIndex((step) => step.label === event.label);
          if (stepIndex >= 0) {
            applyInvoiceRecognizeStep(progressState, stepIndex);
          }
          await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeProgressPayload(progressState), {
            event: `invoice batch ${event.stage}`,
            transcriptType: "outbound-final",
            textPreview: `${fileName} ${event.label}`,
            len: fileName.length + event.label.length + 1,
          });
        };
        const result = await this.deps.service!.recognizeInvoice(file, updateProgress);
        firstResult ??= result;
        result.record["文件名"] = fileName;
        completedResults.push(result);
        progressState.completedFiles = [...(progressState.completedFiles ?? []), fileName];
      } catch (error) {
        progressState.failedFiles = [...(progressState.failedFiles ?? []), {
          fileName,
          reason: error instanceof Error ? error.message : String(error),
        }];
      }
    }
    if (firstResult) {
      completeInvoiceRecognizeProgress(progressState);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildInvoiceRecognizeCompletedPayload(firstResult, {
        elapsedMs: Date.now() - startedAt,
        recordUrl: buildBitableRecordUrl(this.featureConfig.storage.baseToken, this.featureConfig.storage.invoiceTableId, firstResult.recordId),
        batchResults: completedResults,
      }), {
        event: "invoice batch recognize completed",
        transcriptType: "outbound-final",
        textPreview: firstResult.summary,
        len: firstResult.summary.length,
      });
      return;
    }
    const failed = progressState.failedFiles?.map((item) => `${item.fileName}：${item.reason ?? "识别失败"}`).join("\n") || "未识别到可写入发票。";
    await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
      title: "发票识别失败",
      level: "error",
      message: failed,
    }), {
      event: "invoice batch recognize failed",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(failed),
      len: failed.length,
    });
  }

  private async handleCaseCreate(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    request: string,
  ): Promise<void> {
    const progressState = createCaseCreateProgressState(request);
    const processing = await this.deps.transport.sendPayload(message.chatId, buildCaseCreateProcessingPayload(progressState), {
      event: "case create processing",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(request),
      len: request.length,
    }, { replyToMessageId: message.messageId });
    try {
      const result = await this.deps.service!.createCase(request, async (stage, detail) => {
        applyCaseCreateProgress(progressState, stage, detail);
        await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildCaseCreateProcessingPayload(progressState), {
          event: "case create progress updated",
          transcriptType: "outbound-final",
          textPreview: detail ?? stage,
          len: (detail ?? stage).length,
        });
      });
      const recordUrl = buildBitableRecordUrl(this.featureConfig.storage.baseToken, this.featureConfig.storage.caseTableId, result.recordId);
      completeCaseCreateProgress(progressState);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildCaseCreateProcessingPayload(progressState), {
        event: "case create progress updated",
        transcriptType: "outbound-final",
        textPreview: "案件记录已写入，正在生成完成卡",
        len: 15,
      });
      const payload = buildCaseCreateCompletedPayload(result, recordUrl, request);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, payload, {
        event: "case create completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.summary),
        len: result.summary.length,
      });
    } catch (error) {
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件录入失败",
        level: "error",
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
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件更新完成",
        level: "info",
        message: summary,
      }), {
        event: "case update completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "案件更新失败",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      }), {
        event: "case update failed",
        transcriptType: "outbound-final",
        textPreview: error instanceof Error ? error.message : String(error),
        len: (error instanceof Error ? error.message : String(error)).length,
      });
    }
  }

  private async handleCaseTodos(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    query: string,
  ): Promise<void> {
    try {
      const result = await this.deps.service!.listCaseTodos(query);
      const sourceItems: Array<{ line: string; recordId?: string | undefined }> = result.items ?? result.lines.map((line) => ({ line }));
      const items = sourceItems.map((item) => ({
        line: item.line,
        ...(item.recordId
          ? { url: buildBitableRecordUrl(this.featureConfig.storage.baseToken, this.featureConfig.storage.caseTableId, item.recordId) }
          : {}),
      }));
      await this.deps.transport.sendPayload(message.chatId, buildCaseTodoReminderPayload({ items }), {
        event: "case todos sent",
        transcriptType: "outbound-final",
        textPreview: result.lines.length > 0
          ? createTextPreview(result.lines.join("\n"))
          : "当前没有待做事项。",
        len: result.lines.join("\n").length,
      }, { replyToMessageId: message.messageId });
    } catch (error) {
      await this.sendNotice(message, {
        title: "案件待办查询失败",
        template: "red",
        icon: "error_filled",
        message: error instanceof Error ? error.message : String(error),
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
      this.interactions.set(updated);
      await this.updateWorkbenchAnchor(updated);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同已载入工作会话",
        level: "info",
        message: summary,
      }), {
        event: "contract workbench init from text",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同初始化失败",
        level: "error",
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
      this.interactions.set(updated);
      await this.updateWorkbenchAnchor(updated);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同已载入工作会话",
        level: "info",
        message: summary,
      }), {
        event: "contract workbench init from file",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(summary),
        len: summary.length,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.transport.updatePayload(message.chatId, processing.messageId, buildNoticeCardPayload({
        title: "合同初始化失败",
        level: "error",
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
      this.interactions.set(updated);
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
        this.interactions.set(updated);
        await this.updateWorkbenchAnchor(updated);
        const summary = `Word 草稿已导出：${wordPath}`;
        await this.deps.transport.updatePayload(message.chatId, exportProcessing.messageId, buildNoticeCardPayload({
          title: "Word 导出完成",
          level: "info",
          message: summary,
        }), {
          event: "contract workbench export completed",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(summary),
          len: summary.length,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.deps.transport.updatePayload(message.chatId, exportProcessing.messageId, buildNoticeCardPayload({
          title: "Word 导出失败",
          level: "error",
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
      this.interactions.set(updated);
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
    await this.deps.transport.updatePayload(pending.chatId, pending.anchorMessageId, buildNoticeCardPayload({
      title: "合同起草会话",
      level: "info",
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
      files: [],
    };
    this.interactions.set(interaction);
    await this.sendNotice(message, {
      title: kind === "contract-extract" ? "等待上传合同文件" : "等待上传发票文件",
      template: "blue",
      icon: "upload_outlined",
      message: prompt,
    });
  }

  private async handleExpiredInteraction(pending: PendingInteraction): Promise<void> {
    try {
      await this.deps.transport.sendPayload(pending.chatId, buildNoticeCardPayload({
        title: "任务已超时",
        level: "neutral",
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
    this.interactions.touch(conversationKey, interaction.expiresAt);
  }

  private isFileAcceptableFor(kind: PendingUploadKind, fileName: string): boolean {
    const extension = path.extname(fileName).toLowerCase();
    const allowedExtensions = kind === "contract-extract"
      ? this.featureConfig.ingest.contractAllowedExtensions
      : this.featureConfig.ingest.invoiceAllowedExtensions;
    return allowedExtensions.includes(extension);
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

  private async sendNotice(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    options: {
      title: string;
      template: "yellow" | "grey" | "blue" | "red" | "orange" | "green" | "indigo";
      icon: string;
      message: string;
    },
  ): Promise<{ messageId: string }> {
    return await this.deps.transport.sendNotice({
      chatId: message.chatId,
      replyToMessageId: message.messageId,
    }, {
      title: options.title,
      level: resolveNoticeLevelFromTemplate(options.template),
      message: options.message,
    }, {
      event: "contract assistant notice sent",
      transcriptType: "outbound-final",
      textPreview: options.message,
      len: options.message.length,
    });
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

  // #endregion
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

function buildBitableRecordUrl(baseToken: string, tableId: string, recordId: string): string {
  const base = `https://feishu.cn/base/${encodeURIComponent(baseToken)}?table=${encodeURIComponent(tableId)}`;
  return `${base}&record=${encodeURIComponent(recordId)}`;
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

function detectPendingUploadKind(text: string): PendingUploadKind | null {
  const routed = routeIncomingText(text.trim());
  if (routed.kind === "command" && routed.command.kind === "passthrough") {
    const normalizedCommand = routed.command.name.trim().toLowerCase();
    if (CONTRACT_EXTRACT_COMMAND_ALIASES.has(normalizedCommand)) {
      return "contract-extract";
    }
    if (INVOICE_RECOGNIZE_COMMAND_ALIASES.has(normalizedCommand)) {
      return "invoice-recognize";
    }
  }
  return null;
}

function isUploadFinishCommand(command: ContractAssistantCommand): boolean {
  return command.kind === "passthrough"
    && command.name.trim().toLowerCase() === "完成上传";
}

function extractLocalPath(text: string): string | null {
  const trimmed = text.trim();
  const quoted = trimmed.match(/[`"'“”‘’]((?:~\/|\/)[^`"'“”‘’]+)[`"'“”‘’]/);
  if (quoted?.[1]) {
    return normalizeLocalPath(quoted[1]);
  }
  const absolute = trimmed.match(/(?:^|\s)((?:~\/|\/)[^\s，。；,;]+)/);
  return absolute?.[1] ? normalizeLocalPath(absolute[1]) : null;
}

function inferDesktopInvoicePath(text: string): string | null {
  const normalized = text.replace(/\s+/g, "");
  if (!/(桌面|desktop)/i.test(normalized) || !/发票/.test(normalized)) {
    return null;
  }
  const home = process.env.HOME;
  if (!home) {
    return null;
  }
  if (/发票(?:文件夹|目录)/.test(normalized)) {
    return path.join(home, "Desktop", "发票");
  }
  const folderName = normalized.match(/桌面(?:上|里|下)?([^，。；,;\s/]*发票[^，。；,;\s/]*)/)?.[1];
  const safeFolderName = folderName?.replace(/(?:文件夹|目录|里面|里|下|中|所有|全部|的)+$/g, "") || "发票";
  return path.join(home, "Desktop", safeFolderName || "发票");
}

function normalizeLocalPath(value: string): string {
  return value.replace(/^~/, process.env.HOME ?? "~").trim();
}

function buildLocalContractFileInput(localPath: string): ContractAssistantFileInput {
  return {
    localPath,
    fileName: path.basename(localPath),
  };
}

function getContractFileName(file: ContractAssistantFileInput): string {
  return file.fileName?.trim() || ("localPath" in file ? path.basename(file.localPath) : "上传文件");
}

function isInvoiceLedgerQuery(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  if (!/(发票|票据)/.test(normalized)) {
    return false;
  }
  if (/(识别|上传|录入|写入|填入|填到|入账|重新处理)/.test(normalized)) {
    return false;
  }
  return /(列出|查看|查询|展示|看看|最近|历史|情况|明细|表格|台账|发票表)/.test(normalized);
}

function renderInvoiceLedgerSystemBlock(result: InvoiceLedgerListResult): string {
  const lines = [
    "[Invoice Ledger Context]",
    "用户正在询问发票表格/台账中的发票情况。以下数据来自配置的发票 Bitable 表，请把它视为本轮回答的唯一发票台账来源。",
    "不要根据聊天记录、上传次数、图片识别结果或会话记忆推断台账记录；如果用户问“根据表格里的数据”，必须基于下列记录回答。",
    `表内总记录数：${result.total}`,
  ];
  if (result.items.length === 0) {
    lines.push("最近记录：空");
    return lines.join("\n");
  }
  lines.push(`最近记录：${result.items.length} 条`);
  for (const [index, item] of result.items.entries()) {
    lines.push(
      [
        `${index + 1}. recordId=${item.recordId}`,
        `发票号=${item.invoiceNo ?? "未填"}`,
        `发票类型=${item.invoiceType ?? "未填"}`,
        `开票日期=${item.invoiceDate ?? "未填"}`,
        `购买方=${formatInvoiceLedgerParty(item.payer)}`,
        `金额=${formatInvoiceLedgerAmount(item.amount)}`,
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

function formatInvoiceLedgerParty(value: string | undefined): string {
  if (!value?.trim()) {
    return "未填";
  }
  const normalized = value.trim();
  if (/公司|律所|事务所|中心|医院|学校|银行|集团|有限|股份|合伙|委员会|部门|单位/.test(normalized)) {
    return normalized;
  }
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(normalized)) {
    return "个人客户（已脱敏）";
  }
  return normalized;
}

function formatInvoiceLedgerAmount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "未填";
  }
  return `¥${value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function isContractReentryCommand(command: ContractAssistantCommand, pendingKind: PendingInteraction["kind"]): boolean {
  if (command.kind !== "passthrough") {
    return false;
  }
  const normalized = command.name.trim().toLowerCase();
  if (pendingKind === "contract-draft-onboard") {
    const request = command.arguments.join(" ").trim();
    return (normalized === "contract-draft" || normalized === "起草合同")
      && (request === "引导" || request.toLowerCase() === "onboard");
  }
  if (pendingKind === "contract-workbench") {
    return normalized === "合同起草开始" || normalized === "contract-workbench";
  }
  return false;
}

function buildContractActionToast(content: string, type: "success" | "warning"): Record<string, unknown> {
  return {
    toast: {
      type,
      content,
    },
  };
}
