/**
 * 职责: 声明记忆模块内置扩展的 data-only meta。
 * 关注点:
 * - 固定 memory extension id 与 AppConfig 配置 key 的显式映射。
 * - memory 配置仍处于过渡期，暂不通过模块配置 registry 下沉。
 */
import type { BuiltinExtensionMetaDefinition } from "../extensions/definition.js";

export const memoryExtensionMeta = {
  id: "memory",
  configKey: "memory",
} as const satisfies BuiltinExtensionMetaDefinition;
