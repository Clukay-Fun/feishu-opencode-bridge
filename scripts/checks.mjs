import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BRIDGE_GROUP = "bridge";
export const LARK_GROUP = "lark";
export const MIN_NODE_MAJOR = 20;
export const MIN_LARK_VERSION = "1.0.8";
const OPENCODE_AUTH_REFRESH_WARN_MS = 24 * 60 * 60 * 1_000;

const STATUS_ICON = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  skip: "--",
};

export function isMainModule(metaUrl, argv = process.argv) {
  const entry = argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(path.resolve(entry)).href === metaUrl;
}

export function createResult(id, group, label, status, detail, hint) {
  return {
    id,
    group,
    label,
    status,
    detail,
    ...(hint ? { hint } : {}),
  };
}

export function formatCheckLine(result) {
  return `[${STATUS_ICON[result.status]}] ${result.label.padEnd(16, " ")} ${result.detail}`;
}

export function formatCheckHint(result) {
  return result.hint ? `     → ${result.hint}` : "";
}

export function getPreferredBinDirs(cwd = process.cwd(), env = process.env, home = os.homedir()) {
  const pathDirs = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const extraDirs = [
    path.join(cwd, "node_modules", ".bin"),
    path.join(home, ".local", "node_modules", ".bin"),
  ];
  return Array.from(new Set([...extraDirs, ...pathDirs]));
}

export function createAugmentedEnv(cwd = process.cwd(), env = process.env, home = os.homedir()) {
  return {
    ...env,
    PATH: getPreferredBinDirs(cwd, env, home).join(path.delimiter),
  };
}

