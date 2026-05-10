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

function createModule() {
  const sendPayload = vi.fn(async () => ({ messageId: "out-1" }));
  const updatePayload = vi.fn(async () => ({ messageId: "om_card" }));
  const startCaseWorkbenchCollection = vi.fn(async () => undefined);
  const module = new CaseWorkbenchRuntimeModule({
    logger: { log: vi.fn() } as never,
    transport: { sendPayload, updatePayload } as never,
    labor: { startCaseWorkbenchCollection },
  });
  return { module, sendPayload, updatePayload, startCaseWorkbenchCollection };
}

describe("CaseWorkbenchRuntimeModule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fast-paths /案件工作台 to labor collection while there is only one runnable domain", async () => {
    const { module, sendPayload, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("/案件工作台 王某违法解除");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(startCaseWorkbenchCollection).toHaveBeenCalledWith(message, "王某违法解除");
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("fast-paths explicit labor natural language to labor collection", async () => {
    const { module, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("帮我整理这批劳动仲裁材料，生成劳动争议工作台");

    const result = await module.handleMessage({
      message,
      routed: routeIncomingText(message.plainText),
    });

    expect(result).toEqual({ claimed: true });
    expect(startCaseWorkbenchCollection).toHaveBeenCalledWith(message, expect.stringContaining("劳动仲裁材料"));
  });

  it("sends the workbench entry card for generic workbench intent", async () => {
    const { module, sendPayload, startCaseWorkbenchCollection } = createModule();
    const message = createTextMessage("打开案件工作台");

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
    expect(payload).toContain("劳动法");
    expect(payload).toContain("公司法");
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
