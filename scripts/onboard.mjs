import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import {
  createAugmentedEnv,
  findExecutable,
  formatCheckHint,
  formatCheckLine,
  getDoctorExitCode,
  isMainModule,
  readLarkCliConfig,
  runAllChecks,
  runCommand,
} from "./checks.mjs";

export async function runOnboard(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  let env = createAugmentedEnv(cwd, options.env ?? process.env, options.home ?? os.homedir());
  const logger = options.logger ?? console;
  const promptYesNoFn = options.promptYesNoFn ?? promptYesNo;
  const promptTextFn = options.promptTextFn ?? promptText;
  const runCommandFn = options.runCommandFn ?? runCommand;
  const findExecutableFn = options.findExecutableFn ?? findExecutable;
  const configPath = path.join(cwd, "config.json");

  logger.log("Feishu OpenCode Bridge — 首次引导");

  const nodeOk = await ensureNodeVersion(logger);
  if (!nodeOk) {
    return 1;
  }

  await ensureProjectDependencies({ cwd, env, logger, runCommandFn });

  const opencodeInstall = await ensureOpencodeInstalled({
    cwd,
    env,
    logger,
    runCommandFn,
    findExecutableFn,
  });
  env = opencodeInstall.env;

  const larkInstall = await ensureLarkCliInstalled({
    cwd,
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
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      opencodeDirectory: cwd,
      logger,
    });
  } else {
    logger.log("保留现有 config.json，不覆盖。");
  }

  logger.log("");
  logger.log("当前环境状态：");
  const results = await runAllChecks({
    cwd,
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

  return getDoctorExitCode(results);
}

export async function shouldRebuildConfig(configPath, promptYesNoFn = promptYesNo) {
  if (!(await fileExists(configPath))) {
    return true;
  }
  return await promptYesNoFn("检测到 config.json 已存在，是否重新配置？", false);
}

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

  const installResult = await runCommandFn("npm", ["i", "-g", "opencode-ai@latest"], {
    cwd,
    env,
    timeoutMs: 10 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
  if (installResult.code !== 0) {
    logger.warn("通过 npm 全局安装 opencode 失败。");
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

export async function generateConfigFile(options) {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? console;
  const templatePath = path.join(cwd, "config.example.json");
  const configPath = path.join(cwd, "config.json");
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  const generated = generateConfigObject(template, {
    appId: options.appId,
    appSecret: options.appSecret,
    opencodeDirectory: options.opencodeDirectory ?? cwd,
  });
  await writeFile(configPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
  logger.log(`已生成 ${configPath}`);
  return configPath;
}

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

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

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

function printOpencodeManualHints(logger) {
  logger.warn("请按平台任选一种方式安装 OpenCode：");
  logger.warn("  macOS / Linux：brew install opencode");
  logger.warn("  macOS / Linux：curl -fsSL https://opencode.ai/install | bash");
  logger.warn("  Windows：scoop install extras/opencode");
  logger.warn("  Windows：choco install opencode");
  logger.warn("  通用：npm i -g opencode-ai@latest");
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
