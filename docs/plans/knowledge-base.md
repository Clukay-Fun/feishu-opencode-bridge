# 法律知识库方案

## 定位

面向法律从业者的知识库系统，支持：

- 批量导入法律文档（PDF/Word/TXT/MD），AI 自动提取问答对
- 用户提问时，基于 embedding 语义检索 + AI 重排序，返回多条带来源引用的答案
- URL 网页内容入库（通过 OpenCode 辅助读取网页并整理成 Markdown）
- 通过 `/legal-query-start` 进入知识库模式，后续直接提问，无需每条消息都输入命令

实现为 bridge 内建知识库子系统（`src/knowledge/`），由 bridge 接管 `/kb-ingest-start`、`/kb-ingest-end`、`/legal-query`、`/legal-query-start`、`/legal-query-end` 这组命令。

## 模型与供应商分工

**核心原则：**

- **普通对话**使用 OpenCode 默认模型，bridge 不显式指定。
- **知识库生成任务**（网页读取、问答提取、重排序）按 `knowledgeBase.models.*` 显式指定 OpenCode model id。
- **embedding** 独立直连 provider，不走 OpenCode。

### 模型路由配置

```json
"knowledgeBase": {
  "models": {
    "default": "minimax-cn-coding-plan/MiniMax-M2.7"
  }
}
```

`default` 为所有知识库生成任务的兜底模型。如需按步骤分别指定，可覆盖：

```json
"knowledgeBase": {
  "models": {
    "default": "minimax-cn-coding-plan/MiniMax-M2.7",
    "webRead": "qwen/qwen-max",
    "extract": "deepseek/deepseek-chat",
    "rerank": "qwen/qwen-plus"
  }
}
```

解析优先级：`models.{step}` > `models.default` > 不传（使用 OpenCode 默认模型）。

### 调用方式

知识库的 webRead / extract / rerank 三步通过 OpenCode 短生命周期内部 session 完成：创建 session → 发送 prompt（带 model 参数）→ 获取响应 → 立即删除 session。这属于实现细节，不暴露成用户会话概念。

### Embedding

embedding 始终通过 `knowledgeBase.embeddingProvider`（或复用 `embeddings.provider` / `memory.embeddingProvider`）直连 provider API，不经过 OpenCode。原因：embedding 是稳定、标准、低耦合的能力，直连更简单可靠。

## 多维表格结构

在飞书 Bitable 中创建知识库表：

| 字段      | 类型        | 说明                                  |
| --------- | ----------- | ------------------------------------- |
| 问题      | 文本        | AI 提取的问题                         |
| 答案      | 文本        | AI 提取的答案                         |
| 标签      | 多选        | 法律领域分类（合同、劳动、知产…）    |
| 法条      | 文本/超链接 | 关联法条引用（如《民法典》第 585 条） |
| 源文件    | 文本/超链接 | 原始文档名称；可配置为飞书超链接字段  |
| 页码/章节 | 文本        | 在原文档中的位置                      |
| embedding | 文本        | 问题+答案的向量（JSON 序列化）        |
| 入库时间  | 日期        | 自动填充                              |

可选：单独的文档表（`documentTableId`），记录每个源文件的入库元信息。

### 权限前置条件

bridge 读写 Bitable 使用的是 `config.json` 中 `feishu.appId` / `feishu.appSecret` 对应的飞书应用身份，不是操作者个人网页登录态。上线前必须同时满足：

- 飞书开放平台中，该应用已开通多维表格记录读取/写入相关 scope，并已发布新版本。
- 目标 Base 的 `...` -> `更多` -> `添加文档应用` 中，已添加同一个飞书应用。

如果缺少文档应用授权，即使用户本人能打开多维表格，OpenAPI 也可能返回 `RolePermNotAllow`，导致启动镜像同步或入库写表失败。

## Bridge 命令 1：knowledge-ingest（入库）

### 触发方式

```
@bot /kb-ingest-start
```

随后连续上传 PDF / DOCX / TXT / MD 文件，或发送带 URL 和明确入库意图的自然语言，例如：

```
@bot 读取 https://example.com/law 这个网页并入库
```

URL 入库路径：bridge 创建一次 OpenCode 短生命周期 session，使用 `models.webRead` 指定的模型读取网页并整理成 Markdown，再交给知识库入库管线。结束入库时发送：

