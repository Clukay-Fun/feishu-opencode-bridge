import { JsonStore } from "./json-store.js";

export type ActiveKnowledgeIngestRecord = {
  chatId: string;
  chatType: string;
  conversationKey: string;
  requesterOpenId: string;
  rootMessageId: string;
  anchorMessageId: string;
  deliveryMode: "group_thread" | "p2p_reply";
  ingestSessionId?: string | undefined;
  previousActiveSessionId?: string | null | undefined;
  expiresAt: number;
};

export type ActiveKnowledgeIngestRecordMap = Record<string, ActiveKnowledgeIngestRecord>;

type ActiveKnowledgeIngestFile = {
  version: 1;
  records: ActiveKnowledgeIngestRecordMap;
};

const ACTIVE_KNOWLEDGE_INGEST_STORE_VERSION = 1 as const;

export class ActiveKnowledgeIngestStore extends JsonStore<unknown> {
  constructor(dataDir: string, fileName = "active-knowledge-ingests.json") {
    super(dataDir, fileName, { version: ACTIVE_KNOWLEDGE_INGEST_STORE_VERSION, records: {} } satisfies ActiveKnowledgeIngestFile);
  }

  override async load(): Promise<ActiveKnowledgeIngestRecordMap> {
    const loaded = await super.load();
    if (!isStoreFile(loaded)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(loaded.records)
        .map(([conversationKey, record]) => [conversationKey, normalizeRecord(record)] as const)
        .filter((entry): entry is readonly [string, ActiveKnowledgeIngestRecord] => entry[1] !== null),
    );
  }

  async saveRecords(records: ActiveKnowledgeIngestRecordMap): Promise<void> {
    await super.save({
      version: ACTIVE_KNOWLEDGE_INGEST_STORE_VERSION,
      records,
    } satisfies ActiveKnowledgeIngestFile);
  }
}

function isStoreFile(value: unknown): value is ActiveKnowledgeIngestFile {
  return isRecord(value) && value.version === ACTIVE_KNOWLEDGE_INGEST_STORE_VERSION && isRecord(value.records);
}

function normalizeRecord(value: unknown): ActiveKnowledgeIngestRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.chatId !== "string"
    || typeof value.chatType !== "string"
    || typeof value.conversationKey !== "string"
    || typeof value.requesterOpenId !== "string"
    || typeof value.rootMessageId !== "string"
    || typeof value.anchorMessageId !== "string"
    || (value.deliveryMode !== "group_thread" && value.deliveryMode !== "p2p_reply")
    || typeof value.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    chatId: value.chatId,
    chatType: value.chatType,
    conversationKey: value.conversationKey,
    requesterOpenId: value.requesterOpenId,
    rootMessageId: value.rootMessageId,
    anchorMessageId: value.anchorMessageId,
    deliveryMode: value.deliveryMode,
    ingestSessionId: typeof value.ingestSessionId === "string" ? value.ingestSessionId : undefined,
    previousActiveSessionId: typeof value.previousActiveSessionId === "string" ? value.previousActiveSessionId : value.previousActiveSessionId === null ? null : undefined,
    expiresAt: value.expiresAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
