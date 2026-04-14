export function buildContractDraftPrompt(request: string): string {
  return [
    "你是律所业务助手，负责根据用户需求起草一份可编辑的合同草稿。",
    "请基于用户输入产出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- docTitle: 文档标题",
    "- markdown: 合同 Markdown 正文，不要包含与标题重复的一级标题",
    "- record: 合同台账字段，尽量补全",
    "",
    "record 可包含这些字段：",
    "项目名称、律所合同号、客户名称、合同类型、具体类型/案由、签约日期、合同金额、付款节点、联系人、联系方式、客户收件地址、信用代码/身份证、备注",
    "",
    "规则：",
    "1. 合同正文要完整，至少包含当事人、服务范围/标的、费用、付款节点、违约责任、争议解决。",
    "2. 如果用户没有给全参数，可以在正文中用“【待补】”占位。",
    "3. 付款安排统一整理到 `付款节点` 文本字段，不要拆成分期数组。",
    "4. 金额字段输出数字；日期优先输出 YYYY-MM-DD。",
    "",
    `用户需求：${request}`,
  ].join("\n");
}

export function buildContractExtractPrompt(fileName: string, content: string): string {
  return [
    "你是合同信息提取助手。",
    "请从以下合同文本中提取合同台账记录，并输出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- summary: 100 字以内摘要",
    "- record: 合同台账字段",
    "",
    "record 可包含这些字段：",
    "项目名称、律所合同号、客户名称、合同类型、具体类型/案由、签约日期、合同金额、付款节点、联系人、联系方式、客户收件地址、信用代码/身份证、备注",
    "",
    "规则：",
    "1. 不确定的字段可以省略，不要编造。",
    "2. 付款安排统一整理为 `付款节点` 长文本。",
    "3. 合同金额输出数字，不带货币符号。",
    "",
    `文件名：${fileName}`,
    "---合同文本开始---",
    content,
    "---合同文本结束---",
  ].join("\n");
}

export function buildInvoiceRecognizePrompt(fileName: string, localPath: string, extractedText?: string): string {
  return [
    "你是发票识别助手。",
    "请根据可见文件内容识别发票信息，并输出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- summary: 100 字以内摘要",
    "- record: 发票记录字段",
    "- matchHints: 合同匹配线索",
    "",
    "record 可包含这些字段：",
    "合同号、付款方、发票号、开票日期、发票金额、备注",
    "",
    "matchHints 可包含这些字段：",
    "contractNo、clientName、payer、amount",
    "",
    "规则：",
    "1. 优先从发票正文提取结构化信息。",
    "2. 如果是图片或 PDF，你可以读取本地路径对应文件进行分析。",
    "3. 发票金额输出数字，日期优先 YYYY-MM-DD。",
    "",
    `文件名：${fileName}`,
    `本地路径：${localPath}`,
    extractedText
      ? `补充可提取文本：\n---\n${extractedText}\n---`
      : "补充可提取文本：无",
  ].join("\n");
}

export function buildCaseCreatePrompt(request: string): string {
  return [
    "你是案件管理助手。",
    "请根据用户输入提取案件管理表记录，并输出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- summary: 100 字以内摘要",
    "- record: 案件管理字段",
    "",
    "record 可包含这些字段：",
    "类型、案由、委托人、对方当事人、联系人、联系方式、案号、审理法院、程序阶段、案件状态、重要紧急程度、日期、开庭日、开庭地点、举证截止日、反诉截止日、管辖权异议截止日、上诉截止日、待做事项、进展、备注",
    "",
    "规则：",
    "1. 程序阶段如果有多个，输出字符串数组。",
    "2. 日期优先 YYYY-MM-DD，日期时间优先 YYYY-MM-DD HH:mm:ss。",
    "3. 不确定字段可以省略。",
    "",
    `用户输入：${request}`,
  ].join("\n");
}

export function buildCaseUpdatePrompt(request: string): string {
  return [
    "你是案件更新助手。",
    "请根据用户输入识别要更新的案件及更新字段，并输出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- caseNo: 优先用案号定位，找不到可为空",
    "- clientName: 如有委托人名称可补充",
    "- fields: 要更新的案件字段",
    "",
    "fields 可包含：程序阶段、案件状态、开庭日、开庭地点、举证截止日、反诉截止日、管辖权异议截止日、上诉截止日、待做事项、进展、备注",
    "",
    "规则：",
    "1. 尽量抽出明确的定位键。",
    "2. 日期时间优先 YYYY-MM-DD HH:mm:ss。",
    "3. 程序阶段如果有多个，输出数组。",
    "",
    `用户输入：${request}`,
  ].join("\n");
}

