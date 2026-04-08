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
    const toolContents = content.body.elements[0].columns[0].elements.map((item: { content: string }) => item.content).join("\n");
    const outputContents = content.body.elements[1].columns[0].elements.map((item: { content: string }) => item.content).join("\n");
    expect(content.header.title.content).toBe("正在忙");
    expect(content.header.template).toBe("blue");
    expect(content.header.icon.token).toBe("external_filled");
    expect(content.config.style.text_size.normal_v2.mobile).toBe("heading");
    expect(toolContents).toContain("**读取文件**：package.json");
    expect(toolContents).toContain("**执行命令**：npm run dev");
    expect(outputContents).toContain("[工业和信息化部办公厅关于开展普惠算力赋能中小企业发展专项行动的通知](https://www.miit.gov.cn/example)");
    expect(outputContents).toContain("**今日新闻五条_正式版.md**");
    expect(outputContents).toContain("`C:\\Users\\LENOVO\\Desktop\\今日新闻五条_正式版.md`");
    expect(content.body.elements[3].text.content).toBe("ID：ses_12345678｜耗时：约 8s");
  });

  it("renders a completed turn card without tool block", () => {
    const payload = buildTurnStatusCardPayload({
      title: "已完成",
      status: "已完成",
      sessionId: "ses_1234567890",
      durationText: "0.8 秒",
      progressUpdates: [],
      toolUpdates: [{ label: "执行命令", detail: "npm run build", status: "completed" }],
      output: {
        text: "已经处理完成",
        paths: [],
        commands: [],
      },
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("已完成");
    expect(content.header.template).toBe("green");
    expect(content.header.icon.token).toBe("thumbsup_filled");
    expect(content.body.elements).toHaveLength(3);
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("已经处理完成");
    expect(content.body.elements[2].text.content).toBe("ID：ses_12345678｜耗时：0.8 秒");
  });

  it("renders an error turn card", () => {
    const payload = buildTurnStatusCardPayload({
      title: "失败",
      status: "执行失败",
      sessionId: "ses_1234567890",
      durationText: "0.8 秒",
      progressUpdates: [],
      toolUpdates: [{ label: "读取文件", detail: "C:\\Users\\LENOVO", status: "error" }],
      output: {
        text: "",
        paths: [],
        commands: [],
      },
    });
    const content = JSON.parse(payload.content) as any;
    expect(content.header.title.content).toBe("出了点问题");
    expect(content.header.template).toBe("red");
    expect(content.header.icon.token).toBe("error_filled");
    expect(content.body.elements[0].columns[0].elements[0].content).toContain("**读取文件**：C:\\Users\\LENOVO");
    expect(content.body.elements[1].columns[0].elements[0].content).toBe("问题描述");
  });
});
