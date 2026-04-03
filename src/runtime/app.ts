import crypto from "node:crypto";

import { QueueRegistry } from "../bridge/queue.js";
import { routeIncomingText } from "../bridge/router.js";
import { transitionTurn } from "../bridge/state-machine.js";
import { TurnWatchdog } from "../bridge/watchdog.js";
import type { BridgeTurn } from "../bridge/turn.js";
import {
  buildPostMarkdownPayload,
  buildQueueNoticePayload,
  buildTurnStatusCardPayload,
  type FeishuPostPayload,
  type OutputView,
  type ToolUpdateView,
  type TurnStatusCardView,
} from "../feishu/formatter.js";
import { createTextPreview, type Logger, type TranscriptType } from "../logging/logger.js";
import { OpenCodeClient, type QuestionRequest } from "../opencode/client.js";
import { OpenCodeEventStream, getEventSessionId, type OpenCodeEvent } from "../opencode/events.js";
import { MappingStore, type MappingRecord } from "../store/mappings.js";
import type { AppConfig } from "../config/schema.js";
import { cleanAssistantReply } from "./sanitize.js";

export type IncomingChatMessage = {
  chatId: string;
  senderOpenId: string;
  messageId: string;
  text: string;
};

type OutboundPort = {
  sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
  updateMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }>;
};

type TurnCardState = {
  messageId: string;
  status: string;
  sessionId: string;
  startedAt: number;
  progressUpdates: string[];
  toolUpdates: Array<{ key: string; view: ToolUpdateView }>;
  output: OutputView;
};

const initialCardSummary = "已创建会话，等待 OpenCode 事件...";

export class BridgeApp {
  private readonly queues: QueueRegistry;
  private readonly mappings: MappingStore;
  private readonly opencode: OpenCodeClient;
  private readonly eventStream: OpenCodeEventStream;
  private sessionMap: MappingRecord = {};
  private readonly runningChats = new Map<string, Promise<void>>();
  private readonly pendingQuestions = new Map<string, QuestionRequest>();
  private readonly turnCards = new Map<string, TurnCardState>();

  constructor(private readonly config: AppConfig, private readonly outbound: OutboundPort, private readonly logger: Logger) {
    this.queues = new QueueRegistry(config.bridge.queueLimit, logger);
    this.mappings = new MappingStore(config.storage.dataDir, config.storage.mappingsFile);
    this.opencode = new OpenCodeClient(config.opencode.baseUrl, config.opencode.directory);
    this.eventStream = new OpenCodeEventStream(config.opencode.baseUrl, config.opencode.directory, logger);
  }

  async start(): Promise<void> {
    this.sessionMap = await this.mappings.load();
    await this.eventStream.start();
    this.logger.log("bridge/app", "bridge started", {
      queueLimit: this.config.bridge.queueLimit,
      opencodeBaseUrl: this.config.opencode.baseUrl.toString(),
    });
  }

  async stop(): Promise<void> {
    await this.eventStream.stop();
  }

  async handleIncomingMessage(message: IncomingChatMessage): Promise<void> {
    if (this.config.feishu.allowedOpenIds.size > 0 && !this.config.feishu.allowedOpenIds.has(message.senderOpenId)) {
      await this.sendPayload(message.chatId, buildPostMarkdownPayload("当前账号未加入白名单。"), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "当前账号未加入白名单。",
        len: 11,
      });
      return;
    }

    this.logger.logTranscript("inbound", {
      chatId: message.chatId,
      senderId: message.senderOpenId,
      messageId: message.messageId,
    }, message.text);

    const routed = routeIncomingText(message.text);
    if (routed.kind === "command") {
      await this.handleCommand(message.chatId, routed.command.kind);
      return;
    }

    const pendingQuestion = this.pendingQuestions.get(message.chatId);
    if (pendingQuestion) {
      await this.handleQuestionReply(message.chatId, pendingQuestion, message.text);
      return;
    }

