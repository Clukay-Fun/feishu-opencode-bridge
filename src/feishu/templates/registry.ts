/**
 * 职责: 注册并查询飞书业务卡片模板。
 * 关注点:
 * - 汇总模板定义并防止重复模板 id。
 * - 为模板运行时提供按 id 查找和列表能力。
 */
import { builtinExtensionCardTemplates } from "../../extensions/card-templates.js";
import type { AnyBusinessCardTemplateDefinition } from "./definition.js";

const businessCardTemplates = builtinExtensionCardTemplates satisfies ReadonlyArray<AnyBusinessCardTemplateDefinition>;

const businessCardTemplateRegistry = new Map<string, AnyBusinessCardTemplateDefinition>();
for (const template of businessCardTemplates) {
  if (businessCardTemplateRegistry.has(template.id)) {
    throw new Error(`Duplicate business card template id: ${template.id}`);
  }
  businessCardTemplateRegistry.set(template.id, template);
}

export function getBusinessCardTemplate(templateId: string): AnyBusinessCardTemplateDefinition | undefined {
  return businessCardTemplateRegistry.get(templateId);
}

export function listBusinessCardTemplates(): readonly string[] {
  return [...businessCardTemplateRegistry.keys()];
}
