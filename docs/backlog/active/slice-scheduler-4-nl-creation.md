# Slice: Bridge Scheduler · Slice 4 · NL 创建 + 确认卡

依据:`docs/adr/0004-bridge-scheduler-architecture.md` 第 7 节、第 9 节 Slice 4。

## 目标

让用户能用自然语言创建定时任务:

```
/schedule 每天早上9点收集前一天的AI科技新闻发送给我
```

LLM 解析为结构化 `ScheduledJob`,弹**确认卡**让用户检查后再落盘。**绝不允许 LLM 直接写 `jobs.json`**。

## 依赖

- Slice 2 完成(`/schedule add` 的底层 API 可用)
- Slice 3 完成(便于真实测试 NL 创建后的任务能跑)

## 范围

### 包含

- `src/scheduler/nl-parser.ts`(新建):LLM 自然语言 → 结构化任务草稿
  - 输入:用户原始 NL + 当前 chat 上下文(senderOpenId / chatId / chatType / 当前时间 + timezone)
  - 输出:`ScheduledJobDraft`(尚未持久化,等待用户确认)
  - 使用现有 OpenCode 客户端,**临时 session**(类似 Slice 3 的 isolated mode)
  - Prompt 强制 LLM 输出 JSON schema(参考 OpenAI tool calling / json mode)
  - 校验 LLM 输出:
    - schedule.expression 必须能被 Slice 1 的 parser 接受
    - prompt 不能为空
    - timezone 必须是 IANA 名(默认 Asia/Shanghai)
- `/schedule` 命令路由扩展:
  - 检测到 `/schedule <自然语言文字>`(不是 `add`/`list`/`pause`/... 等结构化子命令)→ 走 NL 路径
  - 调 `nlParser` → 拿到 draft → 用 `PendingScheduleConfirmation` 暂存 → 弹确认卡
- `src/feishu/scheduler-cards.ts` 加:
  - `buildScheduleNLConfirmCardPayload(draft)`:NL 解析结果确认卡
    - 显示原始 NL、解析后的 schedule、prompt、delivery target
    - 三个按钮:[确认创建] [修改] [取消]
- 卡片回调处理:
  - **确认创建** → 调 Slice 2 的 add 子命令底层(`commands.addJob(draft)`),发送成功通知
  - **修改** → 弹 prompt 让用户重写 NL,重新解析
  - **取消** → 清除 pending,发送取消通知
- 错误处理:
  - LLM 返回非 JSON / 非法 schedule 表达式 → 不弹卡,直接回复"未能理解,请改用 /schedule add cron ... 或重新描述"
  - LLM 输出含有恶意字段(如 modelOverride 指向不存在的模型)→ 校验时拒绝
- 测试:
  - 三种典型 NL 输入(daily / weekly / once)解析正确
  - LLM 输出无效 JSON → 用户得到友好错误
  - 确认 / 修改 / 取消三条路径
  - 解析的 schedule 表达式能被 Slice 1 parser 接受(端到端)
  - **scheduled run 上下文里调 `/schedule <NL>` 也被 anti-recursion 拒绝**

### 不包含

- **不做** 复杂时间表达式(节假日 / 农历 / "下次小张休假后")——超出 LLM 可靠解析范围,让用户用 cron
- **不做** "我已经懂了你的意思,直接帮你创建吧" 自动确认——确认卡是硬约束
- **不做** 历史 NL 学习(用户改正过的解析不会作为 future training signal)
- **不修改** Slice 1/2/3 的核心代码,本 slice 是上层 layer
- **不动** Memory v2(不要把"我想定期收新闻"写进 memory)

### 行为规则

1. **确认卡是硬约束**:即使 LLM 解析非常确定,也必须用户主动点 [确认创建] 才落盘
2. **LLM 输出必须校验**:schedule 表达式过 Slice 1 parser、timezone 是 IANA、prompt 非空,任一不过则拒绝
3. **pending confirmation 有 TTL**:30 分钟内不确认自动清除(参考 Setup UI 的 confirmation TTL 模式)
4. **重新解析**:用户点[修改]后,重新走 NL 解析路径,不复用之前的 draft
5. **NL 路径默认是 P2P / 当前 chat 投递**:LLM 不允许指定其他 chat 作为 delivery target(防止用户被引导创建到别人聊天的任务)
6. **anti-recursion**:跟 Slice 2 一样,scheduled run 上下文调 NL 创建也拒绝
7. **没办法解析的 NL 不要乱猜**:LLM 应该说"我不确定你说的'每个工作日下午'是几点",让用户补全

## 实现步骤

1. 设计 LLM prompt:输入 NL + 当前上下文,输出严格 JSON
2. 写 `nlParser.parse(text, context)` + 校验
3. 路由扩展:`command-handler.ts` 检测非结构化子命令的 `/schedule <text>` 走 NL 路径
4. 写 `buildScheduleNLConfirmCardPayload` + 三个按钮回调
5. 接入 PendingInteraction 模式存 draft
6. 错误处理 + 友好提示
7. 测试覆盖

## 验收标准

- [ ] 三种典型 NL("每天 9 点 X"、"下周一 10 点 X"、"每周一三五 14 点 X")解析正确
- [ ] LLM 输出无效 JSON / 非法 schedule → 用户拿到"我不太理解"提示,不弹卡
- [ ] 确认卡显示完整 schedule + prompt + delivery
- [ ] [确认创建] → 真创建 + 成功通知
- [ ] [修改] → 弹 prompt + 重新解析
- [ ] [取消] → 清除 pending + 取消通知
- [ ] pending TTL 30 分钟自动清除
- [ ] delivery target 锁定到当前 chat(LLM 不能改)
- [ ] anti-recursion 在 NL 路径也生效
- [ ] 端到端:NL → 确认 → 创建 → 真到点跑(需 Slice 3 已完成)
- [ ] typecheck + scheduler 全套测试通过
- [ ] 未触 Slice 1/2/3 核心代码

## 验证命令

```bash
npm run typecheck
npm test -- scheduler nl
git diff src/scheduler/runtime.ts src/scheduler/store.ts src/scheduler/runner.ts 2>/dev/null  # 应为空
```

## 给执行 Agent 的硬约束

1. **确认卡是硬约束**——任何"省事自动创建"的路径不允许。
2. **LLM 输出严格 schema 校验**——schedule 表达式必须过 Slice 1 parser 才接受。
3. **delivery 锁定当前 chat**——LLM 不能控制投递到其他 chat。
4. **anti-recursion 在 NL 路径同样生效**——scheduled run 触发的 turn 不能用 NL 创建新 schedule。
5. **不动 Slice 1/2/3 核心**——本 slice 仅添加上层 NL 处理。
6. **pending TTL 必须实现**——不允许 pending 永久挂起。
7. **复杂时间表达式不靠 LLM 猜**——节假日 / 农历 / 相对时间链不属于 v1 范围,LLM 应该说"我不懂"而不是乱猜。
8. **不引入新依赖**——用现有 opencode client。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单(主要在 src/scheduler/nl-parser.ts + src/feishu/scheduler-cards.ts)
3. NL parser prompt 设计要点
4. LLM 输出校验逻辑(三处:schedule 表达式 / timezone / prompt 非空)
5. 三种典型 NL 单测位置
6. 确认 / 修改 / 取消三路径单测位置
7. pending TTL 实现 + 单测
8. delivery 锁当前 chat 单测
9. anti-recursion 在 NL 路径生效单测
10. Slice 1/2/3 核心未触确认
11. 未完成项清单(逐条对照)
```
