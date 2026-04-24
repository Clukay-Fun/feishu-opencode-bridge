import { describe, expect, it, vi } from "vitest";

import { generateCaseWorkflowWorkbench } from "../src/workflows/case-workflow.js";
import { buildTimelineMermaid } from "../src/workflows/timeline-build.js";
import { withWhiteboardDslInstruction } from "../src/workflows/workbench-generate.js";

describe("shared case workflows", () => {
  it("builds reusable timeline diagrams in date order", () => {
    const source = buildTimelineMermaid([
      { date: "2026-02-01", event: "申请仲裁" },
      { date: "2026-01-01", event: "收到解除通知" },
    ]);

    expect(source).toContain("N1[\"2026-01-01｜收到解除通知\"]");
    expect(source).toContain("N2[\"2026-02-01｜申请仲裁\"]");
    expect(source).toContain("N1 --> N2");
  });

  it("creates a case workbench document and updates shared diagrams", async () => {
    const createDocument = vi.fn(async () => ({
      docUrl: "https://example.com/doc",
      boardTokens: ["board_1"],
    }));
    const updateBoards = vi.fn(async () => {});
    const onProgress = vi.fn();

    const result = await generateCaseWorkflowWorkbench({
      title: "案件工作台",
      markdown: "# 案件工作台",
      diagrams: [{ source: "flowchart TD\nA[开始]" }],
      logger: { log: vi.fn() },
      logScope: "test",
      onProgress,
      createDocument,
      updateBoards,
    });

    expect(result).toEqual({ docUrl: "https://example.com/doc" });
    expect(createDocument).toHaveBeenCalledWith("案件工作台", "# 案件工作台");
    expect(updateBoards).toHaveBeenCalledWith(["board_1"], [{ source: "flowchart TD\nA[开始]" }]);
    expect(onProgress).toHaveBeenCalledWith("正在生成飞书工作台文档");
    expect(onProgress).toHaveBeenCalledWith("正在生成时间线、关系图和思维导图");
  });

  it("marks Mermaid sources for Feishu whiteboard rendering", () => {
    expect(withWhiteboardDslInstruction("flowchart TD\nA[开始]")).toContain("使用飞书白板内置DSL精确控制样式");
  });
});
