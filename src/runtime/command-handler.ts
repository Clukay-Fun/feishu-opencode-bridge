import type { PendingInteraction, PendingPermissionInteraction } from "../bridge/state.js";
import type { RoutedText } from "../bridge/router.js";
import {
  buildModelListCardPayload,
  buildNoticeCardPayload,
  buildLeaveCommandCardPayload,
  buildSessionListCardPayload,
  buildSessionTransitionCardPayload,
  buildStatusCommandCardPayload,
  buildWhoCommandCardPayload,
  type FeishuPostPayload,
} from "../feishu/formatter.js";
import type { TranscriptType } from "../logging/logger.js";
import type { OpenCodeMessage, OpenCodeProvidersResponse, OpenCodeSession, OpenCodeSessionStatus } from "../opencode/client.js";
import type { SessionWindowRecord } from "../store/mappings.js";
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
  queues: {
    get(key: string): {
      peek(): { sessionId?: string } | null | undefined;
      pendingCount(): number;
    };
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
  createAndBindSession(message: Pick<IncomingChatMessage, "chatId" | "chatType" | "conversationKey" | "threadKey">): Promise<{ sessionId: string; label: string }>;
  sendPayload(
    chatId: string,
    payload: FeishuPostPayload,
    options: { event: string; transcriptType: TranscriptType; textPreview: string; len: number },
    delivery?: { replyToMessageId: string },
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

export class CommandHandler {
  constructor(private readonly context: BridgeAppContext) {}

  async handleCommand(message: CommandMessage, routed: CommandRouted): Promise<void> {
    const { command } = routed;
    if (command.kind === "new") {
      const previousSession = getActiveSession(this.context.getSessionWindow(message.conversationKey, message.chatType));
      const entry = await this.context.createAndBindSession(message);
      await this.context.sendPayload(message.chatId, buildSessionTransitionCardPayload({
        title: "已创建新会话",
        iconToken: "add-bold_outlined",
        previousLabel: previousSession?.label ?? null,
        currentLabel: entry.label,
        footer: "刚刚创建 · 发送第一条消息开始",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "已创建新会话",
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

      const queue = this.context.queues.get(message.conversationKey);
      const active = queue.peek();
      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const status = currentSession ? this.context.sessionStatuses.get(currentSession.sessionId)?.type ?? "unknown" : "unbound";
      await this.context.sendPayload(message.chatId, buildStatusCommandCardPayload({
        currentSession: currentSession ? { sessionId: currentSession.sessionId, label: currentSession.label } : null,
        connectionState: this.context.eventStream.getConnectionState(),
        sessionMode: window.mode,
        sessionState: status,
        queueState: active ? "处理中" : "空闲",
        pendingCount: queue.pendingCount(),
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
      const queue = this.context.queues.get(message.conversationKey);
      const activeTurn = queue.peek();
      if (!activeTurn) {
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "无任务可中止",
          template: "grey",
          iconToken: "info-hollow_filled",
          message: "当前没有正在执行的任务。",
          messageIconToken: "info-hollow_filled",
          messageIconColor: "grey",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前没有正在执行的任务。",
          len: 12,
        }, { replyToMessageId: message.messageId });
        return;
      }

      const window = this.context.getSessionWindow(message.conversationKey, message.chatType);
      const currentSession = getActiveSession(window);
      const sessionId = activeTurn.sessionId ?? currentSession?.sessionId;
      if (sessionId) {
        await this.context.opencode.abort(sessionId);
      }
      await this.context.sendPayload(message.chatId, buildNoticeCardPayload({
        title: "任务已中止",
        template: "orange",
        iconToken: "stop-record_filled",
        message: "当前任务已中止，可发送新消息继续对话。",
        messageIconToken: "stop-record_filled",
        messageIconColor: "orange",
      }), {
        event: "final message sent",
        transcriptType: "outbound-final",
        textPreview: "当前任务已中止，可发送新消息继续对话。",
        len: 17,
      }, { replyToMessageId: message.messageId });
      return;
    }

    if (command.kind === "models") {
      const providers = await this.context.opencode.listProviders();
      const modelCard = buildModelCardView(providers, command.provider);
      if (!modelCard) {
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({
          title: "提醒",
          template: "yellow",
          iconToken: "maybe_outlined",
          message: "当前没有匹配的模型提供方，请重新发送 `/model` 查看列表。",
          messageIconToken: "maybe_outlined",
          messageIconColor: "yellow",
        }), {
          event: "final message sent",
          transcriptType: "outbound-final",
          textPreview: "当前没有匹配的模型提供方，请重新发送 `/model` 查看列表。",
          len: 27,
        }, { replyToMessageId: message.messageId });
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
      const openCodeSessions = await this.context.listOpenCodeSessionsById();
      if (!openCodeSessions.has(match.sessionId)) {
        const nextWindow = removeSession(window, match.sessionId, this.context.config.bridge.maxSessionsPerWindow);
        await this.context.saveSessionWindow(message.conversationKey, nextWindow);
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.context.sendMarkdown(message.chatId, "目标会话已失效，已从当前窗口列表移除，请重新执行 `/sessions`。", message.messageId);
        return;
      }
      const sessionMeta = openCodeSessions.get(match.sessionId);
      const fallbackLabel = resolveDisplayLabel(sessionMeta, match.title, match.sessionId);
      let nextWindow = match.inWindow
        ? setActiveSession(window, match.sessionId, Date.now(), this.context.config.bridge.maxSessionsPerWindow)
        : addSession(window, createSessionEntry(match.sessionId, Date.now(), fallbackLabel), this.context.config.bridge.maxSessionsPerWindow);
      nextWindow = setActiveSession(nextWindow, match.sessionId, Date.now(), this.context.config.bridge.maxSessionsPerWindow);
      nextWindow = updateSessionLabel(nextWindow, match.sessionId, fallbackLabel, this.context.config.bridge.maxSessionsPerWindow);
      await this.context.saveSessionWindow(message.conversationKey, nextWindow);
      this.context.clearPendingInteraction(message.conversationKey, false);
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
        await this.context.saveSessionWindow(message.conversationKey, normalizeSessionWindowRecord(undefined, window.mode, this.context.config.bridge.maxSessionsPerWindow));
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "已删除全部会话", template: "grey", iconToken: "close-bold_outlined", message: "当前窗口的全部会话已移除，发送 `/new` 创建新会话。", messageIconToken: "close-bold_outlined", messageIconColor: "grey" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "当前窗口的全部会话已移除，发送 `/new` 创建新会话。", len: 24 }, { replyToMessageId: message.messageId });
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
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "已删除多个会话", template: "grey", iconToken: "close-bold_outlined", message: `已从当前窗口移除 ${targets.sessions.length} 个会话。`, messageIconToken: "close-bold_outlined", messageIconColor: "grey" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: `已从当前窗口移除 ${targets.sessions.length} 个会话。`, len: 17 }, { replyToMessageId: message.messageId });
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
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "提醒", template: "yellow", iconToken: "maybe_outlined", message: "确认彻底删除当前窗口全部会话？发送 `/delete all confirm`", messageIconToken: "maybe_outlined", messageIconColor: "yellow" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "确认彻底删除当前窗口全部会话？发送 `/delete all confirm`", len: 31 }, { replyToMessageId: message.messageId });
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
          await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "提醒", template: "yellow", iconToken: "maybe_outlined", message: confirmText, messageIconToken: "maybe_outlined", messageIconColor: "yellow" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: confirmText, len: confirmText.length }, { replyToMessageId: message.messageId });
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
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "提醒", template: "yellow", iconToken: "maybe_outlined", message: confirmText, messageIconToken: "maybe_outlined", messageIconColor: "yellow" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: confirmText, len: confirmText.length }, { replyToMessageId: message.messageId });
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
        await this.context.saveSessionWindow(message.conversationKey, normalizeSessionWindowRecord(undefined, window.mode, this.context.config.bridge.maxSessionsPerWindow));
        this.context.clearPendingInteraction(message.conversationKey, false);
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "已彻底删除全部会话", template: "red", iconToken: "close-bold_outlined", message: "当前窗口的全部会话已从窗口和 OpenCode 中删除。", messageIconToken: "close-bold_outlined", messageIconColor: "red" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "当前窗口的全部会话已从窗口和 OpenCode 中删除。", len: 25 }, { replyToMessageId: message.messageId });
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
          await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "已彻底删除多个会话", template: "red", iconToken: "close-bold_outlined", message: `已从当前窗口和 OpenCode 中删除 ${pending.sessionIds.length} 个会话。`, messageIconToken: "close-bold_outlined", messageIconColor: "red" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: `已从当前窗口和 OpenCode 中删除 ${pending.sessionIds.length} 个会话。`, len: 25 }, { replyToMessageId: message.messageId });
          return;
        }
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "提醒", template: "yellow", iconToken: "maybe_outlined", message: "删除确认已失效，请重新发送 `/delete`。", messageIconToken: "maybe_outlined", messageIconColor: "yellow" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "删除确认已失效，请重新发送 `/delete`。", len: 19 }, { replyToMessageId: message.messageId });
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
        await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ title: "信息提示", template: "blue", iconToken: "info_outlined", message: "当前没有待确认的权限请求。", messageIconToken: "info_outlined", messageIconColor: "blue" }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "当前没有待确认的权限请求。", len: 13 }, { replyToMessageId: message.messageId });
        return;
      }
      const resolution: PermissionResolution = command.kind === "deny" ? "deny" : command.policy;
      await this.context.permissionManager.resolveInteraction(pending, resolution);
      await this.context.sendPayload(message.chatId, this.context.permissionManager.buildResolutionPayload(resolution), { event: "final message sent", transcriptType: "outbound-final", textPreview: resolution === "deny" ? "已拒绝权限请求。" : "已确认权限请求。", len: 8 }, { replyToMessageId: message.messageId });
      return;
    }

    const sessionId = await this.context.ensureSession(message);
    const result = await this.context.opencode.runCommand(sessionId, { command: command.name, arguments: command.arguments });
    const text = extractAssistantText(result) || "命令已执行。";
    await this.context.sendMarkdown(message.chatId, text, message.messageId);
  }

  private async sendBusyNotice(message: CommandMessage): Promise<void> {
    await this.context.sendPayload(message.chatId, buildNoticeCardPayload({
      title: "提醒",
      template: "yellow",
      iconToken: "maybe_outlined",
      message: "当前会话正在执行任务，请先发送 `/abort`。",
      messageIconToken: "maybe_outlined",
      messageIconColor: "yellow",
    }), { event: "final message sent", transcriptType: "outbound-final", textPreview: "当前会话正在执行任务，请先发送 `/abort`。", len: 20 }, { replyToMessageId: message.messageId });
  }
}
