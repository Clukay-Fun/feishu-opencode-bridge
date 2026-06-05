# Slice: Bridge Scheduler · Slice 6 · 可观测性

依据:`docs/adr/0004-bridge-scheduler-architecture.md` 第 9 节 Slice 6。

## 目标

给 Scheduler 加可见性:Dashboard 顶部加 sched 计数,Activity 区显示 schedule 事件,新增 `/schedule runs` 命令显示历史。**只观测、不改 Scheduler 业务逻辑**。

## 依赖

- Slice 1 + 2 + 3 必须完成(本 slice 是 observer 层)

## 范围

### 包含

#### 1. Scheduler 发出结构化事件

修改 `src/scheduler/runtime.ts` + `src/scheduler/runner.ts`,在关键节点 emit 日志事件(通过现有 `logEvent` 走 `bridge-runtime.log`):

```ts
// scheduler/job.created     —— add job 时
// scheduler/job.deleted     —— delete job 时
// scheduler/job.paused      —— pause / 连续失败自动 pause
// scheduler/job.resumed
// scheduler/run.started     —— ScheduledRunner.run 开始
// scheduler/run.completed   —— 成功
// scheduler/run.failed      —— 失败
// scheduler/run.skipped     —— missed-due-to-restart / already-running
```

#### 2. Dashboard / Sticky / Append 三种模式都增加 sched 渲染

修改 `scripts/runtime/activity-ticker.mjs`:

- **shouldDisplay** 白名单加 `scope.startsWith("scheduler/")`
- **formatEvent** 加 scheduler 分支:
  - `job.created` / `job.deleted` / `job.paused` / `job.resumed` → 简短一行
  - `run.started` → `→ sched sched-001 running...`(蓝色 →)
  - `run.completed` → `✓ sched sched-001 (2.3s · 850字)`(绿色 ✓)
  - `run.failed` → `✗ sched sched-001 timeout`(红色 ✗)
  - `run.skipped` → `· sched sched-001 skipped: already-running`(灰色 ·)
- **Dashboard 顶部 panel**:`createDashboardRenderer` 在 panel 数据里加 `scheduledJobs / scheduledRunsTotal / scheduledRunsFailed` 计数,在头部一行显示:
  ```
  Scheduler  Jobs 5    Runs 47    Failed 1
  ```

#### 3. `/schedule runs` 命令完善(Slice 2 已有骨架,本 slice 加丰富)

- 支持 `runs <jobId>` 显示该 job 的最近 N 次
- 支持 `runs all` 显示全局最近 N 次跨 job 的运行
- 卡片展示:每次 run 一行(时间 / 状态 / 耗时 / 投递 messageId 链接)
- 支持 `--failed-only` 筛选,排查问题用

#### 4. `npm run scheduler -- list` CLI(命令行查 jobs / runs)

便于在 SSH session 不打开飞书的场景查看:

```bash
npm run scheduler -- list             # 列出所有 jobs
npm run scheduler -- runs sched-001 --limit 20
npm run scheduler -- runs all --failed-only --limit 50
```

CLI 输出 markdown 表格(也可 `--format json`)。

#### 5. 测试

- 每种 scheduler 事件出现在 ticker 输出
- Dashboard panel 数据更新(模拟事件累加计数)
- `/schedule runs` 命令各筛选条件
- CLI 各参数

### 不包含

- **不修改** Slice 1/2/3 的业务逻辑——本 slice 是纯 observer 层,只插日志事件 + 读 jsonl 历史
- **不做** 历史 run 的全文搜索(关键字过滤),只按 jobId / status / time 范围
- **不做** Web Dashboard 后台——纯命令行 + 飞书卡片
- **不做** Prometheus / 第三方监控集成
- **不动** Memory v2
- **不动** core 主流程

### 行为规则

1. **事件是 fire-and-forget**:emit 失败(如 log writer 满)不能拖垮 scheduler 主流程
2. **Dashboard 计数从 jsonl 读**:不维护内存计数(避免重启后归零),每次刷新读 `data/schedules/runs/*.jsonl` 聚合
3. **CLI 输出友好**:markdown 表格人类可读,JSON 模式机器可消费
4. **筛选语义**:`--failed-only` 只显示 status=failed,`--limit` 默认 20

## 实现步骤

1. 在 scheduler 模块各个状态变化点 emit 事件(单测验证每条都发)
2. 改 activity-ticker.mjs 加白名单 + format 分支
3. 改 dashboard renderer 加 scheduler 数据源 + 头部显示
4. 完善 `/schedule runs` 命令面(卡片渲染)
5. 写 `src/scheduler/cli.ts` + package.json script
6. 测试覆盖

## 验收标准

- [ ] 7 种 scheduler 事件全部 emit(job.created/deleted/paused/resumed + run.started/completed/failed/skipped)
- [ ] Dashboard 顶部显示 `Jobs N · Runs N · Failed N`,数据从 jsonl 读
- [ ] Activity ticker 显示 scheduler 事件(7 种各有合适 icon + 颜色)
- [ ] `/schedule runs <id>` / `runs all` / `--failed-only` 三种筛选
- [ ] `npm run scheduler -- list / runs ...` CLI 可用
- [ ] CLI 支持 markdown / json 两种输出
- [ ] emit 失败不拖垮 scheduler
- [ ] 未触 Slice 1/2/3 业务逻辑(只在状态变化点插 emit + 读 jsonl)
- [ ] typecheck + scheduler 全套测试 + ticker 测试通过

## 验证命令

```bash
npm run typecheck
npm test -- scheduler activity-ticker
npm run scheduler -- list             # 烟测
npm run scheduler -- runs all --limit 5 --format json | python3 -m json.tool
git diff src/scheduler/runtime.ts src/scheduler/runner.ts src/scheduler/store.ts | grep -v "logEvent\|emit" | head -10
# 上面 grep 应该没有非 logEvent 的业务逻辑改动
```

## 给执行 Agent 的硬约束

1. **本 slice 是 observer 层**——不改 Scheduler 业务逻辑,只插事件 emit + 读 jsonl 历史。
2. **emit 是 fire-and-forget**——失败不抛,不拖垮主流程。
3. **Dashboard 数据从 jsonl 读**——不维护内存计数,重启后照样准。
4. **不做 Web 后台 / 不集成第三方监控**——纯 CLI + 飞书卡片。
5. **不动 Slice 1/2/3 业务逻辑**——只在他们的状态变化点插一行 `logEvent(...)`。
6. **不动 Memory v2 / core 主流程**。
7. **CLI 输出稳定**——markdown 模式人类读,json 模式机器消费,字段名跨版本保持一致。

## 完成总结模板

```
1. 跑的验证命令 + 输出(含烟测 npm run scheduler -- list)
2. 变更文件清单(主要在 src/scheduler/cli.ts + scripts/runtime/activity-ticker.mjs)
3. 7 种事件 emit 点位置(逐条)
4. Dashboard 数据源代码位置
5. Activity ticker scheduler 分支位置 + 单测
6. /schedule runs 命令卡片渲染位置
7. CLI 实现位置 + 支持的子命令
8. Scheduler 业务逻辑未触确认(git diff 输出仅 logEvent / 测试)
9. core / memory 未触确认
10. 未完成项清单(逐条对照)
```
