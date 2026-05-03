/**
 * 职责: 作为 portable 包的统一 Node 入口，补齐自身依赖后分发运行命令。
 * 关注点:
 * - 在用户目录准备 BRIDGE_HOME/config/data/logs/extensions。
 * - 用包内 npm cache 安装 bridge 自身依赖，不污染系统全局。
 * - 将 onboard、doctor、start、init、guide、backup/restore 继续交给既有脚本处理。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { runBackupCli } from "./backup.mjs";
import { runCostCli } from "./cost.mjs";
import { runDoctor } from "./doctor.mjs";
import { runGuide } from "./guide.mjs";
import { runOnboard } from "./onboard.mjs";
import { runStart } from "./start.mjs";
import { runUpdateCli } from "./update.mjs";
import { runWorkspaceDoctorCli, runWorkspaceInitCli } from "../workspace-init/workspace-init.mjs";
import {
  createPortableEnv,
  ensurePortableDirectories,
  resolveBridgeHome,
  resolvePackageRoot,
  resolveProjectConfigPath,
} from "./portable.mjs";
import { findExecutable, isMainModule, runCommand } from "./checks.mjs";

const SUPPORTED_COMMANDS = new Set(["onboard", "doctor", "start", "init", "guide", "backup", "restore", "cost", "update", "help"]);

export async function runBootstrap(options = {}) {
  const cwd = options.cwd ?? resolvePackageRoot(import.meta.url);
  const logger = options.logger ?? console;
  const rawArgs = options.args ?? process.argv.slice(2);
  const rawCommand = options.command ?? rawArgs[0] ?? "onboard";
  const command = SUPPORTED_COMMANDS.has(rawCommand) ? rawCommand : "help";
  const env = createPortableEnv({
    cwd,
    env: options.env ?? process.env,
    platform: options.platform,
    home: options.home,
  });
  const configPath = resolveProjectConfigPath(cwd, env);
  const bridgeHome = resolveBridgeHome({ env, platform: options.platform, home: options.home });

  if (command === "help") {
    printHelp(logger, bridgeHome);
    return rawCommand === "help" ? 0 : 1;
  }

  await ensurePortableDirectories({ cwd, env, platform: options.platform, home: options.home });

  await ensureBridgeDependencies({
    cwd,
    env,
    logger,
    runCommandFn: options.runCommandFn ?? runCommand,
    findExecutableFn: options.findExecutableFn ?? findExecutable,
  });

  if (command === "onboard") {
    return await runOnboard({
      cwd,
      env,
      logger,
      configPath,
      runCommandFn: options.runCommandFn,
      findExecutableFn: options.findExecutableFn,
      runAllChecksFn: options.runAllChecksFn,
      runStartFn: options.runStartFn,
      promptYesNoFn: options.promptYesNoFn,
      promptTextFn: options.promptTextFn,
    });
  }

  if (command === "doctor") {
    if (rawArgs[1] === "workspace") {
      return await runWorkspaceDoctorCli(rawArgs.slice(2), {
        cwd,
        env,
        configPath,
        logger,
        runCommandFn: options.runCommandFn,
        findExecutableFn: options.findExecutableFn,
      });
    }
    return await runDoctor({
      cwd,
      env,
      configPath,
      logger,
      runAllChecksFn: options.runAllChecksFn,
      runCommandFn: options.runCommandFn,
      findExecutableFn: options.findExecutableFn,
      fetchImpl: options.fetchImpl,
    });
  }

  if (command === "guide") {
    return await runGuide({
      cwd,
      env,
      configPath,
      logger,
    });
  }

  if (command === "backup") {
    return await runBackupCli(rawArgs.slice(1), {
      cwd,
      env,
      logger,
      platform: options.platform,
      home: options.home,
    });
  }

  if (command === "restore") {
    return await runBackupCli(rawArgs, {
      cwd,
      env,
      logger,
      platform: options.platform,
      home: options.home,
    });
  }

  if (command === "cost") {
    return await runCostCli(rawArgs.slice(1), {
      cwd,
      env,
      logger,
      platform: options.platform,
      home: options.home,
    });
  }

  if (command === "update") {
    return await runUpdateCli(rawArgs.slice(1), {
      cwd,
      env,
      logger,
      platform: options.platform,
      arch: options.arch,
      home: options.home,
      fetchImpl: options.fetchImpl,
      runCommandFn: options.runCommandFn,
    });
  }

  if (command === "init") {
    return await runWorkspaceInitCli(rawArgs.slice(1), {
      cwd,
      env,
      configPath,
      logger,
      runCommandFn: options.runCommandFn,
      findExecutableFn: options.findExecutableFn,
    });
  }

  return await runStart({
    cwd,
    env,
    configPath,
    logger,
    findExecutableFn: options.findExecutableFn,
    fetchImpl: options.fetchImpl,
    spawnFn: options.spawnFn,
    assertPortAvailableFn: options.assertPortAvailableFn,
  });
}

export async function ensureBridgeDependencies(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? console;
  if (existsSync(path.join(cwd, "node_modules"))) {
    logger.log("Bridge 依赖已存在，跳过 npm install。");
    return;
  }

  const npmPath = (options.findExecutableFn ?? findExecutable)("npm", {
    cwd,
    env: options.env,
  });
  if (!npmPath) {
    throw new Error("未检测到 npm，请确认 portable Node 下载完整。");
  }

  const args = ["install"];
  if (existsSync(path.join(cwd, "dist"))) {
    args.push("--omit=dev");
  }
  logger.log(`正在安装 Bridge 依赖，预计 1-3 分钟：npm ${args.join(" ")}`);
  const result = await (options.runCommandFn ?? runCommand)(npmPath, args, {
    cwd,
    env: options.env,
    timeoutMs: 10 * 60_000,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "npm install 失败，请检查网络后重试 bridge onboard。");
  }
}

function printHelp(logger, bridgeHome) {
  logger.log("Feishu OpenCode Bridge portable launcher");
  logger.log("");
  logger.log("用法：");
  logger.log("  bridge onboard   首次引导并生成配置");
  logger.log("  bridge guide     查看当前阶段和下一步");
  logger.log("  bridge doctor    诊断当前环境");
  logger.log("  bridge doctor workspace   诊断飞书多维表格工作区");
  logger.log("  bridge start     启动 OpenCode + Bridge");
  logger.log("  bridge init workspace   创建并写入飞书多维表格工作区");
  logger.log("  bridge backup    备份本地用户数据");
  logger.log("  bridge restore <zip>   恢复本地用户数据");
  logger.log("  bridge cost      查看本地 AI 成本估算");
  logger.log("  bridge update check|download|apply|rollback   检查或切换 portable 更新");
  logger.log("");
  logger.log(`用户数据目录：${bridgeHome}`);
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await runBootstrap();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
