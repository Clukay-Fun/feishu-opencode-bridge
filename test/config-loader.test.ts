import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/loader.js";

describe("loadConfig", () => {
  it("resolves whitelist.storePath under storage.dataDir by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");

    await writeFile(configPath, JSON.stringify({
      feishu: {
        appId: "app",
        appSecret: "secret",
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: process.cwd(),
      },
      storage: {},
      bridge: {},
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.whitelist.storePath).toBe(path.join(dir, "data", "whitelist.json"));
    expect(config.server.publicBaseUrl.toString()).toBe("http://127.0.0.1:3000/");
    expect(config.feishu.cardActions.path).toBe("/webhook/card");
  });
});
