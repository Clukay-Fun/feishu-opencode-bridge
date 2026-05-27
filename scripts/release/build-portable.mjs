/**
 * 职责: 生成 portable release 包目录和压缩包。
 * 关注点:
 * - P0 包只包含运行所需 dist、scripts、配置模板和启动器，不包含 src。
 * - 按当前系统生成 zip 或 tar.gz，供 GitHub Release artifact 使用。
 * - 不负责下载安装外部组件，首次运行由 bridge/bootstrap 完成。
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isMainModule, runCommand } from "../runtime/checks.mjs";

export const PORTABLE_PACKAGE_MANIFEST = Object.freeze({
  files: Object.freeze([
    "bridge",
    "bridge.cmd",
    "bridge.ps1",
    "package.json",
    "package-lock.json",
    "config.example.json",
    "README.md",
    "README.en.md",
    "LICENSE",
  ]),
  directories: Object.freeze([
    "dist",
    "scripts/runtime",
  ]),
  emptyDirectories: Object.freeze([
    ".runtime",
    "logs",
  ]),
  excluded: Object.freeze([
    "src",
    "test",
    "docs",
    "examples",
    "artifacts",
    "outputs",
    "turn-files",
    "data",
    "logs/bridge.log",
    "config.json",
    "knowledge-base.db",
    "mappings.json",
    "message-context.json",
    "usage-ledger.jsonl",
    "active-knowledge-ingests.json",
    "batch-create.json",
    "batch-create-weekly.json",
  ]),
});

export async function buildPortablePackage(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const logger = options.logger ?? console;
  const outRoot = options.outRoot ?? path.join(cwd, "release");
  const packageName = `feishu-opencode-bridge-${toPackagePlatform(platform)}-${toPackageArch(arch)}`;
  const packageDir = path.join(outRoot, packageName);

  if (!existsSync(path.join(cwd, "dist"))) {
    throw new Error("未检测到 dist，请先运行 npm run build。");
  }

  await rm(packageDir, { recursive: true, force: true });
  await mkdir(packageDir, { recursive: true });

  for (const file of PORTABLE_PACKAGE_MANIFEST.files) {
    await cp(path.join(cwd, file), path.join(packageDir, file), { recursive: true });
  }
  for (const directory of PORTABLE_PACKAGE_MANIFEST.directories) {
    await cp(path.join(cwd, directory), path.join(packageDir, directory), { recursive: true });
  }
  for (const directory of PORTABLE_PACKAGE_MANIFEST.emptyDirectories) {
    await mkdir(path.join(packageDir, directory), { recursive: true });
  }

  const archivePath = await archivePackage({
    cwd: outRoot,
    packageName,
    platform,
    runCommandFn: options.runCommandFn ?? runCommand,
  });
  logger.log(`portable 包已生成：${archivePath}`);
  return { packageDir, archivePath };
}

async function archivePackage(options) {
  if (options.platform === "win32") {
    const archivePath = path.join(options.cwd, `${options.packageName}.zip`);
    await rm(archivePath, { force: true });
    const result = await options.runCommandFn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path '${options.packageName}' -DestinationPath '${path.basename(archivePath)}' -Force`,
    ], { cwd: options.cwd, timeoutMs: 5 * 60_000 });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "Compress-Archive 失败");
    }
    return archivePath;
  }

  const archivePath = path.join(options.cwd, `${options.packageName}.tar.gz`);
  await rm(archivePath, { force: true });
  const result = await options.runCommandFn("tar", ["-czf", path.basename(archivePath), options.packageName], {
    cwd: options.cwd,
    timeoutMs: 5 * 60_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "tar 打包失败");
  }
  return archivePath;
}

function toPackagePlatform(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return platform;
}

function toPackageArch(arch) {
  return arch === "arm64" ? "arm64" : "x64";
}

if (isMainModule(import.meta.url)) {
  try {
    await buildPortablePackage();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