    const queue = this.queues.get(message.chatId);
    const turn: BridgeTurn = {
      turnId: crypto.randomUUID(),
      chatId: message.chatId,
      senderOpenId: message.senderOpenId,
      inboundMessageId: message.messageId,
      text: message.text,
    };
    const existingSession = this.sessionMap[message.chatId];
    if (existingSession) {
      turn.sessionId = existingSession;
    }
    const result = queue.enqueue(turn);
    if (!result.accepted) {
      await this.sendPayload(message.chatId, buildQueueNoticePayload(result.notice ?? { message: "当前不可用。" }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: result.notice?.message ?? "当前不可用。",
        len: (result.notice?.message ?? "当前不可用。").length,
      });
      return;
    }

    if (result.notice) {
      await this.sendPayload(message.chatId, buildQueueNoticePayload(result.notice), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: createTextPreview(result.notice.message),
        len: result.notice.message.length,
      });
      return;
    }

    if (!this.runningChats.has(message.chatId)) {
      const runner = this.processChat(message.chatId).finally(() => {
        this.runningChats.delete(message.chatId);
      });
      this.runningChats.set(message.chatId, runner);
      await runner;
    }
  }

  private async processChat(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    while (queue.current()) {
      await this.runTurn(chatId);
      queue.finishActive();
    }
  }

  private async runTurn(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    const active = queue.current();
    if (!active) return;
    let turn = transitionTurn(active, "running");
    queue.replaceActive(turn);

    try {
      const sessionId = turn.sessionId ?? await this.ensureSession(chatId);
      turn = { ...turn, sessionId };
      queue.replaceActive(turn);
      this.logger.log("bridge/queue", "turn started", { turnId: turn.turnId, sessionId, chatId });
      const card = await this.createTurnCard(chatId, turn.turnId, sessionId);
      if (card) {
        queue.replaceActive({ ...turn, processMessageId: card.messageId });
      }

      const reply = cleanAssistantReply(await this.executeTurn(chatId, turn as BridgeTurn & { sessionId: string }));
      this.logger.log("opencode/events", "reply completed", { turnId: turn.turnId, sessionId, len: reply.length });
      this.logger.logTranscript("opencode-reply", { sessionId, turnId: turn.turnId }, reply);
      await this.updateTurnCard(turn.turnId, { status: "已完成", update: `最终回复已生成（${reply.length} 字）`, target: "step" });
      await this.updateTurnCard(turn.turnId, { update: reply, sanitize: false, target: "final" });
      queue.replaceActive(transitionTurn({ ...turn, sessionId }, "done"));
      this.logger.log("bridge/queue", "turn completed", { turnId: turn.turnId, duration: Date.now() - (turn.startedAt ?? Date.now()) });
    } catch (error) {
      const detail = cleanAssistantReply(error instanceof Error ? error.message : String(error));
      this.logger.log("bridge/queue", "run turn failed", { chatId, turnId: turn.turnId, detail }, "error");
      await this.updateTurnCard(turn.turnId, { status: detail.includes("超时") ? "已超时" : "处理失败", update: detail, target: "step" });
      queue.replaceActive(transitionTurn(turn, detail.includes("超时") ? "timeout" : "aborted"));
    } finally {
      this.turnCards.delete(turn.turnId);
    }
  }

  private async ensureSession(chatId: string): Promise<string> {
    const existing = this.sessionMap[chatId];
    if (existing) return existing;
    const session = await this.opencode.createSession(`Feishu ${chatId}`);
    this.sessionMap[chatId] = session.id;
    await this.mappings.save(this.sessionMap);
    return session.id;
  }

  private async executeTurn(chatId: string, turn: BridgeTurn & { sessionId: string }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let assistantMessageId: string | null = null;
      let finalText = "";
      let settled = false;
      let baselineAssistantId: string | null = null;
      const ignoredTextPartIds = new Set<string>();
      const unsubscribe = this.eventStream.subscribe(async (event) => {
        if (getEventSessionId(event) !== turn.sessionId) return;
        try {
          await this.handleEvent(chatId, turn, event, {
            getAssistantMessageId: () => assistantMessageId,
            setAssistantMessageId: (value) => { assistantMessageId = value; },
            ignoredTextPartIds,
            appendFinalText: (delta) => { finalText += delta; },
            setFinalText: (value) => { finalText = value; },
            baselineAssistantId,
            setBaselineAssistantId: (value) => { baselineAssistantId = value; },
            finish: (text) => {
              if (settled) return;
              settled = true;
              unsubscribe();
              watchdog.clear();
              resolve(text);
            },
            fail: (error) => {
              if (settled) return;
              settled = true;
              unsubscribe();
              watchdog.clear();
              reject(error);
            },
            getFinalText: () => finalText,
          });
          watchdog.markEvent();
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.log("opencode/events", "event listener failed", { chatId, sessionId: turn.sessionId, detail, type: event.type }, "warn");
        }
      });

      const watchdog = new TurnWatchdog(
        {
          firstEventTimeoutMs: this.config.bridge.firstEventTimeoutMs,
          eventGapTimeoutMs: this.config.bridge.eventGapTimeoutMs,
          totalTimeoutMs: this.config.bridge.totalTimeoutMs,
        },
        {
          onFirstEventTimeout: () => reject(new Error("处理超时，请重试或 /new 开新会话")),
          onEventGapTimeout: () => reject(new Error("处理超时，请重试或 /new 开新会话")),
          onTotalTimeout: () => reject(new Error("处理超时，请重试或 /new 开新会话")),
        },
      );
      watchdog.start();
      void this.opencode.latestAssistantReply(turn.sessionId)
        .then((reply) => {
          baselineAssistantId = reply?.id ?? null;
          return this.opencode.postMessage(turn.sessionId, turn.text);
        })
        .catch(reject);
    });
  }

  private async handleEvent(
    chatId: string,
    turn: BridgeTurn & { sessionId: string },
    event: OpenCodeEvent,
    context: {
      getAssistantMessageId: () => string | null;
      setAssistantMessageId: (value: string | null) => void;
      ignoredTextPartIds: Set<string>;
      appendFinalText: (delta: string) => void;
      setFinalText: (value: string) => void;
      baselineAssistantId: string | null;
      setBaselineAssistantId: (value: string | null) => void;
      finish: (text: string) => void;
      fail: (error: Error) => void;
      getFinalText: () => string;
    },
  ): Promise<void> {
    if (event.type === "message.updated") {
      const info = readOptionalRecord(event.properties, "info");
      if (info && readOptionalString(info, "role") === "assistant") {
        context.setAssistantMessageId(readOptionalString(info, "id") ?? context.getAssistantMessageId());
      }
      return;
    }

    if (event.type === "message.part.delta") {
      const partId = readOptionalString(event.properties, "partID");
      const messageId = readOptionalString(event.properties, "messageID");
      if (context.getAssistantMessageId() && messageId && messageId !== context.getAssistantMessageId()) return;
      if (partId && context.ignoredTextPartIds.has(partId)) return;
      if (readOptionalString(event.properties, "field") === "text") {
        context.appendFinalText(readOptionalString(event.properties, "delta") ?? "");
      }
      return;
    }

    if (event.type === "message.part.updated") {
      const part = readOptionalRecord(event.properties, "part");
      if (!part) return;
      const messageId = readOptionalString(part, "messageID");
      if (context.getAssistantMessageId() && messageId && messageId !== context.getAssistantMessageId()) return;
      const partType = readOptionalString(part, "type");
      const partId = readOptionalString(part, "id");
      if (partType === "text") {
        if (readOptionalBoolean(part, "synthetic") || readOptionalBoolean(part, "ignored")) {
          if (partId) context.ignoredTextPartIds.add(partId);
          return;
        }
        const text = readOptionalString(part, "text");
        if (text) context.setFinalText(text);
        return;
      }
      if (partType === "reasoning") {
        const text = readOptionalString(part, "text") ?? "";
        if (partId) {
          this.logger.log("opencode/events", "reasoning received", { turnId: turn.turnId, sessionId: turn.sessionId, len: text.length });
          this.logger.logTranscript("reasoning-raw", { turnId: turn.turnId, sessionId: turn.sessionId, partId, len: text.length }, text);
          const step = summarizeReasoningToProgress(text);
          if (step) {
            await this.updateTurnCard(turn.turnId, { status: "处理中", update: step, sanitize: false, target: "step" });
          }
        }
        return;
      }
      if (partType === "tool") {
        const state = readOptionalRecord(part, "state");
        const status = state ? readOptionalString(state, "status") : undefined;
        const toolName = readOptionalString(part, "tool") ?? "tool";
        const title = state ? readOptionalString(state, "title") : undefined;
        await this.updateTurnCard(turn.turnId, {
          status: "处理中",
          update: formatToolRecord(toolName, status, title),
          target: "tool",
          ...(partId ? { toolKey: partId } : {}),
        });
      }
      return;
    }

    if (event.type === "permission.asked") {
      const requestId = readOptionalString(event.properties, "id");
      const permissionName = readOptionalString(event.properties, "permission") ?? "unknown";
      await this.updateTurnCard(turn.turnId, { status: "处理中", update: `请求权限：${permissionName}`, target: "step" });
      if (requestId) {
        await this.opencode.replyPermission(requestId, "once");
      }
      return;
    }

    if (event.type === "question.asked") {
      const request = toQuestionRequest(event.properties, turn.sessionId);
      if (!request) return;
      this.pendingQuestions.set(chatId, request);
      await this.updateTurnCard(turn.turnId, { status: "等待回答", update: formatQuestionPrompt(request), target: "step" });
      return;
    }

    if (event.type === "session.idle") {
      const text = context.getFinalText().trim() || await this.opencode.latestAssistantTextSince(turn.sessionId, context.baselineAssistantId);
      if (!text) {
        context.fail(new Error("OpenCode 未返回文本回复。"));
        return;
      }
      context.finish(text);
    }
  }

  private async handleCommand(chatId: string, kind: "new" | "status" | "abort"): Promise<void> {
    if (kind === "new") {
      delete this.sessionMap[chatId];
      await this.mappings.save(this.sessionMap);
      await this.sendPayload(chatId, buildPostMarkdownPayload("已清空当前会话，下一条消息会创建新会话。"), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已清空当前会话，下一条消息会创建新会话。",
        len: 19,
      });
      return;
    }

    if (kind === "status") {
      const queue = this.queues.get(chatId);
      const active = queue.current();
      const message = active ? `当前处理中：${createTextPreview(active.text)}` : "当前没有进行中的任务。";
      await this.sendPayload(chatId, buildPostMarkdownPayload(message), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: message,
        len: message.length,
      });
      return;
    }

    const sessionId = this.sessionMap[chatId];
    if (sessionId) {
      await this.opencode.abort(sessionId);
    }
    await this.sendPayload(chatId, buildPostMarkdownPayload("已请求中止当前任务。"), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: "已请求中止当前任务。",
      len: 10,
    });
  }

  private async handleQuestionReply(chatId: string, request: QuestionRequest, text: string): Promise<void> {
    try {
      await this.opencode.replyQuestion(request.id, [text]);
      this.pendingQuestions.delete(chatId);
      const currentTurnId = this.queues.get(chatId).current()?.turnId;
      if (currentTurnId) {
        await this.updateTurnCard(currentTurnId, { status: "处理中", update: "已收到你的回答，继续处理中...", target: "step" });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.sendPayload(chatId, buildPostMarkdownPayload(`回答问题失败：${escapeMarkdownText(detail)}`), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: detail,
        len: detail.length,
      });
    }
  }

  private async createTurnCard(chatId: string, turnId: string, sessionId: string): Promise<TurnCardState | null> {
    const state: TurnCardState = {
      messageId: "",
      status: "处理中",
      sessionId,
      startedAt: Date.now(),
      progressUpdates: [initialCardSummary],
      toolUpdates: [],
      output: { text: "", paths: [], commands: [] },
    };
    try {
      const payload = buildTurnStatusCardPayload(this.toTurnCardView(state));
      const result = await this.sendPayload(chatId, payload, {
        event: "process message sent",
        transcriptType: "outbound-process",
        textPreview: initialCardSummary,
        len: initialCardSummary.length,
      });
      state.messageId = result.messageId;
      this.turnCards.set(turnId, state);
      return state;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("feishu/reply", "process card send failed", { chatId, turnId, detail }, "warn");
      return null;
    }
  }

  private async updateTurnCard(turnId: string, update: { status?: string; update?: string; sanitize?: boolean; target?: "step" | "tool" | "final"; toolKey?: string }): Promise<void> {
    const card = this.turnCards.get(turnId);
    if (!card) return;
    if (update.status) card.status = update.status;
    const nextUpdate = update.update ? (update.sanitize === false ? update.update.trim() : cleanAssistantReply(update.update)) : "";
    if (nextUpdate) {
      if (update.target === "tool") {
        const toolKey = update.toolKey ?? nextUpdate;
        card.toolUpdates = upsertToolUpdate(card.toolUpdates, toolKey, parseToolUpdate(nextUpdate));
      } else if (update.target === "final") {
        card.output = parseOutput(nextUpdate);
      } else {
        card.progressUpdates = appendProgressUpdate(card.progressUpdates, nextUpdate);
      }
    }
    try {
      const payload = buildTurnStatusCardPayload(this.toTurnCardView(card));
      const result = await this.outbound.updateMessage(card.messageId, payload);
      this.logger.log("feishu/reply", "process message updated", {
        messageId: result.messageId,
        turnId,
        textPreview: createTextPreview([...card.progressUpdates, ...card.toolUpdates.map((item) => item.view.label)].join(" | ")),
        len: [...card.progressUpdates, ...card.toolUpdates.map((item) => item.view.label)].join("\n").length,
      });
      this.logger.logTranscript("outbound-process", { messageId: result.messageId }, prettyPrintPayload(payload));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("feishu/reply", "process card update failed", { messageId: card.messageId, turnId, detail }, "warn");
    }
  }

  private toTurnCardView(card: TurnCardState): TurnStatusCardView {
    return {
      title: card.status.includes("完成") ? "已完成" : card.status.includes("失败") || card.status.includes("超时") ? "处理异常" : "处理中",
      status: card.status,
      sessionId: card.sessionId,
      durationText: isFinalStatus(card.status) ? formatDuration(Date.now() - card.startedAt) : "",
      progressUpdates: card.progressUpdates,
      toolUpdates: card.toolUpdates.map((item) => item.view),
      output: card.output,
    };
  }

  private async sendPayload(chatId: string, payload: FeishuPostPayload, options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number }): Promise<{ messageId: string }> {
    const result = await this.outbound.sendMessage(chatId, payload);
    this.logger.log("feishu/reply", options.event, { chatId, messageId: result.messageId, textPreview: options.textPreview, len: options.len });
    this.logger.logTranscript(options.transcriptType, { chatId, messageId: result.messageId }, prettyPrintPayload(payload));
    return result;
  }
}

