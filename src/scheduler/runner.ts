/**
 * 职责: 定时任务执行器。
 * 关注点:
 * - notice-only / opencode-isolated 两种 mode
 * - [SILENT] 抑制投递
 * - 超时控制（Promise.race）
 * - 连续 3 次失败自动 pause + 警报
 * - run history 完整记录
 * - 不进 Memory v2 写入路径
 */
import type { Logger } from "../logging/logger.js";
import type { OpenCodeMessage } from "../opencode/client.js";
import type { ScheduledJob } from "./types.js";
import type { JobStore } from "./store.js";
import type { FeishuPostPayload } from "../feishu/shared-primitives.js";
import { runWithScheduledRunContext } from "./context.js";

export type ScheduledRunnerDeps = {
  opencode: {
    createSession(title: string): Promise<{ id: string }>;
    promptAsync(sessionId: string, request: { parts: Array<{ type: string; text: string }> }): Promise<unknown>;
    abort(sessionId: string): Promise<boolean>;
    deleteSession(sessionId: string): Promise<boolean>;
    getSessionMessages(sessionId: string, limit?: number): Promise<Array<{ info: { role?: string; status?: string }; parts: Array<{ type?: string; text?: string }> }>>;
  };
  sendPayload: (chatId: string, payload: FeishuPostPayload, metadata: { event: string }) => Promise<{ messageId: string }>;
  logger: Logger;
};

