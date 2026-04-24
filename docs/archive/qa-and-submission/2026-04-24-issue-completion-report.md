# Issue 收口完成报告

记录日期：2026-04-24

本报告汇总 2026-04-23 至 2026-04-24 期间完成关闭的一组 GitHub issue，并整理后续飞书真机验收清单。

当前 GitHub issue 状态：

- 已完成并关闭：18 条
- 暂停保留：1 条，`#11 【暂停】权限卡按钮回调链路不稳定`

`#11` 暂不纳入本轮功能完成范围。当前稳定交互仍以 `/allow once`、`/allow always`、`/deny` 文本确认为准。

## 完成情况总览

| Issue | 原 issue 标题 | 完成归类 | 完成情况 |
| :-- | :-- | :-- | :-- |
| `#8` | 跟踪飞书 Markdown 代码块语言标注渲染异常 | 飞书输出兼容 | 已通过飞书 Markdown 归一化规则处理代码块语言标注问题，避免命令类 fenced code block 在飞书中错误渲染。 |
| `#9` | 明确模型命令边界并评估窗口级切换方案 | 会话与模型控制 | 已明确 `/models` 为模型列表入口，并由 bridge 接管窗口级 `/model use <provider/model>` 与 `/model reset`。旧 `/model` 列表入口给出迁移提示。 |
| `#10` | 会话列表搜索过滤与删除确认交互优化 | Session UX | 已支持 `/sessions all <关键词>` 过滤、隐藏 session 操作、稳定编号和更清晰的删除确认路径。 |
| `#22` | 将知识库从劳动法偏置放宽为通用法律知识库，并将劳动法偏置下沉为可插拔 skill | 知识库领域边界 | 已将知识库定位从劳动法强偏置收敛为通用法律知识库方向，劳动场景作为上层 skill / workflow 偏置处理。 |
| `#26` | 实现 labor-skill runtime workflow 与证据链输出接线 | Labor workflow | 已落地劳动材料收集、分析、知识库辅助、工作台 Markdown 输出和运行时模块接线。 |
| `#27` | 抽象 shared workflow：timeline-build、workbench-generate、case-workflow module | Shared workflow | 已抽出时间线、工作台生成、证据台账和 case workflow 等共享能力，供 labor 与后续案型复用。 |
| `#29` | [codex] 统一 contract-assistant prompt 外置机制 | Prompt 外置 | 已新增统一 prompt override 机制，合同工作台与合同助手相关 prompt 可优先从外部 skill references 读取，并保留仓库内默认回退。 |
| `#30` | 补充 Python 文档工具层合同编辑与页级删改能力 | DOCX 编辑增强 | 已补充合同编辑与高级 DOCX 编辑脚本能力，包括 analyze、replace、pack 等方向的 Python 测试覆盖。 |
| `#31` | [codex] 支持先上传文件后触发合同/发票识别 | 文件后续指令 | 已通过 `file-await-instruction` 机制支持用户先上传文件，再发送 `/识别发票` 或 `/合同录入` 触发对应模块处理。 |
| `#33` | [需求] 支持图片、扫描件与扫描版 PDF 的知识库材料入库 | 文件解析 / OCR | 已将图片、扫描件和扫描版 PDF 纳入统一材料解析方向，支持通过 document pipeline 和 OCR provider 返回 Markdown sections。 |
| `#47` | Bitable 删除记录未同步清理本地 knowledge-base.db | 知识库一致性 | 已补充 Bitable 远端记录对齐与本地 SQLite 清理能力，远端缺失的 record id 不再继续参与本地知识库检索。 |
| `#48` | 支持基于飞书右键回复/创建的上下文贯通会话延续 | 短期上下文贯通 | 已新增短期消息上下文存储和 prompt 注入能力，用于把飞书回复、线程、bridge 输出摘要接入后续 OpenCode turn。 |
| `#49` | [Tech Debt] 评估单体配置向模块注册表与子配置演进 | 配置架构 | 已引入模块配置注册表，中央配置层开始组合模块定义，减少业务模块字段继续堆进中央 schema 的趋势。 |
| `#50` | [Feature] 支持 labor-skill 领域工作流与 shared skills 拆分 | Labor 分层设计 | 已补充 `docs/modules/labor-skill-workflows.md`，明确 labor-skill、专项能力和 shared workflow 的职责边界。 |
| `#51` | [Enhancement] 支持劳动案件工作台输出与证据台账联动 | Labor 工作台 | 已支持劳动案件分析输出工作台材料，并接入时间线、证据台账和 shared workbench 方向。 |
| `#52` | [Enhancement] 支持通用文件转 Markdown 与统一文本提取管线 | Document pipeline | 已新增 `src/document-pipeline/` 和 `scripts/python/convert_document.py`，把 PDF、DOCX、TXT/MD、HTML、图片 OCR 等路径收敛到统一解析结果。 |
| `#53` | [Spike] 评估高级 DOCX 编辑能力与 docx-edit CLI 封装 | DOCX 编辑 Spike | 已新增 `scripts/python/docx_edit.py` 并以测试验证 DOCX 解包分析、文本替换和打包方向。 |
| `#54` | [Tech Debt] 重构 Feishu 卡片系统为通用原语与业务模板分层 | 卡片模板化 | 已新增通用 card builder 与业务卡片模板 runtime，劳动分析卡片完成模板化试点。 |
| `#55` | [Tech Debt] 将业务能力从 bridge 内嵌实现剥离为 CLI / Skill 可复用单元 | 框架去业务化 | 已将 README、AGENTS、架构边界和多处实现方向调整为 CLI / skill / shared workflow 优先，bridge 继续收敛为宿主与编排层。 |

