import type { PendingQuestionInteraction } from "../bridge/state.js";
import type { BridgeTurn } from "../bridge/turn.js";
import type { FeishuPostPayload, ModelListCardView, OutputView, ToolUpdateView } from "../feishu/formatter.js";
import type { OpenCodeMessage, OpenCodeProvidersResponse, OpenCodeSession } from "../opencode/client.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import type { IncomingChatMessage, PermissionCardActionValue } from "./app.js";
import { getVisibleSessions } from "./session-windows.js";

export function buildPromptRequest(text: string, system?: string): { system?: string; parts: Array<{ type: "text"; text: string }> } {
  return system
    ? {
      system,
      parts: [{ type: "text", text }],
    }
    : {
      parts: [{ type: "text", text }],
    };
}

export function composeSystemPrompt(...sections: Array<string | undefined>): string | undefined {
  const normalized = sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section));
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.join("\n\n");
}

export function toOpencodePromptText(message: Pick<IncomingChatMessage, "chatType" | "senderOpenId" | "plainText">): string {
  if (message.chatType === "p2p") {
    return message.plainText;
  }

  return `[群聊消息][发送者 ${message.senderOpenId}]\n${message.plainText}`;
}

export function buildSessionTitle(chatId: string, chatType: string | undefined, threadKey?: string): string {
  if (chatType === "p2p" || !chatType) {
    return `Feishu ${chatId}`;
  }

  return threadKey ? `Feishu ${chatType} ${chatId} ${threadKey}` : `Feishu ${chatType} ${chatId}`;
}

export function isPermissionCardActionValue(value: Record<string, unknown>): value is PermissionCardActionValue {
  return value.kind === "permission"
    && typeof value.conversationKey === "string"
    && typeof value.turnId === "string"
    && typeof value.sessionId === "string"
    && typeof value.permissionId === "string"
    && (value.policy === "once" || value.policy === "always" || value.policy === "deny")
    && typeof value.nonce === "string";
}

export function toQuestionRequest(properties: Record<string, unknown>, sessionId: string): { id: string; sessionId: string; questions: Array<{ header: string; question: string }> } | null {
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

export function formatQuestionPrompt(questions: PendingQuestionInteraction["questions"]): string {
  return ["OpenCode 需要你回答：", ...questions.map((question, index) => `${index + 1}. ${escapeMarkdownText(question.header)}\n${escapeMarkdownText(question.question)}`)].join("\n\n");
}

export function buildModelCardView(
  providers: OpenCodeProvidersResponse,
  requestedProvider?: string,
): ModelListCardView | null {
  const normalizedFilter = requestedProvider?.trim().toLowerCase();
  const providerViews = providers.providers
    .map((provider) => toProviderCardView(provider, providers.default, !normalizedFilter))
    .filter((provider): provider is NonNullable<typeof provider> => provider !== null)
    .filter((provider) => !normalizedFilter
      || provider.id.toLowerCase() === normalizedFilter
      || provider.name.toLowerCase() === normalizedFilter);

  if (providerViews.length === 0) {
    return null;
  }

  return {
    providers: providerViews,
    footer: normalizedFilter
      ? "发送 `/model use <provider/model>` 切换当前窗口模型\n发送 `/model reset` 恢复默认模型"
      : "发送 `/model <provider>` 查看更多\n发送 `/model use <provider/model>` 切换当前窗口模型",
  };
}

export function toProviderCardView(
  provider: Record<string, unknown>,
  defaults: Record<string, string>,
  compact: boolean,
): { id: string; name: string; models: Array<{ id: string; current?: boolean; default?: boolean }> } | null {
  const id = typeof provider.id === "string"
    ? provider.id
    : typeof provider.providerID === "string"
      ? provider.providerID
      : null;
  if (!id) {
    return null;
  }

  const name = typeof provider.name === "string" ? provider.name : id;
  const rawModels = isRecord(provider.models) ? provider.models : {};
  const defaultModel = defaults[id];
  const allModels = Object.values(rawModels)
    .map((value) => toProviderModelView(value, defaultModel))
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => {
      const leftScore = (left.current ? 100 : 0) + (left.default ? 50 : 0);
      const rightScore = (right.current ? 100 : 0) + (right.default ? 50 : 0);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "");
    });

  const models = (compact ? allModels.slice(0, 5) : allModels).map((model) => ({
    id: `${id}/${model.id}`,
    current: model.current,
    default: model.default,
  }));

  return { id, name, models };
}

