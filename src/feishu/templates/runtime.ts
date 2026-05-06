/**
 * 职责: 提供业务卡片模板运行时，将模板输入渲染为飞书卡片 payload。
 * 关注点:
 * - 定义模板、区块和卡片规格的统一类型。
 * - 执行模板输入校验，并把抽象区块转换为飞书低层元素。
 */
import type { ZodError } from "zod";

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
} from "../shared-primitives.js";
import { getBusinessCardTemplate } from "./registry.js";
import type { BusinessCardBlock, BusinessCardSpec, BusinessCardActionButton } from "./definition.js";
export type { AnyBusinessCardTemplateDefinition, BusinessCardTemplateDefinition } from "./definition.js";

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
): FeishuPostPayload {
  const template = getBusinessCardTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown business card template: ${templateId}`);
  }

  const parsed = template.schema.safeParse(input);
  if (!parsed.success) {
    throw new BusinessCardTemplateValidationError(templateId, parsed.error);
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
    case "actions":
      return [renderActionsBlock(block.buttons)];
    default:
      return [];
  }
}

/** 将模板 actions 区块渲染为飞书 column_set + button 布局。 */
function renderActionsBlock(buttons: ReadonlyArray<BusinessCardActionButton>): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: button.label,
          },
          type: button.type,
          width: button.width ?? "default",
          size: "medium",
          margin: "0px 0px 0px 0px",
          value: button.value,
        },
      ],
      vertical_align: "top",
    })),
    margin: "0px 0px 0px 0px",
  };
}
