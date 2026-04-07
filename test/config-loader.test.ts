import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/loader.js";

describe("loadConfig memory settings", () => {
  it("fills memory defaults from storage.dataDir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(baseConfig()), "utf8");

    const config = await loadConfig(configPath);

    expect(config.memory.retriever).toBe("recent");
    expect(config.memory.dbPath).toBe(path.join(dir, "data", "memory.db"));
    expect(config.memory.obsidian.syncCron).toBe("0 2 * * *");
  });

  it("rejects embedding retriever without provider config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      memory: {
        enabled: true,
        retriever: "embedding",
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow("embeddingProvider");
  });

  it("rejects obsidian sync without vaultPath", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      memory: {
        enabled: true,
        obsidian: {
          enabled: true,
        },
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow("vaultPath");
  });
});

function baseConfig(): Record<string, unknown> {
  return {
    feishu: {
      appId: "cli_xxx",
      appSecret: "secret",
      botOpenId: "ou_bot",
      behavior: {
        enableP2p: true,
        enableGroup: true,
        requireBotMentionInGroup: true,
        strictBotMention: true,
        ignoreNonUserSenders: true,
        replyInThread: true,
      },
    },
    opencode: {
      baseUrl: "http://127.0.0.1:4096/",
      directory: dirPlaceholder(),
    },
    storage: {
      dataDir: "./data",
      mappingsFile: "mappings.json",
    },
    bridge: {
      queueLimit: 3,
    },
  };
}

function dirPlaceholder(): string {
  return process.cwd();
}
