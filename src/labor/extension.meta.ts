/**
 * 职责: 声明劳动分析内置扩展的 data-only meta。
 * 关注点:
 * - 聚合劳动分析配置定义、命令声明和业务卡片模板。
 * - 保持卡片模板注册不加载劳动分析 service 或 RuntimeModule。
 */
import type { BuiltinExtensionMetaDefinition } from "../extensions/definition.js";
import { laborAnalysisCompletedTemplate, laborAnalysisProgressTemplate, laborReviewCompletedTemplate } from "./card-templates.js";
import { laborSkillConfigDefinition } from "./config.js";

export const laborSkillExtensionMeta = {
  id: "labor-skill",
  configKey: "laborSkill",
  configDefinition: laborSkillConfigDefinition,
  commands: [
    { name: "完成上传", owner: "business", description: "结束案件工作台材料收集并开始分析" },
  ],
  cardTemplates: [
    laborAnalysisProgressTemplate,
    laborAnalysisCompletedTemplate,
    laborReviewCompletedTemplate,
  ],
} as const satisfies BuiltinExtensionMetaDefinition;
