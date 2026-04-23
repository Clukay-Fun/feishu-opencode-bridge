import type { ZodError, ZodTypeAny, infer as Infer } from "zod";

import {
  buildDivider,
  buildElapsedLine,
  buildInteractivePayload,
  buildProgressStepElements,
  buildQuoteLine,
  buildStatsRow,
  buildTagChartSection,
  buildTitleLine,
  type FeishuPostPayload,
  type ToolUpdateView,
} from "../shared-primitives.js";
import { getBusinessCardTemplate } from "./registry.js";

type CardTemplate = "blue" | "green" | "red" | "wathet" | "grey" | "orange" | "yellow" | "purple" | "indigo";

export type BusinessCardBlock =
  | { kind: "title"; content: string }
  | { kind: "steps"; steps: ReadonlyArray<ToolUpdateView> }
  | { kind: "quote"; content: string }
  | { kind: "stats"; labels: string[] }
  | { kind: "tagChart"; tagCounts: Record<string, number>; bitableUrl?: string | undefined; title?: string; linkLabel?: string }
  | { kind: "elapsed"; content: string }
  | { kind: "divider" };

export type BusinessCardSpec = {
  title: string;
  template: CardTemplate;
  iconToken: string;
  blocks: readonly BusinessCardBlock[];
};

export type BusinessCardTemplateDefinition<TSchema extends ZodTypeAny = ZodTypeAny> = {
  id: string;
  schema: TSchema;
  render: (input: Infer<TSchema>) => BusinessCardSpec;
};

export type AnyBusinessCardTemplateDefinition = BusinessCardTemplateDefinition<ZodTypeAny>;

export class BusinessCardTemplateValidationError extends Error {
  readonly templateId: string;
  readonly cause: ZodError;

  constructor(templateId: string, cause: ZodError) {
    super(`Business card template "${templateId}" received invalid input`);
    this.name = "BusinessCardTemplateValidationError";
    this.templateId = templateId;
    this.cause = cause;
  }
}

export function renderBusinessCard(
  templateId: string,
  input: unknown,
  options: { onError?: "throw" | "fallback" } = {},
): FeishuPostPayload {
  const onError = options.onError ?? "throw";
  const template = getBusinessCardTemplate(templateId);
  if (!template) {
    const error = new Error(`Unknown business card template: ${templateId}`);
    if (onError === "throw") {
      throw error;
    }
    throw error;
  }

  const parsed = template.schema.safeParse(input);
  if (!parsed.success) {
    const error = new BusinessCardTemplateValidationError(templateId, parsed.error);
    if (onError === "throw") {
      throw error;
    }
    throw error;
  }

  return renderBusinessCardSpec(template.render(parsed.data));
}

function renderBusinessCardSpec(spec: BusinessCardSpec): FeishuPostPayload {
  return buildInteractivePayload({
    title: spec.title,
    template: spec.template,
    iconToken: spec.iconToken,
    bodyElements: spec.blocks.flatMap((block) => renderBusinessCardBlock(block)),
  });
}

function renderBusinessCardBlock(block: BusinessCardBlock): Array<Record<string, unknown>> {
  switch (block.kind) {
    case "title":
      return [buildTitleLine(block.content)];
    case "steps":
      return block.steps.flatMap((step) => buildProgressStepElements(step));
    case "quote":
      return [buildQuoteLine(block.content)];
    case "stats":
      return [buildStatsRow(block.labels)];
    case "tagChart":
      return [buildTagChartSection(block.tagCounts, block.bitableUrl, block.title, block.linkLabel)];
    case "elapsed":
      return [buildElapsedLine(block.content)];
    case "divider":
      return [buildDivider()];
    default:
      return [];
  }
}
