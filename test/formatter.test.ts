import { describe, expect, it } from "vitest";

import {
  buildCloseCommandCardPayload,
  buildLeaveCommandCardPayload,
  buildModelCommandCardPayload,
  buildNoticeCardPayload,
  buildPermissionNoticeCardPayload,
  buildPostMarkdownPayload,
  buildPostPayload,
  buildRenameCommandCardPayload,
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

  it("renders a status command card", () => {
    const payload = buildStatusCommandCardPayload({
      currentSession: {
        sessionId: "ses_2988a201effeCaZpLXXjarY0pM",
        label: "能不能获取舆论新闻",
      },
      connectionState: "connected",
      sessionMode: "multi",
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
    expect(content.body.elements[1].columns[0].elements[1].columns).toHaveLength(5);
    expect(content.body.elements[1].columns[0].elements[1].columns[0].elements[0].content).toBe("connected");
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

  it("renders a rename command card", () => {
    const payload = buildRenameCommandCardPayload({
      previousLabel: "帮我写个单测",
      currentLabel: "代码审查",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("已重命名会话");
    expect(content.body.elements[0].columns[1].elements[0].content).toBe("~~帮我写个单测~~");
    expect(content.body.elements[1].columns[1].elements[0].content).toBe("**代码审查**");
  });

  it("renders a close command card with next session", () => {
    const payload = buildCloseCommandCardPayload({
      closedLabel: "帮我写个单测",
      nextLabel: "代码审查",
      footer: "当前已切换到「代码审查」",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("已关闭会话");
    expect(content.body.elements[0].columns[1].elements[0].content).toBe("~~帮我写个单测~~");
    expect(content.body.elements[1].columns[1].elements[0].content).toBe("**代码审查**");
    expect(content.body.elements[3].columns[0].elements[0].content).toContain("代码审查");
  });

  it("renders a yellow notice card", () => {
    const payload = buildNoticeCardPayload({
      title: "提醒",
      message: "会话列表已过期，请重新发送 `/sessions`",
      template: "yellow",
      iconToken: "maybe_outlined",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("提醒");
    expect(content.header.template).toBe("yellow");
    expect(content.header.icon.token).toBe("maybe_outlined");
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("`/sessions`");
  });

  it("renders an orange abort notice card", () => {
    const payload = buildNoticeCardPayload({
      title: "任务已中止",
      message: "当前任务已中止，可发送新消息继续对话。",
      template: "orange",
      iconToken: "stop-record_filled",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("任务已中止");
    expect(content.header.template).toBe("orange");
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("当前任务已中止");
  });

  it("renders a permission notice card with fake buttons", () => {
    const payload = buildPermissionNoticeCardPayload({
      command: "rm -rf dist/",
      timeoutText: "120s 后自动拒绝",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("权限请求");
    expect(content.header.template).toBe("purple");
    expect(content.body.elements[0].columns[0].elements[0].content).toBe("OpenCode 想执行：");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[0].content).toContain("rm -rf dist/");
    expect(content.body.elements[2].columns[0].elements[0].text.content).toContain("/allow once");
    expect(content.body.elements[2].columns[1].elements[0].text.content).toContain("/allow always");
    expect(content.body.elements[2].columns[2].elements[0].text.content).toContain("/deny");
    expect(content.body.elements[3].content).toBe("120s 后自动拒绝");
  });

  it("renders a model command card", () => {
    const payload = buildModelCommandCardPayload({
      providers: [
        {
          title: "OpenAI 模型",
          highlightStyle: "purple-50",
          models: [
            { label: "gpt-5.4-mini", current: true, default: true },
            { label: "gpt-5.4" },
          ],
        },
        {
          title: "OpenCode 模型",
          highlightStyle: "blue-50",
          models: [
            { label: "big-pickle" },
          ],
        },
      ],
      footer: "`/model use <provider/model>` 切换当前窗口模型\n当前仅展示每个提供方最近 5 个模型；发送 `/model <provider>` 查看更多。",
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("可用模型");
    expect(content.header.template).toBe("indigo");
    expect(content.body.elements[0].columns[0].elements[0].content).toBe("OpenAI 模型");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].background_style).toBe("purple-50");
    expect(content.body.elements[0].columns[0].elements[1].columns[0].elements[0].content).toContain("gpt-5.4-mini");
    expect(content.body.elements[4].content).toContain("最近 5 个模型");
  });
});
