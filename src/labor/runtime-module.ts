import { DEFAULT_LABOR_SKILL_CONFIG, type AppConfig } from "../config/schema.js";
import path from "node:path";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  type ToolUpdateView,
} from "../feishu/shared-primitives.js";
import {
  buildLaborAnalysisCompletedPayload,
  buildLaborAnalysisProgressPayload,
  type LaborAnalysisCompletedCardView,
  type LaborAnalysisProgressCardView,
} from "../feishu/labor-cards.js";
import { createTextPreview, type Logger } from "../logging/logger.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { RoutedText } from "../bridge/router.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import { PersistedInteractionManager } from "../runtime/persisted-interaction-manager.js";
import type { LaborSkillService, LaborMaterialExtraction } from "./index.js";

type LaborRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  knowledge: KnowledgeBasePort | null;
  service: LaborSkillService | null;
  transport: FeishuTransport;
};

type LaborCommand = Extract<RoutedText, { kind: "command" }>["command"];

type PendingLaborInteraction = {
  chatId: string;
  chatType: string;
  conversationKey: string;
  requesterOpenId: string;
  expiresAt: number;
  anchorMessageId: string;
  rootMessageId: string;
  deliveryMode: "group_thread" | "p2p_reply";
  title?: string | undefined;
  notes: string[];
  files: Array<{
    messageId: string;
    fileKey: string;
    fileName: string;
    size?: number | undefined;
  }>;
};

type LaborProgressState = {
  totalFiles: number;
  completedFiles: string[];
  failedFiles: string[];
  currentFile?: string | undefined;
  currentPhase: string;
  recentUpdates: string[];
  startedAt: number;
  steps: Array<{
    label: string;
    status: "pending" | "running" | "completed" | "error";
    detail?: string | undefined;
  }>;
};

export class LaborRuntimeModule implements RuntimeModule {
  readonly name = "labor";
  readonly priority = 40;

  private readonly featureConfig;
  private readonly interactions: PersistedInteractionManager<PendingLaborInteraction>;

  constructor(private readonly deps: LaborRuntimeModuleDeps) {
    this.featureConfig = deps.config.laborSkill ?? DEFAULT_LABOR_SKILL_CONFIG;
    this.interactions = new PersistedInteractionManager({
      stateFilePath: path.join(deps.config.storage.dataDir, "labor-runtime-state.json"),
      logger: deps.logger,
      logScope: "labor/state",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
      onExpire: async (interaction) => {
        await this.handleExpiredInteraction(interaction);
      },
    });
  }

  async start(): Promise<void> {
    await this.interactions.restore();
  }

  async stop(): Promise<void> {
    await this.interactions.stop();
  }

  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    const pending = this.findInteraction(message);

    if (pending) {
      if (routed?.kind === "command" && isLaborEndCommand(routed.command)) {
        await this.finishCollection(message, pending);
        return { claimed: true };
      }

      if (message.senderOpenId !== pending.requesterOpenId) {
        await this.sendNotice(message, {
          title: "当前劳动分析任务仅限发起人继续",
          template: "yellow",
          icon: "maybe_outlined",
          message: "请由当前发起人继续补充材料或说明。",
        }, this.getDelivery(pending));
        return { claimed: true };
      }

      await this.collectInput(message, pending);
      return { claimed: true };
    }

    if (routed?.kind !== "command") {
      return { claimed: false };
    }

