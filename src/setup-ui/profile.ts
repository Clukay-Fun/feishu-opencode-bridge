/**
 * 职责: 实现 `bridge profile` 命令的纯逻辑部分。
 * 关注点:
 * - 显示当前 profile
 * - 切换 profile（通过 saveConfig 经 schema 校验）
 * - 切换不覆盖 user 显式 enabled
 * - 交互式 prompt 在 bin/bridge.ts 层处理，本模块保持纯逻辑
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { saveConfig } from "../config/loader.js";
import { type BridgeProfile } from "../config/profiles.js";
import type { DiagnosticResult } from "./diagnostics.js";

export async function showProfile(configPath: string): Promise<{ profile: BridgeProfile; message: string }> {
  const raw = JSON.parse(await readFile(path.resolve(configPath), "utf-8")) as Record<string, unknown>;
  const profile = (raw.profile as BridgeProfile) ?? "legal";
  return {
    profile,
    message: `当前 profile: ${profile}`,
  };
}

export async function setProfile(configPath: string, newProfile: BridgeProfile): Promise<DiagnosticResult> {
  const resolvedPath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(resolvedPath, "utf-8")) as Record<string, unknown>;
  const currentProfile = (raw.profile as BridgeProfile) ?? "legal";

  if (currentProfile === newProfile) {
    return { ok: true, label: `profile 已经是 ${newProfile}，无需切换` };
  }

  raw.profile = newProfile;
  await saveConfig(resolvedPath, raw);

  return {
    ok: true,
    label: `profile 已从 ${currentProfile} 切换为 ${newProfile}`,
    detail: "重启 bridge 后生效。已有的用户显式 enabled 配置不受影响。",
  };
}
