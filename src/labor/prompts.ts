/**
 * 职责: 组装劳动争议分析模块使用的提示词模板。
 * 关注点:
 * - 区分单材料提取与多材料汇总两类任务。
 * - 让模型输出结构稳定、便于后续程序消费。
 */
import { LABOR_OUTPUT_TEMPLATE_HINTS } from "./templates/index.js";

export function buildLaborMaterialExtractPrompt(fileName: string, content: string, localPath?: string): string {
  return [
    "你是劳动争议材料分析助手。",
    "请从以下单份材料中提取证据属性、关键事实、时间线线索、风险点和缺失证据提示。",
    "请输出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- materialType: 材料类型，例如 劳动合同 / offer / 工资单 / 考勤 / 聊天记录 / 通知书 / 仲裁材料 / 其他",
    "- summary: 80 字以内摘要",
    "- facts: 字符串数组，列出关键事实",
    "- timelineEvents: 数组，元素字段为 date、event、evidence",
    "- evidenceRows: 数组，元素字段为 name、type、proves、support、strength、risk、remarks",
    "- riskPoints: 字符串数组",
    "- missingEvidenceHints: 字符串数组",
    "",
    "规则：",
    "1. 不确定的内容不要编造。",
    "2. date 优先使用 YYYY-MM-DD；如果没有明确日期可以留空。",
    "3. support 取值优先：supports_worker、supports_employer、neutral。",
    "4. strength 取值优先：strong、medium、weak。",
    "5. 如果材料是图片截图、扫描件或照片，请结合本地路径对应文件内容进行识别，不要只依赖补充文本。",
    "",
    `文件名：${fileName}`,
    localPath ? `本地路径：${localPath}` : "本地路径：无",
    "---材料文本开始---",
    content,
    "---材料文本结束---",
  ].join("\n");
}

export function buildLaborAggregatePrompt(materialsJson: string, notesText: string, legalSupportsJson: string): string {
  return [
    "你是劳动争议案件分析助手。",
    "请把多份劳动争议材料归并成统一的证据链分析结果，并输出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- caseTitle: 案件标题",
    "- disputeStage: 当前阶段，例如 仲裁前 / 仲裁中 / 诉讼中 / 内部评估",
    "- summary: 120 字以内案件摘要",
    "- coreJudgment: 字符串数组，列出当前核心判断",
    "- evidenceRows: 数组，元素字段为 name、type、proves、support、strength、risk、remarks",
    "- timeline: 数组，元素字段为 date、event、evidence",
    "- issues: 数组，元素字段为 issue、analysis、riskLevel",
    "- missingEvidence: 字符串数组",
    "- nextActions: 字符串数组",
    "- legalSupports: 数组，元素字段为 issue、rule、relation",
    "- keyIssues: 字符串数组，归纳 3-6 个争议焦点",
    "- claimBasis: 数组，元素字段为 claim、basis、evidence、risk、reviewNote",
    "- strategy: 对象，字段为 litigation、mediation、response，均为字符串数组",
    "- draftDocuments: 数组，元素字段为 type、summary、content",
    "",
    "劳动领域模板约束：",
    LABOR_OUTPUT_TEMPLATE_HINTS,
    "",
    "规则：",
    "1. 重点回答：现有证据能支持哪些劳动主张，缺哪些关键材料。",
    "2. 对 evidenceRows 和 timeline 去重，保留最关键项。",
    "3. riskLevel 优先使用 high、medium、low。",
    "4. 输出风格应像律师工作底稿：事实清楚、证据对应明确、风险提示克制。",
    "5. 法律依据不能凭空编造；如果没有知识库命中或明确规则，请在 legalSupports 中写明“需人工补核”。",
    "6. 避免长段落，每条判断尽量控制在 1-2 句，便于飞书文档阅读和录屏展示。",
    "7. 如果给了 legalSupports，请结合使用；没有明确命中只能保守输出，不得虚构法条编号、案例名称或裁判规则。",
    "",
    notesText
      ? `案件补充背景：\n---\n${notesText}\n---`
      : "案件补充背景：无",
    "",
    `单材料提取结果：\n${materialsJson}`,
    "",
    `知识库支持：\n${legalSupportsJson}`,
  ].join("\n");
}

