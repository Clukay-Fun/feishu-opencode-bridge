/**
 * 职责: 管理聊天窗口与底层 OpenCode 会话之间的映射关系。
 * 关注点:
 * - 支持单会话、多会话模式以及当前活跃会话切换。
 * - 维护窗口内会话列表、排序和交互模式。
 */
import type { InteractionMode, SessionBindingRecord, SessionMode, SessionWindowRecord } from "../store/mappings.js";

const SESSION_LABEL_MAX_LENGTH = 24;

export type SessionModeConfig = {
  p2p: SessionMode;
  group: SessionMode;
  topicGroup: SessionMode;
};

/** 根据聊天类型解析当前窗口应采用的会话模式。 */
export function resolveSessionMode(chatType: string | undefined, config: SessionModeConfig): SessionMode {
  if (chatType === "group") {
    return config.group;
  }
  if (chatType === "topic_group") {
    return config.topicGroup;
  }
  return config.p2p;
}

/** 规范化窗口记录，处理排序、去重、模式收敛和 activeSession。 */
export function normalizeSessionWindowRecord(
  record: SessionWindowRecord | undefined,
  mode: SessionMode,
  maxSessions: number,
): SessionWindowRecord {
  const sessions = sortSessionsByLastUsed(record?.sessions ?? []);
  const interactionMode = record?.interactionMode === "knowledge" ? "knowledge" : "default";
  if (mode === "single") {
    const active = findSessionById(sessions, record?.activeSessionId) ?? sessions[0] ?? null;
    return {
      mode,
      interactionMode,
      activeSessionId: active?.sessionId ?? null,
      sessions: active ? [active] : [],
    };
  }

  const uniqueSessions = dedupeSessions(sessions).slice(0, Math.max(1, maxSessions));
  const active = findSessionById(uniqueSessions, record?.activeSessionId) ?? uniqueSessions[0] ?? null;
  return {
    mode,
    interactionMode,
    activeSessionId: active?.sessionId ?? null,
    sessions: uniqueSessions,
  };
}

/** 创建新的 session 绑定记录。 */
export function createSessionEntry(sessionId: string, now: number, label = "新会话"): SessionBindingRecord {
  return {
    sessionId,
    label: normalizeSessionLabel(label),
    createdAt: now,
    lastUsedAt: now,
  };
}

/** 返回当前窗口的活跃 session。 */
export function getActiveSession(window: SessionWindowRecord): SessionBindingRecord | null {
  return findSessionById(window.sessions, window.activeSessionId) ?? null;
}

/** 切换活跃 session，并刷新最近使用时间。 */
export function setActiveSession(
  window: SessionWindowRecord,
  sessionId: string,
  now: number,
  maxSessions: number,
): SessionWindowRecord {
  const updatedSessions = window.sessions.map((session) => {
    if (session.sessionId !== sessionId) {
      return session;
    }
    return { ...session, lastUsedAt: now };
  });

  return normalizeSessionWindowRecord({
    mode: window.mode,
    interactionMode: resolveInteractionMode(window),
    activeSessionId: sessionId,
    sessions: updatedSessions,
  }, window.mode, maxSessions);
}

/** 新增 session，并将其设为当前活跃项。 */
export function addSession(
  window: SessionWindowRecord,
  session: SessionBindingRecord,
  maxSessions: number,
): SessionWindowRecord {
  return normalizeSessionWindowRecord({
    mode: window.mode,
    interactionMode: resolveInteractionMode(window),
    activeSessionId: session.sessionId,
    sessions: [session, ...window.sessions.filter((item) => item.sessionId !== session.sessionId)],
  }, window.mode, maxSessions);
}

/** 新增 session，但不打断当前活跃项。 */
export function addSessionWithoutActivating(
  window: SessionWindowRecord,
  session: SessionBindingRecord,
  maxSessions: number,
): SessionWindowRecord {
  const hasActiveSession = Boolean(window.activeSessionId);
  return normalizeSessionWindowRecord({
    mode: window.mode,
    interactionMode: resolveInteractionMode(window),
    activeSessionId: hasActiveSession ? window.activeSessionId : session.sessionId,
    sessions: [session, ...window.sessions.filter((item) => item.sessionId !== session.sessionId)],
  }, window.mode, maxSessions);
}

/** 从窗口中移除指定 session。 */
export function removeSession(
  window: SessionWindowRecord,
  sessionId: string,
  maxSessions: number,
): SessionWindowRecord {
  const remaining = window.sessions.filter((session) => session.sessionId !== sessionId);
  const nextActive = window.activeSessionId === sessionId
    ? remaining[0]?.sessionId ?? null
    : window.activeSessionId;
  return normalizeSessionWindowRecord({
    mode: window.mode,
    interactionMode: resolveInteractionMode(window),
    activeSessionId: nextActive,
    sessions: remaining,
  }, window.mode, maxSessions);
}

/** 更新指定 session 的展示标题。 */
export function updateSessionLabel(
  window: SessionWindowRecord,
  sessionId: string,
  label: string,
  maxSessions: number,
): SessionWindowRecord {
  const normalizedLabel = normalizeSessionLabel(label);
  if (!normalizedLabel) {
    return window;
  }

  return normalizeSessionWindowRecord({
    mode: window.mode,
    interactionMode: resolveInteractionMode(window),
    activeSessionId: window.activeSessionId,
    sessions: window.sessions.map((session) => (
      session.sessionId === sessionId
        ? { ...session, label: normalizedLabel }
        : session
    )),
  }, window.mode, maxSessions);
}

/** 切换窗口交互模式。 */
export function setInteractionMode(
  window: SessionWindowRecord,
  interactionMode: InteractionMode,
  maxSessions: number,
): SessionWindowRecord {
  return normalizeSessionWindowRecord({
    mode: window.mode,
    interactionMode,
    activeSessionId: window.activeSessionId,
    sessions: window.sessions,
  }, window.mode, maxSessions);
}

/** 返回当前窗口中需要展示给用户的 sessions。 */
export function getVisibleSessions(window: SessionWindowRecord): SessionBindingRecord[] {
  return sortSessionsByLastUsed(window.sessions);
}

/** 判断窗口中是否包含指定 session。 */
export function hasSession(window: SessionWindowRecord, sessionId: string): boolean {
  return window.sessions.some((session) => session.sessionId === sessionId);
}

function dedupeSessions(sessions: SessionBindingRecord[]): SessionBindingRecord[] {
  const seenSessionIds = new Set<string>();
  return sessions.filter((session) => {
    if (seenSessionIds.has(session.sessionId)) {
      return false;
    }
    seenSessionIds.add(session.sessionId);
    return true;
  });
}

function sortSessionsByLastUsed(sessions: SessionBindingRecord[]): SessionBindingRecord[] {
  return [...sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function findSessionById(sessions: SessionBindingRecord[], sessionId: string | null | undefined): SessionBindingRecord | null {
  if (!sessionId) {
    return null;
  }
  return sessions.find((session) => session.sessionId === sessionId) ?? null;
}

function resolveInteractionMode(window: SessionWindowRecord): InteractionMode {
  return window.interactionMode === "knowledge" ? "knowledge" : "default";
}

function normalizeSessionLabel(label: string): string {
  const normalized = label.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (normalized.length <= SESSION_LABEL_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, SESSION_LABEL_MAX_LENGTH - 3)}...`;
}
