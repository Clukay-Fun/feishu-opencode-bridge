/**
 * 职责: 完成 Bridge 本地开发环境的首次引导。
 * 关注点:
 * - 检查 Node、依赖、OpenCode、lark-cli 等基础环境。
 * - 在需要时安装命令行工具并引导登录。
 * - 生成 config.json，并在环境就绪时可直接启动完整栈。
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { resolveProjectConfigPath, resolveRuntimeDir } from "./portable.mjs";
import {
  assessOpencodeAuthPayload,
  assessLarkAuthPayload,
  createAugmentedEnv,
  findExecutable,
  formatCheckHint,
  formatCheckLine,
  getDoctorExitCode,
  isMainModule,
  readOpencodeAuth,
  readLarkCliConfig,
  runAllChecks,
  runCommand,
} from "./checks.mjs";

export async function runOnboard(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  let env = createAugmentedEnv(cwd, options.env ?? process.env, home);
  const logger = options.logger ?? console;
  const promptYesNoFn = options.promptYesNoFn ?? promptYesNo;
  const promptTextFn = options.promptTextFn ?? promptText;
  const runCommandFn = options.runCommandFn ?? runCommand;
  const findExecutableFn = options.findExecutableFn ?? findExecutable;
  const runAllChecksFn = options.runAllChecksFn ?? runAllChecks;
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);

  logger.log("Feishu OpenCode Bridge — 首次引导");

  const nodeOk = await ensureNodeVersion(logger);
  if (!nodeOk) {
    return 1;
  }

  await ensureProjectDependencies({ cwd, env, logger, runCommandFn });

  const opencodeInstall = await ensureOpencodeInstalled({
    cwd,
    home,
    env,
    logger,
    runCommandFn,
    findExecutableFn,
  });
  env = opencodeInstall.env;
  if (opencodeInstall.path) {
    await maybeLoginOpencodeProvider({
      cwd,
      home,
      env,
      logger,
      promptYesNoFn,
      opencodePath: opencodeInstall.path,
      runCommandFn,
    });
  }

  const larkInstall = await ensureLarkCliInstalled({
    cwd,
    home,
    env,
    logger,
    runCommandFn,
    findExecutableFn,
  });
  env = larkInstall.env;

  let shouldWriteConfig = true;
  if (options.configExistsOverride !== undefined) {
    shouldWriteConfig = options.configExistsOverride;
  } else if (await fileExists(configPath)) {
    shouldWriteConfig = await shouldRebuildConfig(configPath, promptYesNoFn);
  }

  if (larkInstall.path && shouldWriteConfig) {
    await maybeLoginLarkCli({
      cwd,
      home,
      env,
      logger,
      promptYesNoFn,
      larkCliPath: larkInstall.path,
      runCommandFn,
    });
  }

  if (shouldWriteConfig) {
    const credentials = await resolveFeishuCredentials({
      cwd,
      env,
      logger,
      promptTextFn,
      larkCliPath: larkInstall.path,
      runCommandFn,
    });

    if (!credentials?.appId || !credentials.appSecret) {
      logger.error("未拿到可用的 appId / appSecret，无法生成 config.json。");
      return 1;
    }

    await generateConfigFile({
      cwd,
      configPath,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      opencodeDirectory: cwd,
      logger,
    });
  } else {
    logger.log("保留现有 config.json，不覆盖。");
  }

  if (larkInstall.path && !shouldWriteConfig) {
    await maybeLoginLarkCli({
      cwd,
      home,
      env,
      logger,
      promptYesNoFn,
      larkCliPath: larkInstall.path,
      runCommandFn,
    });
  }

  logger.log("");
  logger.log("当前环境状态：");
  const results = await runAllChecksFn({
    cwd,
    home,
    env,
    includeDoctorExtras: false,
    includeLarkDoctor: false,
    runCommandFn,
    findExecutableFn,
  });

  for (const result of results) {
    logger.log(formatCheckLine(result));
    const hint = formatCheckHint(result);
    if (hint) {
      logger.log(hint);
    }
  }

  logger.log("");
  logger.log("提示：");
  logger.log("  当前配置保证 p2p 私聊可用。");
  logger.log("  如需群聊严格 @bot，请后续补 botOpenId / selfBotOpenId。");
  logger.log("  如果 OpenCode 需要在其他项目目录工作，请修改 config.opencode.directory。");
  logger.log("");
  logger.log("推荐下一步：");
  logger.log("  1. bridge init workspace");
  logger.log("  2. bridge doctor workspace");
  logger.log("  3. bridge start");
  logger.log("  随时运行 bridge guide 查看当前阶段。");

  if (shouldOfferStart(results)) {
    const launchNow = await promptYesNoFn("当前环境已接近可运行状态，是否现在启动完整栈？", false);
    if (launchNow) {
      const runStartFn = options.runStartFn ?? (async (startOptions) => {
        const { runStart } = await import("./start.mjs");
        return await runStart(startOptions);
      });
      return await runStartFn({
        cwd,
        env,
        logger,
        findExecutableFn,
      });
    }
    return 0;
  }

  return getDoctorExitCode(results);
}

// Ask whether an existing config file should be regenerated.
export async function shouldRebuildConfig(configPath, promptYesNoFn = promptYesNo) {
  if (!(await fileExists(configPath))) {
    return true;
  }
  return await promptYesNoFn("检测到 config.json 已存在，是否重新配置？", false);
}

// Install project dependencies when `node_modules` is still missing.
export async function ensureProjectDependencies({ cwd, env, logger, runCommandFn = runCommand }) {
  if (await fileExists(path.join(cwd, "node_modules"))) {
    logger.log("项目依赖已存在，跳过 npm install。");
    return;
  }

  logger.log("正在执行 npm install ...");
  const result = await runCommandFn("npm", ["install"], {
    cwd,
    env,
    timeoutMs: 10 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "npm install 失败");
  }
}

// Detect or install the OpenCode CLI and refresh PATH resolution afterwards.
export async function ensureOpencodeInstalled(options) {
  const cwd = options.cwd;
  const logger = options.logger ?? console;
  const runCommandFn = options.runCommandFn ?? runCommand;
  const findExecutableFn = options.findExecutableFn ?? findExecutable;
  let env = createAugmentedEnv(cwd, options.env ?? process.env, options.home ?? os.homedir());

  const existing = findExecutableFn("opencode", { cwd, env });
  if (existing) {
    logger.log(`检测到 OpenCode：${existing}`);
    return { env, path: existing };
  }

  logger.log("未检测到 opencode，正在尝试安装 npm 包 opencode-ai@latest ...");
  const viewResult = await runCommandFn("npm", ["view", "opencode-ai", "name"], {
    cwd,
    env,
    timeoutMs: 30_000,
  });
  if (viewResult.code !== 0 || !viewResult.stdout.includes("opencode-ai")) {
    logger.warn("无法确认 opencode-ai npm 包，跳过自动安装。");
    printOpencodeManualHints(logger);
    return { env, path: null };
  }

  const installArgs = isPortableEnv(env)
    ? ["install", "--prefix", path.join(resolveRuntimeDir(cwd), "npm-global"), "opencode-ai@latest"]
    : ["i", "-g", "opencode-ai@latest"];
  const installResult = await runCommandFn("npm", installArgs, {
    cwd,
    env,
    timeoutMs: 10 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
  if (installResult.code !== 0) {
    logger.warn(isPortableEnv(env) ? "通过 portable npm prefix 安装 opencode 失败。" : "通过 npm 全局安装 opencode 失败。");
    printOpencodeManualHints(logger);
    return { env, path: null };
  }

  env = createAugmentedEnv(cwd, env, options.home ?? os.homedir());
  const installed = findExecutableFn("opencode", { cwd, env });
  if (installed) {
    logger.log(`OpenCode 安装完成：${installed}`);
    return { env, path: installed };
  }

  logger.warn("opencode 安装完成后仍未出现在 PATH 中。");
  printOpencodeManualHints(logger);
  return { env, path: null };
}

// Detect or install `lark-cli`, trying global and user-local prefixes.
export async function ensureLarkCliInstalled(options) {
  const cwd = options.cwd;
  const logger = options.logger ?? console;
  const runCommandFn = options.runCommandFn ?? runCommand;
  const findExecutableFn = options.findExecutableFn ?? findExecutable;
  const home = options.home ?? os.homedir();
  let env = createAugmentedEnv(cwd, options.env ?? process.env, home);

  const existing = findExecutableFn("lark-cli", { cwd, env, home });
  if (existing) {
    logger.log(`检测到 lark-cli：${existing}`);
    return { env, path: existing };
  }

  if (isPortableEnv(env)) {
    logger.log("未检测到 lark-cli，正在尝试安装到 .runtime/npm-global ...");
    const prefix = path.join(resolveRuntimeDir(cwd), "npm-global");
    const localInstall = await runCommandFn("npm", ["install", "--prefix", prefix, "@larksuite/cli"], {
      cwd,
      env,
      timeoutMs: 10 * 60_000,
      onStdout: (text) => process.stdout.write(text),
      onStderr: (text) => process.stderr.write(text),
    });
    env = createAugmentedEnv(cwd, env, home);
    const installed = findExecutableFn("lark-cli", { cwd, env, home });
    if (localInstall.code === 0 && installed) {
      logger.log(`lark-cli 安装完成：${installed}`);
      return { env, path: installed };
    }
    logger.warn("无法安装 portable lark-cli。");
    logger.warn(`请手动执行：npm install --prefix "${prefix}" @larksuite/cli`);
    return { env, path: null };
  }

  logger.log("未检测到 lark-cli，正在尝试全局安装 @larksuite/cli ...");
  const globalInstall = await runCommandFn("npm", ["install", "-g", "@larksuite/cli"], {
    cwd,
    env,
    timeoutMs: 10 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });

  env = createAugmentedEnv(cwd, env, home);
  let installed = findExecutableFn("lark-cli", { cwd, env, home });
  if (globalInstall.code === 0 && installed) {
    logger.log(`lark-cli 安装完成：${installed}`);
    return { env, path: installed };
  }

  logger.warn("全局安装失败，改用用户目录安装 ~/.local ...");
  const prefix = path.join(home, ".local");
  const localInstall = await runCommandFn("npm", ["install", "--prefix", prefix, "@larksuite/cli"], {
    cwd,
    env,
    timeoutMs: 10 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });

  env = createAugmentedEnv(cwd, env, home);
  installed = findExecutableFn("lark-cli", { cwd, env, home });
  if (localInstall.code === 0 && installed) {
    logger.log(`lark-cli 安装完成：${installed}`);
    return { env, path: installed };
  }

  logger.warn("无法自动安装 lark-cli。");
  logger.warn("请手动执行：npm install -g @larksuite/cli");
  logger.warn(`或执行：npm install --prefix "${prefix}" @larksuite/cli`);
  return { env, path: null };
}

// Resolve Feishu app credentials from lark-cli or prompt fallbacks.
export async function resolveFeishuCredentials(options) {
  const logger = options.logger ?? console;
  const runCommandFn = options.runCommandFn ?? runCommand;
  let discovered = null;

  if (options.larkCliPath) {
    logger.log("正在尝试通过 lark-cli 创建或配置飞书应用 ...");
    discovered = await tryCreateFeishuAppWithLark({
      cwd: options.cwd,
      env: options.env,
      logger,
      larkCliPath: options.larkCliPath,
      runCommandFn,
    });
  }

  if (discovered?.appId && discovered.appSecret) {
    return discovered;
  }

  const larkConfig = await readLarkCliConfig();
  const defaultAppId = discovered?.appId ?? (typeof larkConfig?.appId === "string" ? larkConfig.appId : "");
  logger.log("无法自动拿到完整 appId / appSecret，切换为人工输入。");

  const appId = await options.promptTextFn("请输入 Feishu App ID", defaultAppId);
  const appSecret = await options.promptTextFn("请输入 Feishu App Secret");
  return {
    appId: appId.trim(),
    appSecret: appSecret.trim(),
  };
}

// Ensure the current user completes lark-cli login if required.
export async function maybeLoginLarkCli(options) {
  const logger = options.logger ?? console;
  const statusResult = await options.runCommandFn(options.larkCliPath, ["auth", "status"], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 30_000,
  });
  const payload = tryParseJson(`${statusResult.stdout}\n${statusResult.stderr}`);
  const status = assessLarkAuthPayload(payload);
  if (status.status === "pass") {
    return status;
  }

  logger.warn(`当前 Lark 登录态未就绪：${status.detail}`);
  const shouldLogin = await options.promptYesNoFn("是否现在运行 lark-cli auth login 完成用户授权？", true);
  if (!shouldLogin) {
    return status;
  }

  const loginResult = await options.runCommandFn(options.larkCliPath, ["auth", "login", "--recommend"], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 15 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
  if (loginResult.code !== 0) {
    logger.warn("lark-cli auth login 未成功完成。");
    logger.warn("你可以稍后手动执行：lark-cli auth login --recommend");
  }

  const refreshedStatus = await options.runCommandFn(options.larkCliPath, ["auth", "status"], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 30_000,
  });
  return assessLarkAuthPayload(tryParseJson(`${refreshedStatus.stdout}\n${refreshedStatus.stderr}`));
}

// Ensure at least one OpenCode provider is logged in for model access.
export async function maybeLoginOpencodeProvider(options) {
  const logger = options.logger ?? console;
  const status = assessOpencodeAuthPayload(await readOpencodeAuth(options.home, {
    env: options.env,
    platform: options.platform,
  }));
  if (status.status === "pass" || status.status === "warn") {
    return status;
  }

  logger.warn(`当前 OpenCode provider 未就绪：${status.detail}`);
  logger.warn("如果还没有可用的 AI provider key，可以先向维护者申请测试 key；P0 阶段不自动发放 key。");
  if (typeof options.env?.BRIDGE_TEST_KEY_URL === "string" && options.env.BRIDGE_TEST_KEY_URL.trim().length > 0) {
    logger.warn(`测试 key 申请入口：${options.env.BRIDGE_TEST_KEY_URL}`);
  }
  const shouldLogin = await options.promptYesNoFn("是否现在运行 opencode providers login 完成模型提供方登录？", true);
  if (!shouldLogin) {
    return status;
  }

  logger.log("即将启动 opencode providers login。请按终端提示完成 provider 登录。");
  const loginResult = await options.runCommandFn(options.opencodePath, ["providers", "login"], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 15 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
  if (loginResult.code !== 0) {
    logger.warn("opencode providers login 未成功完成。");
  }

  return assessOpencodeAuthPayload(await readOpencodeAuth(options.home, {
    env: options.env,
    platform: options.platform,
  }));
}

// Ask lark-cli to create/configure an app and extract credentials from its output.
export async function tryCreateFeishuAppWithLark(options) {
  const logger = options.logger ?? console;
  const result = await options.runCommandFn(options.larkCliPath, ["config", "init", "--new", "--lang", "zh"], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 15 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });

  if (result.code !== 0) {
    logger.warn("lark-cli config init --new 执行失败。");
    return null;
  }

  const payload = parseConfigInitOutput(`${result.stdout}\n${result.stderr}`);
  if (payload?.appId && payload?.appSecret) {
    return payload;
  }

  const larkConfig = await readLarkCliConfig();
  if (typeof larkConfig?.appId === "string") {
    return { appId: larkConfig.appId, appSecret: "" };
  }

  return null;
}

// Parse `lark-cli config init` output into the credential shape used by onboarding.
export function parseConfigInitOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return normalizeCredentialPayload(parsed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*"appId"[\s\S]*"appSecret"[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      return normalizeCredentialPayload(parsed);
    } catch {
      return null;
    }
  }
}

// Fill the config template with the credentials and working directory discovered during onboarding.
export function generateConfigObject(template, options) {
  const next = JSON.parse(JSON.stringify(template));
  if (!next.feishu) {
    next.feishu = {};
  }
  if (!next.opencode) {
    next.opencode = {};
  }
  next.feishu.appId = options.appId;
  next.feishu.appSecret = options.appSecret;
  next.opencode.directory = options.opencodeDirectory;
  return next;
}

// Materialize `config.json` from `config.example.json`.
export async function generateConfigFile(options) {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? console;
  const templatePath = path.join(cwd, "config.example.json");
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, options.env);
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const generated = generateConfigObject(template, {
    appId: options.appId,
    appSecret: options.appSecret,
    opencodeDirectory: options.opencodeDirectory ?? cwd,
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
  logger.log(`已生成 ${configPath}`);
  return configPath;
}

// Prompt for a yes/no answer, with a default for non-interactive terminals.
export async function promptYesNo(question, defaultValue = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultValue;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  try {
    const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    return ["y", "yes"].includes(answer);
  } finally {
    rl.close();
  }
}

// Prompt for free-form text, again with a non-interactive fallback.
export async function promptText(question, defaultValue = "") {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultValue;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [默认: ${defaultValue}] ` : ": ";
    const answer = await rl.question(`${question}${suffix}`);
    return answer.trim().length > 0 ? answer : defaultValue;
  } finally {
    rl.close();
  }
}

// Enforce the Node.js version floor before onboarding continues.
async function ensureNodeVersion(logger) {
  const version = process.version;
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10);
  if (major >= 20) {
    logger.log(`Node.js 版本通过：${version}`);
    return true;
  }
  logger.error(`当前 Node.js 版本 ${version}，需要 >= v20。`);
  return false;
}

// Check whether a path exists without surfacing ENOENT as an exception.
async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// Normalize ad-hoc credential payloads into a strict `{ appId, appSecret }` shape.
function normalizeCredentialPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const appId = typeof payload.appId === "string" ? payload.appId : "";
  const appSecret = typeof payload.appSecret === "string" ? payload.appSecret : "";
  if (!appId) {
    return null;
  }
  return {
    appId,
    appSecret,
  };
}

// Decide whether onboarding can offer to launch the runtime immediately.
export function shouldOfferStart(results) {
  return !results.some((result) => (
    result.group === "bridge"
    && result.status === "fail"
    && result.id !== "opencode-serve"
  ));
}

// Print manual OpenCode install fallbacks when automatic install is unavailable.
function printOpencodeManualHints(logger) {
  logger.warn("请按平台任选一种方式安装 OpenCode：");
  logger.warn("  macOS / Linux：brew install opencode");
  logger.warn("  macOS / Linux：curl -fsSL https://opencode.ai/install | bash");
  logger.warn("  Windows：scoop install extras/opencode");
  logger.warn("  Windows：choco install opencode");
  logger.warn("  通用：npm i -g opencode-ai@latest");
}

function isPortableEnv(env) {
  return typeof env.BRIDGE_HOME === "string" && env.BRIDGE_HOME.trim().length > 0;
}

// Parse JSON helper output without throwing inside onboarding control flow.
function tryParseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const exitCode = await runOnboard();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
