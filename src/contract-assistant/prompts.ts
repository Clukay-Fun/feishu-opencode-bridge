/**
 * 职责: 组装合同助手模块使用的各类提示词模板。
 * 关注点:
 * - 覆盖合同起草、合同提取、案件创建与更新等场景。
 * - 将业务上下文整理成稳定、可复用的模型输入。
 */
export function buildContractDraftPrompt(
  request: string,
  templateName: string,
  templateMainText: string,
  templateRiskNoticeText: string | undefined,
  fieldGuideText: string | undefined,
): string {
  return [
    "你是律所合同起草助手，负责基于指定模板生成一份可编辑的合同草稿。",
    "请基于用户输入产出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- docTitle: 文档标题",
    "- feeMode: 收费模式，取值 stage_fixed 或 base_plus_risk",
    "- markdown: 合同 Markdown 正文，不要包含与标题重复的一级标题",
    "- templateData: 用于 Word 模板填充的结构化字段",
    "- record: 合同台账字段，尽量补全",
    "",
    "templateData 可包含这些字段：",
    "client_name、client_representative、client_id_code、client_address、client_email、client_phone、counterparty_name、case_cause、lead_lawyer、sign_date、fee_mode、engage_arbitration、engage_first_instance、engage_second_instance、engage_enforcement、engage_settlement、fee_arbitration_clause、fee_first_instance_clause、fee_second_instance_clause、fee_enforcement_clause、base_fee_clause、risk_fee_clause、risk_fee_followup_clause_1、risk_fee_followup_clause_2、dispute_resolution_clause、special_terms",
    "",
    "record 可包含这些字段：",
    "项目名称、律所合同号、客户名称、合同类型、具体类型/案由、签约日期、合同金额、付款节点、联系人、联系方式、客户收件地址、信用代码/身份证、备注",
    "",
    "规则：",
    "1. 必须以模板结构为基础起草，不要自由发明完全不同的章节结构。",
    "2. 对用户未提供的关键字段，用“【待补】”占位，不要编造。",
    "3. 如果判断收费模式为 stage_fixed，则不要输出《风险代理告知书》，并删除风险收费整块。",
    "4. 如果判断收费模式为 base_plus_risk，则保留《风险代理告知书》部分，并删除按阶段收费整块。",
    "5. 第一条委托事项里，未勾选的程序直接删除，不保留空框。",
    "6. 金额字段如果用户没有提供，不要编造，不要新增其他金额占位；尽量保持模板原有金额占位风格。",
    "7. 个人与公司签字页处理不同：个人删除“法定代表人/负责人/授权代表”整行，公司保留该行但默认不填写内容。",
    "8. `签约时间：二〇二 年  月  日` 与 `委托人（签署）` 相关位置默认不要自动填写，也不要改原格式。",
    "9. 付款安排统一整理到 `付款节点` 文本字段，不要拆成分期数组。",
    "10. 金额字段输出数字；日期优先输出 YYYY-MM-DD。",
    "11. 输出的 Markdown 适合直接创建飞书文档，标题层级清晰，条款使用有序段落或小标题表达。",
    "12. templateData 里的 clause 字段请直接输出可落进模板的完整句子，不要只给数字。",
    "13. templateData 中的布尔字段请输出 true/false。",
    "",
    `模板名称：${templateName}`,
    "",
    "主合同模板：",
    "---模板开始---",
    templateMainText,
    "---模板结束---",
    "",
    templateRiskNoticeText
      ? [
        "风险告知书模板：",
        "---风险附件开始---",
        templateRiskNoticeText,
        "---风险附件结束---",
        "",
      ].join("\n")
      : "风险告知书模板：无\n",
    fieldGuideText
      ? [
        "字段说明：",
        "---字段说明开始---",
        fieldGuideText,
        "---字段说明结束---",
        "",
      ].join("\n")
      : "字段说明：无\n",
    `用户需求：${request}`,
  ].join("\n");
}

