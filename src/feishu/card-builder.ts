/**
 * 职责: 提供飞书卡片元素级别的构建基元。
 * 关注点:
 * - 封装 markdown、column、columnSet 等低层元素拼装。
 * - 统一图标和列布局相关的轻量类型定义。
 */
import { normalizeFeishuMarkdown } from "./markdown.js";
export type IconDef = {
  token: string;
  color?: string;
};

export type ColumnDef = Record<string, unknown>;

/** 构建基础 markdown 元素。 */
export function markdown(content: string, opts?: { icon?: IconDef; size?: string }): Record<string, unknown> {
  return {
    tag: "markdown",
    content: normalizeFeishuMarkdown(content),
    text_align: "left",
    text_size: opts?.size ?? "normal_v2",
    margin: "0px 0px 0px 0px",
    ...(opts?.icon ? { icon: standardIcon(opts.icon.token, opts.icon.color) } : {}),
  };
}

/** 构建基础 column_set 元素。 */
export function columnSet(columns: ColumnDef[]): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns,
    margin: "0px 0px 0px 0px",
  };
}

/** 构建基础 column 元素。 */
export function column(elements: Record<string, unknown>[], opts?: { bg?: string; weight?: number }): Record<string, unknown> {
  return {
    tag: "column",
    width: opts?.weight ? "weighted" : "auto",
    ...(opts?.weight ? { weight: opts.weight } : {}),
    ...(opts?.bg ? { background_style: opts.bg } : {}),
    elements,
    padding: "8px 8px 8px 8px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: "8px",
    horizontal_align: "left",
    vertical_align: "top",
    margin: "0px 0px 0px 0px",
  };
}

/** 构建分隔线元素。 */
export function divider(): Record<string, unknown> {
  return {
    tag: "hr",
  };
}

/** 构建标准图标定义。 */
export function standardIcon(token: string, color = "grey"): Record<string, unknown> {
  return {
    tag: "standard_icon",
    token,
    color,
  };
}
