/**
 * 职责: 将劳动争议分析能力接入运行时模块体系。
 * 关注点:
 * - 拦截劳动分析相关命令并组织执行流程。
 * - 管理材料上传态交互以及进度卡、结果卡更新。
 * - 管理案件断点记忆，支持跨会话恢复。
 */
import { DEFAULT_LABOR_SKILL_CONFIG, type AppConfig } from "../config/schema.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  resolveNoticeLevelFromTemplate,
  type ToolUpdateView,
} from "../feishu/shared-primitives.js";
import {
  buildLaborAnalysisCompletedPayload,
  buildLaborFinalReviewPayload,
  buildLaborAnalysisProgressPayload,
  buildLaborMaterialCollectionPayload,
  buildLaborReviewCompletedPayload,
  type LaborAnalysisCompletedCardView,
  type LaborAnalysisProgressCardView,
} from "../feishu/labor-cards.js";
import { createTextPreview, type Logger } from "../logging/logger.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { RoutedText } from "../bridge/router.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import { PersistedInteractionManager } from "../runtime/persisted-interaction-manager.js";
import type { CaseWorkbenchContextStore } from "../case-workbench/context-store.js";
import type {
  LaborAnalyzeResult,
  LaborSkillService,
  LaborMaterialExtraction,
  LaborMaterialInput,
  LaborReviewAuthorityContext,
  LaborFinalReviewReport,
} from "./index.js";
import { extractPartyInfoFromMaterials, formatLaborReviewFindingText } from "./index.js";
import { LaborCaseCheckpointStore } from "./checkpoint.js";

type LaborRuntimeModuleDeps = {
  config: AppConfig;
  logger: Logger;
  knowledge: KnowledgeBasePort | null;
  service: LaborSkillService | null;
  transport: FeishuTransport;
  caseContextStore?: CaseWorkbenchContextStore | undefined;
};

type LaborCommand = Extract<RoutedText, { kind: "command" }>["command"];

type PendingLaborInteraction = {
  stage?: "collecting" | undefined;
  caseId: string;
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
  files: LaborMaterialInput[];
};

