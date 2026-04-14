import type { LaborAnalysisReport, LaborFailedMaterial, LaborKnowledgeSupport } from "./types.js";

export function renderLaborAnalysisMarkdown(input: {
  report: LaborAnalysisReport;
  supports: LaborKnowledgeSupport[];
  failedMaterials: LaborFailedMaterial[];
  generatedAt?: Date | undefined;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  return [
    `# ${escapeMarkdown(input.report.caseTitle || "劳动争议案件分析工作台")}`,
    "",
    "### 案件摘要",
    "",
    `- 生成时间：${formatDateTime(generatedAt)}`,
    `- 材料数量：${input.report.summary.materialCount}`,
    `- 当前争议阶段：${escapeMarkdown(input.report.disputeStage)}`,
    `- 当前结论：${escapeMarkdown(input.report.summary.currentConclusion || "待进一步核实")}`,
    `- 风险等级：${escapeMarkdown(input.report.summary.riskLevel)}`,
    `- 当前建议动作：${escapeMarkdown(input.report.summary.recommendedAction || "请律师结合原始材料复核")}`,
    "",
    "### 核心判断",
    "",
    renderList(input.report.coreJudgment),
    "",
    "### 证据链总表",
    "",
    renderEvidenceTable(input.report.evidenceRows),
    "",
    "### 关键事实时间线",
    "",
    renderTimelineTable(input.report.timeline),
    "",
    "### 时间线画板",
    "",
    "<whiteboard type=\"blank\"></whiteboard>",
    "",
    "### 证据关系图画板",
    "",
    "<whiteboard type=\"blank\"></whiteboard>",
    "",
    "### 争议焦点与风险",
    "",
    renderIssues(input.report),
    "",
    "### 法律依据与知识库支撑",
    "",
    renderKnowledgeSupports(input.supports),
    "",
    "### 待补材料与下一步建议",
    "",
    renderMissingEvidence(input.report, input.failedMaterials),
  ].join("\n");
}

export function buildLaborDocTitle(report: LaborAnalysisReport): string {
  return report.caseTitle?.trim() || `劳动争议案件分析工作台 ${formatDate(new Date())}`;
}

export function buildLaborTimelineMermaid(report: LaborAnalysisReport): string {
  const events = report.timeline.slice(0, 12);
  if (events.length === 0) {
    return [
      "flowchart TD",
      '    A["待补充时间线"] --> B["上传更多案件材料"]',
    ].join("\n");
  }
  const lines = ["flowchart TD"];
  events.forEach((event, index) => {
    const nodeId = `N${index + 1}`;
    const label = escapeMermaid(`${event.date}\\n${event.event}`);
    lines.push(`    ${nodeId}["${label}"]`);
    if (index > 0) {
      lines.push(`    N${index} --> ${nodeId}`);
    }
  });
  return lines.join("\n");
}

export function buildLaborEvidenceMapMermaid(report: LaborAnalysisReport): string {
  const issues = report.issues.slice(0, 6);
  if (issues.length === 0) {
    return [
      "flowchart TD",
      '    A["待补充争议焦点"] --> B["继续上传案件材料"]',
    ].join("\n");
  }

  const lines = ["flowchart TD"];
  issues.forEach((issue, index) => {
    const issueId = `I${index + 1}`;
    lines.push(`    ${issueId}["${escapeMermaid(issue.issue)}"]`);

    const evidences = issue.supportingEvidence.slice(0, 3);
    if (evidences.length === 0) {
      const missingId = `${issueId}M`;
      lines.push(`    ${missingId}["${escapeMermaid(issue.weakness || "待补强证据")}"]`);
      lines.push(`    ${issueId} --> ${missingId}`);
      return;
    }

    evidences.forEach((evidence, evidenceIndex) => {
      const evidenceId = `${issueId}E${evidenceIndex + 1}`;
      lines.push(`    ${evidenceId}["${escapeMermaid(evidence)}"]`);
      lines.push(`    ${issueId} --> ${evidenceId}`);
    });

    if (issue.weakness) {
      const weaknessId = `${issueId}W`;
      lines.push(`    ${weaknessId}["${escapeMermaid(`缺口：${issue.weakness}`)}"]`);
      lines.push(`    ${issueId} --> ${weaknessId}`);
    }
  });

  return lines.join("\n");
}

function renderEvidenceTable(rows: LaborAnalysisReport["evidenceRows"]): string {
  if (rows.length === 0) {
    return "暂无可结构化展示的证据项。";
  }
  return [
    "| 证据名称 | 类型 | 证明事实 | 支持方向 | 证明力 | 风险/缺口 | 备注 |",
    "|----------|------|----------|----------|--------|-----------|------|",
    ...rows.map((row) => [
      row.evidenceName,
      row.evidenceType,
      row.proves,
      row.supportDirection,
      row.probativeStrength,
      row.riskOrGap,
      row.note,
    ].map(escapeTableCell).join(" | ")).map((line) => `| ${line} |`),
  ].join("\n");
}

function renderTimelineTable(rows: LaborAnalysisReport["timeline"]): string {
  if (rows.length === 0) {
    return "暂无明确时间线，需要继续补充材料。";
  }
  return [
    "| 日期 | 事件 | 对应证据 | 置信度 |",
    "|------|------|----------|--------|",
    ...rows.map((row) => `| ${escapeTableCell(row.date)} | ${escapeTableCell(row.event)} | ${escapeTableCell(row.evidence)} | ${escapeTableCell(row.confidence)} |`),
  ].join("\n");
}

function renderIssues(report: LaborAnalysisReport): string {
  const sections: string[] = [];
  if (report.issues.length === 0) {
    sections.push("暂无明确争议焦点，需要继续补充材料。");
  } else {
    for (const issue of report.issues) {
      sections.push([
        `- 争议焦点：${escapeMarkdown(issue.issue)}`,
        `  举证责任：${escapeMarkdown(issue.proofBurden)}`,
        `  已有证据：${escapeMarkdown(issue.supportingEvidence.join("、") || "暂无")}`,
        `  薄弱点：${escapeMarkdown(issue.weakness || "待核实")}`,
        `  风险等级：${escapeMarkdown(issue.riskLevel)}`,
      ].join("\n"));
    }
  }

  if (report.riskItems.length > 0) {
    sections.push([
      "",
      "| 风险事项 | 风险原因 | 可能后果 | 建议处理 |",
      "|----------|----------|----------|----------|",
      ...report.riskItems.map((item) => `| ${escapeTableCell(item.item)} | ${escapeTableCell(item.reason)} | ${escapeTableCell(item.possibleConsequence)} | ${escapeTableCell(item.suggestion)} |`),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function renderKnowledgeSupports(supports: LaborKnowledgeSupport[]): string {
  if (supports.length === 0) {
    return "当前未检索到明确依据，需人工补核。";
  }
  const rows: string[] = [
    "| 争议点 | 对应规则/知识点 | 与本案关系 |",
    "|--------|------------------|------------|",
  ];
  for (const support of supports) {
    if (support.result.results.length === 0) {
      rows.push(`| ${escapeTableCell(support.issue)} | 当前未检索到明确依据 | 需人工补核 |`);
      continue;
    }
    for (const result of support.result.results.slice(0, 2)) {
      rows.push(`| ${escapeTableCell(support.issue)} | ${escapeTableCell(result.answer)} | ${escapeTableCell(result.statute ?? result.sourceFile)} |`);
    }
  }
  return rows.join("\n");
}

function renderMissingEvidence(report: LaborAnalysisReport, failedMaterials: LaborFailedMaterial[]): string {
  const lines: string[] = [];
  if (report.missingEvidence.length > 0) {
    lines.push("| 建议补充材料 | 原因 | 优先级 |", "|--------------|------|--------|");
    for (const item of report.missingEvidence) {
      lines.push(`| ${escapeTableCell(item.evidence)} | ${escapeTableCell(item.whyNeeded)} | ${escapeTableCell(item.priority)} |`);
    }
  } else {
    lines.push("暂无明确待补材料，仍建议律师复核原始证据。");
  }

  if (failedMaterials.length > 0) {
    lines.push("", "解析失败材料：");
    lines.push(...failedMaterials.map((item) => `- ${escapeMarkdown(item.sourceFile)}：${escapeMarkdown(item.reason)}`));
  }

  if (report.nextActions.length > 0) {
    lines.push("", "下一步建议：", renderList(report.nextActions));
  }
  return lines.join("\n");
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${escapeMarkdown(item)}`).join("\n") : "- 待进一步核实。";
}

function escapeTableCell(value: string): string {
  return escapeMarkdown(String(value || "")).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeMarkdown(value: string): string {
  return String(value || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 16);
}

function escapeMermaid(value: string): string {
  return value.replace(/"/g, '\\"');
}