export function buildContractExtractPrompt(fileName: string, content: string): string {
  return [
    "你是合同信息提取助手。",
    "请先判断以下文件是否为合同、协议、委托代理合同、法律服务合同或合同模板，再提取合同台账记录，并输出 JSON 对象，不要输出额外说明。",
    "",
    "输出字段：",
    "- isContract: boolean，只有确认为合同类文件时才为 true",
    "- documentType: 文件类型，例如 委托代理合同、服务合同、发票、判决书、普通文件",
    "- rejectReason: 如果 isContract 为 false，用一句话说明为什么不能录入合同台账",
    "- summary: 100 字以内摘要",
    "- record: 合同台账字段",
    "",
    "record 可包含这些字段：",
    "项目名称、律所合同号、客户名称、合同类型、具体类型/案由、签约日期、合同金额、付款节点、联系人、联系方式、客户收件地址、信用代码/身份证、备注",
    "",
    "规则：",
    "1. 如果文件不是合同类文件，必须输出 isContract=false，record 为空对象，不要尝试凑字段。",
    "2. 不确定的字段可以省略，不要编造。",
    "3. 付款安排统一整理为 `付款节点` 长文本。",
    "4. 合同金额输出数字，不带货币符号。",
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
    "合同号、购买方、发票号、开票日期、发票金额、备注",
    "",
    "matchHints 可包含这些字段：",
    "contractNo、clientName、payer、amount",
    "",
    "规则：",
    "1. 优先从发票正文提取结构化信息。",
    "2. 如果是图片或 PDF，你可以读取本地路径对应文件进行分析；不要依赖本地文本层抽取结果。",
    "3. 发票金额输出数字，日期优先 YYYY-MM-DD。",
    "4. 购买方必须填写发票购买方/客户/委托人；北京市隆安（深圳）律师事务所通常是销售方/服务方，不要填成购买方。",
    "5. matchHints.clientName 和 matchHints.payer 也必须指向购买方/客户，不要填律所名称。",
    "",
    `文件名：${fileName}`,
    `本地路径：${localPath}`,
    extractedText
      ? `补充可提取文本：\n---\n${extractedText}\n---`
      : "补充可提取文本：无",
  ].join("\n");
}

export function buildContractAssistantIntentPrompt(input: {
  userText: string;
  fileName?: string | undefined;
  localPath?: string | undefined;
  hasRecentFile: boolean;
}): string {
  return [
    "你是合同助手的 skill 意图路由器。",
    "请根据用户当前文字、最近材料上下文和 skill 描述，判断是否应由合同助手执行某个 skill。",
    "只输出 JSON 对象，不要输出额外说明。",
    "",
    "可选 skill：",
    "- invoice-recognize：用户提供发票图片、照片或 PDF，需要识别发票字段、写入发票记录或录入发票台账。",
    "- contract-extract：用户提供合同、协议、委托代理合同或法律服务合同文件，需要提取合同字段、写入合同台账或录入合同。",
    "- case-manage：用户用文字提供案件基本信息，需要新增案件管理记录或录入案件台账。",
    "- contract-draft：用户用文字描述合同需求，需要起草合同或生成合同草稿。",
    "- none：不属于以上合同助手能力，或意图不清楚。",
    "",
    "输出字段：",
    "- skill: invoice-recognize | contract-extract | case-manage | contract-draft | none",
    "- confidence: 0 到 1 的数字",
    "- needsFile: boolean，执行该 skill 是否需要材料文件",
    "- reason: 30 字以内原因",
    "",
    "规则：",
    "1. 不要按固定话术或关键词机械匹配，要结合 skill 描述理解意图。",
    "2. slash command 已由系统强制处理；这里只判断自然语言。",
    "3. 发票识别和合同录入通常需要最近上传文件或本地路径。",
    "4. 案件录入和合同起草可以仅根据文字执行。",
    "5. 如果用户只是闲聊、询问说明、要求知识库入库或劳动争议材料生成，输出 none。",
    "6. 如果缺少执行所需文件但意图明确，仍输出对应 skill，并把 needsFile 设为 true。",
    "",
    `最近文件：${input.hasRecentFile ? input.fileName ?? "有" : "无"}`,
    `本地路径：${input.localPath ?? "无"}`,
    `用户文字：${input.userText}`,
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
    "类型、案由、委托人、对方当事人、联系人、联系方式、案号、审理法院、程序阶段、案件状态、重要紧急程度、日期、开庭日、开庭地点、举证截止日、反诉截止日、管辖权异议截止日、上诉截止日、主办律师、协办律师、待做事项、进展、备注",
    "",
    "规则：",
    "1. 程序阶段如果有多个，输出字符串数组。",
    "2. 日期优先 YYYY-MM-DD，日期时间优先 YYYY-MM-DD HH:mm:ss。",
    "3. 用户说“承办律师”或“代理律师”时，写入主办律师，不要写到备注。",
    "4. 主办律师、协办律师使用字符串数组；只有 1 人时也输出数组。",
    "5. 不确定字段可以省略。",
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
    "fields 可包含：程序阶段、案件状态、开庭日、开庭地点、举证截止日、反诉截止日、管辖权异议截止日、上诉截止日、主办律师、协办律师、待做事项、进展、备注",
    "",
    "规则：",
    "1. 尽量抽出明确的定位键。",
    "2. 日期时间优先 YYYY-MM-DD HH:mm:ss。",
    "3. 程序阶段如果有多个，输出数组。",
    "4. 用户说“承办律师”或“代理律师”时，写入主办律师，不要写到备注。",
    "5. 主办律师、协办律师使用字符串数组；只有 1 人时也输出数组。",
    "",
    `用户输入：${request}`,
  ].join("\n");
}

