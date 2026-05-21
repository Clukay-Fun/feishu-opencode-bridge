/**
 * 职责: 构建桥接运行时通用卡片。
 * 关注点:
 * - 覆盖 turn 状态、会话列表、模型列表、权限请求等运行时交互。
 * - 为桥接层的过程消息与系统通知提供一致的 UI 结构。
 */
import { column, columnSet, markdown, standardIcon } from "./card-builder.js";
import { buildDesignerCardPayload, cloneDesignerCard, setDesignerButtonValue, type DesignerCard } from "./designer-card-renderer.js";
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

type RuntimeCardActionButton = {
  label: string;
  type: "primary" | "default" | "danger";
  value: Record<string, unknown>;
  width?: "default" | "fill";
  confirm?: Record<string, unknown>;
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
      buildStatusActionBlock(),
    ],
  });
}

/** 构建 `/cost` 成本摘要卡。 */
export function buildCostCommandCardPayload(view: CostCommandCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "AI 成本摘要",
    template: "orange",
    iconToken: "wallet_outlined",
    bodyElements: [
      columnSet([
        column([
          markdown(`**今日**\n${view.todayTokens} tokens`, { icon: { token: "calendar_outlined", color: "orange" } }),
        ], { bg: "orange-50", weight: 1 }),
        column([
          markdown(`**本月**\n${view.monthTokens} tokens`, { icon: { token: "insert-chart_outlined", color: "blue" } }),
        ], { bg: "wathet-50", weight: 1 }),
      ]),
      buildDivider(),
      buildCostLimitBlock(view),
      buildFooterTipBlock("本页只展示本地 token 记录。终端运行 `bridge cost` 查看更多。", "info-hollow_filled", "grey", "notation"),
    ],
  });
}

/** 构建会话列表卡。 */
export function buildSessionListCardPayload(view: SessionListCardView): FeishuPostPayload {
  const bodyElements = view.items.length === 0
    ? [
      buildEmptyStateBlock(view.emptyText ?? "暂无会话"),
      buildDivider(),
      buildRuntimeActionBlock([
        runtimeCommandButton("新建会话", "/new", "primary", "send-message", "fill"),
      ]),
      buildFooterTipBlock(normalizeSessionListFooter(view.footer), "efficiency_outlined", "grey", "notation"),
    ]
    : [
      ...view.items.map((item) => buildSessionListItemBlock(item)),
      buildDivider(),
      buildSessionListActionBlock(view),
      buildFooterTipBlock(normalizeSessionListFooter(view.footer), "efficiency_outlined", "grey", "notation"),
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
  bodyElements.push(buildSessionTransitionLineBlock(view));
  if (view.review) {
    bodyElements.push(buildSessionReviewBlock(view.review));
  }
  bodyElements.push(buildDivider());
  if (view.previousLabel) {
    bodyElements.push(buildRuntimeActionBlock([
      runtimeCardActionButton("切回上一个", "switch-previous", "default", "update-card"),
    ]));
  }
  bodyElements.push(buildFooterTipBlock(normalizeSessionTransitionFooter(view.footer), "calendar-add_outlined", "green", "notation"));

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
    ...review.recentMessages.map((line, index) => `最近 ${index + 1}：${escapeText(line)}`),
  ];
  return columnSet([
    column([
      markdown(lines.join("\n"), { size: "notation" }),
    ], { bg: "grey-50", weight: 1 }),
  ]);
}

/** 构建模型列表卡。 */
export function buildModelListCardPayload(view: ModelListCardView): FeishuPostPayload {
  return buildDesignerCardPayload("可用模型", [], (card) => {
    applyModelListTemplateData(card, view);
  });
}

/** 构建权限请求卡。 */
export function buildPermissionRequestCardPayload(view: PermissionRequestCardView): FeishuPostPayload {
  return buildDesignerCardPayload("权限请求", [
    { from: "npm run build", to: view.permissionName },
  ], (card) => {
    for (const button of view.buttons) {
      setDesignerButtonValue(card, resolvePermissionDesignerButtonLabel(button.label), button.value);
    }
  });
}

