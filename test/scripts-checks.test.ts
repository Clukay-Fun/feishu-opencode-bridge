import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessLarkAuthPayload,
  checkConfigPublicUrl,
  checkOpencodeDirectory,
  getDoctorExitCode,
  runBridgeChecks,
} from "../scripts/checks.mjs";

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

  it("only fails doctor exit code on bridge failures", () => {
    expect(getDoctorExitCode([
      { group: "lark", status: "fail" },
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
    logging: {
      dir: "./logs",
    },
  }, null, 2));
}
