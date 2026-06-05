# Slice: Bridge Scheduler · Slice 3 · ScheduledRunner

依据:`docs/adr/0004-bridge-scheduler-architecture.md` 第 5 节、第 9 节 Slice 3。

## 目标

实现"到点真的跑起来"——把 Slice 1 暴露的 `onTrigger` callback 填实:

- `mode: notice-only` → 直接发提醒卡
- `mode: opencode-isolated` → 创建临时 OpenCode session、跑 prompt、投递结果
- 支持 `[SILENT]` 抑制投递
- 失败处理 + run history 完整记录

## 依赖

- Slice 1 完成(SchedulerRuntime + onTrigger 注入点存在)
- 推荐 Slice 2 完成(便于手动 `/schedule run` 调试),但**不强依赖**

## 范围

### 包含

- `src/scheduler/runner.ts`(新建):`ScheduledRunner` 类
  - `run(job): Promise<JobRun>` —— 整套执行流程
  - 接收 `BridgeApp` 注入的依赖:`opencode` / `outbound` / `logger` / `costTracker`
- 集成到 BridgeApp:在 `src/runtime/app.ts` 创建 `ScheduledRunner` 实例,作为 `SchedulerRuntime.start(runner.run.bind(runner))` 的 onTrigger 传入
- 两种 mode 的实现:
  - `notice-only`:直接 `outbound.sendMessage(chatId, noticeCard(prompt))`
  - `opencode-isolated`:
    1. `opencode.createSession(title: job.name + " · scheduled")`
    2. `opencode.promptAsync(sessionId, prompt)`
    3. 等待 reply 完成 + 超时管理(`policy.timeoutMs`)
    4. 取最终 reply 文本
    5. 检查是否以 `[SILENT]` 开头 → 是则跳过投递,只写 history
    6. 否则用现有 `buildAssistantMarkdownPayload` 或新建 `buildScheduledResultCardPayload` 发飞书
    7. 按 `policy.deleteAfterRun` 决定是否 `opencode.deleteSession(sessionId)`
- `[SILENT]` 处理:
  - 检测前 trim
  - 计 `silent=true` 写 history
  - 完全不发任何卡片(注意 / 错误卡都不发)
- 失败处理:
  - OpenCode 超时 → 写 `failed: timeout`
  - OpenCode 报错 → 写 `failed: opencode-error` + 投递错误卡(不受 SILENT 影响)
  - 飞书投递报错 → 写 `failed: delivery` + `consecutiveFailures++`
  - **连续 3 次失败** → 自动 `pauseJob(id)` + 发警报卡给 createdByOpenId(P2P)
- `src/feishu/scheduler-cards.ts` 加 3 张新卡:
  - `buildScheduledResultCardPayload`:成功投递的标准结果卡
  - `buildScheduledErrorCardPayload`:执行失败提示
  - `buildScheduledAlertCardPayload`:连续失败自动 pause 警报
- anti-recursion 标记:执行时 set turn context 标记 `{kind: "scheduled-run", jobId}`,Slice 2 的命令入口已经检查这个标记
- 测试:
  - notice-only 直发不调 opencode
  - opencode-isolated happy path(mock opencode + outbound)
  - 超时处理(mock opencode 永不 resolve → runner 在 timeoutMs 后写 failed)
  - `[SILENT]` 抑制投递(outbound.sendMessage 没被调用)
  - 连续 3 次失败 → 自动 pause + 警报投递
  - `deleteAfterRun` 行为
  - run history 字段完整

### 不包含

- **不做** 命令面(Slice 2 已做)
- **不做** NL 解析(Slice 4)
- **不做** 新闻 / RSS 工具配置(Slice 5)
- **不动** `src/runtime/turn-executor.ts`(普通 turn 跟 scheduled run 完全分开,各走各的代码路径)
- **不动** Memory v2(scheduled run 不写 memory,避免噪音)
- **不允许** scheduled run 内部触发新的 `/schedule add`(anti-recursion 在 Slice 2 处理,本 slice 仅 set context flag)

