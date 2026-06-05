/**
 * 职责: 实现 /schedule 子命令逻辑。
 * 关注点:
 * - 结构化 input only（不做 NL 解析）
 * - 短 ID 作为 user-facing 标识
 * - 创建者权限主权
 * - delete 二次确认
 * - anti-recursion 检查
 * - 自动识别表达式类型（新语法）
 * - 保留旧语法兼容
 */
import type { Logger } from "../logging/logger.js";
import { randomUUID } from "node:crypto";
import { parseScheduleExpression } from "./parser.js";
import { parseScheduleIntent } from "./intent-parser.js";
import { buildScheduleConfirmNlCardPayload } from "../feishu/scheduler-cards.js";
import type { JobStore } from "./store.js";
import type { ScheduleExpression, ScheduledJob } from "./types.js";
import { getScheduledRunContext } from "./context.js";

export type ScheduleCommandResult = {
  ok: boolean;
  message: string;
  card?: "list" | "show" | "confirm" | "runs" | "notice";
  data?: unknown;
};

export type SchedulerCommandRuntimePort = {
  getStore(): JobStore;
  addJob(job: Omit<ScheduledJob, "id" | "shortId">): Promise<ScheduledJob>;
  pauseJob(id: string): Promise<boolean>;
  resumeJob(id: string): Promise<boolean>;
  removeJob(id: string): Promise<boolean>;
  triggerJobNow(id: string): Promise<{ success: boolean; detail?: string }>;
};

export class ScheduleCommands {
  constructor(
    private readonly runtime: SchedulerCommandRuntimePort,
    private readonly logger: Logger,
  ) {}

