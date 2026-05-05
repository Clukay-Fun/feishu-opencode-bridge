/**
 * 职责: 构建桥接运行时通用卡片。
 * 关注点:
 * - 覆盖 turn 状态、会话列表、模型列表、权限请求等运行时交互。
 * - 为桥接层的过程消息与系统通知提供一致的 UI 结构。
 */
import { column, columnSet, markdown, standardIcon } from "./card-builder.js";
import {
  buildDivider,
  buildFooterTipBlock,
  buildInteractivePayload,
  escapeText,
  type FeishuPostPayload,
  type OutputView,
  type ToolUpdateView,
} from "./shared-primitives.js";
import { normalizeAssistantMarkdown } from "./markdown.js";

export type TurnStatusCardView = {
  title: string;
  status: string;
  sessionId: string;
  durationText: string;
  progressUpdates: readonly string[];
  toolUpdates: ReadonlyArray<ToolUpdateView>;
  output: OutputView;
  costSummary?: string | undefined;
};

export type StatusCommandCardView = {
  currentSession: { sessionId: string; label: string } | null;
  connectionState: string;
  sessionMode: string;
  interactionMode: string;
  sessionState: string;
  queueState: string;
  pendingCount: number;
  windowCount: number;
  costStatus?: string | undefined;
};
export type CostCommandCardView = {
  todayTokens: number;
  todayCostCny?: number | undefined;
  monthTokens: number;
  monthCostCny?: number | undefined;
  dailyLimitCny?: number | undefined;
  recent: Array<{
    createdAt: string;
    provider: string;
    model: string;
    totalTokens: number;
    estimatedCostCny?: number | undefined;
    source: "provider" | "estimated" | "external-call";
    tool?: string | undefined;
    operation?: string | undefined;
  }>;
};

export type SessionListCardView = {
  items: Array<{
    index: number;
    title: string;
    current?: boolean;
    archived?: boolean;
    meta?: string;
    /** 短会话 ID（前 12 位），用于显示和匹配。 */
    shortId?: string;
  }>;
  footer: string;
  emptyText?: string;
};

export type SessionTransitionCardView = {
  title: string;
  iconToken: string;
  previousLabel?: string | null;
  previousTitle?: string;
  preservePrevious?: boolean;
  currentLabel: string;
  currentTitle?: string;
  review?: {
    meta: string;
    recentMessages: string[];
  } | undefined;
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
  currentModelLabel: string;
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      current?: boolean;
    }>;
  }>;
  footer: string;
};

