/**
 * 职责: 定义记忆召回策略的统一接口。
 * 关注点:
 * - 约束不同检索实现对外暴露的 recall 能力。
 */
export interface MemoryRetriever {
  // Recall up to `limit` memory snippets relevant to the current user query.
  recall(userId: string, query: string, limit: number): Promise<string[]>;
}
