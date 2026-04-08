import { JsonStore } from "./json-store.js";

export type SessionMode = "single" | "multi";

export type SessionBindingRecord = {
  sessionId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
};

export type SessionWindowRecord = {
  mode: SessionMode;
  model?: string | null;
  activeSessionId: string | null;
  sessions: SessionBindingRecord[];
};

export type MappingRecord = Record<string, SessionWindowRecord>;

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type MappingFile = {
  version: 3;
  mappings: MappingRecord;
};

const MAPPING_STORE_VERSION = 3 as const;

export class MappingStore extends JsonStore<unknown> {
  constructor(
    dataDir: string,
    fileName: string,
    private readonly maxEntries = 200,
    private readonly logger?: LoggerLike,
  ) {
    super(dataDir, fileName, { version: MAPPING_STORE_VERSION, mappings: {} } satisfies MappingFile);
  }

  override async load(): Promise<MappingRecord> {
    const loaded = await super.load();
    if (isMappingFile(loaded)) {
      return trimMappings(normalizeMappings(loaded.mappings), this.maxEntries);
    }

    if (isVersion2MappingFile(loaded)) {
      const migrated = trimMappings(migrateVersion2Mappings(loaded.mappings), this.maxEntries);
      this.logger?.log("store/mappings", "mapping store 格式升级，已迁移", { fromVersion: 2 }, "warn");
      await super.save({ version: MAPPING_STORE_VERSION, mappings: migrated } satisfies MappingFile);
      return migrated;
    }

    if (isLegacyMappingFile(loaded)) {
      const migrated = trimMappings(migrateLegacyMappings(loaded), this.maxEntries);
      this.logger?.log("store/mappings", "mapping store 格式升级，已迁移", { fromVersion: "legacy" }, "warn");
      await super.save({ version: MAPPING_STORE_VERSION, mappings: migrated } satisfies MappingFile);
      return migrated;
    }

    return {};
  }

  override async save(value: MappingRecord): Promise<void> {
    await super.save({
      version: MAPPING_STORE_VERSION,
      mappings: trimMappings(normalizeMappings(value), this.maxEntries),
    } satisfies MappingFile);
  }
}

function isMappingFile(value: unknown): value is MappingFile {
  return isRecord(value) && value.version === MAPPING_STORE_VERSION && isRecord(value.mappings);
}

function isVersion2MappingFile(value: unknown): value is { version: 2; mappings: Record<string, unknown> } {
  return isRecord(value) && value.version === 2 && isRecord(value.mappings);
}

function isLegacyMappingFile(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  if ("version" in value || "mappings" in value) {
    return false;
  }

  return Object.keys(value).length > 0 || Object.values(value).some((entry) => typeof entry === "string" || isRecord(entry));
}

function normalizeMappings(value: unknown): MappingRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalizedEntries = Object.entries(value)
    .map(([conversationKey, raw]) => {
      const normalized = normalizeWindowRecord(raw);
      if (!normalized) {
        return null;
      }
      return [conversationKey, normalized] as const;
    })
    .filter((entry): entry is readonly [string, SessionWindowRecord] => entry !== null);

  return Object.fromEntries(normalizedEntries);
}

function trimMappings(value: MappingRecord, maxEntries: number): MappingRecord {
  const sorted = Object.entries(value).sort((a, b) => getWindowLastUsedAt(b[1]) - getWindowLastUsedAt(a[1]));
  return Object.fromEntries(sorted.slice(0, maxEntries));
}

function migrateVersion2Mappings(value: Record<string, unknown>): MappingRecord {
  const now = Date.now();
  const migratedEntries = Object.entries(value)
    .map(([conversationKey, raw]) => {
      if (typeof raw === "string") {
        return [conversationKey, createSingleWindow(raw, now, raw)] as const;
      }

      if (!isRecord(raw) || typeof raw.sessionId !== "string") {
        return null;
      }

      const lastUsedAt = typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : now;
      return [conversationKey, createSingleWindow(raw.sessionId, lastUsedAt, raw.sessionId)] as const;
    })
    .filter((entry): entry is readonly [string, SessionWindowRecord] => entry !== null);

  return Object.fromEntries(migratedEntries);
}