```
@bot /kb-ingest-end
```

### 流程

```
用户上传文档 / 发送 URL
  │
  ▼
[1] 文档解析 / 网页读取
    ├── PDF → pdf-parse 按页提取文本，保留页码
    ├── Word → mammoth 提取原始文本，再按段落切分
    ├── TXT/MD → 按段落切分
    └── URL → OpenCode session (model: webRead) 读取网页 → Markdown
  │
  ▼
[2] 分块
    按语义段落切分，每块 ≤ 1000 字
    重叠窗口 100 字（避免截断关键信息）
    每块携带 prevContext（上一块尾部 150 字原文，仅供上下文理解）
    附带元信息：{ fileName, location }
  │
  ▼
[3] AI 提取问答对（model: extract）
    对每个 chunk 调用 OpenCode session，提取：
    - question：口语化的法律咨询问题
    - answer：基于原文的回答（50-300 字）
    - tags：1-3 个核心法律主题标签
    - statute：关联法条（无法条时为 null）
    规则：同一知识点只提取一个问答对，不拆分
  │
  ▼
[4] 两层去重
    第一层：规则去重
      - question 标准化（去标点、空格、语气词）
      - 完全相同的 question 合并，保留更完整的一条
    第二层：语义去重
      - 同源文件内 question embedding 相似度 > 0.9 合并
      - 保留答案更完整、法条更明确、标签更干净的一条
  │
  ▼
[5] 生成 embedding
    对「问题 + 答案」拼接文本生成向量（直连 embedding provider）
  │
  ▼
[6] 写入 Bitable + 本地 SQLite
    每条问答对写入 Bitable 一行 + SQLite 一行
    SQLite 同时维护 FTS5 全文索引
```

### 问答提取 Prompt

```
你是法律知识提取专家。

阅读以下文本片段，提取可以直接回答用户法律咨询的问答对。

规则：
1. 问题必须是用户真实会提出的法律实务问题，范围限定在劳动用工、合同履行、争议处理、合规操作等法律咨询场景。
2. 同一知识点只提取一个问答对，答案中列举所有关键情形，不要拆成多条相近问题。
3. 答案忠于原文，长度控制在 50-300 字，涵盖核心结论、适用条件和例外情形，不要整段照抄原文。
4. 不要提取目录、课程介绍、检索方法、转载说明、免责声明、作者信息、案例来源、地域统计、学习建议、关键词列表等非咨询内容。
5. 如果片段主要是说明性或信息性内容，而不是可直接回答咨询的问题，返回空数组 []。

字段说明：
- question: 字符串，口语化的法律咨询问题
- answer: 字符串，基于原文的回答
- tags: 数组，1-3 个核心法律主题标签
- statute: 字符串或 null；无明确法条引用时填 null

前文上下文（仅供理解，不要从这里单独提取问答）：
{prevContext}

源文件：{fileName}
页码/章节：{pageSection}

---正文开始---
{chunk}
---正文结束---

示例输出：
[
  {
    "question": "公司不续签劳动合同，员工能拿到补偿吗？",
    "answer": "劳动合同期满，用人单位不续签或降低条件续签导致劳动者不续签的，应按工作年限支付经济补偿，每满一年支付一个月工资。",
    "tags": ["劳动"],
    "statute": "《劳动合同法》第 46 条"
  }
]

只输出 JSON 数组，不要输出其他内容。
```

### 入库完成卡片

```
📚 知识入库完成

源文件：《劳动合同法实务指南》.pdf
原始提取：63 条
去重合并：16 条
最终入库：47 条
标签分布：劳动(32)、合同(10)、诉讼程序(5)
耗时：12s

[查看多维表格]
```

如果最终入库数 > 150 条，卡片额外显示软警告：

```
⚠️ 该文件提取了 N 条问答，建议人工抽查质量。
```

## Bridge 命令 2：knowledge-query（检索）

### 触发方式

```
@bot /legal-query-start
员工试用期最长多久？
```

知识库模式下，普通文本消息会直接进入知识库检索，不再创建 OpenCode 普通会话。退出时发送：

```
@bot /legal-query-end
```

单次查询仍可使用：

```
@bot /legal-query 员工试用期最长多久？
```

