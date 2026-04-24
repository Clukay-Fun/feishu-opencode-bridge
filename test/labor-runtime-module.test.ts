/**
 * 职责: 覆盖劳动分析运行时模块接入流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import { routeIncomingText } from "../src/bridge/router.js";
import { LaborRuntimeModule } from "../src/labor/runtime-module.js";
import type { LaborAggregateResult, LaborMaterialExtraction } from "../src/labor/index.js";
import type { IncomingChatMessage } from "../src/runtime/app.js";
import { createFeishuTransport } from "../src/runtime/feishu-transport.js";

function createTextMessage(text: string, overrides: Partial<IncomingChatMessage> = {}): IncomingChatMessage {
  return {
    chatId: "chat-1",
    chatType: "group",
    senderOpenId: "ou_user",
    messageId: `msg-${Math.random().toString(16).slice(2)}`,
    rawContent: text,
    plainText: text,
    threadKey: "thread-1",
    conversationKey: "chat-1:thread-1",
    rootId: "thread-1",
    parentId: "thread-1",
    messageType: "text",
    ...overrides,
  } as IncomingChatMessage;
}

function createFileMessage(fileName: string, overrides: Partial<IncomingChatMessage> = {}): IncomingChatMessage {
  return {
    chatId: "chat-1",
    chatType: "group",
    senderOpenId: "ou_user",
    messageId: `msg-${Math.random().toString(16).slice(2)}`,
    rawContent: "",
    plainText: "",
    threadKey: "thread-1",
    conversationKey: "chat-1:thread-1",
    rootId: "thread-1",
    parentId: "thread-1",
    messageType: "file",
    file: {
      fileKey: `file-${Math.random().toString(16).slice(2)}`,
      fileName,
      size: 1024,
    },
    ...overrides,
  } as IncomingChatMessage;
}

function createExtraction(): LaborMaterialExtraction {
  return {
    materialType: "仲裁申请书",
    summary: "已提取材料摘要",
    facts: ["存在解除劳动关系争议"],
    timelineEvents: [{ date: "2026-01-01", event: "收到解除通知" }],
    evidenceRows: [{ name: "解除通知", proves: "用人单位解除劳动关系" }],
    riskPoints: ["解除依据不足"],
    missingEvidenceHints: ["工资流水"],
  };
}

function createAggregate(): LaborAggregateResult {
  return {
    caseTitle: "劳动争议分析",
    disputeStage: "劳动仲裁",
    summary: "案件需要继续补证。",
    coreJudgment: ["单位解除依据不足，建议继续整理证据。"],
    evidenceRows: [{ name: "解除通知", proves: "单位解除劳动关系" }],
    timeline: [{ date: "2026-01-01", event: "收到解除通知" }],
    issues: [{ issue: "违法解除", analysis: "现有材料初步支持劳动者主张", riskLevel: "中" }],
    missingEvidence: ["工资流水"],
    nextActions: ["补充工资流水", "核算赔偿金额"],
    legalSupports: [{ issue: "违法解除", rule: "劳动合同法第四十七条", relation: "支持经济补偿计算" }],
  };
}

async function createModule(existingTempDir?: string) {
  const tempDir = existingTempDir ?? await mkdtemp(path.join(os.tmpdir(), "labor-runtime-test-"));
  let sendIndex = 0;
  const sendPayload = vi.fn(async () => {
    sendIndex += 1;
    return { messageId: `out-${sendIndex}` };
  });
  const updatePayload = vi.fn(async (_chatId: string, messageId: string) => ({ messageId }));
  const extractMaterial = vi.fn(async () => ({
    fileName: "证据1.pdf",
    extraction: createExtraction(),
    cached: false,
  }));
  const finalizeAnalysis = vi.fn(async () => ({
    title: "劳动争议分析",
    markdown: "### 劳动争议分析",
    docUrl: "https://example.com/doc",
    ledgerUrl: "https://example.com/base/app?table=tbl_labor",
    keyEvidenceViewUrl: "https://example.com/base/app?table=tbl_labor&view=vew_key",
    missingEvidenceViewUrl: "https://example.com/base/app?table=tbl_labor&view=vew_gap",
    syncedEvidenceCount: 1,
    syncedGapCount: 1,
    extractedMaterials: [createExtraction()],
    aggregate: createAggregate(),
    warnings: [],
  }));

  const module = new LaborRuntimeModule({
    config: {
      storage: { dataDir: tempDir },
      knowledgeBase: { ingest: { pendingTtlMs: 60_000 } },
      laborSkill: {
        enabled: true,
        ingest: {
          pendingTtlMs: 60_000,
          allowedExtensions: [".pdf", ".docx", ".txt", ".md"],
          maxFileSizeMb: 20,
        },
      },
    } as unknown as AppConfig,
    logger: { log: vi.fn() } as never,
    knowledge: null,
    service: {
      extractMaterial,
      finalizeAnalysis,
    } as never,
    transport: createFeishuTransport({
      sendPayload: sendPayload as never,
      updatePayload: updatePayload as never,
    }),
  });

  return {
    module,
    tempDir,
    sendPayload,
    updatePayload,
    extractMaterial,
    finalizeAnalysis,
  };
}

async function cleanupModule(module: LaborRuntimeModule, tempDir: string): Promise<void> {
  await module.stop();
  await rm(tempDir, { recursive: true, force: true });
}

describe("LaborRuntimeModule", () => {
  it("shows a retirement notice for the legacy /labor-start alias", async () => {
    const { module, tempDir, sendPayload } = await createModule();
    try {
      const start = createTextMessage("/labor-start 劳动争议演示");
      const result = await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });

      expect(result).toEqual({ claimed: true });
      const payloadCalls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      expect(JSON.stringify(payloadCalls[0]?.[1] ?? {})).toContain("命令已更新");
      const interactions = (module as unknown as {
        interactions: { get(key: string): unknown };
      }).interactions;
      expect(interactions.get(start.conversationKey)).toBeUndefined();
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("collects files and notes silently, and only starts analysis after /劳动分析结束", async () => {
    const { module, tempDir, sendPayload, updatePayload, extractMaterial, finalizeAnalysis } = await createModule();
    try {
      const start = createTextMessage("/劳动分析 劳动争议演示");
      const startResult = await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });

      expect(startResult).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(1);

      const interactionBefore = (module as unknown as {
        interactions: Map<string, { expiresAt: number }>;
      }).interactions.get(start.conversationKey);
      const originalExpiresAt = interactionBefore?.expiresAt ?? 0;

      const fileOne = createFileMessage("证据1.pdf");
      const fileOneResult = await module.handleMessage({
        message: fileOne,
        routed: null,
      });
      expect(fileOneResult).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(extractMaterial).not.toHaveBeenCalled();

      const note = createTextMessage("这是补充背景说明");
      const noteResult = await module.handleMessage({
        message: note,
        routed: routeIncomingText(note.plainText),
      });
      expect(noteResult).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(extractMaterial).not.toHaveBeenCalled();
      expect(finalizeAnalysis).not.toHaveBeenCalled();

      const fileTwo = createFileMessage("证据2.pdf");
      await module.handleMessage({
        message: fileTwo,
        routed: null,
      });
      expect(sendPayload).toHaveBeenCalledTimes(1);

      const interactionAfter = (module as unknown as {
        interactions: Map<string, { expiresAt: number; files: unknown[]; notes: string[] }>;
      }).interactions.get(start.conversationKey);
      expect(interactionAfter?.files).toHaveLength(2);
      expect(interactionAfter?.notes).toEqual(["这是补充背景说明"]);
      expect((interactionAfter?.expiresAt ?? 0)).toBeGreaterThanOrEqual(originalExpiresAt);

      const end = createTextMessage("/劳动分析结束");
      const endResult = await module.handleMessage({
        message: end,
        routed: routeIncomingText(end.plainText),
      });

      expect(endResult).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(2);
      expect(extractMaterial).toHaveBeenCalledTimes(2);
      expect(finalizeAnalysis).toHaveBeenCalledTimes(1);
      expect(updatePayload).toHaveBeenCalled();
      const progressPayloads = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      const progressSerialized = JSON.stringify(progressPayloads[1]?.[1] ?? {});
      expect(progressSerialized).toContain("劳动分析进行中");
      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      const completedSerialized = JSON.stringify(updatedPayloads.at(-1)?.[2] ?? {});
      expect(completedSerialized).toContain("劳动分析完成");
      expect(completedSerialized).toContain("材料 2");
      expect(completedSerialized).toContain("证据 1");
      expect(completedSerialized).toContain("焦点 1");
      expect(completedSerialized).toContain("材料占比");
      expect(completedSerialized).toContain("打开分析文档");
      expect(completedSerialized).toContain("打开总表");
      expect(completedSerialized).toContain("关键证据视图");
      expect(completedSerialized).toContain("缺口视图");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("restores an unfinished interaction after restart", async () => {
    const { module, tempDir } = await createModule();
    try {
      const start = createTextMessage("/劳动分析 劳动争议演示");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });
      await module.handleMessage({
        message: createFileMessage("证据1.pdf"),
        routed: null,
      });
      await module.stop();

      const restarted = await createModule(tempDir);
      try {
        await restarted.module.start();
        const interactions = (restarted.module as unknown as {
          interactions: { get(key: string): { files: unknown[]; title?: string } | undefined };
        }).interactions;
        expect(interactions.get(start.conversationKey)).toEqual(expect.objectContaining({
          title: "劳动争议演示",
          files: expect.arrayContaining([expect.objectContaining({ fileName: "证据1.pdf" })]),
        }));
      } finally {
        await cleanupModule(restarted.module, restarted.tempDir);
      }
    } catch (error) {
      await cleanupModule(module, tempDir);
      throw error;
    }
  });
});
