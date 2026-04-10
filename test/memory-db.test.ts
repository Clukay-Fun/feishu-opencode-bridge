import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { MemoryDb } from "../src/memory/db.js";

describe("MemoryDb", () => {
  it("dedupes by userId and fact while truncating source previews", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-memory-db-"));
    const dbPath = path.join(dir, "memory.db");
    const db = new MemoryDb(dbPath, 10, 10);

    db.add("u1", ["用户偏好 TypeScript", "用户偏好 TypeScript"], "0123456789abcdef");

    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.prepare("SELECT fact, source_message FROM memories").all() as Array<{ fact: string; source_message: string }>;
    expect(rows).toEqual([{ fact: "用户偏好 TypeScript", source_message: "0123456789" }]);

    raw.close();
    db.close();
  });

  it("searches memories within the current user only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-memory-db-"));
    const dbPath = path.join(dir, "memory.db");
    const db = new MemoryDb(dbPath, 10, 50);

    db.add("u1", ["user likes typescript", "user uses vitest"], "source 1");
    db.add("u2", ["user likes typescript"], "source 2");

    expect(db.search("u1", "typescript", 5)).toEqual(["user likes typescript"]);
    expect(db.search("u2", "typescript", 5)).toEqual(["user likes typescript"]);
    expect(db.search("u1", "nonexistent", 5)).toEqual([]);

    db.close();
  });

  it("evicts least recently accessed facts when over the per-user limit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-memory-db-"));
    const dbPath = path.join(dir, "memory.db");
    const db = new MemoryDb(dbPath, 2, 50);

    db.add("u1", ["fact one"], "source 1");
    db.add("u1", ["fact two"], "source 2");
    db.add("u1", ["fact three"], "source 3");

    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ?").get("u1") as { count: number };
    expect(row.count).toBe(2);

    raw.close();
    db.close();
  });
});
