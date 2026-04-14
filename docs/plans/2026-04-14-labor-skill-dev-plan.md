# 劳动 Skill 开发计划

## 目标

首版只交付“证据链分析 -> 飞书文档输出”。

不把合同审查作为独立主功能，不在首版自动生成文书草稿。

固定用户链路：

```text
/labor-start 案件标题
  -> 连续上传劳动争议案件材料
  -> 可补充案件背景文字说明
  -> /labor-end
  -> 解析材料
  -> 单材料提取
  -> 案件聚合
  -> 知识库补强
  -> 生成 Markdown
  -> 写入飞书文档
```

如果飞书文档写入不可用，fallback 为在消息卡片里直接返回 Markdown。

## 第 0 步：lark-cli 发布链路验证

开发第一步先验证 `lark-cli`，不要等分析链路写完后才发现文档发布路径不可用。

验收动作：

```text
检查 lark-cli 是否安装
  -> 检查 lark-cli 登录态
  -> 创建一份最小飞书文档
  -> 确认返回文档链接
```

如果这一步失败：

- 不阻塞证据链分析本体开发
- 首版默认开启 Markdown fallback
- 文档发布阶段只在 `lark-cli` 可用时执行
- 对用户说明“飞书文档发布不可用，已返回可复制到文档的 Markdown”

## 架构与分层

首版按 runtime module 方式实现，不把劳动 skill 逻辑塞回 `BridgeApp` core。

建议新增目录：

- `src/labor/runtime-module.ts`
- `src/labor/index.ts`
- `src/labor/prompts.ts`
- `src/labor/renderer.ts`
- `src/labor/types.ts`

模块职责固定如下：

- `labor runtime module` 负责命令处理、收集模式、上传确认、进度卡片、结束触发。
- `labor service` 负责文件解析、单材料提取、案件聚合、知识库补强、Markdown 渲染。
- `OpenCode turn executor` 继续负责最终调用 `lark-cli`、权限流、过程卡和最终回复。

不要在 bridge core 里直接写飞书文档 API。

## Module Handoff

`labor` module 不直接调用 `lark-cli`。

`/labor-end` 后，模块先完成材料分析和 Markdown 渲染，再投递一个标准 OpenCode turn。

这个 turn 的文本只包含：

- 文档标题
- 已生成的最终 Markdown
- 使用 `lark-cli docs +create` 的发布要求
- `lark-cli` 失败时返回 Markdown fallback 的要求

这样可以复用已有的 queue、session、权限按钮、过程卡和最终回复逻辑。

实现时需要给 module deps 增加一个安全的 handoff 方法，例如：

```ts
enqueueGeneratedTurn(input: {
  chatId: string;
  chatType: string;
  conversationKey: string;
  threadKey: string;
  senderOpenId: string;
  inboundMessageId: string;
  plainText: string;
  text: string;
}): Promise<void>
```

模块不得直接操作 queue 内部结构。

## 内部类型

首版内部类型固定如下，后续实现不要临时发明第二套字段名。

```ts
type LaborMaterialInput = {
  sourceFile: string;
  messageId: string;
  fileKey: string;
  size?: number;
};

type LaborCaseContext = {
  caseTitle?: string;
  notes: string[];
};

type LaborMaterialExtraction = {
  sourceFile: string;
  materialType: "contract" | "payroll" | "attendance" | "chat" | "notice" | "resignation" | "arbitration" | "other";
  summary: string;
  facts: Array<{ fact: string; sourceLocation: string; confidence: "high" | "medium" | "low" }>;
  timelineEvents: Array<{ date: string; event: string; sourceLocation: string; confidence: "high" | "medium" | "low" }>;
  evidenceRows: LaborEvidenceRow[];
  contractRisks: Array<{ clauseOrContent: string; risk: string; possibleConsequence: string; suggestion: string }>;
  riskPoints: string[];
  missingEvidenceHints: string[];
};

type LaborEvidenceRow = {
  evidenceName: string;
  evidenceType: string;
  proves: string;
  supportDirection: "supports_worker" | "supports_employer" | "neutral" | "unclear";
  probativeStrength: "strong" | "medium" | "weak";
  riskOrGap: string;
  note: string;
};

type LaborAnalysisReport = {
  caseTitle: string;
  disputeStage: "咨询中" | "仲裁前" | "仲裁中" | "诉讼中" | "未知";
  summary: { materialCount: number; currentConclusion: string; riskLevel: "high" | "medium" | "low" | "unknown"; recommendedAction: string };
  coreJudgment: string[];
  evidenceRows: LaborEvidenceRow[];
  timeline: Array<{ date: string; event: string; evidence: string; confidence: "high" | "medium" | "low" }>;
  issues: Array<{ issue: string; proofBurden: string; supportingEvidence: string[]; weakness: string; riskLevel: "high" | "medium" | "low"; knowledgeQuery: string }>;
  riskItems: Array<{ item: string; reason: string; possibleConsequence: string; suggestion: string }>;
  missingEvidence: Array<{ evidence: string; whyNeeded: string; priority: "high" | "medium" | "low" }>;
  nextActions: string[];
};
```