export function toProviderModelView(
  value: unknown,
  defaultModel: string | undefined,
): { id: string; current: boolean; default: boolean; releaseDate?: string } | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id : null;
  if (!id) {
    return null;
  }

  return {
    id,
    current: false,
    default: defaultModel === id,
    ...(typeof value.release_date === "string" ? { releaseDate: value.release_date } : {}),
  };
}

export function buildBridgeSystemPrompt(
  turn: Pick<BridgeTurn, "chatType" | "conversationKey" | "senderOpenId" | "sessionId">,
  window: SessionWindowRecord,
): string {
  const visibleSessions = getVisibleSessions(window);
  const lines = [
    "[Bridge State]",
    `windowType: ${turn.chatType ?? "p2p"}`,
    `conversationKey: ${turn.conversationKey}`,
    `sessionMode: ${window.mode}`,
    `activeSessionId: ${window.activeSessionId ?? "none"}`,
    "visibleSessions:",
    ...(visibleSessions.length > 0
      ? visibleSessions.map((session) => `- ${session.sessionId === turn.sessionId ? "*" : " "} ${session.label} (${session.sessionId})`)
      : ["- none"]),
    `senderOpenId: ${turn.senderOpenId}`,
    "rules:",
    "- Bridge owns /new /sessions /switch /status and all runtime progress or reply messages.",
    "- Do not pretend to switch, create, close, or rename bridge sessions yourself.",
    "- Use lark-cli only when the user explicitly asks to operate on Feishu or Lark resources.",
  ];
  return lines.join("\n");
}

export function resolveDisplayLabel(session: OpenCodeSession | undefined, currentLabel: string, sessionId: string): string {
  if (!shouldHydrateLabelFromSessionMeta(currentLabel, sessionId)) {
    return currentLabel;
  }

  return session?.title?.trim() || session?.slug?.trim() || currentLabel || sessionId;
}

export function shouldHydrateLabelFromSessionMeta(currentLabel: string, sessionId: string): boolean {
  return currentLabel === sessionId;
}

export function summarizeSessionLabel(plainText: string): string {
  const normalized = plainText.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 20);
}

export function extractAssistantText(message: OpenCodeMessage | null): string {
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function isCompletedMessage(message: OpenCodeMessage): boolean {
  const time = isRecord(message.info.time) ? message.info.time : null;
  return typeof message.info.finish === "string" || typeof time?.completed === "number";
}

export function isAssistantMessageAfterBaseline(
  message: OpenCodeMessage,
  options?: {
    afterAssistantId?: string | null;
    afterTimestamp?: number | null;
  },
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }

  if (options?.afterAssistantId && message.info.id === options.afterAssistantId) {
    return false;
  }

  const baselineTimestamp = options?.afterTimestamp ?? null;
  const messageTimestamp = getMessageTimestamp(message);
  if (baselineTimestamp !== null && messageTimestamp !== null && messageTimestamp <= baselineTimestamp) {
    return false;
  }

  return true;
}