function applyModelListTemplateData(card: DesignerCard, view: ModelListCardView): void {
  const header = getRuntimeDesignerRecord(card.header);
  const subtitle = getRuntimeDesignerRecord(header?.subtitle);
  if (subtitle) {
    subtitle.content = `当前：${view.currentModelLabel}`;
  }

  const body = getRuntimeDesignerRecord(card.body);
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  const providerRows = elements.filter((element) => isProviderModelRow(element));
  const footer = elements.find((element) => getRuntimeDesignerRecord(element)?.tag === "markdown"
    && typeof getRuntimeDesignerRecord(element)?.content === "string"
    && (getRuntimeDesignerRecord(element)?.content as string).includes("/model use"));

  const templateRow = providerRows[0] ? cloneDesignerCard(providerRows[0]) : null;
  while (providerRows.length < view.providers.length && templateRow) {
    const cloned = cloneDesignerCard(templateRow);
    const insertAt = footer ? elements.indexOf(footer) : elements.length;
    elements.splice(insertAt, 0, cloned);
    providerRows.push(cloned);
  }

  providerRows.forEach((row, index) => {
    const provider = view.providers[index];
    if (!provider) {
      const rowIndex = elements.indexOf(row);
      if (rowIndex >= 0) elements.splice(rowIndex, 1);
      return;
    }
    applyProviderModelRow(row, provider);
  });

  const footerRecord = getRuntimeDesignerRecord(footer);
  if (footerRecord && typeof footerRecord.content === "string") {
    footerRecord.content = view.footer;
  }
}

function applyProviderModelRow(row: unknown, provider: ModelListCardView["providers"][number]): void {
  const title = findFirstRuntimeMarkdown(row, (content) => /^(\*\*)?.+模型/.test(content));
  if (title) {
    title.content = `**${escapeText(provider.name)} 模型**`;
  }

  const modelColumnSet = findModelChipColumnSet(row);
  if (modelColumnSet) {
    const templateColumn = Array.isArray(modelColumnSet.columns) && modelColumnSet.columns[0]
      ? cloneDesignerCard(modelColumnSet.columns[0])
      : null;
    modelColumnSet.columns = provider.models.length > 0 && templateColumn
      ? provider.models.slice(0, 5).map((model) => buildModelChipColumn(templateColumn, model.id, Boolean(model.current)))
      : [buildModelEmptyColumn(templateColumn)];
  }

  const example = findFirstRuntimeMarkdown(row, (content) => content.includes("切换示例"));
  if (example) {
    const sample = provider.models[0]?.id;
    example.content = sample ? `>切换示例：${escapeText(sample)}` : ">暂无可切换模型";
  }
}

function buildModelChipColumn(templateColumn: DesignerCard, label: string, current: boolean): DesignerCard {
  const column = cloneDesignerCard(templateColumn);
  column.background_style = current ? "blue-50" : "grey-50";
  const markdownNode = findFirstRuntimeMarkdown(column);
  if (markdownNode) {
    markdownNode.content = escapeText(label);
  }
  return column;
}

function buildModelEmptyColumn(templateColumn: DesignerCard | null): DesignerCard {
  const column = templateColumn ? cloneDesignerCard(templateColumn) : {
    tag: "column",
    width: "auto",
    background_style: "grey-50",
    elements: [{ tag: "markdown", content: "暂无模型", text_align: "left", text_size: "normal" }],
    padding: "4px 8px 4px 8px",
  };
  const markdownNode = findFirstRuntimeMarkdown(column);
  if (markdownNode) {
    markdownNode.content = "暂无模型";
  }
  return column;
}

function isProviderModelRow(input: unknown): boolean {
  const record = getRuntimeDesignerRecord(input);
  if (!record || record.tag !== "column_set") {
    return false;
  }
  return Boolean(findFirstRuntimeMarkdown(record, (content) => content.includes("模型"))
    && findFirstRuntimeMarkdown(record, (content) => content.includes("切换示例")));
}

