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

  add(userId: string, facts: string[], sourceMessage: string): { saved: number } {
    const normalizedFacts = dedupeFacts(facts);
    if (normalizedFacts.length === 0) {
      return { saved: 0 };
    }

    const now = Date.now();
    const sourcePreview = truncateSourcePreview(sourceMessage, this.sourcePreviewLength);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memories (user_id, fact, source_message, created_at, accessed_at)
      VALUES (@userId, @fact, @sourceMessage, @now, @now)
    `);
    const touch = this.db.prepare(`
      UPDATE memories
      SET accessed_at = @now
      WHERE user_id = @userId AND fact = @fact
    `);
    const transaction = this.db.transaction((rows: string[]) => {
      let saved = 0;
      for (const fact of rows) {
        const result = insert.run({ userId, fact, sourceMessage: sourcePreview, now });
        if (result.changes > 0) {
          saved += 1;
          continue;
        }
        touch.run({ userId, fact, now });
      }
      this.evict(userId);
      return { saved };
    });

    return transaction(normalizedFacts);
  }

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

    if (rows.length > 0) {
      const now = Date.now();
      const ids = rows.map((row) => row.id);
      this.db.prepare(`
        UPDATE memories
        SET accessed_at = ${now}
        WHERE id IN (${ids.map(() => "?").join(",")})
      `).run(...ids);
    }

    return rows.map((row) => row.fact);
  }

  close(): void {
    this.db.close();
  }

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
  }

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

function dedupeFacts(facts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fact of facts.map((fact) => fact.trim()).filter(Boolean)) {
    if (seen.has(fact)) {
      continue;
    }
    seen.add(fact);
    result.push(fact);
  }
  return result;
}
