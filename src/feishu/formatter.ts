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

export type StatusCommandCardView = {
  currentSession: { sessionId: string; label: string } | null;
  connectionState: string;
  sessionMode: string;
  sessionState: string;
  queueState: string;
  pendingCount: number;
  windowCount: number;
};

export type SessionListCardView = {
  items: Array<{
    index: number;
    title: string;
    current?: boolean;
    archived?: boolean;
    meta?: string;
  }>;
  footer: string;
  emptyText?: string;
};

export type SessionTransitionCardView = {
  title: string;
  iconToken: string;
  previousLabel?: string | null;
  currentLabel: string;
  footer: string;
};

export type WhoCommandCardView = {
  boundCount: number;
  isBound: boolean;
};

export type LeaveCommandCardView = {
  unbound: boolean;
};

export type ModelListCardView = {
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      current?: boolean;
      default?: boolean;
    }>;
  }>;
  footer: string;
};

export type NoticeCardView = {
  title: string;
  template: "blue" | "green" | "red" | "wathet" | "grey" | "orange" | "yellow" | "purple" | "indigo";
  iconToken: string;
  message: string;
  messageIconToken?: string;
  messageIconColor?: string;
};

export type PermissionActionButton = {
  label: string;
  type: "default" | "primary" | "danger";
  value: Record<string, unknown>;
};

export type PermissionRequestCardView = {
  permissionName: string;
  buttons: PermissionActionButton[];
  expiresInSeconds: number;
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
  return buildInteractivePayload({
    title: state.title,
    template: state.template,
    iconToken: state.headerIconToken,
    bodyElements: buildTurnBodyElements(state, toolElements, outputElements, view),
  });
}

export function buildStatusCommandCardPayload(view: StatusCommandCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "会话状态",
    template: "wathet",
    iconToken: "insert-chart_outlined",
    bodyElements: [
      buildStatusCurrentSessionBlock(view.currentSession),
      buildStatusSystemBlock(view),
      buildDivider(),
      buildFooterTipBlock("`/sessions` 查看全部   `/new` 新建会话", "efficiency_outlined", "green", "normal_v2"),
    ],
  });
}

export function buildSessionListCardPayload(view: SessionListCardView): FeishuPostPayload {
  const bodyElements = view.items.length === 0
    ? [
      buildEmptyStateBlock(view.emptyText ?? "暂无会话"),
      buildDivider(),
      buildFooterTipBlock(view.footer, "efficiency_outlined", "green", "normal_v2"),
    ]
    : [
      ...view.items.map((item) => buildSessionListItemBlock(item)),
      buildDivider(),
      buildFooterTipBlock(view.footer, "efficiency_outlined", "green", "normal_v2"),
    ];

  return buildInteractivePayload({
    title: "会话列表",
    template: "wathet",
    iconToken: "chat_filled",
    bodyElements,
  });
}

export function buildSessionTransitionCardPayload(view: SessionTransitionCardView): FeishuPostPayload {
  const bodyElements: Array<Record<string, unknown>> = [];
  if (view.previousLabel) {
    bodyElements.push(buildSessionTransitionRow("离开", `~~${escapeText(view.previousLabel)}~~`, "grey-50"));
  }
  bodyElements.push(buildSessionTransitionRow("当前", `**${escapeText(view.currentLabel)}**`, "green-50"));
  bodyElements.push(buildDivider());
  bodyElements.push(buildFooterTipBlock(view.footer, "calendar-add_outlined", "green", "notation"));

  return buildInteractivePayload({
    title: view.title,
    template: "green",
    iconToken: view.iconToken,
    bodyElements,
  });
}

export function buildWhoCommandCardPayload(view: WhoCommandCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "群聊绑定状态",
    template: "blue",
    iconToken: "group_filled",
    bodyElements: [
      buildTwoColumnBadgeRow("已绑定人数", `**${view.boundCount} 人**`, "member_filled", "blue", "wathet-100"),
      buildTwoColumnBadgeRow("你的状态", view.isBound ? "**已绑定**" : "**未绑定**", view.isBound ? "yes_filled" : "error_filled", view.isBound ? "green" : "red", view.isBound ? "green-50" : "red-50"),
      buildDivider(),
      buildFooterTipBlock(view.isBound ? "发送 `/leave` 可解除绑定" : "@bot 并发送任意消息即可绑定", "info-hollow_filled", "grey", "notation"),
    ],
  });
}

