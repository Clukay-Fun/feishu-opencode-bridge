import { describe, expect, it } from "vitest";

import { buildPostMarkdownPayload, buildPostPayload, buildTurnStatusCardPayload } from "../src/feishu/formatter.js";

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
    const outputContents = content.body.elements[9].columns[0].elements.map((item: { content: string }) => item.content).join("\n");
    expect(content.header.title.content).toBe("任务进行中");
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("会话 ID");
    expect(content.body.elements[0].columns[1].elements[0].content).toContain("约 8s");
    expect(content.body.elements[3].columns[0].elements[0].content).toContain("生成最终回复");
    expect(content.body.elements[6].columns[0].elements[0].content).toContain("✅ **读取文件**：package.json");
    expect(content.body.elements[6].columns[0].elements[1].content).toContain("⏳ **执行命令**：npm run dev");
    expect(outputContents).toContain("[工业和信息化部办公厅关于开展普惠算力赋能中小企业发展专项行动的通知](https://www.miit.gov.cn/example)");
    expect(outputContents).toContain("**今日新闻五条_正式版.md**");
    expect(outputContents).toContain("`C:\\Users\\LENOVO\\Desktop\\今日新闻五条_正式版.md`");
  });
});
