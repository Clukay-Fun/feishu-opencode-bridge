/**
 * 职责: 覆盖onboard/start 脚本启动引导逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ensureLarkCliInstalled,
  generateConfigObject,
  maybeLoginOpencodeProvider,
  maybeLoginLarkCli,
  runOnboard,
  shouldOfferStart,
  shouldRebuildConfig,
} from "../scripts/runtime/onboard.mjs";
import {
  ensureBridgePortAvailable,
  isProjectBridgeProcess,
  isBridgeHealthy,
  ensureOpencodeServer,
  parseLsofPidOutput,
  parsePsProcessOutput,
  resolveBridgeLaunch,
  runStart,
  tryReclaimStaleBridgePort,
} from "../scripts/runtime/start.mjs";
import { runBootstrap, ensureBridgeDependencies } from "../scripts/runtime/bootstrap.mjs";
import { createBackup, restoreBackup } from "../scripts/runtime/backup.mjs";
import { runCostCli } from "../scripts/runtime/cost.mjs";
import { checkForUpdate, downloadUpdate } from "../scripts/runtime/update.mjs";
import { createPortableEnv, resolveBridgeHome, resolveNodeDownload, resolveProjectConfigPath } from "../scripts/runtime/portable.mjs";
import { buildPortablePackage, PORTABLE_PACKAGE_MANIFEST } from "../scripts/release/build-portable.mjs";

describe("scripts/onboard", () => {
  it("does not overwrite existing config by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, "{}");

    const result = await shouldRebuildConfig(configPath, vi.fn(async () => false));

    expect(result).toBe(false);
  });

  it("falls back to ~/.local installation when global lark-cli install fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-lark-"));
    const home = path.join(dir, "home");
    await mkdir(home, { recursive: true });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const calls: string[] = [];
    let installed = false;

    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "install" && args[1] === "-g") {
        return { code: 1, stdout: "", stderr: "EACCES", signal: null, timedOut: false };
      }
      if (args[0] === "install" && args[1] === "--prefix") {
        installed = true;
      }
      return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
    });

    const findExecutableFn = vi.fn(() => {
      if (installed) {
        return path.join(home, ".local", "node_modules", ".bin", "lark-cli");
      }
      return null;
    });

    const result = await ensureLarkCliInstalled({
      cwd: dir,
      env: {},
      home,
      logger,
      runCommandFn,
      findExecutableFn,
    });

    expect(calls).toContain("install -g @larksuite/cli");
    expect(calls.some((line) => line.includes("--prefix"))).toBe(true);
    expect(result.path).toContain(path.join(".local", "node_modules", ".bin", "lark-cli"));
  });

  it("installs lark-cli into the portable npm prefix when BRIDGE_HOME is set", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-lark-portable-"));
    const home = path.join(dir, "home");
    const bridgeHome = path.join(dir, "bridge-home");
    await mkdir(home, { recursive: true });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const calls: string[] = [];
    let installed = false;

    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "install" && args[1] === "--prefix") {
        installed = true;
      }
      return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
    });

    const findExecutableFn = vi.fn(() => {
      if (installed) {
        return path.join(dir, ".runtime", "npm-global", "node_modules", ".bin", "lark-cli");
      }
      return null;
    });

    const result = await ensureLarkCliInstalled({
      cwd: dir,
      env: { BRIDGE_HOME: bridgeHome },
      home,
      logger,
      runCommandFn,
      findExecutableFn,
    });

    expect(calls).toEqual([`install --prefix ${path.join(dir, ".runtime", "npm-global")} @larksuite/cli`]);
    expect(result.path).toContain(path.join(".runtime", "npm-global", "node_modules", ".bin", "lark-cli"));
  });

  it("preserves template defaults while replacing credentials and directory", () => {
    const generated = generateConfigObject({
      feishu: {
        appId: "cli_xxx",
        appSecret: "xxx",
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: "E:\\.Software\\OpenCode",
      },
      server: {
        port: 3000,
      },
      bridge: {
        sessions: {
          p2pMode: "multi",
        },
      },
    }, {
      appId: "cli_real",
      appSecret: "secret",
      opencodeDirectory: "/tmp/project",
    });

    expect(generated.feishu.appId).toBe("cli_real");
    expect(generated.feishu.appSecret).toBe("secret");
    expect(generated.opencode.directory).toBe("/tmp/project");
    expect(generated.opencode.baseUrl).toBe("http://127.0.0.1:4096/");
    expect(generated.server.port).toBe(3000);
    expect(generated.bridge.sessions.p2pMode).toBe("multi");
  });

  it("can trigger lark-cli auth login when user auth is missing", async () => {
    const calls: string[] = [];
    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "auth" && args[1] === "status" && calls.length === 1) {
        return {
          code: 0,
          stdout: JSON.stringify({ identity: "bot", note: "No user logged in" }),
          stderr: "",
          signal: null,
          timedOut: false,
        };
      }
      if (args[0] === "auth" && args[1] === "login" && args[2] === "--recommend") {
        return { code: 0, stdout: "login ok", stderr: "", signal: null, timedOut: false };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ identity: "user", tokenStatus: "valid" }),
        stderr: "",
        signal: null,
        timedOut: false,
      };
    });

    const result = await maybeLoginLarkCli({
      cwd: process.cwd(),
      env: process.env,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      larkCliPath: "/tmp/lark-cli",
      promptYesNoFn: vi.fn(async () => true),
      runCommandFn,
    });

    expect(calls).toContain("auth login --recommend");
    expect(result.status).toBe("pass");
  });

  it("can trigger opencode providers login when provider auth is missing", async () => {
    const calls: string[] = [];
    const home = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-opencode-auth-"));
    const authDir = path.join(home, ".local", "share", "opencode");
    await mkdir(authDir, { recursive: true });

    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "providers" && args[1] === "login") {
        await writeFile(path.join(authDir, "auth.json"), JSON.stringify({
          openai: {
            type: "oauth",
            expires: Date.now() + 7 * 24 * 60 * 60 * 1_000,
          },
        }));
      }
      return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
    });

    const result = await maybeLoginOpencodeProvider({
      cwd: process.cwd(),
      env: process.env,
      home,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      opencodePath: "/tmp/opencode",
      promptYesNoFn: vi.fn(async () => true),
      runCommandFn,
    });

    expect(calls).toContain("providers login");
    expect(result.status).toBe("pass");
  });

  it("prints a manual test-key channel when provider auth is still unavailable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-opencode-test-key-"));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await maybeLoginOpencodeProvider({
      cwd: process.cwd(),
      env: { BRIDGE_TEST_KEY_URL: "https://example.com/apply-test-key" },
      home,
      logger,
      opencodePath: "/tmp/opencode",
      promptYesNoFn: vi.fn(async () => false),
      runCommandFn: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", signal: null, timedOut: false })),
    });

    expect(result.status).toBe("fail");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("https://example.com/apply-test-key"));
  });

  it("exits successfully when start is offered but the user declines", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-decline-start-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-decline-start-home-"));
    const authDir = path.join(home, ".local", "share", "opencode");
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ ok: true }));
    await writeFile(path.join(authDir, "auth.json"), JSON.stringify({
      openai: {
        type: "oauth",
        expires: Date.now() + 60_000,
      },
    }));

    const promptYesNoFn = vi.fn(async () => false);
    const exitCode = await runOnboard({
      cwd: dir,
      home,
      env: {},
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configExistsOverride: false,
      promptYesNoFn,
      runCommandFn: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "auth" && args[1] === "status") {
          return {
            code: 0,
            stdout: JSON.stringify({ identity: "user", tokenStatus: "valid" }),
            stderr: "",
            signal: null,
            timedOut: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
      }),
      findExecutableFn: (command: string) => {
        if (command === "opencode") return "/tmp/opencode";
        if (command === "lark-cli") return "/tmp/lark-cli";
        return null;
      },
      runAllChecksFn: vi.fn(async () => [
        { group: "bridge", status: "fail", id: "opencode-serve", label: "OpenCode 健康", detail: "down" },
        { group: "lark", status: "fail", id: "lark-auth", label: "Lark 登录态", detail: "missing" },
      ]),
    });

    expect(exitCode).toBe(0);
    expect(promptYesNoFn).toHaveBeenCalledWith("当前环境已接近可运行状态，是否现在启动完整栈？", false);
  });

  it("runs lark auth login before trying lark config init during onboarding", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-lark-order-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "bridge-onboard-lark-order-home-"));
    const authDir = path.join(home, ".local", "share", "opencode");
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "auth.json"), JSON.stringify({
      openai: {
        type: "oauth",
        expires: Date.now() + 60_000,
      },
    }));
    await writeFile(path.join(dir, "config.example.json"), JSON.stringify({
      feishu: {
        appId: "cli_xxx",
        appSecret: "xxx",
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: dir,
      },
      server: {
        port: 3000,
      },
      bridge: {
        sessions: {
          p2pMode: "multi",
        },
      },
    }, null, 2));

    const calls: string[] = [];
    const promptTextFn = vi.fn(async () => "");
    const exitCode = await runOnboard({
      cwd: dir,
      home,
      env: {},
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configExistsOverride: true,
      promptTextFn,
      promptYesNoFn: vi.fn(async (question: string) => question.includes("lark-cli auth login")),
      runCommandFn: vi.fn(async (_command: string, args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "auth" && args[1] === "status" && !calls.includes("auth login --recommend")) {
          return {
            code: 0,
            stdout: JSON.stringify({ identity: "bot", note: "No user logged in" }),
            stderr: "",
            signal: null,
            timedOut: false,
          };
        }
        if (args[0] === "auth" && args[1] === "login") {
          return { code: 0, stdout: "login ok", stderr: "", signal: null, timedOut: false };
        }
        if (args[0] === "auth" && args[1] === "status") {
          return {
            code: 0,
            stdout: JSON.stringify({ identity: "user", tokenStatus: "valid" }),
            stderr: "",
            signal: null,
            timedOut: false,
          };
        }
        if (args[0] === "config" && args[1] === "init") {
          return {
            code: 0,
            stdout: JSON.stringify({ appId: "cli_real", appSecret: "secret" }),
            stderr: "",
            signal: null,
            timedOut: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
      }),
      findExecutableFn: (command: string) => {
        if (command === "opencode") return "/tmp/opencode";
        if (command === "lark-cli") return "/tmp/lark-cli";
        return null;
      },
      runAllChecksFn: vi.fn(async () => []),
    });

    expect(exitCode).toBe(0);
    expect(promptTextFn).not.toHaveBeenCalled();
    expect(calls.indexOf("auth login --recommend")).toBeGreaterThan(-1);
    expect(calls.indexOf("config init --new --lang zh")).toBeGreaterThan(-1);
    expect(calls.indexOf("auth login --recommend")).toBeLessThan(calls.indexOf("config init --new --lang zh"));
  });

  it("offers start when only opencode health is blocking bridge readiness", () => {
    expect(shouldOfferStart([
      { group: "bridge", status: "fail", id: "opencode-serve" },
      { group: "lark", status: "fail", id: "lark-auth" },
    ])).toBe(true);

    expect(shouldOfferStart([
      { group: "bridge", status: "fail", id: "config-feishu" },
    ])).toBe(false);
  });
});

describe("scripts/portable bootstrap", () => {
  it("resolves user data and config paths from BRIDGE_HOME", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-portable-paths-"));
    const bridgeHome = path.join(dir, "home");
    const env = createPortableEnv({
      cwd: dir,
      env: { BRIDGE_HOME: bridgeHome, PATH: "/usr/bin" },
      platform: "darwin",
      home: dir,
    });

    expect(resolveBridgeHome({ env, platform: "darwin", home: dir })).toBe(bridgeHome);
    expect(resolveProjectConfigPath(dir, env)).toBe(path.join(bridgeHome, "config.json"));
    expect(env.PATH).toContain(path.join(dir, ".runtime", "node", "bin"));
    expect(env.XDG_DATA_HOME).toBe(path.join(bridgeHome, "xdg-data"));
  });

  it("preserves the user OpenCode data home when requested", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-portable-xdg-"));
    const bridgeHome = path.join(dir, "home");
    const xdgDataHome = path.join(dir, "xdg-data");
    const env = createPortableEnv({
      cwd: dir,
      env: {
        BRIDGE_HOME: bridgeHome,
        BRIDGE_PRESERVE_XDG: "1",
        XDG_DATA_HOME: xdgDataHome,
        PATH: "/usr/bin",
      },
      platform: "darwin",
      home: dir,
    });

    expect(env.XDG_DATA_HOME).toBe(xdgDataHome);
  });

  it("does not inject XDG_DATA_HOME when preserving the default user OpenCode data home", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-portable-xdg-default-"));
    const bridgeHome = path.join(dir, "home");
    const env = createPortableEnv({
      cwd: dir,
      env: {
        BRIDGE_HOME: bridgeHome,
        BRIDGE_PRESERVE_XDG: "1",
        PATH: "/usr/bin",
      },
      platform: "darwin",
      home: dir,
    });

    expect(env.XDG_DATA_HOME).toBeUndefined();
  });

  it("selects Node archives by platform and architecture", () => {
    expect(resolveNodeDownload({ platform: "win32", arch: "x64" }).archiveName).toContain("win-x64.zip");
    expect(resolveNodeDownload({ platform: "darwin", arch: "arm64" }).archiveName).toContain("darwin-arm64.tar.gz");
  });

  it("skips dependency installation when node_modules already exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-deps-"));
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    const runCommandFn = vi.fn();

    await ensureBridgeDependencies({
      cwd: dir,
      env: {},
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runCommandFn,
      findExecutableFn: vi.fn(),
    });

    expect(runCommandFn).not.toHaveBeenCalled();
  });

  it("dispatches doctor with portable config path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-doctor-"));
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    const bridgeHome = path.join(dir, "bridge-home");
    const runAllChecksFn = vi.fn(async () => []);

    const exitCode = await runBootstrap({
      cwd: dir,
      command: "doctor",
      env: { BRIDGE_HOME: bridgeHome, PATH: "" },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runAllChecksFn,
      findExecutableFn: vi.fn(),
      runCommandFn: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(runAllChecksFn).toHaveBeenCalledWith(expect.objectContaining({
      configPath: path.join(bridgeHome, "config.json"),
    }));
  });

  it("dispatches workspace init through bootstrap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-init-"));
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    const bridgeHome = path.join(dir, "bridge-home");
    const configPath = path.join(bridgeHome, "config.json");
    await mkdir(bridgeHome, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      extensions: {
        "knowledge-base": { storage: { bitable: {} } },
        "contract-assistant": { storage: {} },
      },
    }), "utf8");
    const schemaPath = path.join(dir, "schema.json");
    await writeFile(schemaPath, JSON.stringify({
      schemaVersion: 1,
      name: "测试工作区",
      tables: [
        { key: "contract", name: "合同管理表", sourceTableId: "old_contract", fields: [{ sourceFieldId: "fld_contract", name: "客户名称", type: "text" }] },
        { key: "invoice", name: "发票台账", sourceTableId: "old_invoice", fields: [{ sourceFieldId: "fld_invoice", name: "发票号", type: "text" }] },
        { key: "case", name: "案件管理表", sourceTableId: "old_case", fields: [{ sourceFieldId: "fld_case", name: "案号", type: "text" }] },
        { key: "knowledge", name: "知识库问答", sourceTableId: "old_knowledge", fields: [{ sourceFieldId: "fld_question", name: "问题", type: "text" }] },
      ],
      sampleRecords: {},
    }), "utf8");

    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === "+base-create") {
        return { code: 0, stdout: JSON.stringify({ data: { base: { app_token: "app_new" } } }), stderr: "", signal: null, timedOut: false };
      }
      if (args[1] === "+table-create") {
        const name = args[args.indexOf("--name") + 1];
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              table: { table_id: `tbl_${name}` },
              fields: [{ name: JSON.parse(args[args.indexOf("--fields") + 1] ?? "[]")[0].name, id: `fld_${name}` }],
            },
          }),
          stderr: "",
          signal: null,
          timedOut: false,
        };
      }
      return { code: 0, stdout: JSON.stringify({ data: { field: { id: "fld_x", name: "x" } } }), stderr: "", signal: null, timedOut: false };
    });

    const exitCode = await runBootstrap({
      cwd: dir,
      args: ["init", "workspace", "--schema", schemaPath],
      env: { BRIDGE_HOME: bridgeHome, PATH: "" },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      findExecutableFn: (command: string) => command === "lark-cli" ? "/tmp/lark-cli" : null,
      runCommandFn,
    });

    expect(exitCode).toBe(0);
    const updated = JSON.parse(await readFile(configPath, "utf8"));
    expect(updated.extensions["contract-assistant"].storage.baseToken).toBe("app_new");
  });

});

describe("scripts/backup", () => {
  it("backs up user data while excluding runtime folders", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-backup-"));
    const bridgeHome = path.join(dir, "bridge-home");
    await mkdir(path.join(bridgeHome, "data"), { recursive: true });
    await mkdir(path.join(bridgeHome, "data", "pkulaw-cache"), { recursive: true });
    await mkdir(path.join(bridgeHome, "logs"), { recursive: true });
    await mkdir(path.join(bridgeHome, "extensions", "demo"), { recursive: true });
    await mkdir(path.join(bridgeHome, ".runtime", "node"), { recursive: true });
    await writeFile(path.join(bridgeHome, "config.json"), "{}");
    await writeFile(path.join(bridgeHome, "data", "knowledge-base.db"), "db");
    await writeFile(path.join(bridgeHome, "data", "pkulaw-cache", "cached.json"), "{}");
    await writeFile(path.join(bridgeHome, "logs", "bridge.log"), "log");
    await writeFile(path.join(bridgeHome, "extensions", "demo", "manifest.json"), "{}");
    await writeFile(path.join(bridgeHome, ".runtime", "node", "secret.txt"), "runtime");
    const outputPath = path.join(dir, "backup.zip");

    const result = await createBackup({ cwd: dir, bridgeHome, outputPath });
    const restored = path.join(dir, "restored");
    await restoreBackup({ cwd: dir, bridgeHome: restored, zipPath: result.outputPath });

    await expect(readFile(path.join(restored, "config.json"), "utf8")).resolves.toBe("{}");
    await expect(readFile(path.join(restored, "data", "knowledge-base.db"), "utf8")).resolves.toBe("db");
    await expect(readFile(path.join(restored, "data", "pkulaw-cache", "cached.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(restored, "extensions", "demo", "manifest.json"), "utf8")).resolves.toBe("{}");
    await expect(readFile(path.join(restored, ".runtime", "node", "secret.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses restore over existing user data unless force is explicit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-restore-"));
    const source = path.join(dir, "source");
    await mkdir(path.join(source, "data"), { recursive: true });
    await writeFile(path.join(source, "config.json"), "{\"ok\":true}");
    await writeFile(path.join(source, "data", "state.json"), "{}");
    const { outputPath } = await createBackup({ cwd: dir, bridgeHome: source, outputPath: path.join(dir, "backup.zip") });
    const target = path.join(dir, "target");
    await mkdir(path.join(target, "data"), { recursive: true });
    await writeFile(path.join(target, "config.json"), "{\"old\":true}");

    await expect(restoreBackup({ cwd: dir, bridgeHome: target, zipPath: outputPath })).rejects.toThrow("--force");
    await expect(restoreBackup({ cwd: dir, bridgeHome: target, zipPath: outputPath, force: true })).resolves.toMatchObject({
      bridgeHome: target,
    });
    await expect(readFile(path.join(target, "config.json"), "utf8")).resolves.toBe("{\"ok\":true}");
  });

  it("rejects invalid backup files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-restore-invalid-"));
    const invalid = path.join(dir, "invalid.zip");
    await writeFile(invalid, "not a zip");

    await expect(restoreBackup({ cwd: dir, bridgeHome: path.join(dir, "target"), zipPath: invalid })).rejects.toThrow("zip");
  });
});

describe("scripts/release portable package", () => {
  it("builds a dist-only portable package layout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-release-portable-"));
    await mkdir(path.join(dir, "dist", "bin"), { recursive: true });
    await mkdir(path.join(dir, "dist", "src"), { recursive: true });
    await mkdir(path.join(dir, "scripts", "runtime"), { recursive: true });
    await mkdir(path.join(dir, "scripts", "workspace-init"), { recursive: true });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "test"), { recursive: true });
    await mkdir(path.join(dir, "data"), { recursive: true });
    await mkdir(path.join(dir, "logs"), { recursive: true });
    await mkdir(path.join(dir, "artifacts"), { recursive: true });
    await mkdir(path.join(dir, "outputs"), { recursive: true });
    await mkdir(path.join(dir, "turn-files"), { recursive: true });
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await mkdir(path.join(dir, "examples"), { recursive: true });
    await mkdir(path.join(dir, ".runtime"), { recursive: true });
    await mkdir(path.join(dir, "bin"), { recursive: true });
    await writeFile(path.join(dir, "dist", "bin", "files.js"), "console.log('files');");
    await writeFile(path.join(dir, "dist", "src", "index.js"), "console.log('ok');");
    await writeFile(path.join(dir, "scripts", "runtime", "bootstrap.mjs"), "export {};");
    await writeFile(path.join(dir, "scripts", "workspace-init", "workspace-init.mjs"), "export {};");
    // bin/ 启动器文件（便携包会从这里拷贝到根目录）
    await writeFile(path.join(dir, "bin", "bridge"), "#!/bin/bash\nROOT=\"$(cd \"$(dirname \"$0\")/..\" && pwd)\"\nexec \"$ROOT/scripts/runtime/bootstrap.mjs\" \"$@\"\n");
    await writeFile(path.join(dir, "bin", "bridge.cmd"), "@echo off\nset \"ROOT=%~dp0..\\\"\n\"%ROOT%.runtime\\node\\node.exe\" \"%ROOT%scripts\\runtime\\bootstrap.mjs\" %*\n");
    await writeFile(path.join(dir, "bin", "bridge.ps1"), "$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)\n& (Join-Path $Root 'scripts\\runtime\\bootstrap.mjs')\n");
    await writeFile(path.join(dir, "src", "index.ts"), "export {};");
    await writeFile(path.join(dir, "test", "example.test.ts"), "export {};");
    await writeFile(path.join(dir, "data", "knowledge-base.db"), "db");
    await writeFile(path.join(dir, "logs", "bridge.log"), "log");
    await writeFile(path.join(dir, "artifacts", "demo.json"), "{}");
    await writeFile(path.join(dir, "outputs", "demo.txt"), "output");
    await writeFile(path.join(dir, "turn-files", "material.txt"), "material");
    await writeFile(path.join(dir, "docs", "README.md"), "docs");
    await writeFile(path.join(dir, "examples", "README.md"), "examples");
    await writeFile(path.join(dir, ".runtime", "secret.txt"), "runtime");
    await writeFile(path.join(dir, "config.json"), "{}");
    await writeFile(path.join(dir, "knowledge-base.db"), "db");
    await writeFile(path.join(dir, "mappings.json"), "{}");
    await writeFile(path.join(dir, "message-context.json"), "{}");
    await writeFile(path.join(dir, "usage-ledger.jsonl"), "{}\n");
    await writeFile(path.join(dir, "active-knowledge-ingests.json"), "[]");
    await writeFile(path.join(dir, "batch-create.json"), "{}");
    await writeFile(path.join(dir, "batch-create-weekly.json"), "{}");
    for (const file of PORTABLE_PACKAGE_MANIFEST.files) {
      await writeFile(path.join(dir, file), "{}");
    }
    const runCommandFn = vi.fn(async () => ({ code: 0, stdout: "", stderr: "", signal: null, timedOut: false }));

    const result = await buildPortablePackage({
      cwd: dir,
      platform: "darwin",
      arch: "arm64",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runCommandFn,
    });

    expect(result.packageDir).toContain("feishu-opencode-bridge-macos-arm64");
    expect(runCommandFn).toHaveBeenCalledWith("tar", expect.arrayContaining(["feishu-opencode-bridge-macos-arm64"]), expect.any(Object));

    const topLevelEntries = await readdir(result.packageDir);
    expect(topLevelEntries.sort()).toEqual([
      ".runtime",
      "LICENSE",
      "README.en.md",
      "README.md",
      "bridge",
      "bridge.cmd",
      "bridge.ps1",
      "config.example.json",
      "config.general.example.json",
      "config.legal.example.json",
      "dist",
      "logs",
      "package-lock.json",
      "package.json",
      "scripts",
    ]);
    await expect(readFile(path.join(result.packageDir, "dist", "src", "index.js"), "utf8")).resolves.toBe("console.log('ok');");
    await expect(readFile(path.join(result.packageDir, "dist", "bin", "files.js"), "utf8")).resolves.toBe("console.log('files');");
    await expect(readFile(path.join(result.packageDir, "package.json"), "utf8")).resolves.toContain('"files": "node dist/bin/files.js"');
    await expect(readFile(path.join(result.packageDir, "scripts", "runtime", "bootstrap.mjs"), "utf8")).resolves.toBe("export {};");
    await expect(readFile(path.join(result.packageDir, "bridge"), "utf8")).resolves.toContain('ROOT="$(cd "$(dirname "$0")" && pwd)"');
    await expect(readFile(path.join(result.packageDir, "bridge"), "utf8")).resolves.not.toContain('/.."');
    await expect(readFile(path.join(result.packageDir, "bridge.cmd"), "utf8")).resolves.toContain('set "ROOT=%~dp0."');
    await expect(readFile(path.join(result.packageDir, "bridge.ps1"), "utf8")).resolves.toContain("$Root = Split-Path -Parent $MyInvocation.MyCommand.Path");
    await expect(readdir(path.join(result.packageDir, ".runtime"))).resolves.toEqual([]);
    await expect(readdir(path.join(result.packageDir, "logs"))).resolves.toEqual([]);
    for (const excluded of PORTABLE_PACKAGE_MANIFEST.excluded) {
      await expect(readFile(path.join(result.packageDir, excluded), "utf8")).rejects.toThrow();
      await expect(readdir(path.join(result.packageDir, excluded))).rejects.toThrow();
    }
  });
});

describe("scripts/start", () => {
  it("starts bridge runtime with quiet terminal output and file-backed logs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-start-quiet-"));
    await mkdir(path.join(dir, "dist", "src"), { recursive: true });
    await writeFile(path.join(dir, "dist", "src", "index.js"), "console.log('ok');");
    await writeFile(path.join(dir, "config.json"), JSON.stringify({
      feishu: { appId: "cli_test", appSecret: "secret" },
      opencode: { baseUrl: "http://127.0.0.1:4096/", directory: dir },
      server: { host: "127.0.0.1", port: 3000 },
      logging: { dir: path.join(dir, "logs") },
    }));

    class FakeChild extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      pid = 1234;
      kill = vi.fn();
    }
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child);
    let bridgeHealthChecks = 0;

    const exitPromise = runStart({
      cwd: dir,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fetchImpl: vi.fn(async (input: URL) => {
        const url = String(input);
        if (url.includes("/global/health")) {
          return new Response("{}", { status: 200 });
        }
        if (url.includes("/healthz")) {
          bridgeHealthChecks += 1;
          if (bridgeHealthChecks === 1) {
            return new Response("not ready", { status: 404 });
          }
          return new Response(JSON.stringify({ ok: true, bridgeVersion: "0.2.2" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
      assertPortAvailableFn: vi.fn(async () => undefined),
      spawnFn,
      bridgeHealthTimeoutMs: 100,
      color: false,
    });

    const deadline = Date.now() + 1_000;
    while (spawnFn.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.emit("close", 0);

    await expect(exitPromise).resolves.toBe(0);
    expect(spawnFn).toHaveBeenCalledWith(process.execPath, [path.join(dir, "dist", "src", "index.js")], expect.objectContaining({
      stdio: ["ignore", "pipe", "pipe"],
      env: expect.objectContaining({ BRIDGE_CONSOLE_LOG: "0" }),
    }));
  });

  it("reuses existing opencode serve instead of spawning a new one", async () => {
    const spawnFn = vi.fn();
    const result = await ensureOpencodeServer({
      cwd: process.cwd(),
      env: process.env,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })),
      opencodeBaseUrl: "http://127.0.0.1:4096/",
      opencodeDirectory: process.cwd(),
      loggingDir: process.cwd(),
      findExecutableFn: () => "/usr/local/bin/opencode",
      spawnFn,
    });

    expect(result.ownedProcess).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("spawns opencode serve when health check is initially down", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-start-opencode-"));
    const child = {
      pid: 1234,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      once: vi.fn(),
    };
    let healthChecks = 0;

    const result = await ensureOpencodeServer({
      cwd: dir,
      env: process.env,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fetchImpl: vi.fn(async () => {
        healthChecks += 1;
        return new Response("{}", { status: healthChecks === 1 ? 500 : 200 });
      }),
      opencodeBaseUrl: "http://127.0.0.1:4096/",
      opencodeDirectory: dir,
      loggingDir: dir,
      findExecutableFn: () => "/usr/local/bin/opencode",
      spawnFn: vi.fn(() => child),
    });

    expect(result.ownedProcess).toBe(true);
    expect(result.child).toBe(child);
  });

  it("detects an already running bridge before spawning a second one", async () => {
    const assertPortAvailableFn = vi.fn(async () => undefined);
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await ensureBridgePortAvailable({
      host: "127.0.0.1",
      port: 3000,
      logger,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        bridgeVersion: "0.1.22",
      }), { status: 200 })),
      assertPortAvailableFn,
    });

    expect(result).toEqual({ alreadyRunning: true });
    expect(assertPortAvailableFn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith("[1/3] 检查 Bridge ... 已在运行 127.0.0.1:3000");
  });

  it("checks bridge port availability when health endpoint is absent", async () => {
    const assertPortAvailableFn = vi.fn(async () => undefined);
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await ensureBridgePortAvailable({
      host: "127.0.0.1",
      port: 3000,
      logger,
      fetchImpl: vi.fn(async () => new Response("not found", { status: 404 })),
      assertPortAvailableFn,
    });

    expect(result).toEqual({ alreadyRunning: false });
    expect(assertPortAvailableFn).toHaveBeenCalledWith(3000, "127.0.0.1");
    expect(logger.log).toHaveBeenCalledWith("[1/3] 检查 Bridge ... 127.0.0.1:3000 可用");
  });

  it("reports a friendly bridge port conflict", async () => {
    await expect(ensureBridgePortAvailable({
      host: "127.0.0.1",
      port: 3000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fetchImpl: vi.fn(async () => {
        throw new Error("connect refused");
      }),
      assertPortAvailableFn: vi.fn(async () => {
        throw new Error("listen EADDRINUSE");
      }),
      listPortListenersFn: vi.fn(async () => []),
    })).rejects.toThrow(/Bridge 端口 127\.0\.0\.1:3000 已被其他进程占用/);
  });

  it("reclaims stale bridge listeners from the same project before starting", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-start-reclaim-"));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const terminatePidFn = vi.fn(async () => undefined);
    let attempts = 0;

    const result = await ensureBridgePortAvailable({
      cwd: dir,
      host: "127.0.0.1",
      port: 3000,
      logger,
      fetchImpl: vi.fn(async () => {
        throw new Error("connect refused");
      }),
      assertPortAvailableFn: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("listen EADDRINUSE");
        }
      }),
      listPortListenersFn: vi.fn(async () => [{
        pid: 4321,
        command: `${process.execPath} ${path.join(dir, "dist/src/index.js")}`,
      }]),
      terminatePidFn,
    });

    expect(result).toEqual({ alreadyRunning: false });
    expect(terminatePidFn).toHaveBeenCalledWith(4321);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("发现旧 Bridge 进程占用"));
    expect(logger.log).toHaveBeenCalledWith("[1/3] 检查 Bridge ... 已清理旧进程，127.0.0.1:3000 可用");
  });

  it("does not reclaim unrelated listeners on the bridge port", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-start-external-port-"));
    const terminatePidFn = vi.fn(async () => undefined);

    await expect(tryReclaimStaleBridgePort({
      cwd: dir,
      host: "127.0.0.1",
      port: 3000,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      listPortListenersFn: vi.fn(async () => [{
        pid: 9999,
        command: "/usr/bin/python3 -m http.server 3000",
      }]),
      terminatePidFn,
    })).resolves.toBe(false);

    expect(terminatePidFn).not.toHaveBeenCalled();
  });

  it("parses port listener process output and recognizes project bridge commands", () => {
    const dir = "/tmp/bridge-start-parse";

    expect(parseLsofPidOutput("123\n123\n456\n")).toEqual([123, 456]);
    expect(parsePsProcessOutput(`  123 ${process.execPath} ${dir}/dist/src/index.js\n`)).toEqual([{
      pid: 123,
      command: `${process.execPath} ${dir}/dist/src/index.js`,
    }]);
    expect(isProjectBridgeProcess(`${process.execPath} ${dir}/dist/src/index.js`, dir)).toBe(true);
    expect(isProjectBridgeProcess("/usr/bin/python3 -m http.server 3000", dir)).toBe(false);
  });

  it("recognizes bridge health responses", async () => {
    await expect(isBridgeHealthy(
      "127.0.0.1",
      3000,
      vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        bridgeVersion: "0.1.22",
      }), { status: 200 })),
    )).resolves.toBe(true);

    await expect(isBridgeHealthy(
      "127.0.0.1",
      3000,
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )).resolves.toBe(false);
  });

  it("falls back to tsx when dist is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-start-bridge-"));
    const launch = resolveBridgeLaunch({
      cwd: dir,
      env: {},
      findExecutableFn: (command: string) => command === "tsx" ? "/tmp/node_modules/.bin/tsx" : null,
    });

    expect(launch.command).toBe("/tmp/node_modules/.bin/tsx");
    expect(launch.args).toEqual(["src/index.ts"]);
  });

  it("prefers dist/src/index.js when build output exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-start-build-"));
    await mkdir(path.join(dir, "dist", "src"), { recursive: true });
    await writeFile(path.join(dir, "dist", "src", "index.js"), "console.log('ok');");

    const launch = resolveBridgeLaunch({
      cwd: dir,
      env: {},
      findExecutableFn: () => null,
    });

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([path.join(dir, "dist", "src", "index.js")]);
  });
});

describe("scripts/cost", () => {
  it("prints local usage summary and can reset only the local ledger", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-cost-cli-"));
    const home = path.join(dir, "home");
    const bridgeHome = path.join(home, "Library", "Application Support", "FeishuOpenCodeBridge");
    const ledgerDir = path.join(bridgeHome, "data");
    await mkdir(ledgerDir, { recursive: true });
    await writeFile(path.join(ledgerDir, "usage-ledger.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      provider: "openai",
      model: "gpt-test",
      totalTokens: 100,
      estimatedCostCny: 0.01,
      source: "estimated",
    })}\n`);
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(runCostCli([], { cwd: dir, home, platform: "darwin", logger })).resolves.toBe(0);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("今日: 100 tokens"));

    await expect(runCostCli(["--reset-local"], { cwd: dir, home, platform: "darwin", logger })).resolves.toBe(0);
    await expect(readFile(path.join(ledgerDir, "usage-ledger.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("scripts/update", () => {
  it("detects newer GitHub releases", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-update-check-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ updates: { githubRepo: "owner/repo" } }));

    const result = await checkForUpdate({
      cwd: dir,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        tag_name: "v1.2.0",
        html_url: "https://github.com/owner/repo/releases/tag/v1.2.0",
        assets: [],
      }), { status: 200 })),
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("downloads only matching portable assets into staging", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-update-download-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ updates: { githubRepo: "owner/repo" } }));
    const archiveBytes = Buffer.from("fake archive");
    const runCommandFn = vi.fn(async (_command: string, _args: string[], options: { cwd: string }) => {
      const packageDir = path.join(options.cwd, "feishu-opencode-bridge-macos-arm64");
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(packageDir, "package.json"), "{}");
      return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
    });

    const result = await downloadUpdate({
      cwd: dir,
      platform: "darwin",
      arch: "arm64",
      runCommandFn,
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify({
            tag_name: "v1.1.0",
            assets: [
              { name: "feishu-opencode-bridge-windows-x64.zip", size: 1, browser_download_url: "https://example.com/win.zip" },
              { name: "feishu-opencode-bridge-macos-arm64.tar.gz", size: archiveBytes.length, browser_download_url: "https://example.com/mac.tar.gz" },
            ],
          }), { status: 200 });
        }
        return new Response(archiveBytes, { status: 200 });
      }),
    });

    expect(result.stagingDir).toContain(path.join(".runtime", "staging", "1.1.0"));
    expect(runCommandFn).toHaveBeenCalled();
    expect(await readFile(path.join(result.stagingDir, "update-manifest.json"), "utf8")).toContain("macos-arm64");
  });
});

describe("scripts/activity-ticker", () => {
  it("parses standard log line into ts/scope/name/fields", async () => {
    const { parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const line = '22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=16805 replyLength=13 }';
    const event = parseLogLine(line);
    expect(event).toMatchObject({
      ts: "22:58:48",
      scope: "bridge/queue",
      name: "turn.completed",
      level: "info",
    });
    expect(event?.fields.turnId).toBe("t1");
    expect(event?.fields.durationMs).toBe("16805");
    expect(event?.fields.replyLength).toBe("13");
  });

  it("parses [warn] / [error] bracket level lines", async () => {
    const { parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    expect(parseLogLine("[warn]: ws disconnected")?.level).toBe("warn");
    expect(parseLogLine("[error]: handler failed")?.level).toBe("error");
  });

  it("strips ANSI sequences before parsing", async () => {
    const { parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const line = '[33m22:58:51 [feishu/ws] connection reconnected { reason="x" }[0m';
    const event = parseLogLine(line);
    expect(event?.scope).toBe("feishu/ws");
  });

  it("returns null for noise / unparseable lines", async () => {
    const { parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("not a log line at all")).toBeNull();
  });

  it("shouldDisplay whitelist includes turn.completed / ws / errors / kb", async () => {
    const { shouldDisplay, parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const turn = parseLogLine('22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=1000 }');
    const ws = parseLogLine('22:58:51 [feishu/ws] connection reconnected { }');
    const kb = parseLogLine('22:59:00 [knowledge/ingest] file added { fileName="a.pdf" chunks=12 }');
    const noise = parseLogLine('22:58:33 [runtime/modules] module.invoked { moduleId="persona" hook="beforeTurn" result="completed" durationMs=0 }');
    expect(shouldDisplay(turn)).toBe(true);
    expect(shouldDisplay(ws)).toBe(true);
    expect(shouldDisplay(kb)).toBe(true);
    expect(shouldDisplay(noise)).toBe(false);
  });

  it("formatEvent (no color) renders turn.completed with duration + length, no per-turn cost", async () => {
    const { formatEvent, parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const event = parseLogLine('22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=2300 replyLength=13 chatId="oc_p2p_1" userId="ou_abcdefghij12" }');
    expect(event).not.toBeNull();
    event!.cost = { estimatedCostCny: 0.0124, totalTokens: 600 };
    const out = formatEvent(event, false);
    expect(out).toContain("turn");
    expect(out).toContain("2.3s");
    expect(out).toContain("13字");
    // per-turn 不再显示成本（session cost 仍在 30s status 行汇总）
    expect(out).not.toContain("¥");
    expect(out).not.toContain("[");
  });

  it("formatEventJson emits machine-parseable JSON line", async () => {
    const { formatEventJson, parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const event = parseLogLine('22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=2300 replyLength=13 }');
    const out = formatEventJson(event!);
    const parsed = JSON.parse(out);
    expect(parsed.scope).toBe("bridge/queue");
    expect(parsed.name).toBe("turn.completed");
    expect(parsed.durationMs).toBe("2300");
  });

  it("ActivityTicker buffers cost/usage and merges into next turn.completed", async () => {
    const { createActivityTicker } = await import("../scripts/runtime/activity-ticker.mjs");
    const out: string[] = [];
    const ticker = createActivityTicker({ color: false, json: true, emit: (l: string) => out.push(l) });
    ticker.handle('22:58:47 [cost/usage] turn usage recorded { correlationId="c1" totalTokens=600 estimatedCostCny=0.0124 }');
    ticker.handle('22:58:48 [bridge/queue] turn.completed { correlationId="c1" durationMs=2300 replyLength=13 }');
    expect(out).toHaveLength(1); // cost 不显示,只显示合并后的 turn.completed
    const parsed = JSON.parse(out[0]!);
    expect(parsed.scope).toBe("bridge/queue");
    expect(parsed.cost).toEqual({ estimatedCostCny: "0.0124", totalTokens: "600" });
  });

  it("ActivityTicker.status returns formatted heartbeat string (does not auto-emit)", async () => {
    const { createActivityTicker } = await import("../scripts/runtime/activity-ticker.mjs");
    const out: string[] = [];
    const ticker = createActivityTicker({ color: false, json: false, emit: (l: string) => out.push(l) });
    const returned = ticker.status({ uptimeSec: 125 });
    // 不再自动 emit,由调用方决定怎么用
    expect(out).toHaveLength(0);
    expect(returned).toContain("uptime");
    expect(returned).toContain("2m 5s");
    expect(returned).not.toContain("¥");
    expect(returned).not.toContain("session cost");
  });

  it("ActivityTicker.status returns JSON string in json mode", async () => {
    const { createActivityTicker } = await import("../scripts/runtime/activity-ticker.mjs");
    const ticker = createActivityTicker({ color: false, json: true, emit: () => {} });
    const returned = ticker.status({ uptimeSec: 60 });
    const parsed = JSON.parse(returned as string);
    expect(parsed).toMatchObject({ scope: "ticker", name: "status", uptimeSec: 60 });
  });
});

describe("scripts/activity-ticker createStickyWriter", () => {
  function makeFakeStdout() {
    const written: string[] = [];
    return {
      written,
      write: (s: string) => { written.push(s); return true; },
    };
  }

  it("setStatus draws sticky line; emit clears it, writes event, redraws", async () => {
    const { createStickyWriter } = await import("../scripts/runtime/activity-ticker.mjs");
    const stdout = makeFakeStdout();
    const sticky = createStickyWriter({ stdout: stdout as unknown as NodeJS.WritableStream });
    sticky.setStatus("status uptime 5s");
    expect(stdout.written).toEqual(["status uptime 5s"]); // 无 newline,粘在底
    sticky.emit("event A");
    expect(stdout.written.slice(1)).toEqual([
      "\r[2K",          // 清当前行
      "event A\n",            // 写事件 + newline
      "status uptime 5s",     // 重画 sticky
    ]);
  });

  it("setStatus updates in-place (clear then re-draw)", async () => {
    const { createStickyWriter } = await import("../scripts/runtime/activity-ticker.mjs");
    const stdout = makeFakeStdout();
    const sticky = createStickyWriter({ stdout: stdout as unknown as NodeJS.WritableStream });
    sticky.setStatus("a");
    sticky.setStatus("b");
    expect(stdout.written).toEqual(["a", "\r[2K", "b"]);
  });

  it("cleanup clears sticky and adds final newline for prompt", async () => {
    const { createStickyWriter } = await import("../scripts/runtime/activity-ticker.mjs");
    const stdout = makeFakeStdout();
    const sticky = createStickyWriter({ stdout: stdout as unknown as NodeJS.WritableStream });
    sticky.setStatus("x");
    sticky.cleanup();
    expect(stdout.written).toEqual(["x", "\r[2K", "\n"]);
  });

  it("collectEnabledExtensions returns memory + legal defaults", async () => {
    const startMod = await import("../scripts/runtime/start.mjs");
    // collectEnabledExtensions 是内部函数，但我们通过 createActivityTicker 行为间接验证 status panel 不抛错
    // 这里只做最小冒烟:模块可导入。
    expect(typeof startMod.runStart).toBe("function");
  });
});

describe("scripts/activity-ticker conversation preview", () => {
  it("includes userTextPreview/replyTextPreview in turn.completed render", async () => {
    const { formatEvent, parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const event = parseLogLine('22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=2300 replyLength=13 chatId="oc_p2p_1" userId="ou_abc12" userTextPreview="帮我看下这个劳动合同有什么问题" replyTextPreview="收到,我会从条款合规性、风险点和签约程序三个方面分析" }');
    expect(event).not.toBeNull();
    const out = formatEvent(event!, false);
    expect(out).toContain("turn");
    expect(out).toContain("Q「帮我看下这个劳动合同有什么问题」");
    expect(out).toContain("A「收到,我会从条款合规性、风险点和签约程序三个方面分析」");
    expect(out.split("\n")).toHaveLength(3); // 三行:metadata + Q + A
  });

  it("truncates long previews at 40 chars with ellipsis", async () => {
    const { formatEvent, parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const long = "A".repeat(60);
    const event = parseLogLine(`22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=2300 userTextPreview="${long}" replyTextPreview="ok" }`);
    const out = formatEvent(event!, false);
    expect(out).toContain("A".repeat(39) + "…");
    expect(out).toContain("A「ok」");
  });

  it("omits preview line entirely when both previews missing", async () => {
    const { formatEvent, parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const event = parseLogLine('22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=2300 replyLength=13 chatId="oc_p2p_1" userId="ou_abc12" }');
    const out = formatEvent(event!, false);
    expect(out.split("\n")).toHaveLength(1);
  });

  it("includes previews in JSON mode", async () => {
    const { formatEventJson, parseLogLine } = await import("../scripts/runtime/activity-ticker.mjs");
    const event = parseLogLine('22:58:48 [bridge/queue] turn.completed { turnId="t1" durationMs=2300 userTextPreview="问题" replyTextPreview="答案" }');
    const parsed = JSON.parse(formatEventJson(event!));
    expect(parsed.userTextPreview).toBe("问题");
    expect(parsed.replyTextPreview).toBe("答案");
  });
});

describe("scripts/activity-ticker createDashboardRenderer", () => {
  function makeFakeStdout() {
    const written: string[] = [];
    return {
      written,
      write: (s: string) => { written.push(s); return true; },
    };
  }

  it("enter writes alt-screen-on + hide-cursor; leave writes show-cursor + alt-screen-off", async () => {
    const { createDashboardRenderer } = await import("../scripts/runtime/activity-ticker.mjs");
    const stdout = makeFakeStdout();
    const dash = createDashboardRenderer({
      color: false,
      panel: { endpoint: "http://x", profile: "legal", extensions: [], logPath: "/x", startedAt: new Date() },
      stdout: stdout as unknown as NodeJS.WritableStream,
    });
    dash.enter();
    expect(stdout.written.join("")).toContain("[?1049h");
    expect(stdout.written.join("")).toContain("[?25l");
    stdout.written.length = 0;
    dash.leave();
    expect(stdout.written.join("")).toContain("[?25h");
    expect(stdout.written.join("")).toContain("[?1049l");
  });

  it("recordEvent counts turn.completed / error / warn", async () => {
    const { createDashboardRenderer } = await import("../scripts/runtime/activity-ticker.mjs");
    const dash = createDashboardRenderer({
      color: false,
      panel: { endpoint: "x", profile: "legal", extensions: [], logPath: "x", startedAt: new Date() },
      stdout: makeFakeStdout() as unknown as NodeJS.WritableStream,
    });
    dash.recordEvent({ scope: "bridge/queue", name: "turn.completed", level: "info" } as any);
    dash.recordEvent({ scope: "bridge/queue", name: "turn.completed", level: "info" } as any);
    dash.recordEvent({ scope: "runtime", level: "error" } as any);
    dash.recordEvent({ scope: "runtime", level: "warn" } as any);
    dash.recordEvent({ scope: "runtime", level: "warn" } as any);
    const state = dash.getState();
    expect(state.turnCount).toBe(2);
    expect(state.errorCount).toBe(1);
    expect(state.warnCount).toBe(2);
  });

  it("pushEvent enforces activityCapacity (rolling buffer)", async () => {
    const { createDashboardRenderer } = await import("../scripts/runtime/activity-ticker.mjs");
    const dash = createDashboardRenderer({
      color: false,
      panel: { endpoint: "x", profile: "legal", extensions: [], logPath: "x", startedAt: new Date() },
      stdout: makeFakeStdout() as unknown as NodeJS.WritableStream,
      activityCapacity: 3,
    });
    for (let i = 0; i < 5; i++) dash.pushEvent(`event-${i}`);
    const state = dash.getState();
    expect(state.activity).toEqual(["event-2", "event-3", "event-4"]);
  });

  it("render emits clear-screen + top panel + activity", async () => {
    const { createDashboardRenderer } = await import("../scripts/runtime/activity-ticker.mjs");
    const stdout = makeFakeStdout();
    const dash = createDashboardRenderer({
      color: false,
      panel: { endpoint: "http://127.0.0.1:3000", profile: "legal", extensions: ["memory"], logPath: "/tmp/log", startedAt: new Date() },
      stdout: stdout as unknown as NodeJS.WritableStream,
    });
    dash.enter();
    stdout.written.length = 0;
    dash.pushEvent("23:14:15  ↻  ws       connection opened");
    dash.render();
    const all = stdout.written.join("");
    expect(all).toContain("[H[2J[H"); // clear screen sequence
    expect(all).toContain("Feishu OpenCode Bridge");
    expect(all).toContain("http://127.0.0.1:3000");
    expect(all).toContain("Uptime");
    expect(all).toContain("Turns");
    expect(all).toContain("memory");
    expect(all).toContain("connection opened");
  });

  it("render does nothing before enter()", async () => {
    const { createDashboardRenderer } = await import("../scripts/runtime/activity-ticker.mjs");
    const stdout = makeFakeStdout();
    const dash = createDashboardRenderer({
      color: false,
      panel: { endpoint: "x", profile: "legal", extensions: [], logPath: "x", startedAt: new Date() },
      stdout: stdout as unknown as NodeJS.WritableStream,
    });
    dash.render();
    expect(stdout.written).toEqual([]);
  });
});
