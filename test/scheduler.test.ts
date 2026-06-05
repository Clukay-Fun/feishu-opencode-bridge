/**
 * 职责: 覆盖 Scheduler 核心功能。
 * 关注点: parser 三种表达式、JobStore 持久化、Runtime 重启不补跑/不重入。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseScheduleExpression, computeNextRunTime } from "../src/scheduler/parser.js";
import { JobStore } from "../src/scheduler/store.js";
import { SchedulerRuntime } from "../src/scheduler/runtime.js";

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

describe("parseScheduleExpression", () => {
  it("parses at (once) expression", () => {
    const result = parseScheduleExpression("at 2026-12-31T09:00:00");
    expect(result.kind).toBe("once");
    expect(result.expression).toBe("2026-12-31T09:00:00");
  });

  it("parses interval expression", () => {
    expect(parseScheduleExpression("every 1h").kind).toBe("interval");
    expect(parseScheduleExpression("every 30m").kind).toBe("interval");
    expect(parseScheduleExpression("every 2d").kind).toBe("interval");
    expect(parseScheduleExpression("every 1w").kind).toBe("interval");
  });

  it("parses cron expression", () => {
    const result = parseScheduleExpression("0 9 * * *");
    expect(result.kind).toBe("cron");
    expect(result.expression).toBe("0 9 * * *");
  });

  it("rejects empty input", () => {
    expect(() => parseScheduleExpression("")).toThrow("不能为空");
  });

  it("rejects past date for once", () => {
    expect(() => parseScheduleExpression("at 2020-01-01T00:00:00")).toThrow("未来");
  });

  it("rejects interval < 1 minute", () => {
    expect(() => parseScheduleExpression("every 30s")).toThrow("无法解析");
  });

  it("rejects invalid cron", () => {
    expect(() => parseScheduleExpression("not-a-cron")).toThrow("无法解析");
    expect(() => parseScheduleExpression("99 99 * * *")).toThrow("无效的 cron 表达式");
  });

  it("rejects intervals that cannot be registered by the runtime", () => {
    expect(() => parseScheduleExpression("every 90m")).toThrow("分钟间隔");
    expect(() => parseScheduleExpression("every 25h")).toThrow("小时间隔");
    expect(() => parseScheduleExpression("every 2w")).toThrow("every 1w");
  });
});

describe("computeNextRunTime", () => {
  it("computes next run for once", () => {
    const future = new Date(Date.now() + 300_000).toISOString();
    const result = computeNextRunTime({ kind: "once", expression: future });
    expect(result).toBeGreaterThan(Date.now());
  });

  it("returns null for past once", () => {
    expect(computeNextRunTime({ kind: "once", expression: "2020-01-01T00:00:00" })).toBeNull();
  });

  it("computes next run for interval", () => {
    const result = computeNextRunTime({ kind: "interval", expression: "1h" });
    expect(result).toBeGreaterThan(Date.now());
  });

  it("computes next run for cron", () => {
    const result = computeNextRunTime({ kind: "cron", expression: "0 9 * * *" });
    expect(result).toBeGreaterThan(Date.now());
  });
});

describe("JobStore", () => {
  it("persists jobs and states across load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-store-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job = await store.addJob({
        name: "测试任务",
        schedule: { kind: "cron", expression: "0 9 * * *" },
        prompt: "发送测试",
        chatId: "chat-1",
        conversationKey: "conv-1",
        creatorOpenId: "ou_user",
        enabled: true,
        createdAt: Date.now(),
      });

      expect(job.shortId).toBe("sched-001");
      expect(job.id).toBeDefined();

      const store2 = new JobStore(dir);
      await store2.load();
      const loaded = store2.getJob(job.id);
      expect(loaded?.name).toBe("测试任务");
      expect(loaded?.shortId).toBe("sched-001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("increments short ID across saves", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-id-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job1 = await store.addJob({ name: "A", schedule: { kind: "cron", expression: "0 9 * * *" }, prompt: "p1", chatId: "c1", conversationKey: "k1", creatorOpenId: "u1", enabled: true, createdAt: Date.now() });
      const job2 = await store.addJob({ name: "B", schedule: { kind: "cron", expression: "0 9 * * *" }, prompt: "p2", chatId: "c1", conversationKey: "k1", creatorOpenId: "u1", enabled: true, createdAt: Date.now() });
      expect(job1.shortId).toBe("sched-001");
      expect(job2.shortId).toBe("sched-002");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appendRun writes to jsonl file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-run-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job = await store.addJob({ name: "test", schedule: { kind: "cron", expression: "0 9 * * *" }, prompt: "p", chatId: "c", conversationKey: "k", creatorOpenId: "u", enabled: true, createdAt: Date.now() });
      await store.appendRun(job.id, { runId: "r1", jobId: job.id, startedAt: Date.now(), finishedAt: Date.now(), status: "success" });
      const runs = await store.getRuns(job.id);
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("success");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SchedulerRuntime", () => {
  it("does not re-trigger running jobs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-noreentry-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job = await store.addJob({
        name: "阻塞任务",
        schedule: { kind: "cron", expression: "* * * * *" },
        prompt: "test",
        chatId: "chat-1",
        conversationKey: "conv-1",
        creatorOpenId: "ou_user",
        enabled: true,
        createdAt: Date.now(),
      });

      const runtime = new SchedulerRuntime({ dataDir: dir }, silentLogger as never);
      const trigger = vi.fn();
      await runtime.start(trigger);

      // start() 会重置 isRunning，所以在 start() 之后再设置
      // 必须通过 runtime 的 store 设置，因为 runtime 有自己的 store 实例
      await runtime.getStore().setState(job.id, { isRunning: true });
      const stateAfterSet = runtime.getStore().getState(job.id);
      expect(stateAfterSet?.isRunning).toBe(true);

      await runtime.triggerJobNow(job.id);
      expect(trigger).not.toHaveBeenCalled();

      const runs = await store.getRuns(job.id);
      expect(runs.some((r) => r.detail === "任务正在执行中")).toBe(true);

      await runtime.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skip expired once jobs on restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-restart-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      await store.addJob({
        name: "过期任务",
        schedule: { kind: "once", expression: "2020-01-01T00:00:00" },
        prompt: "test",
        chatId: "chat-1",
        conversationKey: "conv-1",
        creatorOpenId: "ou_user",
        enabled: true,
        createdAt: Date.now(),
      });

      const runtime = new SchedulerRuntime({ dataDir: dir }, silentLogger as never);
      const trigger = vi.fn();
      await runtime.start(trigger);

      expect(trigger).not.toHaveBeenCalled();

      // 重新加载 store 以获取 start() 更新后的状态
      const store2 = new JobStore(dir);
      await store2.load();
      const jobs = store2.getJobs();
      expect(jobs[0]?.enabled).toBe(false);

      const runs = await store2.getRuns(jobs[0]?.id ?? "");
      expect(runs.some((r) => r.detail === "missed-due-to-restart")).toBe(true);

      await runtime.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("add/pause/resume/remove lifecycle", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-lifecycle-"));
    try {
      const runtime = new SchedulerRuntime({ dataDir: dir }, silentLogger as never);
      await runtime.start(vi.fn());

      const job = await runtime.addJob({
        name: "生命周期测试",
        schedule: { kind: "cron", expression: "0 9 * * *" },
        prompt: "test",
        chatId: "chat-1",
        conversationKey: "conv-1",
        creatorOpenId: "ou_user",
        enabled: true,
        createdAt: Date.now(),
      });

      expect(runtime.getStore().getJob(job.id)?.enabled).toBe(true);

      await runtime.pauseJob(job.id);
      expect(runtime.getStore().getJob(job.id)?.enabled).toBe(false);

      await runtime.resumeJob(job.id);
      expect(runtime.getStore().getJob(job.id)?.enabled).toBe(true);

      await runtime.removeJob(job.id);
      expect(runtime.getStore().getJob(job.id)).toBeUndefined();

      await runtime.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses configured maxConcurrentRuns for automatic triggers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-max-concurrent-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job1 = await store.addJob({
        name: "A",
        schedule: { kind: "cron", expression: "* * * * *" },
        prompt: "test",
        chatId: "chat-1",
        conversationKey: "conv-1",
        creatorOpenId: "ou_user",
        enabled: true,
        createdAt: Date.now(),
      });
      const job2 = await store.addJob({
        name: "B",
        schedule: { kind: "cron", expression: "* * * * *" },
        prompt: "test",
        chatId: "chat-1",
        conversationKey: "conv-1",
        creatorOpenId: "ou_user",
        enabled: true,
        createdAt: Date.now(),
      });

      let release!: () => void;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = new SchedulerRuntime({ dataDir: dir, maxConcurrentRuns: 1 }, silentLogger as never);
      const trigger = vi.fn(async () => {
        await blocker;
        return { status: "success" as const };
      });
      await runtime.start(trigger);

      const runtimeInternals = runtime as unknown as { onCronTrigger(jobId: string): Promise<void> };
      const firstRun = runtimeInternals.onCronTrigger(job1.id);
      await vi.waitFor(() => {
        expect(trigger).toHaveBeenCalledTimes(1);
      });

      await runtimeInternals.onCronTrigger(job2.id);
      const runs = await runtime.getStore().getRuns(job2.id);
      expect(runs.some((run) => run.detail === "max-concurrent-reached")).toBe(true);

      release();
      await firstRun;
      await runtime.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists trigger result metadata in run history", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-run-meta-"));
    try {
      const runtime = new SchedulerRuntime({ dataDir: dir }, silentLogger as never);
      await runtime.start(async () => ({
        status: "success",
        detail: "silent",
        silent: true,
        openCodeSessionId: "ses_1",
        deliveryMessageId: "om_1",
      }));

      const job = await runtime.addJob({
        name: "meta",
        schedule: { kind: "cron", expression: "0 9 * * *" },
        prompt: "test",
        chatId: "chat-1",
        conversationKey: "conv-1",
        creatorOpenId: "ou_user",
        enabled: true,
        createdAt: Date.now(),
      });

      await runtime.triggerJobNow(job.id);
      const runs = await runtime.getStore().getRuns(job.id);
      expect(runs[0]?.triggerKind).toBe("manual");
      expect(runs[0]?.silent).toBe(true);
      expect(runs[0]?.openCodeSessionId).toBe("ses_1");
      expect(runs[0]?.deliveryMessageId).toBe("om_1");

      await runtime.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
