/**
 * 职责: 解析 schedule 表达式。
 * 关注点:
 * - 支持三种格式: at(一次性) / interval(周期) / cron(5字段)
 * - 无效输入抛带描述的错
 */
import cron from "node-cron";

import type { ScheduleExpression } from "./types.js";

const INTERVAL_REGEX = /^every\s+(\d+)\s*(m|min|h|hr|hour|d|day|w|week)s?$/i;
const AT_REGEX = /^at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)$/i;
const CRON_REGEX = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)$/;

const INTERVAL_MULTIPLIERS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
};

export function parseScheduleExpression(input: string): ScheduleExpression {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("schedule 表达式不能为空");
  }

  const atMatch = trimmed.match(AT_REGEX);
  if (atMatch) {
    const date = new Date(atMatch[1]!);
    if (isNaN(date.getTime())) {
      throw new Error(`无效的日期: ${atMatch[1]}`);
    }
    if (date.getTime() <= Date.now()) {
      throw new Error(`一次性任务的时间必须在未来: ${atMatch[1]}`);
    }
    return { kind: "once", expression: atMatch[1]! };
  }

  const intervalMatch = trimmed.match(INTERVAL_REGEX);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1]!, 10);
    if (amount <= 0) {
      throw new Error("间隔必须大于 0");
    }
    const unit = intervalMatch[2]!.toLowerCase();
    const multiplier = INTERVAL_MULTIPLIERS[unit];
    if (!multiplier) {
      throw new Error(`不支持的时间单位: ${unit}`);
    }
    if ((unit === "m" || unit === "min") && amount > 59) {
      throw new Error("分钟间隔必须在 1-59 之间");
    }
    if ((unit === "h" || unit === "hr" || unit === "hour") && amount > 23) {
      throw new Error("小时间隔必须在 1-23 之间");
    }
    if ((unit === "w" || unit === "week") && amount !== 1) {
      throw new Error("当前仅支持 every 1w");
    }
    const ms = amount * multiplier;
    if (ms < 60_000) {
      throw new Error("间隔不能小于 1 分钟");
    }
    return { kind: "interval", expression: `${amount}${unit}` };
  }

  const cronMatch = trimmed.match(CRON_REGEX);
  if (cronMatch) {
    const parts = trimmed.split(/\s+/);
    if (parts.length === 5 && cron.validate(trimmed)) {
      return { kind: "cron", expression: trimmed };
    }
    throw new Error(`无效的 cron 表达式: "${trimmed}"`);
  }

  throw new Error(`无法解析 schedule 表达式: "${trimmed}"。支持格式: at 2026-06-05T09:00 / every 1h / 0 9 * * *`);
}

export function computeNextRunTime(schedule: ScheduleExpression, from: number = Date.now()): number | null {
  switch (schedule.kind) {
    case "once": {
      const t = new Date(schedule.expression).getTime();
      return t > from ? t : null;
    }
    case "interval": {
      const match = schedule.expression.match(/^(\d+)([a-z]+)$/i);
      if (!match) return null;
      const amount = parseInt(match[1]!, 10);
      const unit = match[2]!.toLowerCase();
      const ms = amount * (INTERVAL_MULTIPLIERS[unit] ?? 0);
      return ms > 0 ? from + ms : null;
    }
    case "cron": {
      return computeNextCronRun(schedule.expression, from);
    }
  }
}

function computeNextCronRun(expr: string, from: number): number | null {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const date = new Date(from + 60_000);
  date.setSeconds(0);
  date.setMilliseconds(0);

  for (let attempts = 0; attempts < 366 * 24 * 60; attempts++) {
    if (matchesCronField(minute!, date.getMinutes()) &&
        matchesCronField(hour!, date.getHours()) &&
        matchesCronField(dayOfMonth!, date.getDate()) &&
        matchesCronField(month!, date.getMonth() + 1) &&
        matchesCronField(dayOfWeek!, date.getDay())) {
      return date.getTime();
    }
    date.setMinutes(date.getMinutes() + 1);
  }
  return null;
}

function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.includes(",")) {
    return field.split(",").some((part) => matchesCronField(part.trim(), value));
  }
  if (field.includes("/")) {
    const [range, step] = field.split("/");
    const stepNum = parseInt(step!, 10);
    if (isNaN(stepNum) || stepNum <= 0) return false;
    if (range === "*") return value % stepNum === 0;
    const [min, max] = range!.split("-").map(Number);
    return value >= min! && value <= max! && (value - min!) % stepNum === 0;
  }
  if (field.includes("-")) {
    const [min, max] = field.split("-").map(Number);
    return value >= min! && value <= max!;
  }
  return parseInt(field, 10) === value;
}
