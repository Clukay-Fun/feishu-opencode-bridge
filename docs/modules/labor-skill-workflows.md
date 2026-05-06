# Labor Skill 领域工作流分层

`labor-skill` 是劳动争议领域总入口，不是与 `/起草合同`、`/识别发票`、`/案件录入` 平级的又一个离散专项命令。

它负责把劳动案件从材料接收、事实提取、证据链整理、知识库辅助、工作底稿生成串成一条领域 workflow。专项能力和 shared skills 只作为它在合适阶段调用的能力，不反向接管领域主线。

## 分层结论

```text
Feishu Runtime
  -> labor runtime module
    -> labor-skill domain workflow
      -> domain-specific decisions
      -> specialist capabilities
      -> shared skills / workflows
```

### labor-skill

`labor-skill` 拥有劳动争议案件的主线编排。

它负责：

- 判断当前劳动案件处于材料收集、证据分析、补证、文书准备还是工作台整理阶段。
- 把用户上传的材料、补充说明和知识库命中结果组织成一个劳动案件工作流。
- 决定何时调用材料提取、知识库查询、合同起草、案件录入等下层能力。
- 生成面向律师复核的劳动案件工作底稿，而不是直接生成最终法律意见。
- 当用户基于劳动分析结果继续要求证据清单、举证目录、证明目的表或 Word 文书时，应继续沿用 labor 证据链上下文；专用 Word 导出应作为明确 workflow 接线，不应退回普通 OpenCode 文档问答。

它不负责：

- 重新实现附件下载、文档解析、图片/PDF 文本提取等通用文件能力。
- 直接接管 bridge session creation、switch、rename 或 close 语义。
- 把合同、发票、案件台账等专项能力的内部状态复制到 labor 自己的状态文件。

### 独立专项能力

专项能力面向明确、可单独触发的业务动作。

当前应保持独立的能力包括：

- `contract-draft`：从用户需求和合同模板生成合同初稿。
- `contract-extract`：从现有合同文件提取合同台账字段。
- `contract-review`：审查已有合同并输出风险、缺失条款和修改建议。
- `contract-revise`：基于已有合同或合同工作台状态修改、删改、补充和导出合同。
- `invoice-recognize`：从发票文件识别发票字段并写入发票台账。
- `case-manage`：创建或更新案件台账记录。
- `reminder-service`：围绕合同、发票、案件日期生成提醒。

这些能力可以被 `labor-skill` 调用，但不应变成 labor 内部私有实现。原因是它们也可能被非劳动场景复用，例如商事合同、常法服务、普通诉讼案件。

### shared skills / workflows

shared skills 承载跨领域、可组合、低业务判断的底层能力。

当前已落地能力：

- `evidence-extract`：附件下载、格式校验、临时文件保存、文本提取、模型结构化抽取。
- `document-pipeline`：统一文档解析入口，收口 PDF、DOCX、图片、TXT/MD、HTML 的 Markdown / plain text / section 输出。
- `timeline-build`：从事实片段归并时间线，处理日期归一、去重、证据引用。
- `workbench-generate`：把结构化分析结果渲染为可复核的工作台文档。
- `case-workflow`：串联案件工作台 Markdown、共享图表和飞书文档 / 白板输出。

后续候选能力：

- `knowledge-support`：根据争议焦点低成本查询知识库，并把命中结果作为“待复核规则线索”返回。

shared skills 只提供通用能力，不决定劳动案件策略。比如 `timeline-build` 可以合并事件，但“哪些事件对违法解除最关键”仍属于 `labor-skill`。

## 三层职责边界

### Bridge Runtime

bridge runtime 拥有通用运行时机制。

它负责入口消息路由、session window、interaction mode、queue、turn lifecycle、permission/question、process card，以及 bridge-owned commands。

它不应包含劳动案件判断，也不应知道某个劳动 workflow 的阶段细节。

### Runtime Module

`src/labor/runtime-module.ts` 是 Feishu 会话里的劳动模块入口。

它负责：

- 认领 `/劳动分析`、`/劳动分析结束` 等 labor 命令。
- 管理 labor 自己的 pending interaction、TTL 和状态恢复。
- 收集用户上传文件和补充说明。
- 记录最近上传的劳动材料上下文；当用户随后明确要求“做劳动分析 / 生成劳动争议证据链 / 整理工作台”时，可直接复用这些材料启动分析。
- 调用 `LaborSkillService`，并通过 labor card family 输出过程卡和结果卡。

