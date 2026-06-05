# ADR 0004:Bridge Scheduler 架构

- **状态**:草案(2026-06-04)
- **关联**:Issue TBD、`src/memory/`(Task 子系统边界)

## 1. 背景

用户希望在飞书里创建"每天 9 点收集 AI 新闻发给我"这类**到点自动执行**的任务。Bridge 现有能力:
- Memory v2 Task 系统(`src/memory/task-db.ts`):**被动提醒**——到期推一条 ticker 行,用户决定何时做
- 没有"主动执行 + 投递结果"的能力

参考实现:OpenClaw 的 `jobs.json` 持久化 + 隔离 session,Hermes 的 `/cron` 命令面 + `[SILENT]` 抑制。

## 2. 定位:框架能力,不做业务扩展

Scheduler 属于**框架层**,挂在 `BridgeApp` 生命周期:

```text
Feishu /schedule
  -> Scheduler Runtime
    -> JobStore(持久化定义)
    -> node-cron(到点触发)
    -> ScheduledRunner
      -> isolated OpenCode session(默认)
      -> 飞书卡片投递
      -> Run history(JSONL)
```

Bridge **只拥有**:调度定义、运行状态、投递路由、运行历史。
OpenCode session **依然拥有**:真实对话内容。

## 3. 与 Memory v2 Task 的边界

**两套并存,语义不同**:

| 维度 | Memory v2 Task | Bridge Scheduler |
|---|---|---|
| 谁执行 | 人 | AI / 系统 |
| 触发后做什么 | 推一条提醒,等用户响应 | 跑 prompt → 投递结果 |
| 入口命令 | `/tasks`、`/remind me ...`(未来) | `/schedule add ...` |
| 持久化 | `work_tasks` 表(SQLite) | `jobs.json`(JSON 文件) |
| 取消 | 改状态 `canceled` | `/schedule delete <id>` 真删 |
| 用户故事 | "明天 10 点提醒我打电话" | "每天 9 点收 AI 新闻发我" |

**边界口径**:
- 名词带"提醒/remind/记得"→ Task
- 名词带"自动/帮我做/收集/生成"→ Scheduler
- 时间是"一次性 + 等我做"→ Task
- 时间是"周期 + AI 执行"→ Scheduler
- 创建路径不交叉:`/tasks` 和 `/schedule` 各自命令面,**不允许某个命令同时走两套底层**

## 4. 数据模型

### `data/schedules/jobs.json`(任务定义)

```ts
type ScheduledJob = {
  id: string;                            // 短 ID:sched-001、sched-002
  uuid: string;                          // 内部全局 UUID
  name: string;                          // 用户取的别名
  enabled: boolean;
  schedule: {
    kind: "once" | "interval" | "cron";
    expression: string;                  // node-cron 表达式 / ISO 时间戳 / "every 1h"
    timezone: string;                    // 默认 "Asia/Shanghai"
  };
  task: {
    mode: "opencode-isolated" | "notice-only";
    prompt: string;                      // 给 OpenCode 的 prompt;notice-only 则是要发的文本
    modelOverride?: { providerID: string; modelID: string };
  };
  delivery: {
    chatId: string;
    chatType: string;                    // "p2p" / "group" / "topic_group"
    conversationKey: string;
    threadKey: string;
    createdByOpenId: string;
  };
  policy: {
    timeoutMs: number;                   // 默认 300000(5 min)
    maxAttempts: number;                 // v1:1(不重试)
    deleteAfterRun?: boolean;            // once 类型默认 true
  };
  createdAt: number;
  updatedAt: number;
};
```

### `data/schedules/jobs-state.json`(运行态,独立)

```ts
type JobState = {
  jobId: string;
  lastRunAt?: number;
  lastRunStatus?: "success" | "failed" | "skipped" | "interrupted";
  consecutiveFailures: number;           // 用于"投递连续 3 次失败自动 pause"
  nextRunAt?: number;                    // 仅供 /schedule list 显示,不参与调度决策
  isRunning: boolean;                    // 当前是否正在跑(防重入)
};
```

### `data/schedules/runs/<jobId>.jsonl`(运行历史)

每次 run 一行:

```json
{"runId":"r-001","jobId":"sched-001","startedAt":1717400000000,"finishedAt":1717400023000,
 "status":"success","attempt":1,"openCodeSessionId":"ses_xxx","replyLength":850,
 "deliveryMessageId":"om_xxx","triggerKind":"cron","silent":false}
```

每条 jsonl 文件**保留 30 天**(配置项 `runRetentionDays`),后台清理。

## 5. 核心行为规则

