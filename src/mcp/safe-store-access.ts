/**
 * 职责: 为 MCP 工具提供安全的只读调度器存储访问。
 * 关注点:
 * - 只读取 JSON/JSONL 文件，不提供任何写入能力。
 * - 读取失败时返回空结果，避免 MCP 查询影响 Bridge 主流程。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface ScheduledJobInfo {
  id: string;
  shortId: string;
  name: string;
  schedule: {
    kind: string;
    expression: string;
  };
  enabled: boolean;
  createdAt: number;
  creatorOpenId?: string;
}

export interface JobStateInfo {
  jobId: string;
  isRunning: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  skipCount: number;
}

export interface JobRunRecord {
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  reason?: string;
}

interface JobsFile {
  version: number;
  nextShortId: number;
  jobs: ScheduledJobInfo[];
}

interface StatesFile {
  version: number;
  states: Record<string, JobStateInfo>;
}

export class SafeStoreAccess {
  constructor(private readonly dataDir: string) {}

  getJobs(): ScheduledJobInfo[] {
    const filePath = path.join(this.dataDir, "schedules", "jobs.json");
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as JobsFile;
      if (parsed.version === 1 && Array.isArray(parsed.jobs)) {
        return parsed.jobs;
      }
      return [];
    } catch {
      return [];
    }
  }

  getStates(): Record<string, JobStateInfo> {
    const filePath = path.join(this.dataDir, "schedules", "jobs-state.json");
    if (!existsSync(filePath)) return {};
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as StatesFile;
      if (parsed.version === 1 && parsed.states) {
        return parsed.states;
      }
      return {};
    } catch {
      return {};
    }
  }

  getRecentRuns(jobId: string, limit = 5): JobRunRecord[] {
    const filePath = path.join(this.dataDir, "schedules", "runs", `${jobId}.jsonl`);
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line) as JobRunRecord);
    } catch {
      return [];
    }
  }
}
