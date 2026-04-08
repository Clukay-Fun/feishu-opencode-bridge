import type { QueueNotice } from "../bridge/turn.js";

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

export type TurnStatusCardView = {
  title: string;
  status: string;
  sessionId: string;
  durationText: string;
  progressUpdates: readonly string[];
  toolUpdates: ReadonlyArray<ToolUpdateView>;
  output: OutputView;
};

export function buildQueueNoticePayload(notice: QueueNotice): FeishuPostPayload {
  return buildPostMarkdownPayload(notice.message);
}

export function buildPostMarkdownPayload(markdown: string): FeishuPostPayload {
  return {
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title: "",
        content: [[{ tag: "md", text: markdown }]],
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

export function buildTurnStatusCardPayload(view: TurnStatusCardView): FeishuPostPayload {
  const state = resolveCardState(view.status);
  const toolElements = buildToolElements(view.toolUpdates);
  const outputElements = buildOutputElements(view.output, state);
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
        padding: "12px 8px 12px 12px",
        subtitle: { tag: "plain_text", content: "" },
        template: state.template,
        title: { tag: "plain_text", content: state.title },
        icon: {
          tag: "standard_icon",
          token: state.headerIconToken,
        },
      },
      body: {
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        elements: buildTurnBodyElements(state, toolElements, outputElements, view),
      },
    }),
  };
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : sessionId.slice(0, 12);
}

type CardState = {
  kind: "running" | "completed" | "error";
  title: string;
  template: "blue" | "green" | "red";
  headerIconToken: string;
};

function resolveCardState(status: string): CardState {
  if (status.includes("失败") || status.includes("超时") || status.includes("中止")) {
    return {
      kind: "error",
      title: "出了点问题",
      template: "red",
      headerIconToken: "error_filled",
    };
  }
  if (status.includes("完成")) {
    return {
      kind: "completed",
      title: "已完成",
      template: "green",
      headerIconToken: "thumbsup_filled",
    };
  }
  return {
    kind: "running",
    title: "正在忙",
    template: "blue",
    headerIconToken: "external_filled",
  };
}

function buildTurnBodyElements(
  state: CardState,
  toolElements: Array<Record<string, unknown>>,
  outputElements: Array<Record<string, unknown>>,
  view: TurnStatusCardView,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];

  if (state.kind !== "completed" && toolElements.length > 0) {
    elements.push(buildToolBlock(toolElements));
  }

  elements.push(buildOutputBlock(outputElements));
  elements.push(buildSpacerBlock());
  elements.push(buildFooter(view.sessionId, view.durationText));
  return elements;
}

function buildToolElements(lines: ReadonlyArray<ToolUpdateView>): Array<Record<string, unknown>> {
  return lines.slice(-3).map((line) => ({
    tag: "markdown",
    content: formatToolDisplay(line),
    text_align: "left",
    text_size: "normal",
    icon: mapToolIcon(line.status),
  }));
}

function formatToolDisplay(line: ToolUpdateView): string {
  return line.detail ? `**${escapeText(line.label)}**：${escapeText(line.detail)}` : `**${escapeText(line.label)}**`;
}

function mapToolIcon(status: ToolUpdateView["status"]): Record<string, string> {
  switch (status) {
    case "completed":
      return { tag: "standard_icon", token: "yes_outlined", color: "green" };
    case "error":
      return { tag: "standard_icon", token: "more-close_outlined", color: "red" };
    case "pending":
    case "running":
      return { tag: "standard_icon", token: "loading_outlined", color: "blue" };
    default:
      return { tag: "standard_icon", token: "info_outlined", color: "grey" };
  }
}

function buildOutputElements(output: OutputView, state: CardState): Array<Record<string, unknown>> {
  const blocks: string[] = [];

  if (output.text) {
    blocks.push(formatOutputText(output.text));
  }
  for (const path of output.paths) {
    blocks.push(`**${escapeText(fileNameFromPath(path))}**\n\`${escapeText(path)}\``);
  }
  if (output.commands.length > 0) {
    blocks.push(output.commands.map((command) => `\`${escapeText(command)}\``).join("\n"));
  }

  if (blocks.length === 0) {
    blocks.push(state.kind === "error" ? "问题描述" : "处理中...");
  }

  return [{
    tag: "markdown",
    content: blocks.join("\n\n"),
    text_align: "left",
    text_size: "normal_v2",
  }];
}

function formatOutputText(text: string): string {
  return escapeText(text)
    .split("\n")
    .map((line) => formatOutputLine(line))
    .join("\n");
}

function formatOutputLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  const titleLinkMatch = trimmed.match(/^(.*?)[，,:：]?\s*链接：(https?:\/\/\S+)$/);
  if (titleLinkMatch) {
    const title = titleLinkMatch[1]?.trim() ?? "打开链接";
    const url = titleLinkMatch[2] ?? "";
    return `[${title}](${url})`;
  }
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    return `[打开链接](${trimmed})`;
  }
  return line;
}

function fileNameFromPath(path: string): string {
  const parts = path.split("\\").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function buildToolBlock(toolElements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        background_style: "grey-50",
        elements: toolElements,
        padding: "12px 12px 12px 12px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "4px",
        horizontal_align: "left",
        vertical_align: "top",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildOutputBlock(outputElements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: outputElements,
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildSpacerBlock(): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: [
          {
            tag: "markdown",
            content: "",
            text_align: "left",
            text_size: "notation",
          },
        ],
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildFooter(sessionId: string, durationText: string): Record<string, unknown> {
  const duration = durationText ? `｜耗时：${durationText}` : "";
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content: `ID：${shortSessionId(sessionId)}${duration}`,
      text_size: "notation",
      text_align: "left",
      text_color: "grey",
    },
    icon: {
      tag: "standard_icon",
      token: "robot_outlined",
      color: "light_grey",
    },
  };
}

function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