export function findExecutable(command, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dirs = getPreferredBinDirs(cwd, env, options.home ?? os.homedir());
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  const candidates = [];
  if (command.includes(path.sep)) {
    candidates.push(command);
  } else {
    for (const dir of dirs) {
      for (const extension of extensions) {
        candidates.push(path.join(dir, platform === "win32" ? appendExtension(command, extension) : command));
      }
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function runCommand(command, args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const shell = options.shell ?? process.platform === "win32";
  const timeoutMs = options.timeoutMs ?? 30_000;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateChild(child).finally(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          code: null,
          signal: "SIGTERM",
          stdout,
          stderr,
          timedOut: true,
        });
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

export async function readProjectConfig(cwd = process.cwd(), configPath = path.join(cwd, "config.json")) {
  try {
    const rawText = await readFile(configPath, "utf8");
    const config = JSON.parse(rawText);
    return {
      exists: true,
      configPath,
      config,
      rawText,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        exists: false,
        configPath,
        config: null,
        rawText: null,
      };
    }

    return {
      exists: true,
      configPath,
      config: null,
      rawText: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function resolveConfigValue(configPath, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value);
}

export function compareSemver(actual, minimum) {
  const actualParts = actual.split(".").map((part) => Number.parseInt(part, 10));
  const minimumParts = minimum.split(".").map((part) => Number.parseInt(part, 10));
  const max = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < max; index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

export function extractVersion(text) {
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export function assessLarkAuthPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return createResult("lark-auth", LARK_GROUP, "Lark 登录态", "fail", "lark-cli auth status 输出不可识别", "运行 lark-cli auth login");
  }

  const tokenStatus = typeof payload.tokenStatus === "string" ? payload.tokenStatus : null;
  const identity = typeof payload.identity === "string" ? payload.identity : "unknown";
  const note = typeof payload.note === "string" ? payload.note : "";

  if (tokenStatus === "valid" || tokenStatus === "needs_refresh") {
    return createResult(
      "lark-auth",
      LARK_GROUP,
      "Lark 登录态",
      "pass",
      `identity=${identity}, tokenStatus=${tokenStatus}`,
      tokenStatus === "needs_refresh" ? "refresh token 失效后需要重新运行 lark-cli auth login" : undefined,
    );
  }

  if (tokenStatus) {
    return createResult("lark-auth", LARK_GROUP, "Lark 登录态", "fail", `tokenStatus=${tokenStatus}`, "运行 lark-cli auth login");
  }

  if (identity === "user") {
    return createResult("lark-auth", LARK_GROUP, "Lark 登录态", "pass", "identity=user");
  }

  if (identity === "bot") {
    return createResult(
      "lark-auth",
      LARK_GROUP,
      "Lark 登录态",
      "fail",
      note || "仅检测到 bot 身份，未完成用户授权",
      "运行 lark-cli auth login",
    );
  }

  return createResult("lark-auth", LARK_GROUP, "Lark 登录态", "warn", `identity=${identity}`);
}

export function assessOpencodeAuthPayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return createResult(
      "opencode-auth",
      BRIDGE_GROUP,
      "OpenCode 认证",
      "fail",
      "未检测到 provider 凭证",
      "运行 opencode providers login",
    );
  }

  const credentials = Object.entries(payload)
    .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
    .map(([providerId, credential]) => ({
      providerId,
      credential,
      expires: typeof credential.expires === "number" ? credential.expires : null,
      type: typeof credential.type === "string" ? credential.type : "unknown",
    }));

  if (credentials.length === 0) {
    return createResult(
      "opencode-auth",
      BRIDGE_GROUP,
      "OpenCode 认证",
      "fail",
      "未检测到 provider 凭证",
      "运行 opencode providers login",
    );
  }

  const expired = credentials.filter((item) => item.expires !== null && item.expires <= now);
  if (expired.length === credentials.length) {
    const target = expired.length === 1 ? ` -p ${expired[0].providerId}` : "";
    return createResult(
      "opencode-auth",
      BRIDGE_GROUP,
      "OpenCode 认证",
      "fail",
      `已配置 ${credentials.length} 个 provider，但登录态已过期`,
      `运行 opencode providers login${target}`,
    );
  }

  const expiringSoon = credentials.filter((item) => item.expires !== null && item.expires > now && item.expires - now <= OPENCODE_AUTH_REFRESH_WARN_MS);
  const providerNames = credentials.map((item) => formatProviderName(item.providerId)).join("、");
  if (expiringSoon.length > 0) {
    return createResult(
      "opencode-auth",
      BRIDGE_GROUP,
      "OpenCode 认证",
      "warn",
      `已配置 ${credentials.length} 个 provider：${providerNames}，部分登录态即将过期`,
      "如果后续出现 401，请重新执行 opencode providers login",
    );
  }

  return createResult(
    "opencode-auth",
    BRIDGE_GROUP,
    "OpenCode 认证",
    "pass",
    `已配置 ${credentials.length} 个 provider：${providerNames}`,
  );
}

export async function checkConfigExists(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, "config.json");
  const state = await readProjectConfig(cwd, configPath);
  if (!state.exists) {
    return createResult("config-exists", BRIDGE_GROUP, "配置文件", "fail", "未找到 config.json", "复制 config.example.json 并填写必要字段");
  }
  if (state.error) {
    return createResult("config-exists", BRIDGE_GROUP, "配置文件", "fail", `config.json 解析失败：${state.error.message}`, "修复 JSON 格式后重试");
  }
  return createResult("config-exists", BRIDGE_GROUP, "配置文件", "pass", "config.json 已加载");
}

export async function checkConfigFeishu(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("config-feishu", BRIDGE_GROUP, "飞书配置", "skip", "等待 config.json");
  }

  const appId = state.config?.feishu?.appId;
  const appSecret = state.config?.feishu?.appSecret;
  if (!isConfiguredValue(appId) || !isConfiguredValue(appSecret)) {
    return createResult("config-feishu", BRIDGE_GROUP, "飞书配置", "fail", "缺少 feishu.appId 或 feishu.appSecret", "在开放平台创建应用后填写 appId / appSecret");
  }
  return createResult("config-feishu", BRIDGE_GROUP, "飞书配置", "pass", "appId / appSecret 已填写");
}

export async function checkConfigOpencode(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("config-opencode", BRIDGE_GROUP, "OpenCode 配置", "skip", "等待 config.json");
  }
  const baseUrl = state.config?.opencode?.baseUrl;
  const directory = state.config?.opencode?.directory;
  if (!isConfiguredValue(baseUrl) || !isConfiguredValue(directory)) {
    return createResult("config-opencode", BRIDGE_GROUP, "OpenCode 配置", "fail", "缺少 opencode.baseUrl 或 opencode.directory", "填写 OpenCode 服务地址和工作目录");
  }
  return createResult("config-opencode", BRIDGE_GROUP, "OpenCode 配置", "pass", "baseUrl / directory 已填写");
}

