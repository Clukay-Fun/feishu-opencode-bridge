/**
 * 职责: 提供基于最近访问时间的记忆检索实现。
 * 关注点:
 * - 按最近访问顺序返回限定数量的记忆。
 * - 作为无需 embedding 的轻量召回策略。
 */
import type { MemoryDb } from "./db.js";
import type { MemoryRetriever } from "./retriever.js";

export class RecentRetriever implements MemoryRetriever {
  constructor(private readonly db: MemoryDb) {}

  /** 直接按最近访问时间返回记忆，并刷新 accessedAt。 */
  async recall(userId: string, _query: string, limit: number, options?: { scope?: string }): Promise<string[]> {
    const rows = this.db.listRecent(userId, limit, options?.scope);
    this.db.touch(rows.map((row) => row.id));
    return rows.map((row) => row.fact);
  }
}