## 主题完成总结

### 框架边界

本轮最重要的变化是把 bridge 的定位进一步收紧为宿主框架。

已经完成的关键动作：

- 配置从单体 schema 开始向模块注册表过渡。
- 业务能力优先沉淀到 CLI、skill、shared workflow 或模块服务中。
- 卡片层开始从业务硬编码函数迁移到通用原语与业务模板。
- AGENTS 与 README 已同步更新，明确后续新增业务不应默认写进 bridge core。

### 文件与文档处理

文件处理能力已经从专项脚本走向统一入口。

已经完成的关键动作：

- 新增统一 document pipeline。
- Python 转换入口统一返回 Markdown、纯文本、sections、使用工具、质量和 fallback 信息。
- 图片 OCR、扫描件和扫描版 PDF 进入统一材料解析方向。
- DOCX 高级编辑能力完成第一轮 spike。

### 知识库与上下文

知识库继续从单一劳动法场景扩展为更通用的法律知识库。

已经完成的关键动作：

- 劳动法偏置下沉为可插拔领域能力。
- Bitable 与本地 SQLite 的删除一致性补齐。
- 飞书回复/线程上下文可以作为短期 context 注入后续 OpenCode turn。

### Labor 与共享工作流

Labor 不再只是单次分析，而是开始接入可复用工作流和工作台输出。

已经完成的关键动作：

- Labor runtime workflow 已接线。
- 时间线、工作台、证据台账、case workflow 开始作为共享能力存在。
- Labor skill 分层文档明确了领域入口、专项能力和 shared workflow 的关系。

## 飞书真机验收准备

本节只记录真机验收，不以单元测试、类型检查或 CI 命令作为主要标准。目标是在真实飞书私聊或测试群里确认用户路径是否可用、提示是否清楚、上下文是否贯通。

建议准备：

- 启动 OpenCode 服务和 bridge 服务，优先用测试应用或测试群。
- 准备一组材料：普通 PDF、扫描版 PDF、图片、DOCX 合同、发票图片、劳动争议材料、非劳动法法律材料。
- 先在飞书私聊验收，再在群聊或话题场景验收。
- 权限按钮 issue `#11` 仍保持暂停，本轮只验收文本确认路径。
- 每个场景记录飞书消息截图、bridge 日志片段、最终输出是否符合预期。

## 飞书真机验收清单

### 1. 运行时、会话与飞书 Markdown

覆盖 issue：`#8`、`#9`、`#10`。

飞书对话样例：

```text
用户：/status
用户：/new
用户：请给我一段包含 bash 命令和 JSON 配置的安装步骤
用户：/models
用户：/model use openai/gpt-5.4-mini
用户：现在用一句话说明当前模型是什么
用户：/model reset
用户：/sessions all
用户：/sessions all 合同
```

