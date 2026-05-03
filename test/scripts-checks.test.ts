/**
 * 职责: 覆盖runtime checks 脚本诊断逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assessOpencodeAuthPayload,
  assessLarkAuthPayload,
  checkConfigPublicUrl,
  checkAiProviderDataFlow,
  checkExternalOcrDataFlow,
  checkMemoryDataFlow,
  checkObsidianSync,
  checkOpencodeModels,
  checkOpencodeDirectory,
  getDoctorExitCode,
  readOpencodeAuth,
  runBridgeChecks,
} from "../scripts/runtime/checks.mjs";

describe("scripts/checks", () => {
  it("skips dependent config checks when config.json is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-missing-"));

    const results = await runBridgeChecks({ cwd: dir });
    const byId = new Map<string, { status: string }>(
      (results as Array<{ id: string; status: string }>).map((result) => [result.id, result]),
    );

    expect(byId.get("config-exists")?.status).toBe("fail");
    expect(byId.get("config-feishu")?.status).toBe("skip");
    expect(byId.get("config-opencode")?.status).toBe("skip");
    expect(byId.get("config-publicurl")?.status).toBe("skip");
  });

  it("treats lark tokenStatus needs_refresh as pass", () => {
    const result = assessLarkAuthPayload({
      identity: "user",
      tokenStatus: "needs_refresh",
    });

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("needs_refresh");
  });

  it("fails when opencode provider auth is missing", () => {
    const result = assessOpencodeAuthPayload(null);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("未检测到 provider 凭证");
  });

  it("fails when all opencode provider credentials are expired", () => {
    const result = assessOpencodeAuthPayload({
      openai: {
        type: "oauth",
        expires: Date.now() - 10_000,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("登录态已过期");
  });

  it("reads opencode auth from the Windows LOCALAPPDATA data directory", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-opencode-auth-win-"));
    const localAppData = path.join(home, "AppData", "Local");
    const authDir = path.join(localAppData, "opencode", "Data");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "auth.json"), JSON.stringify({
      openai: {
        type: "oauth",
        expires: Date.now() + 60_000,
      },
    }));

    const payload = await readOpencodeAuth(home, {
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
    });

    expect(payload).not.toBeNull();
    expect(payload?.openai?.type).toBe("oauth");
  });

  it("does not hard fail publicBaseUrl when card actions are disabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-public-url-"));
    await writeConfig(dir, {
      feishu: {
        appId: "cli_test",
        appSecret: "secret",
        cardActions: {
          enabled: false,
          path: "/webhook/card",
          verificationToken: "",
          encryptKey: "",
        },
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: dir,
      },
      server: {
        publicBaseUrl: "https://bridge.example.com/",
      },
    });

    const result = await checkConfigPublicUrl({ cwd: dir });

    expect(result.status).toBe("skip");
  });

  it("warns when opencode.directory exists but is not a git repo", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-worktree-"));
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace, { recursive: true });

    await writeConfig(dir, {
      feishu: {
        appId: "cli_test",
        appSecret: "secret",
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: "./workspace",
      },
    });

    const result = await checkOpencodeDirectory({ cwd: dir });

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("不是 git 仓库");
  });

  it("passes when opencode providers endpoint returns models", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-models-"));
    await writeConfig(dir, {
      feishu: {
        appId: "cli_test",
        appSecret: "secret",
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: dir,
      },
    });

    const result = await checkOpencodeModels({
      cwd: dir,
      healthResult: { status: "pass" },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        providers: [
          { id: "openai", models: { "gpt-5.4": {}, "gpt-5.4-mini": {} } },
        ],
      }), { status: 200 })),
    });

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("1 个 provider，2 个模型");
  });

  it("reports external provider, OCR, and memory data-flow warnings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-data-flow-"));
    await writeConfig(dir, {
      opencode: {
        baseUrl: "https://api.example-provider.test/",
        directory: dir,
      },
      extensions: {
        "knowledge-base": {
          parser: {
            externalApiEnabled: true,
            pdfProviderOrder: ["mineru-agent"],
            imageProviderOrder: ["paddleocr-vl-aistudio"],
          },
        },
      },
      memory: {
        enabled: true,
        dbPath: "./data/memory.db",
      },
    });

    await expect(checkAiProviderDataFlow({ cwd: dir })).resolves.toMatchObject({
      status: "warn",
      detail: expect.stringContaining("外部地址"),
    });
    await expect(checkExternalOcrDataFlow({ cwd: dir })).resolves.toMatchObject({
      status: "warn",
      detail: expect.stringContaining("mineru-agent"),
    });
    await expect(checkMemoryDataFlow({ cwd: dir })).resolves.toMatchObject({
      status: "warn",
      detail: expect.stringContaining("memory.db"),
    });
  });

  it("treats local OpenCode provider URLs as private-leaning", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-data-flow-local-"));
    await writeConfig(dir, {
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: dir,
      },
    });

    const result = await checkAiProviderDataFlow({ cwd: dir });

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("本地/私有地址");
  });

  it("skips obsidian sync when obsidian is not enabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-obsidian-skip-"));
    await writeConfig(dir, {
      memory: {
        enabled: false,
        obsidian: {
          enabled: false,
          vaultPath: "/tmp/vault",
        },
      },
    });

    const result = await checkObsidianSync({ cwd: dir });

    expect(result.status).toBe("skip");
    expect(result.detail).toContain("未启用");
  });

  it("passes obsidian sync when enabled vault is writable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-checks-obsidian-pass-"));
    const vault = path.join(dir, "vault");
    await mkdir(vault, { recursive: true });
    await writeConfig(dir, {
      memory: {
        enabled: true,
        obsidian: {
          enabled: true,
          vaultPath: "./vault",
        },
      },
    });

    const result = await checkObsidianSync({ cwd: dir });

    expect(result.status).toBe("pass");
    expect(result.detail).toContain(vault);
  });

  it("only fails doctor exit code on bridge failures", () => {
    expect(getDoctorExitCode([
      { group: "lark", status: "fail" },
      { group: "memory", status: "warn" },
      { group: "bridge", status: "warn" },
    ])).toBe(0);

    expect(getDoctorExitCode([
      { group: "bridge", status: "fail" },
    ])).toBe(1);
  });
});

async function writeConfig(dir: string, partial: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(dir, "config.json"), JSON.stringify({
    feishu: {
      appId: "cli_xxx",
      appSecret: "xxx",
      cardActions: {
        enabled: false,
        path: "/webhook/card",
        verificationToken: "",
        encryptKey: "",
      },
      ...(partial.feishu ?? {}),
    },
    opencode: {
      baseUrl: "http://127.0.0.1:4096/",
      directory: dir,
      ...(partial.opencode ?? {}),
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: "http://127.0.0.1:3000/",
      ...(partial.server ?? {}),
    },
    memory: {
      enabled: false,
      obsidian: {
        enabled: false,
        vaultPath: "/tmp/vault",
      },
      ...(partial.memory ?? {}),
    },
    extensions: partial.extensions ?? {},
    logging: {
      dir: "./logs",
      ...(partial.logging ?? {}),
    },
  }, null, 2));
}
