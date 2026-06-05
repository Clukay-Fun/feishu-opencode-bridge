# ADR 0005: Bridge Agent Visibility Boundary

- 状态:Accepted (2026-06-05)
- 关联:[`0001-window-session-vocabulary.md`](./0001-window-session-vocabulary.md)、[`0004-bridge-scheduler-architecture.md`](./0004-bridge-scheduler-architecture.md)
- 取代:无

## 背景

OpenCode/Claude agent 在 Bridge 之上运行时,频繁出现两类失败模式:

1. **否认能力** — agent 不知道 Bridge 提供了定时、知识库、文件上下文等能力,被问到时回 "我没有这个工具"。
2. **伪造副作用** — agent 自称 "已创建任务"、"已写入表格",但 Bridge 根本没收到指令。

把所有能力说明塞进 system prompt 既会膨胀,也会和 Skill 文本漂移,且无法表达**实时状态**(当前有几个任务、当前窗口绑定哪个 session)。

需要一个稳定的三层切分,让 agent **看见**能力但**不越权**执行。

## 决策

三层职责严格分离:

```
Skill        = 稳定行为准则      "该怎么想"
MCP          = 实时状态/只读查询  "现在是什么"
Bridge Core  = 状态变更/副作用    "真的去做"
```

### 不变量(违反需先升级 ADR,不能 PR 级决定)

1. **Bridge 是状态和副作用的唯一持有者**。MCP/Skill 永远不能直接修改持久化状态、发送飞书消息、写飞书 Base、切换会话、创建/删除定时任务、abort turn、改 pending interaction。
2. **MCP 永远只读**。允许有 IO 副作用(消耗 token、查 embedding、读 DB),但禁止任何持久化写入或外部世界变更。
3. **Skill 永远是 evergreen 行为准则,不替代命令面**。Skill 不写"当前有 N 个任务"这类实时事实,只写"用户问定时时怎么回应"。
4. **MCP/Skill 不重复彼此**。Skill 静态说明绝不进 MCP `_help` 工具;MCP 实时状态绝不进 Skill 文本。

### 命名约定

| 工具后缀 | 语义 | 副作用 | 调用约束 |
|---|---|---|---|
| `_status` | 实时只读状态,零外部 IO | 无 | 任意调用 |
| `_query` | 只读但有 IO(embedding、DB、HTTP) | IO,可能消耗资源 | 单轮 ≤2 次,结果必须引用来源 |
| `_help`(暂停使用) | 静态说明 | 无 | **v1 不做** — 跟 Skill 重叠会漂 |

不允许写权限工具(`_create` / `_update` / `_delete` / `_send` / `_switch` 等)。

### 鲜度契约

凡是状态可能在两次调用之间变化的 `_status` 工具,响应**必须**包含:

```json
{
  "as_of": "2026-06-05T12:30:00+08:00",
  "ttl_seconds": 0,
  "note": "Snapshot. Call again after <trigger list>."
}
```

Skill 同时要求 agent **不要把旧 status 当长期事实**。

## 决策树(每加新能力前必过)

```
新能力 X 应该归到哪?

1. X 会改外部世界 / 持久化状态吗?
   ├─ 是 → Bridge Core,不暴露执行入口,只能写 Skill 教 agent 引导用户走命令
   └─ 否 → 进入第 2 问

2. X 依赖实时状态吗?
   ├─ 是 → MCP `_status` 或 `_query`(看是否有 IO)
   └─ 否(纯行为准则)→ Skill

3. Skill 和 MCP 都需要吗?
   ├─ 是 → 两边都做,但 Skill 只写"该怎么想",MCP 只返"现在是什么",**绝不重叠静态文本**
   └─ 否 → 单边
```

## v1 范围(Slice 0-1)

最小验证:scheduler 一条链路打通,证明 MCP 形态可行。

- ADR 0005(本文档)
- `bridge mcp` CLI(stdio MCP server,OpenCode 配置启动)
- `Bridge_scheduler_status` 工具
- `scheduler` skill 重写

### 后续路线图(防止遗忘)

| Slice | 内容 | 关联组件 |
|---|---|---|
| 2 | `bridge-sessions` skill + `Bridge_window_state` MCP | `src/runtime/session-windows.ts` |
| 3 | `file-materials` skill + `Bridge_recent_materials` MCP | `src/runtime/message-context.ts`、文件 workspace |
| 4 | `knowledge-base` skill(MCP query 缓做) | `src/knowledge/` |
| 5 | system prompt 收敛 — 把已迁移到 skill/MCP 的静态说明从 system prompt 删掉 | bridge 注入 prompt 处 |
| (v2) | `Bridge_kb_query` / `Bridge_case_query` / `Bridge_material_query` 这类 `_query` 工具 | 待 v1 跑通后评估 |
| (永禁) | 任何 `_create` / `_update` / `_delete` / `_switch` / `_send` 工具 | 见不变量 |

## MCP server 形态(实现约束)

- **形态**:stdio MCP 子进程,由 OpenCode 配置启动(`command: "bridge"`, `args: ["mcp"]`)。Bridge 主进程**不** spawn 它,也不管理其生命周期。
- **状态访问**:子进程复用 Bridge 代码 + 同一份 `config.json` + 同一个 `dataDir`,直接读取磁盘上的持久化文件(`data/schedules/jobs.json`、`data/session-windows.json` 等)。
- **不允许写**:即便共用 dataDir,MCP 进程在代码层禁用所有 store 的 write API。这条由 lint/类型/运行时三重保证(具体见 Slice 1)。
- **与主进程的 race**:主进程在写、MCP 在读 → 只读快照,容忍弱一致(agent 总能在下一次调用拿到新值)。

## 不做的事

- 不做 HTTP MCP server(端口管理 / 鉴权太重,价值低)
- 不做 in-process MCP fork(Bridge crash 拖死 MCP,且 OpenCode 期望自己管 spawn)
- 不做 `_help` 静态说明工具(会和 Skill 漂)
- 不做任何写权限工具(见不变量)
- v1 不做 `_query` 类(等 `_status` 跑通形态再扩)
