/**
 * 职责: 声明知识库内置扩展。
 * 关注点:
 * - 将 knowledge runtime module 的创建收口到模块侧。
 * - 声明知识库相关命令归属，但不参与通用 router 分发。
 */
import type { BuiltinExtensionDefinition } from "../extensions/definition.js";
import { KnowledgeRuntimeModule } from "./runtime-module.js";

export const knowledgeBaseExtension: BuiltinExtensionDefinition = {
  id: "knowledge-base",
  configKey: "knowledgeBase",
  commands: [
    { name: "kb-query", aliases: ["法律咨询"], owner: "framework", description: "查询知识库或法律咨询知识模式" },
    { name: "kb-ingest-start", aliases: ["知识入库", "kb-ingest"], owner: "framework", description: "进入知识库材料入库模式" },
    { name: "kb-ingest-end", owner: "framework", description: "退出知识库材料入库模式" },
    { name: "法律咨询开始", owner: "business", description: "进入群聊法律咨询知识库模式" },
    { name: "法律咨询结束", owner: "business", description: "退出群聊法律咨询知识库模式" },
  ],
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
