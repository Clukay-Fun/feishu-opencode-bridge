# Backlog 文档生命周期

`docs/backlog/` 只放仍有执行、审查或维护价值的工作中文档。已完成、纯历史或长期决策材料要及时移动到对应位置。

## 目录约定

```text
docs/backlog/
  active/         # 正在做或下个 sprint 准备做的 slice plan
  completed/      # 已完成的 slice plan，保留验收和复盘价值
  audit-reports/  # audit 报告、差距分析、收口决策矩阵
```

当前根目录下的旧 backlog 文件会按后续文档治理 PR 逐步迁移，不在普通功能 PR 中顺手批量移动。

## 移动规则

- slice 完成后，相关计划移动到 `completed/`。
- audit 报告移动到 `audit-reports/`。
- 仍在执行或准备执行的计划放入 `active/`。
- 完全过时但仍有历史价值的材料移到 `docs/archive/`。
- 影响长期架构和术语的决策写入 `docs/adr/`，不要只留在 backlog。

## 过期信号

- 文档提到的源码路径、命令、配置字段或卡片入口已经不存在。
- 文档里的决策被新 ADR、架构基线或当前实现推翻。
- 文档超过 6 个月无人引用，且不属于 ADR、架构基线、模块说明或历史归档。
- 文档描述的是一次性执行计划，但对应 issue / PR 已完成。

## ADR 规则

ADR 只增不删。某个 ADR 被后续决策取代时，在旧 ADR 顶部添加：

```text
> Superseded by ADR xxxx: <title>
```

然后用新 ADR 记录新的背景、决策、取舍和迁移影响。