export function buildLeaveCommandCardPayload(view: LeaveCommandCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: view.unbound ? "已解除绑定" : "无需解除绑定",
    template: "grey",
    iconToken: view.unbound ? "leaveroom_filled" : "info_filled",
    bodyElements: [
      {
        tag: "column_set",
        horizontal_spacing: "8px",
        horizontal_align: "left",
        columns: [
          {
            tag: "column",
            width: "auto",
            elements: [
              {
                tag: "markdown",
                content: view.unbound
                  ? "后续消息不再响应，发送任意消息并 `@bot` 可重新绑定。"
                  : "当前群里你尚未绑定，无需解除。",
                text_align: "left",
                text_size: "normal_v2",
                margin: "0px 0px 0px 0px",
                icon: {
                  tag: "standard_icon",
                  token: view.unbound ? "clear_outlined" : "info-hollow_filled",
                  color: "grey",
                },
              },
            ],
            padding: "8px 8px 8px 8px",
            direction: "vertical",
            horizontal_spacing: "8px",
            vertical_spacing: "8px",
            horizontal_align: "left",
            vertical_align: "top",
            margin: "0px 0px 0px 0px",
          },
        ],
        margin: "0px 0px 0px 0px",
      },
    ],
  });
}

export function buildModelListCardPayload(view: ModelListCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "可用模型",
    template: "indigo",
    iconToken: "ai-common_colorful",
    bodyElements: [
      ...view.providers.flatMap((provider, index) => {
        const elements: Array<Record<string, unknown>> = [
          buildModelProviderBlock(provider),
        ];
        if (index < view.providers.length - 1) {
          elements.push(buildDivider());
        }
        return elements;
      }),
      buildDivider(),
      {
        tag: "markdown",
        content: view.footer,
        text_align: "left",
        text_size: "notation",
        margin: "0px 0px 0px 0px",
      },
    ],
  });
}

export function buildNoticeCardPayload(view: NoticeCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: view.title,
    template: view.template,
    iconToken: view.iconToken,
    bodyElements: [
      buildNoticeBodyBlock(view.message, view.messageIconToken, view.messageIconColor),
    ],
  });
}

export function buildPermissionRequestCardPayload(view: PermissionRequestCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "权限请求",
    template: "purple",
    iconToken: "lock_filled",
    bodyElements: [
      buildPermissionRequestBlock(view.permissionName),
      buildDivider(),
      buildPermissionActionBlock(view.buttons),
      buildFooterTipBlock(
        `发送 \`/allow once\`、\`/allow always\` 或 \`/deny\` 也可处理\n${view.expiresInSeconds}s 后自动拒绝`,
        "alarm-clock_outlined",
        "grey",
        "notation",
      ),
    ],
  });
}

