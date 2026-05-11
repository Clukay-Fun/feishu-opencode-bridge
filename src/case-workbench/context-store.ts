/**
 * 职责: 保存案件工作台可召回上下文。
 * 关注点:
 * - 为普通 OpenCode 对话提供最近案件分析结果。
 * - 按用户和会话维度查找当前案件，避免跨人串案。
 * - 仅保存业务摘要与工作台 Markdown，不负责执行领域分析。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logging/logger.js";

export type CaseWorkbenchContext = {
  caseId: string;
  title: string;
  userId: string;
  chatId: string;
  conversationKey: string;
  source: "labor";
  docUrl?: string | undefined;
  markdown: string;
  summary?: string | undefined;
  issues: string[];
  claimBasis: string[];
  evidence: string[];
  missingEvidence: string[];
  updatedAt: number;
};

type StoreFile = {
  version: 1;
  contexts: CaseWorkbenchContext[];
};

const MAX_CONTEXTS = 50;
const MAX_MARKDOWN_LENGTH = 120_000;
const CONTEXT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export class CaseWorkbenchContextStore {
  private contexts = new Map<string, CaseWorkbenchContext>();
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {}

  private get filePath(): string {
    return path.join(this.dataDir, "case-workbench-contexts.json");
  }

  async restore(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.contexts)) {
        return;
      }
      const now = Date.now();
      for (const context of parsed.contexts) {
        if (now - context.updatedAt <= CONTEXT_TTL_MS) {
          this.contexts.set(context.caseId, normalizeContext(context));
        }
      }
      this.logger.log("case-workbench/context", "restored case contexts", {
        count: this.contexts.size,
      });
    } catch {
      // 首次启动或旧文件损坏时不阻断运行。
    }
  }

  async stop(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.dirty) {
      await this.persist();
    }
  }

  upsert(context: CaseWorkbenchContext): void {
    this.contexts.set(context.caseId, normalizeContext(context));
    this.schedulePersist();
  }

  findRecent(input: {
    userId: string;
    conversationKey?: string | undefined;
    chatId?: string | undefined;
  }): CaseWorkbenchContext | null {
    const candidates = [...this.contexts.values()]
      .filter((context) => context.userId === input.userId)
      .filter((context) => !input.conversationKey || context.conversationKey === input.conversationKey || context.chatId === input.chatId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return candidates[0] ?? null;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 1000);
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const contexts = [...this.contexts.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_CONTEXTS);
      await writeFile(this.filePath, JSON.stringify({ version: 1, contexts } satisfies StoreFile, null, 2), "utf8");
      this.dirty = false;
    } catch (error) {
      this.logger.log("case-workbench/context", "persist failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }
}

export function renderCaseWorkbenchContextBlock(context: CaseWorkbenchContext): string {
  return [
    "[Current Case Workbench Context]",
    `案件ID：${context.caseId}`,
    `案件标题：${context.title}`,
    context.docUrl ? `工作台文档：${context.docUrl}` : "",
    context.summary ? `案件摘要：${context.summary}` : "",
    "",
    "争议焦点：",
    ...formatList(context.issues),
    "",
    "请求权基础：",
    ...formatList(context.claimBasis),
    "",
    "证据清单：",
    ...formatList(context.evidence),
    "",
    "待补材料：",
    ...formatList(context.missingEvidence),
    "",
    "工作台正文：",
    context.markdown.slice(0, MAX_MARKDOWN_LENGTH),
    "",
    "使用要求：用户提到当前案件、刚才的工作台、案件分析结果或要求生成仲裁申请书/证据目录/代理意见时，优先基于以上工作台内容回答；不要臆造工作台没有的事实、金额或证据。",
  ].filter((line) => line !== "").join("\n");
}

function normalizeContext(context: CaseWorkbenchContext): CaseWorkbenchContext {
  return {
    ...context,
    markdown: context.markdown.slice(0, MAX_MARKDOWN_LENGTH),
    issues: context.issues.filter(Boolean).slice(0, 12),
    claimBasis: context.claimBasis.filter(Boolean).slice(0, 12),
    evidence: context.evidence.filter(Boolean).slice(0, 20),
    missingEvidence: context.missingEvidence.filter(Boolean).slice(0, 12),
  };
}

function formatList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- 暂无"];
}
