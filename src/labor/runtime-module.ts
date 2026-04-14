import { DEFAULT_LABOR_SKILL_CONFIG, type AppConfig } from "../config/schema.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  type FeishuPostPayload,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { RoutedText } from "../bridge/router.js";
import type { LaborSkillService, LaborMaterialExtraction } from "./index.js";

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

type LaborRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  knowledge: KnowledgeBasePort | null;
  service: LaborSkillService | null;
  sendPayload: SendPayload;
  updatePayload: UpdatePayload;
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
};

export class LaborRuntimeModule implements RuntimeModule {
  readonly name = "labor";
  readonly priority = 40;

  private readonly featureConfig;
  private readonly interactions = new Map<string, PendingLaborInteraction>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly stateFilePath: string;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LaborRuntimeModuleDeps) {
    this.featureConfig = deps.config.laborSkill ?? DEFAULT_LABOR_SKILL_CONFIG;
    this.stateFilePath = path.join(deps.config.storage.dataDir, "labor-runtime-state.json");
  }

  async start(): Promise<void> {
    await this.restoreState();
  }

  async stop(): Promise<void> {
    await this.flushPersist();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.interactions.clear();
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

    if (!this.featureConfig.enabled || !this.deps.service) {
      await this.sendNotice(message, {
        title: "劳动 skill 未启用",
        template: "yellow",
        icon: "maybe_outlined",
        message: "当前未启用 laborSkill，请先补充 `laborSkill` 配置。",
      });
      return true;
    }

    if (normalized === "劳动分析" || normalized === "labor-start") {
      const title = command.arguments.join(" ").trim() || undefined;
      await this.startCollection(message, title);
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
        "现在可以连续上传劳动相关材料，也可以发送补充背景说明。",
        "完成后发送 `/劳动分析结束`。",
      ].join("\n"),
    }, { replyToMessageId: message.messageId, replyInThread: deliveryMode === "group_thread" });

    this.interactions.set(message.conversationKey, {
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
    this.schedulePersist();

    const timer = setTimeout(() => {
      void this.expireInteraction(message.conversationKey);
    }, this.featureConfig.ingest.pendingTtlMs);
    this.timers.set(message.conversationKey, timer);
  }

  private async collectInput(message: IncomingChatMessage, pending: PendingLaborInteraction): Promise<void> {
    if (message.messageType === "file") {
      pending.files.push({
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
      });
      this.schedulePersist();
      await this.sendNotice(message, {
        title: "已收到材料",
        template: "blue",
        icon: "file-link-docx_outlined",
        message: `已收到《${message.file.fileName}》，当前共 ${pending.files.length} 份材料。`,
      });
      return;
    }

    if (message.plainText.trim()) {
      pending.notes.push(message.plainText.trim());
      this.schedulePersist();
      await this.sendNotice(message, {
        title: "已记录补充说明",
        template: "blue",
        icon: "edit_outlined",
        message: `已记录第 ${pending.notes.length} 条背景说明。`,
      });
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
    };

    const processing = await this.sendNotice(message, {
      title: "劳动分析处理中",
      template: "blue",
      icon: "loading_outlined",
      message: renderProcessingMessage(progressState),
    });

    const extractedMaterials: LaborMaterialExtraction[] = [];
    const warnings: string[] = [];

    for (const file of pending.files) {
      progressState.currentFile = file.fileName;
      progressState.currentPhase = "正在解析证据材料";
      pushProgress(progressState, `开始处理《${file.fileName}》`);
      await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);

      try {
        const extracted = await this.deps.service!.extractMaterial(file, {
          onProgress: async (step) => {
            pushProgress(progressState, shortenProgress(step, file.fileName));
            await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
          },
        });
        extractedMaterials.push(extracted.extraction);
        progressState.completedFiles.push(file.fileName);
        pushProgress(progressState, extracted.cached
          ? `《${file.fileName}》已完成，命中缓存`
          : `《${file.fileName}》已完成`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        progressState.failedFiles.push(file.fileName);
        warnings.push(`已跳过《${file.fileName}》：${detail}`);
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
          pushProgress(progressState, shortenProgress(step));
          await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
        },
      });

      await this.safeUpdateNotice(pending.chatId, processing.messageId, {
        title: "证据链分析已完成",
        template: "green",
        icon: "yes_outlined",
        message: [
          `案件标题：${result.title}`,
          result.docUrl ? `[打开飞书文档](${result.docUrl})` : "飞书文档创建失败，已保留 Markdown 结果。",
        ].join("\n\n"),
      }, "labor analysis completed");

      if (!result.docUrl) {
        const markdown = [
          `### ${result.title}`,
          "",
          "工作台文档创建失败，下面返回 Markdown 版本供直接查看。",
          "",
          result.markdown,
        ].join("\n");

        await this.deps.sendPayload(pending.chatId, buildPostMarkdownPayload(markdown), {
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

  private async expireInteraction(conversationKey: string): Promise<void> {
    const pending = this.interactions.get(conversationKey);
    if (!pending) {
      return;
    }
    this.clearInteraction(conversationKey);
    await this.deps.sendPayload(pending.chatId, buildNoticeCardPayload({
      title: "劳动分析已超时",
      template: "grey",
      iconToken: "time_outlined",
      message: "长时间未继续补充材料，当前劳动分析模式已自动结束。",
      showMessageIcon: false,
    }), {
      event: "labor interaction expired",
      transcriptType: "outbound-final",
      textPreview: "劳动分析已超时",
      len: 8,
    }, this.getDelivery(pending));
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
    await this.safeUpdateNotice(chatId, messageId, {
      title: "劳动分析处理中",
      template: "blue",
      icon: "loading_outlined",
      message: renderProcessingMessage(state),
    }, "labor progress updated");
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
      await this.deps.updatePayload(chatId, messageId, buildNoticeCardPayload({
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
    return await this.deps.sendPayload(message.chatId, buildNoticeCardPayload({
      title: options.title,
      template: options.template,
      iconToken: options.icon,
      message: options.message,
      showMessageIcon: false,
    }), {
      event: "labor notice sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(options.message),
      len: options.message.length,
    }, delivery ?? { replyToMessageId: message.messageId });
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

  private async readPersistedInteractions(): Promise<PendingLaborInteraction[]> {
    try {
      const raw = await readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: number; interactions?: PendingLaborInteraction[] };
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
        this.deps.logger.log("labor/state", "persist state failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
  }

  private async flushPersist(): Promise<void> {
    await this.persistChain;
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
