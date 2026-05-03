/**
 * 职责: 启动本地 Bridge 运行栈，并在需要时拉起 OpenCode 服务。
 * 关注点:
 * - 检查 Bridge 端口是否已被当前服务占用。
 * - 复用或启动 OpenCode Server。
 * - 选择 dist/tsx 入口启动 Bridge 主进程，并负责退出清理。
 */
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveProjectConfigPath } from "./portable.mjs";
import { markGuidePromptShown, readOnboardingState, resolveOnboardingStatePath } from "./onboarding-state.mjs";
import {
  createAugmentedEnv,
  assertPortAvailable,
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
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);
  const configState = await readProjectConfig(cwd, configPath);

  if (!configState.exists || configState.error || !configState.config) {
    throw new Error(`缺少可用的 config.json：${configPath}，请先运行 bridge onboard 或 npm run onboard`);
  }

  const rawConfig = configState.config;
  const opencodeBaseUrl = typeof rawConfig?.opencode?.baseUrl === "string" ? rawConfig.opencode.baseUrl : "";
  const opencodeDirectory = resolveConfigValue(configState.configPath, rawConfig?.opencode?.directory);
  const loggingDir = resolveConfigValue(configState.configPath, rawConfig?.logging?.dir) ?? path.join(cwd, "logs");
  const serverHost = typeof rawConfig?.server?.host === "string" ? rawConfig.server.host : "127.0.0.1";
  const serverPort = Number(rawConfig?.server?.port ?? 3000);

  if (!opencodeBaseUrl || !opencodeDirectory) {
    throw new Error("config.json 缺少 opencode.baseUrl 或 opencode.directory");
  }

  await mkdir(loggingDir, { recursive: true });

  logger.log("Feishu OpenCode Bridge");

  const bridgePort = await ensureBridgePortAvailable({
    host: serverHost,
    port: serverPort,
    logger,
    fetchImpl,
    assertPortAvailableFn: options.assertPortAvailableFn ?? assertPortAvailable,
  });
  if (bridgePort.alreadyRunning) {
    logger.log("Bridge 已在运行，可以直接回到飞书继续使用。");
    await maybePrintGuidePrompt({ config: rawConfig, configPath, logger });
    return 0;
  }

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
  await maybePrintGuidePrompt({ config: rawConfig, configPath, logger });
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

export async function maybePrintGuidePrompt(options) {
  const statePath = resolveOnboardingStatePath(options.config, options.configPath);
  const state = await readOnboardingState(statePath);
  if (state.guideShownAt) {
    return false;
  }
  options.logger.log("");
  options.logger.log("新手提示：Bridge 启动后，回到飞书发送 /guide 查看 60 秒新手引导。");
  options.logger.log("如果不确定下一步，终端运行 bridge guide。");
  await markGuidePromptShown(statePath);
  return true;
}

// Check whether the configured Bridge port is free or already served by this project.
export async function ensureBridgePortAvailable(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? 3000);
  const logger = options.logger ?? console;

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("config.json server.port 不合法");
  }

  if (await isBridgeHealthy(host, port, options.fetchImpl ?? fetch, options.healthTimeoutMs ?? 1_000)) {
    logger.log(`[1/3] 检查 Bridge ... 已在运行 ${host}:${port}`);
    return { alreadyRunning: true };
  }

  try {
    await (options.assertPortAvailableFn ?? assertPortAvailable)(port, host);
    logger.log(`[1/3] 检查 Bridge ... ${host}:${port} 可用`);
    return { alreadyRunning: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Bridge 端口 ${host}:${port} 已被其他进程占用。若是旧的 Bridge，请先关闭旧窗口或结束旧进程后再启动；若只是想使用，直接回到飞书即可。详情：${detail}`);
  }
}

// Probe the Bridge health endpoint to distinguish a live bridge from a random port listener.
export async function isBridgeHealthy(host, port, fetchImpl = fetch, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildBridgeHealthUrl(host, port), { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json().catch(() => null);
    return Boolean(
      payload
      && typeof payload === "object"
      && payload.ok === true
      && typeof payload.bridgeVersion === "string",
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Reuse an existing OpenCode server or start a managed local one when baseUrl is local.
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

// Resolve whether to launch the built output or fall back to `tsx src/index.ts`.
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

// Stop a child process only when this script owns its lifecycle.
export async function stopManagedProcess(child, options = {}) {
  if (!options.owned || !child) {
    return;
  }
  await terminateChild(child, options.platform ?? process.platform);
}

// Probe OpenCode health using the configured baseUrl.
export async function isOpencodeHealthy(baseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(new URL("global/health", ensureTrailingSlash(baseUrl)));
    return response.ok;
  } catch {
    return false;
  }
}

// Poll until OpenCode becomes healthy or the timeout elapses.
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

// Restrict auto-start behavior to loopback OpenCode addresses.
function isLocalBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

// Normalize base URLs before appending health paths.
function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

// Build the local Bridge health URL from host and port settings.
function buildBridgeHealthUrl(host, port) {
  const hostname = host === "0.0.0.0" ? "127.0.0.1" : host;
  const wrappedHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return new URL(`http://${wrappedHost}:${port}/healthz`);
}

// Guard against missing dist entries or executables.
function pathExists(target) {
  return Boolean(target) && existsSync(target);
}

// Sleep between health-check polling attempts.
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
