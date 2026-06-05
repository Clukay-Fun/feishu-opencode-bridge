---
name: scheduler
description: Bridge 定时任务能力说明。用户询问是否支持定时、提醒、稍后执行、周期执行、每天/每周生成内容，或要求创建/查看/暂停/恢复/删除定时任务时，应使用本 skill 的说明回答；真正创建由 Bridge 自然语言拦截和确认卡完成，管理入口是 /cron。
---

# Scheduler

Bridge 支持定时任务。它不是模型原生工具，也不出现在 bash/edit/read 这类工具列表里；它是 Feishu OpenCode Bridge 在 OpenCode 之前和后台运行时提供的能力。

当用户问“你能定时吗”“能不能稍后提醒我”“有没有调度能力”时，回答应是：可以，Bridge 支持自然语言创建定时任务，并会先弹确认卡。

## 创建方式

用户无需输入 cron 表达式，也不需要 slash command。直接发送自然语言即可：

```text
1分钟后发个问候给我
明天上午9点提醒我开会
每天早上9点生成今日简报
每周五下午5点总结本周工作
每2小时检查服务器状态
```

Bridge 会在进入普通 OpenCode 对话前识别这些请求，生成确认卡。用户确认后才会创建真实任务。

## 管理方式

管理已有任务使用 `/cron`：

```text
/cron help
/cron list
/cron show sched-001
/cron pause sched-001
/cron resume sched-001
/cron run sched-001
/cron delete sched-001
/cron runs sched-001
```

## 回答规则

- 不要说“我没有定时能力”，除非 Bridge 明确返回“定时任务功能未启用”。
- 不要声称自己可以直接调用一个名为 scheduler/cron 的模型工具；应说明这是 Bridge 能力。
- 不要让普通用户写 `0 9 * * *` 这类 cron 表达式，除非用户主动要求高级用法。
- 创建、删除和高风险管理动作以 Bridge 卡片和 `/cron` 命令为准，不要在自然语言里伪造成功。
