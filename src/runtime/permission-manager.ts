/**
 * 职责: 管理模型工具调用权限请求的完整生命周期。
 * 关注点:
 * - 创建挂起权限交互并展示审批卡片。
 * - 处理用户决策、超时和状态清理。
 * - 将权限结果回传给 OpenCode。
 */
import type { PendingPermissionInteraction } from "../bridge/state.js";
import { buildNoticeCardPayload, type FeishuPostPayload } from "../feishu/shared-primitives.js";
import { logEvent, type Logger, type TranscriptType } from "../logging/logger.js";
import type { PermissionPolicy } from "../opencode/client.js";
import type { PermissionCardActionValue } from "./app.js";
import { isPermissionCardActionValue } from "./app-helpers.js";

type PermissionResolution = "once" | "always" | "deny" | "timeout";

type OpenCodePermissionPort = {
  replyPermission(sessionId: string, permissionId: string, policy: PermissionPolicy, remember: boolean): Promise<boolean>;
};

type SendPayloadOptions = {
  event: string;
  transcriptType: TranscriptType;
  textPreview: string;
  len: number;
};

type PermissionManagerCallbacks = {
  clearPendingInteraction(conversationKey: string, keepNonExpiring: boolean): void;
  updateTurnCard(turnId: string, update: { status?: string; update?: string; sanitize?: boolean; target?: "step" | "tool" | "final"; toolKey?: string }): Promise<void>;
  sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: SendPayloadOptions,
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
  ): Promise<{ messageId: string }>;
  toCardContent(payload: FeishuPostPayload): Record<string, unknown>;
};

export class PermissionManager {
  private readonly interactions = new Map<string, PendingPermissionInteraction>();
  private readonly processing = new Set<string>();

  constructor(
    private readonly opencode: OpenCodePermissionPort,
    private readonly logger: Logger,
    private readonly callbacks: PermissionManagerCallbacks,
  ) {}

  // #region 对外入口

  /** 注册一条新的权限请求。 */
  registerInteraction(interaction: PendingPermissionInteraction): void {
    this.interactions.set(interaction.permissionVersion, interaction);
  }

  /** 处理来自飞书卡片的权限审批动作。 */
  async handleCardAction(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isPermissionCardActionValue(value)) {
      return this.callbacks.toCardContent(this.buildNoticePayload("信息提示", "blue", "info_outlined", "当前卡片动作无法识别。"));
    }

    const interaction = this.interactions.get(value.nonce);
    if (!interaction || !this.matchesAction(interaction, value, openMessageId)) {
      return this.callbacks.toCardContent(this.buildNoticePayload("提醒", "yellow", "maybe_outlined", "权限请求已失效，请重新触发操作。"));
    }

    if (interaction.requesterOpenId !== actorOpenId) {
      return this.callbacks.toCardContent(this.buildNoticePayload("提醒", "yellow", "maybe_outlined", "当前按钮仅限本轮发起者处理。"));
    }

    if (interaction.resolvedAt && interaction.resolution) {
      return this.callbacks.toCardContent(this.buildResolutionPayload(interaction.resolution));
    }

    if (interaction.expiresAt <= Date.now()) {
      await this.expireInteraction(interaction, false);
      return this.callbacks.toCardContent(this.buildResolutionPayload("timeout"));
    }

    if (this.processing.has(interaction.permissionVersion)) {
      return this.callbacks.toCardContent(this.buildNoticePayload("信息提示", "blue", "info_outlined", "当前权限请求正在处理。"));
    }

