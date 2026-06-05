/**
 * 职责: 保存当前异步链路是否来自定时任务执行。
 * 关注点: 给命令入口提供 anti-recursion 判断，不耦合普通 turn executor。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type ScheduledRunContext = {
  kind: "scheduled-run";
  jobId: string;
};

const storage = new AsyncLocalStorage<ScheduledRunContext>();

export function getScheduledRunContext(): ScheduledRunContext | undefined {
  return storage.getStore();
}

export async function runWithScheduledRunContext<T>(
  context: ScheduledRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  return await storage.run(context, fn);
}