export function getMessageTimestamp(message: OpenCodeMessage | null): number | null {
  if (!message || !isRecord(message.info.time)) {
    return null;
  }

  const time = message.info.time;
  const candidates = [time.updated, time.completed, time.created];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readOptionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

export function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

export function prettyPrintPayload(payload: FeishuPostPayload): string {
  return JSON.stringify({ msg_type: payload.msg_type, content: JSON.parse(payload.content) }, null, 2);
}

export function escapeMarkdownText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mapToolStatus(status: string | undefined): string {
  switch (status) {
    case "pending": return "等待中";
    case "running": return "执行中";
    case "completed": return "已完成";
    case "error": return "失败";
    default: return status ?? "未知状态";
  }
}

export function summarizeReasoningToProgress(text: string): string {
  const normalized = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
  if (!normalized) return "";
  if (/considering user response/i.test(normalized)) return "";
  if (/news|headline|search/i.test(normalized)) return "正在检索相关信息";
  if (/project|package\.json|file/i.test(normalized)) return "正在整理上下文信息";
  return "正在处理中";
}

export function formatToolRecord(toolName: string, status: string | undefined, title: string | undefined): string {
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

export function formatToolTarget(title: string | undefined): string {
  if (!title) return "";
  const cleaned = title.replace(/\(text\/html.*$/i, "").replace(/Success\. Updated the following files:\s*/i, "Success. Updated the following files: ").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

export function formatDuration(ms: number): string {
  return `约 ${Math.max(1, Math.round(ms / 1000))}s`;
}

export function formatSessionTimestamp(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "--";
  }

  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

export function findSessionMeta(window: SessionWindowRecord, sessionId: string): SessionBindingRecord | null {
  return window.sessions.find((session) => session.sessionId === sessionId) ?? null;
}

export function isFinalStatus(status: string): boolean {
  return status.includes("完成") || status.includes("失败") || status.includes("超时") || status.includes("中止");
}

export function upsertToolUpdate(updates: Array<{ key: string; view: ToolUpdateView }>, key: string, view: ToolUpdateView): Array<{ key: string; view: ToolUpdateView }> {
  const existingIndex = updates.findIndex((item) => item.key === key);
  if (existingIndex === -1) return [...updates, { key, view }].slice(-8);
  return updates.map((item, index) => (index === existingIndex ? { key, view } : item));
}

export function parseToolUpdate(text: string): ToolUpdateView {
  const match = text.match(/^(.*?)[：:](.*?)[（(]([^）)]+)[）)]$/);
  if (!match) return { label: text, detail: "", status: "unknown" };
  const [, label, detail, statusLabel] = match;
  return { label: (label ?? text).trim(), detail: (detail ?? "").trim(), status: parseToolStatus((statusLabel ?? "").trim()) };
}

export function parseToolStatus(statusLabel: string): ToolUpdateView["status"] {
  switch (statusLabel) {
    case "等待中": return "pending";
    case "执行中": return "running";
    case "已完成": return "completed";
    case "失败": return "error";
    default: return "unknown";
  }
}

export function parseOutput(finalReply: string): OutputView {
  const paths = extractPaths(finalReply);
  const commands = extractCommands(finalReply);
  const text = stripStructuredLines(finalReply, paths, commands);
  return { text, paths, commands };
}

export function extractPaths(text: string): string[] {
  return dedupe((text.match(/[A-Za-z]:\\[^\n`]+/g) ?? []).map((item) => item.trim()));
}

export function extractCommands(text: string): string[] {
  const commandMatches = Array.from(text.matchAll(/`([^`]+)`/g), (match) => match[1] ?? "");
  return dedupe(commandMatches.map((item) => item.trim()).filter((item) => /^(npm|pnpm|yarn|node|python|python3|git|bash|powershell|pwsh|cmd|npx)\b/i.test(item)));
}

export function stripStructuredLines(text: string, paths: string[], commands: string[]): string {
  let result = text;
  for (const path of paths) result = result.replace(path, "");
  for (const command of commands) result = result.replace(`\`${command}\``, "");
  return result.split("\n").map((line) => line.trimEnd()).filter((line, index, lines) => line.trim() !== "" || (index > 0 && lines[index - 1]?.trim() !== "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function appendProgressUpdate(updates: string[], nextUpdate: string): string[] {
  if (!nextUpdate || updates.includes(nextUpdate)) return updates;
  return [...updates, nextUpdate].slice(-6);
}

export function buildSessionRangeIndices(range: { start: number; end: number }): number[] {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  if (start < 1 || end < 1) {
    return [];
  }

  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
