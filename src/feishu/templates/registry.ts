/**
 * 职责: 注册并查询飞书业务卡片模板。
 * 关注点:
 * - 汇总模板定义并防止重复模板 id。
 * - 为模板运行时提供按 id 查找和列表能力。
 */
import { builtinExtensionCardTemplates } from "../../extensions/card-templates.js";
import type { AnyBusinessCardTemplateDefinition } from "./definition.js";

const businessCardTemplates = builtinExtensionCardTemplates satisfies ReadonlyArray<AnyBusinessCardTemplateDefinition>;

const businessCardTemplateRegistry = createBusinessCardTemplateRegistry(businessCardTemplates);

export function createBusinessCardTemplateRegistry(
  templates: ReadonlyArray<AnyBusinessCardTemplateDefinition>,
): Map<string, AnyBusinessCardTemplateDefinition> {
  const registry = new Map<string, AnyBusinessCardTemplateDefinition>();
  for (const template of templates) {
    if (registry.has(template.id)) {
      // 模板 id 是全局卡片调用入口，启动期必须尽早暴露重复注册。
      throw new Error(`Duplicate business card template id: ${template.id}`);
    }
    registry.set(template.id, template);
  }
  return registry;
}

export function getBusinessCardTemplate(templateId: string): AnyBusinessCardTemplateDefinition | undefined {
  return businessCardTemplateRegistry.get(templateId);
}

export function listBusinessCardTemplates(): readonly string[] {
  return [...businessCardTemplateRegistry.keys()];
}