export async function checkConfigPublicUrl(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("config-publicurl", BRIDGE_GROUP, "公网回调", "skip", "等待 config.json");
  }
  const enabled = state.config?.feishu?.cardActions?.enabled === true;
  if (!enabled) {
    return createResult("config-publicurl", BRIDGE_GROUP, "公网回调", "skip", "未启用卡片按钮模式");
  }
  const publicBaseUrl = state.config?.server?.publicBaseUrl;
  if (!isConfiguredValue(publicBaseUrl) || isExampleUrl(publicBaseUrl)) {
    return createResult("config-publicurl", BRIDGE_GROUP, "公网回调", "fail", "已启用卡片按钮，但 server.publicBaseUrl 未正确配置", "填写可公网访问的 HTTPS 地址");
  }
  return createResult("config-publicurl", BRIDGE_GROUP, "公网回调", "pass", "publicBaseUrl 已配置");
}

export async function checkNodeVersion(options = {}) {
  const version = options.version ?? process.version;
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0] ?? "0", 10);
  if (major >= MIN_NODE_MAJOR) {
    return createResult("node-version", BRIDGE_GROUP, "Node.js", "pass", `Node.js ${version}`);
  }
  return createResult("node-version", BRIDGE_GROUP, "Node.js", "fail", `当前版本 ${version}，需要 >= v${MIN_NODE_MAJOR}`, `先安装 Node.js ${MIN_NODE_MAJOR}+`);
}

export async function checkDepsInstalled(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const nodeModulesDir = path.join(cwd, "node_modules");
  if (existsSync(nodeModulesDir)) {
    return createResult("deps-installed", BRIDGE_GROUP, "项目依赖", "pass", "node_modules 已存在");
  }
  return createResult("deps-installed", BRIDGE_GROUP, "项目依赖", "fail", "未检测到 node_modules", "运行 npm install");
}

export async function checkOpencodeBin(options = {}) {
  const executable = (options.findExecutableFn ?? findExecutable)("opencode", options);
  if (executable) {
    return createResult("opencode-bin", BRIDGE_GROUP, "OpenCode 命令", "pass", executable);
  }
  return createResult("opencode-bin", BRIDGE_GROUP, "OpenCode 命令", "fail", "未检测到 opencode", "安装 OpenCode 后重试");
}

export async function checkOpencodeServe(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("opencode-serve", BRIDGE_GROUP, "OpenCode 健康", "skip", "等待 config.json");
  }
  const baseUrl = state.config?.opencode?.baseUrl;
  if (!isConfiguredValue(baseUrl)) {
    return createResult("opencode-serve", BRIDGE_GROUP, "OpenCode 健康", "skip", "等待 opencode.baseUrl");
  }
  try {
    const response = await (options.fetchImpl ?? fetch)(new URL("global/health", ensureTrailingSlash(baseUrl)));
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return createResult("opencode-serve", BRIDGE_GROUP, "OpenCode 健康", "pass", "健康检查通过");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createResult("opencode-serve", BRIDGE_GROUP, "OpenCode 健康", "fail", detail, "确认 opencode serve 已启动");
  }
}

export async function checkOpencodeAuth(options = {}) {
  const executable = (options.findExecutableFn ?? findExecutable)("opencode", options);
  if (!executable) {
    return createResult("opencode-auth", BRIDGE_GROUP, "OpenCode 认证", "skip", "等待 opencode");
  }

  const payload = await readOpencodeAuth(options.home, {
    env: options.env,
    platform: options.platform,
  });
  return assessOpencodeAuthPayload(payload);
}