未开启知识库模式时，bridge 会保守识别普通文本中的法律咨询问题（基于关键词 + 问句特征 + 法条引用的置信度评分）；置信度不足则回退到 OpenCode 普通对话。

### 流程

```
用户提问
  │
  ▼
[1] 生成查询 embedding（直连 embedding provider）
  │
  ▼
[2] 双路检索
    ├── 语义检索：与 SQLite 中所有条目的 embedding 计算余弦相似度，取 top-K（K=10）
    └── 关键词检索：FTS5 全文索引匹配，取 top-N
    合并去重
  │
  ▼
[3] AI 重排序（model: rerank）
    将合并后的候选条目送入 OpenCode session 重排序
    过滤无关项，按相关性排序
    保留 top-N（N=3）
  │
  ▼
[4] 格式化输出
    每条答案附带来源引用（源文件 + 页码）
    同一问题的多个答案全部列出
```

### 检索输出卡片示例

```
🔍 法律咨询：员工试用期最长多久？

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

答案 1
试用期最长不超过 6 个月。具体期限与劳动合同期限挂钩：
- 合同期 3 个月～1 年：试用期 ≤ 1 个月
- 合同期 1～3 年：试用期 ≤ 2 个月
- 合同期 3 年以上或无固定期限：试用期 ≤ 6 个月
同一用人单位与同一劳动者只能约定一次试用期。

📄 来源：《劳动合同法实务指南》.pdf · 第 23 页
📌 法条：《劳动合同法》第 19 条

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

答案 2
以完成一定工作任务为期限的劳动合同，或劳动合同期限不满三个月的，
不得约定试用期。违法约定的试用期已履行的，由用人单位以满月工资为
标准向劳动者支付赔偿金。

📄 来源：《企业用工合规手册》.docx · 第 3.2 章
📌 法条：《劳动合同法》第 19 条、第 83 条

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

共检索到 2 条相关结果

⚠️ 以上内容仅供参考，不构成法律意见。具体问题请咨询专业律师。
```

## 技术实现

### 模块结构

```
src/knowledge/
├── index.ts      # KnowledgeBaseService 主类：入库、查询、去重、模型调度
├── parser.ts     # 文档解析 + 分块（PDF/DOCX/TXT/MD）
├── db.ts         # SQLite 存储：文档表、条目表、FTS5 全文索引、embedding 检索
└── detector.ts   # 法律问题自动识别：关键词匹配 + 问句特征 + 法条引用检测
```

### Bridge 分流

```text
文本消息
  │
  ├── /kb-ingest-start
  │     └── 当前窗口进入知识入库模式，连续接收同发送者文件消息 / URL 消息
  │
  ├── /kb-ingest-end
  │     └── 当前窗口退出知识入库模式
  │
  ├── /legal-query-start
  │     └── 当前窗口进入知识库模式
  │
  ├── /legal-query-end
  │     └── 当前窗口退出知识库模式
  │
  ├── 知识库模式已开启
  │     └── 直接查询知识库
  │
  └── 普通文本
        ├── autoDetect 命中（置信度 ≥ 0.75）→ 查询知识库
        └── 未命中 → 原 OpenCode 对话
```

### 存储架构

**Bitable + 本地 SQLite 双写：**

- Bitable：面向用户可见的知识库表，方便在飞书中浏览和管理
- SQLite：本地持久化 + 高性能检索（FTS5 全文索引 + embedding 暴力扫描）
- 入库时双写；启动时可通过 `syncMirror()` 从 Bitable 同步到 SQLite

SQLite 表结构：

- `knowledge_documents`：文档元信息（文件名、checksum、来源类型、状态）
- `knowledge_entries`：问答条目（question、answer、tags、statute、embedding、源文件、页码）
- `knowledge_entries_fts`：FTS5 虚拟表，对 question/answer/statute/source_file/page_section 建索引

### 文档解析

| 格式         | 解析方式                       | 依赖        |
| ------------ | ------------------------------ | ----------- |
| PDF          | `pdf-parse` 按页提取文本       | pdf-parse   |
| Word (.docx) | `mammoth` 提取原始文本，再按段落切分 | mammoth     |
| TXT/MD       | 直接读取（支持 GB18030 自动检测） | 无          |
| URL 网页     | OpenCode session 读取并整理成 MD | OpenCode    |

### 分块策略

