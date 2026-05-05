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