function toQuestionRequest(properties: Record<string, unknown>, sessionId: string): QuestionRequest | null {
  const requestId = readOptionalString(properties, "id");
  const rawQuestions = properties.questions;
  if (!requestId || !Array.isArray(rawQuestions)) return null;
  const questions = rawQuestions
    .map((value) => {
      if (!isRecord(value)) return null;
      const header = readOptionalString(value, "header") ?? "问题";
      const question = readOptionalString(value, "question") ?? header;
      return { header, question };
    })
    .filter((value): value is { header: string; question: string } => value !== null);
  if (questions.length === 0) return null;
  return { id: requestId, sessionId, questions };
}

function formatQuestionPrompt(request: QuestionRequest): string {
  return ["❓ OpenCode 需要你回答：", ...request.questions.map((question, index) => `${index + 1}. ${escapeMarkdownText(question.header)}\n${escapeMarkdownText(question.question)}`)].join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function prettyPrintPayload(payload: FeishuPostPayload): string {
  return JSON.stringify({ msg_type: payload.msg_type, content: JSON.parse(payload.content) }, null, 2);
}

function escapeMarkdownText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mapToolStatus(status: string | undefined): string {
  switch (status) {
    case "pending": return "等待中";
    case "running": return "执行中";
    case "completed": return "已完成";
    case "error": return "失败";
    default: return status ?? "未知状态";
  }
}

function summarizeReasoningToProgress(text: string): string {
  const normalized = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
  if (!normalized) return "";
  if (/considering user response/i.test(normalized)) return "";
  if (/news|headline|search/i.test(normalized)) return "正在检索相关信息";
  if (/project|package\.json|file/i.test(normalized)) return "正在整理上下文信息";
  return "正在处理中";
}

function formatToolRecord(toolName: string, status: string | undefined, title: string | undefined): string {
  const statusLabel = mapToolStatus(status);
  const detail = formatToolTarget(title) || "-";
  switch (toolName) {
    case "webfetch": return `抓取网页：${detail}（${statusLabel}）`;
    case "read": return `读取文件：${detail}（${statusLabel}）`;
    case "glob": return `查找路径：${detail}（${statusLabel}）`;
    case "apply_patch": return `工具 apply_patch：${detail}（${statusLabel}）`;
    case "bash": return `执行命令：${detail}（${statusLabel}）`;
    default: return `工具 ${toolName}：${detail}（${statusLabel}）`;
  }
}

function formatToolTarget(title: string | undefined): string {
  if (!title) return "";
  const cleaned = title.replace(/\(text\/html.*$/i, "").replace(/Success\. Updated the following files:\s*/i, "Success. Updated the following files: ").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function formatDuration(ms: number): string {
  return `约 ${Math.max(1, Math.round(ms / 1000))}s`;
}

function isFinalStatus(status: string): boolean {
  return status.includes("完成") || status.includes("失败") || status.includes("超时") || status.includes("中止");
}

function upsertToolUpdate(updates: Array<{ key: string; view: ToolUpdateView }>, key: string, view: ToolUpdateView): Array<{ key: string; view: ToolUpdateView }> {
  const existingIndex = updates.findIndex((item) => item.key === key);
  if (existingIndex === -1) return [...updates, { key, view }].slice(-8);
  return updates.map((item, index) => (index === existingIndex ? { key, view } : item));
}

function parseToolUpdate(text: string): ToolUpdateView {
  const match = text.match(/^(.*?)[：:](.*?)[（(]([^）)]+)[）)]$/);
  if (!match) return { label: text, detail: "", status: "unknown" };
  const [, label, detail, statusLabel] = match;
  return { label: (label ?? text).trim(), detail: (detail ?? "").trim(), status: parseToolStatus((statusLabel ?? "").trim()) };
}

function parseToolStatus(statusLabel: string): ToolUpdateView["status"] {
  switch (statusLabel) {
    case "等待中": return "pending";
    case "执行中": return "running";
    case "已完成": return "completed";
    case "失败": return "error";
    default: return "unknown";
  }
}

function parseOutput(finalReply: string): OutputView {
  const paths = extractPaths(finalReply);
  const commands = extractCommands(finalReply);
  const text = stripStructuredLines(finalReply, paths, commands);
  return { text, paths, commands };
}

function extractPaths(text: string): string[] {
  return dedupe((text.match(/[A-Za-z]:\\[^\n`]+/g) ?? []).map((item) => item.trim()));
}

function extractCommands(text: string): string[] {
  const commandMatches = Array.from(text.matchAll(/`([^`]+)`/g), (match) => match[1] ?? "");
  return dedupe(commandMatches.map((item) => item.trim()).filter((item) => /^(npm|pnpm|yarn|node|python|python3|git|bash|powershell|pwsh|cmd|npx)\b/i.test(item)));
}

function stripStructuredLines(text: string, paths: string[], commands: string[]): string {
  let result = text;
  for (const path of paths) result = result.replace(path, "");
  for (const command of commands) result = result.replace(`\`${command}\``, "");
  return result.split("\n").map((line) => line.trimEnd()).filter((line, index, lines) => line.trim() !== "" || (index > 0 && lines[index - 1]?.trim() !== "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function appendProgressUpdate(updates: string[], nextUpdate: string): string[] {
  if (!nextUpdate || updates.includes(nextUpdate)) return updates;
  return [...updates, nextUpdate].slice(-6);
}
