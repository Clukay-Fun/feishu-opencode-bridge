/**
 * 职责: 汇总仓库内置扩展。
 * 关注点:
 * - 统一 runtime extension 的启动期静态注册顺序。
 * - 仅供 runtime module assembly 创建 RuntimeModule。
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
]);

export const builtinExtensions = builtinExtensionRegistry.extensions;
