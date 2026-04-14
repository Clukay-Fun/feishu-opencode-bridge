import crypto from "node:crypto";

import type { AppConfig } from "../config/schema.js";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import type { PendingLaborAnalysisInteraction } from "../bridge/state.js";
import type { BridgeTurn } from "../bridge/turn.js";
import {
  buildLaborAnalysisProcessingPayload,
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import { buildLaborDocumentPublishPrompt } from "./prompts.js";
import { LaborAnalysisAllMaterialsFailedError, type LaborSkillService } from "./index.js";
import type { LaborProgressStep, LaborProgressUpdate } from "./types.js";

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
  labor: LaborSkillService | null;
  sendPayload: SendPayload;
  updatePayload: UpdatePayload;
  enqueueGeneratedTurn(turn: BridgeTurn): Promise<void>;
};

type LaborCommand = Extract<
  Extract<NonNullable<RuntimeModuleMessageContext["routed"]>, { kind: "command" }>["command"],
  { kind: "labor-start" } | { kind: "labor-end" }
>;

export class LaborRuntimeModule implements RuntimeModule {
  readonly name = "labor";
  readonly priority = 25;

  private readonly interactions = new Map<string, PendingLaborAnalysisInteraction>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();

  constructor(private readonly deps: LaborRuntimeModuleDeps) {}

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    const pending = this.findInteraction(message);
    if (pending) {
      if (routed?.kind === "command" && routed.command.kind === "labor-end") {
        await this.endLaborAnalysis(message, pending);
        return { claimed: true };
      }
      const consumed = await this.consumeLaborInput(message, pending);
      if (consumed) {
        return { claimed: true };
      }
    }

    if (routed?.kind === "command" && (routed.command.kind === "labor-start" || routed.command.kind === "labor-end")) {
      await this.handleLaborCommand(message, routed.command);
      return { claimed: true };
    }

