#!/usr/bin/env node
/**
 * 职责: feishu-opencode-bridge / fob 全局命令的 Node 分发入口。
 * 关注点:
 * - npm 全局安装时,bin 字段指向本文件(必须是 Node-runnable .mjs/.cjs/.js)。
 * - 运行时按平台分发到对应 shell 启动器(bin/bridge / bin/bridge.cmd)。
 * - `mcp` 子命令直接运行 MCP stdio server,不走 shell 启动器。
 * - 跟随软链接到包内真实路径,兼容 `npm i -g` 在 /usr/local/bin/ 创建的 symlink。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

// 解析自身真实路径(跟随软链接 → npm 全局安装的真实 bin/cli.mjs)
const SELF = realpathSync(fileURLToPath(import.meta.url));
const BIN_DIR = path.dirname(SELF);
const PACKAGE_ROOT = path.dirname(BIN_DIR);
const BRIDGE_APP_DIR_NAME = "FeishuOpenCodeBridge";

// 检查是否为 mcp 子命令 — 直接运行 MCP stdio server
const args = process.argv.slice(2);
if (args[0] === "mcp") {
  // Dynamic import to avoid loading MCP SDK when not needed
  const { startMcpServer } = await import(path.join(PACKAGE_ROOT, "dist", "src", "mcp", "server.js"));
  const dataDir = resolveMcpDataDir();
  await startMcpServer(dataDir);
  await waitForMcpStdioClose();
  process.exit(0);
}

function waitForMcpStdioClose() {
  return new Promise((resolve) => {
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function resolveMcpDataDir() {
  const explicitDataDir = trimEnv("BRIDGE_DATA_DIR");
  if (explicitDataDir) {
    return path.resolve(explicitDataDir);
  }

  const configPath = resolveMcpConfigPath();
  if (configPath) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      const configuredDataDir = parsed?.storage?.dataDir;
      if (typeof configuredDataDir === "string" && configuredDataDir.trim().length > 0) {
        return path.isAbsolute(configuredDataDir)
          ? configuredDataDir
          : path.resolve(path.dirname(configPath), configuredDataDir);
      }
    } catch (err) {
      process.stderr.write(`Bridge MCP: 读取配置失败,将使用默认数据目录: ${err.message}\n`);
    }
  }

  return path.join(resolveBridgeHome(), "data");
}

function resolveMcpConfigPath() {
  const explicitConfigPath = trimEnv("BRIDGE_CONFIG_PATH");
  if (explicitConfigPath) {
    return path.resolve(explicitConfigPath);
  }

  const bridgeHomeConfigPath = path.join(resolveBridgeHome(), "config.json");
  if (existsSync(bridgeHomeConfigPath)) {
    return bridgeHomeConfigPath;
  }

  const cwdConfigPath = path.resolve(process.cwd(), "config.json");
  if (existsSync(cwdConfigPath)) {
    return cwdConfigPath;
  }

  return null;
}

function resolveBridgeHome() {
  const explicitBridgeHome = trimEnv("BRIDGE_HOME");
  if (explicitBridgeHome) {
    return path.resolve(explicitBridgeHome);
  }

  if (process.platform === "win32") {
    const home = trimEnv("USERPROFILE") || process.cwd();
    const base = trimEnv("LOCALAPPDATA") || path.join(home, "AppData", "Local");
    return path.join(base, BRIDGE_APP_DIR_NAME);
  }

  const home = trimEnv("HOME") || process.cwd();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", BRIDGE_APP_DIR_NAME);
  }

  const xdgDataHome = trimEnv("XDG_DATA_HOME");
  return path.join(xdgDataHome || path.join(home, ".local", "share"), BRIDGE_APP_DIR_NAME);
}

function trimEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// 按平台选启动器
const isWindows = process.platform === "win32";
const launcher = isWindows
  ? path.join(BIN_DIR, "bridge.cmd")
  : path.join(BIN_DIR, "bridge");

if (!existsSync(launcher)) {
  console.error(`错误: 找不到启动器 ${launcher}`);
  console.error(`包根目录: ${PACKAGE_ROOT}`);
  console.error(`这可能是 npm 安装包不完整导致,请重新安装:`);
  console.error(`  npm i -g feishu-opencode-bridge@beta`);
  process.exit(1);
}

// 透传所有参数 + 环境变量,使用 inherit stdio 让用户直接看到输出
const child = spawn(launcher, args, {
  stdio: "inherit",
  env: process.env,
  shell: isWindows, // Windows 需要 shell:true 才能运行 .cmd
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on("error", (err) => {
  console.error(`启动 ${launcher} 失败:`, err.message);
  process.exit(1);
});