  async handleAdd(
    senderOpenId: string,
    chatId: string,
    conversationKey: string,
    args: string[],
    options: { scheduledRun?: boolean } = {},
  ): Promise<ScheduleCommandResult> {
    if (options.scheduledRun || getScheduledRunContext()?.kind === "scheduled-run") {
      this.logger.log("scheduler", "scheduled run context rejected /schedule add", { senderOpenId, conversationKey }, "warn");
      return { ok: false, message: "定时任务执行过程中不能创建新的定时任务，避免递归触发。" };
    }

    // 参数不足直接返回帮助
    if (args.length < 2) {
      return { ok: false, message: this.buildAddHelpMessage() };
    }

    // 自动识别：如果第一个参数是 cron|interval|at，走旧语法；否则当表达式
    let scheduleArgs: string[];
    let promptParts: string[];

    const firstArg = args[0]!.replace(/^["']|["']$/g, "");
    if (args.length >= 3 && /^(cron|interval|at)$/i.test(firstArg)) {
      // 旧语法：/schedule add cron "0 9 * * *" "prompt"
      const rawExpr = args[1]!.replace(/^["']|["']$/g, "");
      scheduleArgs = [firstArg.toLowerCase() === "at" ? `at ${rawExpr}` : rawExpr];
      promptParts = args.slice(2);
    } else {
      // 新语法：自动识别表达式类型
      const rawExpr = firstArg;
      // ISO 日期时间自动补 at 前缀
      const expr = /^\d{4}-\d{2}-\d{2}T/.test(rawExpr) ? `at ${rawExpr}` : rawExpr;
      scheduleArgs = [expr];
      promptParts = args.slice(1);
    }

    const expression = scheduleArgs[0]!;
    const prompt = promptParts.join(" ").trim().replace(/^["']|["']$/g, "");

    if (!expression || !prompt) {
      return { ok: false, message: this.buildAddHelpMessage() };
    }

    let schedule;
    try {
      const expr = expression.replace(/^["']|["']$/g, "");
      schedule = parseScheduleExpression(expr);
    } catch (error) {
      return {
        ok: false,
        message: `表达式解析失败：${error instanceof Error ? error.message : String(error)}\n\n` + this.buildAddHelpMessage(),
      };
    }

    try {
      const job = await this.runtime.addJob({
        name: prompt.slice(0, 50),
        schedule,
        taskMode: resolveTaskMode(prompt),
        prompt: stripTaskModePrefix(prompt),
        chatId,
        conversationKey,
        creatorOpenId: senderOpenId,
        alertChatId: chatId,
        enabled: true,
        createdAt: Date.now(),
      });

      const scheduleDesc = schedule.kind === "cron" ? `cron: ${schedule.expression}`
        : schedule.kind === "interval" ? `每 ${schedule.expression}`
        : `一次性: ${schedule.expression}`;

      return {
        ok: true,
        message: `定时任务已创建\n- ID：${job.shortId}\n- 调度：${scheduleDesc}\n- 提示词：${prompt}`,
        card: "notice",
        data: { job, action: "created" },
      };
    } catch (error) {
      return { ok: false, message: `创建失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async handleList(senderOpenId: string, args: string[]): Promise<ScheduleCommandResult> {
    const showAll = args[0] === "all";
    const store = this.runtime.getStore();
    const jobs = store.getJobs();
    const filtered = showAll ? jobs : jobs.filter((j) => j.creatorOpenId === senderOpenId);

    if (filtered.length === 0) {
      return {
        ok: true,
        message: showAll ? "当前没有定时任务。" : "你还没有创建定时任务。\n\n直接发送自然语言即可创建，例如：`1分钟后发个问候给我`。",
        card: "list",
        data: { jobs: [], showAll },
      };
    }

    return {
      ok: true,
      message: `共 ${filtered.length} 个定时任务`,
      card: "list",
      data: { jobs: filtered, states: store.getStates(), showAll },
    };
  }

  async handleShow(senderOpenId: string, args: string[]): Promise<ScheduleCommandResult> {
    const shortId = args[0];
    if (!shortId) return { ok: false, message: "用法：`/cron show <任务ID>`" };

    const store = this.runtime.getStore();
    const job = store.getJobs().find((j) => j.shortId === shortId);
    if (!job) return { ok: false, message: `找不到任务 ${shortId}。使用 \`/cron list\` 查看所有任务。` };

    const state = store.getState(job.id);
    const runs = await store.getRuns(job.id, 5);

    return { ok: true, message: `任务详情：${shortId}`, card: "show", data: { job, state, runs } };
  }

  async handlePause(senderOpenId: string, args: string[]): Promise<ScheduleCommandResult> {
    return this.handleAction("pause", senderOpenId, args);
  }

  async handleResume(senderOpenId: string, args: string[]): Promise<ScheduleCommandResult> {
    return this.handleAction("resume", senderOpenId, args);
  }

  async handleRun(senderOpenId: string, args: string[]): Promise<ScheduleCommandResult> {
    return this.handleAction("run", senderOpenId, args);
  }

  async handleDelete(senderOpenId: string, args: string[]): Promise<ScheduleCommandResult> {
    const shortId = args[0];
    if (!shortId) return { ok: false, message: "用法：`/cron delete <任务ID>`" };

    const store = this.runtime.getStore();
    const job = store.getJobs().find((j) => j.shortId === shortId);
    if (!job) return { ok: false, message: `找不到任务 ${shortId}。` };
    if (job.creatorOpenId !== senderOpenId) return { ok: false, message: "只有任务创建者才能删除该任务。" };

    return { ok: true, message: `确认删除任务 ${shortId}？`, card: "confirm", data: { job, action: "delete" } };
  }

  async handleDeleteConfirm(senderOpenId: string, shortId: string): Promise<ScheduleCommandResult> {
    const store = this.runtime.getStore();
    const job = store.getJobs().find((j) => j.shortId === shortId);
    if (!job) return { ok: false, message: `找不到任务 ${shortId}。` };
    if (job.creatorOpenId !== senderOpenId) return { ok: false, message: "只有任务创建者才能删除该任务。" };

    await this.runtime.removeJob(job.id);
    return { ok: true, message: `任务 ${shortId} 已删除。`, card: "notice", data: { job, action: "deleted" } };
  }

  async handleRuns(senderOpenId: string, args: string[]): Promise<ScheduleCommandResult> {
    const shortId = args[0];
    if (!shortId) return { ok: false, message: "用法：`/cron runs <任务ID>`" };

    const store = this.runtime.getStore();
    const job = store.getJobs().find((j) => j.shortId === shortId);
    if (!job) return { ok: false, message: `找不到任务 ${shortId}。` };

    const runs = await store.getRuns(job.id, 20);
    return { ok: true, message: `任务 ${shortId} 的执行记录`, card: "runs", data: { job, runs } };
  }

  async handleHelp(): Promise<ScheduleCommandResult> {
    return { ok: true, message: this.buildHelpMessage() };
  }

  async handleNlCreate(
    senderOpenId: string,
    chatId: string,
    conversationKey: string,
    input: string,
    replyMessageId: string,
  ): Promise<ScheduleCommandResult & { payload?: unknown }> {
    const intent = parseScheduleIntent(input);
    if (!intent) {
      return {
        ok: false,
        message: "无法识别定时任务描述。请使用更具体的格式，例如：\n- `1分钟后发个问候给我`\n- `每天上午9点生成今日简报`\n- `明天下午6点提醒我准备会议`",
      };
    }

    const pendingKey = randomUUID();
    this.pendingNlConfirmations.set(pendingKey, {
      creatorOpenId: senderOpenId,
      schedule: intent.schedule,
      prompt: intent.prompt,
      taskMode: intent.taskMode,
      chatId,
      conversationKey,
      replyMessageId,
    });

    const payload = buildScheduleConfirmNlCardPayload({
      pendingKey,
      scheduleDesc: intent.description,
      prompt: intent.prompt,
      deliveryTarget: "当前窗口",
      useOpenCode: intent.taskMode === "opencode-isolated",
    });

    return {
      ok: true,
      message: "请确认定时任务信息",
      payload,
    };
  }

  async handleNlConfirm(senderOpenId: string, pendingKey: string): Promise<ScheduleCommandResult> {
    const pending = this.pendingNlConfirmations.get(pendingKey);
    if (!pending) {
      return { ok: false, message: "没有待确认的定时任务。请先直接发送自然语言创建。" };
    }
    if (pending.creatorOpenId !== senderOpenId) {
      return { ok: false, message: "只有任务创建者才能确认该定时任务。" };
    }
    this.pendingNlConfirmations.delete(pendingKey);

    try {
      const prompt = stripTaskModePrefix(pending.prompt);
      const job = await this.runtime.addJob({
        name: prompt.slice(0, 50),
        schedule: pending.schedule,
        taskMode: pending.taskMode,
        prompt,
        chatId: pending.chatId,
        conversationKey: pending.conversationKey,
        creatorOpenId: senderOpenId,
        alertChatId: pending.chatId,
        enabled: true,
        createdAt: Date.now(),
      });

      const scheduleDesc = pending.schedule.kind === "cron" ? `cron: ${pending.schedule.expression}`
        : pending.schedule.kind === "interval" ? `每 ${pending.schedule.expression}`
        : `一次性: ${pending.schedule.expression}`;

      return {
        ok: true,
        message: `定时任务已创建\n- ID：${job.shortId}\n- 调度：${scheduleDesc}\n- 提示词：${prompt}`,
        card: "notice",
        data: { job, action: "created" },
      };
    } catch (error) {
      return { ok: false, message: `创建失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async handleNlCancel(senderOpenId: string, pendingKey: string): Promise<ScheduleCommandResult> {
    const pending = this.pendingNlConfirmations.get(pendingKey);
    if (pending && pending.creatorOpenId !== senderOpenId) {
      return { ok: false, message: "只有任务创建者才能取消该定时任务。" };
    }
    this.pendingNlConfirmations.delete(pendingKey);
    return { ok: true, message: "已取消定时任务创建。" };
  }

  private pendingNlConfirmations = new Map<string, {
    creatorOpenId: string;
    schedule: ScheduleExpression;
    prompt: string;
    taskMode: NonNullable<ScheduledJob["taskMode"]>;
    chatId: string;
    conversationKey: string;
    replyMessageId: string;
  }>();

  private async handleAction(
    action: "pause" | "resume" | "run",
    senderOpenId: string,
    args: string[],
  ): Promise<ScheduleCommandResult> {
    const shortId = args[0];
    if (!shortId) return { ok: false, message: `用法：\`/cron ${action} <任务ID>\`` };

    const store = this.runtime.getStore();
    const job = store.getJobs().find((j) => j.shortId === shortId);
    if (!job) return { ok: false, message: `找不到任务 ${shortId}。` };
    if (job.creatorOpenId !== senderOpenId) return { ok: false, message: "只有任务创建者才能执行此操作。" };

    switch (action) {
      case "pause": {
        const ok = await this.runtime.pauseJob(job.id);
        return ok ? { ok: true, message: `任务 ${shortId} 已暂停。` } : { ok: false, message: "操作失败。" };
      }
      case "resume": {
        const ok = await this.runtime.resumeJob(job.id);
        return ok ? { ok: true, message: `任务 ${shortId} 已恢复。` } : { ok: false, message: "操作失败。" };
      }
      case "run": {
        const result = await this.runtime.triggerJobNow(job.id);
        return result.success
          ? { ok: true, message: `任务 ${shortId} 已触发手动执行。`, card: "notice", data: { job, action: "triggered" } }
          : { ok: false, message: result.detail ?? "触发失败。" };
      }
      default:
        return { ok: false, message: "未知操作。" };
    }
  }

  private buildHelpMessage(): string {
    return [
      "**定时任务**",
      "",
      "直接发送自然语言即可创建，无需命令：",
      "```",
      "1分钟后发个问候给我",
      "明天上午9点提醒我开会",
      "每天早上9点生成今日简报",
      "每周五下午5点总结本周工作",
      "```",
      "",
      "**管理**",
      "- `/cron list` — 查看任务",
      "- `/cron show <ID>` — 查看详情",
      "- `/cron pause <ID>` — 暂停",
      "- `/cron resume <ID>` — 恢复",
      "- `/cron run <ID>` — 立即执行",
      "- `/cron delete <ID>` — 删除",
      "- `/cron runs <ID>` — 执行记录",
    ].join("\n");
  }

  private buildAddHelpMessage(): string {
    return [
      "直接发送自然语言即可创建定时任务，例如：",
      "- `1分钟后发个问候给我`",
      "- `明天上午9点提醒我开会`",
      "- `每天早上9点生成今日简报`",
      "- `每周五下午5点总结本周工作`",
      "",
      "管理任务请使用 `/cron list` 等命令。",
    ].join("\n");
  }
}

function resolveTaskMode(prompt: string): NonNullable<ScheduledJob["taskMode"]> {
  return prompt.trimStart().startsWith("[NOTICE]") ? "notice-only" : "opencode-isolated";
}

function stripTaskModePrefix(prompt: string): string {
  return prompt.trimStart().startsWith("[NOTICE]")
    ? prompt.trimStart().slice("[NOTICE]".length).trimStart()
    : prompt;
}
