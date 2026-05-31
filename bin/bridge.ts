#!/usr/bin/env node
/**
 * 职责: Bridge Setup UI CLI 入口。
 * 关注点:
 * - 5 个子命令: setup / profile / extensions / doctor / start
 * - 交互式 (TTY) + 非交互式 (flag) 双轨：TTY 下弹 @inquirer/prompts，非 TTY 走 flag
 * - 错误输出 JSON 到 stderr，exit code 反映成功/失败
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { input, password, select, checkbox } from "@inquirer/prompts";

import { renderDiagnostics, hasFailures } from "../src/setup-ui/diagnostics.js";
import { runDoctor } from "../src/setup-ui/doctor.js";
import { showProfile, setProfile } from "../src/setup-ui/profile.js";
import { showExtensions, toggleExtensions } from "../src/setup-ui/extensions.js";
import { runSetup, type SetupOptions } from "../src/setup-ui/setup.js";
import { runStart } from "../src/setup-ui/start.js";
import type { BridgeProfile } from "../src/config/profiles.js";
import type { ProfileManagedExtensionId } from "../src/config/profiles.js";
import { PROFILE_MANAGED_EXTENSION_IDS } from "../src/config/profiles.js";

const USAGE = `Usage: npm run bridge -- <command> [options]

Commands:
  setup               首次初始化向导（profile + 扩展 + secret）
  profile             查看/切换当前 profile
  extensions          启用/停用可选扩展
  doctor              配置 / Feishu / OpenCode / 数据目录 / 端口诊断
  start               启动服务

Options:
  --config <path>     配置文件路径（默认 config.json）
  --profile <name>    设置 profile（general / legal）
  --enable <ids>      启用扩展（逗号分隔）
  --disable <ids>     停用扩展（逗号分隔）
  --set <value>       profile 切换值
  --feishu-app-id     飞书 App ID
  --feishu-app-secret 飞书 App Secret
  --opencode-url      OpenCode 服务地址
  --help, -h          显示帮助

Notes:
  - TTY 终端下不带必填 flag 会弹出交互式向导
  - 非 TTY (CI / 脚本管道) 下必须用 flag 传入必填字段，否则报错
`;

const VALID_PROFILES: BridgeProfile[] = ["general", "legal"];
const VALID_EXTENSIONS: ProfileManagedExtensionId[] = [...PROFILE_MANAGED_EXTENSION_IDS];

const EXTENSION_LABELS: Record<ProfileManagedExtensionId, string> = {
  "memory": "记忆系统",
  "knowledge-base": "法律知识库",
  "contract-assistant": "合同助手",
  "labor-skill": "劳动分析",
  "case-workbench": "案件工作台",
};

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const configPath = getArg(args, "--config") ?? "config.json";

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    // onboard → setup alias（向后兼容）
    const effectiveCommand = command === "onboard" ? "setup" : command;

    switch (effectiveCommand) {
      case "setup": {
        const options: SetupOptions = {};
        const profileFlag = getArg(args, "--profile") as BridgeProfile | undefined;
        if (profileFlag) options.profile = profileFlag;
        const enable = getArg(args, "--enable");
        const disable = getArg(args, "--disable");
        if (enable) options.enable = enable.split(",").map((s) => s.trim()) as ProfileManagedExtensionId[];
        if (disable) options.disable = disable.split(",").map((s) => s.trim()) as ProfileManagedExtensionId[];
        options.feishuAppId = getArg(args, "--feishu-app-id");
        options.feishuAppSecret = getArg(args, "--feishu-app-secret");
        options.opencodeBaseUrl = getArg(args, "--opencode-url");

        // TTY 模式：缺什么问什么
        if (isInteractive()) {
          if (!options.profile) {
            options.profile = await select<BridgeProfile>({
              message: "选择 profile",
              choices: [
                { name: "通用版 (general)：基础卡片 / 文件 / 记忆", value: "general" },
                { name: "法律版 (legal)：通用 + 知识库 / 合同 / 劳动 / 案件工作台", value: "legal" },
              ],
              default: "legal",
            });
          }
          if (!options.enable && !options.disable) {
            const selected = await checkbox<ProfileManagedExtensionId>({
              message: "选择启用扩展（空格切换，回车确认）",
              choices: VALID_EXTENSIONS.map((id) => ({
                name: `${EXTENSION_LABELS[id]} (${id})`,
                value: id,
                checked: options.profile === "legal" ? id !== "case-workbench" || true : id === "memory",
              })),
            });
            options.enable = selected;
            options.disable = VALID_EXTENSIONS.filter((id) => !selected.includes(id));
          }
          if (!options.feishuAppId) {
            options.feishuAppId = await input({
              message: "Feishu App ID",
              validate: (v) => v.trim().length > 0 || "App ID 不能为空",
            });
          }
          if (!options.feishuAppSecret) {
            options.feishuAppSecret = await password({
              message: "Feishu App Secret",
              mask: "*",
              validate: (v) => v.trim().length > 0 || "App Secret 不能为空",
            });
          }
          if (!options.opencodeBaseUrl) {
            options.opencodeBaseUrl = await input({
              message: "OpenCode Base URL",
              default: "http://127.0.0.1:4096/",
            });
          }
        }
        // 非 TTY 模式下,setup.ts 内部会守护必填字段;若缺会抛错带"下一步建议"

        const result = await runSetup(configPath, options);
        console.log(`配置已写入: ${result.configPath}`);
        console.log(renderDiagnostics(result.diagnostics));
        if (hasFailures(result.diagnostics)) process.exit(1);
        break;
      }

      case "profile": {
        let setVal = getArg(args, "--set") as BridgeProfile | undefined;
        if (!setVal && isInteractive()) {
          const current = existsSync(resolve(configPath))
            ? (await showProfile(configPath)).profile
            : "legal";
          setVal = await select<BridgeProfile>({
            message: `选择新 profile（当前: ${current}）`,
            choices: [
              { name: "general — 基础卡片 / 文件 / 记忆", value: "general" },
              { name: "legal — 通用 + 知识库 / 合同 / 劳动 / 案件工作台", value: "legal" },
            ],
            default: current,
          });
        }
        if (setVal) {
          if (!VALID_PROFILES.includes(setVal)) {
            process.stderr.write(JSON.stringify({ error: "invalid_profile", detail: `支持的 profile: ${VALID_PROFILES.join(", ")}` }) + "\n");
            process.exit(1);
          }
          const result = await setProfile(configPath, setVal);
          console.log(renderDiagnostics([result]));
          if (!result.ok) process.exit(1);
        } else {
          const result = await showProfile(configPath);
          console.log(result.message);
        }
        break;
      }

      case "extensions": {
        const enable = getArg(args, "--enable");
        const disable = getArg(args, "--disable");
        if (enable || disable) {
          const enableList = enable ? enable.split(",").map((s) => s.trim()) as ProfileManagedExtensionId[] : [];
          const disableList = disable ? disable.split(",").map((s) => s.trim()) as ProfileManagedExtensionId[] : [];
          for (const id of [...enableList, ...disableList]) {
            if (!VALID_EXTENSIONS.includes(id)) {
              process.stderr.write(JSON.stringify({ error: "invalid_extension", detail: `未知扩展: ${id}。支持: ${VALID_EXTENSIONS.join(", ")}` }) + "\n");
              process.exit(1);
            }
          }
          const result = await toggleExtensions(configPath, enableList, disableList);
          console.log(renderDiagnostics([result]));
          if (!result.ok) process.exit(1);
        } else if (isInteractive()) {
          const current = await showExtensions(configPath);
          const selected = await checkbox<ProfileManagedExtensionId>({
            message: "选择启用扩展（空格切换，回车确认）",
            choices: current.map((ext) => ({
              name: `${ext.label} (${ext.id})`,
              value: ext.id,
              checked: ext.enabled,
            })),
          });
          const enableList = selected;
          const disableList = current.filter((ext) => !selected.includes(ext.id)).map((ext) => ext.id);
          const result = await toggleExtensions(configPath, enableList, disableList);
          console.log(renderDiagnostics([result]));
          if (!result.ok) process.exit(1);
        } else {
          const list = await showExtensions(configPath);
          for (const ext of list) {
            const icon = ext.enabled ? "✅" : "⬜";
            console.log(`${icon} ${ext.label} (${ext.id})`);
          }
        }
        break;
      }

      case "doctor": {
        const results = await runDoctor(configPath);
        console.log(renderDiagnostics(results));
        if (hasFailures(results)) process.exit(1);
        break;
      }

      case "start": {
        const result = await runStart(process.cwd());
        console.log(renderDiagnostics([result]));
        if (!result.ok) process.exit(1);
        break;
      }

      default:
        process.stderr.write(JSON.stringify({ error: "unknown_command", detail: `未知命令: ${command}` }) + "\n");
        console.log(USAGE);
        process.exit(1);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(JSON.stringify({ error: "command_failed", detail }) + "\n");
    process.exit(1);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

main();