export type GuideCardView = {
  windowLabel: string;
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

export type ButtonCallbackTestCardView = {
  nonce: string;
  callbackPath: string;
};

// #region 运行时主卡片

/** 构建 turn 过程卡。 */
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

/** 构建 `/status` 结果卡。 */
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

/** 构建 `/cost` 成本摘要卡。 */
export function buildCostCommandCardPayload(view: CostCommandCardView): FeishuPostPayload {
  const todayCost = view.todayCostCny === undefined ? "未配置价格" : `≈¥${view.todayCostCny.toFixed(4)}`;
  const monthCost = view.monthCostCny === undefined ? "未配置价格" : `≈¥${view.monthCostCny.toFixed(4)}`;
  const limit = view.dailyLimitCny === undefined ? "未设置" : `¥${view.dailyLimitCny.toFixed(2)}`;
  const recent = view.recent.length === 0
    ? "暂无本地成本记录"
    : view.recent.map((entry) => {
      const cost = entry.estimatedCostCny === undefined ? "" : ` · ≈¥${entry.estimatedCostCny.toFixed(4)}`;
      const source = entry.source === "external-call"
        ? `${entry.tool ?? entry.model}/${entry.operation ?? "call"}`
        : (entry.source === "provider" ? "provider usage" : "估算");
      return `- ${escapeText(entry.provider)}/${escapeText(entry.model)} · ${entry.totalTokens} tokens${cost} · ${source}`;
    }).join("\n");

  return buildInteractivePayload({
    title: "AI 成本摘要",
    template: "orange",
    iconToken: "wallet_outlined",
    bodyElements: [
      columnSet([
        column([
          markdown(`**今日**\n${view.todayTokens} tokens\n${todayCost}`, { icon: { token: "calendar_outlined", color: "orange" } }),
        ], { bg: "orange-50", weight: 1 }),
        column([
          markdown(`**本月**\n${view.monthTokens} tokens\n${monthCost}`, { icon: { token: "insert-chart_outlined", color: "blue" } }),
        ], { bg: "wathet-50", weight: 1 }),
      ]),
      buildDivider(),
      columnSet([
        column([
          markdown(`**日上限**\n${limit}\n\n${recent}`, { icon: { token: "info-hollow_filled", color: "grey" } }),
        ], { bg: "grey-50", weight: 1 }),
      ]),
      buildDivider(),
      buildFooterTipBlock("金额是本地估算，provider 账单以服务商为准。终端运行 `bridge cost` 查看更多。", "calculator_outlined", "grey", "notation"),
    ],
  });
}

/** 构建会话列表卡。 */
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

/** 构建会话切换或创建结果卡。 */
export function buildSessionTransitionCardPayload(view: SessionTransitionCardView): FeishuPostPayload {
  const bodyElements: Array<Record<string, unknown>> = [];
  if (view.previousLabel) {
    bodyElements.push(buildSessionTransitionRow(
      view.previousTitle ?? "离开",
      view.preservePrevious ? `**${escapeText(view.previousLabel)}**` : `~~${escapeText(view.previousLabel)}~~`,
      view.preservePrevious ? "green-50" : "grey-50",
    ));
  }
  bodyElements.push(buildSessionTransitionRow(
    view.currentTitle ?? "当前",
    `**${escapeText(view.currentLabel)}**`,
    view.preservePrevious ? "grey-50" : "green-50",
  ));
  if (view.review) {
    bodyElements.push(buildSessionReviewBlock(view.review));
  }
  bodyElements.push(buildDivider());
  bodyElements.push(buildFooterTipBlock(view.footer, "calendar-add_outlined", "green", "notation"));

  return buildInteractivePayload({
    title: view.title,
    template: "green",
    iconToken: view.iconToken,
    bodyElements,
  });
}

function buildSessionReviewBlock(review: NonNullable<SessionTransitionCardView["review"]>): Record<string, unknown> {
  const lines = [
    `**会话回顾**\n${escapeText(review.meta)}`,
    ...review.recentMessages.map((line) => `- ${escapeText(line)}`),
  ];
  return columnSet([
    column([
      markdown(lines.join("\n"), { size: "notation", icon: { token: "history_outlined", color: "grey" } }),
    ], { bg: "grey-50", weight: 1 }),
  ]);
}

/** 构建 `/who` 结果卡。 */
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

/** 构建 `/leave` 结果卡。 */
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

/** 构建模型列表卡。 */
export function buildModelListCardPayload(view: ModelListCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "可用模型",
    template: "indigo",
    iconToken: "ai-common_colorful",
    bodyElements: [
      buildCurrentModelBlock(view.currentModelLabel),
      buildDivider(),
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

/** 构建权限请求卡。 */
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

/** 构建 `/guide` 新手引导卡。 */
export function buildGuideCardPayload(view: GuideCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "60 秒新手引导",
    template: "blue",
    iconToken: "compass_outlined",
    bodyElements: [
      columnSet([
        column([
          markdown(`**当前窗口**\n${escapeText(view.windowLabel)}\n\n先跑通一条 Hero 路线，再开始处理真实材料。`, {
            icon: { token: "info-hollow_filled", color: "blue" },
          }),
        ], { bg: "blue-50", weight: 1 }),
      ]),
      buildDivider(),
      buildGuideStepBlock("1", "上传样例材料", "使用违法解除劳动合同样例材料，先不要上传真实案件。"),
      buildGuideStepBlock("2", "启动 /劳动分析", "发送 `/劳动分析`，补充材料后发送 `/劳动分析结束`。"),
      buildGuideStepBlock("3", "确认检索词", "按卡片确认或编辑检索词，再查询本地知识库 / pkulaw 权威源。"),
      buildGuideStepBlock("4", "查看 Labor 输出", "重点看争议焦点、请求权基础、证据缺口、策略和文书草稿摘要。"),
      buildGuideStepBlock("5", "查看 Harness 报告", "本地运行 `npm run labor:harness`，按终端输出路径打开报告。"),
      buildDivider(),
      buildFooterTipBlock("常用命令：`/new` · `/sessions` · `/models` · `/cost`。本地排查运行 `bridge doctor workspace` 和 `npm run labor:harness`。", "efficiency_outlined", "green", "notation"),
    ],
  });
}

/** 构建按钮回调真机验收卡。 */
export function buildButtonCallbackTestCardPayload(view: ButtonCallbackTestCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "按钮回调测试",
    template: "blue",
    iconToken: "click_outlined",
    bodyElements: [
      columnSet([
        column([
          markdown(`**用途**\n点击下方按钮，验证飞书卡片 action 是否能回调到 Bridge。\n\n回调路径：\`${escapeText(view.callbackPath)}\`\n测试 nonce：\`${escapeText(view.nonce)}\``, {
            icon: { token: "info-hollow_filled", color: "blue" },
          }),
        ], { bg: "blue-50", weight: 1 }),
      ]),
      buildDivider(),
      buildButtonCallbackTestActionBlock(view),
      buildFooterTipBlock("如果点击后没有提示，请先运行 `bridge doctor`，再检查 `http/card-action` 日志。", "wrench_outlined", "grey", "notation"),
    ],
  });
}

