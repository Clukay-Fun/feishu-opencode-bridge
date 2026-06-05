# Slice: Agent Visibility · Slice 1 · Scheduler 一刀

依据:[`docs/adr/0005-bridge-agent-visibility-boundary.md`](../../adr/0005-bridge-agent-visibility-boundary.md)。

## 目标

打通 **MCP stdio 形态** + **Skill 行为准则**这一条链路,以 scheduler 为最小验证场景。本 slice 完成后,OpenCode agent 在被问到 "你能定时吗" / "刚才那个任务跑了没" 时,既能给出正确说明(skill),也能查到实时状态(MCP),且**不会伪造**任何创建/删除。

这是后续所有 visibility slice 的形态模板 — 本 slice 跑通后,Slice 2-4 就是按这个模板复制。

## 范围

### 包含

#### 1. `bridge mcp` CLI 入口

- 新增 `src/mcp/` 目录
- `src/mcp/server.ts`:基于 `@modelcontextprotocol/sdk` 起一个 stdio MCP server
- `src/mcp/tools/scheduler-status.ts`:`Bridge_scheduler_status` 工具实现
- `src/mcp/safe-store-access.ts`:**只读** wrapper,从 dataDir 直接 load `data/schedules/jobs.json` + `data/schedules/jobs-state.json` + `data/schedules/runs/<jobId>.jsonl`。**禁止 import 任何带 write 方法的 store**(用类型/lint 双重把关:文件顶部 ESLint disable 注释 + tsconfig 路径限制)
- `bin/cli.mjs` 增加 `mcp` 子命令分支:`bridge mcp` → 调用 `src/mcp/server.ts` 入口
- 在 stdio 模式下,所有日志走 `stderr`,不污染 stdio JSON-RPC

#### 2. `Bridge_scheduler_status` 工具

输入 schema(JSON Schema):

```json
{
  "type": "object",
  "properties": {
    "include_recent_runs": { "type": "boolean", "default": false },
    "creator_user_id": { "type": "string", "description": "可选,只过滤某个 user 的任务" }
  }
}
```

输出:

```json
{
  "as_of": "ISO timestamp",
  "ttl_seconds": 0,
  "note": "Snapshot. Call again after /cron add/pause/resume/delete or after task run.",
  "enabled": true,
  "total_jobs": 3,
  "visible_jobs": [
    {
      "short_id": "sched-001",
      "title": "每天9点生成简报",
      "expression": "0 9 * * *",
      "kind": "cron",
      "state": "enabled|paused|disabled",
      "next_run_at": "ISO timestamp",
      "last_run": { "at": "...", "status": "success|failed|skipped", "reason": "..." }
    }
  ],
  "recent_failures": [ /* 当 include_recent_runs=true 时填 */ ],
  "management_commands": [
    "/cron list", "/cron show <id>", "/cron pause <id>", "/cron resume <id>", "/cron delete <id>"
  ]
}
```

#### 3. `scheduler` skill 重写

更新 `.opencode/skills/scheduler/SKILL.md`,**严格不含**实时事实(任务数、cron 列表等)。内容应明确包含:

- 用户提定时请求时,**不要让用户写 cron**,直接说"发送 自然语言描述 即可,Bridge 会弹确认卡"
- **不要伪造**"已创建"/"已删除"
- 如果用户问当前状态(几个任务、跑没跑),先调用 `Bridge_scheduler_status` 再回答,**不要凭记忆**
- Bridge 通常会拦截自然语言定时请求于 OpenCode 之前;若没拦截,提醒用户重发或查 `/cron help`
- 当前状态总是 snapshot — 用户做了任何 `/cron` 操作后,旧 status 立即过期

#### 4. OpenCode 配置示例 + 文档

在 `docs/commands.md` 或新建 `docs/agent-mcp.md` 添加:

```jsonc
// OpenCode 配置示例
{
  "mcpServers": {
    "bridge": {
      "command": "bridge",
      "args": ["mcp"]
    }
  }
}
```

并说明:Bridge 主进程**不**启动 MCP server,由 OpenCode 按需 spawn。

#### 5. 测试

- `src/mcp/safe-store-access.test.ts`:验证只能读、试图调 write API 时类型不通过(或运行时 throw)
- `src/mcp/tools/scheduler-status.test.ts`:
  - 空任务列表返回结构正确
  - 多任务返回包含 next_run_at / last_run
  - `include_recent_runs=true` 时填 recent_failures
  - 输出**必须**含 `as_of` 和 `note`(契约测试)
- `bin/cli.mjs` 增加 `mcp` 子命令的烟测:`bridge mcp` 启动后能响应 `initialize` JSON-RPC

### 不包含

- 其他三个 MCP 工具(Slice 2-4)
- 其他 skill 文本(Slice 2-4)
- system prompt 收敛(Slice 5)
- `_query` 类工具
- 任何写权限工具
- Bridge 主进程主动 spawn MCP — **永远不做**

## 验收(用户级)

让 OpenCode 接上 MCP 配置后,以下三个问题必须**全部满足**:

1. **"你有定时能力吗?"**
   → agent 回答 "支持,可以用自然语言创建,Bridge 会弹确认卡",**不否认**。
2. **"我现在有几个定时任务?最近有失败的吗?"**
   → agent **调用 `Bridge_scheduler_status` 工具**,返回真实数字。若 agent 凭空说"你有 5 个任务",验收失败。
3. **"帮我建个每天 9 点的提醒。"**
   → agent **不**回 "请使用 `/cron add 0 9 * * * ...`",而是回 "直接发送 '每天上午9点提醒我...' 即可,Bridge 会弹确认卡"。同时**不**伪造 "已创建"。

## 验收(技术级)

- `npm run typecheck` + `npm test` 通过
- `bridge mcp` 启动后能响应 MCP `initialize` / `tools/list` / `tools/call`
- `Bridge_scheduler_status` 响应包含 `as_of` + `note`(契约测试)
- safe-store-access 的所有调用对 jobs.json 只持有 read fd,无 write 路径

## 未完成项清单

本 slice 完成时,以下事项**还没做**,留给后续 slice:

- `Bridge_window_state`(Slice 2)
- `Bridge_recent_materials`(Slice 3)
- `bridge-sessions` / `file-materials` / `knowledge-base` skill(Slice 2-4)
- system prompt 把 scheduler 相关静态说明删掉(Slice 5 — 本 slice 只新增 skill,**不**删除 system prompt 旧文本,等 Slice 5 统一处理避免双失效)
- 任何 `_query` 类工具(v2)
- MCP server 的进程级遥测(若需要,新开 slice)

## 风险与缓解

- **风险:OpenCode 不知道 MCP 工具存在,不主动调用**
  缓解:scheduler skill 明确写 "用户问当前状态时,必须先调用 `Bridge_scheduler_status`"。验收第 2 条专门测这点。

- **风险:MCP 进程读 dataDir 时主进程正在写,读到半截 JSON**
  缓解:`safe-store-access` 用 atomic read(整体 readFile 再 parse,失败回退到上一次成功值)。主进程写 jobs.json 已经用 write-then-rename,本来就有原子性。

- **风险:agent 看到 status 后伪造 "我帮你删了 sched-002"**
  缓解:skill 明确 "你**只能**说明、引导,**不能**自称执行了任何 /cron 操作"。验收第 3 条覆盖类似场景。
