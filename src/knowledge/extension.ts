/**
 * 职责: 声明知识库内置扩展。
 * 关注点:
 * - 将 knowledge runtime module 的创建收口到模块侧。
 * - 复用 data-only meta 的 id/configKey/commands，避免字符串漂移。
 */
import type { BuiltinExtensionDefinition } from "../extensions/definition.js";
import { knowledgeBaseExtensionMeta } from "./extension.meta.js";
import { KnowledgeRuntimeModule } from "./runtime-module.js";

export const knowledgeBaseExtension: BuiltinExtensionDefinition = {
  id: knowledgeBaseExtensionMeta.id,
  configKey: knowledgeBaseExtensionMeta.configKey,
  commands: knowledgeBaseExtensionMeta.commands,
  createModule(context) {
    return new KnowledgeRuntimeModule({
      config: context.config,
      logger: context.logger,
      knowledge: context.knowledge,
      transport: context.transport,
      getSessionWindow: context.getSessionWindow,
      saveSessionWindow: context.saveSessionWindow,
      createAndBindSession: context.createAndBindSession,
      whitelistBind: async (chatId, openId) => await context.whitelist.bind(chatId, openId),
    });
  },
};
