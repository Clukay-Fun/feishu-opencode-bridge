import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/schema.js";
import { routeIncomingText } from "../src/bridge/router.js";
import { ContractAssistantRuntimeModule } from "../src/contract-assistant/runtime-module.js";
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

function createFileMessage(fileName: string): IncomingChatMessage {
  return {
    chatId: "chat-1",
    chatType: "group",
    senderOpenId: "ou_user",
    messageId: `msg-${Math.random().toString(16).slice(2)}`,
    rawContent: fileName,
    plainText: fileName,
    threadKey: "thread-1",
    conversationKey: "chat-1:thread-1",
    messageType: "file",
    file: {
      fileKey: "file_1",
      fileName,
      size: 1024,
    },
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
  const draftContract = vi.fn(async (
    request: string,
    optionsOrProgress?: { requesterOpenId?: string | undefined } | ((stage: string, detail?: string) => Promise<void> | void),
    maybeOnProgress?: (stage: string, detail?: string) => Promise<void> | void,
  ) => {
    const onProgress = typeof optionsOrProgress === "function" ? optionsOrProgress : maybeOnProgress;
    await onProgress?.("parse-request", "正在解析起草需求");
    await onProgress?.("match-template", "正在匹配合同模板");
    await onProgress?.("prepare-fields", "正在整理关键字段");
    await onProgress?.("generate-word", "正在使用模板填充变量并生成文档");
    await onProgress?.("sync-artifacts", "正在同步合同台账记录");
    return {
      docTitle: "合同草稿",
      wordPath: path.join(process.cwd(), "data/contract-drafts/contract.docx"),
      markdown: `### 合同草稿\n\n${request}`,
      recordId: "rec_1",
      warnings: [],
    };
  });
  const createCase = vi.fn(async (request: string) => ({
    summary: `已整理案件：${request}`,
    recordId: "rec_case_1",
    record: {
      类型: "劳动争议",
      案由: "违法解除劳动合同争议",
      委托人: "张三",
      对方当事人: "北京XX科技有限公司",
      审理法院: "朝阳区劳动仲裁委员会",
      程序阶段: ["劳动仲裁"],
      承办律师: "刘达律师",
      开庭日: "2026-04-18 09:30",
      举证截止日: "2026-04-17",
    },
  }));
  const recognizeInvoice = vi.fn(async () => ({
    summary: "付款方 张三，身份证号 110101199001010011，增值税普通发票，项目 诉讼代理律师费",
    recordId: "rec_invoice_1",
    record: {
      付款方: "张三",
      发票号: "032001900104",
      开票日期: "2026-04-10",
      发票金额: 20000,
    },
    matchedContract: "委托代理合同（张三 vs 北京XX科技）",
  }));
  const listReminderItems = vi.fn(async () => ({
    contractLines: ["委托代理合同：未收款 ¥10000，未开票 ¥0；付款节点：04-20"],
    invoiceLines: [],
    caseLines: [
      "张三劳动争议案：举证截止日 2026-04-17；当前状态 进行中；待做事项 需补充工资流水证据",
      "张三劳动争议案：开庭日 2026-04-18 09:30；当前状态 进行中；待做事项 需补充工资流水证据",
      "张三劳动争议案：待做事项 社保缴纳记录待获取；截止 2026-04-25；当前状态 进行中",
    ],
  }));
  const addCaseReminder = vi.fn(async (request: string) => ({
    matchedLabel: "张某某 vs 杭州XX科技有限公司 劳动争议",
    recordId: "rec_case_1",
    reminderLabel: request.includes("开庭") ? "开庭日" : "举证截止日",
    reminderDate: request.includes("09:30") ? "2026-04-18 09:30" : "2026-04-18",
    todo: "补充工资流水证据",
    fields: {
      举证截止日: new Date(2026, 3, 18).getTime(),
      待做事项: "补充工资流水证据",
    },
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
      createCase,
      recognizeInvoice,
      listReminderItems,
      addCaseReminder,
    } as never,
    transport: createFeishuTransport({
      sendPayload: sendPayload as never,
      updatePayload: updatePayload as never,
    }),
  });
  return {
    module,
    sendPayload,
    updatePayload,
    listDraftTemplates,
    draftContract,
    createCase,
    recognizeInvoice,
    listReminderItems,
    addCaseReminder,
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

  it("renders optimized case create processing and completed cards", async () => {
    const { module, sendPayload, updatePayload, createCase } = createModule();
    const message = createTextMessage("/案件录入 张三与北京XX科技有限公司劳动争议，朝阳区劳动仲裁委员会，承办律师刘达律师");
    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(createCase).toHaveBeenCalledTimes(1);

    const processingSerialized = JSON.stringify(sendPayload.mock.calls[0]?.[1] ?? {});
    const completedSerialized = JSON.stringify(updatePayload.mock.calls[0]?.[2] ?? {});
    const completedCard = JSON.parse((updatePayload.mock.calls[0]?.[2] as { content?: string })?.content ?? "{}");
    expect(processingSerialized).toContain("案件信息录入中");
    expect(processingSerialized).toContain("正在解析案件信息");
    expect(processingSerialized).toContain("提取字段：进行中");
    expect(processingSerialized).toContain("写入案件管理表：等待中");
    expect(completedSerialized).toContain("案件已录入");
    expect(completedSerialized).toContain("张三 vs 北京XX科技有限公司");
    expect(completedSerialized).toContain("劳动争议｜劳动仲裁");
    expect(completedSerialized).toContain("违法解除劳动合同争议");
    expect(completedSerialized).toContain("刘达律师");
    expect(completedSerialized).toContain("案件管理表");
    expect(completedSerialized).toContain("rec_case_1");
    expect(completedSerialized).toContain("开庭日 2026-04-18 09:30");
    expect(completedSerialized).toContain("举证截止日 2026-04-17");
    expect((completedCard.body?.elements ?? []).some((item: { tag?: string }) => item.tag === "column")).toBe(false);
  });

  it("keeps completed steps visible on contract draft card", async () => {
    const { module, sendPayload, updatePayload, draftContract } = createModule();
    const message = createTextMessage("/起草合同 甲方 张三，对方 北京XX科技，案由 劳动争议，劳动仲裁，律师费 20000 元");
    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(draftContract).toHaveBeenCalledTimes(1);

    const initialSerialized = JSON.stringify(sendPayload.mock.calls.at(-1)?.[1] ?? {});
    const finalSerialized = JSON.stringify(updatePayload.mock.calls.at(-1)?.[2] ?? {});
    expect(initialSerialized).toContain("合同起草");
    expect(initialSerialized).toContain("委托代理合同");
    expect(initialSerialized).toContain("劳动争议｜劳动仲裁");
    expect(initialSerialized).toContain("律师费：¥20,000");
    expect(finalSerialized).toContain("合同起草完成");
    expect(finalSerialized).toContain("已完成解析起草需求");
    expect(finalSerialized).toContain("已完成匹配合同模板");
    expect(finalSerialized).toContain("已完成整理关键字段");
    expect(finalSerialized).toContain("已完成使用模板填充变量并生成文档");
    expect(finalSerialized).toContain("已完成同步合同台账记录");
    expect(finalSerialized).toContain("/contract.docx");
    expect(finalSerialized).toContain("合同台账记录：打开记录");
    expect(finalSerialized).toContain("耗时：");
  });

  it("uses demo one-shot contract data in the draft card and request", async () => {
    const { module, sendPayload, draftContract } = createModule();
    const request = "/起草合同 使用《委托代理合同-民事》模板。甲方张某某，身份证号330100199003010011，住址杭州市西湖区文三路附近，联系电话13800000000；对方为杭州XX科技有限公司；案由为违法解除劳动合同争议；委托程序选择劳动仲裁、调解和解；授权方式为一般授权；收费模式为按阶段收费，仲裁阶段律师费20000元，办案费用实报实销；承办律师刘达律师；特别约定：AI 生成文本仅作为合同草稿，需经承办律师复核后签署。";

    const result = await module.handleMessage({
      message: createTextMessage(request),
      routed: routeIncomingText(request),
    });

    expect(result).toEqual({ claimed: true });
    expect(draftContract).toHaveBeenCalledTimes(1);
    expect(draftContract.mock.calls[0]?.[0]).toContain("甲方张某某");
    expect(draftContract.mock.calls[0]?.[0]).toContain("身份证号330100199003010011");
    expect(draftContract.mock.calls[0]?.[0]).toContain("办案费用实报实销");
    const initialSerialized = JSON.stringify(sendPayload.mock.calls.at(-1)?.[1] ?? {});
    expect(initialSerialized).toContain("委托代理合同（张某某 vs 杭州XX科技有限公司）");
    expect(initialSerialized).toContain("违法解除劳动合同争议｜劳动仲裁");
    expect(initialSerialized).toContain("律师费：¥20,000");
  });

  it("supports one-shot answer during onboarding", async () => {
    const { module, sendPayload, draftContract, updatePayload } = createModule();
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
    const processingSerialized = JSON.stringify(sendPayload.mock.calls.at(-1)?.[1] ?? {});
    expect(processingSerialized).toContain("委托代理合同（房怡康 vs 网新集团有限公司、安徽网新计算机有限公司）");
    expect(processingSerialized).toContain("劳动争议｜仲裁");
    expect(processingSerialized).toContain("律师费：¥8,000");
    expect(processingSerialized).not.toContain("委托人 vs 相关单位");
    expect(updatePayload.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("merges invoice processing and completed card", async () => {
    const { module, sendPayload, updatePayload, recognizeInvoice } = createModule();
    const start = createTextMessage("/识别发票");
    await module.handleMessage({
      message: start,
      routed: routeIncomingText(start.plainText),
    });

    const file = createFileMessage("invoice.pdf");
    const result = await module.handleMessage({
      message: file,
      routed: null,
      pendingInteraction: null,
    });

    expect(result).toEqual({ claimed: true });
    expect(recognizeInvoice).toHaveBeenCalledTimes(1);

    const initialSerialized = JSON.stringify(sendPayload.mock.calls.at(-1)?.[1] ?? {});
    const finalSerialized = JSON.stringify(updatePayload.mock.calls.at(-1)?.[2] ?? {});
    expect(initialSerialized).toContain("发票识别");
    expect(initialSerialized).toContain("正在 OCR 识别发票内容");
    expect(initialSerialized).toContain("等待填写表格");
    expect(initialSerialized).not.toContain("正在填写表格");
    expect(finalSerialized).toContain("发票识别完成");
    expect(finalSerialized).not.toContain("正在 OCR 识别发票内容");
    expect(finalSerialized).toContain("购买方信息");
    expect(finalSerialized).toContain("张三");
    expect(finalSerialized).toContain("110101199001010011");
    expect(finalSerialized).toContain("发票信息");
    expect(finalSerialized).toContain("032001900104");
    expect(finalSerialized).toContain("增值税普通发票");
    expect(finalSerialized).toContain("¥20,000.00");
    expect(finalSerialized).toContain("2026-04-10");
    expect(finalSerialized).toContain("诉讼代理律师费");
    expect(finalSerialized).toContain("查看发票表");
    expect(finalSerialized).toContain("耗时：");
  });

  it("falls back to request fields when case create response misses display fields", async () => {
    const { module, updatePayload, createCase } = createModule();
    createCase.mockResolvedValueOnce({
      summary: "已整理案件管理字段。",
      recordId: "rec_case_sparse",
      record: {},
    } as any);

    const request = "/案件录入 类型劳动仲裁，案由违法解除劳动合同争议，委托人张某某，对方当事人杭州XX科技有限公司，受理机构杭州市西湖区劳动人事争议仲裁委员会，程序阶段劳动仲裁，案件状态证据整理中，承办律师刘达律师。";
    const result = await module.handleMessage({
      message: createTextMessage(request),
      routed: routeIncomingText(request),
    });

    expect(result).toEqual({ claimed: true });
    const completedSerialized = JSON.stringify(updatePayload.mock.calls.at(-1)?.[2] ?? {});
    expect(completedSerialized).toContain("张某某 vs 杭州XX科技有限公司");
    expect(completedSerialized).toContain("劳动仲裁｜仲裁阶段");
    expect(completedSerialized).toContain("劳动争议");
    expect(completedSerialized).toContain("杭州市西湖区劳动人事争议仲裁委员会");
    expect(completedSerialized).toContain("刘达");
    expect(completedSerialized).toContain("进行中");
    expect(completedSerialized).not.toContain("委托人 vs 对方当事人");
  });

  it("renders reminder progress and today todo cards", async () => {
    const { module, sendPayload, updatePayload, listReminderItems } = createModule();
    const now = new Date();
    const moduleAny = module as any;
    moduleAny.featureConfig.reminder.targetChatIds = ["chat-reminder"];
    moduleAny.featureConfig.reminder.hour = now.getHours();
    moduleAny.featureConfig.reminder.minute = now.getMinutes();

    await moduleAny.tickReminders();

    expect(listReminderItems).toHaveBeenCalledTimes(1);
    const progressSerialized = JSON.stringify(sendPayload.mock.calls.at(-1)?.[1] ?? {});
    const todoSerialized = JSON.stringify(updatePayload.mock.calls.at(-1)?.[2] ?? {});
    expect(progressSerialized).toContain("案件提醒");
    expect(progressSerialized).toContain("正在检索关联案件与待办事项");
    expect(todoSerialized).toContain("今日待办");
    expect(todoSerialized).toContain("举证期限截止");
    expect(todoSerialized).toContain("开庭提醒");
    expect(todoSerialized).toContain("合同付款");
    expect(todoSerialized).toContain("证据补充");
    expect(todoSerialized).toContain("2026-04-25");
    expect(todoSerialized).toContain("发送 /提醒 详情 查看全部");
  });

  it("adds a case reminder with a direct command", async () => {
    const { module, sendPayload, updatePayload, addCaseReminder } = createModule();
    const request = "/添加案件提醒 举证截止日 2026-04-18 待做事项 补充工资流水证据";
    const result = await module.handleMessage({
      message: createTextMessage(request),
      routed: routeIncomingText(request),
    });

    expect(result).toEqual({ claimed: true });
    expect(addCaseReminder).toHaveBeenCalledWith("举证截止日 2026-04-18 待做事项 补充工资流水证据");
    expect(JSON.stringify(sendPayload.mock.calls.at(-1)?.[1] ?? {})).toContain("案件提醒添加中");
    const completedSerialized = JSON.stringify(updatePayload.mock.calls.at(-1)?.[2] ?? {});
    expect(completedSerialized).toContain("案件提醒已添加");
    expect(completedSerialized).toContain("张某某 vs 杭州XX科技有限公司");
    expect(completedSerialized).toContain("举证截止日 2026-04-18");
    expect(completedSerialized).toContain("补充工资流水证据");
    expect(completedSerialized).toContain("发送 `/案件提醒`");
  });

  it("shows short Word path and hides doc link in direct draft completion card", async () => {
    const { module, updatePayload } = createModule();
    const message = createTextMessage("/起草合同 甲方（委托人）：张三，身份证号：110101199001010011，住址：北京市朝阳区建国路88号，联系电话：13800000000。甲方因与相关单位发生劳动争议，现委托乙方作为其代理人，代理处理劳动仲裁相关事宜。双方经协商一致，确认本次代理事项为劳动仲裁，代理费用为人民币20,000元（大写：贰万元整）。");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    const completedSerialized = JSON.stringify(updatePayload.mock.calls.at(-1)?.[2] ?? {});
    expect(completedSerialized).toContain("feishu-opencode-bridge/data/contract-drafts/contract.docx");
    expect(completedSerialized).not.toContain("飞书文档");
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
