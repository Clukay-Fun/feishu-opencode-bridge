# Slice: Agent Visibility · Slice 0 · ADR + 路线图

依据:[`docs/adr/0005-bridge-agent-visibility-boundary.md`](../../adr/0005-bridge-agent-visibility-boundary.md)。

## 目标

把 Skill/MCP/Bridge Core 的三层职责 + 决策树 + 不变量先以 ADR 形式落地,把后续 5 个 slice 的占位 plan 写好,**防止做完 Slice 1 后忘记最初想法**。本 slice **零代码改动**,只产出文档。

## 范围

### 包含

- `docs/adr/0005-bridge-agent-visibility-boundary.md`(已随本 slice 写入)
- `docs/backlog/active/slice-visibility-0-adr.md`(本文)
- `docs/backlog/active/slice-visibility-1-scheduler.md`(可执行)
- `docs/backlog/active/slice-visibility-2-window.md`(占位但范围完整)
- `docs/backlog/active/slice-visibility-3-materials.md`(占位)
- `docs/backlog/active/slice-visibility-4-kb-skill.md`(占位)
- `docs/backlog/active/slice-visibility-5-prompt-shrink.md`(占位)

### 不包含

- 任何代码改动
- 任何 skill 文本修改(放 Slice 1+)
- 任何 MCP 实现(放 Slice 1)

## 验收

- 团队成员只看 ADR 0005 就能回答:
  - "这个新能力应该放 Skill / MCP / Core 哪一层?" → 决策树有答案
  - "MCP 工具能不能加个 `_create`?" → 不变量明确禁止
  - "Skill 里能不能写当前任务数?" → 不变量明确禁止
- v1 路线图(Slice 1-5)在 ADR 0005 "后续路线图"表格里能查到。
- Slice 0-5 plan 文件都存在,任意一个 slice 启动时不需要回到 ADR 也能读懂自身范围。

## 未完成项清单

本 slice 完成时,以下事项**还没做**,留给后续 slice:

- `bridge mcp` CLI 入口(Slice 1)
- `Bridge_scheduler_status` 工具(Slice 1)
- `scheduler` skill 重写(Slice 1)
- 其他三个 MCP 工具 + 三个 skill(Slice 2-4)
- system prompt 收敛(Slice 5)
- `_query` 类工具的实现规范(v2)
