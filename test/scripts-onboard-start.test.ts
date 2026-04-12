import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ensureLarkCliInstalled,
  generateConfigObject,
  shouldRebuildConfig,
} from "../scripts/onboard.mjs";
import {
  ensureOpencodeServer,
  resolveBridgeLaunch,
} from "../scripts/start.mjs";

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
