/**
 * 职责: 将飞书卡片设计器模板渲染为项目统一消息载荷。
 * 关注点:
 * - 深拷贝 .card 导出的 JSON，避免业务 builder 修改共享模板。
 * - 只提供字符串替换和轻量结构访问能力，保持视觉结构来自设计器。
 * - 输出仍遵循 FeishuPostPayload，方便现有发送链路复用。
 */
import { DESIGNER_CARD_TEMPLATES, type DesignerCardTemplateName } from "./designer-card-templates.js";
import type { FeishuPostPayload } from "./shared-primitives.js";

export type DesignerCard = Record<string, unknown>;

export type DesignerReplacement = {
  from: string;
  to: string;
};

export function buildDesignerCardPayload(
  templateName: DesignerCardTemplateName,
  replacements: readonly DesignerReplacement[] = [],
  mutate?: (card: DesignerCard) => void,
): FeishuPostPayload {
  const card = cloneDesignerCard(DESIGNER_CARD_TEMPLATES[templateName]);
  for (const replacement of replacements) {
    replaceDesignerCardText(card, replacement.from, replacement.to);
  }
  mutate?.(card);
  return {
    msg_type: "interactive",
    content: JSON.stringify(card),
  };
}

export function cloneDesignerCard(input: unknown): DesignerCard {
  return JSON.parse(JSON.stringify(input)) as DesignerCard;
}

export function replaceDesignerCardText(input: unknown, from: string, to: string): void {
  if (typeof input === "string") {
    return;
  }
  if (Array.isArray(input)) {
    input.forEach((item) => replaceDesignerCardText(item, from, to));
    return;
  }
  if (!input || typeof input !== "object") {
    return;
  }
  const record = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      record[key] = value.split(from).join(to);
    } else {
      replaceDesignerCardText(value, from, to);
    }
  }
}

export function replaceDesignerCardElement(
  input: unknown,
  predicate: (element: Record<string, unknown>) => boolean,
  replacement: Record<string, unknown> | undefined,
): boolean {
  if (Array.isArray(input)) {
    const index = input.findIndex((item) => isRecord(item) && predicate(item));
    if (index >= 0) {
      if (replacement) {
        input[index] = replacement;
      } else {
        input.splice(index, 1);
      }
      return true;
    }
    return input.some((item) => replaceDesignerCardElement(item, predicate, replacement));
  }
  if (!isRecord(input)) {
    return false;
  }
  return Object.values(input).some((value) => replaceDesignerCardElement(value, predicate, replacement));
}

export function removeDesignerCardElements(
  input: unknown,
  predicate: (element: Record<string, unknown>) => boolean,
): void {
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (isRecord(item) && predicate(item)) {
        input.splice(index, 1);
      } else {
        removeDesignerCardElements(item, predicate);
      }
    }
    return;
  }
  if (!isRecord(input)) {
    return;
  }
  for (const value of Object.values(input)) {
    removeDesignerCardElements(value, predicate);
  }
}

export function setDesignerButtonValue(card: DesignerCard, label: string, value: Record<string, unknown>): void {
  setDesignerButtonValueRecursive(card, label, value);
}

function setDesignerButtonValueRecursive(input: unknown, label: string, value: Record<string, unknown>): boolean {
  if (Array.isArray(input)) {
    return input.some((item) => setDesignerButtonValueRecursive(item, label, value));
  }
  if (!isRecord(input)) {
    return false;
  }
  if (input.tag === "button" && isRecord(input.text) && typeof input.text.content === "string"
    && (input.text.content === label || label.includes(input.text.content))) {
    input.value = value;
    return true;
  }
  return Object.values(input).some((item) => setDesignerButtonValueRecursive(item, label, value));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
