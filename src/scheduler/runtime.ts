/**
 * 职责: Scheduler 运行时，用 node-cron 注册 cron 任务。
 * 关注点:
 * - start(onTrigger) / stop()
 * - addJob / pauseJob / resumeJob / removeJob / triggerJobNow
 * - 重启不补跑（missed-due-to-restart）
 * - 单 job 不重入（isRunning 锁）
 * - maxConcurrentRuns 限制 cron 触发，triggerJobNow 不受限
 */
import cron from "node-cron";

import type { Logger } from "../logging/logger.js";
import type { ScheduledJob, JobRun } from "./types.js";
import { computeNextRunTime } from "./parser.js";
import { JobStore } from "./store.js";

export type SchedulerRuntimeConfig = {
  dataDir: string;
  maxConcurrentRuns?: number;
};

export type TriggerHandler = (
  job: ScheduledJob,
  context: { triggerKind: "cron" | "manual" },
) => Promise<{
  status: "success" | "error";
  detail?: string;
  silent?: boolean;
  openCodeSessionId?: string;
  deliveryMessageId?: string;
}>;

const MAX_RUNNING_COUNT_DEFAULT = 1;

export class SchedulerRuntime {
  private readonly store: JobStore;
  private readonly tasks = new Map<string, cron.ScheduledTask>();
  private readonly maxConcurrentRuns: number;
  private runningCount = 0;
  private started = false;
  private onTrigger: TriggerHandler | null = null;

  constructor(
    config: SchedulerRuntimeConfig,
    private readonly logger: Logger,
  ) {
    this.store = new JobStore(config.dataDir);
    this.maxConcurrentRuns = config.maxConcurrentRuns ?? MAX_RUNNING_COUNT_DEFAULT;
  }