1. **node-cron 是底层调度器**,不重写 tick loop(已是 dependency,成熟稳定)
2. **重启不补跑**:bridge crash → 重启后,过期未执行的任务**直接跳过**(写一条 `skipped: missed-due-to-restart` 到 run history),只计算下一次未来触发
3. **同一 job 不允许重入**:`isRunning=true` 时再到点 → 写 `skipped: already-running`,不并行跑同一个 job
4. **maxConcurrentRuns 仅限制 cron 自动触发**:手动 `/schedule run <id>` **忽略全局并发上限**,允许调试时强制跑
5. **isolated session 默认**:每次跑 cron job 创建临时 OpenCode session,完成后按 `deleteAfterRun` 决定保留与否。**不复用用户当前窗口 active session**
6. **`[SILENT]` 抑制投递**:OpenCode 回复以 `[SILENT]` 开头时,只记 run history,**不发卡片**——用户配的"安静监控类"任务
7. **递归创建禁止**:scheduled run 跑出来的 OpenCode session 不允许调用 `/schedule add`(命令面强制拒绝;通过 run context 标记)
8. **创建者主权**:默认只有 `createdByOpenId` 可以 pause/resume/delete 自己的 job;admin 可全管(v1.1 再做)
9. **投递连续失败 3 次** → 自动 `enabled: false` + 推送一条警报到创建者(防止"被踢出群"后任务一直推空气)

## 6. 不做项(显式)

- **不做** 跨 Bridge 实例分布式调度(单机)
- **不做** "复用当前窗口 active session" 模式(会污染会话语义)
- **不做** 自然语言里复杂时间表达式(节假日、农历、"每周第一个工作日");复杂场景让用户写 cron
- **不做** Web 管理后台(纯飞书命令)
- **不做** scheduled run 内部再创建 schedule(递归)
- **不做** 在 Memory v2 Task 上叠加 Scheduler 语义(两套并存,不合并)

## 7. NL 创建的 LLM 解析护栏

NL 解析强制走"**LLM 解析 → 确认卡 → 用户点 → 落盘**":

- **不允许** LLM 直接写 `jobs.json`(无论解析多稳)
- **不允许** 确认卡里"自动确认按钮"——必须用户主动点
- 确认卡显示完整 schedule + prompt 原文,让用户能看出 LLM 解析没翻车
- 解析失败(LLM 返回不合规 JSON / 时间表达式无效)→ 不弹卡,直接报错让用户改 NL 重发

## 8. 配置 schema

```json
{
  "scheduler": {
    "enabled": true,
    "storeDir": "./data/schedules",
    "defaultTimezone": "Asia/Shanghai",
    "defaultTimeoutMs": 300000,
    "maxConcurrentRuns": 1,
    "runRetentionDays": 30,
    "allowIsolatedOpenCode": true,
    "allowNoticeOnly": true,
    "nlParser": {
      "enabled": true,
      "modelOverride": null
    }
  }
}
```

## 9. 实现切片建议

| Slice | 标题 | 依赖 | 估时 |
|---|---|---|---|
| 1 | SchedulerCore(node-cron + JobStore + TickRunner) | 无 | 3-4 天 |
| 2 | `/schedule` 结构化命令面 + 卡片 | Slice 1 | 2-3 天 |
| 3 | ScheduledRunner(isolated session + SILENT + 投递) | Slice 1 | 2-3 天 |
| 4 | NL 创建 + 确认卡 | Slice 2 + 3 | 2-3 天 |
| 5 | 新闻工具(RSS / webfetch MCP) | 独立 | 1-2 天 |
| 6 | 可观测性(Dashboard + run history 查询命令) | Slice 1-3 | 1-2 天 |

## 10. 被拒绝的备选方案

### 方案 A:用 Memory v2 Task 子系统兜住 Scheduler

**拒绝**:Task 设计为"被动提醒,人来决定执行",`due_at` 触发后只 push memory recall,不调 OpenCode。强行扩展会让 Task 子系统语义混乱,且 Task 没有 run history、isolated session、并发控制这些 Scheduler 必需的能力。

### 方案 B:自写 tick loop(模仿 OpenClaw)

**拒绝**:Node 生态有成熟 `node-cron`(项目已 deps,4.x 版本),自写 tick loop 失去秒级精度、cron 表达式、时区/DST 支持。OpenClaw 用 tick 是 Python 生态原因。

### 方案 C:把 `/schedule add` 命令路由进 `/tasks` 命令面

**拒绝**:命令面合并会让用户分不清"是提醒我还是 AI 自动跑",且两套底层(`work_tasks` 表 vs `jobs.json`)语义不能合并。命令面就保持两套。

## 11. 验收清单

- [ ] 4 张 JSON/JSONL 文件结构清晰,各自职责不重叠(jobs / jobs-state / runs/*)
- [ ] node-cron 接管底层调度,不写自定义 tick loop
- [ ] isolated OpenCode session 默认,且不允许复用当前窗口 session
- [ ] `[SILENT]` 抑制 + 递归创建禁止 + 重启不补跑三条核心规则全部落地
- [ ] NL 解析必须走确认卡,不允许直接落盘
- [ ] Memory v2 Task 与 Scheduler 命令面分离,文档明确边界
- [ ] 投递连续失败 3 次自动 pause + 推送警报
- [ ] 单 job 不重入(isRunning 锁)
- [ ] runs/<jobId>.jsonl 按配置保留期清理
