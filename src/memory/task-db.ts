/**
 * 职责: 提供工作记忆任务 / 提醒 / Checklist 的本地存储层。
 * 关注点:
 * - work_tasks 表：待办、提醒、状态流转（todo → doing → done / canceled）。
 * - checklists 表：一次性或可复用检查清单。
 * - 仅暴露 CRUD，不实现状态流转逻辑、到期检测或自动归档。
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type WorkTaskRow = {
  id: number;
  userId: string;
  scope: string;
  title: string;
  status: string;
  dueAt: number | null;
  source: string | null;
  relatedMemoryIds: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ChecklistRow = {
  id: number;
  userId: string;
  scope: string;
  name: string;
  reusable: number;
  items: string;
  createdAt: number;
  updatedAt: number;
};

export class TaskDb {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

  // #region work_tasks

  createTask(input: {
    userId: string;
    scope?: string;
    title: string;
    status?: string;
    dueAt?: number | null;
    source?: string | null;
    relatedMemoryIds?: number[];
  }): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO work_tasks (user_id, scope, title, status, due_at, source, related_memory_ids, created_at, updated_at)
      VALUES (@userId, @scope, @title, @status, @dueAt, @source, @relatedMemoryIds, @now, @now)
    `).run({
      userId: input.userId,
      scope: input.scope ?? "user",
      title: input.title,
      status: input.status ?? "todo",
      dueAt: input.dueAt ?? null,
      source: input.source ?? null,
      relatedMemoryIds: input.relatedMemoryIds ? JSON.stringify(input.relatedMemoryIds) : null,
      now,
    });
    return Number(result.lastInsertRowid);
  }

  getTask(id: number): WorkTaskRow | undefined {
    return this.db.prepare(`
      SELECT id, user_id AS userId, scope, title, status, due_at AS dueAt, source,
             related_memory_ids AS relatedMemoryIds, created_at AS createdAt, updated_at AS updatedAt
      FROM work_tasks WHERE id = @id
    `).get({ id }) as WorkTaskRow | undefined;
  }

  listTasks(userId: string, options?: { status?: string; limit?: number; scope?: string }): WorkTaskRow[] {
    const limit = options?.limit ?? 50;
    const scopeClause = buildScopeClause(options?.scope);
    if (options?.status) {
      return this.db.prepare(`
        SELECT id, user_id AS userId, scope, title, status, due_at AS dueAt, source,
               related_memory_ids AS relatedMemoryIds, created_at AS createdAt, updated_at AS updatedAt
        FROM work_tasks
        WHERE user_id = @userId AND status = @status
          ${scopeClause.sql}
        ORDER BY due_at ASC NULLS LAST, created_at DESC
        LIMIT @limit
      `).all({ userId, status: options.status, limit, scope: scopeClause.scope }) as WorkTaskRow[];
    }
    return this.db.prepare(`
      SELECT id, user_id AS userId, scope, title, status, due_at AS dueAt, source,
             related_memory_ids AS relatedMemoryIds, created_at AS createdAt, updated_at AS updatedAt
      FROM work_tasks
      WHERE user_id = @userId
        ${scopeClause.sql}
      ORDER BY due_at ASC NULLS LAST, created_at DESC
      LIMIT @limit
    `).all({ userId, limit, scope: scopeClause.scope }) as WorkTaskRow[];
  }

  updateTask(id: number, updates: {
    title?: string;
    status?: string;
    dueAt?: number | null;
    source?: string | null;
    relatedMemoryIds?: number[] | null;
  }): void {
    const now = Date.now();
    const existing = this.getTask(id);
    if (!existing) {
      return;
    }
    this.db.prepare(`
      UPDATE work_tasks
      SET title = @title, status = @status, due_at = @dueAt, source = @source,
          related_memory_ids = @relatedMemoryIds, updated_at = @now
      WHERE id = @id
    `).run({
      id,
      title: updates.title ?? existing.title,
      status: updates.status ?? existing.status,
      dueAt: updates.dueAt !== undefined ? updates.dueAt : existing.dueAt,
      source: updates.source !== undefined ? updates.source : existing.source,
      relatedMemoryIds: updates.relatedMemoryIds !== undefined
        ? (updates.relatedMemoryIds ? JSON.stringify(updates.relatedMemoryIds) : null)
        : existing.relatedMemoryIds,
      now,
    });
  }

  deleteTask(id: number): boolean {
    const result = this.db.prepare("DELETE FROM work_tasks WHERE id = @id").run({ id });
    return result.changes > 0;
  }

  deleteUserTasks(userId: string): number {
    const result = this.db.prepare("DELETE FROM work_tasks WHERE user_id = @userId").run({ userId });
    return result.changes;
  }

  // #endregion

  // #region checklists

  createChecklist(input: {
    userId: string;
    scope?: string;
    name: string;
    reusable?: boolean;
    items: Array<{ text: string; checked?: boolean }>;
  }): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO checklists (user_id, scope, name, reusable, items, created_at, updated_at)
      VALUES (@userId, @scope, @name, @reusable, @items, @now, @now)
    `).run({
      userId: input.userId,
      scope: input.scope ?? "user",
      name: input.name,
      reusable: input.reusable ? 1 : 0,
      items: JSON.stringify(input.items),
      now,
    });
    return Number(result.lastInsertRowid);
  }

  getChecklist(id: number): ChecklistRow | undefined {
    return this.db.prepare(`
      SELECT id, user_id AS userId, scope, name, reusable, items, created_at AS createdAt, updated_at AS updatedAt
      FROM checklists WHERE id = @id
    `).get({ id }) as ChecklistRow | undefined;
  }

  listChecklists(userId: string, limit = 20, options?: { scope?: string }): ChecklistRow[] {
    const scopeClause = buildScopeClause(options?.scope);
    return this.db.prepare(`
      SELECT id, user_id AS userId, scope, name, reusable, items, created_at AS createdAt, updated_at AS updatedAt
      FROM checklists
      WHERE user_id = @userId
        ${scopeClause.sql}
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ userId, limit, scope: scopeClause.scope }) as ChecklistRow[];
  }

  updateChecklist(id: number, updates: {
    name?: string;
    items?: Array<{ text: string; checked?: boolean }>;
  }): void {
    const now = Date.now();
    const existing = this.getChecklist(id);
    if (!existing) {
      return;
    }
    this.db.prepare(`
      UPDATE checklists
      SET name = @name, items = @items, updated_at = @now
      WHERE id = @id
    `).run({
      id,
      name: updates.name ?? existing.name,
      items: updates.items ? JSON.stringify(updates.items) : existing.items,
      now,
    });
  }

  deleteChecklist(id: number): boolean {
    const result = this.db.prepare("DELETE FROM checklists WHERE id = @id").run({ id });
    return result.changes > 0;
  }

  deleteUserChecklists(userId: string): number {
    const result = this.db.prepare("DELETE FROM checklists WHERE user_id = @userId").run({ userId });
    return result.changes;
  }

  // #endregion

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        due_at INTEGER,
        source TEXT,
        related_memory_ids TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_user_status
        ON work_tasks(user_id, status, due_at);

      CREATE TABLE IF NOT EXISTS checklists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        name TEXT NOT NULL,
        reusable INTEGER NOT NULL DEFAULT 0,
        items TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
