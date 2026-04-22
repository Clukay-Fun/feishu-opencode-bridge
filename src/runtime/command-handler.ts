/**
 * 职责: 处理 bridge 自有命令，并协调会话管理类操作。
 * 关注点:
 * - 处理 /new、/status、/sessions、/allow 等命令。
 * - 连接会话窗口状态、OpenCode 能力和飞书卡片输出。
 */
import type { PendingInteraction, PendingPermissionInteraction, PendingSessionSelectionInteraction } from "../bridge/state.js";
import type { RoutedText } from "../bridge/router.js";
import {
  buildLeaveCommandCardPayload,
  buildModelListCardPayload,
  buildSessionListCardPayload,
  buildSessionTransitionCardPayload,
  buildStatusCommandCardPayload,
  buildWhoCommandCardPayload,
} from "../feishu/runtime-cards.js";
import { buildNoticeCardPayload, type FeishuPostPayload } from "../feishu/shared-primitives.js";
import type { TranscriptType } from "../logging/logger.js";
import type { OpenCodeMessage, OpenCodeProvidersResponse, OpenCodeSession, OpenCodeSessionStatus } from "../opencode/client.js";
import type { SessionBindingRecord, SessionWindowRecord } from "../store/mappings.js";
import type { IncomingChatMessage } from "./app.js";
import {
  buildModelCardView,
  buildSessionRangeIndices,
  chunkArray,
  extractAssistantText,
  findSessionMeta,
  formatSessionTimestamp,
  resolveDisplayLabel,
} from "./app-helpers.js";
import {
  addSession,
  createSessionEntry,
  getActiveSession,
  getVisibleSessions,
  normalizeSessionWindowRecord,
  removeSession,
  setActiveSession,
  updateSessionLabel,
} from "./session-windows.js";

const SESSION_SELECTION_TTL_MS = 30_000;
const SESSION_DELETE_CONFIRM_TTL_MS = 30_000;
const SESSIONS_ALL_PAGE_SIZE = 20;

type CommandMessage = Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey" | "threadKey" | "senderOpenId">;
type CommandRouted = Extract<RoutedText, { kind: "command" }>;
type PermissionResolution = "once" | "always" | "deny" | "timeout";
type SessionSelectionOption = PendingSessionSelectionInteraction["options"][number];

