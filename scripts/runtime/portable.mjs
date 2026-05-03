/**
 * 职责: 收口 portable 包的目录、环境变量和 Node 下载元数据。
 * 关注点:
 * - 为 bridge.cmd / bridge / bootstrap 提供一致的用户数据目录和运行时目录。
 * - 只在 portable 入口显式设置 BRIDGE_HOME 时改变配置位置，保留开发期默认行为。
 * - 不负责实际下载安装或启动业务进程。
 */
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PORTABLE_NODE_VERSION = "v22.15.0";
export const PORTABLE_APP_DIR_NAME = "FeishuOpenCodeBridge";

export function resolvePackageRoot(currentFileUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(currentFileUrl)), "..", "..");
}

export function resolveBridgeHome(options = {}) {
  const env = options.env ?? process.env;
  if (typeof env.BRIDGE_HOME === "string" && env.BRIDGE_HOME.trim().length > 0) {
    return path.resolve(env.BRIDGE_HOME);
  }

  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  if (platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim().length > 0
      ? env.LOCALAPPDATA
      : path.join(home, "AppData", "Local");
    return path.join(localAppData, PORTABLE_APP_DIR_NAME);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", PORTABLE_APP_DIR_NAME);
  }

  const xdgDataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME
    : path.join(home, ".local", "share");
  return path.join(xdgDataHome, PORTABLE_APP_DIR_NAME);
}

export function resolveRuntimeDir(packageRoot = process.cwd()) {
  return path.join(packageRoot, ".runtime");
}

export function resolveProjectConfigPath(cwd = process.cwd(), env = process.env) {
  if (typeof env.BRIDGE_CONFIG_PATH === "string" && env.BRIDGE_CONFIG_PATH.trim().length > 0) {
    return path.resolve(env.BRIDGE_CONFIG_PATH);
  }
  if (typeof env.BRIDGE_HOME === "string" && env.BRIDGE_HOME.trim().length > 0) {
    return path.join(resolveBridgeHome({ env }), "config.json");
  }
  return path.join(cwd, "config.json");
}

export function createPortableEnv(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const runtimeDir = resolveRuntimeDir(cwd);
  const bridgeHome = resolveBridgeHome({ env, platform, home });
  const nodeBinDir = platform === "win32"
    ? path.join(runtimeDir, "node")
    : path.join(runtimeDir, "node", "bin");
  const npmGlobalBin = platform === "win32"
    ? path.join(runtimeDir, "npm-global", "node_modules", ".bin")
    : path.join(runtimeDir, "npm-global", "bin");
  const localBin = path.join(cwd, "node_modules", ".bin");
  const pathValue = [nodeBinDir, npmGlobalBin, localBin, env.PATH ?? ""]
    .filter(Boolean)
    .join(path.delimiter);
  const preserveXdg = env.BRIDGE_PRESERVE_XDG === "1";

  const portableEnv = {
    ...env,
    PATH: pathValue,
    BRIDGE_HOME: bridgeHome,
    BRIDGE_CONFIG_PATH: resolveProjectConfigPath(cwd, { ...env, BRIDGE_HOME: bridgeHome }),
    npm_config_cache: env.npm_config_cache ?? path.join(runtimeDir, "npm-cache"),
  };

  if (preserveXdg) {
    // 保留用户 shell 的 XDG_DATA_HOME；若用户未设置，则不要注入，交给 OpenCode 回落到 ~/.local/share。
    if (typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim().length > 0) {
      portableEnv.XDG_DATA_HOME = env.XDG_DATA_HOME;
    } else {
      delete portableEnv.XDG_DATA_HOME;
    }
  } else {
    portableEnv.XDG_DATA_HOME = path.join(bridgeHome, "xdg-data");
  }

  return portableEnv;
}

export async function ensurePortableDirectories(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const bridgeHome = resolveBridgeHome({ env, platform: options.platform, home: options.home });
  const runtimeDir = resolveRuntimeDir(cwd);
  await Promise.all([
    mkdir(bridgeHome, { recursive: true }),
    mkdir(path.join(bridgeHome, "data"), { recursive: true }),
    mkdir(path.join(bridgeHome, "logs"), { recursive: true }),
    mkdir(path.join(bridgeHome, "extensions"), { recursive: true }),
    mkdir(path.join(bridgeHome, "xdg-data"), { recursive: true }),
    mkdir(path.join(runtimeDir, "npm-cache"), { recursive: true }),
    mkdir(path.join(runtimeDir, "npm-global"), { recursive: true }),
  ]);
  return { bridgeHome, runtimeDir };
}

export function resolveNodeDownload(options = {}) {
  const version = options.version ?? PORTABLE_NODE_VERSION;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nodeArch = arch === "arm64" ? "arm64" : "x64";
  if (platform === "win32") {
    const name = `node-${version}-win-${nodeArch}`;
    return {
      archiveName: `${name}.zip`,
      url: `https://nodejs.org/dist/${version}/${name}.zip`,
      innerDir: name,
    };
  }
  if (platform === "darwin") {
    const name = `node-${version}-darwin-${nodeArch}`;
    return {
      archiveName: `${name}.tar.gz`,
      url: `https://nodejs.org/dist/${version}/${name}.tar.gz`,
      innerDir: name,
    };
  }
  if (platform === "linux") {
    const name = `node-${version}-linux-${nodeArch}`;
    return {
      archiveName: `${name}.tar.xz`,
      url: `https://nodejs.org/dist/${version}/${name}.tar.xz`,
      innerDir: name,
    };
  }
  throw new Error(`暂不支持自动下载 Node：platform=${platform}, arch=${arch}`);
}