### 行为规则

1. **isolated session 是硬约束**:绝不复用用户当前窗口 session;每次新建,完成后按 deleteAfterRun 决定保留与否
2. **`[SILENT]` 检测严格**:`reply.trimStart().startsWith("[SILENT]")`(允许前置空白,但不允许后置如 `[SILENT ]`)
3. **超时由 ScheduledRunner 控制**,不依赖 OpenCode 自身超时:用 `Promise.race` + `AbortController`
4. **投递失败的错误卡也尝试发**——但如果飞书投递自己报错,就只写 history,不死循环
5. **连续失败计数在 JobState 持久化**:成功一次重置为 0;连续 3 次后 set `enabled: false` + 发警报
6. **不写 memory**:scheduled run 跑出来的对话内容**不进 Memory v2 的自动学习路径**,避免 cron job 把 memory 表灌满
7. **anti-recursion context flag** 必须传到 OpenCode 的 turn 处理路径,且在命令入口可读

## 实现步骤

1. 写 `ScheduledRunner` 框架(接收 deps,定义 `run(job)`)
2. 实现 notice-only 分支
3. 实现 opencode-isolated 分支(create / prompt / wait / extract reply)
4. 实现超时 + `[SILENT]` 检测
5. 实现失败处理 + 连续 3 次自动 pause + 警报
6. 接入 BridgeApp,挂到 SchedulerRuntime
7. set anti-recursion turn context
8. 加 memory 屏蔽:在 scheduled run 路径上跳过 memory 学习钩子
9. 测试覆盖

## 验收标准

- [ ] notice-only / opencode-isolated 两种 mode 都跑通
- [ ] `[SILENT]` 抑制投递(测试 mock outbound 验证未被调用)
- [ ] 超时按 `policy.timeoutMs` 触发
- [ ] OpenCode 报错时投错误卡,且不死循环
- [ ] 飞书投递报错只写 history,不抛
- [ ] 连续 3 次失败 → `enabled=false` + 警报卡到创建者私聊
- [ ] `deleteAfterRun` 正确处理(once 默认删,interval/cron 默认保留)
- [ ] run history 字段完整(runId / startedAt / finishedAt / status / attempt / silent / openCodeSessionId / deliveryMessageId)
- [ ] anti-recursion turn context flag 在命令入口可读
- [ ] scheduled run 不进 Memory v2 学习路径
- [ ] 未触 `src/runtime/turn-executor.ts`
- [ ] 未触 `src/memory/` 写入路径
- [ ] typecheck + scheduler / memory / app-command-surface 全套测试通过

## 验证命令

```bash
npm run typecheck
npm test -- scheduler memory app-command-surface
git diff src/runtime/turn-executor.ts 2>/dev/null  # 应为空
```

## 给执行 Agent 的硬约束

1. **isolated session 是硬约束**——不允许任何路径复用用户当前窗口 session。
2. **`[SILENT]` 抑制是硬约束**——SILENT 检测后,连错误卡都不发,只记 history。
3. **超时控制必须在 runner 里**——不允许"等 opencode 永远 resolve"。
4. **anti-recursion context flag 必须在 turn 处理路径可读**——否则 Slice 2 的 add 命令检查无效。
5. **scheduled run 不进 Memory v2 写入路径**——避免 cron 灌库。
6. **失败处理必须有边界**——飞书投递报错不能死循环,只写 history 然后 return。
7. **不动 turn-executor.ts**——scheduled run 走独立路径。
8. **不引入新依赖**——用现有 opencode client + outbound port。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. ScheduledRunner.run() 主流程位置
4. notice-only vs opencode-isolated 分支位置
5. [SILENT] 检测位置 + 单测
6. 超时实现方式(Promise.race / AbortController)
7. 连续 3 次失败自动 pause 单测位置
8. anti-recursion context flag 设置点 + 命令入口读取点
9. memory 不进自动学习的实现方式
10. turn-executor.ts 未触确认
11. 未完成项清单(逐条对照)
```
