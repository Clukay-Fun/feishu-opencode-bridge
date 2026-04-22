# 设计历史说明

这个目录不是“所有旧文档的垃圾桶”，而是用来保留少量仍有解释价值的历史设计资料。

它的作用主要有两个：

- 补充当前规则背后的历史背景，帮助理解“为什么今天会这样设计”
- 保存仍被当前脚本或检查流程直接依赖的历史资产

如果你只是想看项目现在应该怎么做，优先看这些现行文档：

- `AGENTS.md`
- `docs/architecture-baseline.md`
- `docs/guidelines/new-feature-checklist.md`
- `README.md`

只有当你需要回答下面这类问题时，才需要回到这里：

- 这个边界当初为什么这样拆？
- formatter 为什么被冻结成兼容层？
- runtime module 分层最初是怎么收敛出来的？
- 某个检查脚本依赖的快照文件是什么来历？

## 当前保留资料

### `formatter-export-snapshot.json`

这是 formatter 兼容导出面的快照文件，不只是历史记录，而是当前仍在使用的检查基线。

- 用途：固定 `src/feishu/formatter.ts` 的兼容导出面
- 当前调用方：`scripts/check-formatter-exports.ts`
- 为什么保留：它会直接影响 CI 和本地检查，删掉会破坏现有校验流程

### `formatter-migration.md`

这是 formatter 拆分过程的迁移记录，说明为什么 `formatter.ts` 被收敛成兼容层，以及 family entrypoints 的边界是怎么定下来的。

- 用途：解释 formatter 迁移的背景、顺序和约束
- 为什么保留：当前 README 仍把它作为背景资料入口，而且它对理解 formatter 边界还有持续价值

### `runtime-layering.md`

这是 runtime 分层方向的历史说明，记录了 core、modules、skills、scripts 这些层级最初是如何定义的。

- 用途：补充 runtime 分层的来历
- 当前关系：`docs/architecture-baseline.md` 仍显式引用它
- 为什么保留：虽然今天的现行规则写在 baseline 里，但这份文档仍能解释分层收敛的来源

## 保留标准

以后只有满足下面条件的历史资料，才适合继续放在这里：

- 当前脚本、CI 或检查流程仍直接依赖它
- 它能解释今天仍然有效的架构边界或迁移背景
- 它提供的是“长期背景”，而不是“短期施工步骤”

反过来说，下面这些通常应该删除：

- 临时施工单
- 一次性任务拆解
- 已完成且没有后续参考价值的方案稿
- 只服务某次实现、某次修 bug、某次 agent 执行的计划文档

## 使用原则

- 这里的文档只提供历史背景，不代表当前最新规则
- 当前规则以 `AGENTS.md`、`docs/architecture-baseline.md` 和 active guidelines 为准
- 如果历史文档与现行规则冲突，以现行规则为准
