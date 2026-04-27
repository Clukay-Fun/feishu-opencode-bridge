/**
 * 职责: 静态注册内置模块配置定义。
 * 关注点:
 * - 让中央配置层只从 data-only extension meta 组合模块定义。
 * - 暂不提供第三方 plugin 动态注册能力。
 */
import { builtinExtensionConfigDefinitions } from "../extensions/builtin-meta.js";
import { createModuleConfigRegistry } from "./module-registry.js";

export const moduleConfigRegistry = createModuleConfigRegistry(builtinExtensionConfigDefinitions);

type BuiltinExtensionConfigDefinitions = typeof builtinExtensionConfigDefinitions;

export const moduleConfigSchemas = moduleConfigRegistry.getSchemaShape<{
  knowledgeBase: BuiltinExtensionConfigDefinitions[0]["schema"];
  contractAssistant: BuiltinExtensionConfigDefinitions[1]["schema"];
  laborSkill: BuiltinExtensionConfigDefinitions[2]["schema"];
}>();