// #endregion

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
  elements.push(buildFooter(view.sessionId, view.durationText, view.costSummary));
  return elements;
}

function buildPermissionRequestBlock(permissionName: string): Record<string, unknown> {
  return columnSet([
    column([
      markdown("OpenCode 想执行："),
      columnSet([
        {
          tag: "column",
          width: "weighted",
          elements: [markdown(`\`\`\`\n${escapeText(permissionName)}\n\`\`\``)],
          vertical_align: "top",
          weight: 1,
        },
      ]),
    ], { weight: 1 }),
  ]);
}

function buildGuideStepBlock(index: string, title: string, detail: string): Record<string, unknown> {
  return columnSet([
    column([
      markdown(`**${index}. ${escapeText(title)}**\n${detail}`, {
        icon: { token: "send_outlined", color: "green" },
      }),
    ], { bg: "grey-50", weight: 1 }),
  ]);
}

function buildModelProviderBlock(provider: ModelListCardView["providers"][number]): Record<string, unknown> {
  return {
    ...columnSet([
      {
        ...column([
          markdown(`${escapeText(provider.name)} 模型`, { size: "normal" }),
          {
            ...columnSet(provider.models.map((model) => buildModelChip(model))),
            flex_mode: "flow",
          },
          markdown(`切换示例：\`/model use ${escapeText(buildModelSwitchId(provider, provider.models[0]?.id ?? "<model>"))}\``, { size: "notation" }),
        ], { weight: 1 }),
        vertical_spacing: "4px",
      },
    ]),
    flex_mode: "stretch",
    horizontal_spacing: "12px",
  };
}

function buildCurrentModelBlock(currentModelLabel: string): Record<string, unknown> {
  return columnSet([
    column([
      markdown("**当前窗口模型**", { size: "notation", icon: { token: "setting_outlined", color: "blue" } }),
      markdown(escapeText(currentModelLabel), { size: "normal" }),
    ], { bg: "blue-50", weight: 1 }),
  ]);
}

function buildModelChip(model: ModelListCardView["providers"][number]["models"][number]): Record<string, unknown> {
  const label = model.id.includes("/") ? (model.id.split("/").at(-1) ?? model.id) : model.id;
  const highlighted = model.current;
  return {
    ...column([
      markdown(
        model.current
          ? `**${escapeText(label)}**`
          : escapeText(label),
        { size: "notation" },
      ),
    ], highlighted ? { bg: "purple-50" } : undefined),
    padding: "4px 4px 4px 4px",
  };
}

