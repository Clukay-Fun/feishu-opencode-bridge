import type { MemoryDb } from "./db.js";
import type { MemoryRetriever } from "./retriever.js";

export class RecentRetriever implements MemoryRetriever {
  constructor(private readonly db: MemoryDb) {}

  async recall(userId: string, _query: string, limit: number): Promise<string[]> {
    const rows = this.db.listRecent(userId, limit);
    this.db.touch(rows.map((row) => row.id));
    return rows.map((row) => row.fact);
  }
}
