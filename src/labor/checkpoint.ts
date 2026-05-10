/**
 * 职责: 管理劳动案件断点记忆，支持跨会话恢复。
 * 关注点:
 * - 为每次劳动分析生成独立 caseId。
 * - 持久化案件阶段、待处理材料、开放问题。
 * - 支持最近未完成案件查询与恢复。
 */
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logging/logger.js";

export type LaborCaseStage =
  | "collecting"
  | "analyzing"
  | "authority-confirmation"
  | "reviewing"
  | "completed"
  | "failed"
  | "expired";

export type LaborCaseCheckpoint = {
  caseId: string;
  userId: string;
  conversationKey: string;
  chatId: string;
  stage: LaborCaseStage;
  lastStep: string;
  pendingMaterials: Array<{ fileName: string; messageId?: string | undefined }>;
  openIssues: string[];
  anchorMessageId?: string | undefined;
  createdAt: number;
  updatedAt: number;
};

type CheckpointStore = {
  version: 1;
  checkpoints: LaborCaseCheckpoint[];
};

const MAX_CHECKPOINTS = 100;
const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export class LaborCaseCheckpointStore {
  private checkpoints: Map<string, LaborCaseCheckpoint> = new Map();
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {}

  private get filePath(): string {
    return path.join(this.dataDir, "labor-case-checkpoints.json");
  }

  async restore(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as CheckpointStore;
      if (data.version !== 1 || !Array.isArray(data.checkpoints)) {
        return;
      }
      const now = Date.now();
      for (const cp of data.checkpoints) {
        if (now - cp.updatedAt < CHECKPOINT_TTL_MS) {
          this.checkpoints.set(cp.caseId, cp);
        }
      }
      this.logger.log("labor/checkpoint", "restored checkpoints", {
        count: this.checkpoints.size,
      });
    } catch {
      // 文件不存在或损坏时静默启动
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
    if (!this.dirty) {
      return;
    }
    await this.persist();
  }

  generateCaseId(): string {
    return `case_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  get(caseId: string): LaborCaseCheckpoint | undefined {
    return this.checkpoints.get(caseId);
  }

  set(checkpoint: LaborCaseCheckpoint): void {
    this.checkpoints.set(checkpoint.caseId, checkpoint);
    this.logCheckpointSaved(checkpoint.caseId, checkpoint.stage);
    this.schedulePersist();
  }

  delete(caseId: string): boolean {
    const deleted = this.checkpoints.delete(caseId);
    if (deleted) {
      this.schedulePersist();
    }
    return deleted;
  }

  /** 查找指定用户最近的可恢复未完成案件 */
  findRecentUnfinished(userId: string): LaborCaseCheckpoint | undefined {
    const unfinished: LaborCaseCheckpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.userId === userId && isRecoverableUnfinished(cp)) {
        unfinished.push(cp);
      }
    }
    unfinished.sort((a, b) => b.updatedAt - a.updatedAt);
    return unfinished[0];
  }

  /** 查找指定用户所有可恢复未完成案件 */
  findAllUnfinished(userId: string): LaborCaseCheckpoint[] {
    const unfinished: LaborCaseCheckpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.userId === userId && isRecoverableUnfinished(cp)) {
        unfinished.push(cp);
      }
    }
    unfinished.sort((a, b) => b.updatedAt - a.updatedAt);
    return unfinished;
  }

  /** 通过 anchorMessageId 反查 caseId */
  findByAnchorMessage(anchorMessageId: string): LaborCaseCheckpoint | undefined {
    for (const cp of this.checkpoints.values()) {
      if (cp.anchorMessageId === anchorMessageId) {
        return cp;
      }
    }
    return undefined;
  }

  updateStage(caseId: string, stage: LaborCaseStage, lastStep: string): void {
    const cp = this.checkpoints.get(caseId);
    if (!cp) {
      return;
    }
    cp.stage = stage;
    cp.lastStep = lastStep;
    cp.updatedAt = Date.now();
    this.logCheckpointSaved(caseId, stage);
    this.schedulePersist();
  }

  updateCollection(caseId: string, input: {
    pendingMaterials?: LaborCaseCheckpoint["pendingMaterials"] | undefined;
    openIssues?: string[] | undefined;
    lastStep?: string | undefined;
    anchorMessageId?: string | undefined;
  }): void {
    const cp = this.checkpoints.get(caseId);
    if (!cp) {
      return;
    }
    if (input.pendingMaterials) {
      cp.pendingMaterials = input.pendingMaterials;
    }
    if (input.openIssues) {
      cp.openIssues = input.openIssues;
    }
    if (input.lastStep) {
      cp.lastStep = input.lastStep;
    }
    if (input.anchorMessageId) {
      cp.anchorMessageId = input.anchorMessageId;
    }
    cp.updatedAt = Date.now();
    this.logCheckpointSaved(caseId, cp.stage);
    this.schedulePersist();
  }

  private logCheckpointSaved(caseId: string, stage: LaborCaseStage): void {
    this.logger.log("labor/checkpoint", "case_checkpoint_saved", { caseId, stage });
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 2000);
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const entries = [...this.checkpoints.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHECKPOINTS);
      const data: CheckpointStore = { version: 1, checkpoints: entries };
      await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
      this.dirty = false;
    } catch (error) {
      this.logger.log("labor/checkpoint", "persist failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }
}

function isTerminalStage(stage: LaborCaseStage): boolean {
  return stage === "completed" || stage === "failed" || stage === "expired";
}

function isRecoverableUnfinished(checkpoint: LaborCaseCheckpoint): boolean {
  if (isTerminalStage(checkpoint.stage)) {
    return false;
  }
  if (checkpoint.stage !== "collecting") {
    return true;
  }
  return checkpoint.pendingMaterials.length > 0 || checkpoint.openIssues.length > 0;
}
