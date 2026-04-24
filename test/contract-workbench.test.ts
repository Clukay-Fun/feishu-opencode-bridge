/**
 * 职责: 覆盖合同工作台初始化、编辑和状态流转。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import { routeIncomingText } from "../src/bridge/router.js";
import { ContractAssistantRuntimeModule } from "../src/contract-assistant/runtime-module.js";
import type { ContractState } from "../src/contract-assistant/index.js";
import type { IncomingChatMessage } from "../src/runtime/app.js";
import { createFeishuTransport } from "../src/runtime/feishu-transport.js";

function createTextMessage(text: string): IncomingChatMessage {
  return {
    chatId: "chat-1",
    chatType: "group",
    senderOpenId: "ou_user",
    messageId: `msg-${Math.random().toString(16).slice(2)}`,
    rawContent: text,
    plainText: text,
    threadKey: "thread-1",
    conversationKey: "chat-1:thread-1",
    messageType: "text",
  };
}

function createContractState(): ContractState {
  return {
    sessionId: "session-1",
    sourceMode: "freeform_prompt",
    title: "委托代理合同",
    parties: {
      clientName: "XXX",
      counterpartyName: "XXX公司",
    },
    clauses: [
      { id: "c1", number: "第一条", title: "委托事项", content: "甲方委托乙方处理劳动争议仲裁事宜。" },
    ],
    appendices: [],
    version: 1,
    history: [{ version: 1, summary: "初始化完成", at: "2026-04-15T00:00:00.000Z" }],
  };
}

async function createModule() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "contract-workbench-test-"));
  const sendPayload = vi.fn(async (
    chatId: string,
    payload: unknown,
    options: unknown,
    delivery?: unknown,
  ) => {
    void chatId;
    void payload;
    void options;
    void delivery;
    return { messageId: `out-${Math.random().toString(16).slice(2)}` };
  });
  const updatePayload = vi.fn(async (
    chatId: string,
    messageId: string,
    payload: unknown,
    options: unknown,
  ) => {
    void chatId;
    void payload;
    void options;
    return { messageId };
  });
  const initializeWorkbenchFromPrompt = vi.fn(async () => ({
    state: createContractState(),
    message: "已根据文字描述初始化合同。",
  }));
  const initializeWorkbenchFromDocument = vi.fn(async () => ({
    state: createContractState(),
    message: "已根据上传文件初始化合同。",
  }));
  const applyWorkbenchMessage = vi.fn(async () => ({
    action: "update",
    message: "已删除风险收费部分。",
    updatedState: {
      ...createContractState(),
      clauses: [
        { id: "c1", number: "第一条", title: "委托事项", content: "甲方委托乙方处理劳动争议仲裁事宜。" },
        { id: "c2", number: "第二条", title: "收费方式", content: "按阶段收费。" },
      ],
    },
  }));
  const exportWorkbenchWord = vi.fn(async () => ({ wordPath: path.join(tempDir, "draft.docx") }));

  const module = new ContractAssistantRuntimeModule({
    config: {
      storage: { dataDir: tempDir },
      contractAssistant: {
        enabled: true,
        storage: {
          baseToken: "app_token",
          contractTableId: "tbl_contract",
          invoiceTableId: "tbl_invoice",
          caseTableId: "tbl_case",
        },
        models: {},
        ingest: {
          contractAllowedExtensions: [".pdf", ".docx", ".txt", ".md"],
          invoiceAllowedExtensions: [".pdf", ".png"],
          maxFileSizeMb: 20,
          pendingTtlMs: 60_000,
        },
        reminder: {
          enabled: false,
          targetChatIds: [],
          hour: 9,
          minute: 0,
          lookaheadDays: 7,
        },
      },
    } as unknown as AppConfig,
    logger: { log: vi.fn() } as never,
    service: {
      initializeWorkbenchFromPrompt,
      initializeWorkbenchFromDocument,
      applyWorkbenchMessage,
      exportWorkbenchWord,
    } as never,
    transport: createFeishuTransport({
      sendPayload: sendPayload as never,
      updatePayload: updatePayload as never,
    }),
  });

  return {
    tempDir,
    module,
    sendPayload,
    updatePayload,
    initializeWorkbenchFromPrompt,
    initializeWorkbenchFromDocument,
    applyWorkbenchMessage,
    exportWorkbenchWord,
  };
}

async function cleanupModule(module: ContractAssistantRuntimeModule, tempDir: string): Promise<void> {
  await module.stop();
  await rm(tempDir, { recursive: true, force: true });
}

describe("ContractAssistantRuntimeModule contract workbench", () => {
  it("shows a retirement notice for the legacy /contract-workbench alias", async () => {
    const { module, sendPayload, tempDir } = await createModule();
    try {
      const message = createTextMessage("/contract-workbench");
      const result = await module.handleMessage({
        message,
        routed: routeIncomingText(message.plainText),
      });

      expect(result).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((sendPayload.mock.calls[0] ?? [])[1] ?? {})).toContain("命令已更新");
      expect(JSON.stringify((sendPayload.mock.calls[0] ?? [])[1] ?? {})).toContain("/合同起草开始");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("starts a dedicated contract workbench session", async () => {
    const { module, sendPayload, tempDir } = await createModule();
    try {
      const message = createTextMessage("/合同起草开始");
      const result = await module.handleMessage({
        message,
        routed: routeIncomingText(message.plainText),
      });

      expect(result).toEqual({ claimed: true });
      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((sendPayload.mock.calls[0] ?? [])[1] ?? {})).toContain("已进入合同起草会话");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("initializes state from freeform text inside workbench session", async () => {
    const { module, initializeWorkbenchFromPrompt, updatePayload, tempDir } = await createModule();
    try {
      const start = createTextMessage("/合同起草开始");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });

      const input = createTextMessage("帮我起草一份劳动仲裁委托代理合同，甲方 XXX，对方 XXX公司。");
      const result = await module.handleMessage({
        message: input,
        routed: routeIncomingText(input.plainText),
      });

      expect(result).toEqual({ claimed: true });
      expect(initializeWorkbenchFromPrompt).toHaveBeenCalledTimes(1);
      expect(updatePayload).toHaveBeenCalled();
    } finally {
      await cleanupModule(module, tempDir);
    }
  });

  it("applies update actions during active workbench session", async () => {
    const { module, applyWorkbenchMessage, sendPayload, tempDir } = await createModule();
    try {
      const start = createTextMessage("/合同起草开始 帮我起草一份劳动仲裁委托代理合同");
      await module.handleMessage({
        message: start,
        routed: routeIncomingText(start.plainText),
      });

      const input = createTextMessage("删除风险收费部分");
      const result = await module.handleMessage({
        message: input,
        routed: routeIncomingText(input.plainText),
      });

      expect(result).toEqual({ claimed: true });
      expect(applyWorkbenchMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((sendPayload.mock.calls.at(-1) ?? [])[1] ?? {})).toContain("合同已更新");
    } finally {
      await cleanupModule(module, tempDir);
    }
  });
});