export type ScheduledRunnerConfig = {
  timeoutMs?: number;
  deleteAfterRun?: boolean;
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const POLL_INTERVAL_MS = 1000;

export class ScheduledRunner {
  constructor(
    private readonly deps: ScheduledRunnerDeps,
    private readonly store: JobStore,
    private readonly pauseJob: (id: string) => Promise<boolean>,
    private readonly config: ScheduledRunnerConfig = {},
  ) {}

  async run(job: ScheduledJob): Promise<{ status: "success" | "error"; detail?: string; silent?: boolean; openCodeSessionId?: string; deliveryMessageId?: string }> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deleteAfterRun = this.config.deleteAfterRun ?? (job.schedule.kind === "once");

    return await runWithScheduledRunContext({ kind: "scheduled-run", jobId: job.id }, async () => {
      if (job.taskMode === "notice-only") {
        return await this.handleNoticeOnly(job);
      }

      return await this.handleOpencodeIsolated(job, timeoutMs, deleteAfterRun);
    });
  }

  private async handleNoticeOnly(job: ScheduledJob): Promise<{ status: "success" | "error"; detail?: string; deliveryMessageId?: string }> {
    const delivery = await this.deliverResult(job, job.prompt, "scheduled notice delivered");
    await this.resetFailures(job);
    return { status: "success", detail: "notice-only", deliveryMessageId: delivery.messageId };
  }

  private async handleOpencodeIsolated(
    job: ScheduledJob,
    timeoutMs: number,
    deleteAfterRun: boolean,
  ): Promise<{ status: "success" | "error"; detail?: string; silent?: boolean; openCodeSessionId?: string; deliveryMessageId?: string }> {
    let sessionId: string | null = null;
    try {
      const session = await this.deps.opencode.createSession(`[scheduled] ${job.name}`);
      sessionId = session.id;

      const replyText = await this.withTimeout(
        (async () => {
          await this.deps.opencode.promptAsync(sessionId!, { parts: [{ type: "text", text: stripControlPrefix(job.prompt) }] });
          return await this.waitForCompletion(sessionId!, timeoutMs);
        })(),
        timeoutMs,
      );

      if (replyText.trimStart().startsWith("[SILENT]")) {
        this.deps.logger.log("scheduler/runner", "SILENT 抑制投递", { jobId: job.shortId, sessionId });
        await this.maybeDeleteSession(sessionId, deleteAfterRun);
        await this.resetFailures(job);
        return { status: "success", detail: "silent", silent: true, openCodeSessionId: sessionId };
      }

      const delivery = await this.deliverResult(job, replyText, "scheduled result delivered");
      await this.maybeDeleteSession(sessionId, deleteAfterRun);
      await this.resetFailures(job);
      return { status: "success", openCodeSessionId: sessionId, deliveryMessageId: delivery.messageId };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.log("scheduler/runner", "执行失败", { jobId: job.shortId, detail }, "error");

      if (sessionId) {
        try { await this.deps.opencode.abort(sessionId); } catch { /* best effort */ }
        await this.maybeDeleteSession(sessionId, deleteAfterRun);
      }

      await this.handleFailure(job, detail);
      return { status: "error", detail };
    }
  }

  private async waitForCompletion(sessionId: string, timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await this.getRecentAssistantMessages(sessionId);
      const lastAssistant = messages[messages.length - 1];

      if (lastAssistant && this.isCompletedMessage(lastAssistant)) {
        return this.extractAssistantText(lastAssistant);
      }

      await this.sleep(POLL_INTERVAL_MS);
    }

    throw new Error("timeout");
  }

  private async getRecentAssistantMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    try {
      return await this.deps.opencode.getSessionMessages(sessionId, 10);
    } catch {
      return [];
    }
  }

  private isCompletedMessage(message: OpenCodeMessage): boolean {
    return message.info.role === "assistant" && message.info.status === "completed";
  }

  private extractAssistantText(message: OpenCodeMessage): string {
    return message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("")
      .trim();
  }

  private async deliverResult(job: ScheduledJob, text: string, event: string): Promise<{ messageId: string }> {
    try {
      const delivery = await this.deps.sendPayload(job.chatId, {
        msg_type: "interactive",
        content: JSON.stringify({
          header: {
            title: { tag: "plain_text", content: `定时任务：${job.name}` },
            template: "blue",
          },
          elements: [
            { tag: "markdown", content: text },
          ],
        }),
      }, { event });
      this.deps.logger.log("scheduler/runner", "结果已投递", { jobId: job.shortId, chatId: job.chatId });
      return delivery;
    } catch (error) {
      this.deps.logger.log("scheduler/runner", "投递失败", {
        jobId: job.shortId,
        detail: error instanceof Error ? error.message : String(error),
      }, "error");
      throw new Error(`delivery-failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleFailure(job: ScheduledJob, detail: string): Promise<void> {
    const state = this.store.getState(job.id);
    const consecutiveFailures = (state?.consecutiveFailures ?? 0) + 1;
    await this.store.setState(job.id, { consecutiveFailures });

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await this.pauseJob(job.id);
      this.deps.logger.log("scheduler/runner", "连续失败自动暂停", {
        jobId: job.shortId,
        consecutiveFailures,
      }, "warn");

      try {
        await this.deps.sendPayload(job.alertChatId ?? job.chatId, {
          msg_type: "interactive",
          content: JSON.stringify({
            header: {
              title: { tag: "plain_text", content: "定时任务已暂停" },
              template: "red",
            },
            elements: [
              {
                tag: "markdown",
                content: `任务 **${job.shortId}**（${job.name}）连续 ${consecutiveFailures} 次执行失败，已自动暂停。\n\n原因：${detail}\n\n使用 \`/schedule resume ${job.shortId}\` 恢复。`,
              },
            ],
          }),
        }, { event: "scheduled alert" });
      } catch {
        this.deps.logger.log("scheduler/runner", "警报投递失败", { jobId: job.shortId }, "warn");
      }
    }
  }

  private async resetFailures(job: ScheduledJob): Promise<void> {
    const state = this.store.getState(job.id);
    if ((state?.consecutiveFailures ?? 0) > 0) {
      await this.store.setState(job.id, { consecutiveFailures: 0 });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async maybeDeleteSession(sessionId: string, shouldDelete: boolean): Promise<void> {
    if (!shouldDelete) return;
    try {
      await this.deps.opencode.deleteSession(sessionId);
    } catch {
      this.deps.logger.log("scheduler/runner", "session 删除失败（忽略）", { sessionId }, "warn");
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function stripControlPrefix(prompt: string): string {
  return prompt.trimStart().startsWith("[SILENT]")
    ? prompt.trimStart().slice("[SILENT]".length).trimStart()
    : prompt;
}
