/**
 * 职责: 汇总仓库内置扩展的 data-only meta。
 * 关注点:
 * - 供配置 registry、命令冲突检测和业务卡片模板聚合使用。
 * - 不导入 runtime extension、service 实现或 RuntimeModule。
 */
import { contractAssistantExtensionMeta } from "../contract-assistant/extension.meta.js";
import { knowledgeBaseExtensionMeta } from "../knowledge/extension.meta.js";
import { laborSkillExtensionMeta } from "../labor/extension.meta.js";
import { memoryExtensionMeta } from "../memory/extension.meta.js";
import { createBuiltinExtensionMetaRegistry } from "./registry.js";

const builtinExtensionMetaDefinitions = [
  knowledgeBaseExtensionMeta,
  contractAssistantExtensionMeta,
  laborSkillExtensionMeta,
  memoryExtensionMeta,
] as const;

export const builtinExtensionMetaRegistry = createBuiltinExtensionMetaRegistry(builtinExtensionMetaDefinitions, {
  configKeys: ["knowledgeBase", "contractAssistant", "laborSkill", "memory"],
});

export const builtinExtensionMetas = builtinExtensionMetaRegistry.metas;
export const builtinExtensionCommands = builtinExtensionMetaRegistry.listCommands();
export const builtinExtensionConfigDefinitions = [
  knowledgeBaseExtensionMeta.configDefinition,
  contractAssistantExtensionMeta.configDefinition,
  laborSkillExtensionMeta.configDefinition,
] as const;
export const builtinExtensionCardTemplates = builtinExtensionMetaRegistry.listCardTemplates();
