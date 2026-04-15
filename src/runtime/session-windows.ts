import type { InteractionMode, SessionBindingRecord, SessionMode, SessionWindowRecord } from "../store/mappings.js";

const SESSION_LABEL_MAX_LENGTH = 24;

export type SessionModeConfig = {
  p2p: SessionMode;
  group: SessionMode;
  topicGroup: SessionMode;
};

export function resolveSessionMode(chatType: string | undefined, config: SessionModeConfig): SessionMode {
  if (chatType === "group") {
    return config.group;
  }
  if (chatType === "topic_group") {
    return config.topicGroup;
  }
  return config.p2p;
}

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

export function createSessionEntry(sessionId: string, now: number, label = "新会话"): SessionBindingRecord {
  return {
    sessionId,
    label: normalizeSessionLabel(label),
    createdAt: now,
    lastUsedAt: now,
  };
}

export function getActiveSession(window: SessionWindowRecord): SessionBindingRecord | null {
  return findSessionById(window.sessions, window.activeSessionId) ?? null;
}

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

export function getVisibleSessions(window: SessionWindowRecord): SessionBindingRecord[] {
  return sortSessionsByLastUsed(window.sessions);
}

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
