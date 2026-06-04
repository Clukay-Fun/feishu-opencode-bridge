#!/usr/bin/env node
/**
 * 职责: feishu-opencode-bridge / fob 全局命令的 Node 分发入口。
 * 关注点:
 * - npm 全局安装时,bin 字段指向本文件(必须是 Node-runnable .mjs/.cjs/.js)。
 * - 运行时按平台分发到对应 shell 启动器(bin/bridge / bin/bridge.cmd)。
 * - 跟随软链接到包内真实路径,兼容 `npm i -g` 在 /usr/local/bin/ 创建的 symlink。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

// 解析自身真实路径(跟随软链接 → npm 全局安装的真实 bin/cli.mjs)
const SELF = realpathSync(fileURLToPath(import.meta.url));
const BIN_DIR = path.dirname(SELF);
const PACKAGE_ROOT = path.dirname(BIN_DIR);

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
const child = spawn(launcher, process.argv.slice(2), {
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
