/**
 * 职责: 持久化正在进行中的知识库摄入会话状态。
 * 关注点:
 * - 以 conversation 维度记录摄入锚点、请求人和消息关联信息。
 * - 为摄入恢复、续传和状态查询提供基础数据。
 */
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

  /** 读取并规范化当前活跃入库记录。 */
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

  /** 保存整批活跃入库记录。 */
  async saveRecords(records: ActiveKnowledgeIngestRecordMap): Promise<void> {
    await super.save({
      version: ACTIVE_KNOWLEDGE_INGEST_STORE_VERSION,
      records,
    } satisfies ActiveKnowledgeIngestFile);
  }
}

/** 判断对象是否符合 active ingest 存储结构。 */
function isStoreFile(value: unknown): value is ActiveKnowledgeIngestFile {
  return isRecord(value) && value.version === ACTIVE_KNOWLEDGE_INGEST_STORE_VERSION && isRecord(value.records);
}

/** 规范化单条 active ingest 记录。 */
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

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
