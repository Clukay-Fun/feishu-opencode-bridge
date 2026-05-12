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
import type { OpenCodeMessage, OpenCodePromptRequest } from "../opencode/client.js";
import type { IncomingChatMessage } from "../runtime/app.js";
import { extractAssistantText } from "../runtime/app-helpers.js";
import type { FeishuTransport } from "../runtime/feishu-transport.js";
import { createWorkbenchDocument, type WorkbenchDocumentResult } from "../workflows/workbench-generate.js";
import { renderCaseWorkbenchContextBlock, type CaseWorkbenchContextStore } from "./context-store.js";
import { readReferencedFeishuDocuments } from "./feishu-doc-reader.js";
import { readLocalCaseDocumentTemplates } from "./local-template-reader.js";

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
  contextStore?: CaseWorkbenchContextStore | undefined;
  docReader?: ((text: string, logger: Logger) => Promise<string[]>) | undefined;
  templateReader?: ((text: string, logger: Logger) => Promise<string[]>) | undefined;
  opencode?: CaseWorkbenchOpenCodePort | undefined;
  createDocument?: ((title: string, markdown: string) => Promise<WorkbenchDocumentResult>) | undefined;
};

type CaseWorkbenchOpenCodePort = {
  createSession(title: string): Promise<{ id: string }>;
  postMessageSync(sessionId: string, request: OpenCodePromptRequest): Promise<OpenCodeMessage>;
  deleteSession?: ((sessionId: string) => Promise<unknown>) | undefined;
};

export class CaseWorkbenchRuntimeModule implements RuntimeModule {
  readonly name = "case-workbench";
  readonly priority = 35;

  constructor(private readonly deps: CaseWorkbenchRuntimeModuleDeps) {}

  async start(): Promise<void> {
    await this.deps.contextStore?.restore();
  }

  async stop(): Promise<void> {
    await this.deps.contextStore?.stop();
  }

  async beforeTurn(context: { turn: { plainText: string; senderOpenId: string; conversationKey: string; chatId: string } }): Promise<{ systemBlocks?: string[] } | void> {
    const blocks: string[] = [];
    const docReader = this.deps.docReader ?? readReferencedFeishuDocuments;
    blocks.push(...await docReader(context.turn.plainText, this.deps.logger));

    if (shouldInjectCaseDocumentTemplate(context.turn.plainText)) {
      const templateReader = this.deps.templateReader ?? readLocalCaseDocumentTemplates;
      blocks.push(...await templateReader(context.turn.plainText, this.deps.logger));
    }

    if (this.deps.contextStore && shouldRecallCaseContext(context.turn.plainText)) {
      const current = this.deps.contextStore.findRecent({
        userId: context.turn.senderOpenId,
        conversationKey: context.turn.conversationKey,
        chatId: context.turn.chatId,
      });
      if (current) {
        blocks.push(renderCaseWorkbenchContextBlock(current));
      }
    }
    return blocks.length > 0 ? { systemBlocks: blocks } : undefined;
  }

  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    const { message, routed } = context;
    if (message.messageType !== "text" && message.messageType !== "post") {
      return { claimed: false };
    }

    if (routed?.kind === "command") {
      if (routed.command.kind !== "passthrough" || routed.command.name.trim().toLowerCase() !== "案件工作台") {
        return { claimed: false };
      }
      const title = routed.command.arguments
        .filter((argument) => argument.trim() !== "新建" && argument.trim().toLowerCase() !== "new")
        .join(" ")
        .trim() || undefined;
      await this.sendWorkbenchEntryCard(message, title);
      return { claimed: true };
    }

    if (shouldGenerateCaseCloudDocument(message.plainText)) {
      const handled = await this.tryGenerateCaseCloudDocument(message);
      if (handled) {
        return { claimed: true };
      }
    }

    return { claimed: false };
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
    const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined;
    if (!chatId || !conversationKey) {
      return buildCaseWorkbenchToast("入口卡片缺少上下文，请重新发送 /案件工作台。", "warning");
    }

