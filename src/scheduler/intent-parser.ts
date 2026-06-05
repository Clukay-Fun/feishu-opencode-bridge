/**
 * 职责: 中文自然语言定时任务意图识别。
 * 关注点:
 * - 规则优先，不调 LLM
 * - 相对时间 + 绝对时间 + 周期时间
 * - 意图判定：提醒/生成类触发，问答类不触发
 * - 执行方式默认规则：提醒类=notice，生成类=opencode
 */
import type { ScheduleExpression } from "./types.js";

export type ParsedScheduleIntent = {
  schedule: ScheduleExpression;
  prompt: string;
  description: string;
  taskMode: "notice-only" | "opencode-isolated";
};

// ============================================================
// 时间词映射
// ============================================================

const HOUR_MAP: Record<string, number> = {
  "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
  "十一": 11, "十二": 12, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  "9": 9, "10": 10, "11": 11, "12": 12, "零": 0, "0": 0,
};

const WEEKDAY_MAP: Record<string, number> = {
  "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0,
};

// ============================================================
// 意图判定：哪些词暗示"提醒"，哪些暗示"生成"
// ============================================================

const NOTICE_KEYWORDS = /提醒|通知|发个|叫我|告诉|发我|喊我|记得|别忘/;
// ============================================================
// 入口
// ============================================================

export function parseScheduleIntent(input: string): ParsedScheduleIntent | null {
  const text = input.trim().replace(/\s+/g, "");
  if (!text || text.length < 6) return null;

  // 先尝试各种模式，按优先级
  const result = tryRelativeMinutes(text)
    || tryRelativeHours(text)
    || tryRelativeDays(text)
    || tryTomorrowAt(text)
    || tryDayAfterTomorrowAt(text)
    || tryTodayAt(text)
    || tryNextWeekday(text)
    || tryDailyAt(text)
    || tryDailyPm(text)
    || tryDailyNight(text)
    || tryHourly(text)
    || tryNHourly(text)
    || tryWeekly(text)
    || tryMonthly(text);

  if (!result) return null;

  // 推断执行方式
  const taskMode = guessTaskMode(result.prompt);

  return { ...result, taskMode };
}

// ============================================================
// 相对时间模式
// ============================================================

function tryRelativeMinutes(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "1分钟后发个问候给我" / "半小时后提醒我喝水"
  // Handle "半小时后" separately from "X分钟/X分后"
  let minutes: number | null = null;
  let remaining: string | null = null;

  // "半小时后..."
  const halfMatch = text.match(/^半小时后(.+)$/);
  if (halfMatch) {
    minutes = 30;
    remaining = halfMatch[1]!.trim();
  }

  // "X分钟后..." / "X分后..."
  if (!minutes) {
    const numMatch = text.match(/^(\d{1,3})(?:分钟?|分)后(.+)$/);
    if (numMatch) {
      minutes = parseInt(numMatch[1]!, 10);
      remaining = numMatch[2]!.trim();
    }
  }

  if (!minutes || minutes <= 0 || minutes > 1440 || !remaining) return null;
  const target = new Date(Date.now() + minutes * 60_000);
  return {
    schedule: { kind: "once", expression: formatIsoLocal(target) },
    prompt: remaining,
    description: `${minutes} 分钟后执行`,
  };
}

function tryRelativeHours(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "2小时后提醒我回消息"
  const match = text.match(/^(\d{1,3})小时后(.+)$/);
  if (!match) return null;
  const hours = parseInt(match[1]!, 10);
  if (!hours || hours <= 0 || hours > 720) return null;
  const target = new Date(Date.now() + hours * 3600_000);
  return {
    schedule: { kind: "once", expression: formatIsoLocal(target) },
    prompt: match[2]!.trim(),
    description: `${hours} 小时后执行`,
  };
}

function tryRelativeDays(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "3天后提醒我提交材料"
  const match = text.match(/^(\d{1,3})天后(.+)$/);
  if (!match) return null;
  const days = parseInt(match[1]!, 10);
  if (!days || days <= 0 || days > 365) return null;
  const target = new Date(Date.now() + days * 86_400_000);
  return {
    schedule: { kind: "once", expression: formatIsoLocal(target) },
    prompt: match[2]!.trim(),
    description: `${days} 天后执行`,
  };
}

// ============================================================
// 绝对日期 + 时间
// ============================================================

