# Slice: Agent Visibility · Slice 2 · Window State

依据:[`docs/adr/0005-bridge-agent-visibility-boundary.md`](../../adr/0005-bridge-agent-visibility-boundary.md)。
**前置**:Slice 1 必须验收通过(MCP 形态 + skill 模板都已经跑通)。

## 目标

让 agent 能查到"我当前在哪个窗口?这个窗口绑定哪个 OpenCode session?有几个候选 session?"等实时状态。新增 `Bridge_window_state` MCP + `bridge-sessions` skill。

本 slice 是 Slice 1 模板的复用 — 形态不变,只换数据源。

## 范围

### 包含

- `src/mcp/tools/window-state.ts`:`Bridge_window_state` 工具
  - 输入:`window_key?: string`(默认:从环境/上下文推断;暂无机制时要求显式传)
  - 输出:`{ as_of, ttl_seconds: 0, note, window_key, active_session: {id, title, last_activity_at}, bound_sessions: [...], unbound_recent: [...] }`
- 直接读 `data/session-windows.json`(或当前持久化文件,Slice 1 实现 safe-store-access 时已铺好读路径)
- 注册到 MCP server 的 tools/list
- `.opencode/skills/bridge-sessions/SKILL.md`(新建):
  - 解释 "窗口 vs 会话 vs 未绑定"(术语见 ADR 0001)
  - `as_of` 鲜度警告:用户做了 `/switch` / `/new` / `/close` / `/delete` 后旧 status 立即过期
  - agent **不能**自称切换会话,只能引导 `/switch <编号>`
- 测试:工具响应结构、`as_of` 必填、跨 window 隔离

### 不包含

- `_query` 类(session 预览不在此 slice,留 v2 评估 `Bridge_session_preview`)
- 写权限(`_switch` / `_create` / `_close` / `_delete` 永禁,见 ADR 0005)
- system prompt 修改(Slice 5)

## 验收

- "我现在在哪个 session?" → agent 调 `Bridge_window_state`,返回真实 id 和 title
- "把我切到 sched-001" / "切到第 2 个 session" → agent **不**自己切,回 "请发送 `/switch 2`"
- 多窗口下,A 窗口调用返回 A 的状态,不串台

## 未完成项清单

- `Bridge_recent_materials`(Slice 3)
- 知识库 skill(Slice 4)
- system prompt 收敛(Slice 5)
- `Bridge_session_preview`(v2 评估)
