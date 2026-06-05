# Slice: Bridge Scheduler · Slice 1 · SchedulerCore

依据:`docs/adr/0004-bridge-scheduler-architecture.md` 第 4-5 节、第 9 节 Slice 1。

## 目标

实现 Scheduler 的**底层基础**——node-cron 接入 + 持久化 JobStore + 重启恢复。**不包含命令面、不包含 OpenCode runner、不包含投递**——本 slice 完成后,Scheduler 能"按时到点触发回调",但回调 body 是空(由 Slice 3 填)。

## 范围

### 包含

- 新建 `src/scheduler/` 目录
- `src/scheduler/types.ts`:`ScheduledJob` / `JobState` / `JobRun` 类型(对齐 ADR 第 4 节)
- `src/scheduler/store.ts`:`JobStore` 类
  - load/save `data/schedules/jobs.json`(任务定义)
  - load/save `data/schedules/jobs-state.json`(运行态)
  - `appendRun(jobId, run)` 写 `data/schedules/runs/<jobId>.jsonl`
  - 短 ID 自增(sched-001、sched-002 ...,内部对应 UUID)
- `src/scheduler/parser.ts`:轻量 schedule 表达式解析
  - `at 2026-06-05T09:00:00` → `{kind: "once", expression}`
  - `every 1h` / `every 30m` / `every 2d` → `{kind: "interval", expression}`
  - 5/6 字段 cron `"0 9 * * *"` → `{kind: "cron", expression}`
- `src/scheduler/runtime.ts`:`SchedulerRuntime` 类
  - `start(onTrigger)`:用 node-cron 注册所有 enabled job;onTrigger(job) 是 Slice 3 会传进来的执行回调
  - `stop()`:卸载所有 cron 任务
  - `addJob(job)` / `pauseJob(id)` / `resumeJob(id)` / `removeJob(id)` / `triggerJobNow(id, onTrigger)`
  - 重启时只计算下一次未来触发,**不补跑过期任务**(写 `skipped: missed-due-to-restart` 到 run history)
  - 单 job 不重入:`isRunning=true` 时再到点 → 写 `skipped: already-running`,不调 onTrigger
- 接入 BridgeApp 生命周期:`src/runtime/app.ts` 启动时 `scheduler.start(...)`、关闭时 `scheduler.stop()`
- 配置 schema:`src/config/schema.ts` 加 `scheduler` 节(ADR 第 8 节)
- 测试:
  - parser 三种表达式格式
  - JobStore 持久化往返
  - JobStore 短 ID 自增不撞
  - Runtime 重启不补跑
  - Runtime 单 job 不重入
  - Runtime add/pause/resume/remove 生命周期

### 不包含

- **不做** `/schedule` 命令面(Slice 2)
- **不做** OpenCode session 执行(Slice 3)
- **不做** 飞书卡片投递(Slice 3)
- **不做** NL 解析(Slice 4)
- **不做** Dashboard 展示(Slice 6)
- **不动** `src/memory/` 任何文件(Memory v2 Task 是另一套)
- **不修改** `src/runtime/turn-executor.ts` 主流程

### 行为规则

1. **底层必须用 `node-cron`**——已在 deps,不允许重写 tick loop
2. **JobStore 写入是原子的**:write to `jobs.json.tmp` → rename(防止半写)
3. **重启不补跑**是 ADR 第 5 节核心规则,本 slice 必须实现并单测验证
4. **单 job 不重入**通过 `JobState.isRunning` 锁,onTrigger 包装层在调用前后翻转该字段
5. **maxConcurrentRuns 是全局并发上限**(配置项,默认 1),只对 cron 自动触发生效;`triggerJobNow` 走手动路径,**不受该上限限制**
6. **短 ID 是 user-facing**(展示在命令和卡片),UUID 是内部 stable key(用于事件、日志、外部引用)
7. **`data/schedules/` 目录不存在时自动 mkdir -p**,首次启动不报错

## 实现步骤

1. 创建目录结构 `src/scheduler/` + `data/schedules/`(.gitkeep)
2. 写 `types.ts`(对齐 ADR 数据模型)
3. 写 `parser.ts` + 单测(三种表达式 + 边界 case)
4. 写 `store.ts` + 单测(原子写、短 ID 自增、run history append、保留期清理)
5. 写 `runtime.ts` + 单测(start/stop、不重入、不补跑)
6. 接入 `src/runtime/app.ts`(start/stop 钩进 BridgeApp 生命周期)
7. 加 config schema + 默认值
8. 跑全量回归

## 验收标准

- [ ] `src/scheduler/` 4 个文件齐(types/store/parser/runtime)
- [ ] parser 三种表达式(once/interval/cron)解析正确,无效输入抛带描述的错
- [ ] JobStore 写入原子(并发写不会半文件)
- [ ] 短 ID 自增不撞(`sched-001` 到 `sched-NNN`,跨重启延续)
- [ ] 重启不补跑(单测:写一个过期 once job → 重启 → 断言 onTrigger 没被调用 + run history 有 `skipped: missed-due-to-restart`)
- [ ] 单 job 不重入(单测:onTrigger 模拟阻塞 100ms,期间第二次到点 → 第二次写 `skipped: already-running`)
- [ ] `maxConcurrentRuns: 1` 限制 cron 触发,但 `triggerJobNow` 不受限
- [ ] BridgeApp 启动时 scheduler.start,Ctrl+C 时 scheduler.stop 干净
- [ ] config schema 增加 `scheduler` 节有默认值
- [ ] `data/schedules/` 不存在时自动创建,首次启动不报错
- [ ] typecheck + scheduler 全量测试通过
- [ ] 未触及 `src/memory/`、`src/runtime/turn-executor.ts`、`src/runtime/command-handler.ts`

## 验证命令

```bash
npm run typecheck
npm test -- scheduler
git diff src/memory/ src/runtime/turn-executor.ts src/runtime/command-handler.ts 2>/dev/null   # 应为空
```

## 给执行 Agent 的硬约束

1. **底层调度必须用 `node-cron`**。不允许自写 tick loop / setInterval polling。
2. **不动 core 主流程**:`src/runtime/app.ts` 仅添加生命周期钩子(start/stop scheduler),不改其他逻辑。
3. **不动 `src/memory/`**:Memory v2 Task 是另一套,边界由 ADR 钉死,不允许在 scheduler 里 import memory db。
4. **不实现命令 / 不实现执行 / 不实现投递**:本 slice 只做"到点能触发回调"的底层。
5. **onTrigger 是注入的 callback**:`runtime.start(onTrigger)` 接受外部传入的 trigger handler,本 slice 测试用 vi.fn() mock。
6. **重启不补跑是硬约束**,必须有单测验证。
7. **写文件用原子模式**(tmp + rename),不允许 raw fs.writeFile 直接覆盖 jobs.json。
8. **不引入新依赖**——node-cron 已在 deps。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单(应在 src/scheduler/ + src/config/schema.ts + src/runtime/app.ts + test/scheduler*/)
3. 4 个核心文件位置 + 行数
4. parser 支持的 3 种表达式具体测试 fixture 位置
5. JobStore 原子写实现方式
6. "重启不补跑"单测位置 + 断言
7. "单 job 不重入"单测位置
8. core 主流程未触确认(git diff 输出空)
9. memory 未触确认
10. 未完成项清单(逐条对照"包含"章节,无则写"无")
```