export async function checkOpencodeModels(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("opencode-models", BRIDGE_GROUP, "OpenCode 模型", "skip", "等待 config.json");
  }
  if (options.healthResult && options.healthResult.status !== "pass") {
    return createResult("opencode-models", BRIDGE_GROUP, "OpenCode 模型", "skip", "等待 OpenCode 健康检查");
  }
  const baseUrl = state.config?.opencode?.baseUrl;
  if (!isConfiguredValue(baseUrl)) {
    return createResult("opencode-models", BRIDGE_GROUP, "OpenCode 模型", "skip", "等待 opencode.baseUrl");
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(new URL("config/providers", ensureTrailingSlash(baseUrl)));
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    const providerCount = providers.length;
    const modelCount = providers.reduce((sum, provider) => {
      const models = provider && typeof provider === "object" && provider.models && typeof provider.models === "object"
        ? Object.keys(provider.models).length
        : 0;
      return sum + models;
    }, 0);

    if (providerCount === 0) {
      return createResult("opencode-models", BRIDGE_GROUP, "OpenCode 模型", "fail", "未检测到可用 provider", "运行 opencode providers login");
    }
    if (modelCount === 0) {
      return createResult("opencode-models", BRIDGE_GROUP, "OpenCode 模型", "fail", `已检测到 ${providerCount} 个 provider，但没有可用模型`, "检查 provider 登录状态或发送 /model 查看列表");
    }
    return createResult("opencode-models", BRIDGE_GROUP, "OpenCode 模型", "pass", `${providerCount} 个 provider，${modelCount} 个模型`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createResult("opencode-models", BRIDGE_GROUP, "OpenCode 模型", "fail", detail, "确认 provider 已登录并可访问 /config/providers");
  }
}

export async function checkOpencodeDirectory(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("opencode-directory", BRIDGE_GROUP, "工作目录", "skip", "等待 config.json");
  }
  const configured = state.config?.opencode?.directory;
  const resolved = resolveConfigValue(state.configPath, configured);
  if (!resolved) {
    return createResult("opencode-directory", BRIDGE_GROUP, "工作目录", "skip", "等待 opencode.directory");
  }
  try {
    await access(resolved, constants.R_OK);
  } catch {
    return createResult("opencode-directory", BRIDGE_GROUP, "工作目录", "fail", `目录不存在：${resolved}`, "修改 config.opencode.directory");
  }

  const gitDir = path.join(resolved, ".git");
  if (existsSync(gitDir)) {
    return createResult("opencode-directory", BRIDGE_GROUP, "工作目录", "pass", resolved);
  }
  return createResult(
    "opencode-directory",
    BRIDGE_GROUP,
    "工作目录",
    "warn",
    `${resolved} 不是 git 仓库`,
    "如果 OpenCode 需要在其他项目目录工作，请修改 config.opencode.directory",
  );
}

export async function checkLarkBin(options = {}) {
  const executable = (options.findExecutableFn ?? findExecutable)("lark-cli", options);
  if (executable) {
    return createResult("lark-bin", LARK_GROUP, "Lark CLI", "pass", executable);
  }
  return createResult("lark-bin", LARK_GROUP, "Lark CLI", "fail", "未检测到 lark-cli", "运行 npm install -g @larksuite/cli");
}

