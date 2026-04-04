import { JsonStore } from "./json-store.js";

export type SessionBindingRecord = {
  sessionId: string;
  lastUsedAt: number;
};

export type MappingRecord = Record<string, SessionBindingRecord>;

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type MappingFile = {
  version: 2;
  mappings: MappingRecord;
};

const MAPPING_STORE_VERSION = 2 as const;

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

    if (isLegacyMappingFile(loaded)) {
      this.logger?.log("store/mappings", "mapping store 格式升级，已重置", {}, "warn");
      await super.save({ version: MAPPING_STORE_VERSION, mappings: {} } satisfies MappingFile);
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

function isLegacyMappingFile(value: unknown): boolean {
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

  const now = Date.now();
  const normalizedEntries = Object.entries(value)
    .map(([conversationKey, raw]) => {
      if (typeof raw === "string") {
        return [conversationKey, { sessionId: raw, lastUsedAt: now }] as const;
      }

      if (!isRecord(raw) || typeof raw.sessionId !== "string") {
        return null;
      }

      return [
        conversationKey,
        {
          sessionId: raw.sessionId,
          lastUsedAt: typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : now,
        },
      ] as const;
    })
    .filter((entry): entry is readonly [string, SessionBindingRecord] => entry !== null);

  return Object.fromEntries(normalizedEntries);
}

function trimMappings(value: MappingRecord, maxEntries: number): MappingRecord {
  const sorted = Object.entries(value).sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
  return Object.fromEntries(sorted.slice(0, maxEntries));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