    return { claimed: false };
  }

  private async handleLaborCommand(
    message: IncomingChatMessage,
    command: LaborCommand,
  ): Promise<void> {
    if (command.kind === "labor-end") {
      await this.sendNotice(message, {
        title: "当前没有劳动分析任务",
        template: "grey",
        icon: "info_outlined",
        message: "请先发送 `/labor-start` 或 `/劳动分析` 开始收集案件材料。",
      });
      return;
    }

    const laborConfig = getLaborConfig(this.deps.config);
    if (!laborConfig.enabled || !this.deps.labor) {
      await this.sendNotice(message, {
        title: "劳动 Skill 未启用",
        template: "yellow",
        icon: "maybe_outlined",
        message: "当前未启用 laborSkill，请联系部署者补充配置。",
      });
      return;
    }

    const existing = this.interactions.get(message.conversationKey);
    if (existing) {
      await this.sendLaborMarkdown(existing, "当前已在劳动分析收集模式。请继续上传材料，或发送 `/labor-end` 开始分析。");
      return;
    }

    const ready = await this.deps.sendPayload(message.chatId, buildNoticeCardPayload({
      title: "劳动分析已开始",
      template: "blue",
      iconToken: "file-link-docx_outlined",
      message: [
        command.caseTitle ? `案件：${command.caseTitle}` : "案件：未命名劳动争议案件",
        "",
        "请连续上传 PDF / DOCX / TXT / MD 材料，或发送案件背景说明。",
        "材料收集完成后，发送 `/labor-end` 开始证据链分析。",
      ].join("\n"),
      messageIconToken: "file-link-docx_outlined",
      messageIconColor: "blue",
    }), {
      event: "labor analysis started",
      transcriptType: "outbound-final",
      textPreview: "劳动分析已开始",
      len: 7,
    }, { replyToMessageId: message.messageId, replyInThread: this.deliveryMode(message) === "group_thread" });

    this.setInteraction(message.conversationKey, {
      kind: "labor-analysis-await-input",
      chatId: message.chatId,
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      replyToMessageId: message.messageId,
      rootMessageId: message.rootId ?? message.messageId,
      anchorMessageId: ready.messageId,
      deliveryMode: this.deliveryMode(message),
      caseTitle: command.caseTitle,
      materials: [],
      notes: [],
      expiresAt: Date.now() + laborConfig.ingest.pendingTtlMs,
    });
  }

  private async consumeLaborInput(message: IncomingChatMessage, pending: PendingLaborAnalysisInteraction): Promise<boolean> {
    if (this.running.has(pending.conversationKey)) {
      await this.sendLaborMarkdown(pending, "劳动分析正在处理中，请等待当前任务完成。");
      return true;
    }
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendLaborMarkdown(pending, "当前分析任务仅允许发起人继续补充材料。");
      return true;
    }
    if (message.messageType === "file") {
      const next = {
        ...pending,
        materials: [...pending.materials, {
          sourceFile: message.file.fileName,
          messageId: message.messageId,
          fileKey: message.file.fileKey,
          size: message.file.size,
        }],
      };
      this.setInteraction(pending.conversationKey, this.refreshInteraction(next));
      await this.sendLaborMarkdown(next, `已收到《${message.file.fileName}》，当前共 ${next.materials.length} 份材料。\n继续上传材料，或发送 /labor-end 开始分析。`);
      return true;
    }

    const note = message.plainText.trim();
    if (note) {
      const next = {
        ...pending,
        notes: [...pending.notes, note],
      };
      this.setInteraction(pending.conversationKey, this.refreshInteraction(next));
      await this.sendLaborMarkdown(next, `已记录案件背景说明，当前共 ${next.notes.length} 条说明。\n说明会作为案件背景注入聚合阶段，不会作为独立证据材料。`);
    }
    return true;
  }

  private async endLaborAnalysis(message: IncomingChatMessage, pending: PendingLaborAnalysisInteraction): Promise<void> {
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendLaborMarkdown(pending, "当前分析任务仅允许发起人结束。");
      return;
    }
    if (pending.materials.length === 0) {
      this.clearInteraction(pending.conversationKey);
      await this.sendNotice(message, {
        title: "劳动分析已退出",
        template: "grey",
        icon: "info_outlined",
        message: "本次没有收到案件材料，已退出收集模式。",
      });
      return;
    }
    if (!this.deps.labor) {
      await this.sendLaborMarkdown(pending, "劳动 Skill 未启用，无法分析材料。");
      return;
    }

    this.running.add(pending.conversationKey);
    this.clearInteraction(pending.conversationKey, { keepRunning: true });
    const progressState = createLaborProgressState("劳动争议案件材料");
    const processing = await this.deps.sendPayload(message.chatId, buildLaborAnalysisProcessingPayload(progressState), {
      event: "labor analysis processing",
      transcriptType: "outbound-process",
      textPreview: "劳动分析处理中",
      len: 7,
    }, this.getDelivery(pending));

    try {
      const result = await this.deps.labor.analyze(pending.materials, {
        caseTitle: pending.caseTitle,
        notes: pending.notes,
      }, {
        onProgress: async (update) => {
          applyLaborProgress(progressState, update);
          await this.deps.updatePayload(message.chatId, processing.messageId, buildLaborAnalysisProcessingPayload(progressState), {
            event: "labor analysis progress updated",
            transcriptType: "outbound-process",
            textPreview: update.detail ?? update.step,
            len: (update.detail ?? update.step).length,
          });
        },
      });

      applyLaborProgress(progressState, { step: "document", status: "running", detail: "正在创建飞书文档" });
      await this.deps.updatePayload(message.chatId, processing.messageId, buildLaborAnalysisProcessingPayload(progressState), {
        event: "labor document publish requested",
        transcriptType: "outbound-process",
        textPreview: "正在创建飞书文档",
        len: 8,
      });

      await this.deps.enqueueGeneratedTurn({
        turnId: crypto.randomUUID(),
        chatId: message.chatId,
        conversationKey: message.conversationKey,
        threadKey: message.threadKey,
        chatType: message.chatType,
        senderOpenId: message.senderOpenId,
        inboundMessageId: message.messageId,
        plainText: `发布劳动分析文档：${result.docTitle}`,
        text: buildLaborDocumentPublishPrompt({
          docTitle: result.docTitle,
          finalMarkdown: result.markdown,
          timelineWhiteboardMermaid: result.timelineWhiteboardMermaid,
          evidenceMapWhiteboardMermaid: result.evidenceMapWhiteboardMermaid,
        }),
      });
    } catch (error) {
      applyLaborProgress(progressState, { step: "document", status: "error", detail: normalizeLaborError(error) });
      await this.deps.updatePayload(message.chatId, processing.messageId, buildLaborAnalysisProcessingPayload(progressState), {
        event: "labor analysis failed",
        transcriptType: "outbound-final",
        textPreview: normalizeLaborError(error),
        len: normalizeLaborError(error).length,
      });
      const markdown = error instanceof LaborAnalysisAllMaterialsFailedError
        ? `全部材料解析或提取失败：\n${error.failedMaterials.map((item) => `- ${item.sourceFile}：${item.reason}`).join("\n")}`
        : `劳动分析失败：${normalizeLaborError(error)}`;
      await this.deps.sendPayload(message.chatId, buildPostMarkdownPayload(markdown), {
        event: "labor analysis failure sent",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(markdown),
        len: markdown.length,
      }, this.getDelivery(pending));
    } finally {
      this.running.delete(pending.conversationKey);
    }
  }

  private findInteraction(message: IncomingChatMessage): PendingLaborAnalysisInteraction | null {
    const direct = this.interactions.get(message.conversationKey);
    if (!direct) {
      return null;
    }
    if (direct.chatType === "p2p") {
      return direct;
    }
    const rootOrParent = message.rootId ?? message.parentId ?? message.messageId;
    return rootOrParent === direct.rootMessageId || message.messageId === direct.anchorMessageId ? direct : null;
  }

  private setInteraction(conversationKey: string, interaction: PendingLaborAnalysisInteraction): void {
    this.clearInteraction(conversationKey);
    this.interactions.set(conversationKey, interaction);
    const timer = setTimeout(() => {
      void this.handleTimeout(conversationKey);
    }, Math.max(1, interaction.expiresAt - Date.now()));
    this.timers.set(conversationKey, timer);
  }

  private clearInteraction(conversationKey: string, options?: { keepRunning?: boolean }): void {
    const timer = this.timers.get(conversationKey);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(conversationKey);
    }
    if (!options?.keepRunning) {
      this.running.delete(conversationKey);
    }
    this.interactions.delete(conversationKey);
  }

  private refreshInteraction(pending: PendingLaborAnalysisInteraction): PendingLaborAnalysisInteraction {
    return {
      ...pending,
      expiresAt: Date.now() + getLaborConfig(this.deps.config).ingest.pendingTtlMs,
    };
  }

  private async handleTimeout(conversationKey: string): Promise<void> {
    const pending = this.interactions.get(conversationKey);
    if (!pending) {
      return;
    }
    this.clearInteraction(conversationKey);
    await this.sendLaborMarkdown(pending, "长时间未收到新的劳动分析材料，已结束当前收集任务。需要继续时请重新发送 `/labor-start`。");
  }

  private async sendLaborMarkdown(pending: PendingLaborAnalysisInteraction, markdown: string): Promise<void> {
    await this.deps.sendPayload(pending.chatId, buildPostMarkdownPayload(markdown), {
      event: "labor analysis notice sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(markdown),
      len: markdown.length,
    }, this.getDelivery(pending));
  }

  private async sendNotice(
    message: Pick<IncomingChatMessage, "chatId" | "messageId">,
    view: { title: string; template: "blue" | "yellow" | "red" | "green" | "grey"; icon: string; message: string },
  ): Promise<void> {
    await this.deps.sendPayload(message.chatId, buildNoticeCardPayload({
      title: view.title,
      template: view.template,
      iconToken: view.icon,
      message: view.message,
      messageIconToken: view.icon,
      messageIconColor: view.template,
    }), {
      event: "labor notice sent",
      transcriptType: "outbound-final",
      textPreview: view.message,
      len: view.message.length,
    }, { replyToMessageId: message.messageId });
  }

  private getDelivery(pending: PendingLaborAnalysisInteraction): { replyToMessageId: string; replyInThread: boolean } {
    return {
      replyToMessageId: pending.deliveryMode === "group_thread" ? pending.rootMessageId : pending.replyToMessageId,
      replyInThread: pending.deliveryMode === "group_thread",
    };
  }

  private deliveryMode(message: IncomingChatMessage): PendingLaborAnalysisInteraction["deliveryMode"] {
    return message.chatType === "p2p" ? "p2p_reply" : "group_thread";
  }
}