function findModelChipColumnSet(input: unknown): Record<string, unknown> | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findModelChipColumnSet(item);
      if (found) return found;
    }
    return null;
  }
  const record = getRuntimeDesignerRecord(input);
  if (!record) {
    return null;
  }
  if (record.tag === "column_set"
    && record.flex_mode === "stretch"
    && Array.isArray(record.columns)
    && record.columns.some((column) => Boolean(findFirstRuntimeMarkdown(column, (content) => !content.includes("模型") && !content.includes("切换示例"))))) {
    return record;
  }
  for (const value of Object.values(record)) {
    const found = findModelChipColumnSet(value);
    if (found) return found;
  }
  return null;
}

function findFirstRuntimeMarkdown(
  input: unknown,
  predicate: (content: string) => boolean = () => true,
): Record<string, unknown> | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstRuntimeMarkdown(item, predicate);
      if (found) return found;
    }
    return null;
  }
  const record = getRuntimeDesignerRecord(input);
  if (!record) {
    return null;
  }
  if (record.tag === "markdown" && typeof record.content === "string" && predicate(record.content)) {
    return record;
  }
  for (const value of Object.values(record)) {
    const found = findFirstRuntimeMarkdown(value, predicate);
    if (found) return found;
  }
  return null;
}

function getRuntimeDesignerRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolvePermissionDesignerButtonLabel(label: string): string {
  if (label.includes("once") || label.includes("仅此一次") || label.includes("允许一次")) {
    return "允许一次";
  }
  if (label.includes("always") || label.includes("始终允许")) {
    return "始终允许";
  }
  if (label.includes("deny") || label.includes("拒绝")) {
    return "拒绝";
  }
  return label;
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
          markdown("**用途**\n点击下方按钮，验证飞书卡片 action 是否能回调到 Bridge。", {
            icon: { token: "info-hollow_filled", color: "blue" },
          }),
        ], { bg: "blue-50", weight: 1 }),
      ]),
      buildKeyValueBlock("回调路径", `\`${escapeText(view.callbackPath)}\``),
      buildKeyValueBlock("测试 nonce", `\`${escapeText(view.nonce)}\``),
      buildDivider(),
      buildButtonCallbackTestActionBlock(view),
      buildFooterTipBlock("无提示时运行 `bridge doctor`，再检查 `http/card-action` 日志。", "wrench_outlined", "grey", "notation"),
    ],
  });
}

// #endregion

type CardState = {
  kind: "running" | "completed" | "error";
  title: string;
  template: "blue" | "green" | "red" | "indigo";
  headerIconToken: string;
};

function resolveCardState(status: string): CardState {
  if (status.includes("失败") || status.includes("超时") || status.includes("中止")) {
    return {
      kind: "error",
      title: "执行失败",
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
    title: "处理中",
    template: "indigo",
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
  elements.push(buildDivider());
  elements.push(buildFooter(view.sessionId, view.durationText));
  return elements;
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

function buildKeyValueBlock(label: string, value: string): Record<string, unknown> {
  return columnSet([
    column([markdown(escapeText(label), { size: "notation" })], { bg: "grey-50", weight: 1 }),
    column([markdown(value, { size: "notation" })], { bg: "grey-50", weight: 3 }),
  ]);
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
            markdown(session ? `**${escapeText(session.label)}**` : "当前窗口暂未绑定会话"),
            markdown(session ? `\`${escapeText(session.sessionId)}\`` : "未绑定", { size: "notation" }),
          ], { weight: 1 }),
          background_style: "grey-50",
        },
      ]),
    ], { weight: 1 }),
  ]);
}

function buildStatusSystemBlock(view: StatusCommandCardView): Record<string, unknown> {
  const statusChips = [
    buildStatusChip(view.connectionState, "wathet-50"),
    buildStatusChip(view.sessionState, mapStatusChipBackground(view.sessionState)),
    buildStatusChip(view.interactionMode, view.interactionMode === "知识库模式" ? "indigo-50" : "grey-50"),
    buildStatusChip(view.queueState, view.queueState === "空闲" ? "green-50" : "wathet-50"),
  ];
  const metricChips = [
    buildStatusChip(`排队 ${view.pendingCount}`, "grey-50"),
    buildStatusChip(`窗口 ${view.windowCount}`, "grey-50"),
    ...(view.costStatus ? [buildStatusChip(view.costStatus, view.costStatus.includes("已达") ? "red-50" : view.costStatus.includes("接近") ? "orange-50" : "green-50")] : []),
  ];

  return columnSet([
    column([
      markdown("**系统状态**", { icon: { token: "driveload_outlined", color: "blue" } }),
      {
        ...columnSet(statusChips),
        flex_mode: "flow",
      },
      {
        ...columnSet(metricChips),
        flex_mode: "flow",
      },
    ], { weight: 1 }),
  ]);
}

