import type { QueueNotice } from "../bridge/turn.js";
import { column, columnSet, markdown, standardIcon, type IconDef } from "./card-builder.js";

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

export function buildQueueNoticePayload(notice: QueueNotice): FeishuPostPayload {
  return buildPostMarkdownPayload(notice.message);
}

export function buildPostMarkdownPayload(markdownText: string): FeishuPostPayload {
  return {
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title: "",
        content: [[{ tag: "md", text: markdownText }]],
      },
    }),
  };
}

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

export function toInteractiveCardContent(payload: FeishuPostPayload): Record<string, unknown> {
  return JSON.parse(payload.content) as Record<string, unknown>;
}

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

export function buildDivider(): Record<string, unknown> {
  return {
    tag: "hr",
    margin: "0px 0px 0px 0px",
  };
}

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

export function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function cardMarkdown(content: string, textSize = "normal", opts?: { icon?: IconDef; textAlign?: string }): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
    text_align: opts?.textAlign ?? "left",
    text_size: textSize,
    margin: "0px 0px 0px 0px",
    ...(opts?.icon ? { icon: standardIcon(opts.icon.token, opts.icon.color) } : {}),
  };
}

export function buildTitleLine(content: string, icon?: IconDef): Record<string, unknown> {
  return buildStretchColumnSet([
    {
      ...buildWeightedColumn([
        cardMarkdown(content, "heading", icon ? { icon } : undefined),
      ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
    },
  ]);
}

export function buildGreyPanel(elements: Array<Record<string, unknown>>, opts: { padding?: string } = {}): Record<string, unknown> {
  return buildStretchColumnSet([
    buildWeightedColumn(elements, {
      bg: "grey-50",
      padding: opts.padding ?? "12px 12px 12px 12px",
      verticalSpacing: "4px",
    }),
  ]);
}

export function buildQuoteLine(content: string): Record<string, unknown> {
  return buildStretchColumnSet([
    buildWeightedColumn([
      cardMarkdown(`> ${content}`, "notation"),
    ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
  ], "8px");
}

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

export function buildKnowledgeIngestProgressStepElements(step: ToolUpdateView): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    buildGreyPanel([
      cardMarkdown(`**${escapeText(step.label)}**：${formatKnowledgeIngestInlineStatus(step)}`, "normal", {
        icon: mapKnowledgeIngestStepIcon(step.status),
      }),
    ]),
  ];
  const detail = normalizeKnowledgeIngestDetail(step);
  if (detail) {
    elements.push(buildQuoteLine(detail));
  }
  return elements;
}

export function resolveElapsedText(view: { elapsedMs?: number | undefined; startedAt?: number | undefined }): string {
  const elapsedMs = view.elapsedMs ?? (view.startedAt ? Date.now() - view.startedAt : 0);
  return `耗时：${formatDurationMs(elapsedMs)}`;
}

export function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`;
}

export function formatKnowledgeIngestInlineStatus(step: ToolUpdateView): string {
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

export function normalizeKnowledgeIngestDetail(step: ToolUpdateView): string {
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

export function mapKnowledgeIngestStepIcon(status: ToolUpdateView["status"]): IconDef {
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
