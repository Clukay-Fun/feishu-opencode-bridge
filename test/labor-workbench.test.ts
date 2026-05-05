/**
 * 职责: 覆盖劳动分析工作台辅助流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import { renderLaborWorkbenchMarkdown, type LaborAggregateResult } from "../src/labor/index.js";

describe("labor workbench markdown", () => {
  it("embeds readable diagrams without blank whiteboard placeholders", () => {
    const markdown = renderLaborWorkbenchMarkdown(createAggregate(), 2, []);

    expect(markdown).toContain("#### 2. 证据关系图");
    expect(markdown).toContain("#### 3. 请求项结构图");
    expect(markdown).toContain("#### 4. 补证流程图");
    expect(markdown).toContain("```mermaid\nflowchart TD");
    expect(markdown).toContain("违法解除");
    expect(markdown).toContain("补充社保欠缴证据");
    expect(markdown).not.toContain("<whiteboard type=\"blank\"></whiteboard>");
    expect(markdown).not.toContain("暂时无法在飞书文档外展示此内容");
  });
});

function createAggregate(): LaborAggregateResult {
  return {
    caseTitle: "张某某违法解除劳动合同争议",
    disputeStage: "证据整理中",
    summary: "现有证据可以支撑违法解除主张。",
    coreJudgment: ["解除通知与聊天记录可以形成初步证据链。"],
    evidenceRows: [
      {
        name: "解除通知",
        type: "通知",
        proves: "违法解除",
        support: "支持劳动者",
        strength: "strong",
        risk: "需核对送达时间",
      },
    ],
    timeline: [
      { date: "2026-01-10", event: "收到解除通知", evidence: "解除通知" },
    ],
    issues: [
      { issue: "违法解除", analysis: "需要核对解除理由和规章制度依据。", riskLevel: "medium" },
    ],
    missingEvidence: ["社保欠缴记录"],
    nextActions: ["补充社保欠缴证据", "核算赔偿金", "准备仲裁申请书"],
    legalSupports: [
      { issue: "违法解除", rule: "需人工复核", relation: "关联解除合法性" },
    ],
    keyIssues: ["解除是否合法", "赔偿金如何计算"],
    claimBasis: [
      {
        claim: "违法解除赔偿金",
        basis: "《中华人民共和国劳动合同法》第四十八条",
        evidence: ["解除通知", "聊天记录"],
        risk: "需核对解除理由",
        reviewNote: "需律师复核规章制度民主程序",
      },
    ],
    strategy: {
      litigation: ["围绕解除理由和送达时间组织证据"],
      mediation: ["以赔偿金区间作为谈判锚点"],
      response: ["准备回应用人单位关于严重违纪的抗辩"],
    },
    draftDocuments: [
      { type: "仲裁申请书", summary: "围绕违法解除赔偿金形成请求摘要" },
    ],
  };
}
