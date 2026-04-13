import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MappingStore } from "../src/store/mappings.js";

describe("MappingStore", () => {
  it("migrates legacy mapping files and logs the upgrade", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-mappings-"));
    await writeFile(path.join(dir, "mappings.json"), JSON.stringify({ chat: "ses_1" }), "utf8");
    const logger = { log: vi.fn() };
    const store = new MappingStore(dir, "mappings.json", 2, logger);

    const mappings = await store.load();
    const raw = JSON.parse(await readFile(path.join(dir, "mappings.json"), "utf8")) as {
      version: number;
      mappings: Record<string, {
        mode: string;
        activeSessionId: string | null;
        sessions: Array<{ sessionId: string; label: string }>;
      }>;
    };

    expect(mappings.chat?.mode).toBe("single");
    expect(mappings.chat?.interactionMode).toBe("default");
    expect(mappings.chat?.activeSessionId).toBe("ses_1");
    expect(mappings.chat?.sessions).toHaveLength(1);
    expect(mappings.chat?.sessions[0]?.label).toBe("ses_1");
    expect(raw.version).toBe(4);
    expect(raw.mappings.chat?.sessions[0]?.sessionId).toBe("ses_1");
    expect(logger.log).toHaveBeenCalledWith("store/mappings", "mapping store 格式升级，已迁移", { fromVersion: "legacy" }, "warn");
  });

  it("migrates version 3 mappings with a default interaction mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-mappings-"));
    await writeFile(path.join(dir, "mappings.json"), JSON.stringify({
      version: 3,
      mappings: {
        chat: {
          mode: "single",
          activeSessionId: "ses_1",
          sessions: [{ sessionId: "ses_1", label: "会话1", createdAt: 1, lastUsedAt: 1 }],
        },
      },
    }), "utf8");
    const logger = { log: vi.fn() };
    const store = new MappingStore(dir, "mappings.json", 2, logger);

    const mappings = await store.load();
    const raw = JSON.parse(await readFile(path.join(dir, "mappings.json"), "utf8")) as {
      version: number;
      mappings: Record<string, {
        interactionMode?: string;
      }>;
    };

    expect(mappings.chat?.interactionMode).toBe("default");
    expect(raw.version).toBe(4);
    expect(raw.mappings.chat?.interactionMode).toBe("default");
    expect(logger.log).toHaveBeenCalledWith("store/mappings", "mapping store 格式升级，已迁移", { fromVersion: 3 }, "warn");
  });

  it("trims to the configured LRU size on save", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-mappings-"));
    const store = new MappingStore(dir, "mappings.json", 2);

    await store.save({
      a: { mode: "single", interactionMode: "default", activeSessionId: "ses_a", sessions: [{ sessionId: "ses_a", label: "A", createdAt: 1, lastUsedAt: 1 }] },
      b: { mode: "single", interactionMode: "default", activeSessionId: "ses_b", sessions: [{ sessionId: "ses_b", label: "B", createdAt: 3, lastUsedAt: 3 }] },
      c: { mode: "single", interactionMode: "default", activeSessionId: "ses_c", sessions: [{ sessionId: "ses_c", label: "C", createdAt: 2, lastUsedAt: 2 }] },
    });

    const raw = JSON.parse(await readFile(path.join(dir, "mappings.json"), "utf8")) as {
      version: number;
      mappings: Record<string, {
        mode: string;
        activeSessionId: string | null;
        sessions: Array<{ sessionId: string; lastUsedAt: number }>;
      }>;
    };
    expect(raw.version).toBe(4);
    expect(Object.keys(raw.mappings)).toEqual(["b", "c"]);
  });
});