export function buildContractWorkbenchInitFromPromptPrompt(request: string): string {
  return [
    "你是合同工作台初始化助手。",
    "请根据用户描述生成一份首版合同结构，并只输出 JSON 对象，不要输出额外说明。",
    "",
    "输出格式：",
    "{",
    '  "state": {',
    '    "title": "合同标题",',
    '    "sourceMode": "freeform_prompt",',
    '    "parties": {',
    '      "clientName": "甲方",',
    '      "counterpartyName": "对方",',
    '      "agencyName": "乙方/机构",',
    '      "leadLawyer": "承办律师",',
    '      "signDate": "YYYY-MM-DD 或 【待补】"',
    "    },",
    '    "clauses": [',
    '      { "number": "第一条", "title": "委托事项", "content": "..." }',
    "    ],",
    '    "appendices": [',
    '      { "title": "附件标题", "content": "..." }',
    "    ]",
    "  },",
    '  "message": "初始化摘要"',
    "}",
    "",
    "规则：",
    "1. 必须生成完整、可编辑的合同结构，至少包含标题、当事人信息、条款数组。",
    "2. 未提供但合同中必须出现的信息，用“【待补】”占位，不要编造。",
    "3. clauses 中每条都要保留 number、title、content。",
    "4. 条款内容应当是完整自然语言，而不是关键词。",
    "5. appendices 可为空数组。",
    "6. 不要输出 markdown，不要输出解释。",
    "",
    `用户需求：${request}`,
  ].join("\n");
}

export function buildContractWorkbenchInitFromDocumentPrompt(fileName: string, content: string): string {
  return [
    "你是合同工作台初始化助手。",
    "请根据上传的合同或模板文本，整理出一份结构化合同状态 JSON，不要输出额外说明。",
    "",
    "输出格式：",
    "{",
    '  "state": {',
    '    "title": "合同标题",',
    '    "sourceMode": "template_upload 或 existing_contract_upload",',
    '    "parties": {',
    '      "clientName": "甲方",',
    '      "counterpartyName": "对方",',
    '      "agencyName": "乙方/机构",',
    '      "leadLawyer": "承办律师",',
    '      "signDate": "YYYY-MM-DD 或 【待补】"',
    "    },",
    '    "clauses": [',
    '      { "number": "第一条", "title": "委托事项", "content": "..." }',
    "    ],",
    '    "appendices": [',
    '      { "title": "附件标题", "content": "..." }',
    "    ]",
    "  },",
    '  "message": "初始化摘要"',
    "}",
    "",
    "规则：",
    "1. 如果文本更像带占位/空白的模板，sourceMode 设为 template_upload。",
    "2. 如果文本更像已有合同成稿或接近成稿，sourceMode 设为 existing_contract_upload。",
    "3. 必须尽量保留原文条款结构，不要擅自重写整体逻辑。",
    "4. 未识别出的必须字段可填“【待补】”。",
    "5. clauses 中每条都要保留 number、title、content。",
    "6. 如果存在附件或告知书，请放进 appendices。",
    "",
    `文件名：${fileName}`,
    "---合同内容开始---",
    content,
    "---合同内容结束---",
  ].join("\n");
}

export function buildContractWorkbenchApplyPrompt(
  contractStateJson: string,
  recentMessages: string[],
  userMessage: string,
): string {
  return [
    "你是合同工作台编辑助手。",
    "当前处于一个专属合同工作会话中。请基于当前合同结构理解用户指令，并只输出 JSON，不要输出额外说明。",
    "",
    "输出格式：",
    "{",
    '  "action": "view | update | export | reject",',
    '  "message": "给用户的简短说明",',
    '  "viewPayload": { "title": "查看标题", "content": "查看内容" },',
    '  "updatedState": { ...完整 ContractState... },',
    '  "exportHint": { "suggestedFileName": "建议文件名" }',
    "}",
    "",
    "规则：",
    "1. 如果用户是在查看条款、查看概览或让你展示某一段，返回 action=view，不要修改状态。",
    "2. 如果用户要求修改、删除、新增、重写条款或更新字段，返回 action=update，并返回完整 updatedState。",
    "3. 如果用户要求导出 Word、重新生成 Word、导出当前草稿，返回 action=export。",
    "4. 如果用户输入与合同编辑无关，返回 action=reject。",
    "5. 除了用户明确要求修改的部分，其余内容必须保留，不能丢条款。",
    "6. updatedState 必须是完整合同结构，不要只返回局部 patch。",
    "7. 如果用户只说“把这一条删掉”“改刚才那条”，请结合最近上下文和当前结构理解。",
    "8. 不要用硬编码规则解释用户意图，直接根据语义理解并返回结果。",
    "",
    "当前合同结构 JSON：",
    contractStateJson,
    "",
    recentMessages.length > 0
      ? [
        "最近上下文：",
        ...recentMessages.map((item, index) => `${index + 1}. ${item}`),
        "",
      ].join("\n")
      : "最近上下文：无\n",
    `用户指令：${userMessage}`,
  ].join("\n");
}
