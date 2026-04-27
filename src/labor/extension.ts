/**
 * 职责: 声明劳动分析内置扩展。
 * 关注点:
 * - 将劳动分析服务与 RuntimeModule 创建收口到模块侧。
 * - 复用 data-only meta 的 id/configKey/commands，避免字符串漂移。
 */
import type { BuiltinExtensionDefinition } from "../extensions/definition.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { DEFAULT_LABOR_SKILL_CONFIG } from "./config.js";
import { laborSkillExtensionMeta } from "./extension.meta.js";
import { LaborSkillService } from "./index.js";
import { LaborRuntimeModule } from "./runtime-module.js";

export const laborSkillExtension: BuiltinExtensionDefinition = {
  id: laborSkillExtensionMeta.id,
  configKey: laborSkillExtensionMeta.configKey,
  commands: laborSkillExtensionMeta.commands,
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