function buildStatusActionBlock(): Record<string, unknown> {
  return buildRuntimeActionBlock([
    runtimeCommandButton("查看全部会话", "/sessions", "default", "send-message"),
    runtimeCommandButton("新建会话", "/new", "primary", "send-message"),
  ]);
}

function buildCostLimitBlock(view: CostCommandCardView): Record<string, unknown> {
  const limit = view.dailyLimitCny === undefined ? "未设置" : `¥${view.dailyLimitCny.toFixed(2)}`;
  const rows = view.recent.length === 0
    ? [markdown("暂无本地成本记录", { size: "notation" })]
    : [
      buildCostTableHeader(),
      ...view.recent.map((entry) => buildCostTableRow(entry)),
    ];

  return columnSet([
    {
      ...column([
        markdown(`**日上限**\n${limit}`),
        ...rows,
      ], { bg: "grey-50", weight: 1 }),
      vertical_spacing: "6px",
    },
  ]);
}

function buildCostTableHeader(): Record<string, unknown> {
  return {
    ...columnSet([
      column([markdown("模型", { size: "notation" })], { bg: "grey-100", weight: 2 }),
      column([markdown("Tokens", { size: "notation" })], { bg: "grey-100", weight: 1 }),
    ]),
    flex_mode: "stretch",
  };
}

function buildCostTableRow(entry: CostCommandCardView["recent"][number]): Record<string, unknown> {
  return {
    ...columnSet([
      column([markdown(formatCostModelLabel(entry), { size: "notation" })], { bg: "bg-white", weight: 2 }),
      column([markdown(String(entry.totalTokens), { size: "notation" })], { bg: "bg-white", weight: 1 }),
    ]),
    flex_mode: "stretch",
  };
}

function formatCostModelLabel(entry: CostCommandCardView["recent"][number]): string {
  if (entry.source === "external-call") {
    return escapeText(`${entry.provider}/${entry.tool ?? entry.model}`);
  }
  if (entry.provider === "opencode-default" && entry.model === "default") {
    return "OpenCode 默认模型";
  }
  return `${escapeText(entry.provider)}/${escapeText(entry.model)}`;
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
  const meta = item.current ? "当前" : item.archived ? "已归档" : escapeText(item.meta ?? "");
  const rightElements = item.current || item.archived
    ? [{ ...markdown(meta), text_align: "right" }]
    : [buildCompactRuntimeButton(runtimeCommandButton("切换", `/switch ${item.index}`, "default", "send-message"))];
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
          elements: rightElements,
          vertical_align: "top",
        },
      ]),
    ], { bg: item.current ? "wathet-100" : item.archived ? "grey-50" : "bg-white", weight: 1 }),
  ]);
}

function formatSessionListTitle(item: SessionListCardView["items"][number]): string {
  const title = escapeText(item.title);
  const shortId = item.shortId ? `\n\`${escapeText(item.shortId)}\`` : "";
  if (item.archived) {
    return `~~${title}~~${shortId}`;
  }
  if (item.current) {
    return `**${title}**${shortId}`;
  }
  return `${title}${shortId}`;
}

function normalizeSessionListFooter(footer: string): string {
  const compact = footer
    .replace(/发送\s*`\/new`\s*/g, "")
    .replace(/发送\s*`\/switch <编号>`\s*(?:切换|恢复或切换)\s*·?\s*/g, "")
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.includes("`/"))
    .join(" · ")
    .replace(/发送\s*`\/new`\s*/g, "")
    .trim();
  return compact || "操作入口见上方按钮";
}