## 配置

新增 `laborSkill` 配置块。

默认值固定为：

```json
{
  "laborSkill": {
    "enabled": false,
    "models": {
      "extract": "",
      "analyze": "",
      "render": ""
    },
    "ingest": {
      "allowedExtensions": [".pdf", ".docx", ".txt", ".md"],
      "maxFileSizeMb": 20,
      "pendingTtlMs": 600000,
      "concurrency": 3
    }
  }
}
```

模型选择顺序固定为：

```text
laborSkill.models.<step>
  -> knowledgeBase.models.extract/default
  -> OpenCode 默认模型
```

`laborSkill.enabled=true` 时，首版要求 `knowledgeBase.enabled=true`。

如果未开启知识库，启动配置校验应提示：

```text
laborSkill.enabled=true 时必须启用 knowledgeBase.enabled。
```

不做“无知识库也能完整开启劳动 skill”的降级版本。

## 命令与交互

新增显式命令：

- `/labor-start [案件标题]`
- `/labor-end`
- `/劳动分析 [案件标题]`
- `/劳动分析结束`

进入收集模式后，bridge 接管本窗口的劳动分析输入。

每收到一个文件，立即回复确认：

```text
已收到《劳动合同.pdf》，当前共 3 份材料。
继续上传材料，或发送 /labor-end 开始分析。
```

每收到一条文字说明，立即回复确认：

```text
已记录案件背景说明，当前共 2 条说明。
说明会作为案件背景注入聚合阶段，不会作为独立证据材料。
```

`/labor-end` 后显示处理中卡片，步骤固定为：

```text
解析中
  -> 提取中
  -> 聚合中
  -> 知识库补强中
  -> 文档生成中
```

## 材料与文字说明

首版支持材料格式：

- `.pdf`
- `.docx`
- `.txt`
- `.md`

首版不处理原始图片 OCR、原始音频识别和网页抓取。

文字说明只作为案件背景信息使用。

示例：

```text
这是甲方公司，乙方是员工张某，2026 年 3 月被辞退。
```

这些内容注入案件聚合 prompt，用于帮助模型理解角色、时间和争议背景。

文字说明不进入单材料提取阶段，不生成单独证据项。

## 并发策略

并发只用于批量材料处理。

固定规则：

- 文件解析并发执行
- 单材料 AI 提取并发执行
- AI 提取并发度使用 `laborSkill.ingest.concurrency`
- 案件聚合只执行一次，串行
- 知识库补强按争议点查询，首版最多查询 3 个争议点
- 飞书文档生成只执行一次，串行

如果任一材料解析失败：

- 该材料标记为失败
- 继续处理其他材料
- 最终文档“待补材料与下一步建议”里提示该材料未能解析，需要人工补充

如果全部材料失败：

- 不进入聚合
- 给出失败卡片，列出失败材料和原因

## 服务流程

服务层执行顺序固定为：

```text
collectInputs
  -> parseMaterials
  -> extractMaterials
  -> analyzeCase
  -> enrichWithKnowledgeBase
  -> renderMarkdown
  -> enqueueDocumentPublishTurn
```

解析阶段直接复用现有 `parseKnowledgeFile`，不要重复实现 PDF / DOCX / TXT / MD 解析器。

单材料提取使用短生命周期 OpenCode session，完成后删除 session。

案件聚合使用短生命周期 OpenCode session，完成后删除 session。

文档发布使用当前用户窗口里的标准 OpenCode session，不使用短生命周期 session。

## 单材料提取 Prompt

用途：从单份材料中提取劳动争议相关事实、时间线、证据价值和风险。

输出格式：严格 JSON，不输出解释。

