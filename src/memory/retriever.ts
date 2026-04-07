export interface MemoryRetriever {
  recall(userId: string, query: string, limit: number): Promise<string[]>;
}