export type BridgeAppContext = {
  config: {
    bridge: {
      sessionListLimit: number;
      maxSessionsPerWindow: number;
    };
  };
  opencode: {
    getSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>>;
    abort(sessionId: string): Promise<boolean>;
    listProviders(): Promise<OpenCodeProvidersResponse>;
    deleteSession(sessionId: string): Promise<boolean>;
    runCommand(sessionId: string, input: { command: string; arguments: string[] }): Promise<OpenCodeMessage | null>;
  };
  whitelist: {
    count(chatId: string): number;
    isBound(chatId: string, openId: string): boolean;
    unbind(chatId: string, openId: string): Promise<boolean>;
  };
  getQueueState(conversationKey: string, sessionId?: string | null): {
    activeTurn: { sessionId?: string } | null;
    pendingCount: number;
  };
  eventStream: {
    getConnectionState(): string;
  };
  sessionStatuses: Map<string, OpenCodeSessionStatus>;
  pendingInteractions: Map<string, PendingInteraction>;
  permissionManager: {
    resolveInteraction(interaction: PendingPermissionInteraction, resolution: PermissionResolution): Promise<void>;
    buildResolutionPayload(resolution: PermissionResolution): FeishuPostPayload;
  };
  getSessionWindow(conversationKey: string, chatType: string): SessionWindowRecord;
  createAndBindSession(message: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">, preferredLabel?: string): Promise<SessionBindingRecord>;
  createDetachedSession(message: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">, preferredLabel?: string): Promise<SessionBindingRecord>;
  bindSessionWithoutActivating(message: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">, entry: SessionBindingRecord): Promise<SessionBindingRecord>;
  registerPendingNewSessionAnchor(replyMessageId: string, sourceConversationKey: string, entry: SessionBindingRecord): Promise<void>;
  sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    delivery?: { replyToMessageId: string; replyInThread?: boolean },
  ): Promise<{ messageId: string }>;
  sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<void>;
  setPendingInteraction(conversationKey: string, interaction: PendingInteraction): void;
  clearPendingInteraction(conversationKey: string, keepNonExpiring: boolean): void;
  listOpenCodeSessionsById(): Promise<Map<string, OpenCodeSession>>;
  saveSessionWindow(conversationKey: string, window: SessionWindowRecord): Promise<void>;
  getSessionMessageCount(sessionId: string): Promise<number>;
  ensureSession(source: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<string>;
  isSessionBusy(conversationKey: string, sessionId: string): boolean;
  resolveSessionCommandTarget(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey">,
    index: number | undefined,
  ): Promise<
    | { ok: true; window: SessionWindowRecord; session: SessionWindowRecord["sessions"][number]; index: number }
    | { ok: false; message: string }
  >;
  resolveSessionCommandTargets(
    message: Pick<IncomingChatMessage, "chatId" | "chatType" | "messageId" | "conversationKey">,
    range: { start: number; end: number },
  ): Promise<
    | { ok: true; window: SessionWindowRecord; sessions: SessionWindowRecord["sessions"]; indices: number[] }
    | { ok: false; message: string }
  >;
};

const BRIDGE_OWNED_COMMAND_KINDS = new Set<Extract<RoutedText, { kind: "command" }>["command"]["kind"]>([
  "new",
  "rename",
  "status",
  "abort",
  "models",
  "leave",
  "who",
  "sessions",
  "sessions-all",
  "sessions-select",
  "close",
  "delete",
  "allow",
  "deny",
  "passthrough",
]);

/** 判断命令是否由 bridge 核心层而不是业务模块处理。 */
export function isBridgeOwnedCommand(command: Extract<RoutedText, { kind: "command" }>["command"]): boolean {
  return BRIDGE_OWNED_COMMAND_KINDS.has(command.kind);
}

/** 承载 bridge 自有命令的执行逻辑。 */
export class CommandHandler {
  constructor(private readonly context: BridgeAppContext) {}

  /** 分发并执行一条 bridge 自有命令。 */
  async handleCommand(message: CommandMessage, routed: CommandRouted): Promise<void> {
    const { command } = routed;
    if (command.kind === "new") {
      const previousSession = getActiveSession(this.context.getSessionWindow(message.conversationKey, message.chatType));
      const preferredLabel = command.title?.trim() || undefined;
      const entry = await this.context.createAndBindSession(message, preferredLabel);
      const result = await this.context.sendPayload(message.chatId, buildSessionTransitionCardPayload({
        title: "已创建新会话",
        iconToken: "add-bold_outlined",
        previousLabel: previousSession?.label ?? null,
        currentLabel: entry.label,
        ...(previousSession ? { currentTitle: "当前会话" } : {}),
        footer: previousSession ? "已切换到新会话 · 可基于这条回复创建话题" : "刚刚创建 · 发送第一条消息开始",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已创建新会话",
        len: 6,
      }, { replyToMessageId: message.messageId });
      if (previousSession) {
        await this.context.registerPendingNewSessionAnchor(result.messageId, message.conversationKey, entry);
      }
      return;
    }

    if (command.kind === "rename") {
      const nextLabel = command.title.trim();
      if (!nextLabel) {
        await this.context.sendMarkdown(message.chatId, "请在 `/rename` 后输入新的会话标题。", message.messageId);
        return;
      }
      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      if (!currentSession) {
        await this.context.sendMarkdown(message.chatId, "当前窗口暂无会话，请先发送 `/new`。", message.messageId);
        return;
      }
      const nextWindow = updateSessionLabel(window, currentSession.sessionId, nextLabel, this.context.config.bridge.maxSessionsPerWindow);
      const renamedSession = getActiveSession(nextWindow);
      await this.context.saveSessionWindow(message.conversationKey, nextWindow);
      await this.context.sendPayload(message.chatId, buildSessionTransitionCardPayload({
        title: "已重命名会话",
        iconToken: "edit_outlined",
        previousLabel: currentSession.label,
        currentLabel: renamedSession?.label ?? nextLabel,
        footer: "仅更新 bridge 当前窗口中的显示名称",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已重命名会话",
        len: 6,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "status") {
      const statuses = await this.context.opencode.getSessionStatuses().catch(() => null);
      if (statuses) {
        for (const [sessionId, status] of Object.entries(statuses)) {
          this.context.sessionStatuses.set(sessionId, status);
        }
      }

      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const queueState = this.context.getQueueState(message.conversationKey, currentSession?.sessionId ?? null);
      const status = currentSession ? this.context.sessionStatuses.get(currentSession.sessionId)?.type ?? "unknown" : "unbound";
      await this.context.sendPayload(message.chatId, buildStatusCommandCardPayload({
        currentSession: currentSession ? { sessionId: currentSession.sessionId, label: currentSession.label } : null,
        connectionState: this.context.eventStream.getConnectionState(),
        sessionMode: window.mode,
        interactionMode: window.interactionMode === "knowledge" ? "知识库模式" : "普通对话",
        sessionState: status,
        queueState: queueState.activeTurn ? "处理中" : "空闲",
        pendingCount: queueState.pendingCount,
        windowCount: window.sessions.length,
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "会话状态",
        len: 4,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "abort") {
      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const queueState = this.context.getQueueState(message.conversationKey, currentSession?.sessionId ?? null);
      const activeTurn = queueState.activeTurn;
      if (!activeTurn) {
        await this.sendNotice(message, {
          title: "无任务可中止",
          template: "grey",
          icon: "info-hollow_filled",
          message: "当前没有正在执行的任务。",
        });
        return;
      }

      const sessionId = activeTurn.sessionId ?? currentSession?.sessionId;
      if (sessionId) {
        await this.context.opencode.abort(sessionId);
      }
      await this.sendNotice(message, {
        title: "任务已中止",
        template: "orange",
        icon: "stop-record_filled",
        message: "当前任务已中止，可发送新消息继续对话。",
      });
      return;
    }

    if (command.kind === "models") {
      const providers = await this.context.opencode.listProviders();
      const modelCard = buildModelCardView(providers, command.provider);
      if (!modelCard) {
        await this.sendNotice(message, {
          title: "提醒",
          template: "yellow",
          icon: "maybe_outlined",
          message: "当前没有匹配的模型提供方，请重新发送 `/models` 查看列表。",
        });
        return;
      }

      await this.context.sendPayload(message.chatId, buildModelListCardPayload(modelCard), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "可用模型",
        len: 4,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "sessions") {
      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      if (window.mode === "single") {
        await this.context.sendPayload(message.chatId, buildSessionListCardPayload({
          items: currentSession ? [{ index: 1, title: currentSession.label, current: true, meta: "当前" }] : [],
          footer: currentSession ? "当前窗口为单会话模式，不支持切换" : "发送 `/new` 创建第一个会话",
          emptyText: "暂无会话",
        }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "会话列表", len: 4 }, { replyToMessageId: message.messageId });
        return;
      }

      const visibleSessions = getVisibleSessions(window).slice(0, this.context.config.bridge.sessionListLimit);
      if (visibleSessions.length === 0) {
        await this.context.sendPayload(message.chatId, buildSessionListCardPayload({ items: [], footer: "发送 `/new` 创建第一个会话", emptyText: "暂无会话" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "会话列表", len: 4 }, { replyToMessageId: message.messageId });
        return;
      }

      const options = visibleSessions.map((session, index) => ({ index: index + 1, sessionId: session.sessionId, title: session.label, current: session.sessionId === currentSession?.sessionId }));
      this.context.setPendingInteraction(message.conversationKey, { kind: "session-select", options, expiresAt: Date.now() + SESSION_SELECTION_TTL_MS });
      await this.context.sendPayload(message.chatId, buildSessionListCardPayload({
        items: options.map((option) => ({ index: option.index, title: option.title, current: option.current, meta: option.current ? "当前" : formatSessionTimestamp(findSessionMeta(window, option.sessionId)?.lastUsedAt) })),
        footer: "发送 `/switch <编号>` 切换 · 30s 内有效",
      }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "会话列表", len: 4 }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "sessions-all") {
      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const openCodeSessions = await this.context.listOpenCodeSessionsById();
      const visibleIds = new Set(window.sessions.map((session) => session.sessionId));
      const sessions = [...openCodeSessions.values()].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0));
      if (sessions.length === 0) {
        await this.context.sendPayload(message.chatId, buildSessionListCardPayload({ items: [], footer: "发送 `/new` 创建第一个会话", emptyText: "暂无会话" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "全部会话", len: 4 }, { replyToMessageId: message.messageId });
        return;
      }
      const options = sessions.map((session, index) => ({ index: index + 1, sessionId: session.id, title: resolveDisplayLabel(session, session.title ?? session.slug ?? session.id, session.id), current: session.id === currentSession?.sessionId, inWindow: visibleIds.has(session.id) }));
      this.context.setPendingInteraction(message.conversationKey, { kind: "session-select", options, expiresAt: Date.now() + SESSION_SELECTION_TTL_MS });
      const pages = chunkArray(options, SESSIONS_ALL_PAGE_SIZE);
      for (const [pageIndex, page] of pages.entries()) {
        const footer = `第 ${pageIndex + 1}/${pages.length} 页 · 发送 \`/switch <编号>\` 恢复或切换 · \`/delete <编号>\` 彻底删除 · 30s 内有效`;
        await this.context.sendPayload(message.chatId, buildSessionListCardPayload({
          items: page.map((option) => ({ index: option.index, title: option.title, current: option.current, archived: !option.inWindow, meta: option.current ? "当前" : option.inWindow ? "窗口中" : "已隐藏" })),
          footer,
        }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "全部会话", len: 4 }, { replyToMessageId: message.messageId });
      }
      return;
    }

    if (command.kind === "sessions-select") {
      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      if (window.mode === "single") {
        await this.context.sendMarkdown(message.chatId, "当前窗口为单会话模式，不支持切换。", message.messageId);
        return;
      }
      const pending = this.context.pendingInteractions.get(message.conversationKey);
      if (command.query) {
        await this.switchSessionByName(message, window, command.query);
        return;
      }
      if (command.index === undefined) {
        await this.context.sendMarkdown(message.chatId, "请发送 `/switch <编号>` 或 `/switch <会话名称>`。", message.messageId);
        return;
      }
      if (!pending || pending.kind !== "session-select" || pending.expiresAt <= Date.now()) {
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.context.sendMarkdown(message.chatId, "会话列表已过期，请先重新执行 `/sessions`。", message.messageId);
        return;
      }
      const match = pending.options.find((option) => option.index === command.index);
      if (!match) {
        await this.context.sendMarkdown(message.chatId, "无效的会话编号，请重新执行 `/sessions` 查看列表。", message.messageId);
        return;
      }
      await this.switchToSession(message, window, match, { clearPending: true });
      return;
    }

    if (command.kind === "close") {
      if (command.all) {
        const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
        if (window.sessions.length === 0) {
          await this.context.sendMarkdown(message.chatId, "当前窗口暂无可操作的会话，请先发送 `/new`。", message.messageId);
          return;
        }
        const busySession = window.sessions.find((session) => this.context.isSessionBusy(message.conversationKey, session.sessionId));
        if (busySession) {
          await this.sendBusyNotice(message);
          return;
        }
        await this.context.saveSessionWindow(message.conversationKey, normalizeSessionWindowRecord({
          mode: window.mode,
          interactionMode: window.interactionMode === "knowledge" ? "knowledge" : "default",
          activeSessionId: null,
          sessions: [],
        }, window.mode, this.context.config.bridge.maxSessionsPerWindow));
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.sendNotice(message, {
          title: "已删除全部会话",
          template: "grey",
          icon: "close-bold_outlined",
          message: "当前窗口的全部会话已移除，发送 `/new` 创建新会话。",
        });
        return;
      }
      if (command.range) {
        const targets = await this.context.resolveSessionCommandTargets(message, command.range);
        if (!targets.ok) {
          await this.context.sendMarkdown(message.chatId, targets.message, message.messageId);
          return;
        }
        const busySession = targets.sessions.find((session) => this.context.isSessionBusy(message.conversationKey, session.sessionId));
        if (busySession) {
          await this.sendBusyNotice(message);
          return;
        }
        let nextWindow = targets.window;
        for (const session of targets.sessions) {
          nextWindow = removeSession(nextWindow, session.sessionId, this.context.config.bridge.maxSessionsPerWindow);
        }
        await this.context.saveSessionWindow(message.conversationKey, nextWindow);
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.sendNotice(message, {
          title: "已删除多个会话",
          template: "grey",
          icon: "close-bold_outlined",
          message: `已从当前窗口移除 ${targets.sessions.length} 个会话。`,
        });
        return;
      }
      const target = await this.context.resolveSessionCommandTarget(message, command.index);
      if (!target.ok) {
        await this.context.sendMarkdown(message.chatId, target.message, message.messageId);
        return;
      }
      if (this.context.isSessionBusy(message.conversationKey, target.session.sessionId)) {
        await this.sendBusyNotice(message);
        return;
      }
      const nextWindow = removeSession(target.window, target.session.sessionId, this.context.config.bridge.maxSessionsPerWindow);
      await this.context.saveSessionWindow(message.conversationKey, nextWindow);
      this.context.clearPendingInteraction(message.conversationKey, false);
      const current = getActiveSession(nextWindow);
      await this.context.sendPayload(message.chatId, buildSessionTransitionCardPayload({ title: "已删除会话", iconToken: "close-bold_outlined", previousLabel: target.session.label, currentLabel: current?.label ?? "当前窗口已无会话", footer: current ? "已从当前窗口移除，可继续使用当前会话" : "已从当前窗口移除，发送 `/new` 创建新会话" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "已删除会话", len: 5 }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "delete") {
      if (command.all && !command.confirm) {
        const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
        if (window.sessions.length === 0) {
          await this.context.sendMarkdown(message.chatId, "当前窗口暂无可操作的会话，请先发送 `/new`。", message.messageId);
          return;
        }
        const busySession = window.sessions.find((session) => this.context.isSessionBusy(message.conversationKey, session.sessionId));
        if (busySession) {
          await this.sendBusyNotice(message);
          return;
        }
        this.context.setPendingInteraction(message.conversationKey, { kind: "session-delete-confirm", all: true, sessionIds: window.sessions.map((session) => session.sessionId), expiresAt: Date.now() + SESSION_DELETE_CONFIRM_TTL_MS });
        await this.sendNotice(message, {
          title: "提醒",
          template: "yellow",
          icon: "maybe_outlined",
          message: "确认彻底删除当前窗口全部会话？发送 `/delete all confirm`",
        });
        return;
      }
      if (!command.confirm) {
        if (command.range) {
          const targets = await this.context.resolveSessionCommandTargets(message, command.range);
          if (!targets.ok) {
            await this.context.sendMarkdown(message.chatId, targets.message, message.messageId);
            return;
          }
          const busySession = targets.sessions.find((session) => this.context.isSessionBusy(message.conversationKey, session.sessionId));
          if (busySession) {
            await this.sendBusyNotice(message);
            return;
          }
          const rangeLabel = `${command.range.start}-${command.range.end}`;
          this.context.setPendingInteraction(message.conversationKey, { kind: "session-delete-confirm", indices: targets.indices, rangeLabel, sessionIds: targets.sessions.map((session) => session.sessionId), titles: targets.sessions.map((session) => session.label), expiresAt: Date.now() + SESSION_DELETE_CONFIRM_TTL_MS });
          const confirmText = `确认删除会话 #${rangeLabel}？发送 \`/delete ${rangeLabel} confirm\``;
          await this.sendNotice(message, {
            title: "提醒",
            template: "yellow",
            icon: "maybe_outlined",
            message: confirmText,
          });
          return;
        }
        const target = await this.context.resolveSessionCommandTarget(message, command.index);
        if (!target.ok) {
          await this.context.sendMarkdown(message.chatId, target.message, message.messageId);
          return;
        }
        if (this.context.isSessionBusy(message.conversationKey, target.session.sessionId)) {
          await this.sendBusyNotice(message);
          return;
        }
        this.context.setPendingInteraction(message.conversationKey, { kind: "session-delete-confirm", index: target.index, sessionId: target.session.sessionId, title: target.session.label, expiresAt: Date.now() + SESSION_DELETE_CONFIRM_TTL_MS });
        const confirmText = target.index > 0 ? `确认删除会话 #${target.index}？发送 \`/delete ${target.index} confirm\`` : "确认删除当前会话？发送 `/delete confirm`";
        await this.sendNotice(message, {
          title: "提醒",
          template: "yellow",
          icon: "maybe_outlined",
          message: confirmText,
        });
        return;
      }
      const pending = this.context.pendingInteractions.get(message.conversationKey);
      if (!pending || pending.kind !== "session-delete-confirm" || pending.expiresAt <= Date.now()) {
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.context.sendMarkdown(message.chatId, "删除确认已过期，请重新发送 `/delete`。", message.messageId);
        return;
      }
      if (command.all) {
        if (!pending.all || !pending.sessionIds || pending.sessionIds.length === 0) {
          this.context.clearPendingInteraction(message.conversationKey, false);
          await this.context.sendMarkdown(message.chatId, "删除确认已过期，请重新发送 `/delete all`。", message.messageId);
          return;
        }
        const busySession = pending.sessionIds.find((sessionId) => this.context.isSessionBusy(message.conversationKey, sessionId));
        if (busySession) {
          await this.sendBusyNotice(message);
          return;
        }
        for (const sessionId of pending.sessionIds) {
          await this.context.opencode.deleteSession(sessionId);
        }
        const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
        await this.context.saveSessionWindow(message.conversationKey, normalizeSessionWindowRecord({
          mode: window.mode,
          interactionMode: window.interactionMode === "knowledge" ? "knowledge" : "default",
          activeSessionId: null,
          sessions: [],
        }, window.mode, this.context.config.bridge.maxSessionsPerWindow));
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.sendNotice(message, {
          title: "已彻底删除全部会话",
          template: "red",
          icon: "close-bold_outlined",
          message: "当前窗口的全部会话已从窗口和 OpenCode 中删除。",
        });
        return;
      }
      if (command.index !== undefined && pending.index !== command.index) {
        await this.context.sendMarkdown(message.chatId, "删除确认编号不匹配，请重新发送 `/delete <编号>`。", message.messageId);
        return;
      }
      if (command.range) {
        const rangeLabel = `${command.range.start}-${command.range.end}`;
        const expectedIndices = buildSessionRangeIndices(command.range);
        const sameRange = pending.indices && pending.rangeLabel === rangeLabel && pending.indices.length === expectedIndices.length && pending.indices.every((value, idx) => value === expectedIndices[idx]);
        if (!sameRange) {
          await this.context.sendMarkdown(message.chatId, "删除确认编号不匹配，请重新发送 `/delete <起始-结束>`。", message.messageId);
          return;
        }
      }
      if (!pending.sessionId) {
        if (pending.sessionIds && pending.sessionIds.length > 0) {
          const busySession = pending.sessionIds.find((sessionId) => this.context.isSessionBusy(message.conversationKey, sessionId));
          if (busySession) {
            await this.sendBusyNotice(message);
            return;
          }
          const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
          for (const sessionId of pending.sessionIds) {
            await this.context.opencode.deleteSession(sessionId);
          }
          let nextWindow = window;
          for (const sessionId of pending.sessionIds) {
            nextWindow = removeSession(nextWindow, sessionId, this.context.config.bridge.maxSessionsPerWindow);
          }
          await this.context.saveSessionWindow(message.conversationKey, nextWindow);
          this.context.clearPendingInteraction(message.conversationKey, false);
          await this.sendNotice(message, {
            title: "已彻底删除多个会话",
            template: "red",
            icon: "close-bold_outlined",
            message: `已从当前窗口和 OpenCode 中删除 ${pending.sessionIds.length} 个会话。`,
          });
          return;
        }
        await this.sendNotice(message, {
          title: "提醒",
          template: "yellow",
          icon: "maybe_outlined",
          message: "删除确认已失效，请重新发送 `/delete`。",
        });
        return;
      }
      if (this.context.isSessionBusy(message.conversationKey, pending.sessionId)) {
        await this.sendBusyNotice(message);
        return;
      }
      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const targetSession = window.sessions.find((session) => session.sessionId === pending.sessionId);
      await this.context.opencode.deleteSession(pending.sessionId);
      const nextWindow = removeSession(window, pending.sessionId, this.context.config.bridge.maxSessionsPerWindow);
      await this.context.saveSessionWindow(message.conversationKey, nextWindow);
      this.context.clearPendingInteraction(message.conversationKey, false);
      const current = getActiveSession(nextWindow);
      await this.context.sendPayload(message.chatId, buildSessionTransitionCardPayload({ title: "已彻底删除会话", iconToken: "close-bold_outlined", previousLabel: targetSession?.label ?? pending.title ?? null, currentLabel: current?.label ?? "当前窗口已无会话", footer: current ? "已从当前窗口和 OpenCode 中删除" : "已从当前窗口和 OpenCode 中删除，发送 `/new` 创建新会话" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "已彻底删除会话", len: 7 }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "who") {
      if (message.chatType !== "group" && message.chatType !== "topic_group") {
        await this.context.sendMarkdown(message.chatId, "该命令仅支持群聊使用", message.messageId);
        return;
      }
      await this.context.sendPayload(message.chatId, buildWhoCommandCardPayload({ boundCount: this.context.whitelist.count(message.chatId), isBound: this.context.whitelist.isBound(message.chatId, message.senderOpenId) }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "群聊绑定状态", len: 6 }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "leave") {
      if (message.chatType !== "group" && message.chatType !== "topic_group") {
        await this.context.sendMarkdown(message.chatId, "该命令仅支持群聊使用", message.messageId);
        return;
      }
      const unbound = await this.context.whitelist.unbind(message.chatId, message.senderOpenId);
      await this.context.sendPayload(message.chatId, buildLeaveCommandCardPayload({ unbound }), { event: "final message sent", transcriptType: "outbound-final", textPreview: unbound ? "已解除绑定" : "无需解除绑定", len: unbound ? 5 : 6 }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "allow" || command.kind === "deny") {
      const pending = this.context.pendingInteractions.get(message.conversationKey);
      if (!pending || pending.kind !== "permission") {
        await this.sendNotice(message, {
          title: "信息提示",
          template: "blue",
          icon: "info_outlined",
          message: "当前没有待确认的权限请求。",
        });
        return;
      }
      const resolution: PermissionResolution = command.kind === "deny" ? "deny" : command.policy;
      await this.context.permissionManager.resolveInteraction(pending, resolution);
      await this.context.sendPayload(message.chatId, this.context.permissionManager.buildResolutionPayload(resolution), { event: "final message sent", transcriptType: "outbound-final", textPreview: resolution === "deny" ? "已拒绝权限请求。" : "已确认权限请求。", len: 8 }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind !== "passthrough") {
      return;
    }
    if (command.name === "model" && (command.arguments.length === 0 || (command.arguments.length === 1 && !["use", "reset"].includes(command.arguments[0] ?? "")))) {
      const replacement = command.arguments.length === 0 ? "`/models`" : "`/models <provider>`";
      await this.sendNotice(message, {
        title: "命令已更新",
        template: "yellow",
        icon: "maybe_outlined",
        message: `模型列表入口已从 \`/model\` 迁移到 ${replacement}。切换模型仍继续使用 \`/model use <provider/model>\` 和 \`/model reset\`。`,
      });
      return;
    }
    const sessionId = await this.context.ensureSession(message);
    const result = await this.context.opencode.runCommand(sessionId, { command: command.name, arguments: command.arguments });
    const text = extractAssistantText(result) || "命令已执行。";
    await this.context.sendMarkdown(message.chatId, text, message.messageId);
  }

  private async switchSessionByName(message: CommandMessage, window: SessionWindowRecord, rawQuery: string): Promise<void> {
    const query = normalizeSessionLookupText(rawQuery);
    if (!query) {
      await this.context.sendMarkdown(message.chatId, "请在 `/switch` 后输入会话名称。", message.messageId);
      return;
    }

    const openCodeSessions = await this.context.listOpenCodeSessionsById();
    const candidateMap = new Map<string, SessionSelectionOption>();
    for (const session of window.sessions) {
      candidateMap.set(session.sessionId, {
        index: candidateMap.size + 1,
        sessionId: session.sessionId,
        title: session.label,
        current: session.sessionId === window.activeSessionId,
        inWindow: true,
      });
    }
    for (const session of openCodeSessions.values()) {
      if (candidateMap.has(session.id)) {
        continue;
      }
      candidateMap.set(session.id, {
        index: candidateMap.size + 1,
        sessionId: session.id,
        title: resolveDisplayLabel(session, session.title ?? session.slug ?? session.id, session.id),
        current: session.id === window.activeSessionId,
        inWindow: false,
      });
    }

    const candidates = [...candidateMap.values()];
    const exactMatches = candidates.filter((candidate) => (
      normalizeSessionLookupText(candidate.title) === query
      || normalizeSessionLookupText(candidate.sessionId) === query
    ));
    const matches = exactMatches.length > 0
      ? exactMatches
      : candidates.filter((candidate) => normalizeSessionLookupText(candidate.title).includes(query));

    if (matches.length === 0) {
      await this.context.sendMarkdown(message.chatId, "未找到匹配的会话，请发送 `/sessions all` 查看完整列表。", message.messageId);
      return;
    }

    if (matches.length > 1) {
      const options = matches.map((match, index) => ({ ...match, index: index + 1 }));
      this.context.setPendingInteraction(message.conversationKey, { kind: "session-select", options, expiresAt: Date.now() + SESSION_SELECTION_TTL_MS });
      await this.context.sendPayload(message.chatId, buildSessionListCardPayload({
        items: options.map((option) => ({
          index: option.index,
          title: option.title,
          current: Boolean(option.current),
          archived: !option.inWindow,
          meta: option.current ? "当前" : option.inWindow ? "窗口中" : "已隐藏",
        })),
        footer: "匹配到多个会话 · 发送 `/switch <编号>` 切换 · 30s 内有效",
      }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "匹配会话", len: 4 }, { replyToMessageId: message.messageId });
      return;
    }

    await this.switchToSession(message, window, matches[0] as SessionSelectionOption, { clearPending: false, openCodeSessions });
  }

  private async switchToSession(
    message: CommandMessage,
    window: SessionWindowRecord,
    match: SessionSelectionOption,
    options: { clearPending: boolean; openCodeSessions?: Map<string, OpenCodeSession> },
  ): Promise<void> {
    const openCodeSessions = options.openCodeSessions ?? await this.context.listOpenCodeSessionsById();
    if (!openCodeSessions.has(match.sessionId)) {
      const nextWindow = removeSession(window, match.sessionId, this.context.config.bridge.maxSessionsPerWindow);
      await this.context.saveSessionWindow(message.conversationKey, nextWindow);
      this.context.clearPendingInteraction(message.conversationKey, false);
      await this.context.sendMarkdown(message.chatId, "目标会话已失效，已从当前窗口列表移除，请重新执行 `/sessions`。", message.messageId);
      return;
    }

    const sessionMeta = openCodeSessions.get(match.sessionId);
    const fallbackLabel = resolveDisplayLabel(sessionMeta, match.title, match.sessionId);
    const inWindow = match.inWindow ?? window.sessions.some((session) => session.sessionId === match.sessionId);
    let nextWindow = inWindow
      ? setActiveSession(window, match.sessionId, Date.now(), this.context.config.bridge.maxSessionsPerWindow)
      : addSession(window, createSessionEntry(match.sessionId, Date.now(), fallbackLabel), this.context.config.bridge.maxSessionsPerWindow);
    nextWindow = setActiveSession(nextWindow, match.sessionId, Date.now(), this.context.config.bridge.maxSessionsPerWindow);
    nextWindow = updateSessionLabel(nextWindow, match.sessionId, fallbackLabel, this.context.config.bridge.maxSessionsPerWindow);
    await this.context.saveSessionWindow(message.conversationKey, nextWindow);
    if (options.clearPending) {
      this.context.clearPendingInteraction(message.conversationKey, false);
    }

    const previous = getActiveSession(window);
    const current = getActiveSession(nextWindow);
    const messageCount = await this.context.getSessionMessageCount(match.sessionId);
    await this.context.sendPayload(message.chatId, buildSessionTransitionCardPayload({
      title: "已切换会话",
      iconToken: "sheet-iconsets-check_filled",
      previousLabel: previous?.sessionId === current?.sessionId ? null : previous?.label ?? null,
      currentLabel: current?.label ?? fallbackLabel,
      footer: `创建于 ${formatSessionTimestamp(current?.createdAt ?? sessionMeta?.time?.created ?? Date.now())} · 共 ${messageCount} 条消息`,
    }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "已切换会话", len: 5 }, { replyToMessageId: message.messageId });
  }

  private async sendNotice(
    message: CommandMessage,
    options: {
      title: string;
      template: "yellow" | "grey" | "blue" | "red" | "orange" | "green" | "indigo";
      icon: string;
      message: string;
    },
  ): Promise<void> {
    await this.context.sendPayload(message.chatId, buildNoticeCardPayload({
      title: options.title,
      template: options.template,
      iconToken: options.icon,
      message: options.message,
      messageIconToken: options.icon,
      messageIconColor: options.template,
    }), {
      event: "final message sent",
      transcriptType: "outbound-final",
      textPreview: options.message,
      len: options.message.length,
    }, { replyToMessageId: message.messageId });
  }

  private async sendBusyNotice(message: CommandMessage): Promise<void> {
    await this.sendNotice(message, {
      title: "提醒",
      template: "yellow",
      icon: "maybe_outlined",
      message: "当前会话正在执行任务，请先发送 `/abort`。",
    });
  }
}

function normalizeSessionLookupText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
