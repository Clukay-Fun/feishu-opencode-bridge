/**
 * 职责: 汇总内置扩展声明的业务卡片模板。
 * 关注点:
 * - 避免模板 runtime 加载完整 runtime extension 造成循环依赖。
 * - 保持模板归属仍由业务模块侧声明。
 */
import { laborAnalysisCompletedTemplate, laborAnalysisProgressTemplate } from "../labor/card-templates.js";
import type { AnyBusinessCardTemplateDefinition } from "../feishu/templates/definition.js";

export const builtinExtensionCardTemplates = [
  laborAnalysisProgressTemplate,
  laborAnalysisCompletedTemplate,
] as const satisfies ReadonlyArray<AnyBusinessCardTemplateDefinition>;
