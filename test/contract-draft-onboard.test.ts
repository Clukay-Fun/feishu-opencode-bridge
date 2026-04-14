import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import { routeIncomingText } from "../src/bridge/router.js";
import { ContractAssistantRuntimeModule } from "../src/contract-assistant/runtime-module.js";
import type { IncomingChatMessage } from "../src/runtime/app.js";

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

function createModule() {
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
    return { messageId: "out-1" };
  });
  const updatePayload = vi.fn(async (
    chatId: string,
    messageId: string,
    payload: unknown,
    options: unknown,
  ) => {
    void chatId;
    void messageId;
    void payload;
    void options;
    return { messageId: "out-1" };
  });
  const listDraftTemplates = vi.fn(async () => ["委托代理合同-民事"]);
  const draftContract = vi.fn(async (request: string) => ({
    docTitle: "合同草稿",
    wordPath: "/tmp/bridge-test/contract.docx",
    docUrl: "https://example.com/doc",
    markdown: `### 合同草稿\n\n${request}`,
    recordId: "rec_1",
    warnings: [],
  }));
  const module = new ContractAssistantRuntimeModule({
    config: {
      storage: {
        dataDir: "/tmp/bridge-test",
      },
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
      listDraftTemplates,
      draftContract,
    } as never,
    sendPayload,
    updatePayload,
  });
  return {
    module,
    sendPayload,
    updatePayload,
    listDraftTemplates,
    draftContract,
  };
}

describe("ContractAssistantRuntimeModule onboard draft", () => {
  it("starts guided onboarding with explicit command", async () => {
    const { module, sendPayload, listDraftTemplates } = createModule();
    const message = createTextMessage("/起草合同 引导");
    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(listDraftTemplates).toHaveBeenCalledTimes(1);
    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendPayload.mock.calls[0]?.[1] ?? {})).toContain("请选择模板");
  });

  it("supports one-shot answer during onboarding", async () => {
    const { module, draftContract, updatePayload } = createModule();
    const start = createTextMessage("/contract-draft onboard");
    await module.handleMessage({
      message: start,
      routed: routeIncomingText(start.plainText),
    });

    const answer = createTextMessage("使用《委托代理合同-民事》模板，甲方房怡康；对方网新集团有限公司、安徽网新计算机有限公司；案由劳动争议；委托程序选择仲裁、调解和解；授权方式一般授权；收费模式按阶段收费；仲裁 8000；办案费用实报实销；承办律师王律师。");
    const result = await module.handleMessage({
      message: answer,
      routed: routeIncomingText(answer.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(draftContract).toHaveBeenCalledTimes(1);
    expect(draftContract.mock.calls[0]?.[0]).toContain("使用《委托代理合同-民事》模板");
    expect(draftContract.mock.calls[0]?.[0]).toContain("甲方为房怡康");
    expect(draftContract.mock.calls[0]?.[0]).toContain("收费模式选择：按阶段收费");
    expect(updatePayload).toHaveBeenCalledTimes(1);
  });

  it("supports numeric step-by-step answers", async () => {
    const { module, draftContract } = createModule();
    const start = createTextMessage("/起草合同 引导");
    await module.handleMessage({
      message: start,
      routed: routeIncomingText(start.plainText),
    });

    const answers = [
      "1",
      "1,5",
      "1",
      "1",
      "8000",
      "2",
      "甲方张三；对方李四；案由民间借贷纠纷",
      "王律师",
      "跳过",
    ];

    for (const text of answers) {
      const message = createTextMessage(text);
      await module.handleMessage({
        message,
        routed: routeIncomingText(message.plainText),
      });
    }

    expect(draftContract).toHaveBeenCalledTimes(1);
    const request = draftContract.mock.calls[0]?.[0] ?? "";
    expect(request).toContain("委托程序选择：仲裁阶段、调解/和解");
    expect(request).toContain("仲裁阶段律师费 8000 元");
    expect(request).toContain("办案费用承担方式选择：实报实销");
  });
});