export async function checkLarkVersion(options = {}) {
  const executable = (options.findExecutableFn ?? findExecutable)("lark-cli", options);
  if (!executable) {
    return createResult("lark-version", LARK_GROUP, "Lark 版本", "skip", "等待 lark-cli");
  }
  try {
    const result = await (options.runCommandFn ?? runCommand)(executable, ["--version"], {
      cwd: options.cwd,
      env: options.env,
    });
    const version = extractVersion(result.stdout + result.stderr);
    if (!version) {
      return createResult("lark-version", LARK_GROUP, "Lark 版本", "warn", "无法解析版本号");
    }
    if (compareSemver(version, MIN_LARK_VERSION) >= 0) {
      return createResult("lark-version", LARK_GROUP, "Lark 版本", "pass", version);
    }
    return createResult("lark-version", LARK_GROUP, "Lark 版本", "warn", `当前版本 ${version}，建议升级到 ${MIN_LARK_VERSION}+`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createResult("lark-version", LARK_GROUP, "Lark 版本", "warn", detail);
  }
}

export async function checkLarkAuth(options = {}) {
  const executable = (options.findExecutableFn ?? findExecutable)("lark-cli", options);
  if (!executable) {
    return createResult("lark-auth", LARK_GROUP, "Lark 登录态", "skip", "等待 lark-cli");
  }
  try {
    const result = await (options.runCommandFn ?? runCommand)(executable, ["auth", "status"], {
      cwd: options.cwd,
      env: options.env,
    });
    const payload = tryParseJson(result.stdout);
    return assessLarkAuthPayload(payload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createResult("lark-auth", LARK_GROUP, "Lark 登录态", "fail", detail, "运行 lark-cli auth login");
  }
}

export async function checkLarkDoctor(options = {}) {
  const executable = (options.findExecutableFn ?? findExecutable)("lark-cli", options);
  if (!executable) {
    return createResult("lark-doctor", LARK_GROUP, "Lark Doctor", "skip", "等待 lark-cli");
  }
  try {
    const result = await (options.runCommandFn ?? runCommand)(executable, ["doctor"], {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    if (result.code === 0) {
      return createResult("lark-doctor", LARK_GROUP, "Lark Doctor", "pass", summarizeCommandOutput(result));
    }
    return createResult("lark-doctor", LARK_GROUP, "Lark Doctor", "fail", summarizeCommandOutput(result));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createResult("lark-doctor", LARK_GROUP, "Lark Doctor", "fail", detail);
  }
}

export async function checkLarkAppMatch(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("lark-app-match", LARK_GROUP, "应用一致性", "skip", "等待 config.json");
  }
  const larkConfig = await readLarkCliConfig(options.home);
  if (!larkConfig) {
    return createResult("lark-app-match", LARK_GROUP, "应用一致性", "skip", "未找到 ~/.lark-cli/config.json");
  }

  const configAppId = typeof state.config?.feishu?.appId === "string" ? state.config.feishu.appId : "";
  const larkAppId = typeof larkConfig.appId === "string" ? larkConfig.appId : "";
  if (!isConfiguredValue(configAppId) || !isConfiguredValue(larkAppId)) {
    return createResult("lark-app-match", LARK_GROUP, "应用一致性", "skip", "缺少可比较的 appId");
  }
  if (configAppId === larkAppId) {
    return createResult("lark-app-match", LARK_GROUP, "应用一致性", "pass", `appId=${configAppId}`);
  }
  return createResult("lark-app-match", LARK_GROUP, "应用一致性", "warn", `bridge=${configAppId}, lark-cli=${larkAppId}`);
}

export async function checkBuildExists(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const distEntry = findBuildEntry(cwd);
  if (distEntry) {
    return createResult("build-exists", BRIDGE_GROUP, "构建产物", "pass", path.relative(cwd, distEntry));
  }
  return createResult("build-exists", BRIDGE_GROUP, "构建产物", "warn", "未检测到 dist/index.js 或 dist/src/index.js");
}

export async function checkPortAvailable(options = {}) {
  const state = options.state ?? await readProjectConfig(options.cwd, options.configPath);
  if (!state.exists || state.error || !state.config) {
    return createResult("port-available", BRIDGE_GROUP, "端口占用", "skip", "等待 config.json");
  }
  const port = Number(state.config?.server?.port);
  const host = typeof state.config?.server?.host === "string" ? state.config.server.host : "127.0.0.1";
  if (!Number.isFinite(port) || port <= 0) {
    return createResult("port-available", BRIDGE_GROUP, "端口占用", "skip", "等待 server.port");
  }

  try {
    await assertPortAvailable(port, host);
    return createResult("port-available", BRIDGE_GROUP, "端口占用", "pass", `${host}:${port} 可用`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createResult("port-available", BRIDGE_GROUP, "端口占用", "fail", detail);
  }
}

export async function runBridgeChecks(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, "config.json");
  const state = await readProjectConfig(cwd, configPath);
  const results = [];

  results.push(await checkConfigExists({ cwd, configPath, state }));
  results.push(await checkConfigFeishu({ cwd, configPath, state }));
  results.push(await checkConfigOpencode({ cwd, configPath, state }));
  results.push(await checkConfigPublicUrl({ cwd, configPath, state }));
  results.push(await checkNodeVersion({ version: options.version }));
  results.push(await checkDepsInstalled({ cwd }));
  results.push(await checkOpencodeBin(options));
  results.push(await checkOpencodeAuth({ ...options, cwd }));
  const healthResult = await checkOpencodeServe({ ...options, cwd, configPath, state });
  results.push(healthResult);
  results.push(await checkOpencodeModels({ ...options, cwd, configPath, state, healthResult }));
  results.push(await checkOpencodeDirectory({ cwd, configPath, state }));

  if (options.includeDoctorExtras) {
    results.push(await checkBuildExists({ cwd }));
    results.push(await checkPortAvailable({ cwd, configPath, state }));
  }

  return results;
}

export async function runLarkChecks(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, "config.json");
  const state = await readProjectConfig(cwd, configPath);
  const results = [];

  const binResult = await checkLarkBin(options);
  results.push(binResult);
  results.push(await checkLarkVersion(options));
  results.push(await checkLarkAuth(options));
  if (options.includeLarkDoctor !== false) {
    results.push(await checkLarkDoctor(options));
  } else {
    results.push(createResult("lark-doctor", LARK_GROUP, "Lark Doctor", "skip", "onboard 阶段未执行"));
  }
  results.push(await checkLarkAppMatch({ ...options, cwd, configPath, state }));

  return results;
}

export async function runAllChecks(options = {}) {
  const bridge = await runBridgeChecks(options);
  const lark = await runLarkChecks(options);
  return [...bridge, ...lark];
}

export function getDoctorExitCode(results) {
  return results.some((result) => result.group === BRIDGE_GROUP && result.status === "fail") ? 1 : 0;
}

export async function readLarkCliConfig(home = os.homedir()) {
  const configPath = path.join(home, ".lark-cli", "config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return null;
  }
}

export async function readOpencodeAuth(home = os.homedir(), options = {}) {
  for (const configPath of getOpencodeAuthPaths(home, options)) {
    try {
      return JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      continue;
    }
  }

  return null;
}

export function getOpencodeAuthPaths(home = os.homedir(), options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates = [];
  const pushCandidate = (candidate) => {
    if (typeof candidate === "string" && candidate.length > 0) {
      candidates.push(candidate);
    }
  };

  const xdgDataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME
    : path.join(home, ".local", "share");
  pushCandidate(path.join(xdgDataHome, "opencode", "auth.json"));

  if (platform === "darwin") {
    pushCandidate(path.join(home, "Library", "Application Support", "opencode", "auth.json"));
  }

  if (platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim().length > 0
      ? env.LOCALAPPDATA
      : path.join(home, "AppData", "Local");
    pushCandidate(path.join(localAppData, "opencode", "Data", "auth.json"));
    pushCandidate(path.join(localAppData, "opencode", "auth.json"));
  }

  return Array.from(new Set(candidates));
}

export function findBuildEntry(cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, "dist", "index.js"),
    path.join(cwd, "dist", "src", "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function assertPortAvailable(port, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
  });
}

