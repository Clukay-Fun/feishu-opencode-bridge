# Slice: Issue #60 旧工作台分支残留能力 Audit

## 目标

对旧分支 `codex/workbench-followups` 中的 5 项残留能力逐条做"是否仍需补回"的判定，产出一份决策矩阵并落入 issue。**本 slice 只做审查与决策，不重新实现任何能力。** 实现工作（如有）由后续独立 slice 承接，每项一个 PR。

## 范围

### 包含

- 检出旧分支 `codex/workbench-followups`，与当前 `main` 做对比
- 逐项判定下列 5 项的状态：仍需补回 / 已被 #59 覆盖 / 不再需要
  1. 发票识别缓存与本地字段优先复用
  2. 发票目录批量识别与进度心跳
  3. 飞书卡片 URL verification 回调直返 challenge
  4. 设计器按钮缺少真实 URL 时删除按钮、外部链接按钮使用 `open_url` 行为
  5. 合同助手调试记录文档是否仍需补回
- 产出审查报告 `docs/backlog/issue-60-audit-report.md`，含每项的：当前状态 / 决策 / 理由 / 如需补回的实现思路要点
- 在 GitHub issue #60 评论里贴决策摘要
- 删除本地对 `codex/workbench-followups` 分支的依赖（如果有引用文档或注释指向它）

### 不包含

- **不合并** `codex/workbench-followups` 整支分支
- **不 cherry-pick** 任何旧代码块（即使该项判定为"仍需补回"，也由后续 slice 在当前 main 架构上重新实现）
- 不在本 slice 内修复任何已判定为"仍需补回"的能力
- 不动 `src/runtime`、`src/feishu`、`src/bridge` 主流程代码（这是审查 slice，不是实现 slice）
- 不删除 `codex/workbench-followups` 远程分支本身（保留作为审查证据）
- 不开展超出上述 5 项之外的"顺手清理"

### 行为规则

1. **不动代码原则**：本 slice 唯一可写的文件是新建的 `docs/backlog/issue-60-audit-report.md`，以及（如有需要）`docs/backlog/post-freeze-backlog.md` 的更新指向。
2. **逐项判定原则**：5 项必须每项一个判定，不能合并为"整体覆盖了"或"整体没用"。
3. **当前 main 优先**：判定"已被覆盖"时，必须在报告里指出 main 上的对应文件路径或 commit/PR 号，作为佐证。
4. **重实现成本估算**：对判定为"仍需补回"的项，报告里给出粗略实现复杂度（小 < 0.5 周 / 中 0.5-1 周 / 大 > 1 周），不要给精确工时。
5. **不引申**：发现旧分支里的其他能力（不在 5 项清单内），不在本报告里展开。如果确实重要，记一条 "follow-up audit candidates" 列出来供未来评估，不延伸本 slice。

## 实现步骤

### 步骤 1：拉取并对照旧分支

```bash
git fetch origin codex/workbench-followups:codex/workbench-followups
git log main..codex/workbench-followups --oneline
git diff main...codex/workbench-followups --stat
```

不要 checkout 到该分支工作；只用于对比阅读。

### 步骤 2：逐项审查

每项按下面三问回答：

1. **旧分支里这项功能的具体实现位置和形态是什么？**（文件、关键函数、所依赖的旧架构）
2. **当前 main 里有没有等价或部分覆盖？**（指出文件/PR/commit）
3. **决策**：仍需补回 / 已覆盖 / 不再需要 — 给出一句话理由

### 步骤 3：产出报告

新建 `docs/backlog/issue-60-audit-report.md`，结构：

```markdown
# Issue #60 工作台残留能力审查报告

审查日期：YYYY-MM-DD
对照分支：codex/workbench-followups @ <commit>
当前 main：@ <commit>

## 决策摘要

| # | 能力项 | 决策 | 重实现复杂度 |
|---|--------|------|--------------|
| 1 | 发票识别缓存与本地字段优先复用 | 仍需补回 / 已覆盖 / 不再需要 | — |
| 2 | 发票目录批量识别与进度心跳 | … | — |
| 3 | 飞书卡片 URL verification 回调直返 challenge | … | — |
| 4 | 设计器按钮 URL 缺失处理 + open_url 行为 | … | — |
| 5 | 合同助手调试记录文档 | … | — |

## 逐项详述

### 1. 发票识别缓存与本地字段优先复用

- **旧分支位置**：`<path>:<line>`，关键实现要点：...
- **当前 main 状态**：...
- **决策**：...
- **理由**：...
- **如需补回**：实现思路要点（不写代码），预估复杂度

（其余 4 项同上格式）

## Follow-up audit candidates（如有）

旧分支里发现的其他可能值得评估的能力，仅列名，不展开。
```

### 步骤 4：在 issue #60 评论决策摘要

把上面"决策摘要"表格贴到 #60 评论区，并加一句"详见 `docs/backlog/issue-60-audit-report.md`"。

### 步骤 5：更新 backlog 索引

如果 `docs/backlog/post-freeze-backlog.md` 里有指向 `codex/workbench-followups` 的条目，更新指向新审查报告。

## 验收标准

- [ ] `docs/backlog/issue-60-audit-report.md` 存在并包含 5 项决策
- [ ] 每项决策三选一明确：仍需补回 / 已覆盖 / 不再需要
- [ ] "已覆盖"项必须指出 main 上的对应文件路径或 PR/commit 号
- [ ] "仍需补回"项给出粗略复杂度（小/中/大）
- [ ] GitHub issue #60 有决策摘要评论
- [ ] **没有任何代码改动**（除 docs/ 下新文件外）
- [ ] 工作树仅新增 docs 文件，`git status --short` 应只有 `?? docs/backlog/issue-60-audit-report.md` 以及 docs/backlog/post-freeze-backlog.md 的可能修改

## 验证命令

```bash
# 确认没有动代码
git status --short
git diff --stat                          # 应该只有 docs/ 下变更
git diff src/ test/                      # 应该完全空

# 确认报告产出
ls docs/backlog/issue-60-audit-report.md
wc -l docs/backlog/issue-60-audit-report.md

# 不需要跑 typecheck / test，因为没改代码
```

## 给执行 Agent 的硬约束

1. **本 slice 是审查 slice，不是实现 slice**。任何"既然看到了顺便修一下"的冲动必须忽略。
2. **每项都要回到 main 上找对应实现**，不要凭印象判断"应该已经有了"。判定"已覆盖"时如果找不到对应文件路径，就标"不确定，建议进一步评估"，不要硬下结论。
3. **不展开任何能力的重实现**。即使某项判定为"仍需补回"且复杂度小，本 slice 也不允许实现。后续 slice 由人决定何时启动。
4. **报告语言保持中性**：陈述事实和决策，不要在审查报告里加营销性表述或"未来愿景"。
5. **遇到判断不了的情况就标 "不确定"**，不要硬猜。审查报告的价值在于诚实，不在于看起来全部决定了。

## 完成总结模板

完成后给出符合以下结构的总结：

```
1. 跑的验证命令 + 输出
2. 产出文件清单（应该只有 docs/backlog/issue-60-audit-report.md ± backlog 索引更新）
3. 5 项决策一句话摘要
4. 已知的"不确定"项（如有）
5. 建议的下一步 slice（如有"仍需补回"项，列出建议的实现优先级）
```
