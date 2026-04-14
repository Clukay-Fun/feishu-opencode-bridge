import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createAugmentedEnv,
  findBuildEntry,
  findExecutable,
  isMainModule,
  readProjectConfig,
  resolveConfigValue,
  terminateChild,
} from "./checks.mjs";

export async function runStart(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? fetch;
  const home = options.home ?? os.homedir();
  const env = createAugmentedEnv(cwd, options.env ?? process.env, home);
  const configState = await readProjectConfig(cwd);

  if (!configState.exists || configState.error || !configState.config) {
    throw new Error("缺少可用的 config.json，请先运行 npm run onboard");
  }

  const rawConfig = configState.config;
  const opencodeBaseUrl = typeof rawConfig?.opencode?.baseUrl === "string" ? rawConfig.opencode.baseUrl : "";
  const opencodeDirectory = resolveConfigValue(configState.configPath, rawConfig?.opencode?.directory);
  const loggingDir = resolveConfigValue(configState.configPath, rawConfig?.logging?.dir) ?? path.join(cwd, "logs");

  if (!opencodeBaseUrl || !opencodeDirectory) {
    throw new Error("config.json 缺少 opencode.baseUrl 或 opencode.directory");
  }

  await mkdir(loggingDir, { recursive: true });

  logger.log("Feishu OpenCode Bridge");

  const opencode = await ensureOpencodeServer({
    cwd,
    env,
    logger,
    fetchImpl,
    opencodeBaseUrl,
    opencodeDirectory,
    loggingDir,
    findExecutableFn: options.findExecutableFn ?? findExecutable,
    spawnFn: options.spawnFn ?? spawn,
  });

  const bridgeLaunch = resolveBridgeLaunch({
    cwd,
    env,
    findExecutableFn: options.findExecutableFn ?? findExecutable,
  });
  logger.log(`[3/3] 启动 Bridge ... ${bridgeLaunch.command}`);
  const bridgeProcess = (options.spawnFn ?? spawn)(bridgeLaunch.command, bridgeLaunch.args, {
    cwd,
    env: bridgeLaunch.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await stopManagedProcess(bridgeProcess, { owned: true });
    await stopManagedProcess(opencode.child, { owned: opencode.ownedProcess });
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await new Promise((resolve, reject) => {
    bridgeProcess.once("error", reject);
    bridgeProcess.once("close", (code) => {
      process.exitCode = code ?? 0;
      resolve(undefined);
    });
  });

  await stopManagedProcess(opencode.child, { owned: opencode.ownedProcess });
  return process.exitCode ?? 0;
}

export async function ensureOpencodeServer(options) {
  const logger = options.logger ?? console;
  const alreadyHealthy = await isOpencodeHealthy(options.opencodeBaseUrl, options.fetchImpl);
  if (alreadyHealthy) {
    logger.log("[2/3] 检查 OpenCode Server ... 复用已运行服务");
    return {
      ownedProcess: false,
      child: null,
    };
  }

  if (!isLocalBaseUrl(options.opencodeBaseUrl)) {
    throw new Error(`OpenCode 未运行，且当前 baseUrl 不是本地地址：${options.opencodeBaseUrl}`);
  }

  const opencodePath = options.findExecutableFn("opencode", {
    cwd: options.cwd,
    env: options.env,
    home: options.home,
  });
  if (!opencodePath) {
    throw new Error("未检测到 opencode 命令，请先安装 OpenCode");
  }

  logger.log("[2/3] 启动 OpenCode Server ...");
  const logStream = createWriteStream(path.join(options.loggingDir, "opencode.log"), { flags: "a" });
  const child = options.spawnFn(opencodePath, ["serve"], {
    cwd: options.opencodeDirectory,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  const healthy = await waitForOpencodeHealth(options.opencodeBaseUrl, options.fetchImpl);
  if (!healthy) {
    await terminateChild(child);
    throw new Error("OpenCode health 检查超时");
  }

  return {
    ownedProcess: true,
    child,
  };
}

export function resolveBridgeLaunch(options) {
  const cwd = options.cwd ?? process.cwd();
  const env = createAugmentedEnv(cwd, options.env ?? process.env);
  const distEntry = findBuildEntry(cwd);
  if (distEntry && pathExists(distEntry)) {
    return {
      command: process.execPath,
      args: [distEntry],
      env,
    };
  }

  const tsxPath = (options.findExecutableFn ?? findExecutable)("tsx", { cwd, env });
  if (tsxPath) {
    return {
      command: tsxPath,
      args: ["src/index.ts"],
      env,
    };
  }

  throw new Error("未找到 dist/index.js / dist/src/index.js，也未检测到 tsx。请先执行 npm install 或 npm run build。");
}

export async function stopManagedProcess(child, options = {}) {
  if (!options.owned || !child) {
    return;
  }
  await terminateChild(child, options.platform ?? process.platform);
}

export async function isOpencodeHealthy(baseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(new URL("global/health", ensureTrailingSlash(baseUrl)));
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForOpencodeHealth(baseUrl, fetchImpl = fetch, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOpencodeHealthy(baseUrl, fetchImpl)) {
      return true;
    }
    await sleep(1_000);
  }
  return false;
}

function isLocalBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function pathExists(target) {
  return Boolean(target) && existsSync(target);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (isMainModule(import.meta.url)) {
  try {
    const exitCode = await runStart();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