type LaborProgressState = {
  sourceLabel: string;
  steps: ToolUpdateView[];
};

function createLaborProgressState(sourceLabel: string): LaborProgressState {
  return {
    sourceLabel,
    steps: [
      { label: "解析中", detail: "等待开始", status: "pending" },
      { label: "提取中", detail: "等待开始", status: "pending" },
      { label: "聚合中", detail: "等待开始", status: "pending" },
      { label: "知识库补强中", detail: "等待开始", status: "pending" },
      { label: "文档生成中", detail: "等待开始", status: "pending" },
    ],
  };
}

function applyLaborProgress(state: LaborProgressState, update: LaborProgressUpdate): void {
  const step = state.steps.find((item) => item.label === mapLaborProgressLabel(update.step));
  if (!step) {
    return;
  }
  step.status = update.status;
  step.detail = update.detail ?? (update.status === "completed" ? "已完成" : update.status === "error" ? "执行失败" : "处理中");
}

function mapLaborProgressLabel(step: LaborProgressStep): ToolUpdateView["label"] {
  switch (step) {
    case "parse":
      return "解析中";
    case "extract":
      return "提取中";
    case "analyze":
      return "聚合中";
    case "knowledge":
      return "知识库补强中";
    case "document":
      return "文档生成中";
  }
}

function normalizeLaborError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getLaborConfig(config: AppConfig): NonNullable<AppConfig["laborSkill"]> {
  return config.laborSkill ?? {
    enabled: false,
    models: {},
    ingest: {
      allowedExtensions: [".pdf", ".docx", ".txt", ".md"],
      maxFileSizeMb: 20,
      pendingTtlMs: 600_000,
      concurrency: 3,
    },
  };
}