function migrateLegacyMappings(value: Record<string, unknown>): MappingRecord {
  const now = Date.now();
  const migratedEntries = Object.entries(value)
    .map(([conversationKey, raw]) => {
      if (typeof raw === "string") {
        return [conversationKey, createSingleWindow(raw, now, raw)] as const;
      }
      if (!isRecord(raw) || typeof raw.sessionId !== "string") {
        return null;
      }
      const lastUsedAt = typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : now;
      return [conversationKey, createSingleWindow(raw.sessionId, lastUsedAt, raw.sessionId)] as const;
    })
    .filter((entry): entry is readonly [string, SessionWindowRecord] => entry !== null);

  return Object.fromEntries(migratedEntries);
}

function normalizeWindowRecord(value: unknown): SessionWindowRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const mode = value.mode === "multi" ? "multi" : value.mode === "single" ? "single" : null;
  const rawSessions = Array.isArray(value.sessions) ? value.sessions : null;
  if (!mode || !rawSessions) {
    return null;
  }

  const now = Date.now();
  const seenSessionIds = new Set<string>();
  const sessions = rawSessions
    .map((raw) => normalizeSessionBindingRecord(raw, now))
    .filter((entry): entry is SessionBindingRecord => entry !== null)
    .filter((entry) => {
      if (seenSessionIds.has(entry.sessionId)) {
        return false;
      }
      seenSessionIds.add(entry.sessionId);
      return true;
    });

  if (sessions.length === 0) {
    return {
      mode,
      model: typeof value.model === "string" && value.model.trim().length > 0 ? value.model.trim() : null,
      activeSessionId: null,
      sessions: [],
    };
  }

  const activeSessionId = typeof value.activeSessionId === "string" && sessions.some((entry) => entry.sessionId === value.activeSessionId)
    ? value.activeSessionId
    : pickMostRecentSession(sessions)?.sessionId ?? null;

  return mode === "single"
    ? {
      mode,
      model: typeof value.model === "string" && value.model.trim().length > 0 ? value.model.trim() : null,
      activeSessionId,
      sessions: [findSessionById(sessions, activeSessionId) ?? pickMostRecentSession(sessions)!],
    }
    : {
      mode,
      model: typeof value.model === "string" && value.model.trim().length > 0 ? value.model.trim() : null,
      activeSessionId,
      sessions: sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt),
    };
}

function normalizeSessionBindingRecord(value: unknown, now: number): SessionBindingRecord | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    return null;
  }

  const lastUsedAt = typeof value.lastUsedAt === "number" ? value.lastUsedAt : now;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : lastUsedAt;
  const label = typeof value.label === "string" && value.label.trim().length > 0 ? value.label.trim() : value.sessionId;
  return {
    sessionId: value.sessionId,
    label,
    createdAt,
    lastUsedAt,
  };
}

function createSingleWindow(sessionId: string, now: number, label: string): SessionWindowRecord {
  return {
    mode: "single",
    model: null,
    activeSessionId: sessionId,
    sessions: [{
      sessionId,
      label,
      createdAt: now,
      lastUsedAt: now,
    }],
  };
}

function getWindowLastUsedAt(window: SessionWindowRecord): number {
  return window.sessions.reduce((max, session) => Math.max(max, session.lastUsedAt), 0);
}

function pickMostRecentSession(sessions: SessionBindingRecord[]): SessionBindingRecord | null {
  return [...sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null;
}

function findSessionById(sessions: SessionBindingRecord[], sessionId: string | null): SessionBindingRecord | null {
  if (!sessionId) {
    return null;
  }
  return sessions.find((session) => session.sessionId === sessionId) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