    try {
      await this.resolveInteraction(interaction, value.policy);
      return this.callbacks.toCardContent(this.buildResolutionPayload(value.policy));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("bridge/permission", "card action failed", {
        permissionId: interaction.permissionId,
        nonce: interaction.permissionVersion,
        detail,
      }, "warn");
      return this.callbacks.toCardContent(this.buildNoticePayload("错误", "red", "more-close_outlined", "权限请求处理失败，请稍后重试。"));
    }
  }

  /** 为权限卡片构建动作按钮。 */
  buildActionButtons(interaction: PendingPermissionInteraction): Array<{
    label: string;
    type: "default" | "primary" | "danger";
    value: PermissionCardActionValue;
  }> {
    return [
      {
        label: "/allow once · 仅此一次",
        type: "primary",
        value: this.buildActionValue(interaction, "once"),
      },
      {
        label: "/allow always · 始终允许",
        type: "default",
        value: this.buildActionValue(interaction, "always"),
      },
      {
        label: "/deny · 拒绝",
        type: "danger",
        value: this.buildActionValue(interaction, "deny"),
      },
    ];
  }

  /** 根据处理结果构建最终提示卡片。 */
  buildResolutionPayload(resolution: PermissionResolution): FeishuPostPayload {
    if (resolution === "once") {
      return this.buildNoticePayload("信息提示", "green", "yes_outlined", "当前权限请求已确认，可继续执行。");
    }

    if (resolution === "always") {
      return this.buildNoticePayload("信息提示", "green", "yes_outlined", "当前权限请求已确认，后续同类权限将自动允许。");
    }

    if (resolution === "timeout") {
      return this.buildNoticePayload("提醒", "yellow", "maybe_outlined", "权限请求已超时，已默认拒绝。");
    }

    return this.buildNoticePayload("错误", "red", "more-close_outlined", "当前权限请求已拒绝。");
  }

  /** 将权限结果回传给 OpenCode，并同步本地状态。 */
  async resolveInteraction(interaction: PendingPermissionInteraction, resolution: PermissionResolution): Promise<void> {
    const remember = resolution === "always";
    const response: PermissionPolicy = resolution === "deny" || resolution === "timeout" ? "reject" : resolution;
    this.processing.add(interaction.permissionVersion);
    try {
      await this.opencode.replyPermission(interaction.sessionId, interaction.permissionId, response, remember);
      interaction.resolvedAt = Date.now();
      interaction.resolution = resolution;
      this.interactions.set(interaction.permissionVersion, interaction);
      this.callbacks.clearPendingInteraction(interaction.conversationKey, false);
      await this.callbacks.updateTurnCard(interaction.turnId, {
        status: "处理中",
        update: resolution === "timeout" ? "权限请求已超时，已默认拒绝" : `已处理权限请求：${interaction.permissionName}`,
        target: "step",
      });
      logEvent(this.logger, "bridge/permission", "permission.decided", {
        turnId: interaction.turnId,
        sessionId: interaction.sessionId,
        chatId: interaction.chatId,
        permissionId: interaction.permissionId,
        decision: resolution === "deny" || resolution === "timeout" ? "denied" : "approved",
        decisionSource: resolution === "timeout" ? "timeout" : "user",
      });
    } finally {
      this.processing.delete(interaction.permissionVersion);
    }
  }

  /** 处理权限超时，并按需通知聊天窗口。 */
  async expireInteraction(interaction: PendingPermissionInteraction, notifyChat: boolean): Promise<void> {
    if (interaction.resolvedAt && interaction.resolution) {
      return;
    }

    if (this.processing.has(interaction.permissionVersion)) {
      return;
    }

    try {
      await this.resolveInteraction(interaction, "timeout");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("bridge/permission", "auto deny failed", {
        chatId: interaction.chatId,
        permissionId: interaction.permissionId,
        nonce: interaction.permissionVersion,
        detail,
      }, "warn");
      interaction.resolvedAt = Date.now();
      interaction.resolution = "timeout";
      this.interactions.set(interaction.permissionVersion, interaction);
      this.callbacks.clearPendingInteraction(interaction.conversationKey, false);
    }

    if (!notifyChat) {
      return;
    }

    await this.callbacks.sendPayload(interaction.chatId, this.buildResolutionPayload("timeout"), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: "权限请求已超时，已默认拒绝。",
      len: 13,
    }, { replyToMessageId: interaction.replyToMessageId });
  }

  // #endregion

  // #region 内部辅助

  /** 构建卡片按钮 value。 */
  private buildActionValue(
    interaction: PendingPermissionInteraction,
    policy: PermissionCardActionValue["policy"],
  ): PermissionCardActionValue {
    return {
      kind: "permission",
      conversationKey: interaction.conversationKey,
      turnId: interaction.turnId,
      sessionId: interaction.sessionId,
      permissionId: interaction.permissionId,
      policy,
      nonce: interaction.permissionVersion,
    };
  }

  /** 校验卡片回调与当前权限请求是否匹配。 */
  private matchesAction(
    interaction: PendingPermissionInteraction,
    value: PermissionCardActionValue,
    openMessageId: string,
  ): boolean {
    const matchesMessageId = !openMessageId || !interaction.permissionMessageId || interaction.permissionMessageId === openMessageId;

    return interaction.conversationKey === value.conversationKey
      && interaction.permissionId === value.permissionId
      && interaction.sessionId === value.sessionId
      && interaction.turnId === value.turnId
      && interaction.permissionVersion === value.nonce
      && matchesMessageId;
  }

  /** 构建统一样式的提示卡片。 */
  private buildNoticePayload(
    title: string,
    template: "blue" | "yellow" | "red" | "green",
    iconToken: string,
    message: string,
  ): FeishuPostPayload {
    return buildNoticeCardPayload({
      title,
      template,
      iconToken,
      message,
      messageIconToken: iconToken,
      messageIconColor: template,
    });
  }

  // #endregion
}
