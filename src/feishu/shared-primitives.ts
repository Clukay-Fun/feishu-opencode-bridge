/**
 * 职责: 提供飞书消息载荷与共享卡片片段的基础构建能力。
 * 关注点:
 * - 统一 post、interactive、notice 等消息类型的拼装方式。
 * - 抽离各业务卡片都会复用的块级组件与辅助函数。
 */
import type { QueueNotice } from "../bridge/turn.js";
import { column, columnSet, markdown, standardIcon, type IconDef } from "./card-builder.js";
import { normalizeFeishuMarkdown } from "./markdown.js";

export type FeishuPostPayload = {
  msg_type: "post" | "interactive";
  content: string;
};

export type ToolUpdateView = {
  label: string;
  detail: string;
  status: "pending" | "running" | "completed" | "error" | "unknown";
};

export type OutputView = {
  text: string;
  paths: readonly string[];
  commands: readonly string[];
};

export type NoticeCardView = {
  title: string;
  template: "blue" | "green" | "red" | "wathet" | "grey" | "orange" | "yellow" | "purple" | "indigo";
  iconToken: string;
  message: string;
  messageIconToken?: string;
  messageIconColor?: string;
  showMessageIcon?: boolean;
};

// #region 基础消息载荷

/** 把队列提示渲染为最简 Markdown 消息。 */
export function buildQueueNoticePayload(notice: QueueNotice): FeishuPostPayload {
  return buildPostMarkdownPayload(notice.message);
}

/** 构建纯 Markdown 的飞书 post 消息。 */
export function buildPostMarkdownPayload(markdownText: string): FeishuPostPayload {
  return {
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title: "",
        content: [[{ tag: "md", text: normalizeFeishuMarkdown(markdownText) }]],
      },
    }),
  };
}

/** 构建带标题的普通文本 post 消息。 */
export function buildPostPayload(title: string, text: string): FeishuPostPayload {
  return {
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title,
        content: text.split("\n").map((line) => [{ tag: "text", text: line }]),
      },
    }),
  };
}

/** 构建统一样式的提示卡片。 */
export function buildNoticeCardPayload(view: NoticeCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: view.title,
    template: view.template,
    iconToken: view.iconToken,
    bodyElements: [
      buildNoticeBodyBlock(
        view.message,
        view.messageIconToken,
        view.messageIconColor,
        { showIcon: view.showMessageIcon ?? false },
      ),
    ],
  });
}

/** 将统一 payload 还原为 interactive card content。 */
export function toInteractiveCardContent(payload: FeishuPostPayload): Record<string, unknown> {
  return JSON.parse(payload.content) as Record<string, unknown>;
}

/** 构建通用 interactive 卡片载荷。 */
export function buildInteractivePayload(options: {
  title: string;
  template: "blue" | "green" | "red" | "wathet" | "grey" | "orange" | "yellow" | "purple" | "indigo";
  iconToken: string;
  bodyElements: Array<Record<string, unknown>>;
}): FeishuPostPayload {
  return {
    msg_type: "interactive",
    content: JSON.stringify({
      schema: "2.0",
      config: {
        update_multi: true,
        style: {
          text_size: {
            normal_v2: {
              default: "normal",
              mobile: "heading",
              pc: "normal",
            },
          },
        },
      },
      header: {
        padding: "12px 12px 12px 12px",
        subtitle: { tag: "plain_text", content: "" },
        template: options.template,
        title: { tag: "plain_text", content: options.title },
        icon: {
          tag: "standard_icon",
          token: options.iconToken,
        },
      },
      body: {
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        elements: options.bodyElements,
      },
    }),
  };
}

// #endregion

// #region 共享卡片块

/** 构建通知正文块，可按需带图标。 */
export function buildNoticeBodyBlock(
  message: string,
  iconToken = "info_outlined",
  iconColor = "grey",
  options: { showIcon?: boolean } = {},
): Record<string, unknown> {
  return columnSet([
    column([
      markdown(message, options.showIcon === false
        ? undefined
        : {
          icon: { token: iconToken, color: iconColor },
        }),
    ]),
  ]);
}