export function buildLaborReviewPrompt(result: {
  title: string;
  markdown: string;
  aggregate: {
    caseTitle: string;
    disputeStage: string;
    summary: string;
    coreJudgment: string[];
    issues: Array<{ issue: string; analysis: string; riskLevel?: string | undefined }>;
    claimBasis: Array<{ claim: string; basis: string; evidence: string[]; risk?: string | undefined; reviewNote?: string | undefined }>;
    legalSupports: Array<{ issue: string; rule: string; relation: string }>;
    evidenceRows: Array<{ name: string; type?: string | undefined; proves: string; support?: string | undefined; strength?: string | undefined; risk?: string | undefined; remarks?: string | undefined }>;
  };
  extractedMaterials: Array<{ materialType: string; summary: string }>;
}, authorityContext?: LaborReviewPromptAuthorityContext): string {
  const domain = result.aggregate;
  const findings: string[] = [];
  const authorityCoverage: Array<{ issue: string; status: "sufficient" | "partial" | "missing" | "skipped"; sourceType: string }> = [];
  const unsupportedClaims: string[] = [];

  for (const item of domain.claimBasis) {
    if (!item.basis || item.basis.includes("需人工补核")) {
      unsupportedClaims.push(item.claim);
    }
  }

  for (const support of domain.legalSupports) {
    if (!support.rule || support.rule.includes("需人工补核")) {
      authorityCoverage.push({ issue: support.issue, status: "missing", sourceType: "local_kb" });
    } else if (support.rule.includes("《") && support.rule.includes("条")) {
      authorityCoverage.push({ issue: support.issue, status: "sufficient", sourceType: "local_kb" });
    } else {
      authorityCoverage.push({ issue: support.issue, status: "partial", sourceType: "local_kb" });
    }
  }

  for (const issue of domain.issues) {
    const hasLegalSupport = domain.legalSupports.some((s) => s.issue === issue.issue && !s.rule.includes("需人工补核"));
    if (!hasLegalSupport && issue.riskLevel === "high") {
      findings.push(`高风险争议焦点"${issue.issue}"缺少法律支撑依据`);
    }
  }

  const authorityBlock = buildAuthorityContextBlock(authorityContext);

  return [
    "你是劳动争议案件二审审查助手。",
    "你的职责是审查分析报告中的法律结论是否可支撑，法规引用是否合规，风险判断是否完整。",
    "你只审查，不重写正文。",
    "",
    "输出字段：",
    "- status: pass | needs_revision | needs_human_review",
    "- findings: 数组，元素字段为 severity（low/medium/high）、type、message、relatedSection、source（对象，字段为 type 和 ref）",
    "- unsupportedClaims: 字符串数组，列出缺少依据的请求项",
    "- authorityCoverage: 数组，元素字段为 issue、status（sufficient/partial/missing/skipped）、source（对象，字段为 type 和 ref）",
    "- suggestedEdits: 字符串数组，列出修改建议",
    "- warnings: 数组，元素字段为 code、message",
    "",
    "审查规则：",
    "1. source.type === null 必须触发 needs_human_review。",
    "2. 硬依据：authority、local_kb:article。软参考：local_kb:digest、local_kb:reflow、local_kb:practice、material。",
    "3. 仅有软参考、无硬依据时为 needs_revision。",
    "4. 至少 1 个硬依据，且风险点完整时为 pass。",
    "5. 用户跳过权威检索时，material 和 local_kb:* 都视为合法依据，但仍属软参考。",
    "6. 白名单外法条、缺少最小来源字段的引用必须进入人工复核。",
    "7. 法规引用最小字段：法规标题 + 条款号 + 来源类型。",
    "8. 案例引用最小字段：案号 + 法院 + 裁判日期 + 来源类型。",
    "9. source.type 使用 local_kb:article、local_kb:digest、local_kb:reflow、local_kb:practice 子类型。",
    "",
    authorityBlock,
    "",
    `案件标题：${domain.caseTitle}`,
    `当前阶段：${domain.disputeStage}`,
    "",
    "## 分析报告正文",
    result.markdown,
    "",
    "## 请求权基础",
    ...domain.claimBasis.map((item) => `- ${item.claim}：依据 ${item.basis}，证据 ${item.evidence.join("、")}，风险 ${item.risk ?? "无"}`),
    "",
    "## 法律支撑覆盖",
    ...domain.legalSupports.map((item) => `- ${item.issue}：${item.rule}（${item.relation}）`),
    "",
    "## 材料摘要",
    ...result.extractedMaterials.map((item) => `- ${item.materialType}：${item.summary}`),
    "",
    "## 二审结论",
    JSON.stringify({ findings, authorityCoverage, unsupportedClaims }),
  ].join("\n");
}

