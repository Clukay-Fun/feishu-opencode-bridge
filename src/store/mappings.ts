/**
 * 职责: 持久化聊天窗口与会话绑定关系。
 * 关注点:
 * - 保存窗口模式、当前活跃会话和历史会话列表。
 * - 支持本地存储版本迁移与兼容读取。
 */
import { JsonStore } from "./json-store.js";

export type SessionMode = "single" | "multi";
export type InteractionMode = "default" | "knowledge";

export type SessionBindingRecord = {
  sessionId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
};

export type SessionWindowModelOverride = {
  providerID: string;
  modelID: string;
};

export type SessionWindowRecord = {
  mode: SessionMode;
  interactionMode?: InteractionMode;
  modelOverride?: SessionWindowModelOverride | undefined;
  activeSessionId: string | null;
  sessions: SessionBindingRecord[];
};

export type MappingRecord = Record<string, SessionWindowRecord>;

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type MappingFile = {
  version: 4;
  mappings: MappingRecord;
};

const MAPPING_STORE_VERSION = 4 as const;

export class MappingStore extends JsonStore<unknown> {
  constructor(
    dataDir: string,
    fileName: string,
    private readonly maxEntries = 200,
    private readonly logger?: LoggerLike,
  ) {
    super(dataDir, fileName, { version: MAPPING_STORE_VERSION, mappings: {} } satisfies MappingFile);
  }

  //#region Persistence API
  // Load mappings from disk and migrate older layouts into the current schema.
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

    if (isVersion3MappingFile(loaded)) {
      const migrated = trimMappings(normalizeMappings(loaded.mappings), this.maxEntries);
      this.logger?.log("store/mappings", "mapping store 格式升级，已迁移", { fromVersion: 3 }, "warn");
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

  // Save mappings back to disk after normalizing and trimming old window entries.
  override async save(value: MappingRecord): Promise<void> {
    await super.save({
      version: MAPPING_STORE_VERSION,
      mappings: trimMappings(normalizeMappings(value), this.maxEntries),
    } satisfies MappingFile);
  }
  //#endregion
}

//#region Schema guards
// Detect the current versioned mapping file shape.
function isMappingFile(value: unknown): value is MappingFile {
  return isRecord(value) && value.version === MAPPING_STORE_VERSION && isRecord(value.mappings);
}

// Detect version 2 mapping payloads for migration.
function isVersion2MappingFile(value: unknown): value is { version: 2; mappings: Record<string, unknown> } {
  return isRecord(value) && value.version === 2 && isRecord(value.mappings);
}

// Detect version 3 mapping payloads for migration.
function isVersion3MappingFile(value: unknown): value is { version: 3; mappings: Record<string, unknown> } {
  return isRecord(value) && value.version === 3 && isRecord(value.mappings);
}

// Detect the earliest unversioned mapping format.
function isLegacyMappingFile(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  if ("version" in value || "mappings" in value) {
    return false;
  }

  return Object.keys(value).length > 0 || Object.values(value).some((entry) => typeof entry === "string" || isRecord(entry));
}
//#endregion

//#region Normalization and migration
// Normalize arbitrary mapping data into the runtime window record shape.
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

// Keep only the most recently used windows to bound local storage size.
function trimMappings(value: MappingRecord, maxEntries: number): MappingRecord {
  const sorted = Object.entries(value).sort((a, b) => getWindowLastUsedAt(b[1]) - getWindowLastUsedAt(a[1]));
  return Object.fromEntries(sorted.slice(0, maxEntries));
}

// Upgrade version 2 records into the current session-window structure.
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

// Upgrade pre-versioned records into the current session-window structure.
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

// Normalize one window record and repair invalid active-session references.
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
      interactionMode: normalizeInteractionMode(value.interactionMode),
      modelOverride: normalizeModelOverride(value.modelOverride),
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
      interactionMode: normalizeInteractionMode(value.interactionMode),
      modelOverride: normalizeModelOverride(value.modelOverride),
      activeSessionId,
      sessions: [findSessionById(sessions, activeSessionId) ?? pickMostRecentSession(sessions)!],
    }
    : {
      mode,
      interactionMode: normalizeInteractionMode(value.interactionMode),
      modelOverride: normalizeModelOverride(value.modelOverride),
      activeSessionId,
      sessions: sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt),
    };
}

// Normalize one session binding entry and backfill timestamps or labels.
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

// Build a single-session window record for migrated legacy data.
function createSingleWindow(sessionId: string, now: number, label: string): SessionWindowRecord {
  return {
    mode: "single",
    interactionMode: "default",
    activeSessionId: sessionId,
    sessions: [{
      sessionId,
      label,
      createdAt: now,
      lastUsedAt: now,
    }],
  };
}

// Normalize interaction mode values and default unknown values safely.
function normalizeInteractionMode(value: unknown): InteractionMode {
  return value === "knowledge" ? "knowledge" : "default";
}

function normalizeModelOverride(value: unknown): SessionWindowModelOverride | undefined {
  if (!isRecord(value) || typeof value.providerID !== "string" || typeof value.modelID !== "string") {
    return undefined;
  }
  const providerID = value.providerID.trim();
  const modelID = value.modelID.trim();
  if (!providerID || !modelID) {
    return undefined;
  }
  return { providerID, modelID };
}

// Read the latest session activity timestamp from a window record.
function getWindowLastUsedAt(window: SessionWindowRecord): number {
  return window.sessions.reduce((max, session) => Math.max(max, session.lastUsedAt), 0);
}

// Pick the most recently used session from a candidate list.
function pickMostRecentSession(sessions: SessionBindingRecord[]): SessionBindingRecord | null {
  return [...sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null;
}

// Find a session by id within one window record.
function findSessionById(sessions: SessionBindingRecord[], sessionId: string | null): SessionBindingRecord | null {
  if (!sessionId) {
    return null;
  }
  return sessions.find((session) => session.sessionId === sessionId) ?? null;
}

// Narrow unknown JSON values to plain records.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
//#endregion
