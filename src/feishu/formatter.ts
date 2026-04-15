import type { QueueNotice } from "../bridge/turn.js";
import type { KnowledgeIngestResult, KnowledgeQueryResult } from "../knowledge/index.js";
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
  interactionMode: string;
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
  previousTitle?: string;
  preservePrevious?: boolean;
  currentLabel: string;
  currentTitle?: string;
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
  showMessageIcon?: boolean;
};

export type KnowledgeQueryEmptyCardView = {
  question: string;
};

export type KnowledgeIngestProgressCardView = {
  sourceLabel: string;
  steps: ReadonlyArray<ToolUpdateView>;
  startedAt?: number | undefined;
  elapsedMs?: number | undefined;
};

export type KnowledgeIngestQueuedCardView = {
  sourceLabel: string;
  queuedAhead: number;
  startedAt?: number | undefined;
  elapsedMs?: number | undefined;
};

export type KnowledgeIngestFailureCardView = {
  sourceLabel: string;
  reason: string;
  suggestion?: string | undefined;
};

export type KnowledgeIngestSessionSummaryView = {
  completedCount: number;
  failedCount: number;
  queuedCount: number;
  currentLabel?: string | undefined;
  totalExtractedCount: number;
  totalDedupedCount: number;
  elapsedMs?: number | undefined;
  bitableUrl?: string | undefined;
  results?: KnowledgeIngestResult[] | undefined;
  failures?: Array<{ sourceFile: string; reason: string }> | undefined;
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
      buildNoticeBodyBlock(
        view.message,
        view.messageIconToken,
        view.messageIconColor,
        { showIcon: view.showMessageIcon ?? false },
      ),
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

export function buildKnowledgeQueryPayload(view: KnowledgeQueryResult): FeishuPostPayload {
  const footerTip = view.bitableUrl
    ? `以上内容仅供参考，不构成法律意见。\n\n[查看知识库](${escapeText(view.bitableUrl)})`
    : "以上内容仅供参考，不构成法律意见。";
  return buildInteractivePayload({
    title: "法律咨询",
    template: "indigo",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(`**问题**\n${escapeText(view.question)}`, "search_outlined", "indigo", { showIcon: false }),
      buildDivider(),
      ...view.results.flatMap((result, index) => {
        const parts = [
          `**答案 ${index + 1}**`,
          escapeText(result.answer),
          `📄 来源：${escapeText(result.sourceFile)}${result.pageSection ? ` · ${escapeText(result.pageSection)}` : ""}`,
          result.statute ? `📌 法条：${escapeText(result.statute)}` : "",
        ].filter(Boolean).join("\n\n");
        return index < view.results.length - 1
          ? [buildNoticeBodyBlock(parts, "book_outlined", "blue", { showIcon: false }), buildDivider()]
          : [buildNoticeBodyBlock(parts, "book_outlined", "blue", { showIcon: false })];
      }),
      buildDivider(),
      buildFooterTipBlock(footerTip, "warning_outlined", "orange", "notation"),
    ],
  });
}

export function buildKnowledgeQueryEmptyPayload(question: string): FeishuPostPayload {
  return buildInteractivePayload({
    title: "法律咨询",
    template: "wathet",
    iconToken: "search_outlined",
    bodyElements: [
      buildNoticeBodyBlock(`未找到与“${escapeText(question)}”直接相关的知识条目。`, "info_outlined", "grey", { showIcon: false }),
      buildDivider(),
      buildFooterTipBlock("以上内容仅供参考，不构成法律意见。", "warning_outlined", "orange", "notation"),
    ],
  });
}

export function buildKnowledgeIngestReadyPayload(): FeishuPostPayload {
  return buildInteractivePayload({
    title: "知识入库已开启",
    template: "indigo",
    iconToken: "status-meeting_filled",
    bodyElements: [
      buildGreyPanel([
        cardMarkdown("**支持格式** ：PDF / DOCX / TXT / MD\n**模式** ：批量入库", "normal"),
      ]),
      cardMarkdown("发送文件或 URL 即可入库\n", "normal"),
      cardMarkdown("发送 `/kb-ingest-end` 结束本次任务", "normal_v2"),
    ],
  });
}

export function buildKnowledgeIngestSessionPayload(view: KnowledgeIngestSessionSummaryView): FeishuPostPayload {
  const bodyParts = [
    `**已完成**\n${view.completedCount} 个素材`,
    `**处理中**\n${view.currentLabel ? escapeText(view.currentLabel) : "无"}`,
    `**排队中**\n${view.queuedCount} 个素材`,
    `**总入库**\n${view.totalExtractedCount} 条问答`,
  ];
  if (view.failedCount > 0) {
    bodyParts.push(`**失败**\n${view.failedCount} 个素材`);
  }
  return buildInteractivePayload({
    title: "知识入库会话",
    template: "blue",
    iconToken: "upload_outlined",
    bodyElements: [
      buildNoticeBodyBlock(bodyParts.join("\n\n"), "upload_outlined", "blue", { showIcon: false }),
      buildDivider(),
      buildFooterTipBlock("发送文件或网页链接继续入库；发送 `/kb-ingest-end` 结束。", "info_outlined", "grey", "notation"),
    ],
  });
}