```text
你是劳动争议案件材料分析助手。

请从劳动争议办案视角分析以下单份材料。

你的任务不是写法律意见书，也不是起草文书，而是把材料转成后续证据链分析可用的结构化信息。

请重点识别：
1. 材料类型，例如劳动合同、工资单、考勤记录、聊天记录、解除通知、离职协议、仲裁材料、其他。
2. 关键事实，包括主体、时间、岗位、薪资、工作年限、解除原因、沟通内容等。
3. 时间线事件，只提取可以从材料中直接看出的时间节点。
4. 证据价值，即这份材料可能证明什么。
5. 对劳动者有利或不利的点。
6. 风险点和证据缺口。

如果材料属于合同、协议、offer、通知书等关键文书，请额外识别：
1. 不合规或可能无效的条款。
2. 对劳动者明显不利的约定。
3. 与解除、试用期、竞业限制、培训服务期、薪资调整相关的风险。

不要编造材料中没有的信息。
不能确定的内容写入 riskPoints 或 missingEvidenceHints。

请只输出 JSON 对象，结构如下：

{
  "sourceFile": "文件名",
  "materialType": "contract | payroll | attendance | chat | notice | resignation | arbitration | other",
  "summary": "100 字以内材料摘要",
  "facts": [
    {
      "fact": "关键事实",
      "sourceLocation": "页码、段落或原文位置；无法定位时写 unknown",
      "confidence": "high | medium | low"
    }
  ],
  "timelineEvents": [
    {
      "date": "YYYY-MM-DD 或原文日期",
      "event": "事件",
      "sourceLocation": "来源位置",
      "confidence": "high | medium | low"
    }
  ],
  "evidenceRows": [
    {
      "evidenceName": "证据名称",
      "evidenceType": "书证 | 电子数据 | 视听资料 | 证人证言 | 其他",
      "proves": "证明事实",
      "supportDirection": "supports_worker | supports_employer | neutral | unclear",
      "probativeStrength": "strong | medium | weak",
      "riskOrGap": "风险或缺口",
      "note": "备注"
    }
  ],
  "contractRisks": [
    {
      "clauseOrContent": "条款或内容",
      "risk": "风险点",
      "possibleConsequence": "可能后果",
      "suggestion": "建议处理"
    }
  ],
  "riskPoints": ["风险点"],
  "missingEvidenceHints": ["缺失证据提示"]
}

源文件：{{sourceFile}}
材料正文：
{{materialMarkdown}}
```

## 案件聚合 Prompt

用途：把多份材料和用户背景说明归并成统一案件认知。

输出格式：严格 JSON，不输出解释。

```text
你是劳动争议案件证据链分析助手。

请基于多份材料的单材料提取结果，以及用户补充的案件背景说明，整理一个统一的案件认知。

你的目标是帮助律师快速判断：
1. 当前争议焦点是什么。
2. 哪些关键事实已有证据支持。
3. 哪些请求或抗辩方向证据较强。
4. 哪些事实链条存在缺口。
5. 当前还需要补什么材料。

请特别注意：
1. 合同、offer、离职协议、解除通知等关键文书要作为高价值材料处理。
2. 如果存在合同类材料，请把不合规条款、对劳动者不利约定、解除或试用期风险归并到 issues 和 riskItems。
3. 文字说明只能作为背景理解，不能替代证据。
4. 不要把未在材料中出现的事实当作已证实事实。
5. 对争议焦点给出举证责任和证据缺口判断。

请只输出 JSON 对象，结构如下：

{
  "caseTitle": "案件标题",
  "disputeStage": "咨询中 | 仲裁前 | 仲裁中 | 诉讼中 | 未知",
  "summary": {
    "materialCount": 0,
    "currentConclusion": "当前总体判断",
    "riskLevel": "high | medium | low | unknown",
    "recommendedAction": "当前建议动作"
  },
  "coreJudgment": [
    "核心判断 1",
    "核心判断 2"
  ],
  "evidenceRows": [
    {
      "evidenceName": "证据名称",
      "evidenceType": "证据类型",
      "proves": "证明事实",
      "supportDirection": "支持方向",
      "probativeStrength": "证明力",
      "riskOrGap": "风险/缺口",
      "note": "备注"
    }
  ],
  "timeline": [
    {
      "date": "日期",
      "event": "事件",
      "evidence": "对应证据",
      "confidence": "high | medium | low"
    }
  ],
  "issues": [
    {
      "issue": "争议焦点",
      "proofBurden": "举证责任或证明要求",
      "supportingEvidence": ["已有支持证据"],
      "weakness": "薄弱点",
      "riskLevel": "high | medium | low",
      "knowledgeQuery": "用于查询劳动法知识库的问题"
    }
  ],
  "riskItems": [
    {
      "item": "风险事项",
      "reason": "风险原因",
      "possibleConsequence": "可能后果",
      "suggestion": "处理建议"
    }
  ],
  "missingEvidence": [
    {
      "evidence": "建议补充材料",
      "whyNeeded": "为什么需要",
      "priority": "high | medium | low"
    }
  ],
  "nextActions": ["下一步动作"]
}

案件标题：{{caseTitle}}

用户背景说明：
{{caseContext}}

单材料提取结果：
{{materialExtractionsJson}}
```

