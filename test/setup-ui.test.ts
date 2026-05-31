/**
 * 职责: 覆盖 setup-ui 核心功能。
 * 关注点: profile 合并、扩展开关、doctor 失败路径、diagnostics 渲染、saveConfig schema 校验、setup 必填守护。
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderDiagnostics, hasFailures, type DiagnosticResult } from "../src/setup-ui/diagnostics.js";
import { showProfile, setProfile } from "../src/setup-ui/profile.js";
import { showExtensions, toggleExtensions } from "../src/setup-ui/extensions.js";
import { runSetup } from "../src/setup-ui/setup.js";
import { saveConfig } from "../src/config/loader.js";

/** 构造一个符合 ConfigSchema 的最小有效配置 fixture。 */
function minimalValidConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: "legal",
    feishu: { appId: "cli_test", appSecret: "secret_test" },
    opencode: { baseUrl: "http://127.0.0.1:4096/", directory: "/tmp/test-bridge" },
    storage: {},
    bridge: {},
    ...overrides,
  };
}

describe("diagnostics", () => {
  it("renders success and failure diagnostics", () => {
    const results: DiagnosticResult[] = [
      { ok: true, label: "配置通过" },
      { ok: false, label: "端口被占用", nextStep: "释放端口 3000" },
    ];
    const rendered = renderDiagnostics(results);
    expect(rendered).toContain("✅ 配置通过");
    expect(rendered).toContain("❌ 端口被占用");
    expect(rendered).toContain("→ 释放端口 3000");
    expect(hasFailures(results)).toBe(true);
  });

  it("returns false when all diagnostics pass", () => {
    expect(hasFailures([{ ok: true, label: "ok" }])).toBe(false);
  });
});

describe("saveConfig schema validation", () => {
  it("rejects config missing required feishu fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-save-invalid-"));
    try {
      const configPath = path.join(dir, "config.json");
      const invalid = { profile: "legal", opencode: { baseUrl: "http://127.0.0.1:4096/", directory: "/tmp" } };
      await expect(saveConfig(configPath, invalid)).rejects.toThrow(/schema 校验失败/);
      // 校验失败时不应落盘
      const { existsSync } = await import("node:fs");
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts and writes a valid config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-save-valid-"));
    try {
      const configPath = path.join(dir, "config.json");
      await saveConfig(configPath, minimalValidConfig());
      const content = await readFile(configPath, "utf-8");
      expect(content).toContain('"profile": "legal"');
      expect(content).toContain('"appId": "cli_test"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("profile", () => {
  it("shows current profile from config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-profile-"));
    try {
      const configPath = path.join(dir, "config.json");
      await writeFile(configPath, JSON.stringify(minimalValidConfig({ profile: "general" })), "utf-8");
      const result = await showProfile(configPath);
      expect(result.profile).toBe("general");
      expect(result.message).toContain("general");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("switches profile and persists to config via saveConfig", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-switch-"));
    try {
      const configPath = path.join(dir, "config.json");
      await writeFile(configPath, JSON.stringify(minimalValidConfig({ profile: "general" })), "utf-8");
      const result = await setProfile(configPath, "legal");
      expect(result.ok).toBe(true);
      expect(result.label).toContain("legal");
      const after = await showProfile(configPath);
      expect(after.profile).toBe("legal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports when profile is already the target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-same-"));
    try {
      const configPath = path.join(dir, "config.json");
      await writeFile(configPath, JSON.stringify(minimalValidConfig()), "utf-8");
      const result = await setProfile(configPath, "legal");
      expect(result.ok).toBe(true);
      expect(result.label).toContain("已经是");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("setProfile rejects when underlying config is invalid (e.g., feishu missing)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-bad-"));
    try {
      const configPath = path.join(dir, "config.json");
      // 故意写一份缺 feishu 的 config，setProfile 会通过 saveConfig 校验失败
      await writeFile(configPath, JSON.stringify({ profile: "general", opencode: { baseUrl: "http://127.0.0.1:4096/", directory: "/tmp" } }), "utf-8");
      await expect(setProfile(configPath, "legal")).rejects.toThrow(/schema 校验失败/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extensions", () => {
  it("shows current extension states", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-ext-"));
    try {
      const configPath = path.join(dir, "config.json");
      await writeFile(configPath, JSON.stringify(minimalValidConfig({
        extensions: { "knowledge-base": { enabled: true }, "contract-assistant": { enabled: false } },
      })), "utf-8");
      const list = await showExtensions(configPath);
      expect(list.length).toBe(5);
      const kb = list.find((e) => e.id === "knowledge-base");
      expect(kb?.enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("toggles extensions and persists via saveConfig", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-toggle-"));
    try {
      const configPath = path.join(dir, "config.json");
      await writeFile(configPath, JSON.stringify(minimalValidConfig({ extensions: {} })), "utf-8");
      const result = await toggleExtensions(configPath, ["labor-skill"], ["contract-assistant"]);
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("启用");
      expect(result.detail).toContain("停用");

      const list = await showExtensions(configPath);
      const labor = list.find((e) => e.id === "labor-skill");
      const contract = list.find((e) => e.id === "contract-assistant");
      expect(labor?.enabled).toBe(true);
      expect(contract?.enabled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("setup", () => {
  it("creates valid config with profile + feishu creds + runs doctor", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-setup-"));
    try {
      const configPath = path.join(dir, "config.json");
      const result = await runSetup(configPath, {
        profile: "legal",
        feishuAppId: "cli_test",
        feishuAppSecret: "secret_test",
      });
      expect(result.configPath).toBe(configPath);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      const content = await readFile(configPath, "utf-8");
      expect(content).toContain('"profile": "legal"');
      expect(content).toContain('"appId": "cli_test"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies user overrides for extensions on top of profile defaults", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-override-"));
    try {
      const configPath = path.join(dir, "config.json");
      await runSetup(configPath, {
        profile: "general",
        enable: ["knowledge-base"],
        feishuAppId: "cli_test",
        feishuAppSecret: "secret_test",
      });
      const list = await showExtensions(configPath);
      const kb = list.find((e) => e.id === "knowledge-base");
      expect(kb?.enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws helpful error when feishu credentials missing (non-TTY guard)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-missing-"));
    try {
      const configPath = path.join(dir, "config.json");
      // 不传 feishuAppId / feishuAppSecret，模拟非 TTY 下漏 flag 的情形
      await expect(runSetup(configPath, { profile: "legal" })).rejects.toThrow(/缺少必填字段/);
      // 错误信息必须包含"下一步建议"
      try {
        await runSetup(configPath, { profile: "legal" });
      } catch (e) {
        expect(e instanceof Error && e.message).toMatch(/--feishu-app-id|TTY/);
      }
      // 校验失败时不应落盘
      const { existsSync } = await import("node:fs");
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when feishu credentials are empty strings (treated as missing)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "setup-ui-empty-"));
    try {
      const configPath = path.join(dir, "config.json");
      await expect(runSetup(configPath, {
        profile: "legal",
        feishuAppId: "   ",
        feishuAppSecret: "",
      })).rejects.toThrow(/缺少必填字段/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
