/**
 * 职责: 定义业务卡片模板的纯类型契约。
 * 关注点:
 * - 让模块侧 cardTemplates 能声明模板而不加载模板 runtime。
 * - 避免 extension registry 与模板 runtime 形成循环依赖。
 */
import type { ZodTypeAny, infer as Infer } from "zod";

import type { ToolUpdateView } from "../shared-primitives.js";

type CardTemplate = "blue" | "green" | "red" | "wathet" | "grey" | "orange" | "yellow" | "purple" | "indigo";

export type BusinessCardBlock =
  | { kind: "title"; content: string }
  | { kind: "steps"; steps: ReadonlyArray<ToolUpdateView> }
  | { kind: "quote"; content: string }
  | { kind: "stats"; labels: string[] }
  | { kind: "tagChart"; tagCounts: Record<string, number>; bitableUrl?: string | undefined; title?: string; linkLabel?: string }
  | { kind: "elapsed"; content: string }
  | { kind: "divider" }
  | { kind: "actions"; buttons: ReadonlyArray<BusinessCardActionButton> };

/** 模板运行时按钮定义，用于 search-confirm 等交互型卡片。 */
export type BusinessCardActionButton = {
  label: string;
  type: "primary" | "default" | "danger";
  value: Record<string, unknown>;
  width?: "fill" | "default" | undefined;
};

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
