/**
 * 职责: 覆盖劳动案件断点记忆的持久化与恢复查询行为。
 * 关注点:
 * - 验证 checkpoint 能跨进程恢复最近未完成案件。
 * - 验证材料收集阶段会持续更新 pendingMaterials 与开放问题。
 * - 验证终态案件不会被“接着上次”误恢复。
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LaborCaseCheckpointStore } from "../src/labor/checkpoint.js";

describe("LaborCaseCheckpointStore", () => {
  it("persists and restores recent unfinished checkpoints", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "bridge-labor-checkpoint-"));
    const store = new LaborCaseCheckpointStore(dataDir, logger());
    const caseId = store.generateCaseId();

    store.set({
      caseId,
      userId: "ou_1",
      conversationKey: "chat_1:thread_1",
      chatId: "chat_1",
      stage: "collecting",
      lastStep: "开始收集材料",
      pendingMaterials: [],
      openIssues: [],
      anchorMessageId: "om_1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.updateCollection(caseId, {
      pendingMaterials: [{ fileName: "解除通知.pdf", messageId: "msg_file_1" }],
      openIssues: ["员工主张违法解除"],
      lastStep: "已收集 1 份材料",
    });
    await store.stop();

    const restored = new LaborCaseCheckpointStore(dataDir, logger());
    await restored.restore();

    expect(restored.findRecentUnfinished("ou_1")).toMatchObject({
      caseId,
      lastStep: "已收集 1 份材料",
      pendingMaterials: [{ fileName: "解除通知.pdf", messageId: "msg_file_1" }],
      openIssues: ["员工主张违法解除"],
    });
    expect(restored.findByAnchorMessage("om_1")?.caseId).toBe(caseId);
    await restored.stop();
  });

  it("does not return terminal checkpoints as unfinished", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "bridge-labor-checkpoint-"));
    const store = new LaborCaseCheckpointStore(dataDir, logger());
    const caseId = store.generateCaseId();

    store.set({
      caseId,
      userId: "ou_2",
      conversationKey: "chat_2:thread_1",
      chatId: "chat_2",
      stage: "collecting",
      lastStep: "开始收集材料",
      pendingMaterials: [],
      openIssues: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.updateStage(caseId, "completed", "二审完成");

    expect(store.findRecentUnfinished("ou_2")).toBeUndefined();
    await store.stop();
  });
});

function logger() {
  return {
    log: vi.fn(),
    logTranscript: vi.fn(),
  };
}