    return { claimed: await this.handleCommand(message, routed.command) };
  }

  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    command: LaborCommand,
  ): Promise<boolean> {
    if (command.kind !== "passthrough") {
      return false;
    }
    const normalized = command.name.trim().toLowerCase();
    if (!["劳动分析", "labor-start", "劳动分析结束", "labor-end"].includes(normalized)) {
      return false;
    }

    if (normalized === "劳动分析" || normalized === "labor-start") {
      const title = command.arguments.join(" ").trim() || undefined;
      await this.startFromEntry(message, title);
      return true;
    }

    await this.sendNotice(message, {
      title: "当前没有进行中的劳动分析",
      template: "grey",
      icon: "info_outlined",
      message: "请先发送 `/劳动分析` 开始收集材料。",
    });
    return true;
  }

  private async startFromEntry(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    title?: string,
  ): Promise<void> {
    if (!this.featureConfig.enabled || !this.deps.service) {
      await this.sendNotice(message, {
        title: "劳动 skill 未启用",
        template: "yellow",
        icon: "maybe_outlined",
        message: "当前未启用 laborSkill，请先补充 `laborSkill` 配置。",
      });
      return;
    }

    await this.startCollection(message, title);
  }

  private async startCollection(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    title?: string,
  ): Promise<void> {
    this.clearRequesterInteractions(message.chatId, message.senderOpenId);
    const deliveryMode = message.chatType === "p2p" ? "p2p_reply" : "group_thread";
    const ready = await this.sendNotice(message, {
      title: "已进入劳动分析收集模式",
      template: "blue",
      icon: "upload_outlined",
      message: [
        `案件标题：${title ?? "未指定"}`,
        "",
        "现在可以连续上传一份或多份劳动相关材料，也可以持续发送补充背景说明。",
        "收集阶段不会逐条弹出确认消息。",
        "完成后发送 `/劳动分析结束`，再统一开始分析。",
      ].join("\n"),
    }, { replyToMessageId: message.messageId, replyInThread: deliveryMode === "group_thread" });

    this.interactions.set({
      chatId: message.chatId,
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      expiresAt: Date.now() + this.featureConfig.ingest.pendingTtlMs,
      anchorMessageId: ready.messageId,
      rootMessageId: message.messageId,
      deliveryMode,
      title,
      notes: [],
      files: [],
    });
  }

  private async collectInput(message: IncomingChatMessage, pending: PendingLaborInteraction): Promise<void> {
    pending.expiresAt = Date.now() + this.featureConfig.ingest.pendingTtlMs;
    this.interactions.touch(pending.conversationKey, pending.expiresAt);

    if (message.messageType === "file") {
      pending.files.push({
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
      });
      this.interactions.touch(pending.conversationKey, pending.expiresAt);
      return;
    }

    if (message.plainText.trim()) {
      pending.notes.push(message.plainText.trim());
      this.interactions.touch(pending.conversationKey, pending.expiresAt);
    }
  }

  private async finishCollection(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey" | "senderOpenId">,
    pending: PendingLaborInteraction,
  ): Promise<void> {
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendNotice(message, {
        title: "只有发起人可以结束当前分析",
        template: "yellow",
        icon: "maybe_outlined",
        message: "请由当前发起人发送 `/劳动分析结束`。",
      }, this.getDelivery(pending));
      return;
    }

    if (pending.files.length === 0 && pending.notes.length === 0) {
      this.clearInteraction(message.conversationKey);
      await this.sendNotice(message, {
        title: "当前没有可分析内容",
        template: "grey",
        icon: "info_outlined",
        message: "还没有收到材料或背景说明，已退出劳动分析模式。",
      });
      return;
    }

    this.clearInteraction(message.conversationKey);
    const progressState: LaborProgressState = {
      totalFiles: pending.files.length,
      completedFiles: [],
      failedFiles: [],
      currentPhase: "正在准备证据链分析",
      recentUpdates: ["已开始处理劳动争议材料"],
      startedAt: Date.now(),
      steps: createLaborAnalysisSteps(),
    };

    const processing = await this.deps.transport.sendPayload(message.chatId, buildLaborAnalysisProgressPayload(toLaborProgressCardView(progressState)), {
      event: "labor analysis started",
      transcriptType: "outbound-final",
      textPreview: "劳动分析处理中",
      len: 7,
    }, { replyToMessageId: message.messageId });

    const extractedMaterials: LaborMaterialExtraction[] = [];
    const warnings: string[] = [];

    for (const file of pending.files) {
      progressState.currentFile = file.fileName;
      progressState.currentPhase = "正在解析证据材料";
      setLaborStep(progressState, "读取内容", "running", "正在解析证据材料");
      setLaborStep(progressState, "提取关键信息", "pending");
      pushProgress(progressState, `开始处理《${file.fileName}》`);
      await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);

      try {
        const extracted = await this.deps.service!.extractMaterial(file, {
          onProgress: async (step) => {
            setLaborStep(progressState, "读取内容", "completed", "已完成");
            setLaborStep(progressState, "提取关键信息", "running", shortenProgress(step, file.fileName));
            pushProgress(progressState, shortenProgress(step, file.fileName));
            await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
          },
        });
        extractedMaterials.push(extracted.extraction);
        progressState.completedFiles.push(file.fileName);
        setLaborStep(progressState, "读取内容", "completed", "已完成");
        setLaborStep(progressState, "提取关键信息", "completed", extracted.cached ? "命中缓存" : "已完成");
        pushProgress(progressState, extracted.cached
          ? `《${file.fileName}》已完成，命中缓存`
          : `《${file.fileName}》已完成`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        progressState.failedFiles.push(file.fileName);
        warnings.push(`已跳过《${file.fileName}》：${detail}`);
        setLaborStep(progressState, "提取关键信息", "error", detail);
        pushProgress(progressState, `《${file.fileName}》处理失败：${detail}`);
      }
      await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
    }

    if (extractedMaterials.length === 0) {
      await this.safeUpdateNotice(pending.chatId, processing.messageId, {
        title: "劳动分析失败",
        template: "red",
        icon: "error_filled",
        message: warnings.length > 0 ? warnings.join("\n") : "当前没有可用于劳动分析的材料。",
      }, "labor analysis failed");
      return;
    }

    progressState.currentFile = undefined;
    progressState.currentPhase = "正在汇总证据链并生成文档";
    setLaborStep(progressState, "检索法律依据", "running", "正在检索知识库与法条线索");
    setLaborStep(progressState, "生成分析文档", "pending");
    pushProgress(progressState, "开始案件级汇总");
    await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);

    try {
      const result = await this.deps.service!.finalizeAnalysis({
        extractedMaterials,
        notes: pending.notes,
        materialCount: pending.files.length,
        warnings,
        preferredTitle: pending.title,
      }, {
        onProgress: async (step) => {
          applyLaborFinalizeProgress(progressState, step);
          pushProgress(progressState, shortenProgress(step));
          await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
        },
      });

      await this.updateCompletedCard(pending.chatId, processing.messageId, progressState, buildLaborCompletedView(result, progressState.totalFiles));

      if (!result.docUrl) {
        const markdown = [
          `### ${result.title}`,
          "",
          "工作台文档创建失败，下面返回 Markdown 版本供直接查看。",
          "",
          result.markdown,
        ].join("\n");

        await this.deps.transport.sendPayload(pending.chatId, buildPostMarkdownPayload(markdown), {
          event: "labor analysis result sent",
          transcriptType: "outbound-final",
          textPreview: createTextPreview(markdown),
          len: markdown.length,
        }, { replyToMessageId: message.messageId });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.safeUpdateNotice(pending.chatId, processing.messageId, {
        title: "劳动分析失败",
        template: "red",
        icon: "error_filled",
        message: detail,
      }, "labor analysis failed");
    }
  }

  private clearInteraction(conversationKey: string): void {
    this.interactions.delete(conversationKey);
  }

  private clearRequesterInteractions(chatId: string, requesterOpenId: string): void {
    for (const [conversationKey, pending] of this.interactions.entries()) {
      if (pending.chatId === chatId && pending.requesterOpenId === requesterOpenId) {
        this.clearInteraction(conversationKey);
      }
    }
  }

  private findInteraction(message: IncomingChatMessage): PendingLaborInteraction | null {
    const direct = this.interactions.get(message.conversationKey);
    if (direct && this.isMessageInLaborChain(message, direct)) {
      return direct;
    }

    const sameChatRequesterMatches = [...this.interactions.values()]
      .filter((pending) => pending.chatId === message.chatId && pending.requesterOpenId === message.senderOpenId);
    if (sameChatRequesterMatches.length === 1) {
      return sameChatRequesterMatches[0] ?? null;
    }

    return null;
  }

  private isMessageInLaborChain(message: IncomingChatMessage, pending: PendingLaborInteraction): boolean {
    if (message.chatId !== pending.chatId) {
      return false;
    }
    if (pending.chatType === "p2p") {
      return message.rootId === pending.anchorMessageId
        || message.parentId === pending.anchorMessageId
        || message.rootId === pending.rootMessageId
        || message.parentId === pending.rootMessageId;
    }
    const candidates = new Set([
      message.rootId,
      message.parentId,
      message.threadKey,
    ].filter((value): value is string => Boolean(value)));
    return message.conversationKey === pending.conversationKey
      || candidates.has(pending.anchorMessageId)
      || candidates.has(pending.rootMessageId);
  }

  private getDelivery(pending: PendingLaborInteraction): { replyToMessageId: string; replyInThread?: boolean } {
    return {
      replyToMessageId: pending.anchorMessageId,
      replyInThread: pending.deliveryMode === "group_thread",
    };
  }

  private async updateProcessingCard(chatId: string, messageId: string, state: LaborProgressState): Promise<void> {
    try {
      await this.deps.transport.updatePayload(chatId, messageId, buildLaborAnalysisProgressPayload(toLaborProgressCardView(state)), {
        event: "labor progress updated",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(renderProcessingMessage(state)),
        len: renderProcessingMessage(state).length,
      });
    } catch (error) {
      this.deps.logger.log("feishu/reply", "labor progress update failed", {
        chatId,
        messageId,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private async updateCompletedCard(
    chatId: string,
    messageId: string,
    progressState: LaborProgressState,
    view: LaborAnalysisCompletedCardView,
  ): Promise<void> {
    try {
      await this.deps.transport.updatePayload(chatId, messageId, buildLaborAnalysisCompletedPayload(view), {
        event: "labor analysis completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(`${view.title}｜材料 ${view.materialCount}｜证据 ${view.evidenceCount}｜焦点 ${view.issueCount}`),
        len: view.title.length,
      });
    } catch (error) {
      const fallbackMessage = [
        `案件标题：${view.title}`,
        view.docUrl ? `[打开飞书文档](${view.docUrl})` : "飞书文档创建失败，已保留 Markdown 结果。",
        `耗时：${formatLaborElapsed(Date.now() - progressState.startedAt)}`,
      ].join("\n\n");
      await this.safeUpdateNotice(chatId, messageId, {
        title: "证据链分析已完成",
        template: "green",
        icon: "yes_outlined",
        message: fallbackMessage,
      }, "labor analysis completed");
      this.deps.logger.log("feishu/reply", "labor completed card update failed", {
        chatId,
        messageId,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private async safeUpdateNotice(
    chatId: string,
    messageId: string,
    options: {
      title: string;
      template: "yellow" | "grey" | "blue" | "red" | "orange" | "green" | "indigo" | "wathet";
      icon: string;
      message: string;
    },
    event: string,
  ): Promise<void> {
    try {
      await this.deps.transport.updatePayload(chatId, messageId, buildNoticeCardPayload({
        title: options.title,
        template: options.template,
        iconToken: options.icon,
        message: options.message,
        showMessageIcon: false,
      }), {
        event,
        transcriptType: "outbound-final",
        textPreview: createTextPreview(options.message),
        len: options.message.length,
      });
    } catch (error) {
      this.deps.logger.log("feishu/reply", "labor notice update failed", {
        chatId,
        messageId,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private async sendNotice(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    options: {
      title: string;
      template: "yellow" | "grey" | "blue" | "red" | "orange" | "green" | "indigo" | "wathet";
      icon: string;
      message: string;
    },
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
  ): Promise<{ messageId: string }> {
    return await this.deps.transport.sendNotice({
      chatId: message.chatId,
      replyToMessageId: delivery?.replyToMessageId ?? message.messageId,
    }, {
      title: options.title,
      template: options.template,
      iconToken: options.icon,
      message: options.message,
      showMessageIcon: false,
    }, {
      event: "labor notice sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(options.message),
      len: options.message.length,
    }, delivery?.replyInThread !== undefined ? { replyInThread: delivery.replyInThread } : undefined);
  }

  private async handleExpiredInteraction(pending: PendingLaborInteraction): Promise<void> {
    await this.deps.transport.sendNotice({
      chatId: pending.chatId,
      replyToMessageId: pending.anchorMessageId,
    }, {
      title: "劳动分析已超时",
      template: "grey",
      iconToken: "time_outlined",
      message: "长时间未继续补充材料，当前劳动分析模式已自动结束。",
      showMessageIcon: false,
    }, {
      event: "labor interaction expired",
      transcriptType: "outbound-final",
      textPreview: "劳动分析已超时",
      len: 8,
    }, {
      replyInThread: pending.deliveryMode === "group_thread",
    });
  }
}

function isLaborEndCommand(command: LaborCommand): boolean {
  return command.kind === "passthrough"
    && ["劳动分析结束", "labor-end"].includes(command.name.trim().toLowerCase());
}

function renderProcessingMessage(state: LaborProgressState): string {
  const lines = [
    `**总进度**\n${state.completedFiles.length + state.failedFiles.length}/${state.totalFiles}`,
    `**当前阶段**\n${state.currentPhase}`,
  ];
  if (state.currentFile) {
    lines.push(`**当前材料**\n${state.currentFile}`);
  }
  lines.push(`**已完成**\n${state.completedFiles.length > 0 ? state.completedFiles.join("、") : "暂无"}`);
  if (state.failedFiles.length > 0) {
    lines.push(`**失败**\n${state.failedFiles.join("、")}`);
  }
  lines.push("**处理进展**\n" + state.recentUpdates.map((item) => `- ${item}`).join("\n"));
  return lines.join("\n\n");
}

function createLaborAnalysisSteps(): LaborProgressState["steps"] {
  return [
    { label: "读取内容", status: "pending" },
    { label: "提取关键信息", status: "pending" },
    { label: "检索法律依据", status: "pending" },
    { label: "生成分析文档", status: "pending" },
  ];
}

function setLaborStep(
  state: LaborProgressState,
  label: string,
  status: LaborProgressState["steps"][number]["status"],
  detail?: string,
): void {
  const step = state.steps.find((item) => item.label === label);
  if (!step) {
    return;
  }
  step.status = status;
  step.detail = detail;
}

function applyLaborFinalizeProgress(state: LaborProgressState, step: string): void {
  const normalized = step.trim();
  if (/知识|法律|法条|检索/.test(normalized)) {
    setLaborStep(state, "检索法律依据", "running", shortenProgress(normalized));
    return;
  }
  setLaborStep(state, "检索法律依据", "completed", "已完成");
  setLaborStep(state, "生成分析文档", "running", shortenProgress(normalized));
}

function formatLaborElapsed(elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain > 0 ? `${minutes} 分 ${remain} 秒` : `${minutes} 分`;
}

function pushProgress(state: LaborProgressState, line: string): void {
  const normalized = line.trim();
  if (!normalized) {
    return;
  }
  if (state.recentUpdates[state.recentUpdates.length - 1] === normalized) {
    return;
  }
  state.recentUpdates.push(normalized);
  state.recentUpdates = state.recentUpdates.slice(-5);
}

function shortenProgress(step: string, fileName?: string): string {
  return step
    .replace(/^正在/, "")
    .replace(/^已/, "已")
    .replace(fileName ?? "", "")
    .replace(/[《》]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toLaborProgressCardView(state: LaborProgressState): LaborAnalysisProgressCardView {
  return {
    sourceLabel: state.currentFile ?? "劳动争议材料",
    steps: state.steps.map((step) => ({
      label: step.label,
      detail: step.detail ?? "等待开始",
      status: step.status,
    }) satisfies ToolUpdateView),
    progressText: state.recentUpdates.length > 0
      ? `当前进度：${state.recentUpdates.at(-1) ?? ""}`
      : undefined,
    startedAt: state.startedAt,
  };
}

function buildLaborCompletedView(result: {
  title: string;
  docUrl?: string | undefined;
  extractedMaterials: LaborMaterialExtraction[];
  aggregate: { evidenceRows: Array<unknown>; issues: Array<unknown> };
}, totalFiles: number): LaborAnalysisCompletedCardView {
  const tagCounts: Record<string, number> = {};
  for (const material of result.extractedMaterials) {
    const key = material.materialType?.trim() || "其他";
    tagCounts[key] = (tagCounts[key] ?? 0) + 1;
  }
  return {
    title: result.title,
    materialCount: totalFiles,
    evidenceCount: result.aggregate.evidenceRows.length,
    issueCount: result.aggregate.issues.length,
    tagCounts,
    docUrl: result.docUrl,
  };
}