预期表现：

- `/status` 和 `/new` 使用 bridge 自己的状态卡片或明确回复，不由 agent 假装创建会话。
- 带代码块的回复在飞书里排版正常，不把 `bash`、`json` 语言标注渲染成正文噪音。
- `/models` 展示模型列表，`/model use` 只影响当前窗口，`/model reset` 能恢复默认。
- `/sessions all <关键词>` 能过滤会话，编号稳定，不因为过滤结果变化导致误删。

可能出现的问题：

- 飞书 Markdown 仍显示语言标注：优先检查 `docs/feishu-markdown.md` 规则和 formatter 输出。
- `/model use` 后没有生效：检查 provider/model 名称是否存在，以及当前窗口是否被切换。
- `/sessions all <关键词>` 结果为空：确认关键词是否在会话标题、摘要或映射信息里存在。
- 过程卡片重复刷屏：检查运行时卡片更新频率和 final reply 是否同时发送了重复内容。

### 2. 权限文本确认

覆盖 issue：`#11` 暂停项的稳定替代路径。

飞书对话样例：

```text
用户：请读取当前项目目录并总结结构
机器人：权限请求...
用户：/allow once
```

或：

```text
用户：请执行一个会修改文件的操作
机器人：权限请求...
用户：/deny
```

预期表现：

- 权限请求能明确说明将要做什么。
- `/allow once`、`/allow always`、`/deny` 文本路径稳定可用。
- 按钮回调不作为本轮验收要求。

可能出现的问题：

- 点击按钮无反应：这是已知暂停项，不作为失败；改用文本确认。
- 文本确认后仍未继续：检查 pending permission 是否过期、是否在同一飞书会话窗口内回复。
- 权限请求内容太泛：需要回到 bridge 权限卡片文案优化，而不是放到 agent 回复里解决。

### 3. 知识库入库与查询

覆盖 issue：`#22`、`#33`、`#47`、`#52`。

飞书对话样例：

```text
用户：/kb-query 合同解除后违约金一般怎么判断？
用户：/kb-ingest-start
用户：上传《民法典合同编解释.pdf》
用户：上传《扫描版判决书.pdf》
用户：上传《合同条款截图.png》
用户：/kb-ingest-end
用户：/kb-query 根据刚才入库的材料，合同解除和违约金有什么判断要点？
```

Bitable 删除一致性验收样例：

```text
用户：/kb-query 刚才那份材料里的某个独特关键词是什么？
人工操作：在飞书 Bitable 里删除对应知识库记录
用户：/kb-query 再查刚才那个独特关键词
```

预期表现：

- 通用法律问题不会被强行带到劳动法语境。
- PDF、DOCX、TXT/MD、图片和扫描件能进入统一解析流程。
- OCR 不可用或解析质量差时，飞书里能看到可诊断提示，而不是静默失败。
- 查询结果带来源或材料依据。
- Bitable 记录删除后，本地知识库不应继续命中已经被删除的远端记录。

可能出现的问题：

- 扫描件无文字：检查 OCR provider 是否配置，或材料是否需要外部 OCR API。
- Bitable 写入失败：检查飞书应用权限、表格 token、字段名和 record id 映射。
- 删除远端记录后仍能查到：检查同步/校准流程是否执行，以及本地 `knowledge-base.db` 是否仍保留旧 record id。
- 入库结果偏劳动法：检查 labor skill 是否误把领域 prompt 注入通用知识库流程。

### 4. 文件后续指令、合同与发票

覆盖 issue：`#29`、`#30`、`#31`、`#53`。

飞书对话样例：

```text
用户：上传《发票照片.jpg》
用户：/识别发票
```

```text
用户：上传《委托代理合同.docx》
用户：/合同录入
用户：/合同起草开始
用户：帮我起草一份民事委托代理合同，委托人张三，代理事项是一审诉讼
用户：把付款条款改成分两期，第二期在立案后支付
用户：/合同起草结束
```

预期表现：

- 用户先上传文件、后发命令时，最近文件会被正确认领。
- 发票识别不会误拿合同文件，合同录入也不会误拿发票图片。
- 合同 prompt 优先使用外置 skill prompt；外置 prompt 不存在时能回退默认 prompt。
- DOCX 编辑或导出结果能正常打开，基本格式不被破坏。

