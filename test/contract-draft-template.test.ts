import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  inferFeeModeFromRequest,
  normalizeBitableDateValue,
  postProcessContractDraftMarkdown,
  resolveNumberedOutputPath,
  splitRiskNotice,
} from "../src/contract-assistant/index.js";

describe("contract draft template helpers", () => {
  it("splits risk notice attachment from main template", () => {
    const source = [
      "第一条 主合同",
      "第二条 主合同",
      "附件",
      "风险代理告知书",
      "这里是风险附件",
    ].join("\n");

    const result = splitRiskNotice(source);

    expect(result.mainText).toContain("第一条 主合同");
    expect(result.mainText).not.toContain("风险代理告知书");
    expect(result.riskNoticeText).toContain("风险代理告知书");
  });

  it("removes risk notice section when fee mode is stage_fixed", () => {
    const markdown = [
      "### 合同正文",
      "",
      "第一条 内容",
      "",
      "附件",
      "风险代理告知书",
      "附件内容",
    ].join("\n");

    expect(postProcessContractDraftMarkdown(markdown, "stage_fixed")).not.toContain("风险代理告知书");
    expect(postProcessContractDraftMarkdown(markdown, "base_plus_risk")).toContain("风险代理告知书");
  });

  it("infers risk fee mode from request keywords", () => {
    expect(inferFeeModeFromRequest("采用风险代理，按回款比例收取律师费")).toBe("base_plus_risk");
    expect(inferFeeModeFromRequest("仲裁阶段固定收费 8000 元")).toBe("stage_fixed");
  });

  it("normalizes natural-language contract dates for bitable", () => {
    const today = normalizeBitableDateValue("今天", new Date(2026, 3, 15, 9, 30, 0));
    const explicit = normalizeBitableDateValue("2026-04-15");

    expect(today).toBe(new Date(2026, 3, 15).getTime());
    expect(explicit).toBe(new Date(2026, 3, 15).getTime());
  });

  it("allocates numbered draft paths without embedding timestamps", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "contract-draft-template-"));
    const outputDir = path.join(tempDir, "contract-drafts");
    await mkdir(outputDir, { recursive: true });

    try {
      const first = await resolveNumberedOutputPath(outputDir, "委托代理合同（XXXvsXXX公司）", ".docx");
      await writeFile(first, "stub");
      const second = await resolveNumberedOutputPath(outputDir, "委托代理合同（XXXvsXXX公司）", ".docx");

      expect(path.basename(first)).toBe("委托代理合同（XXXvsXXX公司）.docx");
      expect(path.basename(second)).toBe("委托代理合同（XXXvsXXX公司）-2.docx");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