```
文档文本
  │
  ▼
按段落 / 页面初步切分
  │
  ▼
按 chunkSize（默认 1000 字）二次切分
  │
  ▼
重叠窗口 overlap（默认 100 字）
  │
  ▼
每块携带 prevContext（上一块尾部 prevContextSize 默认 150 字原文）
  │
  ▼
附带元信息：{ location }
```

## 性能优化

### 入库并发

入库流程涉及大量串行 IO（模型提取 × chunk 数 + embedding × 问答数 + Bitable 写入 × 问答数），是最主要的性能瓶颈。

**当前优化：有限并发（`knowledgeBase.ingest.concurrency`，默认 3）。**

- 提取阶段：最多同时 N 个 chunk 并发调用 OpenCode 提取问答
- 写入阶段：最多同时 N 条问答并发执行 embedding + Bitable 写入 + SQLite 写入

并发度不宜过高，因为 OpenCode 短生命周期 session 本身有创建/删除开销，且模型 API 可能有速率限制。默认 3 在大多数场景下已经能将耗时缩短到串行的 1/2 ~ 1/3。

### 进度展示

进度拆分为三层业务步骤，避免用户误判卡在哪一步：

```
读取内容
  - 正在下载并解析文件
  - 已提取 N 段正文

提取问答
  - 文本切块完成（共 82 段），开始提取问答
  - 正在提取问答（第 12/82 段）
  - 提取完成（63 条），正在合并重复问答
  - 正在去重问答（12/63）
  - 已提取 47 条问答（原始 63 条，去重合并 16 条）

写入知识库
  - 正在生成 embedding 并写入知识库（8/47）
  - 已写入 47 条问答
```

### 入库进行中的交互规则

入库任务运行时，bridge 对同一窗口的其他消息采用"占线"策略：

- **允许**结束命令：`/kb-ingest-end`
- **允许**切换命令：`/legal-query-start`
- **其他普通文本**：不参与普通对话，直接提示"当前正在入库处理中"

提示文案：

```
当前正在处理知识入库任务。
发送 /kb-ingest-end 可退出入库模式。
如需切换到法律查询，请发送 /legal-query-start。
普通对话请等待当前入库完成后再发送。
```

## 架构边界

### 当前决策

- **入库和查询由 bridge 主控。** bridge 负责命令入口、模式切换、文档解析、分块、去重、SQLite 检索、卡片渲染、进度展示。
- **ingest 执行先在 bridge 内部模块化（`src/knowledge/`），不急着外移成外部 skill。** 等核心链路跑稳后再考虑是否将网页读取、文件解析、文本清洗、问答提取等重工作流拆成独立 skill。
- **bridge 不管理 provider。** 所有生成式任务通过 OpenCode model id 路由；embedding 直连 provider。

### 未来可能的 skill 拆分边界（待验证，不急）

```
bridge = 控制面 + 查询面
  - 飞书消息接入、模式切换
  - 命令入口（/kb-ingest-start, /legal-query-start 等）
  - 本地 SQLite 检索
  - 查询结果卡片、入库进度卡片

skill = 入库执行面（如果需要外移）
  - 网页读取
  - 文件解析
  - 文本清洗
  - 问答提取
  - 批量入库工作流
```

## 不做的事

- 不做实时文档同步（入库是一次性操作，更新需重新入库）
- 不做权限控制（当前单人/信任小组定位）
- 不做答案生成（只检索已入库的问答对，不基于原文重新生成）
- 不做多语言支持（仅中文）
- 不替代律师专业意见（卡片底部加免责声明）
- 不对入库条目数做硬上限（> 150 条时软警告提示抽查质量）

## 免责声明

检索结果卡片底部固定附带：

```
⚠️ 以上内容仅供参考，不构成法律意见。具体问题请咨询专业律师。
```

## 实施顺序

1. **Phase 1**（已完成）：查询骨架 + Bitable 同步 + SQLite 双路检索 + AI 重排序
2. **Phase 2**（已完成）：文档解析 + AI 提取 + 两层去重 + 模型路由配置 + URL 网页入库
3. **Phase 3**（已完成）：入库并发优化 + 进度展示细化 + 入库占线交互规则
4. **Phase 4**（进行中）：去重统计上卡片、实际文档验证提取效果、检索质量调优
