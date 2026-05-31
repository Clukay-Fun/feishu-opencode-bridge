/**
 * 职责: 声明合同助手内置扩展。
 * 关注点:
 * - 将合同助手服务与 RuntimeModule 创建收口到模块侧。
 * - 复用 data-only meta 的 id/configKey/commands，避免字符串漂移。
 */
import type { BuiltinExtensionDefinition } from "../extensions/definition.js";
import { ContractAssistantService } from "./index.js";
import { ContractAssistantRuntimeModule } from "./runtime-module.js";
import { DEFAULT_CONTRACT_ASSISTANT_CONFIG } from "./config.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { contractAssistantExtensionMeta } from "./extension.meta.js";

export const contractAssistantExtension: BuiltinExtensionDefinition = {
  id: contractAssistantExtensionMeta.id,
  configKey: contractAssistantExtensionMeta.configKey,
  commands: contractAssistantExtensionMeta.commands,
  createModule(context) {
    const config = context.config.contractAssistant ?? DEFAULT_CONTRACT_ASSISTANT_CONFIG;
    const service = config.enabled
      ? new ContractAssistantService(
        config,
        context.config.storage.dataDir,
        context.outbound,
        context.opencode as OpenCodeClient,
        context.logger,
        context.config.knowledgeBase?.parser,
        context.workspaceService,
      )
      : null;
    return new ContractAssistantRuntimeModule({
      config: context.config,
      logger: context.logger,
      service,
      transport: context.transport,
    });
  },
};
