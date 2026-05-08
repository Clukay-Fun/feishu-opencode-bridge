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
import { buildLaborAnalysisProgressPayload } from "../src/feishu/labor-cards.js";

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
    keyIssues: ["解除是否合法", "赔偿金额如何核算"],
    claimBasis: [
      {
        claim: "经济补偿或赔偿金",
        basis: "《劳动合同法》第四十七条",
        evidence: ["解除通知"],
        risk: "工资基数需复核",
        reviewNote: "需确认违法解除还是协商解除",
      },
    ],
    strategy: {
      litigation: ["先固定解除事实和工资基数"],
      mediation: ["用赔偿金额区间推动调解"],
      response: ["针对公司解除理由准备反驳证据"],
    },
    draftDocuments: [
      { type: "仲裁申请书", summary: "请求确认违法解除并主张赔偿" },
    ],
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
  const finalizeReviewOnly = vi.fn(async () => ({
    reviewReport: {
      status: "needs_human_review" as const,
      findings: [{ severity: "high" as const, type: "null_source", message: "缺少来源", source: { type: null } }],
      unsupportedClaims: [],
      authorityCoverage: [],
      suggestedEdits: [],
      warnings: [],
    },
    reviewSkippedReason: undefined,
  }));
  const buildAuthoritySearchDraft = vi.fn(() => ({
    mainQuery: "劳动争议 违法解除",
    alternatives: ["劳动争议 赔偿金"],
    reason: "测试检索词",
  }));
  const appendAuthoritySearch = vi.fn(async () => ({
    markdown: "### 权威法规补充\n\n已检索",
    search: {
      status: "success",
      query: "劳动争议 违法解除",
      items: [{ title: "劳动合同法", excerpt: "违法解除规则" }],
      durationMs: 10,
    },
  }));

  const logger = { log: vi.fn() };
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
    logger: logger as never,
    knowledge: null,
    service: {
      extractMaterial,
      finalizeAnalysis,
      finalizeReviewOnly,
      buildAuthoritySearchDraft,
      appendAuthoritySearch,
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
    finalizeReviewOnly,
    buildAuthoritySearchDraft,
    appendAuthoritySearch,
    logger,
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
      expect(JSON.stringify(payloadCalls[0]?.[1] ?? {})).toContain("劳动分析入口已更新");
      const interactions = (module as unknown as {
        interactions: { get(key: string): unknown };
      }).interactions;
      expect(interactions.get(start.conversationKey)).toBeUndefined();
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("shows a migration notice for the legacy /劳动分析 command", async () => {
    const { module, tempDir, sendPayload, extractMaterial } = await createModule();
    try {
      const start = createTextMessage("/劳动分析 劳动争议演示");
      const result = await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });

      expect(result).toEqual({ claimed: true });
      expect(extractMaterial).not.toHaveBeenCalled();
      const payloadCalls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      expect(JSON.stringify(payloadCalls[0]?.[1] ?? {})).toContain("该命令已并入");
      expect(JSON.stringify(payloadCalls[0]?.[1] ?? {})).toContain("/案件工作台");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("collects files and notes silently, and only starts analysis after /完成上传", async () => {
    const { module, tempDir, sendPayload, updatePayload, extractMaterial, finalizeAnalysis, finalizeReviewOnly } = await createModule();
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
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

      const end = createTextMessage("/完成上传");
      const endResult = await module.handleMessage({
        message: end,
        routed: routeIncomingText(end.plainText),
      });

      expect(endResult).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(3);
      expect(extractMaterial).toHaveBeenCalledTimes(2);
      expect(finalizeAnalysis).toHaveBeenCalledTimes(1);
      expect(finalizeReviewOnly).toHaveBeenCalledTimes(1);
      expect(updatePayload).toHaveBeenCalled();
      const progressPayloads = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      const progressSerialized = JSON.stringify(progressPayloads[1]?.[1] ?? {});
      expect(progressSerialized).toContain("材料分析进行中");
      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      const completedSerialized = JSON.stringify(updatedPayloads.find((call) => JSON.stringify(call[2]).includes("材料分析完成"))?.[2] ?? {});
      expect(completedSerialized).toContain("材料分析完成");
      expect(completedSerialized).toContain("材料 2");
      expect(completedSerialized).toContain("证据 1");
      expect(completedSerialized).toContain("焦点 1");
      expect(completedSerialized).toContain("标签占比");
      const outboundPayloads = JSON.stringify(progressPayloads.map((call) => call[1]));
      expect(outboundPayloads).toContain("二次审查进行中");
      expect(outboundPayloads).not.toContain("补充权威法规检索");
      expect(outboundPayloads).not.toContain("labor-authority-search");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("starts analysis from the collection card finish button", async () => {
    const { module, tempDir, sendPayload, extractMaterial, finalizeAnalysis, finalizeReviewOnly } = await createModule();
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });
      await module.handleMessage({
        message: createFileMessage("证据1.pdf"),
        routed: null,
      });

      const response = await module.handleCardAction("ou_user", "om_button", {
        kind: "labor-collection-action",
        action: "finish-upload",
        conversationKey: start.conversationKey,
      });

      expect(response).toEqual({ toast: { type: "success", content: "已开始分析材料。" } });
      expect(extractMaterial).toHaveBeenCalledTimes(1);
      expect(finalizeAnalysis).toHaveBeenCalledTimes(1);
      expect(finalizeReviewOnly).toHaveBeenCalledTimes(1);
      const sentPayloads = JSON.stringify((sendPayload.mock.calls as unknown as Array<[string, unknown]>).map((call) => call[1]));
      expect(sentPayloads).toContain("二次审查进行中");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("starts labor analysis from recently uploaded materials when the next message asks for a labor workbench", async () => {
    const { module, tempDir, sendPayload, updatePayload, extractMaterial, finalizeAnalysis } = await createModule();
    try {
      const fileOne = createFileMessage("解除通知.pdf");
      const fileTwo = createFileMessage("工资流水.pdf");

      const fileOneResult = await module.handleMessage({
        message: fileOne,
        routed: null,
      });
      const fileTwoResult = await module.handleMessage({
        message: fileTwo,
        routed: null,
      });

      expect(fileOneResult).toEqual({ claimed: false });
      expect(fileTwoResult).toEqual({ claimed: false });
      expect(extractMaterial).not.toHaveBeenCalled();

      const trigger = createTextMessage("把刚才这些证据生成劳动争议证据链工作台");
      const triggerResult = await module.handleMessage({
        message: trigger,
        routed: routeIncomingText(trigger.plainText),
      });

      expect(triggerResult).toEqual({ claimed: true });
      expect(extractMaterial).toHaveBeenCalledTimes(2);
      const extractCalls = extractMaterial.mock.calls as unknown as Array<[file: { fileName: string }]>;
      expect(extractCalls.map((call) => call[0].fileName)).toEqual(["解除通知.pdf", "工资流水.pdf"]);
      expect(finalizeAnalysis).toHaveBeenCalledTimes(1);
      const finalizeCalls = finalizeAnalysis.mock.calls as unknown as Array<[input: { materialCount: number; notes: string[] }]>;
      const finalizeInput = finalizeCalls[0]?.[0];
      expect(finalizeInput).toEqual(expect.objectContaining({
        materialCount: 2,
        notes: ["把刚才这些证据生成劳动争议证据链工作台"],
      }));
      const payloadCalls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      expect(JSON.stringify(payloadCalls[0]?.[1] ?? {})).toContain("材料收集中");
      expect(JSON.stringify(payloadCalls[1]?.[1] ?? {})).toContain("材料分析进行中");
      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      const completedSerialized = JSON.stringify(updatedPayloads.find((call) => JSON.stringify(call[2]).includes("材料分析完成"))?.[2] ?? {});
      expect(completedSerialized).toContain("材料分析完成");
      expect(completedSerialized).toContain("材料 2");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("starts labor workflow from recent materials when asked for an evidence list Word", async () => {
    const { module, tempDir, sendPayload, updatePayload, extractMaterial, finalizeAnalysis } = await createModule();
    try {
      const file = createFileMessage("劳动仲裁材料.pdf");
      const fileResult = await module.handleMessage({
        message: file,
        routed: null,
      });

      expect(fileResult).toEqual({ claimed: false });

      const trigger = createTextMessage("按照这个文档，生成一个证据清单 Word，序号、证据名称、证据类型、页码、证明目的。");
      const triggerResult = await module.handleMessage({
        message: trigger,
        routed: routeIncomingText(trigger.plainText),
      });

      expect(triggerResult).toEqual({ claimed: true });
      expect(extractMaterial).toHaveBeenCalledTimes(1);
      expect(finalizeAnalysis).toHaveBeenCalledTimes(1);
      const finalizeCalls = finalizeAnalysis.mock.calls as unknown as Array<[input: { materialCount: number; notes: string[]; preferredTitle?: string }]>;
      expect(finalizeCalls[0]?.[0]).toEqual(expect.objectContaining({
        materialCount: 1,
        notes: [trigger.plainText],
      }));
      const payloadCalls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      expect(JSON.stringify(payloadCalls[0]?.[1] ?? {})).toContain("材料收集中");
      expect(JSON.stringify(payloadCalls[1]?.[1] ?? {})).toContain("材料分析进行中");
      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      expect(JSON.stringify(updatedPayloads.find((call) => JSON.stringify(call[2]).includes("材料分析完成"))?.[2] ?? {})).toContain("材料分析完成");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("runs authority search in the background and then reviews the completed workbench", async () => {
    const { module, tempDir, sendPayload, updatePayload, appendAuthoritySearch, finalizeReviewOnly } = await createModule();
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
      await module.handleMessage({ message: start, routed: routeIncomingText(start.plainText) });
      await module.handleMessage({ message: createFileMessage("证据1.pdf"), routed: null });
      const end = createTextMessage("/完成上传");
      await module.handleMessage({ message: end, routed: routeIncomingText(end.plainText) });

      expect(appendAuthoritySearch).toHaveBeenCalledTimes(1);
      expect(appendAuthoritySearch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        query: "劳动争议 违法解除",
      }));
      expect(finalizeReviewOnly).toHaveBeenCalledTimes(1);
      expect(finalizeReviewOnly).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        status: "completed",
        searchResult: expect.objectContaining({ query: "劳动争议 违法解除" }),
      }));
      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      const serializedUpdates = JSON.stringify(updatedPayloads.map((call) => call[2]));
      const sentPayloads = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      const serializedSends = JSON.stringify(sentPayloads.map((call) => call[1]));
      expect(serializedUpdates).toContain("材料分析完成");
      expect(serializedSends).toContain("二次审查进行中");
      expect(serializedUpdates).toContain("法条引用已完成独立校验");
      expect(serializedUpdates).toContain("二审状态");
      expect(serializedUpdates).toContain("需人工复核");
      expect(serializedUpdates).not.toContain("补充权威法规检索");
      expect(serializedUpdates).not.toContain("权威法规检索完成");
      expect(serializedUpdates).not.toContain("lark-table");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("does not mark completed labor analysis as failed when background authority search fails", async () => {
    const { module, tempDir, updatePayload, appendAuthoritySearch, finalizeReviewOnly, logger } = await createModule();
    appendAuthoritySearch.mockRejectedValueOnce(new Error("pkulaw timeout"));
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
      await module.handleMessage({ message: start, routed: routeIncomingText(start.plainText) });
      await module.handleMessage({ message: createFileMessage("证据1.pdf"), routed: null });

      await module.handleMessage({ message: createTextMessage("/完成上传"), routed: routeIncomingText("/完成上传") });

      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      const serializedUpdates = JSON.stringify(updatedPayloads.map((call) => call[2]));
      expect(serializedUpdates).toContain("材料分析完成");
      expect(serializedUpdates).not.toContain("劳动分析失败");
      expect(finalizeReviewOnly).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        status: "pending",
      }));
      expect(logger.log).toHaveBeenCalledWith("labor/authority", "background authority search failed", expect.objectContaining({
        detail: "pkulaw timeout",
      }), "warn");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("ignores stale authority card actions because labor authority search is now background-only", async () => {
    const { module, tempDir } = await createModule();
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
      await module.handleMessage({ message: start, routed: routeIncomingText(start.plainText) });
      await module.handleMessage({ message: createFileMessage("证据1.pdf"), routed: null });
      await module.handleMessage({ message: createTextMessage("/完成上传"), routed: routeIncomingText("/完成上传") });

      const response = await module.handleCardAction("ou_user", "om_card", {
        kind: "labor-authority-search",
        action: "confirm",
        conversationKey: start.conversationKey,
      });

      expect(response).toBeNull();
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("does not claim recent labor materials for summaries or knowledge-base ingestion", async () => {
    const { module, tempDir, extractMaterial, finalizeAnalysis } = await createModule();
    try {
      await module.handleMessage({
        message: createFileMessage("解除通知.pdf"),
        routed: null,
      });

      const summary = createTextMessage("帮我总结一下刚才的文件");
      const summaryResult = await module.handleMessage({
        message: summary,
        routed: routeIncomingText(summary.plainText),
      });
      expect(summaryResult).toEqual({ claimed: false });

      const knowledgeIngest = createTextMessage("把刚才的文件收入知识库");
      const knowledgeResult = await module.handleMessage({
        message: knowledgeIngest,
        routed: routeIncomingText(knowledgeIngest.plainText),
      });
      expect(knowledgeResult).toEqual({ claimed: false });
      expect(extractMaterial).not.toHaveBeenCalled();
      expect(finalizeAnalysis).not.toHaveBeenCalled();
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("exits gracefully when /完成上传 is sent without files or notes", async () => {
    const { module, tempDir, sendPayload, extractMaterial, finalizeAnalysis } = await createModule();
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });

      const end = createTextMessage("/完成上传");
      const result = await module.handleMessage({
        message: end,
        routed: routeIncomingText(end.plainText),
      });

      expect(result).toEqual({ claimed: true });
      expect(extractMaterial).not.toHaveBeenCalled();
      expect(finalizeAnalysis).not.toHaveBeenCalled();
      const payloadCalls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      expect(JSON.stringify(payloadCalls.at(-1)?.[1] ?? {})).toContain("当前没有可分析内容");
      expect(JSON.stringify(payloadCalls.at(-1)?.[1] ?? {})).toContain("已退出劳动分析模式");
      const interactions = (module as unknown as {
        interactions: { get(key: string): unknown };
      }).interactions;
      expect(interactions.get(start.conversationKey)).toBeUndefined();
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("keeps an unfinished collection when the same requester sends /案件工作台 again", async () => {
    const { module, tempDir, sendPayload, extractMaterial } = await createModule();
    try {
      const firstStart = createTextMessage("/案件工作台 第一次");
      await module.handleMessage({
        message: firstStart,
        routed: routeIncomingText(firstStart.plainText),
      });
      await module.handleMessage({
        message: createFileMessage("旧材料.pdf"),
        routed: null,
      });

      const secondStart = createTextMessage("/案件工作台 第二次");
      const secondResult = await module.handleMessage({
        message: secondStart,
        routed: routeIncomingText(secondStart.plainText),
      });

      expect(secondResult).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(2);
      const interactions = (module as unknown as {
        interactions: { get(key: string): { files: unknown[]; title?: string } | undefined };
      }).interactions;
      expect(interactions.get(firstStart.conversationKey)).toEqual(expect.objectContaining({
        title: "第一次",
        files: [expect.objectContaining({ fileName: "旧材料.pdf" })],
      }));
      const payloadCalls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      expect(JSON.stringify(payloadCalls.at(-1)?.[1] ?? {})).toContain("已有劳动分析正在收集");
      expect(extractMaterial).not.toHaveBeenCalled();
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("rejects a different requester from re-entering the same labor thread", async () => {
    const { module, tempDir, sendPayload } = await createModule();
    try {
      const start = createTextMessage("/案件工作台 第一次");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });

      const secondStart = createTextMessage("/案件工作台 第二次", { senderOpenId: "ou_other" });
      const result = await module.handleMessage({
        message: secondStart,
        routed: routeIncomingText(secondStart.plainText),
      });

      expect(result).toEqual({ claimed: true });
      const payloadCalls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
      expect(JSON.stringify(payloadCalls.at(-1)?.[1] ?? {})).toContain("当前劳动分析任务仅限发起人继续");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("updates the progress card with a failure when all material extraction fails", async () => {
    const { module, tempDir, updatePayload, extractMaterial, finalizeAnalysis } = await createModule();
    extractMaterial.mockRejectedValueOnce(new Error("OpenCode crashed"));
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });
      await module.handleMessage({
        message: createFileMessage("证据1.pdf"),
        routed: null,
      });
      const end = createTextMessage("/完成上传");
      await module.handleMessage({
        message: end,
        routed: routeIncomingText(end.plainText),
      });

      expect(finalizeAnalysis).not.toHaveBeenCalled();
      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      const failedSerialized = JSON.stringify(updatedPayloads.at(-1)?.[2] ?? {});
      expect(failedSerialized).toContain("劳动分析失败");
      expect(failedSerialized).toContain("OpenCode crashed");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("updates the progress card when final labor analysis fails", async () => {
    const { module, tempDir, updatePayload, finalizeAnalysis } = await createModule();
    finalizeAnalysis.mockRejectedValueOnce(new Error("analysis timeout"));
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });
      await module.handleMessage({
        message: createFileMessage("证据1.pdf"),
        routed: null,
      });
      const end = createTextMessage("/完成上传");
      await module.handleMessage({
        message: end,
        routed: routeIncomingText(end.plainText),
      });

      const updatedPayloads = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
      const failedSerialized = JSON.stringify(updatedPayloads.at(-1)?.[2] ?? {});
      expect(failedSerialized).toContain("劳动分析失败");
      expect(failedSerialized).toContain("analysis timeout");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("falls back to an error notice when labor progress card input violates the template schema", () => {
    const payload = buildLaborAnalysisProgressPayload({
      sourceLabel: "证据1.pdf",
      steps: [{ label: "读取内容", status: "invalid-status" }],
      elapsedMs: 1_000,
    } as never);

    expect(JSON.stringify(JSON.parse(payload.content))).toContain("劳动分析卡片渲染失败");
  });

  it("restores an unfinished interaction after restart", async () => {
    const { module, tempDir } = await createModule();
    try {
      const start = createTextMessage("/案件工作台 劳动争议演示");
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
