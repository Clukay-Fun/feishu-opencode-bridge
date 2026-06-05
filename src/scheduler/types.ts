/**
 * 职责: 定义 Scheduler 核心类型。
 * 关注点:
 * - 对齐 ADR 0004 第 4 节数据模型。
 * - ScheduledJob / JobState / JobRun 三层分离。
 */
export type ScheduleKind = "once" | "interval" | "cron";

export type ScheduleExpression = {
  kind: ScheduleKind;
  expression: string;
};

export type ScheduledJob = {
  id: string;
  shortId: string;
  name: string;
  schedule: ScheduleExpression;
  taskMode?: "opencode-isolated" | "notice-only";
  prompt: string;
  chatId: string;
  conversationKey: string;
  creatorOpenId: string;
  alertChatId?: string | undefined;
  timeoutMs?: number | undefined;
  deleteAfterRun?: boolean | undefined;
  enabled: boolean;
  createdAt: number;
};

export type JobState = {
  jobId: string;
  isRunning: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  skipCount: number;
  consecutiveFailures: number;
};

export type JobRunStatus = "success" | "error" | "skipped";

export type JobRun = {
  runId: string;
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  status: JobRunStatus;
  detail?: string;
  triggerKind?: "cron" | "manual";
  silent?: boolean;
  openCodeSessionId?: string;
  deliveryMessageId?: string;
};
