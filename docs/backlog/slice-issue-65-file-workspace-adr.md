# Slice: Issue #65 File/Document Workspace 能力层 ADR（设计阶段，不实现）

## 目标

为统一的 File/Document Workspace 能力层产出一份 ADR，定义：

- 9 个能力边界的现状覆盖度评估
- 标准化输出 schema（让业务模块只消费一套结果）
- MVP 子集（必须在 1-2 个 implementation slice 内可完成的最小可执行集）
- 权限/安全约束
- Document Operation Journal 设计
- CLI 形态草案
- 与现有 `document-pipeline`、知识库、合同助手、劳动工作台的衔接路径

**本 slice 只产出设计文档，不写任何业务代码。** 实现工作由后续 implementation slice 承接。

## 范围

### 包含

- 新建 `docs/adr/0003-file-workspace-layer.md`
- ADR 必须包含以下章节：
  1. 背景与现状（分散在哪些模块）
  2. 9 个能力边界的现状覆盖度评估表（文件输入 / 解析 / 本地编辑 / 云文档编辑 / 模板 / 输出 / CLI / 权限 / Journal）
  3. 标准化输出 schema（TypeScript 接口草案）
  4. MVP 子集定义（明确哪些能力是 MVP，哪些是 V2，哪些是 Future）
  5. 权限与安全清单
  6. Document Operation Journal 模型
  7. CLI 形态草案（命令名、参数、输出）
  8. 与现有模块的衔接路径（如何让 document-pipeline / 知识库 / 合同 / 劳动逐步迁移消费这个统一层，不强制一次性重写）
  9. 实现切片建议（推荐的拆分，标题级）
  10. 被拒绝的备选方案与理由
  11. 验收清单
- 更新 `docs/backlog/post-freeze-backlog.md` 索引指向新 ADR
- 在 GitHub issue #65 评论里贴 ADR 摘要

### 不包含

- **不写任何 `.ts` 代码**
- **不动** `src/document-pipeline/`、`src/knowledge/`、`src/contract-assistant/`、`src/labor/` 任何文件
- **不实现** 任何能力（文件输入、解析、编辑、模板、Journal、CLI 都不实现）
- **不重构** 现有 document-pipeline
- **不规划** implementation slice 的具体步骤（ADR 里只给标题级建议）
- **不讨论** PPTX / EML / MSG / JSON / XML 等"后续可选"类型的具体方案（issue 里这些标了"后续可选"，ADR 也保持后续）

### 行为规则

1. **渐进迁移，不强制重写**：ADR 必须明确"现有模块可以继续用现状，新功能优先走统一层"，不允许设计成"一次性重写所有文件相关代码"。
2. **MVP 必须可单 slice 完成**：MVP 子集要严格收敛到 1-2 个 implementation slice 能完成的程度。如果 MVP 写出来需要 5 个 slice，说明 MVP 过大，要砍。
3. **标准化输出 schema 是核心**：MVP 即使只覆盖少数文件类型，schema 必须设计完整（让后续 V2 扩展不需要破坏性变更）。
4. **不引入新存储**：Journal 设计假设继续用 SQLite。
5. **CLI 是 OpenCode 可调用方式之一，不是唯一**：ADR 必须保留 TypeScript service 直接调用的可能，不要把 CLI 设计成强制层。
6. **必须包含被拒绝方案**：至少 2 个（如"一次性重写所有文件模块""完全替换 document-pipeline"），写明拒绝理由。

## 实现步骤

### 步骤 1：读现状

- `src/document-pipeline/` 当前职责和覆盖范围
- `src/knowledge/` 入库路径
- `src/contract-assistant/` 文件处理
- `src/labor/` 材料收集
- `lark-cli` docs/sheets/base/drive 命令的能力（看 #65 issue 提到的底层依赖）
- 读 `docs/architecture-baseline.md` 文件能力相关章节
- 读 `docs/adr/0001-window-session-vocabulary.md` 作为 ADR 格式参考

### 步骤 2：填现状覆盖度评估表

对 9 个能力边界（文件输入 / 解析 / 本地编辑 / 云文档编辑 / 模板 / 输出 / CLI / 权限 / Journal），每项标：

- 当前覆盖位置（文件路径）
- 覆盖完整度（完整 / 部分 / 缺失）
- 重复实现情况（哪些模块各自实现了这个能力）

### 步骤 3：设计标准化输出 schema

TypeScript 接口草案，覆盖文件元信息、原始文本、Markdown、表格数据、页码/章节、OCR 文本、附件索引、解析置信度、fallback 路径。