function tryTomorrowAt(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "明天上午9点提醒我开会"
  const match = text.match(/^明天(?:上午|早上|下午|晚上)?(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const hour = parseHourWithPeriod(match[1]!, text);
  if (hour === null) return null;
  const target = addDays(new Date(), 1);
  return {
    schedule: { kind: "once", expression: `${formatDate(target)}T${pad2(hour)}:00` },
    prompt: match[2]!.trim(),
    description: `明天 ${pad2(hour)}:00 执行`,
  };
}

function tryDayAfterTomorrowAt(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "后天上午10点提交报告"
  const match = text.match(/^后天(?:上午|早上|下午|晚上)?(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const hour = parseHourWithPeriod(match[1]!, text);
  if (hour === null) return null;
  const target = addDays(new Date(), 2);
  return {
    schedule: { kind: "once", expression: `${formatDate(target)}T${pad2(hour)}:00` },
    prompt: match[2]!.trim(),
    description: `后天 ${pad2(hour)}:00 执行`,
  };
}

function tryTodayAt(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "今天下午6点提醒我下班"
  const match = text.match(/^今天(?:上午|早上|下午|晚上)?(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const hour = parseHourWithPeriod(match[1]!, text);
  if (hour === null) return null;
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  // 如果目标时间已过，设为明天
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return {
    schedule: { kind: "once", expression: formatIsoLocal(target) },
    prompt: match[2]!.trim(),
    description: `今天 ${pad2(hour)}:00 执行`,
  };
}

function tryNextWeekday(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "下周一上午9点提醒我开会"
  const match = text.match(/^下周([一二三四五六日天])(?:上午|早上|下午|晚上)?(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const weekday = WEEKDAY_MAP[match[1]!];
  const hour = parseHourWithPeriod(match[2]!, text);
  if (weekday === undefined || hour === null) return null;
  const target = getNextWeekday(new Date(), weekday);
  return {
    schedule: { kind: "once", expression: `${formatDate(target)}T${pad2(hour)}:00` },
    prompt: match[3]!.trim(),
    description: `下周${match[1]} ${pad2(hour)}:00 执行`,
  };
}

// ============================================================
// 周期模式
// ============================================================

function tryDailyAt(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "每天上午9点生成今日简报"
  const match = text.match(/^每天(?:上午|早上|早晨)?(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const hour = parseHourWithPeriod(match[1]!, text);
  if (hour === null) return null;
  return {
    schedule: { kind: "cron", expression: `0 ${hour} * * *` },
    prompt: match[2]!.trim(),
    description: `每天 ${pad2(hour)}:00 执行`,
  };
}

function tryDailyPm(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "每天下午3点发送日报"
  const match = text.match(/^每天下午(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const rawHour = parseHour(match[1]!);
  if (rawHour === null || rawHour >= 12) return null;
  return {
    schedule: { kind: "cron", expression: `0 ${rawHour + 12} * * *` },
    prompt: match[2]!.trim(),
    description: `每天 ${pad2(rawHour + 12)}:00 执行`,
  };
}

function tryDailyNight(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "每天晚上8点提醒下班"
  const match = text.match(/^每天晚上(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const rawHour = parseHour(match[1]!);
  if (rawHour === null || rawHour >= 12) return null;
  return {
    schedule: { kind: "cron", expression: `0 ${rawHour + 12} * * *` },
    prompt: match[2]!.trim(),
    description: `每天 ${pad2(rawHour + 12)}:00 执行`,
  };
}

function tryHourly(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "每小时检查项目状态"
  const match = text.match(/^每小时(.+)$/);
  if (!match) return null;
  return {
    schedule: { kind: "interval", expression: "1h" },
    prompt: match[1]!.trim(),
    description: "每 1 小时执行",
  };
}

function tryNHourly(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "每2小时检查服务器状态"
  const match = text.match(/^每(\d{1,2}|[一二三四五六七八九十]+)小时(.+)$/);
  if (!match) return null;
  const n = parseHour(match[1]!);
  if (n === null || n <= 0) return null;
  return {
    schedule: { kind: "interval", expression: `${n}h` },
    prompt: match[2]!.trim(),
    description: `每 ${n} 小时执行`,
  };
}

function tryWeekly(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "每周一上午9点总结上周工作"
  const match = text.match(/^每周([一二三四五六日天])(?:上午|早上|下午|晚上)?(\d{1,2}|[一二三四五六七八九十]+)点(.+)$/);
  if (!match) return null;
  const weekday = WEEKDAY_MAP[match[1]!];
  const hour = parseHourWithPeriod(match[2]!, text);
  if (weekday === undefined || hour === null) return null;
  return {
    schedule: { kind: "cron", expression: `0 ${hour} * * ${weekday}` },
    prompt: match[3]!.trim(),
    description: `每周${match[1]} ${pad2(hour)}:00 执行`,
  };
}

function tryMonthly(text: string): Omit<ParsedScheduleIntent, "taskMode"> | null {
  // "每月1号9点生成月度报告"
  const match = text.match(/^每月(\d{1,2})[号日](?:上午|早上|下午|晚上)?(\d{1,2})点(.+)$/);
  if (!match) return null;
  const day = parseInt(match[1]!, 10);
  const hour = parseHourWithPeriod(match[2]!, text);
  if (day < 1 || day > 31 || hour === null) return null;
  return {
    schedule: { kind: "cron", expression: `0 ${hour} ${day} * *` },
    prompt: match[3]!.trim(),
    description: `每月 ${day} 号 ${pad2(hour)}:00 执行`,
  };
}

// ============================================================
// 执行方式推断
// ============================================================

function guessTaskMode(prompt: string): "notice-only" | "opencode-isolated" {
  if (NOTICE_KEYWORDS.test(prompt)) return "notice-only";
  return "opencode-isolated";
}

// ============================================================
// 工具函数
// ============================================================

function parseHour(text: string): number | null {
  const direct = HOUR_MAP[text];
  if (direct !== undefined) return direct;
  const num = parseInt(text, 10);
  if (!isNaN(num) && num >= 0 && num <= 23) return num;
  return null;
}

function parseHourWithPeriod(text: string, fullText: string): number | null {
  const hour = parseHour(text);
  if (hour === null) return null;
  if (/下午|晚上/.test(fullText) && hour < 12) return hour + 12;
  return hour;
}

function formatIsoLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getNextWeekday(from: Date, weekday: number): Date {
  const d = new Date(from);
  const diff = (weekday - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}
