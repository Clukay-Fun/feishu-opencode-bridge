/**
 * 职责: 覆盖外部扩展包管理 CLI 的本地目录、tarball 和列表流程。
 * 关注点:
 * - 验证安装工具不接 npm registry，只处理本地目录或 .tgz。
 * - 验证扩展安装后保持独立目录，并在目标目录内执行 npm install。
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  installExtension,
  listExtensions,
  packExtension,
  removeExtension,
  runExtCli,
} from "../scripts/ext/ext.mjs";

describe("external extension CLI", () => {
  it("installs a local extension directory into the configured extensions root", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-ext-cli-"));
    const source = path.join(workspace, "source");
    const extensionsRoot = path.join(workspace, "extensions");
    await writeExtensionPackage(source, "demo");
    await mkdir(path.join(source, "node_modules", "ignored"), { recursive: true });

    const runCommandFn = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    const result = await installExtension({
      cwd: workspace,
      source,
      extensionsRoot,
      runCommandFn,
    });

    expect(result).toEqual({
      id: "demo",
      version: "1.0.0",
      targetDir: path.join(extensionsRoot, "demo"),
    });
    expect(JSON.parse(await readFile(path.join(result.targetDir, "manifest.json"), "utf8"))).toMatchObject({ id: "demo" });
    await expect(stat(path.join(result.targetDir, "node_modules", "ignored"))).rejects.toThrow();
    expect(runCommandFn).toHaveBeenCalledWith("npm", ["install", "--omit=dev", "--no-package-lock=false"], expect.objectContaining({
      cwd: result.targetDir,
      timeoutMs: 600_000,
    }));
  });

  it("installs a tarball by unpacking it through npm and then installing dependencies locally", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-ext-cli-"));
    const tarball = path.join(workspace, "demo-1.0.0.tgz");
    const extensionsRoot = path.join(workspace, "extensions");
    await writeFile(tarball, "fake", "utf8");

    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("--prefix")) {
        const installRoot = args[args.indexOf("--prefix") + 1];
        if (!installRoot) {
          throw new Error("missing --prefix value");
        }
        await writeExtensionPackage(path.join(installRoot, "node_modules", "demo"), "demo");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await installExtension({
      cwd: workspace,
      source: tarball,
      extensionsRoot,
      runCommandFn,
    });

    expect(result.id).toBe("demo");
    expect(await readFile(path.join(result.targetDir, "dist", "runtime.js"), "utf8")).toContain("demo");
    expect(runCommandFn).toHaveBeenCalledWith("npm", expect.arrayContaining(["install", "--prefix"]), expect.anything());
    expect(runCommandFn).toHaveBeenCalledWith("npm", ["install", "--omit=dev", "--no-package-lock=false"], expect.objectContaining({
      cwd: result.targetDir,
    }));
  });

  it("rejects registry-style install inputs", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-ext-cli-"));

    await expect(installExtension({
      cwd: workspace,
      source: "demo-package",
      extensionsRoot: path.join(workspace, "extensions"),
      runCommandFn: vi.fn(),
    })).rejects.toThrow();
  });

  it("lists installed extensions and reads enabled state from config.json", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-ext-cli-"));
    const extensionsRoot = path.join(workspace, "extensions");
    await writeExtensionPackage(path.join(extensionsRoot, "enabled-demo"), "enabled-demo");
    await writeExtensionPackage(path.join(extensionsRoot, "disabled-demo"), "disabled-demo");
    await writeFile(path.join(workspace, "config.json"), JSON.stringify({
      extensions: {
        "enabled-demo": { enabled: true },
        "disabled-demo": { enabled: false },
      },
    }), "utf8");

    const extensions = await listExtensions({ cwd: workspace, extensionsRoot });

    expect((extensions as Array<{ id: string; enabled: string }>).map((extension) => ({
      id: extension.id,
      enabled: extension.enabled,
    }))).toEqual([
      { id: "disabled-demo", enabled: "disabled" },
      { id: "enabled-demo", enabled: "enabled" },
    ]);
  });

  it("removes an installed extension directory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-ext-cli-"));
    const extensionsRoot = path.join(workspace, "extensions");
    const extensionDir = path.join(extensionsRoot, "demo");
    await writeExtensionPackage(extensionDir, "demo");

    await removeExtension({ id: "demo", extensionsRoot });

    await expect(stat(extensionDir)).rejects.toThrow();
  });

  it("packs an extension through npm pack", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-ext-cli-"));
    const source = path.join(workspace, "source");
    await writeExtensionPackage(source, "demo");
    const runCommandFn = vi.fn(async () => ({ code: 0, stdout: "demo-1.0.0.tgz\n", stderr: "" }));

    const result = await packExtension({
      cwd: workspace,
      sourceDir: source,
      packDestination: workspace,
      runCommandFn,
    });

    expect(result).toEqual({
      packageName: "demo",
      version: "1.0.0",
      tarballPath: path.join(workspace, "demo-1.0.0.tgz"),
    });
    expect(runCommandFn).toHaveBeenCalledWith("npm", ["pack", source, "--pack-destination", workspace], expect.anything());
  });

  it("renders list output from the CLI wrapper", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "bridge-ext-cli-"));
    const extensionsRoot = path.join(workspace, "extensions");
    await writeExtensionPackage(path.join(extensionsRoot, "demo"), "demo");
    const logger = { log: vi.fn(), error: vi.fn() };

    const exitCode = await runExtCli(["list"], { cwd: workspace, extensionsRoot, logger });

    expect(exitCode).toBe(0);
    expect(logger.log).toHaveBeenCalledWith("demo\t1.0.0\tunknown");
  });
});

async function writeExtensionPackage(directory: string, id: string): Promise<void> {
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    id,
    version: "1.0.0",
    meta: "dist/meta.js",
    runtime: "dist/runtime.js",
  }), "utf8");
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: id,
    version: "1.0.0",
    type: "module",
    dependencies: {},
  }), "utf8");
  await writeFile(path.join(directory, "dist", "meta.js"), `export default { id: '${id}' };\n`, "utf8");
  await writeFile(path.join(directory, "dist", "runtime.js"), `export default { id: '${id}', createModule: () => null };\n`, "utf8");
}
