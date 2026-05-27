# ADR 0001：窗口 / 会话 / 上下文术语与分层

- **状态**：已接受（2026-05-27）
- **关联**：强制执行的活规则同步维护在 [architecture-baseline.md](../architecture-baseline.md) 的「Core Runtime → Window 与 Session 术语」节。本 ADR 是决策记录与背景；若两者冲突，以架构基线为准。

## 背景

`conversationKey` / `SessionWindowRecord` / `sessions` / `message-context` 等命名把「飞书表面、话题、Bridge 窗口、OpenCode 会话、回复上下文、长期记忆」挤在同一组词里。当前能跑，但在动 `/sessions`、话题继承、长期记忆、项目工作区之前，每一步都会继续把这些概念揉在一起，并诱导后人把「话题等同 session」「窗口等同 session」。

因此先固定**产品/运行时词汇与分层**，再做内部类型迁移，最后才动用户可见文案。

## 决策

### 1. 宪法级不变量

> **Bridge 不拥有对话历史。它拥有窗口状态和绑定关系。OpenCode session 才拥有真实会话内容。**

直接推论：**`conversationKey` 不是 session key，它只是 window key 的输入或结果。**

### 2. 分层：两个实体 + 派生输入 + 外部环境

刻意只设两个持久化实体（Window、OpenCode Session），其余是 identity 输入或外部环境，不新建多余 record：

```text
[identity 输入]
  Surface identity   chatId / chatType
  Topic identity     threadKey / rootId / parentId（派生用，不落盘）
        │  派生函数：surface + topic → windowKey
        ▼
[实体 1] Bridge Window         窗口级状态 + 绑定关系（一条记录）
        │  binds N OpenCode sessions，其中 0/1 个 active
        ▼
[实体 2] OpenCode Session      真实对话历史与执行上下文
        ├─ uses → Workspace/Project（当前为单例，见决策 6）
        └─ reads → Memory（跨窗口/跨会话的外部环境）
```

- **Topic 是派生输入，不是实体**：无自有状态，只参与 `windowKey` 派生与 anchor 认领。
- **Window 与 Binding 是同一条记录**：Binding 是 Window 的字段维度，不是平级层。
- **Reply Context 是临时补充，不是实体**：为理解当前回复链临时拼的短上下文，用完即弃，不等同会话历史。

### 3. 术语定义

| 术语 | 定义 |
|---|---|
| **Bridge Window** | 飞书交互表面上的一个运行时窗口；维护窗口状态与 OpenCode session 绑定；**不保存长期聊天历史**。 |
| **Bound Sessions** | 窗口当前绑定的 OpenCode sessions，其中一个为 active。 |
| **OpenCode Session** | OpenCode 侧真实的对话历史与执行上下文。 |
| **Topic identity** | 飞书话题/回复链语义，决定窗口派生、上下文补齐、anchor 认领。 |
| **Reply Context** | 为理解当前回复链临时补充的短上下文，非持久会话历史。 |
| **Workspace / Project** | 代码目录、配置、运行环境、知识库范围，是 session 的外部环境。 |
| **Memory** | 跨窗口、跨 session 的长期用户/项目事实，是 session 的外部环境。 |

用户侧只收束成三个词：**窗口**（你所在的飞书聊天/话题空间）、**会话**（窗口里在用的 OpenCode 对话）、**上下文**（为当前回复临时补的信息）。

### 4. 关系基数

- 1 Bridge Window — N OpenCode Session（恰好 0/1 个 active）
- 1 OpenCode Session — 1 Workspace（当前单例）
- OpenCode Session — N Memory（只读引用）
- (Surface identity + Topic identity) → 1 windowKey（纯函数派生）

### 5. 命名迁移映射

| 当前 | 概念目标名 | 备注 |
|---|---|---|
| `conversationKey` | `windowKey` | 最高优先；跨边界 DTO 处才用 `bridgeWindowKey` |
| `SessionWindowRecord` | `BridgeWindowRecord` | 存的是窗口状态 |
| `sessions[]` | `boundSessions[]` | 窗口绑定的 OpenCode sessions |
| `activeSessionId` | **不改** | 类型名 `BridgeWindowRecord` 已消歧；仅裸字符串/跨边界 DTO 用 `activeOpenCodeSessionId` |
| `message-context` | `replyContext` / `shortContext` | 短期回复链上下文 |
| `/close`（用户命令） | 内部 handler 用 `unbind` 语义 | 命令名保留；**用户文案改为「从当前窗口移除」**，不再说「删除会话」 |
| `/delete`（用户命令） | 内部 handler 用 `deleteOpenCodeSession` | 命令名保留；表示彻底删除真实 OpenCode session |
| `/sessions`（用户命令） | 保留 | 文档解释为「当前窗口绑定的 OpenCode 会话」 |

**命名原则**：让类型名承担消歧，字段名保持短；只在跨边界（对 Feishu / 对 OpenCode 的 DTO）和裸字符串语境用全限定名，避免每字段挂前缀造成 diff 噪声。

### 6. 现状 vs 未来

- **Workspace 当前是单例**（`opencode.directory` 全局一个）。多 workspace / per-project / per-worktree 是 backlog，不在本 ADR 落地，未来另开 ADR。现在不要把 Workspace 建成 session 的一等关联字段。
- Memory 已与 session 解耦（`config.memory` 独立），保持其「外部环境」定位。

### 7. 迁移政策（护栏）

- 命名迁移默认只动内存语义、类型名、变量名、文档，**不动盘上格式**。
- 不在命名 PR 里改 `mappings.json` wire shape、store version、`message-context.json` 文件名或已落盘字段。
- 若未来要把 `sessions` 持久化字段改成 `boundSessions`，必须单独提供 migration 或 loader compatibility shim，并补迁移测试 + 架构 review。
- **不做 big-bang 全仓 rename PR**；按文件被自然触达时增量迁移，每次引用本 ADR。

### 8. 已占用词（禁止复用）

- `profile` 已被**发行形态**（`config.profile` = general/legal）和**人格**（`persona.profile` = xiaojing）占用。新的 window/session/context/memory/workspace 概念不得再叫 `profile`。
- 未来的**用户画像**也不要叫 `profile`，建议命名为 `userMemory` / `userPersonaMemory` / `workMemory`，归入 Memory 外部环境，而非 session 或 profile 语义。
- `session` 在用户语境固定指 OpenCode 会话，禁止再用它指代 Bridge 窗口。

## 备选方案与权衡

- **`activeSessionId → activeOpenCodeSessionId`（否决）**：更精确，但扩大 diff、且持久化结构易牵出兼容问题。改用「类型名消歧 + 字段名保持短」。
- **把 Topic / Binding / Workspace 都建成一等实体（否决）**：层数更多但当前无对应状态/能力，违反「不为不存在的能力提前建层」。Topic/Binding 降为派生/字段，Workspace 降为外部环境单例。

## 落地顺序

1. 本 ADR + 架构基线术语节（已完成）。
2. 内部类型/变量增量迁移，遵守决策 7 护栏。
3. 最后改用户可见文案（`/sessions` 展示、`/close` 改「从当前窗口移除」、`/sessions all` 的「已隐藏」措辞）。
