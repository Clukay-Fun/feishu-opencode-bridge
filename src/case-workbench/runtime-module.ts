/**
 * 职责: 承接案件工作台统一入口。
 * 关注点:
 * - 识别案件工作台命令与高置信自然语言入口。
 * - 在单领域阶段 fast-path 到劳动争议材料收集。
 * - 处理案件工作台入口卡按钮，不持有领域模块内部状态。
 */
import type { RuntimeModule, RuntimeModuleHandleResult, RuntimeModuleMessageContext } from "../bridge/module.js";
import { buildCaseWorkbenchPayload } from "../feishu/contract-cards.js";
import { buildNoticeCardPayload } from "../feishu/shared-primitives.js";
import { createTextPreview, type Logger } from "../logging/logger.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";

export type CaseWorkbenchLaborPort = {
  startCaseWorkbenchCollection(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    title?: string | undefined,
    options?: { anchorMessageId?: string | undefined; suppressInitialCard?: boolean | undefined } | undefined,
  ): Promise<void>;
};

type CaseWorkbenchRuntimeModuleDeps = {
  logger: Logger;
  transport: FeishuTransport;
  labor: CaseWorkbenchLaborPort;
};

type CaseWorkbenchIntent = "labor" | "workbench" | null;

export class CaseWorkbenchRuntimeModule implements RuntimeModule {
  readonly name = "case-workbench";
  readonly priority = 35;

  constructor(private readonly deps: CaseWorkbenchRuntimeModuleDeps) {}

  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    if (message.messageType !== "text" && message.messageType !== "post") {
      return { claimed: false };
    }

    if (routed?.kind === "command") {
      if (routed.command.kind !== "passthrough" || routed.command.name.trim().toLowerCase() !== "案件工作台") {
        return { claimed: false };
      }
      const title = routed.command.arguments.join(" ").trim() || undefined;
      await this.startLaborFastPath(message, title);
      return { claimed: true };
    }

    const intent = detectCaseWorkbenchIntent(message.plainText);
    if (!intent) {
      return { claimed: false };
    }
    if (intent === "labor") {
      await this.startLaborFastPath(message, extractCaseWorkbenchTitle(message.plainText));
      return { claimed: true };
    }

