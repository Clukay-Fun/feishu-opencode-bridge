/**
 * 职责: 汇总仓库内置扩展。
 * 关注点:
 * - 统一 extension manifest 的启动期静态注册顺序。
 * - 校验 extension 与 AppConfig 顶层配置 key 的显式映射。
 */
import { contractAssistantExtension } from "../contract-assistant/extension.js";
import { knowledgeBaseExtension } from "../knowledge/extension.js";
import { laborSkillExtension } from "../labor/extension.js";
import { memoryExtension } from "../memory/extension.js";
import { createBuiltinExtensionRegistry } from "./registry.js";

export const builtinExtensionRegistry = createBuiltinExtensionRegistry([
  knowledgeBaseExtension,
  contractAssistantExtension,
  laborSkillExtension,
  memoryExtension,
], {
  configKeys: ["knowledgeBase", "contractAssistant", "laborSkill", "memory"],
});

export const builtinExtensions = builtinExtensionRegistry.extensions;
