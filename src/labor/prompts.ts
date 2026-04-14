import type { LaborCaseContext, LaborMaterialExtraction } from "./types.js";

export function buildLaborMaterialExtractionPrompt(input: {
  sourceFile: string;
  materialMarkdown: string;
}): string {
  return [
    "你是劳动争议案件材料分析助手。",
    "",
    "请从劳动争议办案视角分析以下单份材料。",
    "",
    "你的任务不是写法律意见书，也不是起草文书，而是把材料转成后续证据链分析可用的结构化信息。",
    "",
    "请重点识别：",
    "1. 材料类型，例如劳动合同、工资单、考勤记录、聊天记录、解除通知、离职协议、仲裁材料、其他。",
    "2. 关键事实，包括主体、时间、岗位、薪资、工作年限、解除原因、沟通内容等。",
    "3. 时间线事件，只提取可以从材料中直接看出的时间节点。",
    "4. 证据价值，即这份材料可能证明什么。",
    "5. 对劳动者有利或不利的点。",
    "6. 风险点和证据缺口。",
    "",
    "如果材料属于合同、协议、offer、通知书等关键文书，请额外识别：",
    "1. 不合规或可能无效的条款。",
    "2. 对劳动者明显不利的约定。",
    "3. 与解除、试用期、竞业限制、培训服务期、薪资调整相关的风险。",
    "",
    "不要编造材料中没有的信息。",
    "不能确定的内容写入 riskPoints 或 missingEvidenceHints。",
    "",
    "请只输出 JSON 对象，结构如下：",
    JSON.stringify({
      sourceFile: "文件名",
      materialType: "contract | payroll | attendance | chat | notice | resignation | arbitration | other",
      summary: "100 字以内材料摘要",
      facts: [{
        fact: "关键事实",
        sourceLocation: "页码、段落或原文位置；无法定位时写 unknown",
        confidence: "high | medium | low",
      }],
      timelineEvents: [{
        date: "YYYY-MM-DD 或原文日期",
        event: "事件",
        sourceLocation: "来源位置",
        confidence: "high | medium | low",
      }],
      evidenceRows: [{
        evidenceName: "证据名称",
        evidenceType: "书证 | 电子数据 | 视听资料 | 证人证言 | 其他",
        proves: "证明事实",
        supportDirection: "supports_worker | supports_employer | neutral | unclear",
        probativeStrength: "strong | medium | weak",
        riskOrGap: "风险或缺口",
        note: "备注",
      }],
      contractRisks: [{
        clauseOrContent: "条款或内容",
        risk: "风险点",
        possibleConsequence: "可能后果",
        suggestion: "建议处理",
      }],
      riskPoints: ["风险点"],
      missingEvidenceHints: ["缺失证据提示"],
    }, null, 2),
    "",
    `源文件：${input.sourceFile}`,
    "材料正文：",
    input.materialMarkdown,
  ].join("\n");
}

export function buildLaborCaseAnalysisPrompt(input: {
  caseContext: LaborCaseContext;
  materialExtractions: LaborMaterialExtraction[];
}): string {
  return [
    "你是劳动争议案件证据链分析助手。",
    "",
    "请基于多份材料的单材料提取结果，以及用户补充的案件背景说明，整理一个统一的案件认知。",
    "",
    "你的目标是帮助律师快速判断：",
    "1. 当前争议焦点是什么。",
    "2. 哪些关键事实已有证据支持。",
    "3. 哪些请求或抗辩方向证据较强。",
    "4. 哪些事实链条存在缺口。",
    "5. 当前还需要补什么材料。",
    "",
    "请特别注意：",
    "1. 合同、offer、离职协议、解除通知等关键文书要作为高价值材料处理。",
    "2. 如果存在合同类材料，请把不合规条款、对劳动者不利约定、解除或试用期风险归并到 issues 和 riskItems。",
    "3. 文字说明只能作为背景理解，不能替代证据。",
    "4. 不要把未在材料中出现的事实当作已证实事实。",
    "5. 对争议焦点给出举证责任和证据缺口判断。",
    "",
    "请只输出 JSON 对象，结构如下：",
    JSON.stringify({
      caseTitle: "案件标题",
      disputeStage: "咨询中 | 仲裁前 | 仲裁中 | 诉讼中 | 未知",
      summary: {
        materialCount: 0,
        currentConclusion: "当前总体判断",
        riskLevel: "high | medium | low | unknown",
        recommendedAction: "当前建议动作",
      },
      coreJudgment: ["核心判断 1", "核心判断 2"],
      evidenceRows: [{
        evidenceName: "证据名称",
        evidenceType: "证据类型",
        proves: "证明事实",
        supportDirection: "支持方向",
        probativeStrength: "证明力",
        riskOrGap: "风险/缺口",
        note: "备注",
      }],
      timeline: [{
        date: "日期",
        event: "事件",
        evidence: "对应证据",
        confidence: "high | medium | low",
      }],
      issues: [{
        issue: "争议焦点",
        proofBurden: "举证责任或证明要求",
        supportingEvidence: ["已有支持证据"],
        weakness: "薄弱点",
        riskLevel: "high | medium | low",
        knowledgeQuery: "用于查询劳动法知识库的问题",
      }],
      riskItems: [{
        item: "风险事项",
        reason: "风险原因",
        possibleConsequence: "可能后果",
        suggestion: "处理建议",
      }],
      missingEvidence: [{
        evidence: "建议补充材料",
        whyNeeded: "为什么需要",
        priority: "high | medium | low",
      }],
      nextActions: ["下一步动作"],
    }, null, 2),
    "",
    `案件标题：${input.caseContext.caseTitle ?? "未命名劳动争议案件"}`,
    "",
    "用户背景说明：",
    input.caseContext.notes.length > 0 ? input.caseContext.notes.map((note, index) => `${index + 1}. ${note}`).join("\n") : "无",
    "",
    "单材料提取结果：",
    JSON.stringify(input.materialExtractions, null, 2),
  ].join("\n");
}

export function buildLaborDocumentPublishPrompt(input: {
  docTitle: string;
  finalMarkdown: string;
  timelineWhiteboardMermaid: string;
  evidenceMapWhiteboardMermaid: string;
}): string {
  return [
    "请使用 lark-cli 创建飞书云文档。",
    "",
    `标题：${input.docTitle}`,
    "",
    "正文 Markdown 如下。",
    "",
    "要求：",
    "1. 不要重新分析案件材料。",
    "2. 不要改写 Markdown 结构。",
    "3. 使用 `lark-cli docs +create` 创建文档，保留 Markdown 中的 `<whiteboard type=\"blank\"></whiteboard>` 标签。",
    "4. 创建成功后，读取返回结果中的 `data.board_tokens`。",
    "5. 如果存在第一个画板 token，请使用 `lark-cli whiteboard +update --input_format mermaid --overwrite` 把下面提供的“时间线 Mermaid”写入第一个画板。",
    "6. 如果存在第二个画板 token，请使用 `lark-cli whiteboard +update --input_format mermaid --overwrite` 把下面提供的“证据关系图 Mermaid”写入第二个画板。",
    "7. 成功后只返回文档链接和一句简短说明。",
    "8. 如果 `lark-cli` 不可用、文档创建失败、或任一画板写入失败，请返回失败原因，并原样返回下面的 Markdown 和 Mermaid，方便用户手动处理。",
    "",
    "Markdown 文档内容：",
    input.finalMarkdown,
    "",
    "时间线 Mermaid：",
    input.timelineWhiteboardMermaid,
    "",
    "证据关系图 Mermaid：",
    input.evidenceMapWhiteboardMermaid,
  ].join("\n");
}
