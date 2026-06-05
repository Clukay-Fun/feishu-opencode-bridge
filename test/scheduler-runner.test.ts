/**
 * 职责: 覆盖 ScheduledRunner 执行逻辑。
 * 关注点: notice-only / opencode-isolated / [SILENT] / 超时 / 连续失败自动 pause。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { JobStore } from "../src/scheduler/store.js";
import { ScheduledRunner } from "../src/scheduler/runner.js";
import type { ScheduledJob } from "../src/scheduler/types.js";

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-001",
    shortId: "sched-001",
    name: "测试任务",
    schedule: { kind: "cron", expression: "0 9 * * *" },
    prompt: "生成报告",
    chatId: "oc_chat",
    conversationKey: "oc_chat:main",
    creatorOpenId: "ou_user",
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

function createMockOpencode() {
  return {
    createSession: vi.fn(async () => ({ id: "sess-001" })),
    promptAsync: vi.fn(async () => ({})),
    abort: vi.fn(async () => true),
    deleteSession: vi.fn(async () => true),
    getSessionMessages: vi.fn(async () => []),
  };
}

function createMockSendPayload() {
  return vi.fn(async () => ({ messageId: "msg-001" }));
}

describe("ScheduledRunner", () => {
  it("handles notice-only without calling opencode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-silent-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const opencode = createMockOpencode();
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, vi.fn(async () => true));
      const result = await runner.run(makeJob({ taskMode: "notice-only", prompt: "提醒开会" }));

      expect(result.status).toBe("success");
      expect(result.detail).toBe("notice-only");
      expect(opencode.createSession).not.toHaveBeenCalled();
      expect(sendPayload).toHaveBeenCalledWith("oc_chat", expect.anything(), expect.anything());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates isolated session and delivers result", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-opencode-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const opencode = createMockOpencode();
      opencode.getSessionMessages = vi.fn(async () => [
        { info: { role: "assistant", status: "completed" }, parts: [{ type: "text", text: "报告完成" }] },
      ]);
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, vi.fn(async () => true));
      const result = await runner.run(makeJob());

      expect(result.status).toBe("success");
      expect(opencode.createSession).toHaveBeenCalled();
      expect(sendPayload).toHaveBeenCalledWith("oc_chat", expect.anything(), expect.anything());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("suppresses delivery when reply starts with [SILENT]", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-silent-reply-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const opencode = createMockOpencode();
      opencode.getSessionMessages = vi.fn(async () => [
        { info: { role: "assistant", status: "completed" }, parts: [{ type: "text", text: "[SILENT] 已处理" }] },
      ]);
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, vi.fn(async () => true));
      const result = await runner.run(makeJob());

      expect(result.status).toBe("success");
      expect(result.detail).toBe("silent");
      expect(result.silent).toBe(true);
      expect(result.openCodeSessionId).toBe("sess-001");
      expect(sendPayload).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto-pauses after 3 consecutive failures", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-fail-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job = await store.addJob(makeJob());
      const opencode = createMockOpencode();
      opencode.createSession = vi.fn(async () => { throw new Error("opencode down"); });
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };
      const pauseJob = vi.fn(async () => true);

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, pauseJob);

      await runner.run(job);
      await runner.run(job);
      await runner.run(job);

      expect(pauseJob).toHaveBeenCalledWith(job.id);
      expect(sendPayload).toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resets consecutive failures after a successful run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-reset-failure-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job = await store.addJob(makeJob());
      await store.setState(job.id, { consecutiveFailures: 2 });
      const opencode = createMockOpencode();
      opencode.getSessionMessages = vi.fn(async () => [
        { info: { role: "assistant", status: "completed" }, parts: [{ type: "text", text: "ok" }] },
      ]);
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, vi.fn(async () => true));
      const result = await runner.run(job);

      expect(result.status).toBe("success");
      expect(store.getState(job.id)?.consecutiveFailures).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out when promptAsync never resolves", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-timeout-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const job = await store.addJob(makeJob());
      const opencode = createMockOpencode();
      opencode.promptAsync = vi.fn(() => new Promise<never>(() => {}));
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, vi.fn(async () => true), { timeoutMs: 20 });
      const result = await runner.run(job);

      expect(result.status).toBe("error");
      expect(result.detail).toBe("timeout");
      expect(opencode.abort).toHaveBeenCalledWith("sess-001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes session after run for once jobs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-delete-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const opencode = createMockOpencode();
      opencode.getSessionMessages = vi.fn(async () => [
        { info: { role: "assistant", status: "completed" }, parts: [{ type: "text", text: "done" }] },
      ]);
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, vi.fn(async () => true));
      await runner.run(makeJob({ schedule: { kind: "once", expression: "2026-12-31T09:00" } }));

      expect(opencode.deleteSession).toHaveBeenCalledWith("sess-001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not delete session for cron jobs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-keep-"));
    try {
      const store = new JobStore(dir);
      await store.load();
      const opencode = createMockOpencode();
      opencode.getSessionMessages = vi.fn(async () => [
        { info: { role: "assistant", status: "completed" }, parts: [{ type: "text", text: "done" }] },
      ]);
      const sendPayload = createMockSendPayload();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };

      const runner = new ScheduledRunner({ opencode, sendPayload, logger }, store, vi.fn(async () => true));
      await runner.run(makeJob());

      expect(opencode.deleteSession).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
