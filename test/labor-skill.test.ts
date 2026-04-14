import { describe, expect, it } from "vitest";

import { buildLaborCaseAnalysisPrompt, buildLaborDocumentPublishPrompt, buildLaborMaterialExtractionPrompt } from "../src/labor/prompts.js";
import { buildLaborEvidenceMapMermaid, buildLaborTimelineMermaid, renderLaborAnalysisMarkdown } from "../src/labor/renderer.js";
import { buildLaborAnalysisProcessingPayload } from "../src/feishu/formatter.js";

describe("labor skill prompts", () => {
  it("builds material extraction prompt with labor evidence and contract review requirements", () => {
    const prompt = buildLaborMaterialExtractionPrompt({
      sourceFile: "劳动合同.pdf",
      materialMarkdown: "试用期六个月，服务期三年。",
    });

    expect(prompt).toContain("劳动争议案件材料分析助手");
    expect(prompt).toContain("证据价值");
    expect(prompt).toContain("时间线事件");
    expect(prompt).toContain("不合规或可能无效的条款");
    expect(prompt).toContain("materialType");
    expect(prompt).toContain("劳动合同.pdf");
  });

  it("builds case analysis prompt that treats notes as background and asks for proof burden", () => {
    const prompt = buildLaborCaseAnalysisPrompt({
      caseContext: {
        caseTitle: "张某违法解除争议",
        notes: ["员工张某 2026 年 3 月被辞退。"],
      },
      materialExtractions: [{
        sourceFile: "解除通知.txt",
        materialType: "notice",
        summary: "公司解除劳动关系。",
        facts: [],
        timelineEvents: [],
        evidenceRows: [],
        contractRisks: [],
        riskPoints: [],
        missingEvidenceHints: [],
      }],
    });

    expect(prompt).toContain("证据链分析助手");
    expect(prompt).toContain("举证责任");
    expect(prompt).toContain("文字说明只能作为背景理解，不能替代证据");
    expect(prompt).toContain("knowledgeQuery");
    expect(prompt).toContain("张某违法解除争议");
  });

  it("builds document publish prompt with lark-cli fallback instructions", () => {
    const prompt = buildLaborDocumentPublishPrompt({
      docTitle: "劳动争议案件分析工作台",
      finalMarkdown: "### 案件摘要\n\n结论",
      timelineWhiteboardMermaid: "flowchart TD\nA-->B",
      evidenceMapWhiteboardMermaid: "flowchart TD\nC-->D",
    });

    expect(prompt).toContain("lark-cli docs +create");
    expect(prompt).toContain("lark-cli whiteboard +update");
    expect(prompt).toContain("data.board_tokens");
    expect(prompt).toContain("第一个画板");
    expect(prompt).toContain("第二个画板");
    expect(prompt).toContain("不要重新分析案件材料");
    expect(prompt).toContain("原样返回下面的 Markdown 和 Mermaid");
  });
});

describe("labor skill renderer", () => {
  it("renders the fixed Feishu document sections", () => {
    const markdown = renderLaborAnalysisMarkdown({
      generatedAt: new Date("2026-04-14T12:00:00Z"),
      report: {
        caseTitle: "张某违法解除争议",
        disputeStage: "仲裁前",
        summary: {
          materialCount: 2,
          currentConclusion: "解除事实需要继续核实。",
          riskLevel: "medium",
          recommendedAction: "补充送达证据。",
        },
        coreJudgment: ["劳动关系初步有合同支持。"],
        evidenceRows: [{
          evidenceName: "劳动合同.pdf",
          evidenceType: "书证",
          proves: "双方存在劳动关系",
          supportDirection: "supports_worker",
          probativeStrength: "strong",
          riskOrGap: "需核对签署页",
          note: "含试用期条款",
        }],
        timeline: [{
          date: "2026-03-01",
          event: "公司发出解除通知",
          evidence: "解除通知.txt",
          confidence: "high",
        }],
        issues: [{
          issue: "解除是否合法",
          proofBurden: "用人单位需证明解除理由和程序合法",
          supportingEvidence: ["解除通知.txt"],
          weakness: "缺送达证据",
          riskLevel: "medium",
          knowledgeQuery: "违法解除劳动合同举证责任",
        }],
        riskItems: [],
        missingEvidence: [{
          evidence: "送达记录",
          whyNeeded: "证明解除通知到达时间",
          priority: "high",
        }],
        nextActions: ["补充聊天记录和送达截图。"],
      },
      supports: [],
      failedMaterials: [],
    });

    expect(markdown).toContain("### 案件摘要");
    expect(markdown).toContain("### 证据链总表");
    expect(markdown).toContain("### 关键事实时间线");
    expect(markdown).toContain("### 时间线画板");
    expect(markdown).toContain("### 证据关系图画板");
    expect(markdown).toContain("<whiteboard type=\"blank\"></whiteboard>");
    expect(markdown).toContain("### 法律依据与知识库支撑");
    expect(markdown).toContain("当前未检索到明确依据，需人工补核。");
  });

  it("builds timeline mermaid for the whiteboard", () => {
    const mermaid = buildLaborTimelineMermaid({
      caseTitle: "张某违法解除争议",
      disputeStage: "仲裁前",
      summary: {
        materialCount: 1,
        currentConclusion: "待核实",
        riskLevel: "medium",
        recommendedAction: "补证",
      },
      coreJudgment: [],
      evidenceRows: [],
      timeline: [
        { date: "2026-01-01", event: "签署劳动合同", evidence: "劳动合同.pdf", confidence: "high" },
        { date: "2026-03-01", event: "公司发出解除通知", evidence: "解除通知.txt", confidence: "high" },
      ],
      issues: [],
      riskItems: [],
      missingEvidence: [],
      nextActions: [],
    });

    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain("2026-01-01");
    expect(mermaid).toContain("公司发出解除通知");
  });

  it("builds evidence map mermaid for issues and supporting evidence", () => {
    const mermaid = buildLaborEvidenceMapMermaid({
      caseTitle: "张某违法解除争议",
      disputeStage: "仲裁前",
      summary: {
        materialCount: 1,
        currentConclusion: "待核实",
        riskLevel: "medium",
        recommendedAction: "补证",
      },
      coreJudgment: [],
      evidenceRows: [],
      timeline: [],
      issues: [
        {
          issue: "解除是否合法",
          proofBurden: "单位举证",
          supportingEvidence: ["解除通知.txt", "聊天记录.md"],
          weakness: "缺送达证据",
          riskLevel: "medium",
          knowledgeQuery: "违法解除劳动合同举证责任",
        },
      ],
      riskItems: [],
      missingEvidence: [],
      nextActions: [],
    });

    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain("解除是否合法");
    expect(mermaid).toContain("解除通知.txt");
    expect(mermaid).toContain("缺口：缺送达证据");
  });
});

describe("labor skill card payload", () => {
  it("uses labor analysis wording instead of knowledge ingest wording", () => {
    const payload = buildLaborAnalysisProcessingPayload({
      sourceLabel: "劳动争议案件材料",
      steps: [
        { label: "解析中", detail: "正在解析材料（1/2）", status: "running" },
        { label: "提取中", detail: "等待开始", status: "pending" },
      ],
    });

    expect(payload.content).toContain("劳动分析处理中");
    expect(payload.content).not.toContain("知识入库处理中");
    expect(payload.content).toContain("解析中");
  });
});