function buildSessionListActionBlock(view: SessionListCardView): Record<string, unknown> {
  const buttons = [
    runtimeCommandButton("新建会话", "/new", "primary", "send-message"),
  ];
  if (view.items.some((item) => item.archived)) {
    buttons.push(runtimeCardActionButton("清理已归档", "clean-archived", "danger", "update-card", "default", {
      title: {
        tag: "plain_text",
        content: "确认清理已归档会话？",
      },
      text: {
        tag: "plain_text",
        content: "该操作会进入二次确认流程。",
      },
    }));
  }
  return buildRuntimeActionBlock(buttons);
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

function buildSessionTransitionLineBlock(view: SessionTransitionCardView): Record<string, unknown> {
  const previous = view.previousLabel
    ? (view.preservePrevious ? `**${escapeText(view.previousLabel)}**` : `~~${escapeText(view.previousLabel)}~~`)
    : "";
  const current = `**${escapeText(view.currentLabel)}**`;
  const content = previous ? `${previous} → ${current}` : current;
  return {
    ...columnSet([
      column([
        markdown(content, { icon: { token: "right-bold_outlined", color: "green" } }),
      ], { bg: view.preservePrevious ? "grey-50" : "green-50", weight: 1 }),
    ]),
    flex_mode: "stretch",
  };
}

function normalizeSessionTransitionFooter(footer: string): string {
  if (footer.includes("继续") || footer.includes("发送")) {
    return "发送消息继续当前会话";
  }
  return footer;
}

function runtimeCommandButton(
  label: string,
  command: string,
  type: RuntimeCardActionButton["type"],
  response: "send-message" | "update-card",
  width?: RuntimeCardActionButton["width"],
): RuntimeCardActionButton {
  return {
    label,
    type,
    value: {
      kind: "runtime-command",
      command,
      response,
    },
    ...(width ? { width } : {}),
  };
}

function runtimeCardActionButton(
  label: string,
  action: string,
  type: RuntimeCardActionButton["type"],
  response: "send-message" | "update-card",
  width?: RuntimeCardActionButton["width"],
  confirm?: RuntimeCardActionButton["confirm"],
): RuntimeCardActionButton {
  return {
    label,
    type,
    value: {
      kind: "runtime-card-action",
      action,
      response,
    },
    ...(width ? { width } : {}),
    ...(confirm ? { confirm } : {}),
  };
}

function buildRuntimeActionBlock(buttons: readonly RuntimeCardActionButton[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [buildCompactRuntimeButton(button)],
      vertical_align: "top",
    })),
    margin: "0px 0px 0px 0px",
  };
}

function buildCompactRuntimeButton(button: RuntimeCardActionButton): Record<string, unknown> {
  return {
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
    ...(button.confirm ? { confirm: button.confirm } : {}),
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
  if (state.kind === "error") {
    return [markdown(buildErrorSummary(output), { size: "normal_v2" })];
  }

  const elements: Array<Record<string, unknown>> = [];

  if (output.text) {
    elements.push(markdown(formatOutputText(output.text), { size: "normal_v2" }));
  }

  if (output.paths.length > 0 || output.commands.length > 0) {
    elements.push(buildDivider());
  }

  if (output.paths.length > 0) {
    elements.push(markdown(buildPathSection(output.paths), { size: "normal_v2" }));
  }

  if (output.commands.length > 0) {
    elements.push(markdown(buildCommandSection(output.commands), { size: "normal_v2" }));
  }

  if (elements.length === 0) {
    elements.push(markdown("处理中...", { size: "normal_v2" }));
  }

  return elements;
}

function buildErrorSummary(output: OutputView): string {
  const parts = [
    output.text ? `**错误摘要**\n${formatOutputText(output.text)}` : "**错误摘要**\n执行失败，请查看日志或重试。",
    output.paths.length > 0 ? buildPathSection(output.paths) : "",
    output.commands.length > 0 ? buildCommandSection(output.commands) : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

function buildPathSection(paths: readonly string[]): string {
  return [
    "**涉及文件**",
    ...paths.map((item) => `- \`${escapeText(item)}\``),
  ].join("\n");
}

function buildCommandSection(commands: readonly string[]): string {
  return [
    "**执行命令**",
    "```",
    ...commands.map((command) => escapeText(command)),
    "```",
  ].join("\n");
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

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : sessionId.slice(0, 12);
}
