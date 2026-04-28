/**
 * 职责: 管理本地外部扩展包的安装、列出、删除和打包。
 * 关注点:
 * - 只处理本地目录或 .tgz，不连接 npm registry。
 * - 每个扩展保持独立 npm package 与独立 node_modules。
 * - 工具层不做热拔插，扩展变更仍需重启 bridge。
 */
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function runExtCli(args = process.argv.slice(2), options = {}) {
  const command = args[0];
  const logger = options.logger ?? console;

  try {
    if (command === "install") {
      const source = args[1];
      if (!source) {
        throw new Error("用法: npm run ext:install -- <path-or-tarball>");
      }
      const result = await installExtension({ ...options, source });
      logger.log(`已安装扩展 ${result.id}@${result.version} -> ${result.targetDir}`);
      return 0;
    }

    if (command === "list") {
      const extensions = await listExtensions(options);
      if (extensions.length === 0) {
        logger.log("未安装外部扩展。");
        return 0;
      }
      for (const extension of extensions) {
        logger.log(`${extension.id}\t${extension.version}\t${extension.enabled}`);
      }
      return 0;
    }

    if (command === "remove") {
      const id = args[1];
      if (!id) {
        throw new Error("用法: npm run ext:remove -- <id>");
      }
      await removeExtension({ ...options, id });
      logger.log(`已删除扩展 ${id}`);
      return 0;
    }

    if (command === "pack") {
      const sourceDir = args[1];
      if (!sourceDir) {
        throw new Error("用法: npm run ext:pack -- <src-dir>");
      }
      const result = await packExtension({ ...options, sourceDir });
      logger.log(result.tarballPath);
      return 0;
    }

    logger.error("用法: npm run ext:<install|list|remove|pack> -- <args>");
    return 1;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function installExtension(options) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runCommandFn = options.runCommandFn ?? runCommand;
  const source = path.resolve(cwd, options.source);
  const sourceInfo = await stat(source);
  const stagingRoot = await mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "bridge-ext-install-"));

  let stagedPackageDir;
  try {
    if (sourceInfo.isDirectory()) {
      stagedPackageDir = path.join(stagingRoot, "package");
      await copyExtensionDirectory(source, stagedPackageDir);
    } else if (source.endsWith(".tgz")) {
      stagedPackageDir = await unpackTarballToStaging({ source, stagingRoot, cwd, env, runCommandFn });
    } else {
      throw new Error("只支持本地扩展目录或 .tgz tarball");
    }

    const manifest = await readManifest(stagedPackageDir);
    const packageJson = await readPackageJson(stagedPackageDir);
    validatePackage(manifest, packageJson);

    const extensionsRoot = resolveExtensionsRoot(env, options.extensionsRoot);
    const targetDir = path.join(extensionsRoot, manifest.id);
    if (path.resolve(stagedPackageDir) === path.resolve(targetDir)) {
      throw new Error("源扩展目录不能与目标安装目录相同");
    }

    await rm(targetDir, { recursive: true, force: true });
    await cp(stagedPackageDir, targetDir, {
      recursive: true,
      filter: (sourcePath) => !isNestedNodeModules(stagedPackageDir, sourcePath),
    });
    await runNpmInstall({ cwd: targetDir, env, runCommandFn });

    return {
      id: manifest.id,
      version: packageJson.version,
      targetDir,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function listExtensions(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const extensionsRoot = resolveExtensionsRoot(env, options.extensionsRoot);
  const config = await readConfigState(options.configPath ?? path.join(cwd, "config.json"));

  let entries;
  try {
    entries = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const extensions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extensionDir = path.join(extensionsRoot, entry.name);
    try {
      const manifest = await readManifest(extensionDir);
      const packageJson = await readPackageJson(extensionDir);
      extensions.push({
        id: manifest.id,
        version: packageJson.version,
        enabled: resolveEnabledState(config, manifest.id),
        path: extensionDir,
      });
    } catch {
      extensions.push({
        id: entry.name,
        version: "invalid",
        enabled: "unknown",
        path: extensionDir,
      });
    }
  }
  return extensions.sort((left, right) => left.id.localeCompare(right.id));
}

export async function removeExtension(options) {
  const env = options.env ?? process.env;
  const extensionsRoot = resolveExtensionsRoot(env, options.extensionsRoot);
  const targetDir = path.join(extensionsRoot, options.id);
  await rm(targetDir, { recursive: true, force: true });
}

export async function packExtension(options) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runCommandFn = options.runCommandFn ?? runCommand;
  const sourceDir = path.resolve(cwd, options.sourceDir);
  const packageJson = await readPackageJson(sourceDir);
  const packDestination = path.resolve(cwd, options.packDestination ?? ".");
  const result = await runCommandFn("npm", ["pack", sourceDir, "--pack-destination", packDestination], {
    cwd,
    env,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "npm pack 失败");
  }
  const tarballName = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    ?? `${packageJson.name.replace(/^@/, "").replace("/", "-")}-${packageJson.version}.tgz`;
  return {
    packageName: packageJson.name,
    version: packageJson.version,
    tarballPath: path.resolve(packDestination, tarballName),
  };
}

export function resolveExtensionsRoot(env = process.env, explicitRoot) {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  if (env.BRIDGE_EXTENSIONS_DIR) {
    return path.resolve(env.BRIDGE_EXTENSIONS_DIR);
  }
  return path.resolve(env.BRIDGE_HOME ?? ".", "extensions");
}

async function unpackTarballToStaging(options) {
  const installRoot = path.join(options.stagingRoot, "npm-install");
  const result = await options.runCommandFn("npm", [
    "install",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--package-lock=false",
    options.source,
  ], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "npm install tarball 失败");
  }
  return await findInstalledExtensionPackage(path.join(installRoot, "node_modules"));
}