function buildModelSwitchId(provider: ModelListCardView["providers"][number], modelId: string): string {
  return modelId.includes("/") ? modelId : `${provider.id}/${modelId}`;
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
          confirm: button.type === "danger"
            ? {
              title: {
                tag: "plain_text",
                content: "确认操作",
              },
              text: {
                tag: "plain_text",
                content: "确认拒绝当前权限请求？",
              },
            }
            : undefined,
        },
      ],
      vertical_align: "top",
    })),
    margin: "0px 0px 0px 0px",
  };
}

function buildButtonCallbackTestActionBlock(view: ButtonCallbackTestCardView): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "点击测试回调",
            },
            type: "primary",
            width: "fill",
            size: "medium",
            value: {
              kind: "callback-demo",
              nonce: view.nonce,
              source: "button-test",
            },
          },
        ],
        vertical_align: "top",
      },
    ],
    margin: "0px 0px 0px 0px",
  };
}

function buildToolElements(lines: ReadonlyArray<ToolUpdateView>): Array<Record<string, unknown>> {
  return lines.map((line) => ({
    tag: "markdown",
    content: formatToolDisplay(line),
    text_align: "left",
    text_size: "normal",
    icon: mapToolIcon(line.status),
  }));
}

function buildStatusCurrentSessionBlock(session: StatusCommandCardView["currentSession"]): Record<string, unknown> {
  return columnSet([
    column([
      markdown("**当前会话**", { size: "normal", icon: { token: "reply-cn_outlined", color: "grey" } }),
      columnSet([
        {
          ...column([
            markdown(session ? `\`${escapeText(session.sessionId)}\`` : "未绑定", { size: "notation" }),
            columnSet([
              column([
                markdown(session ? escapeText(session.label) : "当前窗口暂未绑定会话"),
              ], { bg: "grey-50", weight: 1 }),
            ]),
          ], { weight: 1 }),
          padding: "0px 0px 0px 0px",
        },
      ]),
    ], { weight: 1 }),
  ]);
}

function buildStatusSystemBlock(view: StatusCommandCardView): Record<string, unknown> {
  const chips = [
    buildStatusChip(view.connectionState, "wathet-50"),
    buildStatusChip(view.sessionState, mapStatusChipBackground(view.sessionState)),
    buildStatusChip(view.interactionMode, view.interactionMode === "知识库模式" ? "indigo-50" : "grey-50"),
    buildStatusChip(view.queueState, view.queueState === "空闲" ? "green-50" : "wathet-50"),
    buildStatusChip(`排队 ${view.pendingCount}`, "grey-50"),
    buildStatusChip(`窗口 ${view.windowCount}`, "grey-50"),
    ...(view.costStatus ? [buildStatusChip(view.costStatus, view.costStatus.includes("已达") ? "red-50" : view.costStatus.includes("接近") ? "orange-50" : "green-50")] : []),
  ];

  return columnSet([
    column([
      markdown("**系统状态**", { icon: { token: "driveload_outlined", color: "blue" } }),
      {
        ...columnSet(chips),
        flex_mode: "flow",
      },
    ], { weight: 1 }),
  ]);
}

function buildStatusChip(text: string, backgroundStyle: string): Record<string, unknown> {
  return {
    ...column([
      {
        ...markdown(escapeText(text)),
        text_align: "center",
      },
    ], { bg: backgroundStyle, weight: 1 }),
  };
}

function buildTwoColumnBadgeRow(
  label: string,
  value: string,
  iconToken: string,
  iconColor: string,
  backgroundStyle: string,
): Record<string, unknown> {
  return columnSet([
    column([markdown(label)]),
    column([
      markdown(value, { icon: { token: iconToken, color: iconColor } }),
    ], { bg: backgroundStyle }),
  ]);
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
  return columnSet([
    column([
      columnSet([
        {
          tag: "column",
          width: "20px",
          elements: [markdown(`#${item.index}`)],
          vertical_align: "top",
        },
        {
          tag: "column",
          width: "weighted",
          elements: [markdown(formatSessionListTitle(item))],
          vertical_align: "top",
          weight: 1,
        },
        {
          tag: "column",
          width: "auto",
          elements: [{ ...markdown(item.current ? "当前" : escapeText(item.meta ?? "")), text_align: "right" }],
          vertical_align: "top",
        },
      ]),
    ], { bg: item.current ? "wathet-100" : item.archived ? "grey-50" : "bg-white", weight: 1 }),
  ]);
}

