# Slice: Agent Visibility · Slice 5 · System Prompt 收敛

依据:[`docs/adr/0005-bridge-agent-visibility-boundary.md`](../../adr/0005-bridge-agent-visibility-boundary.md)。
**前置**:Slice 1-4 全部验收通过 — 必须先确认 skill + MCP 在 agent 端真的生效,**再**从 system prompt 删旧文本,否则双失效。

## 目标

把已经迁移到 Skill / MCP 的能力说明,从 Bridge 注入的 system prompt 里删掉,只保留**核心不变量**和**跨能力级**的引导。把 prompt 体积压下来,同时消除 skill 文本和 prompt 文本的漂移源头。

## 范围

### 包含

#### 1. 审计现有 system prompt

定位 Bridge 在哪里向 OpenCode 注入 system prompt 文本(候选:`src/runtime/turn-executor.ts`、`src/runtime/app.ts`、或某 prompt builder)。逐条标注每段说明 → 现在迁到哪个 skill / MCP:

| 旧 prompt 段 | 迁移目标 | 删除? |
|---|---|---|
| 定时任务用法 | scheduler skill + `Bridge_scheduler_status` | 删 |
| 会话窗口术语 | bridge-sessions skill + `Bridge_window_state` | 删 |
| 文件上传上下文 | file-materials skill + `Bridge_recent_materials` | 删 |
| 知识库入口 | knowledge-base skill | 删 |
| 权限确认 / pending interaction | (留)— 这是 Bridge 行为契约,不该让 agent 自己读 skill | 保留 |
| 自我介绍 / 身份 | (留)| 保留 |
| 安全边界(不要伪造已执行) | 提炼为**跨能力**1-2 行 | 浓缩保留 |

#### 2. 缩减 prompt

按上表删除已迁移段,留下:

- 身份说明(1 段)
- 跨能力安全边界(1-2 行):"Bridge 拥有所有状态和副作用 — 你的任何 '已创建 / 已删除 / 已发送' 声明都是错的,除非用户自己确认。"
- pending interaction 行为契约(必须留)
- 引导 agent **查 skill / MCP** 的一行话:"你的能力清单见已加载的 skills 和 MCP tools,优先调用 `Bridge_*_status` 工具拿实时状态而不是猜。"

#### 3. 回归

- 重跑 Slice 1-4 的全部验收问题,确认从 system prompt 删掉对应说明后,**agent 仍能正确回答**(说明 skill / MCP 确实在生效)
- 若某个验收回归失败,说明对应 skill 文本不够,**不要把 prompt 恢复**,而是回去补 skill

### 不包含

- 新增任何 MCP / skill
- 修改 Bridge Core 行为
- 任何写权限工具

## 验收

- system prompt 字符数对比:迁移前后行数和 token 数都下降(具体下降比例由审计后决定,但不应有任何能力**新增**到 prompt 里)
- Slice 1-4 的全部用户级验收问题在新 prompt 下仍然通过
- 没有任何能力说明**同时存在**于 prompt 和 skill 中 — 如果发现,删 prompt 留 skill

## 未完成项清单

- v2 的 `_query` 类工具(`Bridge_kb_query` 等)
- 永禁的 `_create` / `_update` / `_delete` / `_switch` 类不在任何 slice 范围内
- 跨 agent / 跨 model 的 prompt / skill 兼容性(若未来支持非 Claude agent,可能需要新 ADR)

## 风险

- **风险:prompt 删早了,agent 没读 skill,能力退化**
  缓解:本 slice 排在 Slice 1-4 之后,且验收要求**全部回归通过**才算完成。
- **风险:不同 OpenCode 版本对 skill / MCP 的优先级处理不同**
  缓解:验收必须在 Bridge 实际使用的 OpenCode 版本上跑,记录版本号到 slice 文档。
