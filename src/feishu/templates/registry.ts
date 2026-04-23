import { laborAnalysisCompletedTemplate, laborAnalysisProgressTemplate } from "./labor-analysis.js";
import type { AnyBusinessCardTemplateDefinition } from "./runtime.js";

const businessCardTemplates = [
  laborAnalysisProgressTemplate,
  laborAnalysisCompletedTemplate,
] as const satisfies ReadonlyArray<AnyBusinessCardTemplateDefinition>;

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
