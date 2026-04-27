/**
 * 职责: 声明劳动分析内置扩展。
 * 关注点:
 * - 将劳动分析服务、RuntimeModule 与业务卡片模板收口到模块侧。
 * - 声明劳动命令归属，不做通用命令分发。
 */
import type { BuiltinExtensionDefinition } from "../extensions/definition.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { laborAnalysisCompletedTemplate, laborAnalysisProgressTemplate } from "./card-templates.js";
import { DEFAULT_LABOR_SKILL_CONFIG } from "./config.js";
import { LaborSkillService } from "./index.js";
import { LaborRuntimeModule } from "./runtime-module.js";

export const laborSkillExtension: BuiltinExtensionDefinition = {
  id: "labor-skill",
  configKey: "laborSkill",
  commands: [
    { name: "劳动分析", aliases: ["labor-start"], owner: "business", description: "进入劳动分析材料收集模式" },
    { name: "劳动分析结束", aliases: ["labor-end"], owner: "business", description: "结束收集并开始劳动分析" },
  ],
  cardTemplates: [
    laborAnalysisProgressTemplate,
    laborAnalysisCompletedTemplate,
  ],
  createModule(context) {
    const config = context.config.laborSkill ?? DEFAULT_LABOR_SKILL_CONFIG;
    const service = config.enabled
      ? new LaborSkillService(
        config,
        context.config.storage.dataDir,
        context.outbound,
        context.opencode as OpenCodeClient,
        context.logger,
        context.knowledge,
      )
      : null;
    return new LaborRuntimeModule({
      config: context.config,
      logger: context.logger,
      knowledge: context.knowledge,
      service,
      transport: context.transport,
    });
  },
};