async function findInstalledExtensionPackage(nodeModulesDir) {
  const candidates = [];
  await collectPackageCandidates(nodeModulesDir, candidates);
  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, "manifest.json"))) {
      return candidate;
    }
  }
  throw new Error("tarball 中未找到 manifest.json");
}

async function collectPackageCandidates(directory, candidates) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      await collectPackageCandidates(child, candidates);
      continue;
    }
    candidates.push(child);
  }
}

async function runNpmInstall({ cwd, env, runCommandFn }) {
  const result = await runCommandFn("npm", ["install", "--omit=dev", "--no-package-lock=false"], {
    cwd,
    env,
    timeoutMs: 10 * 60_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "npm install 失败");
  }
}

async function copyExtensionDirectory(source, target) {
  await cp(source, target, {
    recursive: true,
    filter: (sourcePath) => !isNestedNodeModules(source, sourcePath),
  });
}

function isNestedNodeModules(root, sourcePath) {
  const relative = path.relative(root, sourcePath);
  return relative.split(path.sep).includes("node_modules");
}

async function readManifest(extensionDir) {
  const raw = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
  if (!raw?.id || typeof raw.id !== "string") {
    throw new Error("manifest.json 缺少 id");
  }
  return raw;
}

async function readPackageJson(extensionDir) {
  const raw = JSON.parse(await readFile(path.join(extensionDir, "package.json"), "utf8"));
  if (!raw?.name || typeof raw.name !== "string") {
    throw new Error("package.json 缺少 name");
  }
  if (!raw?.version || typeof raw.version !== "string") {
    throw new Error("package.json 缺少 version");
  }
  return raw;
}

function validatePackage(manifest, packageJson) {
  if (packageJson.name !== manifest.id) {
    throw new Error(`package.json name (${packageJson.name}) 必须与 manifest id (${manifest.id}) 一致`);
  }
  if (manifest.version && packageJson.version !== manifest.version) {
    throw new Error(`package.json version (${packageJson.version}) 必须与 manifest version (${manifest.version}) 一致`);
  }
}

async function readConfigState(configPath) {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

function resolveEnabledState(config, id) {
  const value = config?.extensions?.[id];
  if (value && typeof value === "object" && "enabled" in value) {
    return value.enabled === true ? "enabled" : value.enabled === false ? "disabled" : "unknown";
  }
  return "unknown";
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ code: 1, stdout, stderr: error.message });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runExtCli();
}