type LaborProgressState = {
  totalFiles: number;
  fileNames: string[];
  completedFiles: Array<{ fileName: string; elapsedMs: number; cached: boolean }>;
  failedFiles: Array<{ fileName: string; elapsedMs: number; detail: string }>;
  currentFile?: string | undefined;
  currentFileStartedAt?: number | undefined;
  currentPhase: string;
  recentUpdates: string[];
  startedAt: number;
  previewDocUrl?: string | undefined;
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
  private readonly checkpoints: LaborCaseCheckpointStore;
  private readonly finishingCollections = new Set<string>();

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
    this.checkpoints = new LaborCaseCheckpointStore(deps.config.storage.dataDir, deps.logger);
  }

  // #region 生命周期与入口

  /** 恢复持久化的劳动分析交互状态和案件断点。 */
  async start(): Promise<void> {
    await this.interactions.restore();
    await this.checkpoints.restore();
  }

  /** 停止交互状态管理器并刷新断点。 */
  async stop(): Promise<void> {
    await this.interactions.stop();
    await this.checkpoints.stop();
  }

  /** 处理劳动分析命令、收集态输入和结束指令。 */
  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    const pending = this.findInteraction(message);

    if (pending) {
      if (routed?.kind === "command" && isLaborFinishCommand(routed.command)) {
        await this.startFinishCollection(message, pending);
        return { claimed: true };
      }

      if (message.senderOpenId !== pending.requesterOpenId) {
        await this.sendNotice(message, {
          title: "当前材料收集任务仅限发起人继续",
          template: "yellow",
          icon: "maybe_outlined",
          message: "请由当前发起人继续补充材料或说明。",
        }, this.getDelivery(pending));
        return { claimed: true };
      }

      if (routed?.kind === "command" && isCaseWorkbenchStartCommand(routed.command)) {
        await this.sendNotice(message, {
          title: "已有材料收集正在进行",
          template: "yellow",
          icon: "maybe_outlined",
          message: "请继续上传材料，或发送 `/完成上传` 开始分析。",
        }, this.getDelivery(pending));
        return { claimed: true };
      }

      if (!shouldCollectLaborInput(message)) {
        return { claimed: false };
      }

      await this.collectInput(message, pending);
      return { claimed: true };
    }

    if (routed?.kind !== "command") {
      return { claimed: false };
    }

    return { claimed: await this.handleCommand(message, routed.command) };
  }

  /** 处理劳动模块自有命令。 */
  private async handleCommand(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    command: LaborCommand,
  ): Promise<boolean> {
    if (command.kind !== "passthrough") {
      return false;
    }

    if (!isLaborFinishCommand(command)) {
      return false;
    }

    await this.sendNotice(message, {
      title: "当前没有进行中的材料收集",
      template: "grey",
      icon: "info_outlined",
      message: "请先发送 `/案件工作台` 打开案件工作台，再上传材料。",
    });
    return true;
  }

  /** 供案件工作台入口启动劳动材料收集，收集状态仍由 labor 模块维护。 */
  async startCaseWorkbenchCollection(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    title?: string,
    options?: { anchorMessageId?: string; suppressInitialCard?: boolean },
  ): Promise<void> {
    if (!this.featureConfig.enabled || !this.deps.service) {
      await this.sendNotice(message, {
        title: "当前分析领域未启用",
        template: "yellow",
        icon: "maybe_outlined",
        message: "当前未启用所选分析领域，请先补充对应配置。",
      });
      return;
    }

    const unfinished = this.checkpoints.findRecentUnfinished(message.senderOpenId);
    if (unfinished && !this.interactions.get(unfinished.conversationKey)) {
      // 旧断点没有活跃交互时不能继续接收文件；直接关闭残留，避免挡住新工作台入口。
      this.checkpoints.updateStage(unfinished.caseId, "expired", "旧断点已关闭");
    }

    const collectionOptions: { anchorMessageId?: string; suppressInitialCard?: boolean } | undefined =
      options?.anchorMessageId || options?.suppressInitialCard ? {} : undefined;
    if (collectionOptions && options?.anchorMessageId) {
      collectionOptions.anchorMessageId = options.anchorMessageId;
    }
    if (collectionOptions && options?.suppressInitialCard !== undefined) {
      collectionOptions.suppressInitialCard = options.suppressInitialCard;
    }
    await this.startCollection(message, title, collectionOptions);
  }

  /** 创建新的劳动分析收集态交互。 */
  private async startCollection(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    title?: string,
    options?: { anchorMessageId?: string; suppressInitialCard?: boolean },
  ): Promise<PendingLaborInteraction> {
    this.clearRequesterInteractions(message.chatId, message.senderOpenId);
    const caseId = this.checkpoints.generateCaseId();
    const deliveryMode = message.chatType === "p2p" ? "p2p_reply" : "group_thread";
    const payload = buildLaborMaterialCollectionPayload({
      title,
      conversationKey: message.conversationKey,
    });
    const metadata = {
      event: "labor collection started",
      transcriptType: "outbound-final",
      textPreview: "材料收集中",
      len: 5,
    } as const;
    const ready = options?.suppressInitialCard
      ? { messageId: options.anchorMessageId ?? message.messageId }
      : await this.deps.transport.sendPayload(message.chatId, payload, metadata, { replyToMessageId: message.messageId, replyInThread: deliveryMode === "group_thread" });
    const anchorMessageId = ready.messageId || options?.anchorMessageId || message.messageId;

    const interaction: PendingLaborInteraction = {
      caseId,
      chatId: message.chatId,
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      expiresAt: Date.now() + this.featureConfig.ingest.pendingTtlMs,
      anchorMessageId,
      rootMessageId: message.messageId,
      deliveryMode,
      stage: "collecting",
      title,
      notes: [],
      files: [],
    };
    this.interactions.set(interaction);

    // 创建案件断点
    this.checkpoints.set({
      caseId,
      userId: message.senderOpenId,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
      stage: "collecting",
      lastStep: "开始收集材料",
      pendingMaterials: [],
      openIssues: [],
      anchorMessageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.deps.logger.log("labor/checkpoint", "case checkpoint created", { caseId });

    return interaction;
  }

  /** 在收集态中接收文件和补充说明。 */
  private async collectInput(message: IncomingChatMessage, pending: PendingLaborInteraction): Promise<void> {
    pending.expiresAt = Date.now() + this.featureConfig.ingest.pendingTtlMs;
    this.interactions.touch(pending.conversationKey, pending.expiresAt);

    if (message.messageType === "file") {
      pending.files.push({
        messageId: message.messageId,
        fileKey: message.file.fileKey,
        fileName: message.file.fileName,
        size: message.file.size,
        resourceType: message.resourceType,
      });
      this.checkpoints.updateCollection(pending.caseId, {
        pendingMaterials: pending.files.map((file) => ({
          fileName: getLaborMaterialInputName(file),
          messageId: "messageId" in file ? file.messageId : message.messageId,
        })),
        lastStep: `已收集 ${pending.files.length} 份材料`,
      });
      this.interactions.touch(pending.conversationKey, pending.expiresAt);
      return;
    }

    if (message.plainText.trim()) {
      const text = message.plainText.trim();
      const folderResult = await this.resolveLocalFolderFiles(text);
      if (folderResult) {
        const addedCount = folderResult.files.length;
        const skippedNames = folderResult.skipped.map((s) => s.fileName);
        for (const filePath of folderResult.files) {
          pending.files.push({
            localPath: filePath,
            fileName: path.basename(filePath),
          });
        }
        this.checkpoints.updateCollection(pending.caseId, {
          pendingMaterials: pending.files.map((file) => ({
            fileName: getLaborMaterialInputName(file),
            messageId: "messageId" in file ? file.messageId : message.messageId,
          })),
          lastStep: `已收集 ${pending.files.length} 份材料`,
        });
        this.interactions.touch(pending.conversationKey, pending.expiresAt);
        const summary = [`本批新增 ${addedCount} 个文件，累计 ${pending.files.length} 个`];
        if (skippedNames.length > 0) {
          summary.push(`已跳过：${skippedNames.join("、")}`);
        }
        summary.push(`定位路径：${folderResult.resolvedPath}`);
        await this.sendNotice(message, {
          title: "文件夹收集完成",
          template: "green",
          icon: "check_circle_outlined",
          message: summary.join("\n"),
        }, this.getDelivery(pending));
        return;
      }

      pending.notes.push(text);
      this.checkpoints.updateCollection(pending.caseId, {
        openIssues: pending.notes.slice(-5),
        lastStep: `已补充 ${pending.notes.length} 条背景说明`,
      });
      this.interactions.touch(pending.conversationKey, pending.expiresAt);
    }
  }

  /** 结束收集阶段，并正式启动劳动分析。 */
  private async startFinishCollection(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey" | "senderOpenId">,
    pending: PendingLaborInteraction,
  ): Promise<void> {
    if (this.finishingCollections.has(pending.conversationKey)) {
      return;
    }
    this.finishingCollections.add(pending.conversationKey);
    let markVisible: () => void = () => {};
    const visible = new Promise<void>((resolve) => {
      markVisible = resolve;
    });
    void this.finishCollection(message, pending, { onFirstVisibleCard: markVisible })
      .catch((error) => {
        markVisible();
        this.deps.logger.log("labor/runtime", "finish collection failed", {
          conversationKey: pending.conversationKey,
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      })
      .finally(() => {
        this.finishingCollections.delete(pending.conversationKey);
      });
    await visible;
  }

  private async finishCollection(
    message: Pick<IncomingChatMessage, "chatId" | "messageId" | "conversationKey" | "senderOpenId">,
    pending: PendingLaborInteraction,
    options?: { onFirstVisibleCard?: (() => void) | undefined },
  ): Promise<void> {
    if (message.senderOpenId !== pending.requesterOpenId) {
      await this.sendNotice(message, {
        title: "只有发起人可以结束当前分析",
        template: "yellow",
        icon: "maybe_outlined",
        message: "请由当前发起人发送 `/完成上传`。",
      }, this.getDelivery(pending));
      options?.onFirstVisibleCard?.();
      return;
    }

    if (pending.files.length === 0 && pending.notes.length === 0) {
      this.clearInteraction(message.conversationKey);
      this.checkpoints.updateStage(pending.caseId, "expired", "空材料退出");
      await this.sendNotice(message, {
        title: "当前没有可分析内容",
        template: "grey",
        icon: "info_outlined",
        message: "还没有收到材料或背景说明，已退出劳动分析模式。",
      });
      options?.onFirstVisibleCard?.();
      return;
    }

    this.clearInteraction(message.conversationKey);

    // 更新案件断点阶段
    this.checkpoints.updateStage(pending.caseId, "analyzing", "开始证据链分析");

    const progressState: LaborProgressState = {
      totalFiles: pending.files.length,
      fileNames: pending.files.map(getLaborMaterialInputName),
      completedFiles: [],
      failedFiles: [],
      currentPhase: "正在准备证据链分析",
      recentUpdates: [],
      startedAt: Date.now(),
      steps: createLaborAnalysisSteps(),
    };

    const processing = await this.deps.transport.sendPayload(message.chatId, buildLaborAnalysisProgressPayload(toLaborProgressCardView(progressState)), {
      event: "labor analysis started",
      transcriptType: "outbound-final",
      textPreview: "劳动分析处理中",
      len: 7,
    }, { replyToMessageId: message.messageId });
    options?.onFirstVisibleCard?.();

    const extractedMaterials: LaborMaterialExtraction[] = [];
    const warnings: string[] = [];
    const materialInputs: LaborMaterialInput[] = [];

    for (const file of pending.files) {
      try {
        const expanded = await this.deps.service!.expandMaterialFile(file);
        materialInputs.push(...expanded);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const fileName = getLaborMaterialInputName(file);
        warnings.push(`已跳过《${fileName}》：${detail}`);
        progressState.failedFiles.push({
          fileName,
          elapsedMs: 0,
          detail,
        });
      }
    }
    progressState.totalFiles = materialInputs.length + progressState.failedFiles.length;
    progressState.fileNames = materialInputs.map(getLaborMaterialInputName);
    await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);

    for (const file of materialInputs) {
      const fileName = getLaborMaterialInputName(file);
      progressState.currentFile = fileName;
      progressState.currentFileStartedAt = Date.now();
      progressState.currentPhase = "正在解析证据材料";
      setLaborStep(progressState, "读取内容", "running", "正在解析证据材料");
      setLaborStep(progressState, "提取关键信息", "pending");
      await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);

      try {
        const extracted = await this.deps.service!.extractMaterial(file, {
          onProgress: async (step) => {
            setLaborStep(progressState, "读取内容", "completed", "已完成");
            setLaborStep(progressState, "提取关键信息", "running", shortenProgress(step, fileName));
            pushProgress(progressState, shortenProgress(step, fileName));
            await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
          },
        });
        extractedMaterials.push(extracted.extraction);
        progressState.completedFiles.push({
          fileName,
          elapsedMs: Date.now() - (progressState.currentFileStartedAt ?? Date.now()),
          cached: extracted.cached,
        });
        setLaborStep(progressState, "读取内容", "completed", "已完成");
        setLaborStep(progressState, "提取关键信息", "completed", "已完成");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        progressState.failedFiles.push({
          fileName,
          elapsedMs: Date.now() - (progressState.currentFileStartedAt ?? Date.now()),
          detail,
        });
        warnings.push(`已跳过《${fileName}》：${detail}`);
        setLaborStep(progressState, "提取关键信息", "error", detail);
      }
      await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
    }

    if (extractedMaterials.length === 0) {
      this.checkpoints.updateStage(pending.caseId, "failed", "无可用材料");
      await this.safeUpdateNotice(pending.chatId, processing.messageId, {
        title: "劳动分析失败",
        template: "red",
        icon: "error_filled",
        message: warnings.length > 0 ? warnings.join("\n") : "当前没有可用于劳动分析的材料。",
      }, "labor analysis failed");
      return;
    }

    progressState.currentFile = undefined;
    progressState.currentFileStartedAt = undefined;
    progressState.currentPhase = "正在汇总证据链并生成文档";
    progressState.recentUpdates = [];
    setLaborStep(progressState, "读取内容", "completed", "已完成");
    setLaborStep(progressState, "提取关键信息", "completed", "已完成");
    setLaborStep(progressState, "案件级汇总", "running", "正在检索知识库与识别争议焦点");
    setLaborStep(progressState, "创建预览文档", "pending");
    setLaborStep(progressState, "写入云文档", "pending");
    setLaborStep(progressState, "生成图表与台账", "pending");
    await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);

    let result: LaborAnalyzeResult;
    try {
      result = await this.deps.service!.finalizeAnalysis({
        extractedMaterials,
        notes: pending.notes,
        materialCount: materialInputs.length,
        warnings,
        preferredTitle: pending.title,
      }, {
        onProgress: async (step) => {
          applyLaborFinalizeProgress(progressState, step);
          pushProgress(progressState, shortenProgress(step));
          await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
        },
        onWorkbenchPreviewCreated: async (docUrl) => {
          progressState.previewDocUrl = docUrl;
          progressState.currentPhase = "正在写入工作台文档";
          setLaborStep(progressState, "创建预览文档", "completed", "已完成");
          setLaborStep(progressState, "写入云文档", "running", "预览文档已创建");
          pushProgress(progressState, "预览文档已创建，可打开查看写入进度");
          await this.updateProcessingCard(pending.chatId, processing.messageId, progressState);
        },
      });

      await this.deps.transport.updatePayload(pending.chatId, processing.messageId, buildLaborAnalysisCompletedPayload(buildLaborCompletedView(result, progressState.totalFiles, {
        elapsedMs: Date.now() - progressState.startedAt,
      })), {
        event: "labor first-pass analysis completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(`${result.title}｜一审劳动分析完成`),
        len: result.title.length,
      });

      if (!result.docUrl) {
        await this.sendLaborMarkdownFallback(message, pending, result);
      }
      this.saveCaseWorkbenchContext(pending, result);

    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.checkpoints.updateStage(pending.caseId, "failed", "分析生成失败");
      await this.safeUpdateNotice(pending.chatId, processing.messageId, {
        title: "劳动分析失败",
        template: "red",
        icon: "error_filled",
        message: detail,
      }, "labor analysis failed");
      return;
    }

    // 更新案件断点：分析完成，进入二审
    this.checkpoints.updateStage(pending.caseId, "reviewing", "分析完成，进入二审");

    const reviewCard = await this.deps.transport.sendPayload(pending.chatId, buildLaborFinalReviewPayload({
      title: result.title,
      statusText: "二审模型审查中...",
      detail: "正在后台校验法条引用、请求权基础、证据支撑和高风险结论。",
      level: "info",
      steps: [
        { label: "整理审查材料", status: "running" },
        { label: "法条与案例溯源", status: "pending" },
        { label: "二审模型审查", status: "pending" },
        { label: "汇总审查结论", status: "pending" },
      ],
      authorityStatus: "running",
      citationStatus: "pending",
      modelReviewStatus: "pending",
    }), {
      event: "labor final review started",
      transcriptType: "outbound-final",
      textPreview: "劳动分析二审审查中",
      len: 9,
    }, this.getDelivery(pending));

    await this.runAuthoritySearchAndReview(pending, result, reviewCard.messageId, Date.now());
  }

  private clearInteraction(conversationKey: string): void {
    this.interactions.delete(conversationKey);
  }

  private async runAuthoritySearchAndReview(
    pending: PendingLaborInteraction,
    result: LaborAnalyzeResult,
    reviewMessageId: string,
    reviewStartedAt: number,
  ): Promise<void> {
    const draft = this.deps.service!.buildAuthoritySearchDraft(result);
    let authorityContext: LaborReviewAuthorityContext = { status: "pending" };
    try {
      const appended = await this.deps.service!.appendAuthoritySearch(result, {
        query: draft.mainQuery,
        turnId: reviewMessageId,
        sessionId: pending.conversationKey,
      });
      authorityContext = {
        status: "completed",
        searchResult: appended.search,
        lawRecognition: appended.lawRecognition,
        citationValidation: appended.citationValidation,
        caseNumberRecognition: appended.caseNumberRecognition,
      };
    } catch (error) {
      this.deps.logger.log("labor/authority", "background authority search failed", {
        conversationKey: pending.conversationKey,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }

    await this.updateReviewProgressCard(pending, result, authorityContext, reviewMessageId);
    await this.runReviewAndUpdateCard(pending, result, authorityContext, reviewMessageId, reviewStartedAt);
  }

  private async updateReviewProgressCard(
    pending: PendingLaborInteraction,
    result: LaborAnalyzeResult,
    authorityContext: LaborReviewAuthorityContext,
    reviewMessageId: string,
  ): Promise<void> {
    const authorityAvailable = authorityContext.status === "completed";
    const citationAvailable = Boolean(authorityContext.citationValidation);
    try {
      await this.deps.transport.updatePayload(pending.chatId, reviewMessageId, buildLaborFinalReviewPayload({
        title: result.title,
        statusText: "二审模型审查中...",
        detail: authorityAvailable
          ? "权威检索与引用线索已完成，正在进行二审模型审查。"
          : "权威检索不可用，正在使用一审结果与本地线索进行二审模型审查。",
        level: "info",
        steps: [
          { label: "整理审查材料", status: "completed" },
          { label: "法条与案例溯源", status: authorityAvailable ? "completed" : "error" },
          { label: "二审模型审查", status: "running" },
          { label: "汇总审查结论", status: "pending" },
        ],
        authorityStatus: authorityAvailable ? "completed" : "error",
        citationStatus: citationAvailable ? "completed" : authorityAvailable ? "skipped" : "error",
        modelReviewStatus: "running",
      }), {
        event: "labor final review progress updated",
        transcriptType: "outbound-final",
        textPreview: authorityAvailable ? "权威检索完成，二审模型审查中" : "权威检索不可用，二审模型审查中",
        len: 16,
      });
    } catch (error) {
      this.deps.logger.log("feishu/reply", "labor review progress update failed", {
        conversationKey: pending.conversationKey,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private async runReviewAndUpdateCard(
    pending: PendingLaborInteraction,
    result: LaborAnalyzeResult,
    authorityContext: LaborReviewAuthorityContext,
    reviewMessageId: string,
    reviewStartedAt: number,
  ): Promise<void> {
    try {
      const { reviewReport, reviewSkippedReason } = await this.deps.service!.finalizeReviewOnly(result, authorityContext);
      const finalReviewStatus = formatReviewStatus(reviewReport, reviewSkippedReason) ?? "未返回审查结论，法条引用待人工校验";
      const completedView = buildLaborCompletedView(result, undefined, { reviewReport, reviewSkippedReason });
      const appendReview = this.deps.service!.appendReviewToWorkbench?.(result, reviewReport);
      if (appendReview) {
        await appendReview.catch((error) => {
          this.deps.logger.log("labor/authority", "append review to workbench skipped", {
            conversationKey: pending.conversationKey,
            detail: error instanceof Error ? error.message : String(error),
          }, "warn");
        });
      }
      await this.deps.transport.updatePayload(pending.chatId, reviewMessageId, buildLaborReviewCompletedPayload({
        title: completedView.title,
        materialCount: completedView.materialCount,
        evidenceCount: completedView.evidenceCount,
        issueCount: completedView.issueCount,
        tagCounts: completedView.tagCounts,
        reviewStatus: finalReviewStatus,
        findingsCount: reviewReport?.findings.length,
        humanReviewCount: reviewReport ? countHumanReviewItems(reviewReport) : undefined,
        citationDetails: collectCitationValidationDetails(authorityContext),
        findings: reviewReport?.findings.map((finding) => ({
          severity: finding.severity,
          message: formatLaborReviewFindingText(finding),
        })),
        elapsedMs: Date.now() - reviewStartedAt,
        docUrl: result.docUrl,
        ledgerUrl: result.ledgerUrl,
        keyEvidenceViewUrl: result.keyEvidenceViewUrl,
        missingEvidenceViewUrl: result.missingEvidenceViewUrl,
        syncedEvidenceCount: result.syncedEvidenceCount,
        syncedGapCount: result.syncedGapCount,
      }), {
        event: "labor final review completed",
        transcriptType: "outbound-final",
        textPreview: finalReviewStatus,
        len: finalReviewStatus.length,
      });
      // 更新案件断点：二审完成
      this.checkpoints.updateStage(pending.caseId, "completed", "二审完成");
    } catch (error) {
      this.deps.logger.log("labor/authority", "post-decision review failed", {
        conversationKey: pending.conversationKey,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      this.checkpoints.updateStage(pending.caseId, "failed", "二审调用失败");
    }
    this.clearInteraction(pending.conversationKey);
  }

  private saveCaseWorkbenchContext(pending: PendingLaborInteraction, result: LaborAnalyzeResult): void {
    this.deps.caseContextStore?.upsert({
      caseId: pending.caseId,
      title: result.title,
      userId: pending.requesterOpenId,
      chatId: pending.chatId,
      conversationKey: pending.conversationKey,
      source: "labor",
      docUrl: result.docUrl,
      markdown: result.markdown,
      summary: result.aggregate.summary,
      partyInfo: extractPartyInfoFromMaterials(result.extractedMaterials),
      issues: result.aggregate.keyIssues.length > 0
        ? result.aggregate.keyIssues
        : result.aggregate.issues.map((item) => item.issue),
      claimBasis: result.aggregate.claimBasis.map((item) => [
        item.claim,
        item.basis,
        item.evidence.length > 0 ? `证据：${item.evidence.join("、")}` : "",
      ].filter(Boolean).join("｜")),
      evidence: result.aggregate.evidenceRows.map((item) => [
        item.name,
        item.proves,
        item.support ? `支持方向：${item.support}` : "",
      ].filter(Boolean).join("｜")),
      missingEvidence: result.aggregate.missingEvidence,
      updatedAt: Date.now(),
    });
  }

  private async sendLaborMarkdownFallback(
    triggerMessage: Pick<IncomingChatMessage, "messageId">,
    pending: Pick<PendingLaborInteraction, "chatId">,
    result: LaborAnalyzeResult,
  ): Promise<void> {
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
    }, { replyToMessageId: triggerMessage.messageId });
  }

  private clearRequesterInteractions(chatId: string, requesterOpenId: string): void {
    for (const [conversationKey, pending] of this.interactions.entries()) {
      if (pending.chatId === chatId && pending.requesterOpenId === requesterOpenId) {
        this.checkpoints.updateStage(pending.caseId, "expired", "已新建案件，旧收集已关闭");
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
        level: resolveNoticeLevelFromTemplate(options.template),
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
      level: resolveNoticeLevelFromTemplate(options.template),
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
    this.checkpoints.updateStage(pending.caseId, "expired", "材料收集超时");
    await this.deps.transport.sendNotice({
      chatId: pending.chatId,
      replyToMessageId: pending.anchorMessageId,
    }, {
      title: "劳动分析已超时",
      level: "neutral",
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

  /**
   * 从自然语言文本中解析本地文件夹路径，收集目录内支持的文件。
   * 返回 null 表示文本不含文件夹引用。
   */
  private async resolveLocalFolderFiles(text: string): Promise<{
    resolvedPath: string;
    files: string[];
    skipped: Array<{ fileName: string; reason: string }>;
  } | null> {
    const folderPath = inferLaborFolderPath(text);
    if (!folderPath) {
      return null;
    }
    const normalizedPath = normalizeLocalPath(folderPath);
    const stat = await fs.stat(normalizedPath).catch(() => null);
    if (!stat) {
      return null;
    }
    if (stat.isFile()) {
      if (this.isLaborFileAcceptable(normalizedPath)) {
        return { resolvedPath: normalizedPath, files: [normalizedPath], skipped: [] };
      }
      return null;
    }
    if (!stat.isDirectory()) {
      return null;
    }
    const entries = await fs.readdir(normalizedPath, { withFileTypes: true }).catch(() => []);
    const allowedExtensions = this.featureConfig.ingest.allowedExtensions;
    const files: string[] = [];
    const skipped: Array<{ fileName: string; reason: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        skipped.push({ fileName: entry.name, reason: `不支持的类型 ${ext}` });
        continue;
      }
      files.push(path.join(normalizedPath, entry.name));
    }
    files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN"));
    return { resolvedPath: normalizedPath, files, skipped };
  }

  private isLaborFileAcceptable(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.featureConfig.ingest.allowedExtensions.includes(ext);
  }

  // #endregion
}

function isLaborFinishCommand(command: LaborCommand): boolean {
  if (command.kind !== "passthrough") {
    return false;
  }
  const normalized = command.name.trim().toLowerCase();
  return normalized === "完成上传" || normalized === "材料收集完成";
}

/** 从文本推断劳动案件文件夹路径。仅匹配低置信的自然语言模式。 */
function inferLaborFolderPath(text: string): string | null {
  const normalized = text.replace(/\s+/g, "");
  const hasLaborKeyword = /劳动|案件|材料|证据|仲裁/.test(normalized);
  const hasFolderKeyword = /文件夹|目录|folder/i.test(normalized);
  if (!hasLaborKeyword || !hasFolderKeyword) {
    return null;
  }
  const explicitPath = extractLocalPathFromText(text);
  if (explicitPath) {
    return explicitPath;
  }
  const home = process.env.HOME || os.homedir();
  if (!home) {
    return null;
  }
  const folderNameMatch = normalized.match(/(?:桌面(?:上|里|下)?)?([^，。；,;\s/]*(?:劳动|案件)[^，。；,;\s/]*)/);
  const rawFolderName = folderNameMatch?.[1]?.replace(/(?:文件夹|目录|里面|里|下|中|所有|全部|的)+$/g, "") || "";
  if (rawFolderName) {
    return path.join(home, "Desktop", rawFolderName);
  }
  return path.join(home, "Desktop", "劳动案件");
}

function extractLocalPathFromText(text: string): string | null {
  const trimmed = text.trim();
  const quoted = trimmed.match(/[`"'""'']((?:~\/|\/)[^`"'""'']+)[`"'""'']/);
  if (quoted?.[1]) {
    return normalizeLocalPath(quoted[1]);
  }
  const absolute = trimmed.match(/(?:^|\s)((?:~\/|\/)[^\s，。；,;]+)/);
  return absolute?.[1] ? normalizeLocalPath(absolute[1]) : null;
}

function normalizeLocalPath(value: string): string {
  return value.replace(/^~/, process.env.HOME ?? "~").trim();
}

function shouldCollectLaborInput(message: IncomingChatMessage): boolean {
  if (message.messageType === "file") {
    return true;
  }
  if (message.messageType !== "text") {
    return false;
  }
  const text = message.plainText.trim();
  if (!text) {
    return false;
  }
  if (/^(你好|您好|在吗|hi|hello|test|测试|启动安全工作台)$/i.test(text)) {
    return false;
  }
  if (/^(补充|补充说明|材料说明|案情|背景|事实|备注|说明)[：:\s]/.test(text)) {
    return true;
  }
  if (/(补充.*(背景|说明)|背景说明|材料说明|完成上传了)/.test(text)) {
    return true;
  }
  if (text.length < 12) {
    return false;
  }
  return /(劳动|仲裁|工资|社保|解除|辞退|离职|赔偿|补偿|合同|考勤|绩效|证据|材料|公司|用人单位|文件夹|目录|folder)/i.test(text);
}

function isCaseWorkbenchStartCommand(command: LaborCommand): boolean {
  return command.kind === "passthrough"
    && command.name.trim().toLowerCase() === "案件工作台";
}

function renderProcessingMessage(state: LaborProgressState): string {
  const lines = [
    `**总进度**\n${state.completedFiles.length + state.failedFiles.length}/${state.totalFiles}`,
    `**当前阶段**\n${state.currentPhase}`,
  ];
  if (state.currentFile) {
    lines.push(`**当前材料**\n${state.currentFile}`);
  }
  lines.push(`**已完成**\n${state.completedFiles.length > 0 ? state.completedFiles.map((item) => item.fileName).join("、") : "暂无"}`);
  if (state.failedFiles.length > 0) {
    lines.push(`**失败**\n${state.failedFiles.map((item) => item.fileName).join("、")}`);
  }
  lines.push("**处理进展**\n" + state.recentUpdates.map((item) => `- ${item}`).join("\n"));
  return lines.join("\n\n");
}

function createLaborAnalysisSteps(): LaborProgressState["steps"] {
  return [
    { label: "读取内容", status: "pending" },
    { label: "提取关键信息", status: "pending" },
    { label: "案件级汇总", status: "pending" },
    { label: "创建预览文档", status: "pending" },
    { label: "写入云文档", status: "pending" },
    { label: "生成图表与台账", status: "pending" },
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
  setLaborStep(state, "读取内容", "completed", "已完成");
  setLaborStep(state, "提取关键信息", "completed", "已完成");
  if (/预览文档|创建飞书工作台预览文档/.test(normalized)) {
    setLaborStep(state, "案件级汇总", "completed", "已完成");
    setLaborStep(state, "创建预览文档", "running", shortenProgress(normalized));
    return;
  }
  if (/写入飞书工作台文档|写入云文档/.test(normalized)) {
    setLaborStep(state, "案件级汇总", "completed", "已完成");
    setLaborStep(state, "创建预览文档", "completed", "已完成");
    setLaborStep(state, "写入云文档", "running", shortenProgress(normalized));
    return;
  }
  if (/图|白板|台账|视图/.test(normalized)) {
    setLaborStep(state, "案件级汇总", "completed", "已完成");
    setLaborStep(state, "创建预览文档", "completed", "已完成");
    setLaborStep(state, "写入云文档", "completed", "已完成");
    setLaborStep(state, "生成图表与台账", "running", shortenProgress(normalized));
    return;
  }
  setLaborStep(state, "案件级汇总", "running", shortenProgress(normalized));
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
    .replace(/命中缓存[，,、\s]*/g, "")
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
    elapsedMs: Date.now() - state.startedAt,
    totalFiles: state.totalFiles,
    queuedFiles: inferLaborQueuedFiles(state),
    completedFiles: state.completedFiles.map((item) => formatLaborFileResult(item.fileName, item.elapsedMs)),
    failedFiles: state.failedFiles.map((item) => formatLaborFileResult(item.fileName, item.elapsedMs, item.detail)),
    currentPhase: state.currentPhase,
    recentUpdates: state.recentUpdates,
    insightLines: compactLaborProgressUpdates(state.recentUpdates),
    docUrl: state.previewDocUrl,
  };
}

function compactLaborProgressUpdates(updates: string[]): string[] {
  const seen = new Set<string>();
  return updates
    .map((line) => line.trim())
    .filter((line) => line && !seen.has(line) && seen.add(line))
    .slice(-4);
}

function inferLaborQueuedFiles(state: LaborProgressState): string[] {
  const done = new Set([
    ...state.completedFiles.map((item) => item.fileName),
    ...state.failedFiles.map((item) => item.fileName),
  ]);
  return state.fileNames.filter((fileName) => fileName !== state.currentFile && !done.has(fileName));
}

function formatLaborFileResult(fileName: string, elapsedMs: number, suffix?: string | undefined): string {
  const elapsed = formatShortElapsed(elapsedMs);
  return [fileName, `耗时 ${elapsed}`, suffix].filter(Boolean).join("｜");
}

function formatShortElapsed(elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function buildLaborCompletedView(result: {
  title: string;
  docUrl?: string | undefined;
  ledgerUrl?: string | undefined;
  keyEvidenceViewUrl?: string | undefined;
  missingEvidenceViewUrl?: string | undefined;
  syncedEvidenceCount: number;
  syncedGapCount: number;
  extractedMaterials: LaborMaterialExtraction[];
  aggregate: { evidenceRows: Array<unknown>; issues: Array<unknown> };
}, totalFiles: number | undefined, review?: {
  reviewReport?: LaborFinalReviewReport | null | undefined;
  reviewSkippedReason?: string | undefined;
  reviewStatusOverride?: string | undefined;
  elapsedMs?: number | undefined;
}): LaborAnalysisCompletedCardView {
  const tagCounts: Record<string, number> = {};
  for (const material of result.extractedMaterials) {
    const key = material.materialType?.trim() || "其他";
    tagCounts[key] = (tagCounts[key] ?? 0) + 1;
  }
  return {
    title: result.title,
    materialCount: totalFiles ?? result.extractedMaterials.length,
    evidenceCount: result.aggregate.evidenceRows.length,
    issueCount: result.aggregate.issues.length,
    tagCounts,
    docUrl: result.docUrl,
    ledgerUrl: result.ledgerUrl,
    keyEvidenceViewUrl: result.keyEvidenceViewUrl,
    missingEvidenceViewUrl: result.missingEvidenceViewUrl,
    syncedEvidenceCount: result.syncedEvidenceCount,
    syncedGapCount: result.syncedGapCount,
    reviewStatus: review?.reviewStatusOverride ?? formatReviewStatus(review?.reviewReport, review?.reviewSkippedReason),
    elapsedMs: review?.elapsedMs,
  };
}

/** 将二审结果映射为完成卡片中的一行状态文本。 */
function formatReviewStatus(
  report: LaborFinalReviewReport | null | undefined,
  skippedReason?: string | undefined,
): string | undefined {
  if (report) {
    switch (report.status) {
      case "pass":
        return "通过，法条引用已完成独立校验";
      case "needs_revision":
        return `建议修改（${report.findings.length} 条发现），法条引用已完成独立校验`;
      case "needs_human_review":
        return `需人工复核（${countHumanReviewItems(report)} 项），法条引用已完成独立校验`;
    }
  }
  switch (skippedReason) {
    case "review_skipped_no_config":
      return "未配置，法条引用待人工校验";
    case "review_skipped_same_as_analyze":
      return "跳过（与一审同模型），法条引用待人工校验";
    case "review_call_failed":
      return "调用失败，法条引用待人工校验";
    default:
      return undefined;
  }
}

function countHumanReviewItems(report: LaborFinalReviewReport): number {
  const highFindings = report.findings.filter((finding) => finding.severity === "high").length;
  return Math.max(highFindings, report.unsupportedClaims.length, report.findings.length, 1);
}

function collectCitationValidationDetails(authorityContext: LaborReviewAuthorityContext): Array<{ label: string; excerpt?: string; url?: string }> {
  const items = authorityContext.citationValidation?.items ?? [];
  return items.slice(0, 5).map((item) => {
    const article = formatCitationArticleNumber(item.articleNumber);
    const excerpt = item.originalText.replace(/\s+/g, " ").slice(0, 80);
    const label = `《${item.title}》${article}`;
    return {
      label,
      ...(excerpt ? { excerpt } : {}),
      ...(item.url ? { url: item.url } : {}),
    };
  });
}

function getLaborMaterialInputName(file: LaborMaterialInput): string {
  if ("fileName" in file && file.fileName?.trim()) {
    return file.fileName.trim();
  }
  if ("localPath" in file) {
    return path.basename(file.localPath);
  }
  return "未命名材料";
}

function formatCitationArticleNumber(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  if (/^第.+条$/.test(normalized)) {
    return normalized;
  }
  return `第${normalized}条`;
}
