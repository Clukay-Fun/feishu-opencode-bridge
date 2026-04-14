import { describe, expect, it } from "vitest";

import {
  inferFeeModeFromRequest,
  postProcessContractDraftMarkdown,
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
});