function formatSessionListTitle(item: SessionListCardView["items"][number]): string {
  const title = escapeText(item.title);
  const shortIdSuffix = item.shortId ? ` \`${escapeText(item.shortId)}\`` : "";
  if (item.archived) {
    return `~~${title}~~${shortIdSuffix}`;
  }
  if (item.current) {
    return `**${title}**${shortIdSuffix}`;
  }
  return `${title}${shortIdSuffix}`;
}

function buildEmptyStateBlock(text: string): Record<string, unknown> {
  return {
    ...columnSet([
      {
        ...column([
          {
            ...markdown(escapeText(text)),
            text_align: "center",
            margin: "20px 20px 20px 20px",
          },
        ], { weight: 1 }),
        padding: "0px 0px 0px 0px",
      },
    ]),
    horizontal_align: "center",
  };
}

function buildSessionTransitionRow(prefix: string, content: string, backgroundStyle: string): Record<string, unknown> {
  return {
    ...columnSet([
      {
        ...column([{ ...markdown(prefix), text_align: "center" }]),
        width: "84px",
      },
      column([markdown(content)], { weight: 1 }),
    ]),
    background_style: backgroundStyle,
  };
}

function formatToolDisplay(line: ToolUpdateView): string {
  return line.detail ? `**${escapeText(line.label)}**：${escapeText(line.detail)}` : `**${escapeText(line.label)}**`;
}

function mapToolIcon(status: ToolUpdateView["status"]): Record<string, string> {
  switch (status) {
    case "completed":
      return standardIcon("yes_outlined", "green") as Record<string, string>;
    case "error":
      return standardIcon("more-close_outlined", "red") as Record<string, string>;
    case "pending":
    case "running":
      return standardIcon("loading_outlined", "blue") as Record<string, string>;
    default:
      return standardIcon("info_outlined", "grey") as Record<string, string>;
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

  return [markdown(blocks.join("\n\n"), { size: "normal_v2" })];
}

function formatOutputText(text: string): string {
  return splitMarkdownByCodeFence(normalizeAssistantMarkdown(text))
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
  return neutralizeMarkdownTables(escapeText(text))
    .split("\n")
    .map((line) => formatOutputLine(line))
    .join("\n");
}

function neutralizeMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (!isMarkdownTableRow(line) || !isMarkdownTableSeparator(nextLine)) {
      output.push(line);
      continue;
    }

    output.push(formatMarkdownTableRowAsText(line));
    index += 2;
    while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
      output.push(formatMarkdownTableRowAsText(lines[index] ?? ""));
      index += 1;
    }
    index -= 1;
  }

  return output.join("\n");
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return false;
  }
  return splitMarkdownTableCells(trimmed).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableCells(line.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableCells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function formatMarkdownTableRowAsText(line: string): string {
  return `- ${splitMarkdownTableCells(line).join(" ｜ ")}`;
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
    ...columnSet([
      {
        ...column(toolElements, { bg: "grey-50", weight: 1 }),
        padding: "12px 12px 12px 12px",
        vertical_spacing: "4px",
      },
    ]),
    flex_mode: "stretch",
    horizontal_spacing: "12px",
  };
}

function buildOutputBlock(outputElements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...columnSet([
      {
        ...column(outputElements, { weight: 1 }),
        padding: "0px 0px 0px 0px",
      },
    ]),
    flex_mode: "stretch",
    horizontal_spacing: "12px",
  };
}

function buildSpacerBlock(): Record<string, unknown> {
  return {
    ...columnSet([
      {
        ...column([markdown("", { size: "notation" })], { weight: 1 }),
        padding: "0px 0px 0px 0px",
      },
    ]),
    flex_mode: "stretch",
  };
}

function buildFooter(sessionId: string, durationText: string, costSummary?: string): Record<string, unknown> {
  const duration = durationText ? `｜耗时：${durationText}` : "";
  const cost = costSummary ? `｜${costSummary}` : "";
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content: `ID：${shortSessionId(sessionId)}${duration}${cost}`,
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

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : sessionId.slice(0, 12);
}
