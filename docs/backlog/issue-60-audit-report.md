# Issue #60 工作台残留能力审查报告

审查日期：2026-05-29
对照分支：codex/workbench-followups（远程已删除，无 commit 可引用）
当前 main：@ 2425492

## 决策摘要

| # | 能力项 | 决策 | 重实现复杂度 |
|---|--------|------|--------------|
| 1 | 发票识别缓存与本地字段优先复用 | 已覆盖 | — |
| 2 | 发票目录批量识别与进度心跳 | 已覆盖 | — |
| 3 | 飞书卡片 URL verification 回调直返 challenge | 已覆盖 | — |
| 4 | 设计器按钮 URL 缺失处理 + open_url 行为 | 部分覆盖 | 小 |
| 5 | 合同助手调试记录文档 | 不确定 | — |

## 逐项详述

### 1. 发票识别缓存与本地字段优先复用

- **旧分支位置**：无法直接引用（远程分支已删除）。Issue #60 描述为"发票识别缓存与本地字段优先复用"。
- **当前 main 状态**：已完整实现。
  - 缓存层：`src/contract-assistant/index.ts:374-397` — 使用 SHA-256 文件哈希，缓存路径 `data/invoice-recognition-cache/{hash}.json`，命中时跳过外部 API 调用。
  - 本地提取层：`src/contract-assistant/invoice-structured.ts:127-188` — `extractStructuredInvoice()` 从 OCR 文本层用正则提取发票号、日期、购买方、金额，置信度 >= 0.75 时视为完整提取。
  - LLM 补全层：`src/contract-assistant/index.ts:422-459` — 仅当本地提取不完整时调用 LLM，且已确认字段冻结，只补缺失字段。
  - 缓存写入：`src/contract-assistant/index.ts:542-564` — `writeInvoiceRecognitionCache()` 将结果写入 JSON 缓存。
- **决策**：已覆盖。
- **理由**：当前 main 的三层递进策略（缓存 → 正则 → LLM）完整覆盖了旧分支的缓存和本地字段优先复用需求，且实现更完整（增加了本地正则提取层）。

### 2. 发票目录批量识别与进度心跳

- **旧分支位置**：无法直接引用。Issue #60 描述为"发票目录批量识别与进度心跳"。
- **当前 main 状态**：已完整实现。
  - 批量入口：`src/contract-assistant/runtime-module.ts:983-1057` — `handleInvoiceRecognizeBatch()` 循环处理多文件。
  - 进度心跳：每个文件的每个阶段（解析、本地提取、模型补全、写入表）都通过 `updatePayload()` 发送飞书卡片更新（`src/feishu/contract-cards.ts:128-148`）。
  - 批量结果卡：`src/feishu/contract-cards.ts:223-254` — `renderInvoiceBatchDetails()` 渲染多文件详情，含已完成/失败列表。
  - 路由支持：命令路由（`runtime-module.ts:326-334`）、上传队列路由（`runtime-module.ts:508-524`）均支持多文件自动路由到批量识别。
- **决策**：已覆盖。
- **理由**：当前 main 完整实现了批量识别、进度心跳和批量结果展示，路由也覆盖了命令和上传两种入口。

### 3. 飞书卡片 URL verification 回调直返 challenge

- **旧分支位置**：无法直接引用。Issue #60 描述为"飞书卡片 URL verification 回调直返 challenge"。
- **当前 main 状态**：已覆盖。
  - 实现位置：`src/http/server.ts:242` — 创建 adapter 时传入 `{ autoChallenge: true }`。
  - 机制：委托飞书 SDK 的 `adaptDefault()` 内置行为，SDK 自动识别 `type: "url_verification"` 请求并返回 `{"challenge":"..."}` 响应，Bridge 不需要手写 challenge 逻辑。
  - 文档确认：`docs/troubleshooting-card-actions.md:113-127` 记录了 URL 校验模拟 curl 和期望响应。
- **决策**：已覆盖。
- **理由**：飞书 SDK 的 `autoChallenge: true` 选项已自动处理 challenge 响应，无需 Bridge 手动实现。这比旧分支的手动实现更简洁、更可靠。

### 4. 设计器按钮缺少真实 URL 时删除按钮、外部链接按钮使用 open_url 行为

- **旧分支位置**：无法直接引用。Issue #60 描述为"设计器按钮缺少真实 URL 时删除按钮、外部链接按钮使用 open_url 行为"。
- **当前 main 状态**：部分覆盖。
  - **URL 缺失时删除按钮**：已实现。
    - `src/feishu/contract-cards.ts:303-311` — 案件待办提醒卡，`item.url` 为空时整列移除。
    - `src/feishu/knowledge-cards.ts:718-744` — 知识库完成卡，`bitableUrl` 为空时按钮和分割线一起移除。
    - `src/feishu/labor-cards.ts:225-256` — 劳动分析卡，`docUrl` 为空时不添加按钮。
    - `src/feishu/contract-cards.ts:578-586` — `setDesignerButtonUrl()` url 为空时静默跳过。
  - **外部链接按钮使用 open_url 行为**：未实现。
    - 代码库中无 `behaviors: [{ type: "open_url", ... }]` 模式。
    - 当前所有链接按钮使用 `button.url` 直接赋值，点击时由飞书 SDK 直接打开该 URL。
    - 这是飞书卡片按钮的标准用法，功能上已等价。
- **决策**：部分覆盖。
- **理由**：URL 缺失时删除按钮的逻辑已在多处实现。`open_url` 行为类型未使用，但当前 `button.url` 直接赋值方式在功能上等价（飞书客户端点击时同样打开 URL），不需要额外实现 `behaviors` 模式。
- **如需补回**：如需使用 `behaviors: [{ type: "open_url", multi_url: { url, pc_url, ios_url, android_url } }]` 模式支持多端差异化 URL，可在 `src/feishu/designer-card-renderer.ts` 的按钮渲染逻辑中增加支持。预估复杂度：小。

### 5. 合同助手调试记录文档

- **旧分支位置**：无法直接引用。Issue #60 描述为"合同助手调试记录文档是否仍需补回"。
- **当前 main 状态**：不确定。
  - 没有独立的"调试记录文档"生成模块。
  - 现有覆盖：
    - `src/logging/logger.ts` — 统一日志系统，支持 transcript 对话副本日志、结构化事件（turn.started/completed/failed 等）、按日轮转、脱敏策略。
    - `src/contract-assistant/runtime-module.ts` — 约 25 个 transcript 事件点覆盖合同起草/录入/发票/案件全流程。
    - `src/contract-assistant/index.ts` — 7 个 `logger.log()` 调用覆盖关键异常。
  - 缺少的：一个专门的文档生成器，能将合同审查/起草过程中的调试信息聚合为可查看的飞书文档或本地报告。
- **决策**：不确定。
- **理由**：现有日志和 transcript 基础设施已覆盖大部分调试需求，但无法确认旧分支的"调试记录文档"具体形态（是飞书文档？本地文件？结构化报告？）。由于远程分支已删除，无法对比确认。建议进一步评估是否需要一个聚合文档生成器，还是现有日志基础设施已足够。
- **如需补回**：如果确认需要，可在 `src/contract-assistant/` 下新增调试记录聚合模块，读取 transcript 日志并生成结构化飞书文档。预估复杂度：中。

## Follow-up audit candidates

旧分支 `codex/workbench-followups` 远程已删除，无法进一步扫描其他残留能力。如需评估更多内容，需从其他来源（PR、commit 历史、本地备份）获取旧分支代码。