export function buildKnowledgeIngestSessionFinalPayload(view: KnowledgeIngestSessionSummaryView): FeishuPostPayload {
  const bodyElements: Array<Record<string, unknown>> = [];
  const results = view.results ?? [];
  const failures = view.failures ?? [];

  if (results.length > 0 || failures.length > 0) {
    results.forEach((result, index) => {
      if (bodyElements.length > 0) {
        bodyElements.push(buildDivider());
      }
      bodyElements.push(buildKnowledgeIngestSummaryItem(result, "success"));
      if (index === results.length - 1 && failures.length === 0) {
        return;
      }
    });
    failures.forEach((failure) => {
      if (bodyElements.length > 0) {
        bodyElements.push(buildDivider());
      }
      bodyElements.push(buildKnowledgeIngestFailureSummaryItem(failure));
    });
  } else {
    bodyElements.push(buildStatsRow([
      `入库 ${view.totalExtractedCount}`,
      `失败 ${view.failedCount}`,
      `去重 ${view.totalDedupedCount}`,
    ]));
  }

  return buildInteractivePayload({
    title: "本次入库完成",
    template: "indigo",
    iconToken: "grid-view_filled",
    bodyElements: [
      ...bodyElements,
      buildDivider(),
      ...(view.bitableUrl ? [cardMarkdown(`[查看知识库 →](${escapeText(view.bitableUrl)})`, "normal")] : []),
    ],
  });
}

export function buildKnowledgeIngestPayload(view: KnowledgeIngestResult): FeishuPostPayload {
  const rawExtractedCount = view.rawExtractedCount ?? view.extractedCount;
  const dedupedCount = view.dedupedCount ?? Math.max(0, rawExtractedCount - view.extractedCount);
  const bodyElements: Array<Record<string, unknown>> = [
    buildTitleLine(`文件：**${escapeText(view.sourceFile)}**`),
    buildStatsRow([
      `入库 ${view.extractedCount}`,
      `提取 ${rawExtractedCount}`,
      `去重 ${dedupedCount}`,
    ]),
    buildTagChartSection(view.tagCounts, view.bitableUrl),
  ];
  if (view.warning) {
    bodyElements.push(buildQuoteLine(escapeText(view.warning)));
  }
  return buildInteractivePayload({
    title: "知识入库完成",
    template: "green",
    iconToken: "yes_filled",
    bodyElements,
  });
}

export function buildKnowledgeIngestQueuedPayload(view: KnowledgeIngestQueuedCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "知识入库排队中",
    template: "orange",
    iconToken: "time_outlined",
    bodyElements: [
      buildTitleLine(`排队文件：**${escapeText(view.sourceLabel)}**`),
      buildGreyPanel([
        cardMarkdown(`**前方队列**：${view.queuedAhead} 个素材`, "normal"),
        cardMarkdown("**预计开始**：前序处理完成后自动执行", "normal"),
      ]),
      buildQuoteLine("发送 /kb-ingest-end 提前结束入库"),
      buildDivider(),
      buildElapsedLine(resolveElapsedText(view)),
    ],
  });
}

export function buildKnowledgeIngestFailurePayload(view: KnowledgeIngestFailureCardView): FeishuPostPayload {
  return buildInteractivePayload({
    title: "入库失败",
    template: "red",
    iconToken: "error-hollow_filled",
    bodyElements: [
      buildTitleLine(`文件：**${escapeText(view.sourceLabel)}**`),
      buildGreyPanel([
        cardMarkdown(`**原因**：${escapeText(view.reason)}`, "normal_v2"),
        cardMarkdown(`**建议**：${escapeText(view.suggestion ?? "请检查文件是否损坏或重新上传")}`, "normal_v2"),
      ], { padding: "4px 4px 4px 4px" }),
    ],
  });
}

