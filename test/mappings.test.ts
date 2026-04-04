import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MappingStore } from "../src/store/mappings.js";

describe("MappingStore", () => {
  it("resets legacy mapping files and logs the upgrade", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-mappings-"));
    await writeFile(path.join(dir, "mappings.json"), JSON.stringify({ chat: "ses_1" }), "utf8");
    const logger = { log: vi.fn() };
    const store = new MappingStore(dir, "mappings.json", 2, logger);

    const mappings = await store.load();
    const raw = JSON.parse(await readFile(path.join(dir, "mappings.json"), "utf8")) as { version: number; mappings: Record<string, unknown> };

    expect(mappings).toEqual({});
    expect(raw).toEqual({ version: 2, mappings: {} });
    expect(logger.log).toHaveBeenCalledWith("store/mappings", "mapping store 格式升级，已重置", {}, "warn");
  });

  it("trims to the configured LRU size on save", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-mappings-"));
    const store = new MappingStore(dir, "mappings.json", 2);

    await store.save({
      a: { sessionId: "ses_a", lastUsedAt: 1 },
      b: { sessionId: "ses_b", lastUsedAt: 3 },
      c: { sessionId: "ses_c", lastUsedAt: 2 },
    });

    const raw = JSON.parse(await readFile(path.join(dir, "mappings.json"), "utf8")) as {
      version: number;
      mappings: Record<string, { sessionId: string; lastUsedAt: number }>;
    };
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.mappings)).toEqual(["b", "c"]);
  });
});
