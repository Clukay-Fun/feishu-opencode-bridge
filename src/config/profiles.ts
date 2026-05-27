/**
 * 职责: 定义发行形态 profile 与内置扩展的 profile 默认启用值。
 * 关注点:
 * - profile 只提供默认值，不直接关停扩展；用户显式 enabled 始终优先。
 * - general 只保留基础能力（含 memory 共享服务）；legal 额外默认开启法律垂直扩展。
 * - 该映射按内置扩展 id 维护，与 extension meta 的 id 保持一致，避免字符串漂移。
 */

/** 当前支持的发行形态 profile。 */
export type BridgeProfile = "general" | "legal";

/** 默认 profile：项目当前以法律版为主要交付形态。 */
export const DEFAULT_PROFILE: BridgeProfile = "legal";

/**
 * 受 profile 控制的内置扩展 id。
 * memory 是共享服务，但其默认启用同样由 profile 决定。
 */
export const PROFILE_MANAGED_EXTENSION_IDS = [
  "memory",
  "knowledge-base",
  "contract-assistant",
  "labor-skill",
  "case-workbench",
] as const;

export type ProfileManagedExtensionId = (typeof PROFILE_MANAGED_EXTENSION_IDS)[number];

/**
 * 每个 profile 下内置扩展的默认 enabled。
 * - general：仅保留 memory，法律垂直扩展默认关闭。
 * - legal：general 全部能力之上，默认开启法律知识库、合同助手、劳动案件、案件工作台。
 */
export const PROFILE_EXTENSION_DEFAULTS: Record<BridgeProfile, Record<ProfileManagedExtensionId, boolean>> = {
  general: {
    "memory": true,
    "knowledge-base": false,
    "contract-assistant": false,
    "labor-skill": false,
    "case-workbench": false,
  },
  legal: {
    "memory": true,
    "knowledge-base": true,
    "contract-assistant": true,
    "labor-skill": true,
    "case-workbench": true,
  },
};

/** 返回指定 profile 下某内置扩展的默认 enabled。 */
export function resolveProfileExtensionDefault(
  profile: BridgeProfile,
  extensionId: ProfileManagedExtensionId,
): boolean {
  return PROFILE_EXTENSION_DEFAULTS[profile][extensionId];
}
