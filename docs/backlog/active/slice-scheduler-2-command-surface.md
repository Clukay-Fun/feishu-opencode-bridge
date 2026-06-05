# Slice: Bridge Scheduler · Slice 2 · `/schedule` 结构化命令面

依据:`docs/adr/0004-bridge-scheduler-architecture.md` 第 9 节 Slice 2。

## 目标

提供 `/schedule` 命令集 + 飞书卡片渲染。所有创建动作走**结构化 API**(用户必须手写 cron 表达式 / `every 1h` / ISO 时间),**不做 NL 解析**(那是 Slice 4)。

完成后,用户能:
```
/schedule add cron "0 9 * * *" "请检查服务器健康状态"
/schedule list
/schedule pause sched-001
/schedule run sched-001
/schedule delete sched-001
```

## 依赖

- Slice 1 必须完成(SchedulerRuntime + JobStore 可用)

## 范围

### 包含

- `src/runtime/command-handler.ts` 增加 `/schedule` 命令路由(子命令分发)
- `src/scheduler/commands.ts`(新建):每个子命令的处理逻辑
  - `add cron "<expr>" "<prompt>"`
  - `add interval "<expr>" "<prompt>"`(如 `every 1h`)
  - `add at "<ISO>" "<prompt>"`
  - `list`(列出当前用户创建的所有 job)
  - `show <id>`(显示 job 详细 + 最近 5 次 run)
  - `pause <id>` / `resume <id>`
  - `run <id>`(手动触发,绕过 maxConcurrentRuns 限制)
  - `delete <id>`(需二次确认卡)
  - `runs <id>`(显示该 job 的 run history,默认最近 20 条)
- `src/feishu/scheduler-cards.ts`(新建):
  - `buildScheduleListCardPayload(view)`:列表卡
  - `buildScheduleShowCardPayload(view)`:详细卡(含 next run / 最近 5 次结果)
  - `buildScheduleConfirmCardPayload(view)`:删除二次确认卡
  - `buildScheduleRunsCardPayload(view)`:run history 卡
  - `buildScheduleNoticeCardPayload(view)`:`/schedule add` 成功提示卡
- 命令解析:用现有 RoutedText 模式,`add` 子命令的参数解析必须健壮(允许引号包裹的 prompt 含空格)
- **权限**:默认只有 `createdByOpenId === senderOpenId` 可 pause/resume/delete/run 自己创建的 job;非创建者操作返回 "权限不足"卡
- 测试:
  - 每个子命令 happy path
  - `add` 参数缺失 / 表达式无效 → 报错带建议
  - 非创建者操作他人 job → 拒绝
  - `delete` 二次确认机制(参考现有 `/delete` session 流程)
  - `run` 不受 maxConcurrentRuns 限制(单测验证)

### 不包含

- **不做** NL 解析(Slice 4)
- **不做** OpenCode session 执行(Slice 3,本 slice 的 `run` 只触发 onTrigger,真实执行在 Slice 3 实现)
- **不做** 投递逻辑(Slice 3)
- **不做** Dashboard 集成(Slice 6)
- **不动** Memory v2 Task 命令(`/tasks`)
- **不动** `src/runtime/turn-executor.ts`
- **不允许** scheduled run 上下文里调 `/schedule add`(参见 Slice 3 的 anti-recursion;本 slice 在命令入口处补一道判断)

### 行为规则

1. **结构化 input only**:本 slice 不解析自然语言,用户必须按 `cron "<expr>"` / `interval "<expr>"` / `at "<ISO>"` 三种格式之一写
2. **短 ID 是 user-facing**:命令里全部用 `sched-001`,不让用户碰 UUID
3. **创建者主权**:`pause` / `resume` / `delete` / `run` 必须 senderOpenId === createdByOpenId,否则拒绝
4. **delete 必须二次确认**:第一次发 `/schedule delete sched-001` → 弹确认卡 → 用户点[确认删除] → 真删
5. **add 立即生效**:创建后立刻 `runtime.addJob(job)`,下一次到点就跑
6. **list 默认只显示当前用户创建的 job**;`list all` 才显示全部(任何成员可看,但 manage 仍受权限限制)
7. **`run` 命令绕开 maxConcurrentRuns**(ADR 第 5 节规则),但仍受 isRunning 锁——单 job 不重入仍然成立
8. **anti-recursion**:`/schedule add` 命令入口处检查 turn context 是不是 scheduled run 触发的,如果是 → 拒绝并写 warn log

## 实现步骤

1. 在 `command-handler.ts` 加 `/schedule` 路由分发
2. 写 `src/scheduler/commands.ts` 实现所有子命令
3. 写 `src/feishu/scheduler-cards.ts` 5 张卡
4. 接入 delete 二次确认(用现有 PendingInteraction 模式)
5. 加 anti-recursion 检查
6. 写测试覆盖每个子命令
7. 文档:`docs/commands.md` 加 `/schedule` 章节

## 验收标准

- [ ] 9 个子命令(add cron/interval/at + list + show + pause/resume + run + delete + runs)全部可用
- [ ] 5 张卡片(list / show / confirm / runs / notice)都有 designer-quality 渲染
- [ ] 短 ID 一致使用(`sched-NNN`)
- [ ] 创建者权限正确(非创建者不能管理他人 job)
- [ ] delete 二次确认机制正常
- [ ] `run` 不受 maxConcurrentRuns 限制(单测)
- [ ] anti-recursion:scheduled run 上下文调 `/schedule add` 被拒绝
- [ ] 解析失败的错误信息**带"下一步建议"**(不允许只抛栈)
- [ ] `docs/commands.md` 有 `/schedule` 章节
- [ ] 未动 `src/runtime/turn-executor.ts` / `src/memory/`
- [ ] typecheck + 全量测试通过

## 验证命令

```bash
npm run typecheck
npm test -- scheduler
npm test -- app-command-surface           # 确认命令路由不破坏现有命令
npm run check:docs-diff
git diff src/runtime/turn-executor.ts src/memory/ 2>/dev/null  # 应为空
```

## 给执行 Agent 的硬约束

1. **不做 NL 解析**——结构化 input only,Slice 4 才做 NL。
2. **不实现 OpenCode 执行 / 投递**——本 slice 的 `run` 子命令只 invoke `runtime.triggerJobNow(...)`,真实执行靠 Slice 3 的 onTrigger handler。
3. **delete 必须二次确认**——不允许"一条命令直接删"。
4. **创建者权限是硬约束**——不允许任何人 pause / delete 他人 job(admin 概念留 v1.1)。
5. **anti-recursion**——scheduled run 触发的 turn 调 `/schedule add` 必须拒绝,这是 ADR 第 5 节核心。
6. **结构化错误信息**——命令解析失败要返回友好提示,不允许只 console.error。
7. **不动 Memory v2 Task**——`/tasks` 命令面是另一套,本 slice 完全不碰。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. 9 个子命令实现位置 + 测试覆盖
4. 5 张卡片实现位置 + 截图(命令行渲染示例)
5. 创建者权限单测位置
6. delete 二次确认机制实现位置
7. anti-recursion 实现位置
8. docs/commands.md 章节
9. core / memory 未触确认
10. 未完成项清单(逐条对照)
```
