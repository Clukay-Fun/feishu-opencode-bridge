/**
 * 职责: 提供工作记忆留痕（Ledger）的本地存储层。
 * 关注点:
 * - ledger_events 表：只写不改的事件日志。
 * - 支持按时间、类型查询。
 * - 不实现自动归档或过期清理。
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type LedgerEventRow = {
  id: number;
  userId: string;
  scope: string;
  type: string;
  summary: string;
  relatedTaskId: number | null;
  relatedIssueUrl: string | null;
  createdAt: number;
};

export class LedgerDb {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

  appendEvent(input: {
    userId: string;
    scope?: string;
    type: string;
    summary: string;
    relatedTaskId?: number | null;
    relatedIssueUrl?: string | null;
  }): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO ledger_events (user_id, scope, type, summary, related_task_id, related_issue_url, created_at)
      VALUES (@userId, @scope, @type, @summary, @relatedTaskId, @relatedIssueUrl, @now)
    `).run({
      userId: input.userId,
      scope: input.scope ?? "user",
      type: input.type,
      summary: input.summary,
      relatedTaskId: input.relatedTaskId ?? null,
      relatedIssueUrl: input.relatedIssueUrl ?? null,
      now,
    });
    return Number(result.lastInsertRowid);
  }

  queryByTime(userId: string, options?: { since?: number; until?: number; limit?: number; scope?: string }): LedgerEventRow[] {
    const limit = options?.limit ?? 50;
    const since = options?.since ?? 0;
    const until = options?.until ?? Date.now();
    const scopeClause = buildScopeClause(options?.scope);
    return this.db.prepare(`
      SELECT id, user_id AS userId, scope, type, summary,
             related_task_id AS relatedTaskId, related_issue_url AS relatedIssueUrl,
             created_at AS createdAt
      FROM ledger_events
      WHERE user_id = @userId AND created_at >= @since AND created_at <= @until
        ${scopeClause.sql}
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ userId, since, until, limit, scope: scopeClause.scope }) as LedgerEventRow[];
  }

  queryByType(userId: string, type: string, limit = 50, options?: { scope?: string }): LedgerEventRow[] {
    const scopeClause = buildScopeClause(options?.scope);
    return this.db.prepare(`
      SELECT id, user_id AS userId, scope, type, summary,
             related_task_id AS relatedTaskId, related_issue_url AS relatedIssueUrl,
             created_at AS createdAt
      FROM ledger_events
      WHERE user_id = @userId AND type = @type
        ${scopeClause.sql}
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ userId, type, limit, scope: scopeClause.scope }) as LedgerEventRow[];
  }

  deleteUserEvents(userId: string): number {
    const result = this.db.prepare("DELETE FROM ledger_events WHERE user_id = @userId").run({ userId });
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        related_task_id INTEGER,
        related_issue_url TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_user_time
        ON ledger_events(user_id, created_at DESC);
    `);
  }
}

function buildScopeClause(scope: string | undefined): { sql: string; scope: string } {
  const normalized = scope?.trim() || "user";
  if (normalized === "user") {
    return { sql: "", scope: normalized };
  }
  return { sql: "AND scope IN ('user', @scope)", scope: normalized };
}