  async start(onTrigger: TriggerHandler): Promise<void> {
    await this.store.load();
    this.onTrigger = onTrigger;
    this.started = true;

    const jobs = this.store.getJobs();
    const now = Date.now();

    for (const job of jobs) {
      if (!job.enabled) continue;
      const state = this.store.getState(job.id);
      if (state?.isRunning) {
        await this.store.setState(job.id, { isRunning: false });
      }

      const nextRun = computeNextRunTime(job.schedule, now);
      if (nextRun === null) {
        if (job.schedule.kind === "once") {
          await this.store.setState(job.id, { skipCount: (state?.skipCount ?? 0) + 1 });
          await this.store.appendRun(job.id, {
            runId: crypto.randomUUID(),
            jobId: job.id,
            startedAt: now,
            finishedAt: now,
            status: "skipped",
            detail: "missed-due-to-restart",
            triggerKind: "cron",
          });
          await this.store.updateJob(job.id, { enabled: false });
          this.logger.log("scheduler", "过期 once job 跳过", { jobId: job.id, shortId: job.shortId });
        }
        continue;
      }

      // 一次性任务：如果触发时间在当前分钟内，直接注册一次触发；否则按常规 cron 注册
      if (job.schedule.kind === "once") {
        const triggerAt = nextRun - now;
        if (triggerAt <= 60_000) {
          await this.store.setState(job.id, { nextRunAt: nextRun });
          this.scheduleOnceTrigger(job, triggerAt);
          continue;
        }
      }

      await this.store.setState(job.id, { nextRunAt: nextRun });
      this.registerCronJob(job);
    }

    this.logger.log("scheduler", "Scheduler 启动", { jobCount: this.tasks.size });
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const [id, task] of this.tasks) {
      task.stop();
      this.logger.log("scheduler", "cron stopped", { jobId: id });
    }
    this.tasks.clear();
    this.logger.log("scheduler", "Scheduler 已停止");
  }

  async addJob(job: Omit<ScheduledJob, "id" | "shortId">): Promise<ScheduledJob> {
    const created = await this.store.addJob(job);
    if (created.enabled) {
      const nextRun = computeNextRunTime(created.schedule);
      if (nextRun) {
        await this.store.setState(created.id, { nextRunAt: nextRun });
        if (created.schedule.kind === "once" && nextRun - Date.now() <= 60_000) {
          this.scheduleOnceTrigger(created, nextRun - Date.now());
        } else {
          this.registerCronJob(created);
        }
      }
    }
    return created;
  }

  async pauseJob(id: string): Promise<boolean> {
    const ok = await this.store.updateJob(id, { enabled: false });
    if (ok) {
      const task = this.tasks.get(id);
      if (task) {
        task.stop();
        this.tasks.delete(id);
      }
      await this.store.setState(id, { nextRunAt: null });
    }
    return ok;
  }

  async resumeJob(id: string): Promise<boolean> {
    const job = this.store.getJob(id);
    if (!job) return false;
    await this.store.updateJob(id, { enabled: true });
    const nextRun = computeNextRunTime(job.schedule);
    if (nextRun) {
      await this.store.setState(id, { nextRunAt: nextRun });
      this.registerCronJob(job);
    }
    return true;
  }

  async removeJob(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    return this.store.removeJob(id);
  }

  async triggerJobNow(id: string): Promise<{ success: boolean; detail?: string }> {
    const job = this.store.getJob(id);
    if (!job) return { success: false, detail: "任务不存在" };

    const state = this.store.getState(id);
    if (state?.isRunning) {
      await this.store.appendRun(id, {
        runId: crypto.randomUUID(),
        jobId: id,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "skipped",
        detail: "任务正在执行中",
        triggerKind: "manual",
      });
      return { success: false, detail: "任务正在执行中" };
    }

    await this.executeJob(job, true);
    return { success: true };
  }

  getStore(): JobStore {
    return this.store;
  }

  private registerCronJob(job: ScheduledJob): void {
    const cronExpr = this.toCronExpression(job);
    if (!cronExpr || !cron.validate(cronExpr)) {
      this.logger.log("scheduler", "无效 cron 表达式，跳过注册", { jobId: job.id, schedule: job.schedule });
      return;
    }

    const task = cron.schedule(cronExpr, () => {
      this.onCronTrigger(job.id);
    });

    this.tasks.set(job.id, task);
    this.logger.log("scheduler", "cron 已注册", { jobId: job.id, shortId: job.shortId, cron: cronExpr });
  }

  private async onCronTrigger(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job || !job.enabled) return;

    const state = this.store.getState(jobId);
    if (state?.isRunning) {
      await this.store.appendRun(jobId, {
        runId: crypto.randomUUID(),
        jobId,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "skipped",
        detail: "already-running",
        triggerKind: "cron",
      });
      await this.store.setState(jobId, { skipCount: (state?.skipCount ?? 0) + 1 });
      return;
    }

    if (this.runningCount >= this.maxConcurrentRuns) {
      await this.store.appendRun(jobId, {
        runId: crypto.randomUUID(),
        jobId,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "skipped",
        detail: "max-concurrent-reached",
        triggerKind: "cron",
      });
      await this.store.setState(jobId, { skipCount: (state?.skipCount ?? 0) + 1 });
      return;
    }

    await this.executeJob(job, false);
  }

  private async executeJob(job: ScheduledJob, isManual: boolean): Promise<void> {
    const startTime = Date.now();
    await this.store.setState(job.id, { isRunning: true, lastRunAt: startTime });
    if (!isManual) this.runningCount++;

    const run: JobRun = {
      runId: crypto.randomUUID(),
      jobId: job.id,
      startedAt: startTime,
      finishedAt: null,
      status: "success",
      triggerKind: isManual ? "manual" : "cron",
    };

    try {
      if (!this.onTrigger) throw new Error("Scheduler 未启动");
      const result = await this.onTrigger(job, { triggerKind: isManual ? "manual" : "cron" });
      run.status = result.status;
      if (result.detail !== undefined) run.detail = result.detail;
      if (result.silent !== undefined) run.silent = result.silent;
      if (result.openCodeSessionId !== undefined) run.openCodeSessionId = result.openCodeSessionId;
      if (result.deliveryMessageId !== undefined) run.deliveryMessageId = result.deliveryMessageId;
      await this.store.setState(job.id, { runCount: (this.store.getState(job.id)?.runCount ?? 0) + 1 });
    } catch (error) {
      run.status = "error";
      run.detail = error instanceof Error ? error.message : String(error);
    } finally {
      run.finishedAt = Date.now();
      await this.store.setState(job.id, { isRunning: false });
      await this.store.appendRun(job.id, run);
      if (!isManual) this.runningCount--;

      const nextRun = computeNextRunTime(job.schedule);
      if (nextRun) {
        await this.store.setState(job.id, { nextRunAt: nextRun });
      } else if (job.schedule.kind === "once") {
        await this.store.updateJob(job.id, { enabled: false });
        this.unregisterCronJob(job.id);
      }

      this.logger.log("scheduler", `job ${run.status}`, {
        jobId: job.id,
        shortId: job.shortId,
        status: run.status,
        elapsedMs: run.finishedAt! - run.startedAt,
      });
    }
  }

  private unregisterCronJob(jobId: string): void {
    const task = this.tasks.get(jobId);
    if (task) {
      task.stop();
      this.tasks.delete(jobId);
    }
  }

  private scheduleOnceTrigger(job: ScheduledJob, delayMs: number): void {
    const safeDelay = Math.max(0, delayMs);
    const timer = setTimeout(() => {
      this.onCronTrigger(job.id);
      this.tasks.delete(job.id);
    }, safeDelay);
    this.tasks.set(job.id, { stop: () => clearTimeout(timer) } as unknown as cron.ScheduledTask);
    this.logger.log("scheduler", "一次性任务已注册", { jobId: job.id, shortId: job.shortId, delayMs: safeDelay });
  }

  private toCronExpression(job: ScheduledJob): string | null {
    const { schedule } = job;
    switch (schedule.kind) {
      case "cron":
        return schedule.expression;
      case "interval": {
        const match = schedule.expression.match(/^(\d+)([a-z]+)$/i);
        if (!match) return null;
        const amount = parseInt(match[1]!, 10);
        const unit = match[2]!.toLowerCase();
        if (unit === "m" || unit === "min") return `*/${amount} * * * *`;
        if (unit === "h" || unit === "hr" || unit === "hour") return `0 */${amount} * * *`;
        if (unit === "d" || unit === "day") return `0 0 */${amount} * *`;
        if (unit === "w" || unit === "week") return `0 0 * * 0`;
        return null;
      }
      case "once": {
        const date = new Date(schedule.expression);
        if (isNaN(date.getTime())) return null;
        const min = date.getMinutes();
        const hr = date.getHours();
        const day = date.getDate();
        const mon = date.getMonth() + 1;
        return `${min} ${hr} ${day} ${mon} *`;
      }
    }
  }
}
