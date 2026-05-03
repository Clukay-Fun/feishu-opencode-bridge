/**
 * 职责: 提供 portable 包的 GitHub Release 检查、下载和 staging 切换。
 * 关注点:
 * - 只更新程序包目录，不触碰 BRIDGE_HOME 用户数据。
 * - 下载到 .runtime/staging 后由用户显式 apply 或下次启动前切换。
 * - 失败时保留 previous，避免半更新覆盖当前版本。
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { isMainModule, readProjectConfig, runCommand } from "./checks.mjs";
import { createPortableEnv, resolveRuntimeDir } from "./portable.mjs";

const UPDATE_MANIFEST = "update-manifest.json";

export async function runUpdateCli(args = process.argv.slice(2), options = {}) {
  const command = args[0] ?? "check";
  const logger = options.logger ?? console;
  if (command === "check") {
    const result = await checkForUpdate(options);
    printCheckResult(result, logger);
    return 0;
  }
  if (command === "download") {
    const result = await downloadUpdate(options);
    logger.log(`已下载到 staging：${result.stagingDir}`);
    logger.log("运行 bridge update apply 后切换；建议先运行 bridge backup。");
    return 0;
  }
  if (command === "apply") {
    const result = await applyUpdate(options);
    logger.log(`已切换到 ${result.version}。如需回滚，运行 bridge update rollback。`);
    return 0;
  }
  if (command === "rollback") {
    const result = await rollbackUpdate(options);
    logger.log(`已回滚到：${result.restoredFrom}`);
    return 0;
  }
  logger.error("用法: bridge update check|download|apply|rollback");
  return 1;
}

export async function checkForUpdate(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = createPortableEnv({ cwd, env: options.env ?? process.env, platform: options.platform, home: options.home });
  const config = await readConfig(cwd, env);
  const currentVersion = await readCurrentVersion(cwd);
  const latest = await fetchLatestRelease(config.githubRepo, options.fetchImpl ?? fetch);
  const latestVersion = normalizeVersion(latest.tag_name ?? latest.name ?? "");
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    releaseUrl: latest.html_url,
    release: latest,
    githubRepo: config.githubRepo,
  };
}

export async function downloadUpdate(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const check = options.release ? {
    currentVersion: await readCurrentVersion(cwd),
    latestVersion: normalizeVersion(options.release.tag_name ?? options.release.name ?? ""),
    hasUpdate: true,
    release: options.release,
  } : await checkForUpdate(options);
  if (!check.hasUpdate) {
    throw new Error(`当前已是最新版本：${check.currentVersion}`);
  }

  const asset = selectPortableAsset(check.release.assets ?? [], platform, arch);
  if (!asset) {
    throw new Error(`未找到匹配当前平台的 portable 包：${toPackagePlatform(platform)}-${toPackageArch(arch)}`);
  }
  const runtimeDir = resolveRuntimeDir(cwd);
  const stagingDir = path.join(runtimeDir, "staging", check.latestVersion);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  const archivePath = path.join(stagingDir, asset.name);
  const response = await (options.fetchImpl ?? fetch)(asset.browser_download_url);
  if (!response.ok) {
    throw new Error(`下载失败：${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || (typeof asset.size === "number" && asset.size > 0 && bytes.length !== asset.size)) {
    throw new Error("下载文件大小异常，拒绝进入 staging。");
  }
  await writeFile(archivePath, bytes);
  await extractArchive(archivePath, stagingDir, platform, options.runCommandFn ?? runCommand);
  const packageDir = await findExtractedPackageDir(stagingDir);
  await writeFile(path.join(stagingDir, UPDATE_MANIFEST), JSON.stringify({
    schemaVersion: 1,
    version: check.latestVersion,
    assetName: asset.name,
    packageDir,
    createdAt: new Date().toISOString(),
  }, null, 2));
  return { stagingDir, archivePath, version: check.latestVersion, packageDir };
}

export async function applyUpdate(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runtimeDir = resolveRuntimeDir(cwd);
  const stagingRoot = path.join(runtimeDir, "staging");
  const stagingDir = options.stagingDir ?? await findLatestStagingDir(stagingRoot);
  if (!stagingDir) {
    throw new Error("未找到 staging 更新包，请先运行 bridge update download。");
  }
  const manifest = JSON.parse(await readFile(path.join(stagingDir, UPDATE_MANIFEST), "utf8"));
  const packageDir = manifest.packageDir;
  if (!packageDir || !existsSync(packageDir)) {
    throw new Error("staging manifest 指向的包目录不存在。");
  }
  const previousDir = path.join(runtimeDir, "previous", manifest.version);
  await mkdir(path.dirname(previousDir), { recursive: true });
  await rm(previousDir, { recursive: true, force: true });
  await cp(cwd, previousDir, { recursive: true, filter: (source) => {
    const relative = path.relative(cwd, source);
    return !relative.startsWith(path.join(".runtime", "staging"))
      && !relative.startsWith(path.join(".runtime", "previous"));
  } });
  await copyPackageContents(packageDir, cwd);
  await rm(stagingDir, { recursive: true, force: true });
  await writeFile(path.join(runtimeDir, "last-update.json"), JSON.stringify({
    schemaVersion: 1,
    version: manifest.version,
    previousDir,
    appliedAt: new Date().toISOString(),
  }, null, 2));
  return { version: manifest.version, previousDir };
}

export async function rollbackUpdate(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runtimeDir = resolveRuntimeDir(cwd);
  const last = JSON.parse(await readFile(path.join(runtimeDir, "last-update.json"), "utf8"));
  if (!last.previousDir || !existsSync(last.previousDir)) {
    throw new Error("未找到可用 previous 目录，无法回滚。");
  }
  await copyPackageContents(last.previousDir, cwd);
  return { restoredFrom: last.previousDir };
}

export async function maybeCheckForUpdateOnStart(options = {}) {
  const logger = options.logger ?? console;
  try {
    const cwd = options.cwd ?? process.cwd();
    const env = createPortableEnv({ cwd, env: options.env ?? process.env, platform: options.platform, home: options.home });
    const config = await readConfig(cwd, env);
    if (!config.checkOnStart) {
      return null;
    }
    const result = await checkForUpdate(options);
    if (result.hasUpdate) {
      logger.log(`发现新版 ${result.latestVersion}（当前 ${result.currentVersion}）：${result.releaseUrl ?? ""}`);
      logger.log("运行 bridge update download 下载到 staging；下载后运行 bridge update apply 切换。");
    }
    return result;
  } catch (error) {
    logger.warn?.(`更新检查失败，已跳过：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function readConfig(cwd, env) {
  const state = await readProjectConfig(cwd, env.BRIDGE_CONFIG_PATH);
  const raw = state.config ?? {};
  return {
    checkOnStart: raw.updates?.checkOnStart !== false,
    githubRepo: typeof raw.updates?.githubRepo === "string" ? raw.updates.githubRepo : "clukay/feishu-opencode-bridge",
  };
}

async function fetchLatestRelease(repo, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "feishu-opencode-bridge" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release 查询失败：${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function readCurrentVersion(cwd) {
  const parsed = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  return normalizeVersion(parsed.version ?? "0.0.0");
}

function selectPortableAsset(assets, platform, arch) {
  const platformName = toPackagePlatform(platform);
  const archName = toPackageArch(arch);
  return assets.find((asset) => typeof asset.name === "string"
    && asset.name.includes(platformName)
    && asset.name.includes(archName)
    && (asset.name.endsWith(".zip") || asset.name.endsWith(".tar.gz")));
}

async function extractArchive(archivePath, stagingDir, platform, runCommandFn) {
  const result = platform === "win32"
    ? await runCommandFn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${stagingDir}' -Force`], { cwd: stagingDir, timeoutMs: 5 * 60_000 })
    : await runCommandFn("tar", ["-xzf", archivePath, "-C", stagingDir], { cwd: stagingDir, timeoutMs: 5 * 60_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "解压更新包失败");
  }
}

async function findExtractedPackageDir(stagingDir) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("feishu-opencode-bridge-"));
  if (!match) {
    throw new Error("更新包内未找到 portable 包目录。");
  }
  return path.join(stagingDir, match.name);
}

async function findLatestStagingDir(stagingRoot) {
  if (!existsSync(stagingRoot)) return null;
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(stagingRoot, entry.name))
    .sort()
    .at(-1) ?? null;
}

async function copyPackageContents(sourceDir, targetDir) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(sourceDir);
  for (const entry of entries) {
    if (entry === ".runtime") continue;
    await rm(path.join(targetDir, entry), { recursive: true, force: true });
    await cp(path.join(sourceDir, entry), path.join(targetDir, entry), { recursive: true });
  }
}

function printCheckResult(result, logger) {
  if (!result.hasUpdate) {
    logger.log(`当前已是最新版本：${result.currentVersion}`);
    return;
  }
  logger.log(`发现新版：${result.latestVersion}（当前 ${result.currentVersion}）`);
  if (result.releaseUrl) logger.log(result.releaseUrl);
  logger.log("下载：bridge update download");
}

function normalizeVersion(version) {
  return String(version).trim().replace(/^v/, "") || "0.0.0";
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split(".").map((part) => Number(part) || 0);
  const right = normalizeVersion(b).split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
    process.exitCode = await runUpdateCli();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
