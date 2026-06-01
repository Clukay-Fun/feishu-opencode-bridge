/**
 * 职责: 启动本地 Bridge 运行栈，并在需要时拉起 OpenCode 服务。
 * 关注点:
 * - 检查 Bridge 端口是否已被当前服务占用。
 * - 复用或启动 OpenCode Server。
 * - 选择 dist/tsx 入口启动 Bridge 主进程，并负责退出清理。
 */
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { resolveProjectConfigPath } from "./portable.mjs";
import { maybeCheckForUpdateOnStart } from "./update.mjs";
import { createActivityTicker, createLogTailer, createStickyWriter } from "./activity-ticker.mjs";
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

const execFileAsync = promisify(execFile);

export async function runStart(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? fetch;
  const home = options.home ?? os.homedir();
  const env = createAugmentedEnv(cwd, options.env ?? process.env, home);
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);
  const configState = await readProjectConfig(cwd, configPath);

  if (!configState.exists || configState.error || !configState.config) {
    throw new Error(`缺少可用的 config.json：${configPath}，请先运行 bridge setup 或 npm run bridge -- setup`);
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

  const colorMode = options.color ?? Boolean(process.stdout.isTTY);
  const jsonMode = options.jsonOutput ?? (!process.stdout.isTTY);
  const ui = options.ui ?? createStartUi(logger, { color: colorMode });

  ui.header();
  await maybeCheckForUpdateOnStart({ cwd, env, logger, fetchImpl, platform: options.platform, home });

  const bridgePort = await ensureBridgePortAvailable({
    cwd,
    host: serverHost,
    port: serverPort,
    logger,
    fetchImpl,
    assertPortAvailableFn: options.assertPortAvailableFn ?? assertPortAvailable,
    listPortListenersFn: options.listPortListenersFn ?? listPortListeners,
    terminatePidFn: options.terminatePidFn ?? terminatePid,
  });
  if (bridgePort.alreadyRunning) {
    logger.log("Bridge 已在运行，可以直接回到飞书继续使用。");
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
  const bridgeRuntimeLogPath = path.join(loggingDir, "bridge-runtime.log");
  const bridgeRuntimeLogStream = createWriteStream(bridgeRuntimeLogPath, { flags: "a" });
  const bridgeEnv = {
    ...bridgeLaunch.env,
    BRIDGE_CONSOLE_LOG: "0",
  };
  logger.log(`[3/3] 启动 Bridge Runtime ... ${bridgeLaunch.command}`);
  logger.log(`      运行日志: ${bridgeRuntimeLogPath}`);
  const bridgeProcess = (options.spawnFn ?? spawn)(bridgeLaunch.command, bridgeLaunch.args, {
    cwd,
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  bridgeProcess.stdout?.pipe(bridgeRuntimeLogStream);
  bridgeProcess.stderr?.pipe(bridgeRuntimeLogStream);

  const bridgeHealthy = await waitForBridgeHealth(serverHost, serverPort, fetchImpl, options.bridgeHealthTimeoutMs ?? 30_000);
  if (bridgeHealthy) {
    logger.log(`[3/3] Bridge Runtime ... 已启动 http://${serverHost}:${serverPort}`);
    ui.statusPanel({
      endpoint: `http://${serverHost}:${serverPort}`,
      profile: typeof rawConfig?.profile === "string" ? rawConfig.profile : "legal",
      extensions: collectEnabledExtensions(rawConfig),
      logPath: bridgeRuntimeLogPath,
      startedAt: new Date(),
    });
  } else {
    logger.warn?.(`[3/3] Bridge Runtime ... healthz 暂未就绪，Bridge 进程仍在运行`);
    logger.warn?.(`      运行日志: ${bridgeRuntimeLogPath}`);
    const recentRuntimeLogs = await readRecentLogLines(bridgeRuntimeLogPath, 12);
    if (recentRuntimeLogs) {
      logger.warn?.("      最近日志:");
      for (const line of recentRuntimeLogs.split("\n")) {
        logger.warn?.(`      ${line}`);
      }
    }
  }

  // 启动 Activity Ticker:tail bridge-runtime.log,按白名单过滤渲染
  // TTY 下用 sticky writer 把心跳钉在最后一行,事件在它上面滚,心跳原地刷新;
  // 非 TTY(JSON / 重定向)走 append-only 走 logger.log。
  let activityTickerHandle = null;
  if (bridgeHealthy && options.activityTicker !== false) {
    const isStickyMode = colorMode && !jsonMode && options.sticky !== false;
    const sticky = isStickyMode ? (options.stickyWriter ?? createStickyWriter({ stdout: options.stdout ?? process.stdout })) : null;

    const ticker = createActivityTicker({
      color: colorMode,
      json: jsonMode,
      emit: sticky ? (line) => sticky.emit(line) : (line) => logger.log(line),
    });
    const tailer = createLogTailer({
      filePath: bridgeRuntimeLogPath,
      intervalMs: options.tickerPollMs ?? 500,
      onLine: (line) => ticker.handle(line),
      startFromEnd: true,
    });
    const startedAt = Date.now();
    // sticky 模式 1s 一跳(原地刷新无成本);非 sticky 模式 30s 一行(避免刷屏)。
    const intervalMs = sticky ? 1000 : (options.statusEverySec ? options.statusEverySec * 1000 : 30_000);
    const statusInterval = setInterval(() => {
      const text = ticker.status({ uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
      if (sticky) {
        sticky.setStatus(text);
      } else if (jsonMode) {
        logger.log(text); // JSON 行
      }
      // 普通追加模式(无颜色无 JSON 的奇怪场景):不打心跳,避免刷屏
    }, intervalMs);
    // 初次立刻显示一次心跳
    if (sticky) {
      sticky.setStatus(ticker.status({ uptimeSec: 0 }));
    }
    activityTickerHandle = { tailer, statusInterval, sticky };
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (activityTickerHandle) {
      activityTickerHandle.tailer.stop();
      clearInterval(activityTickerHandle.statusInterval);
      activityTickerHandle.sticky?.cleanup();
    }
    await stopManagedProcess(bridgeProcess, { owned: true });
    await stopManagedProcess(opencode.child, { owned: opencode.ownedProcess });
    bridgeRuntimeLogStream.end();
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
      bridgeRuntimeLogStream.end();
      resolve(undefined);
    });
  });

  await stopManagedProcess(opencode.child, { owned: opencode.ownedProcess });
  return process.exitCode ?? 0;
}

function createStartUi(logger, options = {}) {
  const color = Boolean(options.color);
  const style = {
    bold: (value) => color ? `\u001b[1m${value}\u001b[22m` : value,
    dim: (value) => color ? `\u001b[2m${value}\u001b[22m` : value,
    green: (value) => color ? `\u001b[32m${value}\u001b[39m` : value,
  };
  return {
    header() {
      logger.log("");
      logger.log(style.bold("Feishu OpenCode Bridge"));
      logger.log(style.dim("Local runtime console"));
      logger.log("--------------------------------------------------");
    },
    /** 启动成功后渲染完整状态面板。 */
    statusPanel({ endpoint, profile, extensions, logPath, startedAt }) {
      const ts = startedAt instanceof Date ? startedAt.toTimeString().slice(0, 8) : "?";
      logger.log("");
      logger.log("═══════════════════════════════════════════════════════");
      logger.log(`  ${style.bold("Feishu OpenCode Bridge")}`);
      logger.log("═══════════════════════════════════════════════════════");
      logger.log("");
      logger.log(`  Status     ${style.green("● Running")}`);
      logger.log(`  Endpoint   ${endpoint}`);
      logger.log(`  Profile    ${profile}`);
      logger.log(`  Started    ${ts}`);
      if (extensions && extensions.length > 0) {
        logger.log("");
        logger.log(`  Extensions`);
        for (const ext of extensions) {
          logger.log(`    ${style.green("●")} ${ext}`);
        }
      }
      logger.log("");
      logger.log(`  Logs       ${logPath}`);
      logger.log(`  Quit       Ctrl+C`);
      logger.log("");
      logger.log("───────────────────────────────────────────────────────");
      logger.log(`  ${style.dim("Live activity (turns · ws · errors · kb · cards)")}`);
      logger.log("───────────────────────────────────────────────────────");
      logger.log("");
    },
  };
}

/** 从 config 提取启用的扩展 id 列表(用于 status panel)。 */
function collectEnabledExtensions(config) {
  if (!config || typeof config !== "object") return [];
  const result = [];
  const extensions = config.extensions ?? {};
  const KNOWN = ["memory", "knowledge-base", "contract-assistant", "labor-skill", "case-workbench"];
  for (const id of KNOWN) {
    const cfg = extensions[id];
    if (cfg && typeof cfg.enabled === "boolean") {
      if (cfg.enabled) result.push(id);
      continue;
    }
    if (id === "memory") {
      const memoryEnabled = config.memory?.enabled;
      if (memoryEnabled !== false) result.push(id);
    } else if (config.profile === "legal" || !config.profile) {
      result.push(id);
    }
  }
  return result;
}

// Check whether the configured Bridge port is free or already served by this project.
export async function ensureBridgePortAvailable(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? 3000);
  const logger = options.logger ?? console;
  const assertPortAvailableFn = options.assertPortAvailableFn ?? assertPortAvailable;

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("config.json server.port 不合法");
  }

  if (await isBridgeHealthy(host, port, options.fetchImpl ?? fetch, options.healthTimeoutMs ?? 1_000)) {
    logger.log(`[1/3] 检查 Bridge ... 已在运行 ${host}:${port}`);
    return { alreadyRunning: true };
  }

  try {
    await assertPortAvailableFn(port, host);
    logger.log(`[1/3] 检查 Bridge ... ${host}:${port} 可用`);
    return { alreadyRunning: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reclaimed = await tryReclaimStaleBridgePort({
      cwd,
      host,
      port,
      logger,
      listPortListenersFn: options.listPortListenersFn ?? listPortListeners,
      terminatePidFn: options.terminatePidFn ?? terminatePid,
    });
    if (reclaimed) {
      await assertPortAvailableFn(port, host);
      logger.log(`[1/3] 检查 Bridge ... 已清理旧进程，${host}:${port} 可用`);
      return { alreadyRunning: false };
    }
    throw new Error(`Bridge 端口 ${host}:${port} 已被其他进程占用。若是旧的 Bridge，请先关闭旧窗口或结束旧进程后再启动；若只是想使用，直接回到飞书即可。详情：${detail}`);
  }
}

// Reclaim only stale Bridge processes that belong to this project directory.
export async function tryReclaimStaleBridgePort(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const logger = options.logger ?? console;
  const listeners = await (options.listPortListenersFn ?? listPortListeners)(options.port, options.host);
  const staleListeners = listeners.filter((listener) => isProjectBridgeProcess(listener.command, cwd));

  if (staleListeners.length === 0) {
    return false;
  }

  logger.warn?.(`[1/3] 检查 Bridge ... 发现旧 Bridge 进程占用 ${options.host}:${options.port}，正在清理：${staleListeners.map((item) => item.pid).join(", ")}`);
  for (const listener of staleListeners) {
    await (options.terminatePidFn ?? terminatePid)(listener.pid);
  }
  await sleep(1_000);
  return true;
}

// List listening processes for a TCP port using platform tools.
export async function listPortListeners(port, _host = "127.0.0.1") {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const result = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    });
    const pids = parseLsofPidOutput(result.stdout);
    if (pids.length === 0) {
      return [];
    }
    const psResult = await execFileAsync("ps", ["-p", pids.join(","), "-o", "pid=,command="], {
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    });
    return parsePsProcessOutput(psResult.stdout);
  } catch {
    return [];
  }
}