### 步骤 4：定义 MVP

砍到 1-2 slice 能完成的程度。建议方向：

- MVP：统一的"读 + 解析"接口（文件输入 → 标准化输出 schema），覆盖 PDF / DOCX / TXT / MD / XLSX / PNG/JPG 加 OCR
- MVP 不含：本地编辑、云文档编辑、模板、Journal、CLI（这些放 V2）

但 ADR 里要给出 MVP 的具体边界，不要含糊。

### 步骤 5：权限与安全清单

按 issue 给出的 8 条（文件大小、扩展名白名单、降级、脱敏、输出路径、临时清理、写确认、云文档快照）写成 ADR 里的硬约束。

### 步骤 6：Journal 模型

定义 SQLite 表结构草案：来源、操作类型、输出位置、状态、耗时、fallback 标记、文档链接。

### 步骤 7：CLI 形态草案

按 issue 给出的命令样式确认或调整：

```
files read --input ...
files parse --input ...
files create --type docx --from-template ...
files edit --input ... --command ...
files fetch-feishu-doc --url ...
files update-feishu-doc --url ... --command append
```

### 步骤 8：与现有模块衔接路径

写明：

- document-pipeline 怎么逐步消费统一层（先包装现有逻辑，再迁移）
- 知识库入库怎么改为消费统一 schema
- 合同 / 劳动 / 发票模块的迁移优先级

### 步骤 9：实现切片建议

标题级，3-5 个 slice：

- Slice A：标准化输出 schema + MVP 读/解析（PDF/DOCX/TXT/MD/XLSX）
- Slice B：图片 OCR 接入
- Slice C：本地编辑 + 模板能力
- Slice D：云文档编辑封装
- Slice E：Journal + CLI 暴露

每 slice 2-3 行说明，不写步骤。

### 步骤 10：贴 issue 评论

#65 评论里贴 ADR 摘要 + 文件链接。

## 验收标准

- [ ] `docs/adr/0003-file-workspace-layer.md` 存在并包含 11 个章节
- [ ] 9 个能力边界的现状覆盖度评估表完整
- [ ] 标准化输出 schema 有 TypeScript 接口草案
- [ ] MVP 子集明确且收敛到 1-2 slice 可完成
- [ ] 权限与安全清单包含 issue 列出的 8 条
- [ ] Journal 模型有表结构草案
- [ ] CLI 形态草案有具体命令
- [ ] 衔接路径包含现有 4 个模块的迁移描述
- [ ] 实现切片建议 3-5 个，每个 2-3 行
- [ ] 至少 2 个被拒绝备选方案
- [ ] `git diff src/ test/` 完全空
- [ ] GitHub issue #65 有 ADR 摘要评论

## 验证命令

```bash
git status --short                       # 只应有 docs/ 下变更
git diff src/ test/                      # 必须完全空
ls docs/adr/0003-file-workspace-layer.md
wc -l docs/adr/0003-file-workspace-layer.md  # 期望 300-500 行
```

不需要跑 typecheck / test。

## 给执行 Agent 的硬约束

1. **本 slice 是设计 slice，不是实现 slice**。任何"实现起来很简单"的部分都不允许在本 slice 内动手。
2. **不动现有模块代码**。document-pipeline、knowledge、contract、labor、case-workbench 源码不动、不重命名、不"顺手清理"。
3. **MVP 要砍狠**：如果 MVP 章节写出来超过 2 slice 能完成的范围，必须砍。宁可 MVP 小，不要 MVP 完整但落不下来。
4. **schema 设计要前瞻**：MVP 即使只覆盖少数类型，schema 字段要预留未来类型（PPTX / EML 等）需要的位置，但**ADR 不展开未来类型的具体方案**。
5. **不引入新依赖讨论**：继续假设 SQLite + 现有 lark-cli + 现有 OCR 工具链。
6. **不规划现有模块的"必须迁移时间表"**：衔接路径写成"可以"和"建议"，不要写成"必须在 X 个月内完成"。
7. **被拒绝方案要真**：至少 2 个，必须是 issue 隐含或讨论中真实出现过的候选，不要造稻草人。

## 完成总结模板

```
1. ADR 文件路径 + 行数
2. 11 个章节齐全确认
3. MVP 子集一句话摘要 + 预估几个 slice 完成
4. 标准化 schema 关键字段列表
5. Journal 表名 + 字段一句话摘要
6. 推荐的 implementation slice 标题
7. 已知未决问题（如有）
8. issue 评论链接
```