    this.scheduleMaterialCollectionStart({
      chatId,
      chatType,
      openMessageId,
      conversationKey,
      actorOpenId,
      title,
    });
    return buildCaseWorkbenchToast("已进入材料收集。", "success");
  }

  private async sendWorkbenchEntryCard(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "senderOpenId">,
    title?: string | undefined,
  ): Promise<void> {
    const payload = buildCaseWorkbenchPayload({
      domains: ["劳动争议分析"],
      chatId: message.chatId,
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      requesterOpenId: message.senderOpenId,
      title,
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
    title?: string | undefined;
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
          const collectionMessage = {
            chatId: input.chatId,
            chatType: input.chatType,
            messageId: input.openMessageId,
            conversationKey: input.conversationKey,
            senderOpenId: input.actorOpenId,
          };
          if (input.title) {
            await this.deps.labor.startCaseWorkbenchCollection(collectionMessage, input.title);
          } else {
            await this.deps.labor.startCaseWorkbenchCollection(collectionMessage);
          }
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

  private async tryGenerateCaseCloudDocument(message: IncomingChatMessage): Promise<boolean> {
    if (!this.deps.contextStore || !this.deps.opencode) {
      return false;
    }
    const current = this.deps.contextStore.findRecent({
      userId: message.senderOpenId,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
    });
    if (!current) {
      return false;
    }

    const documentType = extractCaseDocumentType(message.plainText);
    const progressMessage = `正在基于当前案件工作台生成${documentType}，完成后会返回云文档链接。`;
    const progress = await this.deps.transport.sendPayload(message.chatId, buildNoticeCardPayload({
      title: "文书生成中",
      level: "info",
      message: progressMessage,
      showMessageIcon: false,
    }), {
      event: "case document generation started",
      transcriptType: "outbound-final",
      textPreview: createTextPreview(progressMessage),
      len: progressMessage.length,
    }, { replyToMessageId: message.messageId });

    try {
      const markdown = await this.generateCaseDocumentMarkdown(message, documentType);
      const title = `${current.title}｜${documentType}`;
      const createDocument = this.deps.createDocument ?? createWorkbenchDocument;
      const document = await createDocument(title, markdown);
      if (!document.docUrl) {
        throw new Error("云文档创建成功但未返回链接");
      }
      const response = [
        `${documentType}已生成： [打开云文档](${document.docUrl})`,
        "",
        "文书草稿基于当前案件工作台生成，提交前仍需人工复核事实、金额、证据原件和法律依据。",
      ].join("\n");
      await this.deps.transport.updatePayload(message.chatId, progress.messageId, buildNoticeCardPayload({
        title: `${documentType}已生成`,
        level: "info",
        message: response,
        showMessageIcon: false,
      }), {
        event: "case document generation completed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(`${documentType}已生成 ${document.docUrl}`),
        len: response.length,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deps.transport.updatePayload(message.chatId, progress.messageId, buildNoticeCardPayload({
        title: "文书生成失败",
        level: "error",
        message: detail,
        showMessageIcon: false,
      }), {
        event: "case document generation failed",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(detail),
        len: detail.length,
      }).catch((updateError) => {
        this.deps.logger.log("case-workbench/runtime", "case document failure card update failed", {
          detail: updateError instanceof Error ? updateError.message : String(updateError),
        }, "warn");
      });
    }
    return true;
  }

  private async generateCaseDocumentMarkdown(message: IncomingChatMessage, documentType: string): Promise<string> {
    const opencode = this.deps.opencode;
    if (!opencode || !this.deps.contextStore) {
      throw new Error("案件文书生成服务未就绪");
    }
    const current = this.deps.contextStore.findRecent({
      userId: message.senderOpenId,
      conversationKey: message.conversationKey,
      chatId: message.chatId,
    });
    if (!current) {
      throw new Error("未找到当前案件工作台结果");
    }

    const docReader = this.deps.docReader ?? readReferencedFeishuDocuments;
    const templateReader = this.deps.templateReader ?? readLocalCaseDocumentTemplates;
    const blocks = [
      renderCaseWorkbenchContextBlock(current),
      ...await docReader(message.plainText, this.deps.logger),
      ...await templateReader(message.plainText, this.deps.logger),
    ];
    const session = await opencode.createSession("[bridge] case-document-draft");
    try {
      const response = await opencode.postMessageSync(session.id, {
        system: blocks.join("\n\n"),
        parts: [{
          type: "text",
          text: buildCaseDocumentDraftPrompt(message.plainText, documentType),
        }],
      });
      const markdown = extractAssistantText(response);
      if (!markdown.trim()) {
        throw new Error("模型未返回可写入云文档的文书内容");
      }
      return markdown.trim();
    } finally {
      await opencode.deleteSession?.(session.id).catch((error) => {
        this.deps.logger.log("case-workbench/runtime", "delete case document draft session failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
    }
  }
}

function chatIdFromValue(value: Record<string, unknown>): string {
  return typeof value.chatId === "string" ? value.chatId : "";
}

function shouldRecallCaseContext(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const refersCurrentCase = /(当前|这个|该|刚才|上面|前面).{0,12}(案件|案子|工作台|分析结果|材料|证据)/.test(normalized)
    || /(案件分析结果|工作台结果|劳动分析结果)/.test(normalized);
  const asksCaseOutput = /(仲裁申请书|起诉状|证据目录|证据清单|代理意见|答辩状|质证意见|文书|补证|诉请|请求事项)/.test(normalized);
  return refersCurrentCase || asksCaseOutput;
}

function shouldInjectCaseDocumentTemplate(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").trim();
  return /(生成|起草|拟|制作|输出|按照|根据).{0,20}(仲裁申请书|起诉状|证据目录|证据清单|代理意见|答辩状|质证意见|文书)/
    .test(normalized);
}

function shouldGenerateCaseCloudDocument(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").trim();
  if (!normalized) {
    return false;
  }
  const asksDocument = /(仲裁申请书|起诉状|证据目录|证据清单|代理意见|答辩状|质证意见|文书)/.test(normalized);
  const asksGenerate = /(生成|起草|拟|制作|输出|写成|写一份|整理成)/.test(normalized);
  const refersCurrent = /(根据|基于|按照).{0,12}(当前|这个|该|刚才|上面|前面).{0,12}(文档|云文档|案件|工作台|分析结果|材料|证据)/
    .test(normalized)
    || /(当前|这个|该|刚才|上面|前面).{0,12}(文档|云文档|案件|工作台|分析结果|材料|证据).{0,12}(生成|起草|拟|制作|输出|写成|写一份|整理成)/
      .test(normalized);
  return asksDocument && asksGenerate && refersCurrent;
}

function extractCaseDocumentType(text: string): string {
  const match = text.match(/仲裁申请书|起诉状|证据目录|证据清单|代理意见|答辩状|质证意见|文书/);
  return match?.[0] ?? "案件文书";
}

function buildCaseDocumentDraftPrompt(userText: string, documentType: string): string {
  return [
    `请根据系统上下文中的当前案件工作台、材料摘要、证据链和可用模板，生成《${documentType}》。`,
    "",
    "用户原始要求：",
    userText,
    "",
    "输出要求：",
    "1. 只输出可直接写入飞书云文档的 Markdown 正文，不要输出解释、寒暄或代码块。",
    "2. 文书结构要正式、完整，优先套用上下文中的本地模板或用户引用模板。",
    "3. 已有案件事实、当事人信息、请求事项、证据和法律依据必须来自上下文；不确定字段用“待补充”或空线保留，不要编造。",
    "4. 涉及金额、日期、身份信息、地址、联系电话、案号、法院/仲裁委等关键字段，缺失时要明确标注待补充。",
    "5. 末尾加入简短复核提示：提交前需复核事实、金额、证据原件和法律依据。",
  ].join("\n");
}

function buildCaseWorkbenchToast(content: string, type: "success" | "warning"): Record<string, unknown> {
  return {
    toast: {
      type,
      content,
    },
  };
}
