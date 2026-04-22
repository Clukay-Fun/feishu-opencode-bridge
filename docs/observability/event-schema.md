# 可观测性事件规范

> 最后更新：2026-04-19
>
> 这份文档定义了 bridge 运行时第一版稳定事件词表。
> 它刻意采用“文档先行”的方式：代码应逐步收敛到这些事件名，而不是在各调用点继续自由发明日志文本。

## 目标

让一次 bridge turn 从 ingress 到最终回包都能被完整追踪，并且事件名稳定、字段可预期。

运行时已经有共享 logger。下一阶段的可观测性工作，应在不整体替换 logger 的前提下，补齐 request context 传播、JSON line 输出和事件 helper。

## 通用包络

每条结构化 bridge 事件都应使用下面这组基础字段：

- `ts`：logger 输出的 ISO 时间戳
- `level`：`debug`、`info`、`warn` 或 `error`
- `scope`：稳定的 logger scope，例如 `bridge/queue` 或 `feishu/reply`
- `event`：本文定义的事件名之一
- `msg`：用于本地调试的简短可读消息
- `correlationId`：同一条 Feishu 入站事件及其后续工作共享的关联 id
- `turnId`：存在 turn 时的 bridge turn id
- `sessionId`：存在时的 OpenCode session id
- `chatId`：存在时的 Feishu chat id
- `userId`：存在时的 Feishu sender id
- `messageId`：存在时的 Feishu message id

字段规则：

- 允许补充事件专属字段，但字段名必须稳定。
- 默认不应记录原始用户消息内容。
- 消息预览应遵循配置中的 message logging policy。
- transcript 文件与结构化 bridge 事件应保持分离。

## 事件名

### `turn.started`

在排队中的 turn 开始执行时发出。

必填字段：

- `turnId`
- `sessionId`
- `chatId`
- `conversationKey`

触发点：

- `TurnExecutor` 进入 active execution 之后。

### `turn.completed`

在 turn 成功完成时发出。

必填字段：

- `turnId`
- `sessionId`
- `durationMs`

可选字段：

- `replyLength`
- `processMessageId`
- `finalMessageId`

触发点：

- `TurnExecutor` 完成最终回复发送和清理之后。

### `turn.failed`

在 turn 未正常完成、提前失败时发出。

必填字段：

- `turnId`
- `chatId`
- `conversationKey`
- `errorKind`
- `detail`

可选字段：

- `sessionId`
- `durationMs`

触发点：

- `TurnExecutor` 包裹 turn 执行的 catch 路径。

### `turn.fallback_triggered`

在 bridge 退化到某种 fallback 行为时发出。

必填字段：

- `turnId`
- `fallbackKind`
- `reason`

可选字段：

- `sessionId`
- `chatId`

触发点：

- 运行时 fallback 分支，例如 degraded reply 或 process-card fallback。

### `permission.asked`

在 bridge 向用户发出运行时权限请求时发出。

必填字段：

- `turnId`
- `permissionId`
- `permissionKind`
- `chatId`

可选字段：

- `sessionId`
- `toolName`

触发点：

- `PermissionManager` 发送权限卡片之后。

### `permission.decided`

在权限请求被用户或超时路径决策后发出。

必填字段：

- `turnId`
- `permissionId`
- `decision`
- `decisionSource`

可选字段：

- `sessionId`
- `chatId`
- `durationMs`

允许值：

- `decision`：`approved`、`denied`
- `decisionSource`：`user`、`timeout`、`system`

触发点：

- `PermissionManager` 的卡片 action 路径与 auto-deny 路径。

### `module.invoked`

在某个 runtime module 认领或处理消息 / hook 时发出。

必填字段：

- `moduleId`
- `hook`
- `result`

可选字段：

- `turnId`
- `chatId`
- `conversationKey`
- `durationMs`

允许值：

- `hook`：`handleMessage`、`beforeTurn`、`afterTurn`、`stop`
- `result`：`claimed`、`ignored`、`completed`

触发点：

- `RuntimeModuleManager` 包裹 module hook 分发时。

### `module.failed`

在 runtime module hook 抛错或返回非法结果时发出。

必填字段：

- `moduleId`
- `hook`
- `errorKind`
- `detail`

可选字段：

- `turnId`
- `chatId`
- `conversationKey`

触发点：

- `RuntimeModuleManager` 包裹 module hook 分发时的错误处理路径。

### `transport.sent`

在 Feishu transport 成功发送或更新一条 bridge-owned 消息时发出。

必填字段：

- `chatId`
- `messageId`
- `transportAction`
- `payloadKind`

可选字段：

- `turnId`
- `textPreview`
- `len`

允许值：

- `transportAction`：`send`、`update`、`reply`、`thread_reply`
- `payloadKind`：`card`、`post`、`text`、`markdown`

触发点：

- Feishu transport 和 turn card manager 的发送 / 更新成功路径。

### `transport.failed`

在 Feishu transport 发送或更新 bridge-owned 消息失败时发出。

必填字段：

- `transportAction`
- `payloadKind`
- `errorKind`
- `detail`

可选字段：

- `turnId`
- `chatId`
- `messageId`

触发点：

- Feishu transport 和 turn card manager 的发送 / 更新失败路径。

## 隐私策略

结构化日志默认应记录运行元数据，而不是内容本身。

默认脱敏清单：

- `feishu.appSecret`
- `opencode.apiKey`
- 原始入站用户消息内容
- 原始 OpenCode 回复内容
- 文件内容和附件内容

建议的 message policy：

- `none`：不记录消息内容或预览
- `hash`：只记录稳定哈希
- `preview`：记录简短、归一化后的预览
- `full`：仅在本地诊断时记录完整内容

生产环境默认策略应为 `preview` 或更严格。

## 迁移顺序

1. 先补 request context 传播，让 `correlationId` 和 `turnId` 自动注入。
2. 再补 JSON line 输出，同时保留可配置的本地 pretty 输出。
3. 再补 `logger.event(event, fields)`，统一使用本文事件名。
4. 最后按 seam 分组逐步迁移代码。

初始 seam 分组：

- ingress：`src/feishu/ws.ts`、`src/http/server.ts`
- turn runtime：`src/runtime/turn-executor.ts`
- permissions：`src/runtime/permission-manager.ts`
- modules：`src/runtime/runtime-modules.ts`
- transport：`src/runtime/feishu-transport.ts`、`src/runtime/turn-card-manager.ts`
