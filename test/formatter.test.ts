/**
 * 职责: 覆盖飞书 formatter 兼容导出面。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import {
  buildCaseCreateProcessingPayload,
  buildKnowledgeIngestCompletedPayload,
  buildKnowledgeIngestFailurePayload,
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestQueuedPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
  buildGuideCardPayload,
  buildLaborAnalysisCompletedPayload,
  buildLaborAnalysisProgressPayload,
  buildModelListCardPayload,
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  buildPostPayload,
  buildPermissionRequestCardPayload,
  buildSessionListCardPayload,
  buildSessionTransitionCardPayload,
  buildStatusCommandCardPayload,
  buildTurnStatusCardPayload,
} from "../src/feishu/formatter.js";
import { buildButtonCallbackTestCardPayload } from "../src/feishu/runtime-cards.js";
import { buildAssistantMarkdownPayload } from "../src/feishu/shared-primitives.js";

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

  it("removes fenced code block language markers for Feishu markdown compatibility", () => {
    const payload = buildPostMarkdownPayload(["```bash", "npm test", "```"].join("\n"));
    const content = JSON.parse(payload.content) as { zh_cn: { content: Array<Array<{ tag: string; text: string }>> } };
    expect(content.zh_cn.content[0]?.[0]?.text).toBe(["```", "npm test", "```"].join("\n"));
  });

  it("repairs multiline single-backtick pseudo code blocks without touching inline code", () => {
    const payload = buildPostMarkdownPayload([
      "操作如下：",
      "`bash",
      "npm install",
      "npm run dev",
      "`",
      "",
      "保留内联 `bash`、`/new` 和普通 bash 文字。",
    ].join("\n"));
    const content = JSON.parse(payload.content) as { zh_cn: { content: Array<Array<{ tag: string; text: string }>> } };
    const text = content.zh_cn.content[0]?.[0]?.text ?? "";

    expect(text).toContain(["```", "npm install", "npm run dev", "```"].join("\n"));
    expect(text).toContain("内联 `bash`");
    expect(text).toContain("`/new`");
    expect(text).toContain("普通 bash 文字");
  });

  it("downgrades headings only for assistant markdown payloads", () => {
    const commonPayload = buildPostMarkdownPayload(["# 一级标题", "正文"].join("\n"));
    const assistantPayload = buildAssistantMarkdownPayload(["# 一级标题", "正文"].join("\n"));
    const commonContent = JSON.parse(commonPayload.content) as { zh_cn: { content: Array<Array<{ tag: string; text: string }>> } };
    const assistantContent = JSON.parse(assistantPayload.content) as { zh_cn: { content: Array<Array<{ tag: string; text: string }>> } };

    expect(commonContent.zh_cn.content[0]?.[0]?.text).toContain("# 一级标题");
    expect(assistantContent.zh_cn.content[0]?.[0]?.text).toContain("### 一级标题");
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
    expect(content.header.title.content).toBe("处理中");
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

    expect(output).toContain("```\n飞书事件 -> ws.ts handleEvent()");
    expect(output).not.toContain("```text");
    expect(output).toContain("飞书事件 -> ws.ts handleEvent()");
    expect(output).not.toContain("-&gt;");
  });

  it("normalizes assistant headings in final turn output", () => {
    const payload = buildTurnStatusCardPayload({
      title: "已完成",
      status: "已完成",
      sessionId: "ses_1234567890",
      durationText: "约 3s",
      progressUpdates: ["最终回复已生成"],
      toolUpdates: [],
      output: {
        text: ["# 安装步骤", "", "```bash", "npm test", "```"].join("\n"),
        paths: [],
        commands: [],
      },
    });
    const content = JSON.parse(payload.content) as any;
    const output = content.body.elements[0].columns[0].elements[0].content as string;

    expect(output).toContain("### 安装步骤");
    expect(output).toContain(["```", "npm test", "```"].join("\n"));
    expect(output).not.toMatch(/^# 安装步骤/m);
    expect(output).not.toContain("```bash");
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
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[0].content).toBe("**能不能获取舆论新闻**");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[1].content).toContain("ses_2988a201effeCaZpLXXjarY0pM");
    expect(content.body.elements[1].columns[0].elements[1].columns).toHaveLength(4);
    expect(content.body.elements[1].columns[0].elements[1].columns[0].elements[0].content).toBe("connected");
    expect(content.body.elements[1].columns[0].elements[1].columns[2].elements[0].content).toBe("知识库模式");
    expect(content.body.elements[1].columns[0].elements[2].columns).toHaveLength(2);
    expect(content.body.elements[1].columns[0].elements[2].columns[0].elements[0].content).toBe("排队 0");
    expect(content.body.elements[3].columns[0].elements[0].text.content).toBe("查看全部会话");
    expect(content.body.elements[3].columns[1].elements[0].value.command).toBe("/new");
    expect(content.body.elements).toHaveLength(4);
  });

  it("renders a guide card with reproducible hero actions", () => {
    const payload = buildGuideCardPayload({ windowLabel: "日常会话" });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);

    expect(content.header.title.content).toBe("快速上手");
    expect(serialized).toContain("/案件工作台");
    expect(serialized).toContain("/完成上传");
    expect(serialized).toContain("查看分析输出");
    expect(serialized).toContain("二审状态");
    expect(serialized).not.toContain("labor:harness");
    expect(serialized).not.toContain("当前窗口");
  });

  it("renders a model list card with current model in header", () => {
    const payload = buildModelListCardPayload({
      currentModelLabel: "openai/gpt-5.4-mini",
      providers: [{
        id: "openai",
        name: "OpenAI",
        models: [
          { id: "openai/gpt-5.4-mini", current: true },
          { id: "openai/gpt-5.2" },
        ],
      }],
      footer: "发送 `/model reset` 恢复默认模型",
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(content.header.subtitle.content).toBe("当前：openai/gpt-5.4-mini");
    expect(serialized).toContain("gpt-5.4-mini");
    expect(serialized).toContain("/model use openai/gpt-5.4-mini");
    expect(serialized).toContain("/model reset");
  });

  it("renders a non-empty sessions command card", () => {
    const payload = buildSessionListCardPayload({
      items: [
        { index: 1, title: "开一个新闻获取的话题", current: true, meta: "当前" },
        { index: 2, title: "帮我写个单测", meta: "04-06 15:10" },
        { index: 3, title: "代码审查", archived: true, meta: "04-06 15:10" },
      ],
      footer: "发送 `/switch <编号>` 切换 · 3 分钟内有效",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("会话列表");
    expect(content.body.elements[0].columns[0].background_style).toBe("wathet-100");
    expect(content.body.elements[0].columns[0].elements[0].columns[1].elements[0].content).toBe("**开一个新闻获取的话题**");
    expect(content.body.elements[1].columns[0].elements[0].columns[2].elements[0].text.content).toBe("切换");
    expect(content.body.elements[1].columns[0].elements[0].columns[2].elements[0].value.command).toBe("/switch 2");
    expect(content.body.elements[2].columns[0].background_style).toBe("grey-50");
    expect(content.body.elements[2].columns[0].elements[0].columns[1].elements[0].content).toBe("~~代码审查~~");
    expect(content.body.elements[2].columns[0].elements[0].columns[2].elements[0].content).toBe("已归档");
  });

  it("renders an empty sessions command card", () => {
    const payload = buildSessionListCardPayload({
      items: [],
      footer: "发送 `/new` 创建第一个会话",
      emptyText: "暂无会话",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].columns[0].elements[0].content).toBe("暂无会话");
    expect(content.body.elements[2].columns[0].elements[0].text.content).toBe("新建会话");
    expect(content.body.elements[3].columns[0].elements[0].content).toBe("创建第一个会话");
    expect(content.body.elements[3].columns[0].elements[0].text_size).toBe("notation");
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
    expect(content.body.elements[0].columns[0].background_style).toBe("green-50");
    expect(content.body.elements[0].columns[0].elements[0].content).toBe("~~帮我写个单测~~ → **开一个新闻获取的话题**");
    expect(content.body.elements[2].columns[0].elements[0].text.content).toBe("切回上一个");
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
    expect(content.body.elements[0].columns[0].background_style).toBe("grey-50");
    expect(content.body.elements[0].columns[0].elements[0].content).toBe("**日常聊天** → **发票识别**");
    expect(content.body.elements[2].columns[0].elements[0].text.content).toBe("切回上一个");
    expect(content.body.elements[3].columns[0].elements[0].content).toBe("发送消息继续当前会话");
  });

  it("re-exports contract family payload builders through formatter compat surface", () => {
    const payload = buildCaseCreateProcessingPayload("委托人：张三；对方当事人：李四；案由：劳动争议");
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);

    expect(content.header.title.content).toBe("案件信息录入中");
    expect(serialized).toContain("案件信息录入中");
    expect(serialized).toContain("劳动争议");
  });

  it("renders a notice card", () => {
    const payload = buildNoticeCardPayload({
      title: "提醒",
      level: "warning",
      message: "会话列表已过期，请重新发送 `/sessions`",
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
    expect(content.header.subtitle.content).toBe("120s 后自动拒绝");
    expect(content.header.template).toBe("purple");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[0].content).toContain("rm -rf dist/");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[0].content).toContain("$ ");
    expect(content.body.elements[2].tag).toBe("column_set");
    expect(content.body.elements[2].columns[0].elements[0].text.content).toBe("/allow once · 仅此一次");
    expect(content.body.elements[3].columns[0].elements[0].value.policy).toBe("deny");
    expect(content.body.elements[3].columns[0].elements[0].confirm.text.content).toContain("确认拒绝当前权限请求");
    expect(content.body.elements[4].columns[0].elements[0].content).toContain("/allow once");
  });

  it("renders a button callback test card with key-value diagnostics", () => {
    const payload = buildButtonCallbackTestCardPayload({
      nonce: "nonce_demo",
      callbackPath: "/webhook/card",
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(content.header.title.content).toBe("按钮回调测试");
    expect(serialized).toContain("回调路径");
    expect(serialized).toContain("/webhook/card");
    expect(serialized).toContain("测试 nonce");
    expect(serialized).toContain("nonce_demo");
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
        bitableRecordId: "rec_123",
        createdAt: Date.now(),
        score: 0.98,
      }],
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(content.header.title.content).toBe("法律咨询");
    expect(serialized).toContain("试用期最长不超过 6 个月");
    expect(serialized).toContain("劳动合同法实务指南.pdf");
    expect(serialized).toContain("打开知识库记录｜劳动合同法实务指南.pdf · 第 23 页");
    expect(serialized).toContain("https://example.com/base/app?table=tbl&recordId=rec_123");
    expect(serialized).toContain("以上内容仅供参考，不构成法律意见");
    expect(serialized).toContain("查看知识库");
    expect(serialized).toContain("https://example.com/base/app?table=tbl");
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
    expect(content.body.elements[2].columns[0].elements[0].icon).toBeUndefined();
    expect(serialized).not.toContain("继续追问");
    expect(serialized).toContain("🏛 法条：《劳动合同法》第 19 条");
  });

  it("falls back to plain source text when the knowledge view url is not a base table", () => {
    const payload = buildKnowledgeQueryPayload({
      question: "员工试用期最长多久？",
      bitableUrl: "https://example.com/knowledge",
      results: [{
        id: 1,
        documentId: 1,
        question: "员工试用期最长多久？",
        answer: "试用期最长不超过 6 个月。",
        tags: ["劳动"],
        sourceFile: "劳动合同法实务指南.pdf",
        pageSection: "第 23 页",
        bitableRecordId: "rec_123",
        createdAt: Date.now(),
        score: 0.98,
      }],
    });
    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("📄 来源：劳动合同法实务指南.pdf · 第 23 页");
    expect(serialized).not.toContain("recordId=rec_123");
  });

  it("renders an empty knowledge query card", () => {
    const payload = buildKnowledgeQueryEmptyPayload({ question: "员工试用期最长多久？" });
    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("未找到");
    expect(serialized).toContain("员工试用期最长多久");
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
    expect(serialized).toContain("正在下载并解析文件");
    expect(serialized).toContain("当前处理");
    expect(serialized).toContain("提取问答");
    expect(serialized).toContain("等待开始");
    expect(serialized).toContain("0/1 已完成");
    expect(content.body.elements[1].columns[0].elements[0].content).toContain("处理文件");
    expect(serialized).toContain("耗时");
  });

  it("renders step error labels consistently after shared helper rename", () => {
    const payload = buildKnowledgeIngestProcessingPayload({
      sourceLabel: "劳动合同.txt",
      steps: [
        { label: "写入知识库", detail: "Bitable 限流", status: "error" },
      ],
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("写入失败");
    expect(serialized).toContain("Bitable 限流");
    expect(serialized).toContain("/retry");
    expect(serialized).toContain("写入失败");
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

  it("renders knowledge ingest completed card", () => {
    const finalPayload = buildKnowledgeIngestCompletedPayload({
      completedCount: 1,
      failedCount: 0,
      queuedCount: 0,
      totalExtractedCount: 12,
      totalDedupedCount: 4,
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

    const finalSerialized = JSON.stringify(JSON.parse(finalPayload.content));
    expect(finalSerialized).toContain("知识入库完成");
    expect(finalSerialized).toContain("劳动合同法实务指南.pdf");
    expect(finalSerialized).toContain("入库 12");
    expect(finalSerialized).toContain("提取 16");
    expect(finalSerialized).toContain("去重 4");
    expect(finalSerialized).toContain("标签占比");
    expect(finalSerialized).toContain("\"tag\":\"劳动\"");
    expect(finalSerialized).toContain("查看知识库");
    expect(finalSerialized).toContain("耗时：3 分 42 秒");
  });

  it("renders labor analysis progress and completed cards through formatter exports", () => {
    const progressPayload = buildLaborAnalysisProgressPayload({
      sourceLabel: "仲裁申请书.pdf",
      steps: [
        { label: "提取事实", detail: "正在识别关键事实", status: "running" },
        { label: "整理证据", detail: "等待开始", status: "pending" },
      ],
      progressText: "正在聚合争议焦点",
      elapsedMs: 9_000,
    });
    const completedPayload = buildLaborAnalysisCompletedPayload({
      title: "张三劳动争议案",
      materialCount: 6,
      evidenceCount: 12,
      issueCount: 3,
      tagCounts: { 仲裁: 4, 加班费: 2 },
      docUrl: "https://example.com/doc/123",
      ledgerUrl: "https://example.com/base/app?table=tbl_labor",
      keyEvidenceViewUrl: "https://example.com/base/app?table=tbl_labor&view=vew_key",
      missingEvidenceViewUrl: "https://example.com/base/app?table=tbl_labor&view=vew_gap",
      syncedEvidenceCount: 12,
      syncedGapCount: 3,
    });

    const progressSerialized = JSON.stringify(JSON.parse(progressPayload.content));
    const completedSerialized = JSON.stringify(JSON.parse(completedPayload.content));

    expect(progressSerialized).toContain("材料分析进行中");
    expect(progressSerialized).toContain("仲裁申请书.pdf");
    expect(progressSerialized).toContain("提取事实");
    expect(progressSerialized).toContain("当前进度");
    expect(progressSerialized).toContain("耗时：9s");
    expect(completedSerialized).toContain("材料分析完成");
    expect(completedSerialized).toContain("张三劳动争议案");
    expect(completedSerialized).toContain("材料 6");
    expect(completedSerialized).toContain("证据 12");
    expect(completedSerialized).toContain("焦点 3");
    expect(completedSerialized).toContain("材料占比");
  });

  it("renders a notice card without body icon when disabled", () => {
    const payload = buildNoticeCardPayload({
      title: "知识入库失败",
      level: "error",
      message: "Feishu createBitableRecord failed: SingleSelectFieldConvFail",
      showMessageIcon: false,
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
  });

  it("renders a notice card without body icon by default", () => {
    const payload = buildNoticeCardPayload({
      title: "提示",
      level: "info",
      message: "这是一个默认提示卡片。",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.body.elements[0].columns[0].elements[0].icon).toBeUndefined();
  });
});
