/**
 * 职责: 将本地记忆数据同步到 Obsidian 知识库。
 * 关注点:
 * - 按计划任务定期生成同步文件。
 * - 处理 Obsidian 友好的链接与文本格式。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import cron, { type ScheduledTask } from "node-cron";

import { createTextPreview, type Logger } from "../logging/logger.js";
import type { MemoryDb, MemoryFactRecord } from "./db.js";

type ObsidianConfig = {
  enabled: boolean;
  vaultPath?: string | undefined;
  syncCron: string;
  enableWikiLinks: boolean;
};

export class ObsidianSyncService {
  private task: ScheduledTask | null = null;
  private syncPromise: Promise<void> | null = null;

  constructor(
    private readonly config: ObsidianConfig,
    private readonly db: MemoryDb,
    private readonly logger: Logger,
  ) {}

  // #region 生命周期

  /** 启动 Obsidian 同步任务，并补做启动补偿同步。 */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (!this.config.vaultPath) {
      throw new Error("Obsidian vaultPath 未配置");
    }
    if (!cron.validate(this.config.syncCron)) {
      throw new Error(`Obsidian syncCron 无效：${this.config.syncCron}`);
    }

    this.task = cron.schedule(this.config.syncCron, () => {
      void this.sync("cron");
    }, {
      noOverlap: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    await this.runStartupCompensation();
  }

  /** 停止定时任务，并等待正在进行的同步完成。 */
  async stop(): Promise<void> {
    this.task?.stop();
    this.task?.destroy();
    this.task = null;
    if (this.syncPromise) {
      await this.syncPromise;
    }
  }

  /** 触发一次同步；如已有同步进行中则复用同一 Promise。 */
  async sync(reason: "cron" | "startup"): Promise<void> {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.performSync(reason).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  // #endregion

  // #region 内部辅助

  /** 根据上次同步时间判断启动时是否需要补偿同步。 */
  private async runStartupCompensation(): Promise<void> {
    const lastSyncedAt = this.db.getObsidianLastSyncedAt();
    if (!lastSyncedAt) {
      await this.sync("startup");
      return;
    }

    const nextRun = this.getNextRunAfter(lastSyncedAt);
    if (nextRun && nextRun.getTime() <= Date.now()) {
      await this.sync("startup");
    }
  }

  /** 计算某个时间点之后的下一次 cron 触发时间。 */
  private getNextRunAfter(timestamp: number): Date | null {
    const matcher = (this.task as ScheduledTask & {
      timeMatcher?: { getNextMatch(date: Date): Date };
    } | null)?.timeMatcher;
    if (!matcher) {
      return null;
    }
    return matcher.getNextMatch(new Date(timestamp));
  }

  /** 执行真正的同步流程，并为每个用户写 profile 文件。 */
  private async performSync(reason: "cron" | "startup"): Promise<void> {
    const startedAt = Date.now();
    const userIds = this.db.listUsers();

    for (const userId of userIds) {
      const facts = this.db.listFactsForUser(userId);
      await this.writeUserProfile(userId, facts);
    }

    this.db.setObsidianLastSyncedAt(startedAt);
    this.logger.log("memory/obsidian", "obsidian sync completed", {
      reason,
      userCount: userIds.length,
      syncedAt: startedAt,
    });
  }

  /** 为指定用户写出 Obsidian profile.md。 */
  private async writeUserProfile(userId: string, facts: MemoryFactRecord[]): Promise<void> {
    if (!this.config.vaultPath) {
      return;
    }

    const profileDir = path.join(this.config.vaultPath, "memory", userId);
    await mkdir(profileDir, { recursive: true });
    const markdown = buildProfileMarkdown(userId, facts, {
      enableWikiLinks: this.config.enableWikiLinks,
    });
    const profilePath = path.join(profileDir, "profile.md");
    await writeFile(profilePath, markdown, "utf8");
    this.logger.log("memory/obsidian", "profile synced", {
      userId,
      path: profilePath,
      preview: createTextPreview(markdown),
    });
  }

  // #endregion
}

/** 把用户事实渲染为 Obsidian profile Markdown。 */
export function buildProfileMarkdown(
  userId: string,
  facts: MemoryFactRecord[],
  options: { enableWikiLinks: boolean },
): string {
  const lines = [
    `# 用户记忆 ${userId}`,
    "",
    "## 事实",
  ];

  if (facts.length === 0) {
    lines.push("- 暂无记忆");
  } else {
    for (const fact of facts) {
      lines.push(`- ${options.enableWikiLinks ? linkifyFact(fact.fact) : fact.fact}`);
    }
  }

  lines.push("", "## 更新时间", formatTimestamp(new Date()));
  return lines.join("\n");
}

/** 把符合模式的 token 转成 wiki links。 */
function linkifyFact(fact: string): string {
  return fact.replace(/\b([A-Za-z0-9][A-Za-z0-9._/-]*[-_/][A-Za-z0-9._/-]+)\b/g, "[[$1]]");
}

/** 格式化同步时间戳。 */
function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