type LaborReviewPromptAuthorityContext = {
  status: "pending" | "skipped" | "completed";
  searchResult?: { query: string; items: Array<{ title: string; excerpt: string }> } | undefined;
  lawRecognition?: { status: string; items: Array<{ text: string; original: string; fulltext?: string | undefined; source?: string | undefined }> } | undefined;
  citationValidation?: { status: string; items: Array<{ title: string; articleNumber: string; originalText: string; url?: string | undefined; issueDate?: string | undefined; implementDate?: string | undefined }> } | undefined;
  caseNumberRecognition?: { status: string; items: Array<{ text: string; caseFlag?: string | undefined; court?: string | undefined; title?: string | undefined; lastInstanceDate?: string | undefined; url?: string | undefined }> } | undefined;
};

/** 根据权威检索状态构建二审提示上下文。 */
function buildAuthorityContextBlock(authorityContext?: LaborReviewPromptAuthorityContext): string {
  if (!authorityContext || authorityContext.status === "pending") {
    return [
      "## 权威检索状态",
      "权威法规检索尚未执行。依据标准放宽为 material + local_kb；缺少 authority 来源不应直接判定 needs_revision，",
      "但仍应在 authorityCoverage 中标记 status 为 missing 并在 warnings 中提示。",
    ].join("\n");
  }
  if (authorityContext.status === "skipped") {
    return [
      "## 权威检索状态",
      "权威法规检索未执行或被产品流程跳过。material 和 local_kb 均视为合法依据来源。",
      "在 authorityCoverage 中，缺少 authority 来源的争议点应标记 status 为 skipped 而非 missing。",
    ].join("\n");
  }
  const items = authorityContext.searchResult?.items ?? [];
  const searchQuery = authorityContext.searchResult?.query ?? "未知";
  const lawItems = authorityContext.lawRecognition?.items ?? [];
  const citationItems = authorityContext.citationValidation?.items ?? [];
  const caseItems = authorityContext.caseNumberRecognition?.items ?? [];
  return [
    "## 权威检索状态",
    `北大法宝后台源已执行：语义法规检索 ${items.length} 条，法条识别 ${lawItems.length} 条，法条校验 ${citationItems.length} 条，案号溯源 ${caseItems.length} 条。`,
    "请交叉验证分析报告中的法律结论、法条原文、案号来源和案例引用是否与后台源一致。",
    "",
    "### 语义法规检索",
    `检索词：${searchQuery}`,
    ...items.slice(0, 5).map((item, index) => `${index + 1}. ${item.title}：${item.excerpt}`),
    items.length === 0 ? "未检索到权威法规。" : "",
    "",
    "### 法条识别与溯源",
    ...lawItems.slice(0, 8).map((item, index) => [
      `${index + 1}. 原文命中：${item.text}`,
      `   标准名称：${item.original}`,
      item.fulltext ? `   法条原文：${item.fulltext}` : "",
      item.source ? `   来源：${item.source}` : "",
    ].filter(Boolean).join("\n")),
    lawItems.length === 0 ? "未识别到法规名称或条款。" : "",
    "",
    "### 修正生成幻觉-法条",
    ...citationItems.slice(0, 8).map((item, index) => [
      `${index + 1}. ${item.title} 第 ${item.articleNumber} 条`,
      `   权威原文：${item.originalText}`,
      item.implementDate ? `   实施日期：${item.implementDate}` : "",
      item.url ? `   来源：${item.url}` : "",
    ].filter(Boolean).join("\n")),
    citationItems.length === 0 ? "未返回可校验法条。" : "",
    "",
    "### 案号识别与溯源",
    ...caseItems.slice(0, 8).map((item, index) => [
      `${index + 1}. ${item.caseFlag || item.text}`,
      item.court ? `   法院：${item.court}` : "",
      item.title ? `   案件：${item.title}` : "",
      item.lastInstanceDate ? `   裁判日期：${item.lastInstanceDate}` : "",
      item.url ? `   来源：${item.url}` : "",
    ].filter(Boolean).join("\n")),
    caseItems.length === 0 ? "未识别到可溯源案号。" : "",
  ].filter(Boolean).join("\n");
}
