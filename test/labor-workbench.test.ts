/**
 * 职责: 覆盖劳动分析工作台辅助流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import {
  formatLaborReviewFindingText,
  renderLaborReviewAppendMarkdown,
  renderLaborWorkbenchMarkdown,
  type LaborAggregateResult,
  type LaborFinalReviewReport,
} from "../src/labor/index.js";

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

  it("keeps party information materials in a dedicated workbench section", () => {
    const markdown = renderLaborWorkbenchMarkdown(createAggregate(), 2, [], [{
      sourceFileName: "当事人信息.txt",
      materialType: "当事人信息",
      summary: "申请人张某某，被申请人为 XXX 公司。",
      facts: [
        "申请人：张某某，身份证号 330100199001010011，联系电话 13800000000",
        "被申请人：XXX 公司，住所地杭州市西湖区，法定代表人李某",
      ],
      timelineEvents: [],
      evidenceRows: [],
      riskPoints: [],
      missingEvidenceHints: [],
    }]);

    expect(markdown).toContain("### 当事人信息");
    expect(markdown).toContain("当事人信息.txt");
    expect(markdown).toContain("申请人：XXX");
    expect(markdown).toContain("被申请人：XXX公司");
  });

  it("renders readable final review findings for cards and workbench documents", () => {
    const highFinding: LaborFinalReviewReport["findings"][number] = {
      severity: "high",
      type: "null_source",
      message: "工资标准举证责任 marked as '需人工补核' with no legal source provided — source.type is null, per Rule 1 this triggers human review",
      relatedSection: "请求权基础",
      source: { type: null },
    };
    const mediumFinding: LaborFinalReviewReport["findings"][number] = {
      severity: "medium",
      type: "citation",
      message: "社保补缴 cites 社会保险法第60条 which is not individually verified in 修正生成幻觉; only 第58条 is verified",
      source: { type: "authority", ref: "社会保险法第58条" },
    };

    const readable = formatLaborReviewFindingText(highFinding);
    expect(readable).toContain("请求权基础：工资标准举证责任缺少可核验来源");
    expect(readable).not.toContain("source.type");

    const markdown = renderLaborReviewAppendMarkdown({
      status: "needs_human_review",
      findings: [
        highFinding,
        mediumFinding,
        { severity: "low", type: "unknown", message: "", source: { type: null } },
      ],
      unsupportedClaims: [],
      authorityCoverage: [],
      suggestedEdits: [],
      warnings: [],
    });

    expect(markdown).toContain("### 二次审查意见");
    expect(markdown).toContain("background-color=\"light-red\"");
    expect(markdown).toContain("background-color=\"light-blue\"");
    expect(markdown).toContain("background-color=\"light-green\"");
    expect(markdown).toContain("本次未完成逐条校验，仅校验到第58条");
    expect(markdown).toContain("审查项 unknown，来源为空，需要人工复核");
  });

  it("does not leave empty evidence support cells in claim basis table", () => {
    const aggregate = createAggregate();
    aggregate.claimBasis = [{
      claim: "工资差额",
      basis: "需人工补核",
      evidence: [],
      risk: "需补充工资流水",
      reviewNote: "待律师复核",
    }];
    aggregate.evidenceRows = [];

    const markdown = renderLaborWorkbenchMarkdown(aggregate, 1, []);

    expect(markdown).toContain("未绑定具体证据，需回看证据链总表补核");
    expect(markdown).not.toContain("需人工补核\n    </lark-td>\n  </lark-tr>");
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