/** 构建分隔线元素。 */
export function buildDivider(): Record<string, unknown> {
  return {
    tag: "hr",
    margin: "0px 0px 0px 0px",
  };
}

/** 构建底部提示条。 */
export function buildFooterTipBlock(text: string, iconToken: string, iconColor: string, textSize: "notation" | "normal_v2"): Record<string, unknown> {
  return {
    ...columnSet([
      {
        ...column([
          markdown(text, { size: textSize, icon: { token: iconToken, color: iconColor } }),
        ], { weight: 1 }),
        vertical_spacing: "10px",
      },
    ]),
    flex_mode: "stretch",
  };
}

/** 转义卡片中可能破坏结构的尖括号。 */
export function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 构建带尺寸与图标选项的 Markdown 元素。 */
export function cardMarkdown(content: string, textSize = "normal", opts?: { icon?: IconDef; textAlign?: string }): Record<string, unknown> {
  return {
    tag: "markdown",
    content: normalizeFeishuMarkdown(content),
    text_align: opts?.textAlign ?? "left",
    text_size: textSize,
    margin: "0px 0px 0px 0px",
    ...(opts?.icon ? { icon: standardIcon(opts.icon.token, opts.icon.color) } : {}),
  };
}


/** 构建通用标题行。 */
export function buildTitleLine(content: string, icon?: IconDef): Record<string, unknown> {
  return buildStretchColumnSet([
    {
      ...buildWeightedColumn([
        cardMarkdown(content, "heading", icon ? { icon } : undefined),
      ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
    },
  ]);
}

/** 构建灰底面板。 */
export function buildGreyPanel(elements: Array<Record<string, unknown>>, opts: { padding?: string } = {}): Record<string, unknown> {
  return buildStretchColumnSet([
    buildWeightedColumn(elements, {
      bg: "grey-50",
      padding: opts.padding ?? "12px 12px 12px 12px",
      verticalSpacing: "4px",
    }),
  ]);
}

/** 构建引用风格的一行内容。 */
export function buildQuoteLine(content: string): Record<string, unknown> {
  return buildStretchColumnSet([
    buildWeightedColumn([
      cardMarkdown(`> ${content}`, "notation"),
    ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
  ], "8px");
}

/** 构建耗时展示行。 */
export function buildElapsedLine(content: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content,
      text_size: "notation",
      text_align: "left",
      text_color: "grey",
      lines: 1,
    },
    icon: standardIcon("alarm-clock_outlined", "light_grey"),
    margin: "0px 0px 0px 0px",
  };
}

/** 构建居中统计行。 */
export function buildStatsRow(labels: string[]): Record<string, unknown> {
  return {
    ...buildStretchColumnSet(labels.map((label) => buildWeightedColumn([
      cardMarkdown(escapeText(label), "heading", { textAlign: "center" }),
    ], {
      bg: "grey-50",
      horizontalAlign: "center",
      verticalAlign: "center",
    }))),
    flex_mode: "trisect",
  };
}

/** 构建标签占比图和可选跳转链接。 */
export function buildTagChartSection(
  tagCounts: Record<string, number>,
  bitableUrl?: string,
  title = "标签占比",
  linkLabel = "查看知识库",
): Record<string, unknown> {
  const values = Object.entries(tagCounts)
    .slice(0, 10)
    .map(([tag, value]) => ({ tag, value }));
  const elements: Array<Record<string, unknown>> = [];
  if (values.length > 0) {
    elements.push({
      tag: "chart",
      chart_spec: {
        type: "pie",
        title: { text: title },
        data: { values },
        seriesField: "tag",
        angleField: "value",
        label: {
          visible: true,
          formatter: "{tag} {value}",
        },
        legends: {
          visible: true,
          orient: "bottom",
        },
      },
      preview: true,
      color_theme: "converse",
      height: "auto",
      margin: "0px 0px 0px 0px",
    });
  } else {
    elements.push(cardMarkdown("暂无标签数据", "normal"));
  }
  if (bitableUrl) {
    elements.push(buildDivider());
    elements.push(cardMarkdown(`[${escapeText(linkLabel)} →](${escapeText(bitableUrl)})`, "normal"));
  }
  return buildStretchColumnSet([
    buildWeightedColumn(elements, { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
  ], "8px");
}

/** 构建单步进度状态的卡片元素。 */
export function buildProgressStepElements(step: ToolUpdateView): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    buildGreyPanel([
      cardMarkdown(`**${escapeText(step.label)}**：${formatStepInlineStatus(step)}`, "normal", {
        icon: mapStepStatusIcon(step.status),
      }),
    ]),
  ];
  const detail = normalizeStepDetail(step);
  if (detail) {
    elements.push(buildQuoteLine(detail));
  }
  return elements;
}

// #endregion

// #region 展示辅助

/** 根据显式耗时或 startedAt 生成耗时文案。 */
export function resolveElapsedText(view: { elapsedMs?: number | undefined; startedAt?: number | undefined }): string {
  const elapsedMs = view.elapsedMs ?? (view.startedAt ? Date.now() - view.startedAt : 0);
  return `耗时：${formatDurationMs(elapsedMs)}`;
}

/** 把毫秒格式化为秒或分秒文本。 */
export function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`;
}

/** 将步骤状态映射为行内文案。 */
export function formatStepInlineStatus(step: ToolUpdateView): string {
  switch (step.status) {
    case "completed":
      return "已完成";
    case "running":
      return "进行中...";
    case "error":
      return step.label === "写入知识库" ? "写入失败" : "执行失败";
    case "pending":
      return "等待中";
    default:
      return "未知状态";
  }
}

/** 规范化步骤详情，避免显示无意义占位文案。 */
export function normalizeStepDetail(step: ToolUpdateView): string {
  if (!step.detail || step.detail === "等待开始" || step.detail === "已完成" || step.detail === "处理中" || step.detail === "执行失败") {
    return "";
  }
  if (step.status === "running") {
    return `当前进度：${escapeText(step.detail)}`;
  }
  if (step.status === "error") {
    return `${escapeText(step.detail)}，发送 /retry 重试`;
  }
  return escapeText(step.detail);
}

/** 为步骤状态选择对应图标。 */
export function mapStepStatusIcon(status: ToolUpdateView["status"]): IconDef {
  switch (status) {
    case "completed":
      return { token: "yes_outlined", color: "green" };
    case "running":
      return { token: "loading_outlined", color: "blue" };
    case "error":
      return { token: "more-close_outlined", color: "red" };
    case "pending":
      return { token: "time_outlined", color: "grey" };
    default:
      return { token: "info_outlined", color: "grey" };
  }
}

// #endregion

function buildWeightedColumn(
  elements: Array<Record<string, unknown>>,
  opts: {
    bg?: string;
    padding?: string;
    horizontalAlign?: string;
    verticalAlign?: string;
    verticalSpacing?: string;
  } = {},
): Record<string, unknown> {
  return {
    tag: "column",
    width: "weighted",
    ...(opts.bg ? { background_style: opts.bg } : {}),
    elements,
    padding: opts.padding ?? "12px 12px 12px 12px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: opts.verticalSpacing ?? "4px",
    horizontal_align: opts.horizontalAlign ?? "left",
    vertical_align: opts.verticalAlign ?? "top",
    weight: 1,
    margin: "0px 0px 0px 0px",
  };
}

function buildStretchColumnSet(columns: Array<Record<string, unknown>>, horizontalSpacing = "12px"): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: horizontalSpacing,
    horizontal_align: "left",
    columns,
    margin: "0px 0px 0px 0px",
  };
}
