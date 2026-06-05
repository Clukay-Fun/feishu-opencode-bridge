/**
 * Tests for safe read-only store access.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SafeStoreAccess } from "../src/mcp/safe-store-access.js";

describe("SafeStoreAccess", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "safe-store-"));
    await mkdir(path.join(tmpDir, "schedules"), { recursive: true });
    await mkdir(path.join(tmpDir, "schedules", "runs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when jobs.json does not exist", () => {
    const store = new SafeStoreAccess(tmpDir);
    expect(store.getJobs()).toEqual([]);
  });

  it("reads jobs from jobs.json", async () => {
    const jobsData = {
      version: 1,
      nextShortId: 3,
      jobs: [
        { id: "j1", shortId: "sched-001", name: "Test Job 1", schedule: { kind: "cron", expression: "0 9 * * *" }, enabled: true, createdAt: 1000 },
        { id: "j2", shortId: "sched-002", name: "Test Job 2", schedule: { kind: "interval", expression: "1h" }, enabled: false, createdAt: 2000 },
      ],
    };
    await writeFile(path.join(tmpDir, "schedules", "jobs.json"), JSON.stringify(jobsData));

    const store = new SafeStoreAccess(tmpDir);
    const jobs = store.getJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.shortId).toBe("sched-001");
    expect(jobs[1]!.enabled).toBe(false);
  });

  it("reads states from jobs-state.json", async () => {
    const statesData = {
      version: 1,
      states: {
        j1: { jobId: "j1", isRunning: false, lastRunAt: 1000, nextRunAt: 5000, runCount: 3, skipCount: 0 },
        j2: { jobId: "j2", isRunning: true, lastRunAt: 2000, nextRunAt: null, runCount: 1, skipCount: 2 },
      },
    };
    await writeFile(path.join(tmpDir, "schedules", "jobs-state.json"), JSON.stringify(statesData));

    const store = new SafeStoreAccess(tmpDir);
    const states = store.getStates();
    expect(states["j1"]!.runCount).toBe(3);
    expect(states["j2"]!.isRunning).toBe(true);
  });

  it("reads recent runs from JSONL file", async () => {
    const runs = [
      { jobId: "j1", startedAt: 1000, finishedAt: 1100, status: "success" },
      { jobId: "j1", startedAt: 2000, finishedAt: 2100, status: "failed", reason: "timeout" },
      { jobId: "j1", startedAt: 3000, finishedAt: 3100, status: "success" },
    ];
    const content = runs.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(path.join(tmpDir, "schedules", "runs", "j1.jsonl"), content);

    const store = new SafeStoreAccess(tmpDir);
    const recentRuns = store.getRecentRuns("j1", 2);
    expect(recentRuns).toHaveLength(2);
    // Returns the LAST 2 runs (runs 2 and 3)
    expect(recentRuns[0]!.status).toBe("failed");
    expect(recentRuns[1]!.status).toBe("success");
  });

  it("returns empty array for non-existent run file", () => {
    const store = new SafeStoreAccess(tmpDir);
    expect(store.getRecentRuns("nonexistent", 5)).toEqual([]);
  });

  it("handles corrupted JSON gracefully", async () => {
    await writeFile(path.join(tmpDir, "schedules", "jobs.json"), "not valid json");

    const store = new SafeStoreAccess(tmpDir);
    expect(store.getJobs()).toEqual([]);
  });

  it("does not have any write methods", () => {
    const store = new SafeStoreAccess(tmpDir);
    // Verify the class only has read methods
    expect(typeof store.getJobs).toBe("function");
    expect(typeof store.getStates).toBe("function");
    expect(typeof store.getRecentRuns).toBe("function");
    // Should not have write methods
    expect((store as any).writeJob).toBeUndefined();
    expect((store as any).saveJob).toBeUndefined();
    expect((store as any).deleteJob).toBeUndefined();
  });
});
