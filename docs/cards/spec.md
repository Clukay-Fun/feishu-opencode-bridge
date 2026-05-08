# 飞书卡片规范

> 本文件是工程 review source of truth，视觉 source of truth 是 `飞书卡片.pdf`。

## 卡片分类

### 1. 知识库卡片（5 态）

| 模板 ID | 卡片标题 | 模板色 | iconToken | 用途 |
|---------|---------|--------|-----------|------|
| `knowledge.ingest-ready` | 知识入库已开启 | indigo | `start_outlined` | 进入入库模式提示 |
| `knowledge.ingest-queued` | 知识入库排队中 | orange | `clock_outlined` | 入库任务排队等待 |
| `knowledge.ingest-processing` | 知识入库进行中 | indigo | `loading_outlined` | 入库处理中进度 |
| `knowledge.ingest-completed` | 知识入库完成 | green | `yes_filled` | 入库成功结果 |
| `knowledge.ingest-failed` | 入库失败 | red | `error_filled` | 入库失败错误 |

**多文件入库规则**：多文件并入五态，不使用独立的 session/summary 卡。

**字段说明**：
- `title`: 入库任务标题
- `fileCount`: 文件数量（多文件时显示）
- `completedCount`: 已完成数量
- `failedCount`: 失败数量
- `duration`: 耗时
- `errorMessage`: 错误信息（失败时显示）

**废弃卡片**：
- `buildKnowledgeIngestSessionPayload` — 会话摘要卡
- `buildKnowledgeIngestSessionFinalPayload` — 会话最终汇总卡（已重命名为 `buildKnowledgeIngestCompletedPayload`）

---

### 2. 知识查询卡片（2 态）

| 函数名 | 卡片标题 | 模板色 | 用途 |
|-------|---------|--------|------|
| `buildKnowledgeQueryPayload` | 法律咨询 | indigo | 查询命中结果 |
| `buildKnowledgeQueryEmptyPayload` | 法律咨询 | grey | 查询未命中 |

---

### 3. 劳动分析卡片

| 模板 ID | 卡片标题 | 模板色 | iconToken | 用途 |
|---------|---------|--------|-----------|------|
| `labor.analysis.progress` | 劳动分析进行中 | indigo | `start_outlined` | 分析进度 |
| `labor.analysis.completed` | 劳动分析完成 | green | `yes_filled` | 一审完成（不含文档链接） |
| `labor.review.completed` | 劳动分析二审通过/完成 | green/yellow | `yes_filled`/`warning_filled` | 二审完成（含文档链接+review信息） |

**二审完成卡字段**：
- `title`: 案件标题
- `materialCount/evidenceCount/issueCount`: 统计数据
- `reviewStatus`: 二审状态文本
- `findingsCount`: 发现问题数量
- `humanReviewCount`: 需人工复核数量
- `docUrl`: 分析文档链接
- `ledgerUrl`: 证据台账链接

**关键规则**：
- 文档链接只在二审完成卡出现，一审完成卡不放
- 二审完成卡必须承载审查状态、findings 数量、需人工复核数量

**废弃卡片**：
- Harness 四张独立卡（review-report、authority-coverage、findings、result-group）

---

### 4. 运行时卡片

| 函数名 | 卡片标题 | 模板色 | 用途 |
|-------|---------|--------|------|
| `buildStatusPayload` | 系统状态 | indigo | /status 命令 |
| `buildGuidePayload` | 快速上手 | indigo | /guide 命令 |
| `buildModelListPayload` | 可用模型 | indigo | /models 命令 |
| `buildSessionListPayload` | 会话列表 | indigo | /sessions 命令 |
| `buildSessionTransitionPayload` | 会话切换 | green | /switch 命令 |
| `buildPermissionRequestPayload` | 权限请求 | purple | 权限确认 |
| `buildTurnStatusPayload` | 任务状态 | indigo | 处理中状态 |
| `buildCallbackTestPayload` | 回调测试 | blue | 按钮回调测试 |

**废弃卡片**：
- `buildWhoCommandCardPayload` — 群聊绑定状态（/who 命令）
- `buildLeaveCommandCardPayload` — 已解除绑定（/leave 命令）

---

### 5. 合同/发票卡片

| 函数名 | 卡片标题 | 模板色 | 用途 |
|-------|---------|--------|------|
| `buildContractExtractPayload` | 合同信息提取 | green | 合同字段提取结果 |
| `buildContractReviewPayload` | 合同审查报告 | indigo | 合同风险审查 |
| `buildContractDraftPayload` | 合同起草 | indigo | 合同草稿生成 |
| `buildInvoiceRecognizePayload` | 发票识别 | green | 发票字段识别 |
| `buildCaseWorkbenchPayload` | 案件工作台 | indigo | 案件管理 |

**停用说明**：
- 提醒卡片与提醒入口本期完全停用，不保留用户侧卡片 fallback。

---

### 6. Harness 卡片（仅离线脚本）

Harness 卡片不再作为用户侧独立卡片展示，仅用于离线回归脚本。

**保留**（仅脚本使用）：
- `harness.review-report`
- `harness.authority-coverage`
- `harness.findings`
- `harness.result-group`

**从 formatter export 中移除**：
- `buildHarnessReviewReportPayload`
- `buildHarnessAuthorityCoveragePayload`
- `buildHarnessFindingsPayload`
- `buildHarnessResultGroupPayload`

---

## 废弃清单

### 知识库
- `buildKnowledgeIngestSessionPayload`
- `buildKnowledgeIngestSessionFinalPayload`
- `KnowledgeIngestCompletedCardView`（替代旧 `KnowledgeIngestSessionSummaryView`）

### 群聊
- `buildWhoCommandCardPayload`
- `buildLeaveCommandCardPayload`
- `WhoCommandCardView`
- `LeaveCommandCardView`

### 提醒
- `buildReminderProgressPayload`
- `buildTodayTodoPayload`
- `buildCaseReminderAddCompletedPayload`
- `ReminderListResult`

### Harness（用户侧）
- `buildHarnessReviewReportPayload`
- `buildHarnessAuthorityCoveragePayload`
- `buildHarnessFindingsPayload`
- `buildHarnessResultGroupPayload`
- `HarnessReviewReportCardView`
- `HarnessAuthorityCoverageCardView`
- `HarnessFindingsCardView`
- `HarnessResultGroupCardView`

---

## 新增功能卡片（pending_integration）

以下卡片已定义但尚未接入运行时发送路径，仅允许进入 mock preview/catalog。

- 无（本期无新增 pending_integration 卡片）