export function toInteractiveCardContent(payload: FeishuPostPayload): Record<string, unknown> {
  return JSON.parse(payload.content) as Record<string, unknown>;
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

function buildInteractivePayload(options: {
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

function buildNoticeBodyBlock(
  message: string,
  iconToken = "info_outlined",
  iconColor = "grey",
): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "markdown",
            content: message,
            text_align: "left",
            text_size: "normal_v2",
            margin: "0px 0px 0px 0px",
            icon: {
              tag: "standard_icon",
              token: iconToken,
              color: iconColor,
            },
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildPermissionRequestBlock(permissionName: string): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: [
          {
            tag: "markdown",
            content: "OpenCode 想执行：",
            text_align: "left",
            text_size: "normal_v2",
            margin: "0px 0px 0px 0px",
          },
          {
            tag: "column_set",
            horizontal_spacing: "8px",
            horizontal_align: "left",
            columns: [
              {
                tag: "column",
                width: "weighted",
                elements: [
                  {
                    tag: "markdown",
                    content: `\`\`\`\n${escapeText(permissionName)}\n\`\`\``,
                    text_align: "left",
                    text_size: "normal_v2",
                    margin: "0px 0px 0px 0px",
                  },
                ],
                vertical_align: "top",
                weight: 1,
              },
            ],
            margin: "0px 0px 0px 0px",
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildModelProviderBlock(provider: ModelListCardView["providers"][number]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "12px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: [
          {
            tag: "markdown",
            content: `${escapeText(provider.name)} 模型`,
            text_align: "left",
            text_size: "normal",
            margin: "0px 0px 0px 0px",
          },
          {
            tag: "column_set",
            flex_mode: "flow",
            horizontal_spacing: "8px",
            horizontal_align: "left",
            columns: provider.models.map((model) => buildModelChip(model)),
            margin: "0px 0px 0px 0px",
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "4px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildModelChip(model: ModelListCardView["providers"][number]["models"][number]): Record<string, unknown> {
  const label = model.id.includes("/") ? (model.id.split("/").at(-1) ?? model.id) : model.id;
  const highlighted = model.current;
  return {
    tag: "column",
    width: "auto",
    ...(highlighted ? { background_style: "purple-50" } : {}),
    elements: [
      {
        tag: "markdown",
        content: model.current
          ? `**${escapeText(label)}**`
          : model.default
            ? `${escapeText(label)} 默认`
            : escapeText(label),
        text_align: "left",
        text_size: "notation",
        margin: "0px 0px 0px 0px",
      },
    ],
    padding: "4px 4px 4px 4px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: "8px",
    horizontal_align: "left",
    vertical_align: "top",
    margin: "0px 0px 0px 0px",
  };
}

function buildPermissionActionBlock(buttons: PermissionActionButton[]): Record<string, unknown> {
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
          width: button.type === "primary" ? "fill" : "default",
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

function buildToolElements(lines: ReadonlyArray<ToolUpdateView>): Array<Record<string, unknown>> {
  return lines.slice(-3).map((line) => ({
    tag: "markdown",
    content: formatToolDisplay(line),
    text_align: "left",
    text_size: "normal",
    icon: mapToolIcon(line.status),
  }));
}

function buildStatusCurrentSessionBlock(session: StatusCommandCardView["currentSession"]): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: [
          {
            tag: "markdown",
            content: "**当前会话**",
            text_align: "left",
            text_size: "normal",
            margin: "0px 0px 0px 0px",
            icon: {
              tag: "standard_icon",
              token: "reply-cn_outlined",
              color: "grey",
            },
          },
          {
            tag: "column_set",
            horizontal_spacing: "8px",
            horizontal_align: "left",
            columns: [
              {
                tag: "column",
                width: "weighted",
                elements: [
                  {
                    tag: "markdown",
                    content: session ? `\`${escapeText(session.sessionId)}\`` : "未绑定",
                    text_align: "left",
                    text_size: "notation",
                    margin: "0px 0px 0px 0px",
                  },
                  {
                    tag: "column_set",
                    horizontal_spacing: "8px",
                    horizontal_align: "left",
                    columns: [
                      {
                        tag: "column",
                        width: "weighted",
                        background_style: "grey-50",
                        elements: [
                          {
                            tag: "markdown",
                            content: session ? escapeText(session.label) : "当前窗口暂未绑定会话",
                            text_align: "left",
                            text_size: "normal_v2",
                            margin: "0px 0px 0px 0px",
                          },
                        ],
                        padding: "8px 8px 8px 8px",
                        direction: "vertical",
                        horizontal_spacing: "8px",
                        vertical_spacing: "8px",
                        horizontal_align: "left",
                        vertical_align: "top",
                        margin: "0px 0px 0px 0px",
                        weight: 1,
                      },
                    ],
                    margin: "0px 0px 0px 0px",
                  },
                ],
                padding: "0px 0px 0px 0px",
                direction: "vertical",
                horizontal_spacing: "8px",
                vertical_spacing: "8px",
                horizontal_align: "left",
                vertical_align: "top",
                margin: "0px 0px 0px 0px",
                weight: 1,
              },
            ],
            margin: "0px 0px 0px 0px",
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildStatusSystemBlock(view: StatusCommandCardView): Record<string, unknown> {
  const chips = [
    buildStatusChip(view.connectionState, "wathet-50"),
    buildStatusChip(view.sessionState, mapStatusChipBackground(view.sessionState)),
    buildStatusChip(view.queueState, view.queueState === "空闲" ? "green-50" : "wathet-50"),
    buildStatusChip(`排队 ${view.pendingCount}`, "grey-50"),
    buildStatusChip(`窗口 ${view.windowCount}`, "grey-50"),
  ];

  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: [
          {
            tag: "markdown",
            content: "**系统状态**",
            text_align: "left",
            text_size: "normal_v2",
            margin: "0px 0px 0px 0px",
            icon: {
              tag: "standard_icon",
              token: "driveload_outlined",
              color: "blue",
            },
          },
          {
            tag: "column_set",
            flex_mode: "flow",
            horizontal_spacing: "8px",
            horizontal_align: "left",
            columns: chips,
            margin: "0px 0px 0px 0px",
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildStatusChip(text: string, backgroundStyle: string): Record<string, unknown> {
  return {
    tag: "column",
    width: "weighted",
    background_style: backgroundStyle,
    elements: [
      {
        tag: "markdown",
        content: escapeText(text),
        text_align: "center",
        text_size: "normal_v2",
        margin: "0px 0px 0px 0px",
      },
    ],
    padding: "8px 8px 8px 8px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: "8px",
    horizontal_align: "left",
    vertical_align: "top",
    margin: "0px 0px 0px 0px",
    weight: 1,
  };
}

function buildTwoColumnBadgeRow(
  label: string,
  value: string,
  iconToken: string,
  iconColor: string,
  backgroundStyle: string,
): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "markdown",
            content: label,
            text_align: "left",
            text_size: "normal_v2",
            margin: "0px 0px 0px 0px",
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
      },
      {
        tag: "column",
        width: "auto",
        background_style: backgroundStyle,
        elements: [
          {
            tag: "markdown",
            content: value,
            text_align: "left",
            text_size: "normal_v2",
            margin: "0px 0px 0px 0px",
            icon: {
              tag: "standard_icon",
              token: iconToken,
              color: iconColor,
            },
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function mapStatusChipBackground(status: string): string {
  if (status === "idle" || status === "空闲") {
    return "green-50";
  }
  if (status === "unbound" || status === "unknown") {
    return "grey-50";
  }
  return "wathet-50";
}

function buildSessionListItemBlock(item: SessionListCardView["items"][number]): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "weighted",
        background_style: item.current ? "wathet-100" : item.archived ? "grey-50" : "bg-white",
        elements: [
          {
            tag: "column_set",
            horizontal_spacing: "8px",
            horizontal_align: "left",
            columns: [
              {
                tag: "column",
                width: "20px",
                elements: [{
                  tag: "markdown",
                  content: `#${item.index}`,
                  text_align: "left",
                  text_size: "normal_v2",
                  margin: "0px 0px 0px 0px",
                }],
                vertical_align: "top",
              },
              {
                tag: "column",
                width: "weighted",
                elements: [{
                  tag: "markdown",
                  content: formatSessionListTitle(item),
                  text_align: "left",
                  text_size: "normal_v2",
                  margin: "0px 0px 0px 0px",
                }],
                vertical_align: "top",
                weight: 1,
              },
              {
                tag: "column",
                width: "auto",
                elements: [{
                  tag: "markdown",
                  content: item.current ? "当前" : escapeText(item.meta ?? ""),
                  text_align: "right",
                  text_size: "normal_v2",
                  margin: "0px 0px 0px 0px",
                }],
                vertical_align: "top",
              },
            ],
            margin: "0px 0px 0px 0px",
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function formatSessionListTitle(item: SessionListCardView["items"][number]): string {
  const title = escapeText(item.title);
  if (item.archived) {
    return `~~${title}~~`;
  }
  if (item.current) {
    return `**${title}**`;
  }
  return title;
}

function buildEmptyStateBlock(text: string): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "center",
    columns: [
      {
        tag: "column",
        width: "weighted",
        elements: [
          {
            tag: "markdown",
            content: escapeText(text),
            text_align: "center",
            text_size: "normal_v2",
            margin: "20px 20px 20px 20px",
          },
        ],
        vertical_align: "top",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildDivider(): Record<string, unknown> {
  return {
    tag: "hr",
    margin: "0px 0px 0px 0px",
  };
}

function buildFooterTipBlock(text: string, iconToken: string, iconColor: string, textSize: "notation" | "normal_v2"): Record<string, unknown> {
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
            content: text,
            text_align: "left",
            text_size: textSize,
            margin: "0px 0px 0px 0px",
            icon: {
              tag: "standard_icon",
              token: iconToken,
              color: iconColor,
            },
          },
        ],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "10px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildSessionTransitionRow(prefix: string, content: string, backgroundStyle: string): Record<string, unknown> {
  return {
    tag: "column_set",
    background_style: backgroundStyle,
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "50px",
        elements: [{
          tag: "markdown",
          content: prefix,
          text_align: "center",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px",
        }],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
      },
      {
        tag: "column",
        width: "weighted",
        elements: [{
          tag: "markdown",
          content,
          text_align: "left",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px",
        }],
        padding: "8px 8px 8px 8px",
        direction: "vertical",
        horizontal_spacing: "8px",
        vertical_spacing: "8px",
        horizontal_align: "left",
        vertical_align: "top",
        margin: "0px 0px 0px 0px",
        weight: 1,
      },
    ],
    margin: "0px 0px 0px 0px",
  };
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
  return splitMarkdownByCodeFence(text)
    .map((segment) => segment.kind === "code" ? segment.content : formatEscapedMarkdownSegment(segment.content))
    .join("");
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

function formatEscapedMarkdownSegment(text: string): string {
  return escapeText(text)
    .split("\n")
    .map((line) => formatOutputLine(line))
    .join("\n");
}

function splitMarkdownByCodeFence(text: string): Array<{ kind: "text" | "code"; content: string }> {
  const segments: Array<{ kind: "text" | "code"; content: string }> = [];
  const codeFencePattern = /```[\s\S]*?```/g;
  let lastIndex = 0;

  for (const match of text.matchAll(codeFencePattern)) {
    const start = match.index ?? 0;
    const block = match[0] ?? "";
    if (start > lastIndex) {
      segments.push({ kind: "text", content: text.slice(lastIndex, start) });
    }
    segments.push({ kind: "code", content: block });
    lastIndex = start + block.length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", content: text }];
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
