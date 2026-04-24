/**
 * 职责: 覆盖onboard/start 脚本启动引导逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  isBridgeHealthy,
  ensureOpencodeServer,
  resolveBridgeLaunch,
} from "../scripts/runtime/start.mjs";

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

describe("scripts/start", () => {
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
    })).rejects.toThrow(/Bridge 端口 127\.0\.0\.1:3000 已被其他进程占用/);
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
