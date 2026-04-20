# Runtime Layering

## Summary

Bridge 运行时采用四层结构：

- `core`: Bridge 运行时内核
- `modules`: 运行时可插拔能力
- `skills`: 注入 OpenCode session 的规则片段
- `scripts`: 安装、诊断、启动类 CLI 工具

当前代码已经落地第一步基础设施：

- `ModuleManager` 负责模块注册、按优先级调度、启动停止和 turn hook 聚合
- `knowledge` 已作为第一个 runtime module 接入
- `memory` 已改为 runtime module hook，通过 `beforeTurn` / `afterTurn` 接入

## Layer Contract

### core

`core` 只保留运行机制：

- Feishu ingress / egress
- session window 与 queue
- turn 生命周期与事件流
- process / final card
- permission / question / session-select / delete-confirm
- Bridge 自有命令面

`core` 不再直接承载 knowledge 的 queue、ingest 状态和 query 路由。

### modules

`modules` 只承载业务能力：

- `knowledge`
- `memory`
- 未来可继续扩展 calendar、approval、workflow 等 runtime 能力

模块通过统一接口接入，不要求 `core` 知道具体场景细节。

### skills

`skills` 只放会注入 OpenCode prompt 的规则片段。

以下内容不属于 skill：

- 部署手册
- 排障 checklist
- 人类操作流程

这些内容继续保留在 `docs/`。

### scripts

`scripts` 是独立层：

- `onboard`
- `doctor`
- `checks`
- `start`

它们不进入 runtime handler chain。

## Runtime Flow

消息分发顺序：

1. core 预处理  
2. core 自有命令与核心交互  
3. module chain  
4. core fallback handlers

当前 fallback handlers 主要包括：

- 文件说明流
- 默认 OpenCode 对话

## Module Interface

`src/bridge/module.ts` 中的 `RuntimeModule` 约定：

- `handleMessage()`: 消费消息，返回 claim / not claim
- `beforeTurn()`: 在 turn 开始前补充 system blocks
- `afterTurn()`: 在 turn 完成后执行收尾逻辑
- `start()` / `stop()`: 模块生命周期

默认只保留两态：

- `{ claimed: true }`
- `{ claimed: false }`

不引入 `continue` 语义。

## Current Mapping

### knowledge module

`src/knowledge/runtime-module.ts` 当前负责：

- ingest interaction
- ingest queue / session stats
- active ingest persistence / restart recovery
- knowledge query
- knowledge mode
- auto-detect query
- knowledge commands

### memory module

`src/memory/runtime-module.ts` 当前负责：

- `beforeTurn`: recall block
- `afterTurn`: enqueue learn
- `start` / `stop`: service lifecycle

## Next Refactor

### 阶段一

- 继续压缩 `app.ts`
- 把更多 knowledge 相关 helper 从 core 挪到 module 专属文件

### 阶段二

- 继续清理 core 中对具体 module 的残留认知
- 保持默认 OpenCode handler 仅作为兜底

### 阶段三

- 整理 `skills` 与 `docs` 的边界
- 把 prompt 规则收敛到 skill 目录
