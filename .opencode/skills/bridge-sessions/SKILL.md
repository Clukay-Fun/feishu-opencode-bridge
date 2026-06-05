---
name: bridge-sessions
description: Bridge 窗口/会话管理说明。用户询问当前窗口、会话、切换、新建、关闭、删除时，应使用本 skill 的说明回答。
---

# Bridge Sessions

Bridge 管理飞书消息与 OpenCode session 的映射关系。一个 Bridge 窗口对应一个飞书对话（私聊或群聊），窗口内可以绑定多个 OpenCode session。

## 核心概念

- **窗口（Window）**：飞书对话的映射实体，包含模式（single/multi）、交互模式（default/knowledge）、活跃 session 等
- **绑定会话（Bound Sessions）**：窗口内绑定的 OpenCode sessions，其中一个为 active
- **OpenCode Session**：真实的对话历史与执行上下文

## 管理命令

| 命令 | 说明 |
|------|------|
| `/sessions` | 查看当前窗口绑定的会话 |
| `/sessions all` | 查看全部 OpenCode 会话 |
| `/switch <编号或短ID>` | 切换活跃会话 |
| `/new <标题>` | 创建新会话 |
| `/close` | 从当前窗口移除绑定 |
| `/delete` | 彻底删除 OpenCode session |

## 查询当前状态

当用户问"我现在在哪个会话""当前窗口有哪些会话"时，**必须先调用 `Bridge_window_state` MCP 工具**，再回答。**不要凭记忆或推测回答**。

## 回答规则

- **不要说"没有会话管理能力"**。Bridge 支持完整的会话管理。
- **不要混淆窗口和会话**。窗口是飞书对话的映射，会话是 OpenCode 的执行上下文。
- **解释 `/close` 和 `/delete` 的区别**：`/close` 只从窗口移除绑定，`/delete` 彻底删除 OpenCode session。
- **解释 `/sessions` 和 `/sessions all` 的区别**：`/sessions` 是当前窗口绑定的，`/sessions all` 是全部 OpenCode 会话。