export function buildKnowledgeIngestProcessingPayload(view: KnowledgeIngestProgressCardView): FeishuPostPayload {
  const stepElements = view.steps.flatMap((step) => buildKnowledgeIngestProgressStepElements(step));
  return buildInteractivePayload({
    title: "知识入库进行中",
    template: "indigo",
    iconToken: "start_outlined",
    bodyElements: [
      buildTitleLine(`处理文件：**${escapeText(view.sourceLabel)}**`),
      ...stepElements,
      buildDivider(),
      buildElapsedLine(resolveElapsedText(view)),
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

function cardMarkdown(content: string, textSize = "normal", opts?: { icon?: IconDef; textAlign?: string }): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
    text_align: opts?.textAlign ?? "left",
    text_size: textSize,
    margin: "0px 0px 0px 0px",
    ...(opts?.icon ? { icon: standardIcon(opts.icon.token, opts.icon.color) } : {}),
  };
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

function buildTitleLine(content: string, icon?: IconDef): Record<string, unknown> {
  return buildStretchColumnSet([
    {
      ...buildWeightedColumn([
        cardMarkdown(content, "heading", icon ? { icon } : undefined),
      ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
    },
  ]);
}

function buildGreyPanel(elements: Array<Record<string, unknown>>, opts: { padding?: string } = {}): Record<string, unknown> {
  return buildStretchColumnSet([
    buildWeightedColumn(elements, {
      bg: "grey-50",
      padding: opts.padding ?? "12px 12px 12px 12px",
      verticalSpacing: "4px",
    }),
  ]);
}

function buildQuoteLine(content: string): Record<string, unknown> {
  return buildStretchColumnSet([
    buildWeightedColumn([
      cardMarkdown(`> ${content}`, "notation"),
    ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
  ], "8px");
}

function buildElapsedLine(content: string): Record<string, unknown> {
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

function buildStatsRow(labels: string[]): Record<string, unknown> {
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

function buildTagChartSection(tagCounts: Record<string, number>, bitableUrl?: string): Record<string, unknown> {
  const values = Object.entries(tagCounts)
    .slice(0, 10)
    .map(([tag, value]) => ({ tag, value }));
  const elements: Array<Record<string, unknown>> = [];
  if (values.length > 0) {
    elements.push({
      tag: "chart",
      chart_spec: {
        type: "pie",
        title: { text: "标签占比" },
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
    elements.push(cardMarkdown(`[查看知识库 →](${escapeText(bitableUrl)})`, "normal"));
  }
  return buildStretchColumnSet([
    buildWeightedColumn(elements, { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
  ], "8px");
}

function buildKnowledgeIngestProgressStepElements(step: ToolUpdateView): Array<Record<string, unknown>> {
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

function buildKnowledgeIngestSummaryItem(result: KnowledgeIngestResult, state: "success" | "error"): Record<string, unknown> {
  const rawExtractedCount = result.rawExtractedCount ?? result.extractedCount;
  const dedupedCount = result.dedupedCount ?? Math.max(0, rawExtractedCount - result.extractedCount);
  return buildStretchColumnSet([
    buildWeightedColumn([
      buildTitleLine(`文件：**${escapeText(result.sourceFile)}**`, {
        token: state === "success" ? "succeed-hollow_filled" : "error-hollow_filled",
        color: state === "success" ? "green" : "red",
      }),
      buildStatsRow([
        `入库 ${result.extractedCount}`,
        `提取 ${rawExtractedCount}`,
        `去重 ${dedupedCount}`,
      ]),
      buildTagChartSection(result.tagCounts),
    ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
  ], "8px");
}

function buildKnowledgeIngestFailureSummaryItem(failure: { sourceFile: string; reason: string }): Record<string, unknown> {
  return buildStretchColumnSet([
    buildWeightedColumn([
      buildTitleLine(`文件：**${escapeText(failure.sourceFile)}**`, {
        token: "error-hollow_filled",
        color: "red",
      }),
      buildQuoteLine(escapeText(failure.reason)),
    ], { padding: "0px 0px 0px 0px", verticalSpacing: "8px" }),
  ], "8px");
}

function resolveElapsedText(view: { elapsedMs?: number | undefined; startedAt?: number | undefined }): string {
  const elapsedMs = view.elapsedMs ?? (view.startedAt ? Date.now() - view.startedAt : 0);
  return `耗时：${formatDurationMs(elapsedMs)}`;
}

function formatKnowledgeIngestInlineStatus(step: ToolUpdateView): string {
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

function normalizeKnowledgeIngestDetail(step: ToolUpdateView): string {
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
        ], { weight: 1 }),
        vertical_spacing: "4px",
      },
    ]),
    flex_mode: "stretch",
    horizontal_spacing: "12px",
  };
}

function buildModelChip(model: ModelListCardView["providers"][number]["models"][number]): Record<string, unknown> {
  const label = model.id.includes("/") ? (model.id.split("/").at(-1) ?? model.id) : model.id;
  const highlighted = model.current;
  return {
    ...column([
      markdown(
        model.current
          ? `**${escapeText(label)}**`
          : model.default
            ? `${escapeText(label)} 默认`
            : escapeText(label),
        { size: "notation" },
      ),
    ], highlighted ? { bg: "purple-50" } : undefined),
    padding: "4px 4px 4px 4px",
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

function buildDivider(): Record<string, unknown> {
  return {
    tag: "hr",
    margin: "0px 0px 0px 0px",
  };
}

function buildFooterTipBlock(text: string, iconToken: string, iconColor: string, textSize: "notation" | "normal_v2"): Record<string, unknown> {
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

function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`;
}

function mapKnowledgeIngestStepIcon(status: ToolUpdateView["status"]): IconDef {
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
