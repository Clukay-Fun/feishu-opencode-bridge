# 飞书卡片规范

> 本文件是工程 review source of truth，视觉 source of truth 是 `飞书卡片.pdf`。

## 预览验收指令

使用真实 builder 发送当前保留用户侧卡片预览：

```bash
npm run cards:preview
```

常用参数：
- `--dry-run`：只列出会发送的卡片，不调用飞书。
- `--list`：列出预览清单。
- `--only <关键词>`：只发送匹配分组、名称或别名的卡片，例如 `--only 知识库`、`--only invoice`。
- `--chat-id <oc_xxx>` / `--user-id <ou_xxx>`：覆盖发送目标。

默认目标：读取当前 `lark-cli auth status` 的 `userOpenId`，用 bot 身份发送到该用户私聊。也可以通过 `LARK_CARD_PREVIEW_CHAT_ID` 或 `LARK_CARD_PREVIEW_USER_ID` 固定默认目标。

## 专属卡片准入规则

业务侧不要为每个输出都制作设计器专属卡片。

只有以下两类业务场景允许新增或保留专属卡片：

- **提醒类**：有明确时间、截止日、待办、风险提醒或需要用户后续动作的场景，例如开庭提醒、举证期限提醒、案件待办。
- **流程类**：有明确生命周期或状态流转的场景，例如开启、排队中、进行中、完成、失败，或需要原位更新进度和按钮动作的流程卡。

其它业务输出默认使用通用卡片能力：

- 普通查询结果、资料摘要、一次性说明、短反馈、空状态和错误提示，优先使用 `buildNoticeCardPayload` 或既有通用结果卡。
- 不新增仅服务单次文本展示的 designer `.card` 模板。
- 如确需例外，必须在本文件写明原因、触发路径、是否可预览，以及为什么通用卡无法承载。

## 卡片分类

### 1. 知识库卡片（5 态）

| 模板 ID | 卡片标题 | 模板色 | iconToken | 用途 |
|---------|---------|--------|-----------|------|
| `knowledge.ingest-ready` | 知识入库已开启 | blue | `loading_outlined` | 进入入库模式提示 |
| `knowledge.ingest-queued` | 知识入库排队中 | orange | `clock_outlined` | 入库任务排队等待 |
| `knowledge.ingest-processing` | 知识入库进行中 | blue | `loading_outlined` | 入库处理中进度 |
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
| `labor.collection` | 材料收集中 | blue | `loading_outlined` | 劳动材料收集入口 |
| `labor.analysis.progress` | 材料分析进行中 | blue | `loading_outlined` | 分析进度 |
| `labor.analysis.completed` | 材料分析完成 | green | `yes_filled` | 一审完成（不含文档链接） |
| `labor.review.progress` | 二次审查进行中 | blue | `loading_outlined` | 后台二审校验进度 |
| `labor.review.completed` | 二次审查完成 | green/yellow | `yes_filled`/`warning_filled` | 二审完成（含文档链接+review信息） |

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
| `buildModelListPayload` | 可用模型 | indigo | /models 命令 |
| `buildSessionListPayload` | 会话列表 | indigo | /sessions 命令 |
| `buildSessionTransitionPayload` | 会话切换 | green | /switch 命令 |
| `buildPermissionRequestPayload` | 权限请求 | purple | 权限确认 |
| `buildTurnStatusPayload` | 任务状态 | indigo | 处理中状态 |
| `buildCallbackTestPayload` | 回调测试 | blue | 按钮回调测试 |

### 5. 合同/发票卡片

| 函数名 | 卡片标题 | 模板色 | 用途 |
|-------|---------|--------|------|
| `buildContractExtractPayload` | 合同信息提取 | green | 合同字段提取结果 |
| `buildContractReviewPayload` | 合同审查报告 | indigo | 合同风险审查 |
| `buildContractDraftPayload` | 合同起草 | indigo | 合同草稿生成 |
| `buildInvoiceRecognizeProgressPayload` | 发票识别 | blue | 发票字段识别进度，支持多文件展示字段 |
| `buildInvoiceRecognizeCompletedPayload` | 发票识别完成 | green | 发票字段识别结果 |
| `buildCaseWorkbenchPayload` | 案件工作台已开启 | blue | 案件工作台入口卡 |
| `buildCaseTodoReminderPayload` | 案件提醒 | blue | `/案件待办` 查询结果，复用今日待办设计器模板展示案件节点和待办 |

**停用说明**：
- 旧通用提醒入口本期停用，不保留用户侧卡片 fallback。
- 案件待办查询仍是 active 能力；卡片标题使用“案件提醒”，但入口只保留 `/案件待办`。

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

### Harness（用户侧）
- `buildHarnessReviewReportPayload`
- `buildHarnessAuthorityCoveragePayload`
- `buildHarnessFindingsPayload`
- `buildHarnessResultGroupPayload`
- `HarnessReviewReportCardView`
- `HarnessAuthorityCoverageCardView`
- `HarnessFindingsCardView`
- `HarnessResultGroupCardView`

### 旧通用提醒入口
- `/案件提醒`
- `/添加案件提醒`

---

## 新增功能卡片（pending_integration）

以下卡片已定义但尚未接入运行时发送路径，仅允许进入 mock preview/catalog。

- 发票多文件展示字段：builder 已支持 `currentFile/completedFiles/failedFiles`，当前 runtime 仍按单文件识别调度。
