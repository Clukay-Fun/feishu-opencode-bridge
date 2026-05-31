/**
 * 职责: 实现 `bridge extensions` 命令。
 * 关注点:
 * - 多选菜单显示当前启用状态
 * - 扩展开关持久化到 config.json
 * - 用户显式 enabled 覆盖 profile 默认值
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { saveConfig } from "../config/loader.js";
import { PROFILE_MANAGED_EXTENSION_IDS, type ProfileManagedExtensionId } from "../config/profiles.js";
import type { DiagnosticResult } from "./diagnostics.js";

const EXTENSION_LABELS: Record<ProfileManagedExtensionId, string> = {
  "memory": "记忆系统",
  "knowledge-base": "法律知识库",
  "contract-assistant": "合同助手",
  "labor-skill": "劳动分析",
  "case-workbench": "案件工作台",
};

export async function showExtensions(configPath: string): Promise<Array<{ id: ProfileManagedExtensionId; label: string; enabled: boolean }>> {
  const raw = JSON.parse(await readFile(path.resolve(configPath), "utf-8")) as Record<string, unknown>;
  const extensions = (raw.extensions ?? {}) as Record<string, { enabled?: boolean }>;

  return PROFILE_MANAGED_EXTENSION_IDS.map((id) => {
    const extConfig = extensions[id];
    const enabled = extConfig?.enabled ?? (id === "memory"); // memory 默认启用
    return { id, label: EXTENSION_LABELS[id], enabled };
  });
}

export async function toggleExtensions(
  configPath: string,
  enable: ProfileManagedExtensionId[],
  disable: ProfileManagedExtensionId[],
): Promise<DiagnosticResult> {
  const resolvedPath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(resolvedPath, "utf-8")) as Record<string, unknown>;
  if (!raw.extensions || typeof raw.extensions !== "object") {
    raw.extensions = {};
  }
  const extensions = raw.extensions as Record<string, { enabled?: boolean }>;

  for (const id of enable) {
    if (!extensions[id]) extensions[id] = {};
    extensions[id].enabled = true;
  }
  for (const id of disable) {
    if (!extensions[id]) extensions[id] = {};
    extensions[id].enabled = false;
  }

  await saveConfig(resolvedPath, raw);

  const enabledNames = enable.map((id) => EXTENSION_LABELS[id]);
  const disabledNames = disable.map((id) => EXTENSION_LABELS[id]);
  const parts: string[] = [];
  if (enabledNames.length) parts.push(`启用: ${enabledNames.join(", ")}`);
  if (disabledNames.length) parts.push(`停用: ${disabledNames.join(", ")}`);

  return {
    ok: true,
    label: "扩展开关已更新",
    detail: parts.join(" | "),
  };
}
