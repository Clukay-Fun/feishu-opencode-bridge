/**
 * 职责: 覆盖案件工作台统一入口运行时模块。
 * 关注点:
 * - 验证单领域 fast-path 与泛化入口分流。
 * - 验证入口卡按钮权限与劳动模块移交契约。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { routeIncomingText } from "../src/bridge/router.js";
import { CaseWorkbenchRuntimeModule } from "../src/case-workbench/runtime-module.js";
import type { IncomingChatMessage } from "../src/runtime/app.js";

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

function createModule(contextStore?: {
  restore: () => Promise<void>;
  stop: () => Promise<void>;
  findRecent: (input: { userId: string; conversationKey?: string | undefined; chatId?: string | undefined }) => unknown;
}, docReader?: (text: string) => Promise<string[]>) {
  const sendPayload = vi.fn(async () => ({ messageId: "out-1" }));
  const updatePayload = vi.fn(async () => ({ messageId: "om_card" }));
  const startCaseWorkbenchCollection = vi.fn(async () => undefined);
  const module = new CaseWorkbenchRuntimeModule({
    logger: { log: vi.fn() } as never,
    transport: { sendPayload, updatePayload } as never,
    labor: { startCaseWorkbenchCollection },
    contextStore: contextStore as never,
    docReader: docReader as never,
  });
  return { module, sendPayload, updatePayload, startCaseWorkbenchCollection };
}

describe("CaseWorkbenchRuntimeModule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the workbench entry card for /案件工作台", async () => {
    const { module, sendPayload, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("/案件工作台 王某违法解除");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(startCaseWorkbenchCollection).not.toHaveBeenCalled();
    expect(sendPayload).toHaveBeenCalledTimes(1);
    const calls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
    const payload = JSON.stringify(calls[0]?.[1] ?? {});
    expect(payload).toContain("案件工作台已开启");
    expect(payload).toContain("请选择你需要分析的领域");
    expect(payload).toContain("王某违法解除");
  });

  it("does not pass the 新建 control word as the labor case title", async () => {
    const { module, sendPayload, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("/案件工作台 新建 王某违法解除");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(startCaseWorkbenchCollection).not.toHaveBeenCalled();
    const calls = sendPayload.mock.calls as unknown as Array<[string, unknown]>;
    const payload = JSON.stringify(calls[0]?.[1] ?? {});
    expect(payload).toContain("王某违法解除");
    expect(payload).not.toContain("新建 王某违法解除");
  });

  it("does not start labor collection from natural-language labor text", async () => {
    const { module, sendPayload, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("帮我整理这批劳动仲裁材料，生成劳动争议工作台");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: false });
    expect(sendPayload).not.toHaveBeenCalled();
    expect(startCaseWorkbenchCollection).not.toHaveBeenCalled();
  });

  it("does not start the workbench from natural-language generic workbench text", async () => {
    const { module, sendPayload, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("打开案件工作台");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: false });
    expect(startCaseWorkbenchCollection).not.toHaveBeenCalled();
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("does not hijack low-confidence document requests", async () => {
    const { module, sendPayload, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("帮我总结一下刚才的文件");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: false });
    expect(sendPayload).not.toHaveBeenCalled();
    expect(startCaseWorkbenchCollection).not.toHaveBeenCalled();
  });

  it("injects recent case workbench context before ordinary drafting turns", async () => {
    const contextStore = {
      restore: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      findRecent: vi.fn(() => ({
        caseId: "case_1",
        title: "张三劳动争议案",
        userId: "ou_user",
        chatId: "chat-1",
        conversationKey: "chat-1:thread-1",
        source: "labor",
        docUrl: "https://example.com/doc",
        markdown: "# 工作台\n\n违法解除争议分析",
        summary: "违法解除劳动争议",
        issues: ["违法解除"],
        claimBasis: ["赔偿金｜劳动合同法第八十七条"],
        evidence: ["解除通知｜证明解除事实"],
        missingEvidence: ["工资流水原件"],
        updatedAt: Date.now(),
      })),
    };
    const { module } = createModule(contextStore);

    const result = await module.beforeTurn?.({
      turn: {
        plainText: "请根据当前案件分析结果生成仲裁申请书",
        senderOpenId: "ou_user",
        conversationKey: "chat-1:thread-1",
        chatId: "chat-1",
      },
    } as never);

    expect(contextStore.findRecent).toHaveBeenCalledWith({
      userId: "ou_user",
      conversationKey: "chat-1:thread-1",
      chatId: "chat-1",
    });
    const block = result?.systemBlocks?.join("\n") ?? "";
    expect(block).toContain("[Current Case Workbench Context]");
    expect(block).toContain("张三劳动争议案");
    expect(block).toContain("违法解除争议分析");
    expect(block).toContain("赔偿金｜劳动合同法第八十七条");
  });

  it("injects referenced Feishu template documents into ordinary turns", async () => {
    const docReader = vi.fn(async () => [
      [
        "[Referenced Feishu Document]",
        "来源：https://example.feishu.cn/docx/template",
        "仲裁申请书模板正文",
      ].join("\n"),
    ]);
    const { module } = createModule(undefined, docReader);

    const result = await module.beforeTurn?.({
      turn: {
        plainText: "请按照这个模板生成材料：https://example.feishu.cn/docx/template",
        senderOpenId: "ou_user",
        conversationKey: "chat-1:thread-1",
        chatId: "chat-1",
      },
    } as never);

    expect(docReader).toHaveBeenCalledWith(
      "请按照这个模板生成材料：https://example.feishu.cn/docx/template",
      expect.anything(),
    );
    expect(result?.systemBlocks?.join("\n")).toContain("仲裁申请书模板正文");
  });

  it("only lets the requester operate the workbench entry card", async () => {
    const { module, updatePayload, startCaseWorkbenchCollection } = createModule();

    const rejected = await module.handleCardAction("ou_other", "om_card", {
      kind: "case-workbench-action",
      action: "start-material-collection",
      requesterOpenId: "ou_user",
      chatId: "chat-1",
      chatType: "group",
      conversationKey: "chat-1:thread-1",
    });
    expect(rejected).toEqual({ toast: { type: "warning", content: "只有工作台发起人可以操作。" } });
    expect(startCaseWorkbenchCollection).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const accepted = await module.handleCardAction("ou_user", "om_card", {
      kind: "case-workbench-action",
      action: "start-material-collection",
      requesterOpenId: "ou_user",
      chatId: "chat-1",
      chatType: "group",
      conversationKey: "chat-1:thread-1",
    });
    expect(accepted).toEqual({ toast: { type: "success", content: "已进入材料收集。" } });
    expect(startCaseWorkbenchCollection).not.toHaveBeenCalled();
    expect(updatePayload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(updatePayload).toHaveBeenCalledWith(
      "chat-1",
      "om_card",
      expect.objectContaining({ msg_type: "interactive" }),
      expect.objectContaining({ event: "case workbench entry acknowledged" }),
    );
    const updateCalls = updatePayload.mock.calls as unknown as Array<[string, string, unknown]>;
    expect(JSON.stringify(updateCalls[0]?.[2] ?? {})).toContain("案件工作台已进入材料收集");
    expect(JSON.stringify(updateCalls[0]?.[2] ?? {})).toContain("新的收集卡片");
    expect(startCaseWorkbenchCollection).toHaveBeenCalledWith({
      chatId: "chat-1",
      chatType: "group",
      messageId: "om_card",
      conversationKey: "chat-1:thread-1",
      senderOpenId: "ou_user",
    });
  });

  it("passes the case title from the entry card action to labor collection", async () => {
    vi.useFakeTimers();
    const { module, startCaseWorkbenchCollection } = createModule();

    await module.handleCardAction("ou_user", "om_card", {
      kind: "case-workbench-action",
      action: "start-material-collection",
      requesterOpenId: "ou_user",
      chatId: "chat-1",
      chatType: "group",
      conversationKey: "chat-1:thread-1",
      title: "王某违法解除",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(startCaseWorkbenchCollection).toHaveBeenCalledWith({
      chatId: "chat-1",
      chatType: "group",
      messageId: "om_card",
      conversationKey: "chat-1:thread-1",
      senderOpenId: "ou_user",
    }, "王某违法解除");
  });

  it("still starts material collection when entry card update fails", async () => {
    vi.useFakeTimers();
    const { module, updatePayload, startCaseWorkbenchCollection } = createModule();
    updatePayload.mockRejectedValueOnce(new Error("Feishu 200341"));

    const accepted = await module.handleCardAction("ou_user", "om_card", {
      kind: "case-workbench-action",
      action: "start-material-collection",
      requesterOpenId: "ou_user",
      chatId: "chat-1",
      chatType: "group",
      conversationKey: "chat-1:thread-1",
    });

    expect(accepted).toEqual({ toast: { type: "success", content: "已进入材料收集。" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updatePayload).toHaveBeenCalled();
    expect(startCaseWorkbenchCollection).toHaveBeenCalledWith({
      chatId: "chat-1",
      chatType: "group",
      messageId: "om_card",
      conversationKey: "chat-1:thread-1",
      senderOpenId: "ou_user",
    });
  });
});
