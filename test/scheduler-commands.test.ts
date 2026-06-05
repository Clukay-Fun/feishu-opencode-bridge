/**
 * 职责: 覆盖 /schedule 子命令逻辑。
 * 关注点: add/list/show/pause/resume/run/delete/runs、创建者权限、delete 二次确认。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SchedulerRuntime } from "../src/scheduler/runtime.js";
import { ScheduleCommands } from "../src/scheduler/commands.js";
import { runWithScheduledRunContext } from "../src/scheduler/context.js";

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

async function createTestContext() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduler-cmd-"));
  const runtime = new SchedulerRuntime({ dataDir: dir }, silentLogger as never);
  await runtime.start(async () => ({ status: "success" }));
  const commands = new ScheduleCommands(runtime, silentLogger as never);
  return { dir, runtime, commands };
}

describe("ScheduleCommands", () => {
  it("add creates a job and returns notice", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "每日早报"]);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("sched-001");
      expect(result.message).toContain("每日早报");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("add supports interval and at forms", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const intervalResult = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["interval", "every 1h", "检查服务器状态"]);
      expect(intervalResult.ok).toBe(true);
      expect(intervalResult.message).toContain("sched-001");

      const atTime = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const atResult = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["at", atTime, "提醒开会"]);
      expect(atResult.ok).toBe(true);
      expect(atResult.message).toContain("sched-002");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects add from scheduled run context", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "递归任务"], { scheduledRun: true });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("不能创建新的定时任务");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects add from async scheduled-run context", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await runWithScheduledRunContext({ kind: "scheduled-run", jobId: "job-1" }, async () =>
        await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "递归任务"])
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("不能创建新的定时任务");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("add rejects missing args", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron"]);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("自然语言");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("add rejects invalid expression", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "not-a-cron", "test"]);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("解析失败");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("add returns help when no args", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", []);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("自然语言");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("add returns help when only 1 arg", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["0 9 * * *"]);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("自然语言");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("add auto-detects ISO datetime in new syntax", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const futureDate = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const result = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", [futureDate, "提醒开会"]);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("一次性");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("help presents cron as the primary command surface", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const result = await commands.handleHelp();
      expect(result.ok).toBe(true);
      expect(result.message).toContain("/cron list");
      expect(result.message).toContain("直接发送自然语言");
      expect(result.message).not.toContain('/schedule add');
      expect(result.message).toContain("1分钟后发个问候给我");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("nl create stores independent confirmations for the same user", async () => {
    const { commands, runtime, dir } = await createTestContext();
    try {
      const first = await commands.handleNlCreate("ou_user", "oc_chat_a", "oc_chat_a:main", "每天上午9点生成早报", "om_1");
      const second = await commands.handleNlCreate("ou_user", "oc_chat_b", "oc_chat_b:main", "每小时检查项目状态", "om_2");
      const firstKey = extractPendingKey(first.payload, "schedule-nl-confirm");
      const secondKey = extractPendingKey(second.payload, "schedule-nl-confirm");

      expect(firstKey).toBeTruthy();
      expect(secondKey).toBeTruthy();
      expect(firstKey).not.toBe(secondKey);

      const firstConfirm = await commands.handleNlConfirm("ou_user", firstKey);
      expect(firstConfirm.ok).toBe(true);
      expect(firstConfirm.message).toContain("生成早报");

      const secondConfirm = await commands.handleNlConfirm("ou_user", secondKey);
      expect(secondConfirm.ok).toBe(true);
      expect(secondConfirm.message).toContain("检查项目状态");

      const jobs = runtime.getStore().getJobs();
      expect(jobs).toEqual([
        expect.objectContaining({ chatId: "oc_chat_a", conversationKey: "oc_chat_a:main", prompt: "生成早报" }),
        expect.objectContaining({ chatId: "oc_chat_b", conversationKey: "oc_chat_b:main", prompt: "检查项目状态" }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("nl confirmation is limited to the creator", async () => {
    const { commands, runtime, dir } = await createTestContext();
    try {
      const created = await commands.handleNlCreate("ou_creator", "oc_chat", "oc_chat:main", "每天上午9点生成早报", "om_1");
      const pendingKey = extractPendingKey(created.payload, "schedule-nl-confirm");

      const denied = await commands.handleNlConfirm("ou_other", pendingKey);
      expect(denied.ok).toBe(false);
      expect(denied.message).toContain("创建者");
      expect(runtime.getStore().getJobs()).toEqual([]);

      const confirmed = await commands.handleNlConfirm("ou_creator", pendingKey);
      expect(confirmed.ok).toBe(true);
      expect(runtime.getStore().getJobs()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("nl confirmation preserves notice-only task mode", async () => {
    const { commands, runtime, dir } = await createTestContext();
    try {
      const created = await commands.handleNlCreate("ou_user", "oc_chat", "oc_chat:main", "1分钟后发个问候给我", "om_1");
      expect(JSON.stringify(created.payload)).toContain("仅投递提醒，不调用 AI");
      const pendingKey = extractPendingKey(created.payload, "schedule-nl-confirm");

      const confirmed = await commands.handleNlConfirm("ou_user", pendingKey);
      expect(confirmed.ok).toBe(true);
      expect(runtime.getStore().getJobs()[0]).toEqual(expect.objectContaining({
        taskMode: "notice-only",
        prompt: "发个问候给我",
        alertChatId: "oc_chat",
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list shows user's own jobs by default", async () => {
    const { commands, dir } = await createTestContext();
    try {
      await commands.handleAdd("ou_user1", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "任务1"]);
      await commands.handleAdd("ou_user2", "oc_chat", "oc_chat:main", ["cron", "10 9 * * *", "任务2"]);

      const result = await commands.handleList("ou_user1", []);
      expect(result.ok).toBe(true);
      const data = result.data as { jobs: unknown[] };
      expect(data.jobs.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list all shows all jobs", async () => {
    const { commands, dir } = await createTestContext();
    try {
      await commands.handleAdd("ou_user1", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "任务1"]);
      await commands.handleAdd("ou_user2", "oc_chat", "oc_chat:main", ["cron", "10 9 * * *", "任务2"]);

      const result = await commands.handleList("ou_user1", ["all"]);
      expect(result.ok).toBe(true);
      const data = result.data as { jobs: unknown[] };
      expect(data.jobs.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pause and resume work correctly", async () => {
    const { commands, dir } = await createTestContext();
    try {
      const addResult = await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "测试"]);
      const shortId = (addResult.message.match(/sched-\d+/) ?? [])[0];

      const pauseResult = await commands.handlePause("ou_user", [shortId!]);
      expect(pauseResult.ok).toBe(true);
      expect(pauseResult.message).toContain("已暂停");

      const resumeResult = await commands.handleResume("ou_user", [shortId!]);
      expect(resumeResult.ok).toBe(true);
      expect(resumeResult.message).toContain("已恢复");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-creator action", async () => {
    const { commands, dir } = await createTestContext();
    try {
      await commands.handleAdd("ou_creator", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "测试"]);
      const listResult = await commands.handleList("ou_creator", []);
      const jobs = (listResult.data as { jobs: Array<{ shortId: string }> }).jobs;

      const pauseResult = await commands.handlePause("ou_other", [jobs[0]!.shortId]);
      expect(pauseResult.ok).toBe(false);
      expect(pauseResult.message).toContain("创建者");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("delete returns confirmation card", async () => {
    const { commands, dir } = await createTestContext();
    try {
      await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "测试"]);
      const listResult = await commands.handleList("ou_user", []);
      const jobs = (listResult.data as { jobs: Array<{ shortId: string }> }).jobs;

      const deleteResult = await commands.handleDelete("ou_user", [jobs[0]!.shortId]);
      expect(deleteResult.ok).toBe(true);
      expect(deleteResult.card).toBe("confirm");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("delete confirm actually deletes", async () => {
    const { commands, dir } = await createTestContext();
    try {
      await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "测试"]);
      const listResult = await commands.handleList("ou_user", []);
      const jobs = (listResult.data as { jobs: Array<{ shortId: string }> }).jobs;

      const confirmResult = await commands.handleDeleteConfirm("ou_user", jobs[0]!.shortId);
      expect(confirmResult.ok).toBe(true);
      expect(confirmResult.message).toContain("已删除");

      const listAfter = await commands.handleList("ou_user", []);
      expect((listAfter.data as { jobs: unknown[] }).jobs.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("run triggers job now", async () => {
    const { commands, dir } = await createTestContext();
    try {
      await commands.handleAdd("ou_user", "oc_chat", "oc_chat:main", ["cron", "0 9 * * *", "测试"]);
      const listResult = await commands.handleList("ou_user", []);
      const jobs = (listResult.data as { jobs: Array<{ shortId: string }> }).jobs;

      const runResult = await commands.handleRun("ou_user", [jobs[0]!.shortId]);
      expect(runResult.ok).toBe(true);
      expect(runResult.message).toContain("触发");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function extractPendingKey(payload: unknown, kind: "schedule-nl-confirm" | "schedule-nl-cancel"): string {
  const card = JSON.parse((payload as { content: string }).content) as { elements?: Array<{ actions?: Array<{ value?: { kind?: string; pendingKey?: string } }> }> };
  const action = card.elements
    ?.flatMap((element) => element.actions ?? [])
    .find((item) => item.value?.kind === kind);
  return action?.value?.pendingKey ?? "";
}
