/**
 * 职责: 实现 Bridge_scheduler_status MCP 工具。
 * 关注点: 严格只读调度器状态，不创建、修改或删除任何任务。
 */
import type { SafeStoreAccess } from "../safe-store-access.js";

interface SchedulerStatusInput {
  include_recent_runs?: boolean;
  creator_user_id?: string;
}

interface SchedulerStatusOutput {
  as_of: string;
  ttl_seconds: number;
  note: string;
  enabled: boolean;
  total_jobs: number;
  visible_jobs: Array<{
    short_id: string;
    title: string;
    expression: string;
    kind: string;
    state: "enabled" | "paused" | "disabled";
    next_run_at: string | null;
    last_run: { at: string | null; status: string; reason: string } | null;
  }>;
  recent_failures: Array<{
    short_id: string;
    at: string;
    status: string;
    reason: string;
  }>;
  management_commands: string[];
}

export function buildSchedulerStatusOutput(
  store: SafeStoreAccess,
  input: SchedulerStatusInput = {},
): SchedulerStatusOutput {
  const jobs = store.getJobs();
  const states = store.getStates();

  const visibleJobs = jobs
    .filter((job) => {
      if (input.creator_user_id && job.creatorOpenId !== input.creator_user_id) {
        return false;
      }
      return true;
    })
    .map((job) => {
      const state = states[job.id];
      const lastRun = state?.lastRunAt
        ? { at: new Date(state.lastRunAt).toISOString(), status: "unknown", reason: "" }
        : null;

      // Get actual last run from JSONL if available
      const runs = store.getRecentRuns(job.id, 1);
      const lastRunRecord = runs.length > 0 ? runs[0] : null;

      return {
        short_id: job.shortId,
        title: job.name,
        expression: job.schedule.expression,
        kind: job.schedule.kind,
        state: (job.enabled ? "enabled" : "paused") as "enabled" | "paused",
        next_run_at: state?.nextRunAt ? new Date(state.nextRunAt).toISOString() : null,
        last_run: lastRunRecord
          ? {
              at: new Date(lastRunRecord.startedAt).toISOString(),
              status: lastRunRecord.status,
              reason: lastRunRecord.reason || "",
            }
          : lastRun,
      };
    });

  const recentFailures: SchedulerStatusOutput["recent_failures"] = [];
  if (input.include_recent_runs) {
    for (const job of jobs) {
      const runs = store.getRecentRuns(job.id, 10);
      for (const run of runs) {
        if (run.status === "failed" || run.status === "error") {
          recentFailures.push({
            short_id: job.shortId,
            at: new Date(run.startedAt).toISOString(),
            status: run.status,
            reason: run.reason || "",
          });
        }
      }
    }
    recentFailures.sort((a, b) => b.at.localeCompare(a.at));
  }

  return {
    as_of: new Date().toISOString(),
    ttl_seconds: 0,
    note: "Snapshot. Call again after /cron add/pause/resume/delete or after task run.",
    enabled: true,
    total_jobs: jobs.length,
    visible_jobs: visibleJobs,
    recent_failures: recentFailures,
    management_commands: [
      "/cron list",
      "/cron show <id>",
      "/cron pause <id>",
      "/cron resume <id>",
      "/cron delete <id>",
    ],
  };
}
