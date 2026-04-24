/**
 * 职责: 静态注册内置模块配置定义。
 * 关注点:
 * - 让中央配置层只组合模块定义，不维护模块字段细节。
 * - 暂不提供第三方 plugin 动态注册能力。
 */
import { knowledgeBaseConfigDefinition } from "../knowledge/config.js";
import { createModuleConfigRegistry } from "./module-registry.js";

export const moduleConfigRegistry = createModuleConfigRegistry([
  knowledgeBaseConfigDefinition,
]);

export const moduleConfigSchemas = moduleConfigRegistry.getSchemaShape<{
  knowledgeBase: typeof knowledgeBaseConfigDefinition.schema;
}>();
