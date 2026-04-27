/**
 * 职责: 声明合同助手内置扩展。
 * 关注点:
 * - 将合同助手服务与 RuntimeModule 创建收口到模块侧。
 * - 声明合同、发票和案件命令归属，不做通用命令分发。
 */
import type { BuiltinExtensionDefinition } from "../extensions/definition.js";
import { ContractAssistantService } from "./index.js";
import { ContractAssistantRuntimeModule } from "./runtime-module.js";
import { DEFAULT_CONTRACT_ASSISTANT_CONFIG } from "./config.js";
import type { OpenCodeClient } from "../opencode/client.js";

export const contractAssistantExtension: BuiltinExtensionDefinition = {
  id: "contract-assistant",
  configKey: "contractAssistant",
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
  createModule(context) {
    const config = context.config.contractAssistant ?? DEFAULT_CONTRACT_ASSISTANT_CONFIG;
    const service = config.enabled
      ? new ContractAssistantService(
        config,
        context.config.storage.dataDir,
        context.outbound,
        context.opencode as OpenCodeClient,
        context.logger,
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
