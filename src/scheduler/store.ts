/**
 * 职责: Scheduler 持久化存储。
 * 关注点:
 * - jobs.json / jobs-state.json / runs/<jobId>.jsonl
 * - 原子写（tmp + rename）
 * - 短 ID 自增（sched-001 起步，跨重启延续）
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ScheduledJob, JobState, JobRun } from "./types.js";

type JobsFile = {
  version: 1;
  nextShortId: number;
  jobs: ScheduledJob[];
};

type StatesFile = {
  version: 1;
  states: Record<string, JobState>;
};

const JOBS_FILE = "jobs.json";
const STATES_FILE = "jobs-state.json";
const RUNS_DIR = "runs";

export class JobStore {
  private jobs: ScheduledJob[] = [];
  private states: Record<string, JobState> = {};
  private nextShortId = 1;
  private loaded = false;

  constructor(private readonly dataDir: string) {}

  async load(): Promise<void> {
    const dir = this.dataDir;
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, RUNS_DIR), { recursive: true });

    const jobsPath = path.join(dir, JOBS_FILE);
    const statesPath = path.join(dir, STATES_FILE);

    try {
      const raw = JSON.parse(await readFile(jobsPath, "utf-8")) as JobsFile;
      if (raw.version === 1 && Array.isArray(raw.jobs)) {
        this.jobs = raw.jobs;
        this.nextShortId = raw.nextShortId ?? (this.jobs.length + 1);
      }
    } catch {
      this.jobs = [];
    }

    try {
      const raw = JSON.parse(await readFile(statesPath, "utf-8")) as StatesFile;
      if (raw.version === 1 && raw.states) {
        this.states = Object.fromEntries(
          Object.entries(raw.states).map(([jobId, state]) => [
            jobId,
            { ...state, consecutiveFailures: state.consecutiveFailures ?? 0 },
          ]),
        );
      }
    } catch {
      this.states = {};
    }

    this.loaded = true;
  }

  async save(): Promise<void> {
    const dir = this.dataDir;
    const jobsData: JobsFile = { version: 1, nextShortId: this.nextShortId, jobs: this.jobs };
    const statesData: StatesFile = { version: 1, states: this.states };

    await atomicWrite(path.join(dir, JOBS_FILE), JSON.stringify(jobsData, null, 2));
    await atomicWrite(path.join(dir, STATES_FILE), JSON.stringify(statesData, null, 2));
  }

  getJobs(): ScheduledJob[] {
    return [...this.jobs];
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  getState(jobId: string): JobState | undefined {
    return this.states[jobId];
  }

  getStates(): Record<string, JobState> {
    return { ...this.states };
  }

  async addJob(job: Omit<ScheduledJob, "id" | "shortId">): Promise<ScheduledJob> {
    const id = crypto.randomUUID();
    const shortId = `sched-${String(this.nextShortId).padStart(3, "0")}`;
    this.nextShortId++;

    const full: ScheduledJob = { ...job, id, shortId };
    this.jobs.push(full);
    this.states[id] = {
      jobId: id,
      isRunning: false,
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      skipCount: 0,
      consecutiveFailures: 0,
    };
    await this.save();
    return full;
  }

  async updateJob(id: string, updates: Partial<Pick<ScheduledJob, "name" | "prompt" | "enabled">>): Promise<boolean> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    Object.assign(job, updates);
    await this.save();
    return true;
  }

  async removeJob(id: string): Promise<boolean> {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return false;
    this.jobs.splice(idx, 1);
    delete this.states[id];
    await this.save();
    return true;
  }

  async setState(jobId: string, updates: Partial<JobState>): Promise<void> {
    const state = this.states[jobId];
    if (!state) return;
    Object.assign(state, updates);
    await this.save();
  }

  async appendRun(jobId: string, run: JobRun): Promise<void> {
    const filePath = path.join(this.dataDir, RUNS_DIR, `${jobId}.jsonl`);
    await writeFile(filePath, JSON.stringify(run) + "\n", { flag: "a" });
  }

  async getRuns(jobId: string, limit = 20): Promise<JobRun[]> {
    const filePath = path.join(this.dataDir, RUNS_DIR, `${jobId}.jsonl`);
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line) as JobRun);
    } catch {
      return [];
    }
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}
