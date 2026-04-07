import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WhitelistStore } from "../src/store/whitelist.js";

describe("WhitelistStore", () => {
  it("loads persisted chat bindings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-whitelist-"));
    const storePath = path.join(dir, "whitelist.json");
    const store = new WhitelistStore(storePath);

    await store.bind("oc_group_1", "ou_1");
    await store.bind("oc_group_1", "ou_2");

    const reloaded = new WhitelistStore(storePath);
    await reloaded.load();

    expect(reloaded.isBound("oc_group_1", "ou_1")).toBe(true);
    expect(reloaded.count("oc_group_1")).toBe(2);
  });

  it("removes empty chat bindings from disk when the last member leaves", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-whitelist-"));
    const storePath = path.join(dir, "whitelist.json");
    const store = new WhitelistStore(storePath);

    await store.bind("oc_group_1", "ou_1");
    expect(await store.unbind("oc_group_1", "ou_1")).toBe(true);

    const raw = JSON.parse(await readFile(storePath, "utf8")) as {
      version: number;
      bindings: Record<string, string[]>;
    };
    expect(raw.version).toBe(1);
    expect(raw.bindings.oc_group_1).toBeUndefined();
  });
});
