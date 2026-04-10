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

  async stop(): Promise<void> {
    this.task?.stop();
    this.task?.destroy();
    this.task = null;
    if (this.syncPromise) {
      await this.syncPromise;
    }
  }

  async sync(reason: "cron" | "startup"): Promise<void> {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.performSync(reason).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

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

  private getNextRunAfter(timestamp: number): Date | null {
    const matcher = (this.task as ScheduledTask & {
      timeMatcher?: { getNextMatch(date: Date): Date };
    } | null)?.timeMatcher;
    if (!matcher) {
      return null;
    }
    return matcher.getNextMatch(new Date(timestamp));
  }

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
}

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

function linkifyFact(fact: string): string {
  return fact.replace(/\b([A-Za-z0-9][A-Za-z0-9._/-]*[-_/][A-Za-z0-9._/-]+)\b/g, "[[$1]]");
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