可能出现的问题：

- 提示“没有找到可处理文件”：检查文件上传事件是否进 bridge、文件上下文是否过期。
- 误绑定其他文件：检查是否跨会话、跨群或多人同时上传造成 recent file 混淆。
- DOCX 打开提示修复：优先检查打包流程和 XML 修改是否破坏关系文件。
- 外置 prompt 没生效：检查 skill references 路径和 fallback 日志。

### 5. 飞书右键回复与上下文贯通

覆盖 issue：`#48`。

飞书对话样例：

```text
用户：/kb-query 这份合同的解除风险是什么？
机器人：输出一段带来源的分析结果
用户：右键回复机器人这条结果，并发送：基于这条继续整理成诉讼策略
```

```text
用户：上传《案件材料.pdf》
用户：请总结关键事实
机器人：输出事实摘要
用户：右键回复摘要中的某一条，并发送：这一点能不能作为证据链核心？
```

预期表现：

- bridge 能识别被回复消息的 parent/root 关系。
- 后续 OpenCode turn 能获得短期 `[Bridge Message Context]` 背景。
- 模型回复能明显承接被回复内容，而不是把问题当成全新会话。
- 短期上下文不会自动写入长期 memory。

可能出现的问题：

- 右键回复后仍像新问题：检查飞书事件里是否带 parent/root message id。
- 被回复内容太旧：短期上下文可能已过期，需要重新引用或重新查询。
- 上下文过长被截断：检查摘要策略，而不是把完整历史全部塞进 prompt。
- bridge 重启后上下文丢失：确认当前实现是否只保证短期 store，不把它当长期记忆。

### 6. Labor 工作流与共享能力

覆盖 issue：`#26`、`#27`、`#50`、`#51`。

飞书对话样例：

```text
用户：/劳动分析
用户：上传《劳动合同.pdf》
用户：上传《工资流水.xlsx》
用户：上传《解除通知书.jpg》
用户：补充背景：公司没有提前通知，最后工作日是 2026-03-31，工资发到 2026-03-15
用户：请生成案件摘要、争议焦点、时间线和证据清单
```

预期表现：

- Labor runtime workflow 能进入材料收集状态。
- 多份材料能被统一解析，并形成案件事实输入。
- 输出包含案件摘要、风险判断、时间线和证据台账方向。
- shared workflow 产物可以被后续案型复用，而不是只写死在 labor 里。

可能出现的问题：

- Excel 工资流水解析失败：检查 document pipeline 是否支持当前格式，必要时先转 CSV。
- 图片证据无文字：检查 OCR 配置和图片清晰度。
- 输出像普通法律咨询而不是工作流结果：检查 `/劳动分析` 是否进入 pending interaction。
- 时间线顺序混乱：检查材料日期抽取和人工补充日期是否冲突。

### 7. 卡片模板化与业务剥离方向

覆盖 issue：`#54`、`#55`。

飞书对话样例：

```text
用户：/劳动分析
用户：上传一份劳动材料
机器人：展示劳动分析相关卡片
用户：/status
机器人：展示运行时状态卡片
```

预期表现：

- 通用运行时卡片和业务卡片风格一致，但职责边界清楚。
- 劳动分析卡片来自业务模板，不应把业务 JSON 硬塞到 runtime core。
- `/status`、权限、过程卡片仍属于 bridge 运行时职责。

可能出现的问题：

- 业务卡片字段缺失：检查业务模板变量是否完整。
- 业务卡片影响通用卡片：检查 shared primitives 是否被业务模板污染。
- 新业务仍需要改 core 才能出卡片：说明抽象还不够，需要继续推进 skill/CLI/template 扩展点。

## 发布前人工复核

- README 中英文版是否仍与当前能力一致。
- `AGENTS.md` 是否包含最新执行规则。
- `docs/architecture-baseline.md` 是否覆盖新增架构边界。
- `docs/modules/knowledge-base.md` 和 `docs/modules/labor-skill-workflows.md` 是否仍是现行说明。
- GitHub open issue 是否只剩明确暂停项 `#11`。
- CHANGELOG 是否记录本轮框架、CLI、文档解析、Labor、知识库、DOCX 和上下文相关变化。
