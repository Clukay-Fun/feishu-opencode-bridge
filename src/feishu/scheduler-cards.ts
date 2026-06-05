/**
 * 职责: 渲染 /schedule 命令的飞书卡片。
 * 关注点:
 * - 5 张卡片：list / show / confirm / runs / notice
 * - 短 ID 一致使用
 * - designer-quality 渲染
 */
import type { ScheduledJob, JobState, JobRun } from "../scheduler/types.js";
import type { FeishuPostPayload } from "./shared-primitives.js";

function formatScheduleDesc(schedule: ScheduledJob["schedule"]): string {
  switch (schedule.kind) {
    case "cron": return `cron: \`${schedule.expression}\``;
    case "interval": return `每 ${schedule.expression}`;
    case "once": return `一次性: ${schedule.expression}`;
  }
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function statusIcon(status: string): string {
  switch (status) {
    case "success": return "✅";
    case "error": return "❌";
    case "skipped": return "⏭️";
    default: return "⚪";
  }
}

export function buildScheduleListCardPayload(data: {
  jobs: ScheduledJob[];
  states: Record<string, JobState>;
  showAll: boolean;
}): FeishuPostPayload {
  const rows = data.jobs.map((job) => {
    const state = data.states[job.id];
    const status = state?.isRunning ? "🔄 运行中"
      : !job.enabled ? "⏸️ 已暂停"
      : "✅ 活跃";
    const nextRun = formatTimestamp(state?.nextRunAt ?? null);
    const runCount = state?.runCount ?? 0;
    return [
      `**${job.shortId}**`,
      job.name.slice(0, 30),
      formatScheduleDesc(job.schedule),
      status,
      nextRun,
      `${runCount} 次`,
    ].join(" | ");
  });

  const header = data.showAll ? "所有定时任务" : "我的定时任务";
  const tableHeader = "ID | 名称 | 调度 | 状态 | 下次执行 | 已执行";

  return {
    msg_type: "interactive",
    content: JSON.stringify({
      header: {
        title: { tag: "plain_text", content: header },
        template: "blue",
      },
      elements: [
        { tag: "markdown", content: tableHeader },
        { tag: "markdown", content: rows.join("\n") || "暂无任务" },
        { tag: "hr" },
        {
          tag: "markdown",
          content: "使用 `/schedule add` 创建 · `/schedule show <ID>` 查看详情",
        },
      ],
    }),
  };
}

export function buildScheduleShowCardPayload(data: {
  job: ScheduledJob;
  state: JobState | undefined;
  runs: JobRun[];
}): FeishuPostPayload {
  const { job, state, runs } = data;
  const status = state?.isRunning ? "🔄 运行中" : !job.enabled ? "⏸️ 已暂停" : "✅ 活跃";
  const runLines = runs.map((r) =>
    `${statusIcon(r.status)} ${formatTimestamp(r.startedAt)} — ${r.status}${r.detail ? ` (${r.detail})` : ""}`
  );

  return {
    msg_type: "interactive",
    content: JSON.stringify({
      header: {
        title: { tag: "plain_text", content: `任务详情：${job.shortId}` },
        template: "blue",
      },
      elements: [
        {
          tag: "markdown",
          content: [
            `**名称**：${job.name}`,
            `**调度**：${formatScheduleDesc(job.schedule)}`,
            `**状态**：${status}`,
            `**下次执行**：${formatTimestamp(state?.nextRunAt ?? null)}`,
            `**已执行**：${state?.runCount ?? 0} 次 · 跳过 ${state?.skipCount ?? 0} 次`,
            `**提示词**：${job.prompt}`,
            `**创建者**：<at id=${job.creatorOpenId}></at>`,
          ].join("\n"),
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `**最近执行记录**\n${runLines.join("\n") || "暂无记录"}`,
        },
      ],
    }),
  };
}

export function buildScheduleConfirmCardPayload(data: {
  job: ScheduledJob;
  action: "delete";
}): FeishuPostPayload {
  return {
    msg_type: "interactive",
    content: JSON.stringify({
      header: {
        title: { tag: "plain_text", content: "确认删除任务" },
        template: "red",
      },
      elements: [
        {
          tag: "markdown",
          content: `确定要删除任务 **${data.job.shortId}**（${data.job.name}）吗？\n\n此操作不可撤销。`,
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "确认删除" },
              type: "danger",
              value: { kind: "schedule-delete-confirm", shortId: data.job.shortId },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "取消" },
              type: "default",
              value: { kind: "schedule-cancel" },
            },
          ],
        },
      ],
    }),
  };
}

export function buildScheduleRunsCardPayload(data: {
  job: ScheduledJob;
  runs: JobRun[];
}): FeishuPostPayload {
  const lines = data.runs.map((r) => {
    const meta = [
      r.triggerKind ? `触发:${r.triggerKind}` : null,
      r.silent ? "silent" : null,
      r.openCodeSessionId ? `session:${r.openCodeSessionId}` : null,
      r.deliveryMessageId ? `message:${r.deliveryMessageId}` : null,
    ].filter(Boolean).join(" · ");
    return `${statusIcon(r.status)} ${formatTimestamp(r.startedAt)} — ${r.status}${r.detail ? ` (${r.detail})` : ""} — ${(r.finishedAt ?? 0) - r.startedAt}ms${meta ? `\n${meta}` : ""}`;
  });

  return {
    msg_type: "interactive",
    content: JSON.stringify({
      header: {
        title: { tag: "plain_text", content: `执行记录：${data.job.shortId}` },
        template: "blue",
      },
      elements: [
        {
          tag: "markdown",
          content: lines.join("\n") || "暂无执行记录",
        },
      ],
    }),
  };
}

export function buildScheduleNoticeCardPayload(data: {
  job: ScheduledJob;
  action: "created" | "deleted" | "triggered";
}): FeishuPostPayload {
  const messages = {
    created: `✅ 任务 ${data.job.shortId} 已创建：${data.job.name}`,
    deleted: `🗑️ 任务 ${data.job.shortId} 已删除`,
    triggered: `🚀 任务 ${data.job.shortId} 已触发手动执行`,
  };

  return {
    msg_type: "interactive",
    content: JSON.stringify({
      header: {
        title: { tag: "plain_text", content: "定时任务" },
        template: "green",
      },
      elements: [
        { tag: "markdown", content: messages[data.action] },
      ],
    }),
  };
}

export function buildScheduleConfirmNlCardPayload(data: {
  pendingKey: string;
  scheduleDesc: string;
  prompt: string;
  deliveryTarget: string;
  useOpenCode: boolean;
}): FeishuPostPayload {
  const opencodeNote = data.useOpenCode
    ? "将调用 AI 执行并投递结果"
    : "仅投递提醒，不调用 AI";

  return {
    msg_type: "interactive",
    content: JSON.stringify({
      header: {
        title: { tag: "plain_text", content: "确认创建定时任务" },
        template: "blue",
      },
      elements: [
        {
          tag: "markdown",
          content: [
            `**执行时间**：${data.scheduleDesc}`,
            `**执行内容**：${data.prompt}`,
            `**投递窗口**：${data.deliveryTarget}`,
            `**执行方式**：${opencodeNote}`,
          ].join("\n"),
        },
        { tag: "hr" },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "确认创建" },
              type: "primary",
              value: { kind: "schedule-nl-confirm", pendingKey: data.pendingKey },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "取消" },
              type: "default",
              value: { kind: "schedule-nl-cancel", pendingKey: data.pendingKey },
            },
          ],
        },
      ],
    }),
  };
}