    await this.sendWorkbenchEntryCard(message);
    return { claimed: true };
  }

  async handleCardAction(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (value.kind !== "case-workbench-action") {
      return null;
    }
    const requesterOpenId = typeof value.requesterOpenId === "string" ? value.requesterOpenId : "";
    if (requesterOpenId && requesterOpenId !== actorOpenId) {
      return buildCaseWorkbenchToast("只有工作台发起人可以操作。", "warning");
    }
    if (value.action === "cancel") {
      if (chatIdFromValue(value)) {
        await this.updateEntryCard(openMessageId, value, "案件工作台已取消", "已取消本次案件工作台入口。", "grey").catch((error) => {
          this.logCardUpdateFailure(error);
        });
      }
      return buildCaseWorkbenchToast("已取消案件工作台入口。", "success");
    }
    if (value.action !== "start-material-collection") {
      return buildCaseWorkbenchToast("未识别的案件工作台操作。", "warning");
    }

    const chatId = typeof value.chatId === "string" ? value.chatId : "";
    const conversationKey = typeof value.conversationKey === "string" ? value.conversationKey : "";
    const chatType = typeof value.chatType === "string" ? value.chatType : "group";
    if (!chatId || !conversationKey) {
      return buildCaseWorkbenchToast("入口卡片缺少上下文，请重新发送 /案件工作台。", "warning");
    }

    this.scheduleMaterialCollectionStart({
      chatId,
      chatType,
      openMessageId,
      conversationKey,
      actorOpenId,
    });
    return buildCaseWorkbenchToast("已进入材料收集。", "success");
  }

  private async startLaborFastPath(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    title?: string | undefined,
  ): Promise<void> {
    this.deps.logger.log("case-workbench/runtime", "case workbench fast-path to labor", {
      conversationKey: message.conversationKey,
      hasTitle: Boolean(title),
    });
    await this.deps.labor.startCaseWorkbenchCollection(message, title);
  }

  private async sendWorkbenchEntryCard(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
  ): Promise<void> {
    const payload = buildCaseWorkbenchPayload({
      domains: ["劳动争议分析"],
      chatId: message.chatId,
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
    });
    await this.deps.transport.sendPayload(message.chatId, payload, {
      event: "case workbench entry sent",
      transcriptType: "outbound-final",
      textPreview: createTextPreview("案件工作台已开启"),
      len: 7,
    }, { replyToMessageId: message.messageId });
  }

  private scheduleMaterialCollectionStart(input: {
    chatId: string;
    chatType: string;
    openMessageId: string;
    conversationKey: string;
    actorOpenId: string;
  }): void {
    setTimeout(() => {
      void (async () => {
        const message = "劳动争议分析已进入材料收集阶段，请在新的收集卡片下继续上传材料。";
        try {
          await this.deps.transport.updatePayload(input.chatId, input.openMessageId, buildNoticeCardPayload({
            title: "案件工作台已进入材料收集",
            level: "info",
            message,
            showMessageIcon: false,
          }), {
            event: "case workbench entry acknowledged",
            transcriptType: "outbound-final",
            textPreview: createTextPreview(message),
            len: message.length,
          });
        } catch (error) {
          this.logCardUpdateFailure(error);
        } finally {
          await this.deps.labor.startCaseWorkbenchCollection({
            chatId: input.chatId,
            chatType: input.chatType,
            messageId: input.openMessageId,
            conversationKey: input.conversationKey,
            senderOpenId: input.actorOpenId,
          });
        }
      })();
    }, 0);
  }

  private async updateEntryCard(
    openMessageId: string,
    value: Record<string, unknown>,
    title: string,
    message: string,
    template: "green" | "grey",
  ): Promise<void> {
    const chatId = chatIdFromValue(value);
    if (!chatId) {
      return;
    }
    await this.deps.transport.updatePayload(chatId, openMessageId, buildNoticeCardPayload({
      title,
      level: template === "green" ? "info" : "neutral",
      message,
      showMessageIcon: false,
    }), {
      event: "case workbench entry updated",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(message),
      len: message.length,
    });
  }

  private logCardUpdateFailure(error: unknown): void {
    this.deps.logger.log("case-workbench/runtime", "case workbench entry card update failed", {
      detail: error instanceof Error ? error.message : String(error),
    }, "warn");
  }
}

function chatIdFromValue(value: Record<string, unknown>): string {
  return typeof value.chatId === "string" ? value.chatId : "";
}

function detectCaseWorkbenchIntent(text: string): CaseWorkbenchIntent {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized || /(不要|不用|先别|取消).{0,8}(工作台|分析|整理|生成)/.test(normalized)) {
    return null;
  }
  const hasLaborDomain = /(劳动|仲裁|工资|加班|工伤|社保|解除|辞退|离职|赔偿|补偿|用人单位|员工)/.test(normalized);
  const hasLaborWorkflowNoun = /(劳动分析|劳动争议工作台|劳动仲裁材料|劳动.{0,8}(材料|证据|工作台|证据链)|仲裁材料|证据链|工作台)/.test(normalized);
  const hasProductionAction = /(做|整理|梳理|生成|输出|形成|编写|起草|录入)/.test(normalized);
  if (hasLaborDomain && hasLaborWorkflowNoun && (hasProductionAction || /劳动分析|工作台|证据链/.test(normalized))) {
    return "labor";
  }
  const hasCaseWorkbench = /(案件工作台|办案工作台|新建案子|新建案件|打开工作台|进入工作台)/.test(normalized);
  if (hasCaseWorkbench) {
    return "workbench";
  }
  return null;
}

function extractCaseWorkbenchTitle(text: string): string | undefined {
  const normalized = text
    .replace(/[，。；、,.!?！？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 6 ? normalized.slice(0, 60) : undefined;
}

function buildCaseWorkbenchToast(content: string, type: "success" | "warning"): Record<string, unknown> {
  return {
    toast: {
      type,
      content,
    },
  };
}
