/**
 * 职责: 声明劳动分析内置扩展的 data-only meta。
 * 关注点:
 * - 聚合劳动分析配置定义、命令声明和业务卡片模板。
 * - 保持卡片模板注册不加载劳动分析 service 或 RuntimeModule。
 */
import type { BuiltinExtensionMetaDefinition } from "../extensions/definition.js";
import { laborAnalysisCompletedTemplate, laborAnalysisProgressTemplate } from "./card-templates.js";
import { laborSkillConfigDefinition } from "./config.js";

export const laborSkillExtensionMeta = {
  id: "labor-skill",
  configKey: "laborSkill",
  configDefinition: laborSkillConfigDefinition,
  commands: [
    { name: "劳动分析", aliases: ["labor-start"], owner: "business", description: "进入劳动分析材料收集模式" },
    { name: "劳动分析结束", aliases: ["labor-end"], owner: "business", description: "结束收集并开始劳动分析" },
  ],
  cardTemplates: [
    laborAnalysisProgressTemplate,
    laborAnalysisCompletedTemplate,
  ],
} as const satisfies BuiltinExtensionMetaDefinition;
