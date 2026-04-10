import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MemoryDb } from "../src/memory/db.js";
import { buildProfileMarkdown, ObsidianSyncService } from "../src/memory/obsidian-sync.js";

describe("ObsidianSyncService", () => {
  it("writes profile markdown during startup catch-up", async () => {
    const dbPath = await tempDbPath();
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-vault-"));
    const db = new MemoryDb(dbPath, 500, 50);
    db.saveFacts("ou_1", [{ fact: "用户维护 feishu-opencode-bridge", sourceMessage: "bridge 项目" }]);
    db.setObsidianLastSyncedAt(0);

    const service = new ObsidianSyncService({
      enabled: true,
      vaultPath,
      syncCron: "0 2 * * *",
      enableWikiLinks: false,
    }, db, logger());

    await service.start();
    await service.stop();
    db.close();

    const profile = await readFile(path.join(vaultPath, "memory", "ou_1", "profile.md"), "utf8");
    expect(profile).toContain("# 用户记忆 ou_1");
    expect(profile).toContain("用户维护 feishu-opencode-bridge");
  });

  it("optionally adds wiki links in the rendered markdown", () => {
    const markdown = buildProfileMarkdown("ou_2", [{
      id: 1,
      fact: "用户维护 feishu-opencode-bridge",
      createdAt: 1,
      accessedAt: 1,
    }], { enableWikiLinks: true });

    expect(markdown).toContain("[[feishu-opencode-bridge]]");
  });
});

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-memory-obsidian-"));
  return path.join(dir, "memory.db");
}

function logger() {
  return {
    log: vi.fn(),
    logTranscript: vi.fn(),
  };
}
