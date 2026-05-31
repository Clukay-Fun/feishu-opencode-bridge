/**
 * 职责: 实现 `bridge setup` 首次初始化向导的纯逻辑部分。
 * 关注点:
 * - 接收已解析的 options（profile / extensions / 关键 secret）
 * - 缺必填字段时抛错并给"下一步建议"
 * - 配置写入经 saveConfig（schema 校验）
 * - 交互式 prompt 在 bin/bridge.ts 层处理，本模块保持纯逻辑
 */
import path from "node:path";

import { saveConfig } from "../config/loader.js";
import type { BridgeProfile } from "../config/profiles.js";
import { PROFILE_MANAGED_EXTENSION_IDS, PROFILE_EXTENSION_DEFAULTS, type ProfileManagedExtensionId } from "../config/profiles.js";
import type { DiagnosticResult } from "./diagnostics.js";
import { runDoctor } from "./doctor.js";

export type SetupOptions = {
  profile?: BridgeProfile;
  enable?: ProfileManagedExtensionId[];
  disable?: ProfileManagedExtensionId[];
  feishuAppId?: string;
  feishuAppSecret?: string;
  opencodeBaseUrl?: string;
};

export async function runSetup(
  configPath: string,
  options: SetupOptions,
): Promise<{ configPath: string; diagnostics: DiagnosticResult[] }> {
  const resolvedPath = path.resolve(configPath);
  const profile = options.profile ?? "legal";
  const defaults = PROFILE_EXTENSION_DEFAULTS[profile];

  // 必填字段守护：缺 Feishu 凭据时直接抛错，不写空字符串到磁盘
  const feishuAppId = options.feishuAppId?.trim() ?? "";
  const feishuAppSecret = options.feishuAppSecret?.trim() ?? "";
  if (!feishuAppId || !feishuAppSecret) {
    throw new Error(
      "缺少必填字段: feishu.appId / feishu.appSecret。" +
      " 下一步: 加 --feishu-app-id <id> --feishu-app-secret <secret>，" +
      "或在交互式终端 (TTY) 下重新运行 `npm run bridge -- setup`，会弹出交互式输入。",
    );
  }

  // 构建 extensions 配置
  const extensions: Record<string, { enabled: boolean }> = {};
  for (const id of PROFILE_MANAGED_EXTENSION_IDS) {
    const userOverride = options.enable?.includes(id) ? true
      : options.disable?.includes(id) ? false
      : undefined;
    extensions[id] = { enabled: userOverride ?? defaults[id] };
  }

  // 构建 config（满足 ConfigSchema 必填字段）
  const config: Record<string, unknown> = {
    profile,
    feishu: {
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      botOpenIds: [],
      botMentionNames: [],
      selfBotOpenIds: [],
      wsUrl: "wss://open.feishu.cn/open-apis/ws/v2",
      allowedOpenIds: [],
      behavior: { enableP2p: true, enableGroup: true, requireBotMentionInGroup: true, strictBotMention: true, ignoreNonUserSenders: true, replyInThread: true },
      cardActions: { enabled: true, path: "/webhook/card", verificationToken: "", encryptKey: "" },
    },
    opencode: {
      baseUrl: options.opencodeBaseUrl ?? "http://127.0.0.1:4096/",
      directory: process.cwd(),
    },
    storage: { dataDir: "./data", mappingsFile: "mappings.json" },
    server: { host: "127.0.0.1", port: 3000, publicBaseUrl: "http://127.0.0.1:3000/" },
    bridge: {
      queueLimit: 3,
      sessionModes: { p2p: "multi", group: "single", topicGroup: "single" },
      maxSessionsPerWindow: 20,
      sessionListLimit: 10,
      injectSystemState: true,
      firstEventTimeoutMs: 30000,
      eventGapTimeoutMs: 600000,
      totalTimeoutMs: 600000,
    },
    memory: { enabled: extensions["memory"]?.enabled ?? true },
    extensions,
    logging: { dir: "./logs", level: "info" },
  };

  // 经 saveConfig 写入，schema 校验失败时抛错（不落盘）
  await saveConfig(resolvedPath, config);

  // 写入成功后跑 doctor
  const diagnostics = await runDoctor(resolvedPath);

  return { configPath: resolvedPath, diagnostics };
}
