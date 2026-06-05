/**
 * Tests for Bridge_scheduler_status MCP tool output.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SafeStoreAccess } from "../src/mcp/safe-store-access.js";
import { buildSchedulerStatusOutput } from "../src/mcp/tools/scheduler-status.js";

describe("Bridge_scheduler_status tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-status-"));
    await mkdir(path.join(tmpDir, "schedules"), { recursive: true });
    await mkdir(path.join(tmpDir, "schedules", "runs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty state when no jobs exist", () => {
    const store = new SafeStoreAccess(tmpDir);
    const output = buildSchedulerStatusOutput(store);

    expect(output.enabled).toBe(true);
    expect(output.total_jobs).toBe(0);
    expect(output.visible_jobs).toEqual([]);
    expect(output.recent_failures).toEqual([]);
    expect(output.as_of).toBeDefined();
    expect(output.note).toContain("Snapshot");
  });

  it("returns jobs with next_run_at and last_run", async () => {
    const jobsData = {
      version: 1,
      nextShortId: 2,
      jobs: [
        { id: "j1", shortId: "sched-001", name: "每天9点生成简报", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, createdAt: 1000, creatorOpenId: "ou_user1" },
      ],
    };
    const statesData = {
      version: 1,
      states: {
        j1: { jobId: "j1", isRunning: false, lastRunAt: 1700000000000, nextRunAt: 1700086400000, runCount: 5, skipCount: 0 },
      },
    };
    await writeFile(path.join(tmpDir, "schedules", "jobs.json"), JSON.stringify(jobsData));
    await writeFile(path.join(tmpDir, "schedules", "jobs-state.json"), JSON.stringify(statesData));

    const store = new SafeStoreAccess(tmpDir);
    const output = buildSchedulerStatusOutput(store);

    expect(output.total_jobs).toBe(1);
    expect(output.visible_jobs).toHaveLength(1);
    expect(output.visible_jobs[0]!.short_id).toBe("sched-001");
    expect(output.visible_jobs[0]!.title).toBe("每天9点生成简报");
    expect(output.visible_jobs[0]!.expression).toBe("0 9 * * *");
    expect(output.visible_jobs[0]!.kind).toBe("cron");
    expect(output.visible_jobs[0]!.state).toBe("enabled");
    expect(output.visible_jobs[0]!.next_run_at).toContain("2023-11-15");
  });

  it("includes recent_failures when include_recent_runs=true", async () => {
    const jobsData = {
      version: 1,
      nextShortId: 2,
      jobs: [
        { id: "j1", shortId: "sched-001", name: "Test", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, createdAt: 1000, creatorOpenId: "ou_user1" },
      ],
    };
    await writeFile(path.join(tmpDir, "schedules", "jobs.json"), JSON.stringify(jobsData));
    await writeFile(path.join(tmpDir, "schedules", "jobs-state.json"), JSON.stringify({ version: 1, states: {} }));

    const run = { jobId: "j1", startedAt: 1700000000000, finishedAt: 1700000001000, status: "failed", reason: "timeout" };
    await writeFile(path.join(tmpDir, "schedules", "runs", "j1.jsonl"), JSON.stringify(run) + "\n");

    const store = new SafeStoreAccess(tmpDir);
    const output = buildSchedulerStatusOutput(store, { include_recent_runs: true });

    expect(output.recent_failures).toHaveLength(1);
    expect(output.recent_failures[0]!.short_id).toBe("sched-001");
    expect(output.recent_failures[0]!.status).toBe("failed");
    expect(output.recent_failures[0]!.reason).toBe("timeout");
  });

  it("always includes as_of and note (contract test)", () => {
    const store = new SafeStoreAccess(tmpDir);
    const output = buildSchedulerStatusOutput(store);

    expect(output.as_of).toBeDefined();
    expect(typeof output.as_of).toBe("string");
    expect(output.note).toBeDefined();
    expect(typeof output.note).toBe("string");
    expect(output.ttl_seconds).toBe(0);
  });

  it("includes management_commands", () => {
    const store = new SafeStoreAccess(tmpDir);
    const output = buildSchedulerStatusOutput(store);

    expect(output.management_commands).toContain("/cron list");
    expect(output.management_commands).toContain("/cron show <id>");
    expect(output.management_commands).toContain("/cron pause <id>");
    expect(output.management_commands).toContain("/cron resume <id>");
    expect(output.management_commands).toContain("/cron delete <id>");
  });
});
