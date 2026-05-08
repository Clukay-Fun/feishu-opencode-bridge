/**
 * 职责: 覆盖飞书业务卡片模板注册和渲染流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createBusinessCardTemplateRegistry, listBusinessCardTemplates } from "../src/feishu/templates/registry.js";
import { BusinessCardTemplateValidationError, renderBusinessCard } from "../src/feishu/templates/runtime.js";
import type { AnyBusinessCardTemplateDefinition } from "../src/feishu/templates/definition.js";

describe("business card templates", () => {
  it("registers labor analysis templates", () => {
    expect(listBusinessCardTemplates()).toEqual([
      "labor.analysis.progress",
      "labor.analysis.completed",
      "labor.review.completed",
    ]);
  });

  it("renders a labor analysis progress template by template id", () => {
    const payload = renderBusinessCard("labor.analysis.progress", {
      sourceLabel: "证据目录.pdf",
      steps: [
        { label: "提取事实", detail: "正在识别关键事实", status: "running" },
        { label: "整理证据", detail: "等待开始", status: "pending" },
      ],
      progressText: "正在汇总争议焦点",
      elapsedMs: 5_000,
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("材料分析进行中");
    expect(serialized).toContain("证据目录.pdf");
    expect(serialized).toContain("提取事实");
    expect(serialized).toContain("正在汇总争议焦点");
    expect(serialized).toContain("耗时：5s");
  });

  it("throws validation errors for invalid template input", () => {
    expect(() => renderBusinessCard("labor.analysis.progress", {
      steps: [],
      elapsedMs: 1_000,
    })).toThrow(BusinessCardTemplateValidationError);
  });

  it("rejects duplicate template ids during registry creation", () => {
    const template = createTemplate("demo.card");

    expect(() => createBusinessCardTemplateRegistry([template, template])).toThrow(
      "Duplicate business card template id: demo.card",
    );
  });
});

function createTemplate(id: string): AnyBusinessCardTemplateDefinition {
  return {
    id,
    schema: z.object({}),
    render: () => ({
      title: "Demo",
      template: "blue",
      iconToken: "chat_outlined",
      blocks: [],
    }),
  };
}
