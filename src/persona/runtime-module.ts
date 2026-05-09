/**
 * 职责: 将“小敬”人格规范通过 RuntimeModule seam 注入 OpenCode turn。
 * 关注点:
 * - 按配置控制全局或法律场景注入。
 * - 保持人格层与 labor/contract/knowledge 等任务 prompt 分离。
 * - 不接管消息路由、会话控制或业务卡片行为。
 */
import type { RuntimeModule, RuntimeModuleBeforeTurnContext } from "../bridge/module.js";
import type { AppConfig } from "../config/schema.js";
import type { BridgeOutputContext } from "../runtime/message-context.js";
import { XIAOJING_SYSTEM_PROMPT } from "./xiaojing.js";

export const DEFAULT_PERSONA_CONFIG: NonNullable<AppConfig["persona"]> = {
  enabled: true,
  profile: "xiaojing",
  scope: "legal",
};

const LEGAL_SCOPE_KEYWORDS = [
  "法律",
  "法条",
  "法规",
  "判例",
  "案例",
  "合同",
  "协议",
  "劳动",
  "仲裁",
  "诉讼",
  "法院",
  "律师",
  "律助",
  "赔偿",
  "补偿",
  "工资",
  "社保",
  "解除",
  "辞退",
  "离职",
  "请求权",
  "证据",
  "起诉",
  "答辩",
  "知识库",
  "北大法宝",
];

const LEGAL_OUTPUT_KINDS = new Set<BridgeOutputContext["kind"]>([
  "labor-result",
  "knowledge-result",
  "contract-result",
]);

export class PersonaRuntimeModule implements RuntimeModule {
  readonly name = "persona";
  readonly priority = 10;

  constructor(private readonly config: NonNullable<AppConfig["persona"]> = DEFAULT_PERSONA_CONFIG) {}

  async beforeTurn(context: RuntimeModuleBeforeTurnContext): Promise<{ systemBlocks?: string[] } | void> {
    if (!this.config.enabled) {
      return;
    }
    if (this.config.scope === "legal" && !isLegalScopedTurn(context)) {
      return;
    }
    return { systemBlocks: [XIAOJING_SYSTEM_PROMPT] };
  }
}

export function isLegalScopedTurn(context: Pick<RuntimeModuleBeforeTurnContext, "turn" | "messageContext">): boolean {
  if (context.messageContext?.some((item) => LEGAL_OUTPUT_KINDS.has(item.kind))) {
    return true;
  }

  const text = context.turn.plainText.trim();
  return LEGAL_SCOPE_KEYWORDS.some((keyword) => text.includes(keyword));
}
