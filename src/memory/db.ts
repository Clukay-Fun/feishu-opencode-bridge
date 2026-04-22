/**
 * 职责: 提供记忆模块的本地存储层。
 * 关注点:
 * - 持久化用户事实及其访问时间。
 * - 支持新增、查询、触碰更新时间等基础操作。
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type MemoryRow = {
  id: number;
  userId: string;
  fact: string;
  sourceMessage: string;
  createdAt: number;
  accessedAt: number;
};

export type MemoryFactRecord = {
  id: number;
  fact: string;
  createdAt: number;
  accessedAt: number;
};

type MemoryEmbeddingCandidate = {
  id: number;
  fact: string;
  embedding: number[];
};

export class MemoryDb {
  private readonly db: Database.Database;

  constructor(
    dbPath: string,
    private readonly maxMemoriesPerUser: number,
    private readonly sourcePreviewLength: number,
  ) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

  // #region 写入与更新

  /** 兼容旧接口：批量保存 facts 并返回保存数量。 */
  add(userId: string, facts: string[], sourceMessage: string): { saved: number } {
    const ids = this.saveFacts(
      userId,
      facts.map((fact) => ({ fact, sourceMessage })),
    );
    return { saved: ids.length };
  }

  /** 批量写入事实；重复事实只更新时间，不重复插入。 */
  saveFacts(userId: string, facts: Array<{ fact: string; sourceMessage: string }>): number[] {
    const normalizedFacts = dedupeFactEntries(facts, this.sourcePreviewLength);
    if (normalizedFacts.length === 0) {
      return [];
    }

    const now = Date.now();
    const ids: number[] = [];
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memories (
        user_id,
        fact,
        source_message,
        created_at,
        accessed_at,
        embedding_model,
        embedding_json
      )
      VALUES (
        @userId,
        @fact,
        @sourceMessage,
        @now,
        @now,
        NULL,
        NULL
      )
    `);
    const selectId = this.db.prepare(`
      SELECT id
      FROM memories
      WHERE user_id = @userId AND fact = @fact
    `);
    const touchExisting = this.db.prepare(`
      UPDATE memories
      SET accessed_at = @now
      WHERE user_id = @userId AND fact = @fact
    `);
    const transaction = this.db.transaction((rows: Array<{ fact: string; sourceMessage: string }>) => {
      for (const row of rows) {
        const insertResult = insert.run({
          userId,
          fact: row.fact,
          sourceMessage: row.sourceMessage,
          now,
        });
        if (insertResult.changes === 0) {
          touchExisting.run({ userId, fact: row.fact, now });
        }
        const record = selectId.get({ userId, fact: row.fact }) as { id: number } | undefined;
        if (record) {
          ids.push(record.id);
        }
      }
      this.evict(userId);
    });

    transaction(normalizedFacts);
    return ids;
  }

  /** 为指定记忆写入 embedding 与模型名。 */
  updateEmbedding(id: number, embedding: number[], model: string): void {
    this.db.prepare(`
      UPDATE memories
      SET embedding_model = @model,
          embedding_json = @embedding
      WHERE id = @id
    `).run({
      id,
      model,
      embedding: JSON.stringify(embedding),
    });
  }

  // #endregion

  // #region 查询

  /** 返回具备 embedding 的召回候选。 */
  listEmbeddingCandidates(userId: string, model: string): MemoryEmbeddingCandidate[] {
    const rows = this.db.prepare(`
      SELECT id, fact, embedding_json
      FROM memories
      WHERE user_id = @userId
        AND embedding_model = @model
        AND embedding_json IS NOT NULL
      ORDER BY accessed_at DESC, id DESC
    `).all({ userId, model }) as Array<{
      id: number;
      fact: string;
      embedding_json: string | null;
    }>;

    return rows.flatMap((row) => {
      if (!row.embedding_json) {
        return [];
      }
      try {
        const embedding = JSON.parse(row.embedding_json) as unknown;
        if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
          return [];
        }
        return [{ id: row.id, fact: row.fact, embedding: embedding as number[] }];
      } catch {
        return [];
      }
    });
  }

  /** 返回最近访问的记忆。 */
  listRecent(userId: string, limit: number): MemoryFactRecord[] {
    return this.db.prepare(`
      SELECT id, fact, created_at, accessed_at
      FROM memories
      WHERE user_id = @userId
      ORDER BY accessed_at DESC, id DESC
      LIMIT @limit
    `).all({ userId, limit }) as MemoryFactRecord[];
  }

  /** 更新若干记忆的 accessedAt 时间。 */
  touch(ids: number[]): void {
    if (ids.length === 0) {
      return;
    }
    const now = Date.now();
    this.db.prepare(`
      UPDATE memories
      SET accessed_at = ${now}
      WHERE id IN (${ids.map(() => "?").join(",")})
    `).run(...ids);
  }

  /** 列出当前有记忆数据的所有用户。 */
  listUsers(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT user_id
      FROM memories
      ORDER BY user_id ASC
    `).all() as Array<{ user_id: string }>;
    return rows.map((row) => row.user_id);
  }

  /** 列出指定用户的所有记忆。 */
  listFactsForUser(userId: string): MemoryFactRecord[] {
    return this.db.prepare(`
      SELECT id, fact, created_at, accessed_at
      FROM memories
      WHERE user_id = @userId
      ORDER BY accessed_at DESC, id DESC
    `).all({ userId }) as MemoryFactRecord[];
  }

  /** 读取 Obsidian 最近一次同步时间。 */
  getObsidianLastSyncedAt(): number | null {
    const row = this.db.prepare(`
      SELECT value
      FROM metadata
      WHERE key = 'obsidian_last_synced_at'
    `).get() as { value: string } | undefined;
    if (!row) {
      return null;
    }
    const value = Number(row.value);
    return Number.isFinite(value) ? value : null;
  }

  /** 更新 Obsidian 最近一次同步时间。 */
  setObsidianLastSyncedAt(timestamp: number): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value)
      VALUES ('obsidian_last_synced_at', @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ value: String(timestamp) });
  }

  /** 使用 FTS 在用户记忆中做关键词搜索。 */
  search(userId: string, query: string, limit: number): string[] {
    const sanitizedQuery = sanitizeSearchQuery(query);
    if (!sanitizedQuery) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT m.id, m.fact
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH @query
        AND m.user_id = @userId
      ORDER BY bm25(memories_fts), m.accessed_at DESC
      LIMIT @limit
    `).all({ query: sanitizedQuery, userId, limit }) as Array<{ id: number; fact: string }>;

    this.touch(rows.map((row) => row.id));
    return rows.map((row) => row.fact);
  }

  // #endregion

  /** 关闭数据库连接。 */
  close(): void {
    this.db.close();
  }

  /** 初始化表结构、索引和 FTS 同步触发器。 */
  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        source_message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_user_fact
        ON memories(user_id, fact);

      CREATE INDEX IF NOT EXISTS idx_memories_user_accessed
        ON memories(user_id, accessed_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, fact) VALUES (new.id, new.fact);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF fact ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
        INSERT INTO memories_fts(rowid, fact) VALUES (new.id, new.fact);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
      END;
    `);

    const columns = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("embedding_model")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN embedding_model TEXT");
    }
    if (!columnNames.has("embedding_json")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN embedding_json TEXT");
    }
  }

  /** 控制单用户记忆上限，淘汰最久未访问的记录。 */
  private evict(userId: string): void {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM memories
      WHERE user_id = ?
    `).get(userId) as { count: number };

    if (row.count <= this.maxMemoriesPerUser) {
      return;
    }

    const toDelete = Math.max(1, Math.ceil(this.maxMemoriesPerUser * 0.2));
    this.db.prepare(`
      DELETE FROM memories
      WHERE id IN (
        SELECT id
        FROM memories
        WHERE user_id = ?
        ORDER BY accessed_at ASC
        LIMIT ?
      )
    `).run(userId, toDelete);
  }
}

function sanitizeSearchQuery(query: string): string {
  return query
    .replace(/["'*:()-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function truncateSourcePreview(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function dedupeFactEntries(
  facts: Array<{ fact: string; sourceMessage: string }>,
  sourcePreviewLength: number,
): Array<{ fact: string; sourceMessage: string }> {
  const seen = new Set<string>();
  const result: Array<{ fact: string; sourceMessage: string }> = [];
  for (const item of facts) {
    const fact = item.fact.trim();
    if (!fact || seen.has(fact)) {
      continue;
    }
    seen.add(fact);
    result.push({
      fact,
      sourceMessage: truncateSourcePreview(item.sourceMessage, sourcePreviewLength),
    });
  }
  return result;
}
