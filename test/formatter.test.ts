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
  buildInvoiceRecognizeCompletedPayload,
  buildInvoiceRecognizeProgressPayload,
  buildLaborAnalysisCompletedPayload,
  buildLaborAnalysisProgressPayload,
  buildLaborFinalReviewPayload,
  buildLaborReviewCompletedPayload,
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
import { buildCaseTodoReminderPayload } from "../src/feishu/contract-cards.js";
import { buildCostCommandCardPayload } from "../src/feishu/runtime-cards.js";
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
      costSummary: "本次约消耗 123 tokens（估算）",
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
    expect(serialized).not.toContain("中止任务");
    expect(serialized).not.toContain("/abort");
    expect(serialized).not.toContain("本次约消耗");
    expect(serialized).not.toContain("tokens");
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

  it("renders cost card without price/source columns and normalizes default model labels", () => {
    const payload = buildCostCommandCardPayload({
      todayTokens: 58,
      monthTokens: 6605,
      recent: [
        {
          createdAt: "2026-05-11T00:00:00.000Z",
          provider: "opencode-default",
          model: "default",
          totalTokens: 58,
          source: "estimated",
        },
      ],
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);

    expect(serialized).toContain("AI 成本摘要");
    expect(serialized).toContain("OpenCode 默认模型");
    expect(serialized).toContain("58");
    expect(serialized).not.toContain("未配置价格");
    expect(serialized).not.toContain("费用");
    expect(serialized).not.toContain("来源");
    expect(serialized).not.toContain("查看完整账单");
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
    expect(content.header.title.content).toBe("可用模型");
    expect(content.header.template).toBe("indigo");
    expect(serialized).toContain("gpt-5.4-mini");
    expect(serialized).toContain("openai/gpt-5.2");
    expect(serialized).not.toContain("gpt-5.3-codex");
    expect(serialized).not.toContain("openai/gpt-5.5");
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
    expect(content.body.elements[1].columns[0].elements[0].columns[2].elements[0].text.content).toBe("预览");
    expect(content.body.elements[1].columns[0].elements[0].columns[2].elements[0].value.command).toBe("/preview 2");
    expect(content.body.elements[1].columns[0].elements[0].columns[2].elements[1].text.content).toBe("切换");
    expect(content.body.elements[1].columns[0].elements[0].columns[2].elements[1].value.command).toBe("/switch 2");
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
    expect(serialized).toContain("提取案件字段");
    expect(serialized).not.toContain("劳动争议");
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
    expect(content.header.template).toBe("yellow");
    expect(JSON.stringify(content)).toContain("rm -rf dist/");
    expect(content.body.elements[2].tag).toBe("column_set");
    expect(content.body.elements[2].columns[0].elements[0].text.content).toBe("允许一次");
    expect(content.body.elements[2].columns[0].elements[0].value.policy).toBe("once");
    expect(content.body.elements[2].columns[1].elements[0].text.content).toBe("始终允许");
    expect(content.body.elements[2].columns[2].elements[0].value.policy).toBe("deny");
  });

  it("renders a knowledge query card with sources and disclaimer", () => {
    const payload = buildKnowledgeQueryPayload({
      question: "员工试用期最长多久？",
      bitableUrl: "https://example.com/base/app?table=tbl",
      results: [{
        id: 1,
        documentId: 1,
        question: "员工试用期最长多久？",
        answer: "试用期规则如下：（1）三个月以上不满一年不得超过一个月。（2）一年以上不满三年不得超过二个月。①三年以上不得超过六个月。",
        tags: ["劳动"],
        statute: "《劳动合同法》第 19 条",
        sourceFile: "劳动合同法实务指南.pdf",
        pageSection: "第 23 页",
        sourceUrl: "https://example.com/base/app?table=tbl&record=rec_123",
        statuteUrl: "https://example.com/law?keyword=%E5%8A%B3%E5%8A%A8%E5%90%88%E5%90%8C%E6%B3%95",
        bitableRecordId: "rec_123",
        createdAt: Date.now(),
        score: 0.98,
      }],
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(content.header.title.content).toBe("法律咨询");
    expect(serialized).toContain("试用期规则如下：\\n（1）三个月以上不满一年不得超过一个月。\\n（2）一年以上不满三年不得超过二个月。\\n①三年以上不得超过六个月。");
    expect(serialized).toContain("劳动合同法实务指南.pdf");
    expect(serialized).toContain("《劳动合同法》第 19 条");
    expect(serialized).not.toContain("查看知识库");
    expect(serialized).toContain("https://example.com/base/app?table=tbl&record=rec_123");
    expect(serialized).toContain("https://example.com/law?keyword=%E5%8A%B3%E5%8A%A8%E5%90%88%E5%90%8C%E6%B3%95");
    expect(serialized).not.toContain("继续追问");
  });

  it("renders plain source text when no knowledge source url exists", () => {
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
    expect(serialized).toContain("劳动合同法实务指南.pdf · 第 23 页");
    expect(serialized).not.toContain("recordId=rec_123");
  });

  it("splits long knowledge answers into readable paragraphs", () => {
    const payload = buildKnowledgeQueryPayload({
      question: "医疗期怎么算？",
      results: [{
        id: 1,
        documentId: 1,
        question: "医疗期怎么算？",
        answer: "医疗期依据员工实际参加工作年限和在本单位工作年限确定。国家层面规定：实际工作10年以下、在本单位5年以下的，医疗期3个月，累计病休6个月；5年以上的，医疗期6个月，累计病休12个月。实际工作10年以上的，根据本单位工作年限不同，医疗期从6个月到24个月不等。医疗期从病休第一天开始累计计算，包括休息日和法定节假日。但地方法规可能有特殊规定，例如上海按本单位工作年限计算，每满1年增加1个月，最高不超过24个月，且每月按20.83天计算，不含休息日和节假日。",
        tags: ["医疗期"],
        sourceFile: "律师来了.pdf",
        createdAt: Date.now(),
        score: 0.98,
      }],
    });
    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("确定。\\n国家层面规定");
    expect(serialized).toContain("不等。\\n医疗期从");
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
      queuedLabels: ["社保缴纳记录.pdf"],
      completedItems: [{ sourceFile: "劳动合同.pdf", extractedCount: 18, elapsedMs: 3_200 }],
      failedItems: [{ sourceFile: "损坏文件.pdf", reason: "PDF 解析失败", elapsedMs: 1_200 }],
    });
    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(serialized).toContain("知识入库进行中");
    expect(serialized).toContain("知识入库进行中");
    expect(serialized).toContain("劳动合同.txt");
    expect(serialized).toContain("读取内容：正在下载并解析文件");
    expect(serialized).toContain("提取问答：等待中");
    expect(serialized).toContain("待处理：社保缴纳记录.pdf");
    expect(serialized).toContain("已完成：劳动合同.pdf｜入库 18 条｜耗时 3s");
    expect(serialized).toContain("失败：损坏文件.pdf｜耗时 1s｜PDF 解析失败");
  });

  it("renders step error labels consistently after shared helper rename", () => {
    const payload = buildKnowledgeIngestProcessingPayload({
      sourceLabel: "劳动合同.txt",
      steps: [
        { label: "写入知识库", detail: "Bitable 限流", status: "error" },
      ],
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("知识入库进行中");
    expect(serialized).toContain("劳动合同.txt");
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
      elapsedMs: 10_000,
    });
    const queuedSerialized = JSON.stringify(JSON.parse(queuedPayload.content));
    const failureSerialized = JSON.stringify(JSON.parse(failurePayload.content));
    expect(queuedSerialized).toContain("知识入库排队中");
    expect(queuedSerialized).toContain("待处理：经济补偿计算规则.docx");
    expect(queuedSerialized).toContain("流程步骤");
    expect(queuedSerialized).toContain("读取内容：等待中");
    expect(queuedSerialized).toContain("前方还有 2 个素材");
    expect(failureSerialized).toContain("入库失败");
    expect(failureSerialized).toContain("流程步骤");
    expect(failureSerialized).toContain("读取内容：PDF 解析失败");
    expect(failureSerialized).toContain("失败原因");
    expect(failureSerialized).toContain("PDF 解析失败");
    expect(failureSerialized).toContain("耗时 10s");
    expect(failureSerialized).not.toContain("retry-upload");
    expect(failureSerialized).not.toContain("重新上传");
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
    expect(finalSerialized).toContain("\"tag\":\"劳动\",\"value\":8");
    expect(finalSerialized).toContain("yes_filled");
    expect(finalSerialized).toContain("查看知识库");
    expect(finalSerialized).toContain("knowledge-ingest-action");
    expect(finalSerialized).toContain("https://example.com/base/app?table=tbl");
    expect(finalSerialized).not.toContain("本次素材");
  });

  it("renders knowledge ingest final summary as failure when every item fails", () => {
    const finalPayload = buildKnowledgeIngestCompletedPayload({
      completedCount: 0,
      failedCount: 1,
      queuedCount: 0,
      totalExtractedCount: 0,
      totalDedupedCount: 0,
      elapsedMs: 5_000,
      bitableUrl: "https://example.com/base/app?table=tbl",
      failures: [{
        sourceFile: "资料.zip",
        reason: "Feishu downloadMessageResource failed: 400 Bad Request",
      }],
    });

    const finalSerialized = JSON.stringify(JSON.parse(finalPayload.content));
    expect(finalSerialized).toContain("知识入库失败");
    expect(finalSerialized).toContain("资料.zip");
    expect(finalSerialized).toContain("400 Bad Request");
    expect(finalSerialized).not.toContain("查看知识库");
    expect(finalSerialized).not.toContain("knowledge-ingest-action");
  });

  it("renders invoice progress card without template dummy files", () => {
    const payload = buildInvoiceRecognizeProgressPayload({
      currentFile: "真实发票.pdf",
      completedFiles: [],
      failedFiles: [],
      steps: [
        { label: "读取发票文件", status: "running" },
        { label: "OpenCode 识别原始内容", status: "pending" },
      ],
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("真实发票.pdf");
    expect(serialized).toContain("读取发票文件：进行中");
    expect(serialized).toContain("OpenCode 识别原始内容：等待中");
    expect(serialized).not.toContain("260405_635.00_深圳市南山区肖三胖甲鱼院子.pdf");
    expect(serialized).not.toContain("260415_875.00_广东徐记海鲜餐饮有限公司.pdf");
    expect(serialized).not.toContain("已完成发票.pdf");
    expect(serialized).not.toContain("识别失败发票.pdf");
    expect(serialized).not.toContain("已完成xxx");
    expect(serialized).not.toContain("正在 OCR 识别发票内容");
    expect(serialized).not.toContain("等待填写表格");
  });

  it("renders invoice completion date from Base timestamp", () => {
    const payload = buildInvoiceRecognizeCompletedPayload({
      summary: "2026-04-23电子发票，发票号26952000001657386511，价税合计8000元。",
      recordId: "rec_invoice",
      record: {
        文件名: "测试发票.pdf",
        发票号: "26952000001657386511",
        发票类型: "电子发票（普通发票）",
        发票金额: 8000,
        开票日期: 1776873600000,
      },
    }, {
      elapsedMs: 1_000,
      recordUrl: "https://feishu.cn/base/app?table=tbl&record=rec_invoice",
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("2026-04-23");
    expect(serialized).not.toContain("开票时间：未识别");
  });

  it("renders case todo reminders as compact task items", () => {
    const payload = buildCaseTodoReminderPayload({
      items: [{
        line: [
          "(2026) 粤0305民初1234号｜一审｜未结",
          "日期：日期 2026-05-06；开庭日 2026-05-16；举证截止日 2026-05-12",
          "待办：关注案件节点：日期 2026-05-06；开庭日 2026-05-16；举证截止日 2026-05-12",
          "进展：已立案，等待开庭",
        ].join("\n"),
        url: "https://example.com/base?record=rec_case",
      }],
    });

    const content = JSON.parse(payload.content) as any;
    const serialized = JSON.stringify(content);
    expect(serialized).toContain("案件提醒");
    expect(serialized).toContain("举证截止");
    expect(serialized).toContain("开庭");
    expect(serialized).toContain("(2026) 粤0305民初1234号");
    expect(serialized).toContain("一审｜未结｜已立案，等待开庭");
    expect(serialized).toContain("开庭 05-16｜举证截止 05-12");
    expect(serialized).not.toContain("案件节点 日期");
    expect(serialized).not.toContain("关注案件节点：日期");
  });

  it("renders labor analysis progress and completed cards through formatter exports", () => {
    const progressPayload = buildLaborAnalysisProgressPayload({
      sourceLabel: "仲裁申请书.pdf",
      steps: [
        { label: "读取内容", detail: "已完成", status: "completed" },
        { label: "提取关键信息", detail: "正在识别关键事实", status: "running" },
      ],
      progressText: "正在聚合争议焦点",
      elapsedMs: 9_000,
      totalFiles: 4,
      completedFiles: ["劳动合同.pdf｜耗时 3s", "工资流水.xlsx｜耗时 2s"],
      failedFiles: [],
      insightLines: ["正在识别关键事实", "准备归并证据用途"],
      docUrl: "https://example.com/doc/preview",
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
    expect(progressSerialized).toContain("当前处理");
    expect(progressSerialized).toContain("读取内容：已完成");
    expect(progressSerialized).toContain("提取关键信息：进行中");
    expect(progressSerialized).toContain("案件级汇总：等待中");
    expect(progressSerialized).toContain("创建预览文档：等待中");
    expect(progressSerialized).toContain("写入云文档：等待中");
    expect(progressSerialized).toContain("生成图表与台账：等待中");
    expect(progressSerialized).not.toContain("社保缴纳记录.pdf");
    expect(progressSerialized).toContain("待处理材料 1");
    expect(progressSerialized).toContain("已完成：劳动合同.pdf｜耗时 3s");
    expect(progressSerialized).toContain("已完成：工资流水.xlsx｜耗时 2s");
    expect(progressSerialized).not.toContain("耗时 1m");
    expect(progressSerialized).toContain("模型处理动态");
    expect(progressSerialized).toContain("正在识别关键事实");
    expect(progressSerialized).not.toContain("进展：正在聚合争议焦点");
    expect(progressSerialized).toContain("预览分析文档");
    expect(progressSerialized).toContain("https://example.com/doc/preview");
    expect((progressSerialized.match(/yes_outlined/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((progressSerialized.match(/已完成：/g) ?? []).length).toBe(2);
    expect(completedSerialized).toContain("材料分析完成");
    expect(completedSerialized).toContain("张三劳动争议案");
    expect(completedSerialized).toContain("材料 6");
    expect(completedSerialized).toContain("证据 12");
    expect(completedSerialized).toContain("焦点 3");
    expect(completedSerialized).toContain("打开分析文档");
    expect(completedSerialized).toContain("https://example.com/doc/123");
    expect(completedSerialized).toContain("材料占比");
    expect(completedSerialized).toContain("\"tag\":\"仲裁\",\"value\":4");
    expect(completedSerialized).toContain("\"tag\":\"加班费\",\"value\":2");
    expect(completedSerialized).not.toContain("\"tag\":\"劳动\",\"value\":32");
  });

  it("renders labor review card without empty risk sections and with review details", () => {
    const payload = buildLaborReviewCompletedPayload({
      title: "张三劳动争议案",
      materialCount: 3,
      evidenceCount: 7,
      issueCount: 2,
      tagCounts: { 劳动合同: 2, 工资流水: 1 },
      reviewStatus: "需人工复核（1 项），法条引用已完成独立校验",
      findings: [{ severity: "medium", message: "社保欠缴依据需补充权威来源" }],
      citationDetails: [{
        label: "《中华人民共和国劳动合同法》第48条",
        excerpt: "违法解除或者终止劳动合同的法律后果",
        url: "https://pkulaw.example/chl?tiao=48",
      }],
      docUrl: "https://example.com/doc/123",
      elapsedMs: 1_250,
      syncedEvidenceCount: 0,
      syncedGapCount: 0,
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));

    expect(serialized).toContain("二次审查完成");
    expect(serialized).not.toContain("\"tag\":\"劳动\",\"value\":32");
    expect(serialized).toContain("耗时 1s");
    expect(serialized).toContain("二审状态：需人工复核（1 项），法条引用已完成独立校验");
    expect(serialized).toContain("中风险问题（1项）");
    expect(serialized).toContain("社保欠缴依据需补充权威来源");
    expect(serialized).toContain("已校验法条（1项）");
    expect(serialized).toContain("《中华人民共和国劳动合同法》第48条");
    expect(serialized).toContain("[《中华人民共和国劳动合同法》第48条](https://pkulaw.example/chl?tiao=48)");
    expect(serialized).toContain("https://pkulaw.example/chl?tiao=48");
    expect(serialized).not.toContain("打开分析文档");
    expect(serialized).not.toContain("labor-review-action");
    expect(serialized).not.toContain("打开北大法宝原文");
    expect(serialized).not.toContain("需人工复核的问题");
    expect(serialized).not.toContain("高风险问题");
    expect(serialized).not.toContain("低风险问题");
    expect(serialized).not.toContain("二审状态：法条引用");
  });

  it("renders labor final review progress from runtime state instead of template defaults", () => {
    const payload = buildLaborFinalReviewPayload({
      title: "张三劳动争议案",
      statusText: "二审模型审查中...",
      level: "info",
      authorityStatus: "error",
      citationStatus: "skipped",
      modelReviewStatus: "running",
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));

    expect(serialized).toContain("整理审查材料：已完成");
    expect(serialized).toContain("法条与案例溯源：不可用");
    expect(serialized).toContain("二审模型审查：进行中");
    expect(serialized).toContain("汇总审查结论：等待中");
    expect(serialized).not.toContain("权威法规检索：已完成");
    expect(serialized).not.toContain("请求权基础校验：等待中");
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