export async function terminateChild(child, platform = process.platform) {
  if (!child.pid) {
    return;
  }
  if (platform === "win32") {
    try {
      await runCommand("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        shell: true,
        timeoutMs: 10_000,
      });
    } catch {
      // Ignore cleanup errors on shutdown.
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(undefined);
    }, 3_000);

    child.once("close", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

function appendExtension(command, extension) {
  return command.toLowerCase().endsWith(extension.toLowerCase()) ? command : `${command}${extension}`;
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isConfiguredValue(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !["xxx", "cli_xxx", "ou_xxx"].includes(trimmed);
}

function formatProviderName(providerId) {
  if (providerId === "openai") return "OpenAI";
  if (providerId === "anthropic") return "Anthropic";
  if (providerId === "openrouter") return "OpenRouter";
  return String(providerId);
}

function isExampleUrl(value) {
  return typeof value === "string" && value.includes("example.com");
}

function tryParseJson(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function summarizeCommandOutput(result) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (result.timedOut) {
    return "命令执行超时";
  }
  if (!text) {
    return result.code === 0 ? "退出码 0" : `退出码 ${result.code ?? "null"}`;
  }
  const json = tryParseJson(text);
  if (json && typeof json === "object" && Array.isArray(json.checks)) {
    const failCount = json.checks.filter((check) => check && typeof check === "object" && check.status === "fail").length;
    const warnCount = json.checks.filter((check) => check && typeof check === "object" && check.status === "warn").length;
    const ok = json.ok === true ? "ok=true" : "ok=false";
    return `${ok}, ${failCount} fail, ${warnCount} warn`;
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? `退出码 ${result.code ?? "null"}`;
}
