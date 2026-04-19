import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TurnOwnedResourceStore } from "../src/runtime/turn-owned-resources.js";

describe("TurnOwnedResourceStore", () => {
  it("cleans a single turn's registered temp directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bridge-turn-resource-"));
    const nestedFile = path.join(tempDir, "note.txt");
    await writeFile(nestedFile, "hello", "utf8");
    const store = new TurnOwnedResourceStore({ log: vi.fn() } as never);

    store.register("turn-1", { path: tempDir });
    await store.cleanupTurn("turn-1");

    await expect(readFile(nestedFile, "utf8")).rejects.toThrow();
  });

  it("cleans all remaining temp directories on shutdown fallback", async () => {
    const firstDir = await mkdtemp(path.join(os.tmpdir(), "bridge-turn-resource-"));
    const secondDir = await mkdtemp(path.join(os.tmpdir(), "bridge-turn-resource-"));
    await writeFile(path.join(firstDir, "a.txt"), "a", "utf8");
    await writeFile(path.join(secondDir, "b.txt"), "b", "utf8");
    const store = new TurnOwnedResourceStore({ log: vi.fn() } as never);

    store.register("turn-1", { path: firstDir });
    store.register("turn-2", { path: secondDir });
    await store.cleanupAll();

    await expect(readFile(path.join(firstDir, "a.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(secondDir, "b.txt"), "utf8")).rejects.toThrow();

    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  });
});