## 知识库补强

案件聚合完成后，从 `issues[].knowledgeQuery` 中选最多 3 个问题查询劳动法知识库。

每个问题最多保留 2 条结果。

补强内容只用于“法律依据与知识库支撑”章节，不回写成已证实事实。

知识库无命中时，保留章节并写明：

```text
当前未检索到明确依据，需人工补核。
```

## Markdown 渲染

最终 Markdown 固定章节：

```text
### 案件摘要
### 核心判断
### 证据链总表
### 关键事实时间线
### 争议焦点与风险
### 法律依据与知识库支撑
### 待补材料与下一步建议
```

首版不输出“文书草稿”章节。

时间线使用 Markdown 表格，不自动插入飞书画板。

## 飞书文档发布

文档发布阶段使用标准 OpenCode turn 执行。

turn prompt 固定要求：

```text
请使用 lark-cli 创建飞书云文档。

标题：{{docTitle}}

正文 Markdown 如下。

要求：
1. 不要重新分析案件材料。
2. 不要改写 Markdown 结构。
3. 使用 lark-cli docs +create 创建文档。
4. 成功后只返回文档链接和一句简短说明。
5. 如果 lark-cli 不可用或创建失败，请返回失败原因，并原样返回下面的 Markdown，方便用户手动复制到飞书文档。

{{finalMarkdown}}
```

如果未来需要支持更新已有文档，再增加 `docToken` 参数，首版不做。

## 失败与边界

首版明确不支持：

- 原始图片 OCR
- 原始音频识别
- 网页证据抓取
- 自动插入飞书画板
- 自动生成仲裁申请书、答辩状等文书草稿
- 更新已有飞书文档
- 劳动分析历史归档

重启后如果仍有劳动分析收集态，按中断处理，给用户提示需要重新发送 `/labor-start`。

收集态超时后自动结束，不进入分析。

如果 `lark-cli` 发布失败，不重试创建飞书文档，直接返回 Markdown fallback。

## 测试计划

### 单元测试

- 路由 `/labor-start`、`/labor-end` 和中文别名。
- 收集模式下文件确认文案包含当前材料数量。
- 文字说明确认文案说明其作为案件背景使用。
- `laborSkill.enabled=true` 且 `knowledgeBase.enabled=false` 时配置校验失败。
- `labor` module 通过 handoff 投递标准 OpenCode turn，不直接调用 `lark-cli`。
- 单材料 prompt 包含劳动争议视角、证据价值、时间线、合同专项要求。
- 聚合 prompt 包含争议焦点、举证责任、证据缺口、合同材料特殊处理。
- 并发参数只作用于解析和单材料 AI 提取。

### 集成测试

- `/labor-start` -> 上传 2 份材料 -> 补充 1 条文字说明 -> `/labor-end`。
- 处理中卡片按步骤更新。
- 知识库无命中时仍生成 Markdown。
- `lark-cli` 发布成功时最终回复包含文档链接。
- `lark-cli` 发布失败时最终回复包含 Markdown fallback。

### 人工验收

- 先运行最小飞书文档创建测试。
- 用一组劳动合同、工资单、解除通知、聊天记录文本跑完整链路。
- 检查飞书文档是否包含摘要、证据链总表、时间线、争议焦点、知识库依据和待补材料。
- 请律师重点审核两个 prompt 和最终文档中争议焦点、举证责任、证据缺口的表达。

## 实施顺序

建议按以下顺序开发：

1. 先做 `lark-cli` 最小文档创建验证，确认是否默认走文档发布或 Markdown fallback。
2. 增加配置 schema、loader 和路由命令。
3. 增加 `labor` runtime module 的收集态、确认回复和超时清理。
4. 增加服务层类型、prompt builder 和 renderer。
5. 接入文件解析、单材料提取、案件聚合和知识库补强。
6. 增加 module handoff，投递标准 OpenCode turn 执行文档发布。
7. 补齐单元测试、集成测试和人工验收脚本。