它不负责：

- 直接做材料解析和模型 prompt 组装。
- 直接写合同、发票、案件台账。
- 持久化其他模块的 pending state。

自然语言入口只在劳动领域意图足够明确时触发。普通的“总结一下刚才文件”或“收入知识库”不会被 labor 接管，仍交给默认文件总结或 knowledge module。

### Skill 文件

skill 文件是 OpenCode 能力发现和业务提示词维护入口。

它适合放领域术语、触发说明、prompt 覆盖文件、字段约定、输出约束和人工复核边界。

它不适合放 bridge session 控制规则、Feishu card 发送逻辑、pending interaction TTL 或状态恢复逻辑。

## 当前真实复用点

`src/workflows/evidence-extract.ts`、`src/workflows/timeline-build.ts`、`src/workflows/workbench-generate.ts` 和 `src/workflows/case-workflow.ts` 已经是落地的 shared workflow。

当前真实复用点：

- `src/contract-assistant/index.ts` 用它做合同提取和发票识别前的附件准备与结构化抽取。
- `src/labor/index.ts` 用它做劳动材料单文件提取前的附件准备、格式校验、文本提取和模型调用。
- `src/labor/index.ts` 用 `timeline-build` 生成关键时间线图。
- `src/labor/index.ts` 用 `case-workflow` 和 `workbench-generate` 生成飞书工作台文档并更新白板图。

这说明 shared skill 的边界已经落地：通用材料处理、时间线构建和工作台输出归 `workflows/*`，劳动争议判断归 `labor-skill`，合同/发票/案件字段归 `contract-assistant` 专项能力。

后续 `document-pipeline` 收敛完成后，应优先让 `evidence-extract` 消费统一文档解析结果，而不是让 labor 或 contract 各自直接选择 PDF/DOCX/OCR 解析路径。

## 劳动案件工作台与证据台账联动

当前 labor 输出默认支持：

- 飞书文档：案件摘要、核心判断、下一步建议、证据链总表、时间线表。
- 白板图：时间线、证据关系图、请求项结构图、补证流程图。
- 多维表联动：当配置 `laborSkill.storage.evidenceLedger` 后，将证据项和缺口项同步到同一张证据台账表。

当前默认台账字段：

- `案件标题`
- `当前阶段`
- `条目类型`
- `名称`
- `证据类型`
- `证明事实`
- `支持方向`
- `证明力`
- `风险提示`
- `备注`
- `状态`

推荐视图：

- `关键证据视图`：筛选 `条目类型=证据`，按 `证明力`、`支持方向`、`风险提示` 排序。
- `缺口视图`：筛选 `条目类型=缺口` 或 `状态=待补充`，用于补证追踪。

运行时行为：

- 正文和可视化默认只展示脱敏后的证据摘要。
- 如果配置了 `keyEvidenceViewId` 和 `missingEvidenceViewId`，结果卡会附带总表、关键证据视图和缺口视图链接。
- 如果未配置台账表，labor 仍会继续生成文档和图表，不因台账缺失而失败。

## 后续扩展规则

新增劳动 workflow 时，按以下顺序放置代码：

1. 先判断是不是劳动争议领域主线。如果是，入口放在 `src/labor/runtime-module.ts` 和 `src/labor/index.ts`。
2. 如果能力可被其他案由复用，优先放进 `src/workflows/` 或后续 shared skill 目录。
3. 如果能力是合同、发票、案件台账专项动作，调用既有 `contract-assistant` 专项服务，不要复制实现。
4. 如果只是在 Feishu 展示结果，走 `src/feishu/labor-cards.ts` 或对应 family entrypoint，不要扩大 `formatter.ts`。
5. 如果需要 prompt 变化，优先放 skill references，代码只保留稳定变量和 fallback。

## 非目标

这份设计不要求立刻完成完整劳动诉讼工作台，也不要求一次性拆出所有 shared skills。

当前阶段只冻结分层方向：

- `labor-skill` 是劳动领域总入口。
- 专项能力保持独立。
- shared skills 只承载跨领域通用步骤。
- 已经重复或稳定的通用步骤优先下沉。
