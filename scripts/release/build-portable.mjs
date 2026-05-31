/**
 * 职责: 生成 portable release 包目录和压缩包。
 * 关注点:
 * - P0 包只包含运行所需 dist、scripts、配置模板和启动器，不包含 src。
 * - 按当前系统生成 zip 或 tar.gz，供 GitHub Release artifact 使用。
 * - 不负责下载安装外部组件，首次运行由 bridge/bootstrap 完成。
 */
import { cp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isMainModule, runCommand } from "../runtime/checks.mjs";

/** 将 bin/ 启动器的 ROOT 路径回退到当前目录（便携包根目录），避免 /.. 跳到父目录。 */
function patchPortableLauncherRoot(content, filename) {
  if (filename === "bridge") {
    return content.replace(
      /\$\{0\}\)\.\.\//,
      "${0})/",
    ).replace(
      /dirname "\$0"\)\/\.\./g,
      'dirname "$0")',
    );
  }
  if (filename === "bridge.cmd") {
    return content.replace(
      /%~dp0\.\.\\/g,
      "%~dp0.",
    );
  }
  if (filename === "bridge.ps1") {
    return content.replace(
      /Split-Path -Parent \(Split-Path -Parent \$MyInvocation\.MyCommand\.Path\)/,
      "Split-Path -Parent $MyInvocation.MyCommand.Path",
    );
  }
  return content;
}

export const PORTABLE_PACKAGE_MANIFEST = Object.freeze({
  files: Object.freeze([
    "package.json",
    "package-lock.json",
    "config.example.json",
    "config.general.example.json",
    "config.legal.example.json",
    "README.md",
    "README.en.md",
    "LICENSE",
  ]),
  launcherFiles: Object.freeze({
    "bin/bridge": "bridge",
    "bin/bridge.cmd": "bridge.cmd",
    "bin/bridge.ps1": "bridge.ps1",
  }),
  directories: Object.freeze([
    "dist",
    "scripts/runtime",
    "scripts/workspace-init",
  ]),
  emptyDirectories: Object.freeze([
    ".runtime",
    "logs",
  ]),
  excluded: Object.freeze([
    "bin",
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
  // 拷贝 bin/ 下的启动器到包根目录，同时替换 ROOT 为当前目录（包根目录）。
  for (const [source, dest] of Object.entries(PORTABLE_PACKAGE_MANIFEST.launcherFiles)) {
    const srcPath = path.join(cwd, source);
    const destPath = path.join(packageDir, dest);
    const srcContent = await readFile(srcPath, "utf-8");
    const patched = patchPortableLauncherRoot(srcContent, dest);
    await writeFile(destPath, patched);
    if (source.endsWith(".sh") || source === "bin/bridge" || source === "bin/bridge.cmd" || source === "bin/setup.command" || source === "bin/start.command") {
      await chmod(destPath, 0o755);
    }
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

  // 构建后敏感数据泄漏检查
  await verifyNoSensitiveDataLeak(packageDir, logger);

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

/** 构建后校验：确保产物不含敏感数据。 */
async function verifyNoSensitiveDataLeak(packageDir, logger) {
  const { readdir, stat } = await import("node:fs/promises");
  const forbiddenNames = new Set([
    "config.json", ".env", "secrets.json", "secrets.yaml",
    "knowledge-base.db", "memory.db", "usage-ledger.jsonl",
    "mappings.json", "message-context.json", "active-knowledge-ingests.json",
    ".git",
  ]);
  const forbiddenExtensions = new Set([".db", ".log", ".env"]);

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 空的 logs/ 和 .runtime/ 目录是允许的
        if (forbiddenNames.has(entry.name)) {
          const subEntries = await readdir(fullPath);
          if (subEntries.length > 0) {
            results.push(fullPath);
          }
        }
        results.push(...await walk(fullPath));
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (forbiddenNames.has(entry.name) || forbiddenExtensions.has(ext)) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }

  const leaks = await walk(packageDir);
  if (leaks.length > 0) {
    const relativeLeaks = leaks.map((f) => path.relative(packageDir, f));
    throw new Error(`敏感数据泄漏！产物中发现禁止文件:\n${relativeLeaks.join("\n")}`);
  }
  logger.log("敏感数据校验通过：产物中未发现 data/logs/config.json/.db/.env/.git");
}

if (isMainModule(import.meta.url)) {
  try {
    await buildPortablePackage();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
