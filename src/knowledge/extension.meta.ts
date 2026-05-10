/**
 * 职责: 声明知识库内置扩展的 data-only meta。
 * 关注点:
 * - 聚合知识库配置定义和命令声明，供配置、文档和冲突检测使用。
 * - 不加载 runtime module、service 实现或运行时装配代码。
 */
import type { BuiltinExtensionMetaDefinition } from "../extensions/definition.js";
import { knowledgeBaseConfigDefinition } from "./config.js";

export const knowledgeBaseExtensionMeta = {
  id: "knowledge-base",
  configKey: "knowledgeBase",
  configDefinition: knowledgeBaseConfigDefinition,
  commands: [
    { name: "法律问答", aliases: ["kb-query"], owner: "framework", description: "查询法律知识库问答" },
    { name: "kb-ingest-start", aliases: ["知识入库", "kb-ingest"], owner: "framework", description: "进入知识库材料入库模式" },
    { name: "kb-ingest-end", aliases: ["知识入库结束"], owner: "framework", description: "退出知识库材料入库模式" },
    { name: "法律咨询开始", owner: "business", description: "进入群聊法律咨询知识库模式" },
    { name: "法律咨询结束", owner: "business", description: "退出群聊法律咨询知识库模式" },
  ],
} as const satisfies BuiltinExtensionMetaDefinition;
