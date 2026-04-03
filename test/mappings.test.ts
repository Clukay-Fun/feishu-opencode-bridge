import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MappingStore } from "../src/store/mappings.js";

describe("MappingStore", () => {
  it("normalizes legacy string mappings on load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-mappings-"));
    await writeFile(path.join(dir, "mappings.json"), JSON.stringify({ chat: "ses_1" }), "utf8");
    const store = new MappingStore(dir, "mappings.json", 2);

    const mappings = await store.load();

    expect(mappings.chat?.sessionId).toBe("ses_1");
    expect(typeof mappings.chat?.lastUsedAt).toBe("number");
  });

  it("trims to the configured LRU size on save", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-mappings-"));
    const store = new MappingStore(dir, "mappings.json", 2);

    await store.save({
      a: { sessionId: "ses_a", lastUsedAt: 1 },
      b: { sessionId: "ses_b", lastUsedAt: 3 },
      c: { sessionId: "ses_c", lastUsedAt: 2 },
    });

    const raw = JSON.parse(await readFile(path.join(dir, "mappings.json"), "utf8")) as Record<string, { sessionId: string; lastUsedAt: number }>;
    expect(Object.keys(raw)).toEqual(["b", "c"]);
  });
});
