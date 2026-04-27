/**
 * 职责: 声明合同助手内置扩展的 data-only meta。
 * 关注点:
 * - 聚合合同助手配置定义和命令声明。
 * - 保持配置层不会间接加载合同助手 service 或 RuntimeModule。
 */
import type { BuiltinExtensionMetaDefinition } from "../extensions/definition.js";
import { contractAssistantConfigDefinition } from "./config.js";

export const contractAssistantExtensionMeta = {
  id: "contract-assistant",
  configKey: "contractAssistant",
  configDefinition: contractAssistantConfigDefinition,
  commands: [
    { name: "合同起草开始", aliases: ["contract-workbench"], owner: "business", description: "进入合同起草工作会话" },
    { name: "合同起草结束", owner: "business", description: "结束合同起草工作会话" },
    { name: "起草合同", aliases: ["contract-draft"], owner: "business", description: "按需求起草合同" },
    { name: "合同录入", aliases: ["contract-extract"], owner: "business", description: "提取合同字段并写入台账" },
    { name: "识别发票", aliases: ["invoice-recognize"], owner: "business", description: "识别发票并写入发票记录" },
    { name: "案件录入", aliases: ["case-manage"], owner: "business", description: "新增案件管理记录" },
    { name: "案件更新", aliases: ["case-update"], owner: "business", description: "更新案件管理记录" },
    { name: "案件待办", aliases: ["case-todos"], owner: "business", description: "查询案件待办" },
    { name: "案件提醒", aliases: ["case-reminders"], owner: "business", description: "查询案件提醒" },
    { name: "添加案件提醒", aliases: ["case-reminder-add"], owner: "business", description: "新增案件提醒" },
  ],
} as const satisfies BuiltinExtensionMetaDefinition;