// Parse `lsof -t` output into unique numeric process ids.
export function parseLsofPidOutput(output) {
  return [...new Set(String(output ?? "")
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isFinite(pid) && pid > 0))];
}

// Parse `ps -o pid=,command=` output into pid/command pairs.
export function parsePsProcessOutput(output) {
  const processes = [];
  for (const rawLine of String(output ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (match) {
      processes.push({ pid: Number(match[1]), command: match[2] ?? "" });
    }
  }
  return processes.filter((item) => Number.isFinite(item.pid));
}

// Decide whether a port listener is a stale Bridge runtime from the same checkout.
export function isProjectBridgeProcess(command, cwd) {
  const normalizedCommand = String(command ?? "");
  const normalizedCwd = path.resolve(cwd);
  return normalizedCommand.includes(normalizedCwd)
    && (
      normalizedCommand.includes("scripts/runtime/bootstrap.mjs")
      || normalizedCommand.includes("dist/src/index.js")
      || normalizedCommand.includes("dist/index.js")
      || normalizedCommand.includes("src/index.ts")
    );
}

// Terminate a process by pid, escalating only if it does not exit.
export async function terminatePid(pid, platform = process.platform) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(100);
  }

  if (platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已经退出；这里不再把清理失败升级成启动失败。
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

// Poll until Bridge becomes healthy or the timeout elapses.
export async function waitForBridgeHealth(host, port, fetchImpl = fetch, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBridgeHealthy(host, port, fetchImpl)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function readRecentLogLines(logPath, maxLines = 12) {
  try {
    const content = await readFile(logPath, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .join("\n");
  } catch {
    return "";
  }
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
