import { describe, expect, it } from "vitest";

import {
  buildKnowledgeIngestFailurePayload,
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestPayload,
  buildKnowledgeIngestQueuedPayload,
  buildKnowledgeIngestSessionFinalPayload,
  buildKnowledgeIngestSessionPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
  buildNoticeCardPayload,
  buildLeaveCommandCardPayload,
  buildPostMarkdownPayload,
  buildPostPayload,
  buildPermissionRequestCardPayload,
  buildSessionListCardPayload,
  buildSessionTransitionCardPayload,
  buildStatusCommandCardPayload,
  buildTurnStatusCardPayload,
  buildWhoCommandCardPayload,
} from "../src/feishu/formatter.js";

describe("buildPostPayload", () => {
  it("renders a post message payload", () => {
    const payload = buildPostPayload("", "你好，世界");
    const content = JSON.parse(payload.content) as { zh_cn: { title: string; content: Array<Array<{ tag: string; text: string }>> } };
    expect(payload.msg_type).toBe("post");
    expect(content.zh_cn.content[0]?.[0]?.text).toBe("你好，世界");
  });

  it("renders markdown post payload", () => {
    const payload = buildPostMarkdownPayload("[打开链接](https://example.com)");
    const content = JSON.parse(payload.content) as { zh_cn: { content: Array<Array<{ tag: string; text: string }>> } };
    expect(content.zh_cn.content[0]?.[0]?.text).toContain("https://example.com");
  });

  it("renders an interactive turn status card", () => {
    const payload = buildTurnStatusCardPayload({
      title: "处理中",
      status: "处理中",
      sessionId: "ses_1234567890",
      durationText: "约 8s",
      progressUpdates: ["已检索相关信息", "最终回复已生成（605 字）"],
      toolUpdates: [
        { label: "读取文件", detail: "package.json", status: "completed" },
        { label: "执行命令", detail: "npm run dev", status: "running" },
      ],
      output: {
        text: "工业和信息化部办公厅关于开展普惠算力赋能中小企业发展专项行动的通知，链接：https://www.miit.gov.cn/example",
        paths: ["C:\\Users\\LENOVO\\Desktop\\今日新闻五条_正式版.md"],
        commands: [],
      },
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(content.header.title.content).toBe("正在忙");
    expect(serialized).toContain("读取文件");
    expect(serialized).toContain("package.json");
    expect(serialized).toContain("执行命令");
    expect(serialized).toContain("npm run dev");
    expect(serialized).toContain("https://www.miit.gov.cn/example");
    expect(serialized).toContain("今日新闻五条_正式版.md");
    expect(serialized).toContain("约 8s");
  });

  it("preserves fenced code blocks without escaping arrows", () => {
    const payload = buildTurnStatusCardPayload({
      title: "处理中",
      status: "处理中",
      sessionId: "ses_1234567890",
      durationText: "约 3s",
      progressUpdates: [],
      toolUpdates: [],
      output: {
        text: [
          "## 消息处理",
          "",
          "```text",
          "飞书事件 -> ws.ts handleEvent()",
          "  -> app.handleIncomingMessage()",
          "```",
        ].join("\n"),
        paths: [],
        commands: [],
      },
    });
    const content = JSON.parse(payload.content) as any;
    const output = content.body.elements[0].columns[0].elements[0].content as string;

    expect(output).toContain("```text");
    expect(output).toContain("飞书事件 -> ws.ts handleEvent()");
    expect(output).not.toContain("-&gt;");
  });

  it("neutralizes markdown tables in turn output so Feishu cards do not create table elements", () => {
    const payload = buildTurnStatusCardPayload({
      title: "已完成",
      status: "已完成",
      sessionId: "ses_1234567890",
      durationText: "约 8s",
      progressUpdates: ["最终回复已生成"],
      toolUpdates: [],
      output: {
        text: [
          "| 项目 | 结论 |",
          "| --- | --- |",
          "| 劳动关系 | 证据较强 |",
          "| 加班费 | 需要补证 |",
        ].join("\n"),
        paths: [],
        commands: [],
      },
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);

    expect(serialized).not.toContain("| --- | --- |");
    expect(serialized).toContain("项目 ｜ 结论");
    expect(serialized).toContain("劳动关系 ｜ 证据较强");
  });

  it("renders all tool updates without truncating the toolbar", () => {
    const payload = buildTurnStatusCardPayload({
      title: "处理中",
      status: "处理中",
      sessionId: "ses_toolbar",
      durationText: "",
      progressUpdates: ["已开始处理"],
      toolUpdates: [
        { label: "读取文件", detail: "a.ts", status: "completed" },
        { label: "执行命令", detail: "npm test", status: "running" },
        { label: "抓取网页", detail: "https://example.com", status: "completed" },
        { label: "应用补丁", detail: "formatter.ts", status: "pending" },
      ],
      output: {
        text: "处理中...",
        paths: [],
        commands: [],
      },
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);

    expect(serialized).toContain("读取文件");
    expect(serialized).toContain("执行命令");
    expect(serialized).toContain("抓取网页");
    expect(serialized).toContain("应用补丁");
  });

  it("renders a status command card", () => {
    const payload = buildStatusCommandCardPayload({
      currentSession: {
        sessionId: "ses_2988a201effeCaZpLXXjarY0pM",
        label: "能不能获取舆论新闻",
      },
      connectionState: "connected",
      sessionMode: "multi",
      interactionMode: "知识库模式",
      sessionState: "idle",
      queueState: "空闲",
      pendingCount: 0,
      windowCount: 1,
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("会话状态");
    expect(content.header.template).toBe("wathet");
    expect(content.body.elements[0].columns[0].elements[0].content).toBe("**当前会话**");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[0].content).toContain("ses_2988a201effeCaZpLXXjarY0pM");
    expect(content.body.elements[1].columns[0].elements[1].columns).toHaveLength(6);
    expect(content.body.elements[1].columns[0].elements[1].columns[0].elements[0].content).toBe("connected");
    expect(content.body.elements[1].columns[0].elements[1].columns[2].elements[0].content).toBe("知识库模式");
    expect(content.body.elements[3].columns[0].elements[0].content).toContain("`/sessions` 查看全部");
  });

  it("renders a non-empty sessions command card", () => {
    const payload = buildSessionListCardPayload({
      items: [
        { index: 1, title: "开一个新闻获取的话题", current: true, meta: "当前" },
        { index: 2, title: "帮我写个单测", meta: "04-06 15:10" },
        { index: 3, title: "代码审查", archived: true, meta: "04-06 15:10" },
      ],
      footer: "发送 `/switch <编号>` 切换 · 30s 内有效",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("会话列表");
    expect(content.body.elements[0].columns[0].background_style).toBe("wathet-100");
    expect(content.body.elements[0].columns[0].elements[0].columns[1].elements[0].content).toBe("**开一个新闻获取的话题**");
    expect(content.body.elements[2].columns[0].background_style).toBe("grey-50");
    expect(content.body.elements[2].columns[0].elements[0].columns[1].elements[0].content).toBe("~~代码审查~~");
  });

  it("renders an empty sessions command card", () => {
    const payload = buildSessionListCardPayload({
      items: [],
      footer: "发送 `/new` 创建第一个会话",
      emptyText: "暂无会话",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].columns[0].elements[0].content).toBe("暂无会话");
    expect(content.body.elements[2].columns[0].elements[0].content).toContain("`/new`");
  });

  it("renders a session transition command card", () => {
    const payload = buildSessionTransitionCardPayload({
      title: "已切换会话",
      iconToken: "sheet-iconsets-check_filled",
      previousLabel: "帮我写个单测",
      currentLabel: "开一个新闻获取的话题",
      footer: "创建于 04-06 14:32 · 共 8 条消息",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("已切换会话");
    expect(content.body.elements[0].columns[1].elements[0].content).toBe("~~帮我写个单测~~");
    expect(content.body.elements[1].columns[1].elements[0].content).toBe("**开一个新闻获取的话题**");
    expect(content.body.elements[3].columns[0].elements[0].content).toContain("共 8 条消息");
  });

  it("renders a preserved current row without strike-through for precreated sessions", () => {
    const payload = buildSessionTransitionCardPayload({
      title: "已创建新会话",
      iconToken: "add-bold_outlined",
      previousLabel: "日常聊天",
      previousTitle: "保持当前",
      preservePrevious: true,
      currentLabel: "发票识别",
      currentTitle: "新会话",
      footer: "可基于这条回复创建话题，在线程里继续",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].background_style).toBe("green-50");
    expect(content.body.elements[0].columns[0].width).toBe("84px");
    expect(content.body.elements[0].columns[1].elements[0].content).toBe("**日常聊天**");
    expect(content.body.elements[1].background_style).toBe("grey-50");
    expect(content.body.elements[1].columns[0].width).toBe("84px");
  });

  it("renders a bound who command card", () => {
    const payload = buildWhoCommandCardPayload({ boundCount: 2, isBound: true });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("群聊绑定状态");
    expect(content.body.elements[0].columns[1].elements[0].content).toBe("**2 人**");
    expect(content.body.elements[1].columns[1].elements[0].content).toBe("**已绑定**");
    expect(content.body.elements[3].columns[0].elements[0].content).toContain("`/leave`");
  });

  it("renders an unbound who command card", () => {
    const payload = buildWhoCommandCardPayload({ boundCount: 0, isBound: false });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].columns[1].elements[0].content).toBe("**0 人**");
    expect(content.body.elements[1].columns[1].elements[0].content).toBe("**未绑定**");
    expect(content.body.elements[3].columns[0].elements[0].content).toContain("@bot");
  });

  it("renders a successful leave card", () => {
    const payload = buildLeaveCommandCardPayload({ unbound: true });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("已解除绑定");
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("后续消息不再响应");
  });

  it("renders an idempotent leave card", () => {
    const payload = buildLeaveCommandCardPayload({ unbound: false });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("无需解除绑定");
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("尚未绑定");
  });

  it("renders a notice card", () => {
    const payload = buildNoticeCardPayload({
      title: "提醒",
      template: "yellow",
      iconToken: "maybe_outlined",
      message: "会话列表已过期，请重新发送 `/sessions`",
      messageIconToken: "maybe_outlined",
      messageIconColor: "yellow",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("提醒");
    expect(content.header.template).toBe("yellow");
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("`/sessions`");
  });

  it("renders a permission request card with action buttons", () => {
    const payload = buildPermissionRequestCardPayload({
      permissionName: "rm -rf dist/",
      expiresInSeconds: 120,
      buttons: [
        {
          label: "/allow once · 仅此一次",
          type: "primary",
          value: {
            kind: "permission",
            conversationKey: "oc_chat_1",
            turnId: "turn_1",
            sessionId: "ses_1",
            permissionId: "perm_1",
            policy: "once",
            nonce: "nonce_1",
          },
        },
        {
          label: "/deny · 拒绝",
          type: "danger",
          value: {
            kind: "permission",
            conversationKey: "oc_chat_1",
            turnId: "turn_1",
            sessionId: "ses_1",
            permissionId: "perm_1",
            policy: "deny",
            nonce: "nonce_1",
          },
        },
      ],
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("权限请求");
    expect(content.header.template).toBe("purple");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[0].content).toContain("rm -rf dist/");
    expect(content.body.elements[2].tag).toBe("column_set");
    expect(content.body.elements[2].columns[0].elements[0].text.content).toBe("/allow once · 仅此一次");
    expect(content.body.elements[2].columns[1].elements[0].value.policy).toBe("deny");
    expect(content.body.elements[2].columns[1].elements[0].confirm.text.content).toContain("确认拒绝当前权限请求");
    expect(content.body.elements[3].columns[0].elements[0].content).toContain("120s 后自动拒绝");
  });

  it("renders a knowledge query card with sources and disclaimer", () => {
    const payload = buildKnowledgeQueryPayload({
      question: "员工试用期最长多久？",
      bitableUrl: "https://example.com/base/app?table=tbl",
      results: [{
        id: 1,
        documentId: 1,
        question: "员工试用期最长多久？",
        answer: "试用期最长不超过 6 个月。",
        tags: ["劳动"],
        statute: "《劳动合同法》第 19 条",
        sourceFile: "劳动合同法实务指南.pdf",
        pageSection: "第 23 页",
        createdAt: Date.now(),
        score: 0.98,
      }],
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(content.header.title.content).toBe("法律咨询");
    expect(serialized).toContain("试用期最长不超过 6 个月");
    expect(serialized).toContain("劳动合同法实务指南.pdf");
    expect(serialized).toContain("以上内容仅供参考，不构成法律意见");
    expect(serialized).toContain("查看知识库");
    expect(serialized).toContain("https://example.com/base/app?table=tbl");
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
    expect(content.body.elements[2].columns[0].elements[0].icon).toBeUndefined();
    expect(serialized).toContain("warning_outlined");
  });

  it("renders an empty knowledge query card", () => {
    const payload = buildKnowledgeQueryEmptyPayload("员工试用期最长多久？");
    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("未找到");
    expect(serialized).toContain("员工试用期最长多久");
  });

  it("renders a knowledge ingest result card", () => {
    const payload = buildKnowledgeIngestPayload({
      sourceFile: "劳动合同法实务指南.pdf",
      rawExtractedCount: 16,
      dedupedCount: 4,
      extractedCount: 12,
      tagCounts: {
        劳动: 8,
        合同: 4,
        解除: 3,
        赔偿: 2,
        程序: 2,
        证据: 2,
        调岗: 2,
        培训: 2,
        仲裁: 1,
        诉讼: 1,
        免责声明: 1,
      },
      durationMs: 12_000,
      bitableUrl: "https://example.com/base/app?table=tbl",
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(serialized).toContain("知识入库完成");
    expect(serialized).toContain("劳动合同法实务指南.pdf");
    expect(serialized).toContain("入库 12");
    expect(serialized).toContain("提取 16");
    expect(serialized).toContain("去重 4");
    expect(serialized).toContain("标签占比");
    expect(serialized).toContain("\"tag\":\"劳动\"");
    expect(serialized).toContain("查看知识库");
    expect(content.header.icon.token).toBe("yes_filled");
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
    expect(serialized).not.toContain("link_outlined");
  });

  it("renders a knowledge ingest processing card", () => {
    const payload = buildKnowledgeIngestProcessingPayload({
      sourceLabel: "劳动合同.txt",
      steps: [
        { label: "读取内容", detail: "正在下载并解析文件", status: "running" },
        { label: "提取问答", detail: "等待开始", status: "pending" },
        { label: "写入知识库", detail: "等待开始", status: "pending" },
      ],
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(serialized).toContain("知识入库进行中");
    expect(serialized).toContain("处理文件");
    expect(serialized).toContain("读取内容");
    expect(serialized).toContain("进行中...");
    expect(serialized).toContain("当前进度");
    expect(serialized).toContain("提取问答");
    expect(serialized).toContain("等待中");
    expect(serialized).toContain("loading_outlined");
    expect(serialized).toContain("time_outlined");
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
    expect(serialized).toContain("耗时");
  });

  it("renders knowledge ingest queued and failure cards", () => {
    const queuedPayload = buildKnowledgeIngestQueuedPayload({
      sourceLabel: "经济补偿计算规则.docx",
      queuedAhead: 2,
      elapsedMs: 10_000,
    });
    const failurePayload = buildKnowledgeIngestFailurePayload({
      sourceLabel: "经济补偿计算规则.docx",
      reason: "PDF 解析失败",
    });
    const queuedSerialized = JSON.stringify(JSON.parse(queuedPayload.content));
    const failureSerialized = JSON.stringify(JSON.parse(failurePayload.content));
    expect(queuedSerialized).toContain("知识入库排队中");
    expect(queuedSerialized).toContain("排队文件");
    expect(queuedSerialized).toContain("前方队列");
    expect(queuedSerialized).toContain("2 个素材");
    expect(queuedSerialized).toContain("耗时：10s");
    expect(failureSerialized).toContain("入库失败");
    expect(failureSerialized).toContain("原因");
    expect(failureSerialized).toContain("PDF 解析失败");
    expect(failureSerialized).toContain("请检查文件是否损坏或重新上传");
  });

  it("renders knowledge ingest session summary and final cards", () => {
    const sessionPayload = buildKnowledgeIngestSessionPayload({
      completedCount: 3,
      failedCount: 0,
      queuedCount: 1,
      currentLabel: "劳动合同法释义.pdf",
      totalExtractedCount: 127,
      totalDedupedCount: 38,
    });
    const finalPayload = buildKnowledgeIngestSessionFinalPayload({
      completedCount: 5,
      failedCount: 0,
      queuedCount: 0,
      totalExtractedCount: 214,
      totalDedupedCount: 38,
      elapsedMs: 222_000,
      bitableUrl: "https://example.com/base/app?table=tbl",
      results: [{
        sourceFile: "劳动合同法实务指南.pdf",
        rawExtractedCount: 16,
        dedupedCount: 4,
        extractedCount: 12,
        tagCounts: { 劳动: 8 },
        durationMs: 12_000,
      }],
    });

    const sessionSerialized = JSON.stringify(JSON.parse(sessionPayload.content));
    const finalSerialized = JSON.stringify(JSON.parse(finalPayload.content));
    expect(sessionSerialized).toContain("知识入库会话");
    expect(sessionSerialized).toContain("已完成");
    expect(sessionSerialized).toContain("劳动合同法释义.pdf");
    expect(sessionSerialized).toContain("排队中");
    expect(sessionSerialized).toContain("总入库");
    expect(finalSerialized).toContain("本次入库完成");
    expect(finalSerialized).toContain("劳动合同法实务指南.pdf");
    expect(finalSerialized).toContain("入库 12");
    expect(finalSerialized).toContain("提取 16");
    expect(finalSerialized).toContain("去重 4");
    expect(finalSerialized).toContain("查看知识库");
  });

  it("renders a notice card without body icon when disabled", () => {
    const payload = buildNoticeCardPayload({
      title: "知识入库失败",
      template: "red",
      iconToken: "error_filled",
      message: "Feishu createBitableRecord failed: SingleSelectFieldConvFail",
      showMessageIcon: false,
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
  });

  it("renders a notice card without body icon by default", () => {
    const payload = buildNoticeCardPayload({
      title: "提示",
      template: "blue",
      iconToken: "info_outlined",
      message: "这是一个默认提示卡片。",
      messageIconToken: "info_outlined",
      messageIconColor: "blue",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
  });
});
