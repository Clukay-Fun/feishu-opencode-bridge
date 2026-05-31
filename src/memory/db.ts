/**
 * 职责: 提供记忆模块的本地存储层。
 * 关注点:
 * - 持久化用户事实及其访问时间。
 * - 支持新增、查询、触碰更新时间等基础操作。
 * - v2 扩展：scope / kind / confidence / status / expires_at / superseded_by 字段，
 *   迁移幂等，旧数据自动取默认值。
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
  scope: string;
  kind: string;
  confidence: number;
  status: string;
  expiresAt: number | null;
  supersededBy: number | null;
};

export type MemoryFactRecord = {
  id: number;
  fact: string;
  createdAt: number;
  accessedAt: number;
  scope: string;
  kind: string;
  confidence: number;
  status: string;
};

type MemoryEmbeddingCandidate = {
  id: number;
  fact: string;
  embedding: number[];
};

export type SaveMemoryFactInput = {
  fact: string;
  sourceMessage: string;
  scope?: string;
  kind?: string;
  confidence?: number;
  status?: string;
  expiresAt?: number | null;
  supersededBy?: number | null;
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
  saveFacts(userId: string, facts: SaveMemoryFactInput[]): number[] {
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
        scope,
        kind,
        confidence,
        status,
        expires_at,
        superseded_by,
        embedding_model,
        embedding_json
      )
      VALUES (
        @userId,
        @fact,
        @sourceMessage,
        @now,
        @now,
        @scope,
        @kind,
        @confidence,
        @status,
        @expiresAt,
        @supersededBy,
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
    const transaction = this.db.transaction((rows: SaveMemoryFactInput[]) => {
      for (const row of rows) {
        const insertResult = insert.run({
          userId,
          fact: row.fact,
          sourceMessage: row.sourceMessage,
          now,
          scope: normalizeScope(row.scope),
          kind: row.kind ?? "fact",
          confidence: clampConfidence(row.confidence ?? 0.8),
          status: row.status ?? "active",
          expiresAt: row.expiresAt ?? null,
          supersededBy: row.supersededBy ?? null,
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
  listEmbeddingCandidates(userId: string, model: string, scope?: string): MemoryEmbeddingCandidate[] {
    const scopeClause = buildScopeClause(scope);
    const rows = this.db.prepare(`
      SELECT id, fact, embedding_json
      FROM memories
      WHERE user_id = @userId
        AND embedding_model = @model
        AND embedding_json IS NOT NULL
        ${scopeClause.sql}
      ORDER BY accessed_at DESC, id DESC
    `).all({ userId, model, scope: scopeClause.scope }) as Array<{
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
  listRecent(userId: string, limit: number, scope?: string): MemoryFactRecord[] {
    const scopeClause = buildScopeClause(scope);
    return this.db.prepare(`
      SELECT id, fact, created_at AS createdAt, accessed_at AS accessedAt, scope, kind, confidence, status
      FROM memories
      WHERE user_id = @userId
        ${scopeClause.sql}
      ORDER BY accessed_at DESC, id DESC
      LIMIT @limit
    `).all({ userId, limit, scope: scopeClause.scope }) as MemoryFactRecord[];
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

  /** 删除指定用户的全部记忆，返回删除条数。 */
  deleteUser(userId: string): number {
    const result = this.db.prepare(`
      DELETE FROM memories
      WHERE user_id = @userId
    `).run({ userId });
    return result.changes;
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
  listFactsForUser(userId: string, scope?: string): MemoryFactRecord[] {
    const scopeClause = buildScopeClause(scope);
    return this.db.prepare(`
      SELECT id, fact, created_at AS createdAt, accessed_at AS accessedAt, scope, kind, confidence, status
      FROM memories
      WHERE user_id = @userId
        ${scopeClause.sql}
      ORDER BY accessed_at DESC, id DESC
    `).all({ userId, scope: scopeClause.scope }) as MemoryFactRecord[];
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

    // v1 → v2 迁移：增量添加新字段，幂等
    const columns = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("embedding_model")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN embedding_model TEXT");
    }
    if (!columnNames.has("embedding_json")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN embedding_json TEXT");
    }
    if (!columnNames.has("scope")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'user'");
    }
    if (!columnNames.has("kind")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'");
    }
    if (!columnNames.has("confidence")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.8");
    }
    if (!columnNames.has("status")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
    if (!columnNames.has("expires_at")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN expires_at INTEGER");
    }
    if (!columnNames.has("superseded_by")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id)");
    }

    // v2 索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_user_kind
        ON memories(user_id, kind, status);

      CREATE TABLE IF NOT EXISTS memory_settings (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `);
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
  facts: SaveMemoryFactInput[],
  sourcePreviewLength: number,
): SaveMemoryFactInput[] {
  const seen = new Set<string>();
  const result: SaveMemoryFactInput[] = [];
  for (const item of facts) {
    const fact = item.fact.trim();
    if (!fact || seen.has(fact)) {
      continue;
    }
    seen.add(fact);
    result.push({
      ...item,
      fact,
      sourceMessage: truncateSourcePreview(item.sourceMessage, sourcePreviewLength),
    });
  }
  return result;
}

function normalizeScope(scope: string | undefined): string {
  const normalized = scope?.trim();
  return normalized || "user";
}

function buildScopeClause(scope: string | undefined): { sql: string; scope: string } {
  const normalized = normalizeScope(scope);
  if (normalized === "user") {
    return { sql: "", scope: normalized };
  }
  return { sql: "AND scope IN ('user', @scope)", scope: normalized };
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
