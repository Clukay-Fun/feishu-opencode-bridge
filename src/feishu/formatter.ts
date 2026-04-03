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
  const progressUpdate = formatCurrentProgress(view.progressUpdates);
  const toolElements = buildToolElements(view.toolUpdates);
  const outputElements = buildOutputElements(view.output);
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
              mobile: "normal",
              pc: "normal",
            },
          },
        },
      },
      header: {
        padding: "12px 8px 12px 8px",
        subtitle: { tag: "plain_text", content: "" },
        template: mapCardTemplate(view.status),
        title: { tag: "plain_text", content: mapHeaderTitle(view.status) },
      },
      body: {
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        elements: [
          {
            tag: "column_set",
            flex_mode: "stretch",
            horizontal_spacing: "12px",
            horizontal_align: "left",
            margin: "0px 0px 0px 0px",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                horizontal_align: "left",
                vertical_align: "top",
                vertical_spacing: "8px",
                elements: [{ tag: "markdown", content: `**会话 ID**：\`${escapeText(shortSessionId(view.sessionId))}\``, text_align: "left", text_size: "normal_v2" }],
              },
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                horizontal_align: "left",
                vertical_align: "top",
                vertical_spacing: "8px",
                elements: [{ tag: "markdown", content: view.durationText ? `⏱ **耗时**：${escapeText(view.durationText)}` : "", text_align: "left", text_size: "normal_v2" }],
              },
            ],
          },
          { tag: "hr", margin: "0px 0px 0px 0px" },
          { tag: "markdown", content: "📋 **执行进度**", margin: "0px 0px 0px 0px" },
          {
            tag: "column_set",
            flex_mode: "stretch",
            horizontal_spacing: "12px",
            horizontal_align: "left",
            margin: "0px 0px 0px 0px",
            columns: [{
              tag: "column",
              width: "weighted",
              weight: 1,
              background_style: mapProgressBackground(view.status),
              padding: "12px 12px 12px 12px",
              direction: "vertical",
              horizontal_align: "left",
              vertical_align: "top",
              vertical_spacing: "4px",
              elements: [{ tag: "markdown", content: progressUpdate, text_align: "left", text_size: "normal_v2" }],
            }],
          },
          ...(toolElements.length > 0
            ? [
              { tag: "hr", margin: "0px 0px 0px 0px" },
              { tag: "markdown", content: "🔧 **工具调用**", margin: "0px 0px 0px 0px" },
              {
                tag: "column_set",
                flex_mode: "stretch",
                horizontal_spacing: "12px",
                horizontal_align: "left",
                margin: "0px 0px 0px 0px",
                columns: [{
                  tag: "column",
                  width: "weighted",
                  weight: 1,
                  background_style: "grey-50",
                  padding: "12px 12px 12px 12px",
                  horizontal_align: "left",
                  vertical_align: "top",
                  vertical_spacing: "4px",
                  elements: toolElements,
                }],
              },
            ]
            : []),
          { tag: "hr", margin: "0px 0px 0px 0px" },
          { tag: "markdown", content: "💬 **输出结果**", margin: "0px 0px 0px 0px" },
          {
            tag: "column_set",
            flex_mode: "stretch",
            horizontal_spacing: "12px",
            horizontal_align: "left",
            margin: "0px 0px 0px 0px",
            columns: [{
              tag: "column",
              width: "weighted",
              weight: 1,
              horizontal_align: "left",
              vertical_align: "top",
              vertical_spacing: "8px",
              elements: outputElements,
            }],
          },
        ],
      },
    }),
  };
}

function mapCardTemplate(status: string): string {
  if (status.includes("失败") || status.includes("超时") || status.includes("中止")) return "red";
  if (status.includes("完成")) return "green";
  return "blue";
}

function mapHeaderTitle(status: string): string {
  if (status.includes("失败") || status.includes("超时") || status.includes("中止")) return "任务异常";
  if (status.includes("完成")) return "任务已完成";
  return "任务进行中";
}

function mapProgressBackground(status: string): string {
  if (status.includes("失败") || status.includes("超时") || status.includes("中止")) return "red-50";
  if (status.includes("完成")) return "green-50";
  return "blue-50";
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : sessionId.slice(0, 12);
}

function formatCurrentProgress(lines: readonly string[]): string {
  const line = lines.length === 0 ? "等待 OpenCode 事件" : lines[lines.length - 1] ?? "等待 OpenCode 事件";
  return toProgressLine(line);
}

function toProgressLine(line: string): string {
  if (line.includes("已创建会话")) return "⏳ **已创建会话** — 等待 OpenCode 事件";
  if (line.includes("最终回复已生成（")) return `✅ **生成最终回复** — ${escapeText(line.replace("最终回复已生成", "").trim())}`;
  if (line.includes("检索")) return "✅ **检索相关信息** — 已完成";
  if (line.includes("上下文") || line.includes("整理")) return "✅ **整理上下文** — 已完成";
  if (line.includes("收到你的回答")) return "✅ **接收补充信息** — 已完成";
  return `⏳ **${escapeText(line)}** — 处理中`;
}

function buildToolElements(lines: ReadonlyArray<ToolUpdateView>): Array<Record<string, string>> {
  return lines.map((line) => ({
    tag: "markdown",
    content: formatToolDisplay(line),
    text_align: "left",
    text_size: "normal_v2",
  }));
}

function formatToolDisplay(line: ToolUpdateView): string {
  const icon = mapToolStatusIcon(line.status);
  return line.detail ? `${icon} **${escapeText(line.label)}**：${escapeText(line.detail)}` : `${icon} **${escapeText(line.label)}**`;
}

function mapToolStatusIcon(status: ToolUpdateView["status"]): string {
  switch (status) {
    case "pending":
    case "running": return "⏳";
    case "completed": return "✅";
    case "error": return "❌";
    default: return "•";
  }
}

function buildOutputElements(output: OutputView): Array<Record<string, string>> {
  const elements: Array<Record<string, string>> = [];
  if (output.text) {
    elements.push({ tag: "markdown", content: formatOutputText(output.text) });
  }
  for (const path of output.paths) {
    elements.push({ tag: "markdown", content: `**${escapeText(fileNameFromPath(path))}**\n\`${escapeText(path)}\`` });
  }
  if (output.commands.length > 0) {
    elements.push({ tag: "markdown", content: "执行命令：" });
    for (const command of output.commands) {
      elements.push({ tag: "markdown", content: `\`${escapeText(command)}\`` });
    }
  }
  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: "处理中..." });
  }
  return elements;
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

function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
