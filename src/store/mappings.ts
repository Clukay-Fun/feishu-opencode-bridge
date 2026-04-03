import { JsonStore } from "./json-store.js";

export type SessionBindingRecord = {
  sessionId: string;
  lastUsedAt: number;
};

export type MappingRecord = Record<string, SessionBindingRecord>;

export class MappingStore extends JsonStore<MappingRecord> {
  constructor(dataDir: string, fileName: string, private readonly maxEntries = 200) {
    super(dataDir, fileName, {});
  }

  override async load(): Promise<MappingRecord> {
    const loaded = await super.load();
    return normalizeMappings(loaded);
  }

  override async save(value: MappingRecord): Promise<void> {
    await super.save(trimMappings(normalizeMappings(value), this.maxEntries));
  }
}

function normalizeMappings(value: unknown): MappingRecord {
  if (!isRecord(value)) {
    return {};
  }

  const now = Date.now();
  const normalizedEntries = Object.entries(value)
    .map(([chatId, raw]) => {
      if (typeof raw === "string") {
        return [chatId, { sessionId: raw, lastUsedAt: now }] as const;
      }

      if (!isRecord(raw) || typeof raw.sessionId !== "string") {
        return null;
      }

      return [
        chatId,
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
