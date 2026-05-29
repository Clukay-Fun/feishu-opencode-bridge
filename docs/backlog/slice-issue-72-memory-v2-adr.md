# Slice: Issue #72 Memory v2 架构 ADR（设计阶段，不实现）

## 目标

为 Memory v2 工作记忆系统产出一份完整 ADR，定义：

- 四个子系统的边界（Memory / Task / Ledger / Context Orchestrator）
- 各子系统的数据模型 schema
- 相关性召回策略
- v1 → v2 兼容路径与迁移机制
- 隐私控制入口

**本 slice 只产出设计文档，不写任何业务代码。** v2 的实现工作由后续 4 个 implementation slice（A/B/C/D）承接，每个 slice 由人决定何时启动。

## 范围

### 包含

- 新建 `docs/adr/0002-memory-v2-architecture.md`
- ADR 必须包含以下章节：
  1. 背景与现状（v1 的问题）
  2. 四子系统职责边界（Memory / Task / Ledger / Orchestrator）
  3. 数据模型 schema（SQLite 表设计 + TypeScript 接口草案）
  4. 召回策略（v1 recent-only → v2 相关性召回的方案）
  5. 自主学习的分类机制（如何区分 profile / project / preference / constraint / fact / task / reminder / checklist）
  6. v1 → v2 兼容路径（v1 数据如何保留 / 何时下线）
  7. 隐私控制（查看 / 删除 / 暂停 / 确认 / 导出）
  8. 实现切片建议（推荐的 4 个 implementation slice 拆分）
  9. 被拒绝的备选方案与理由
  10. 验收清单（供后续 implementation slice 自评）
- 更新 `docs/backlog/post-freeze-backlog.md` 索引指向新 ADR
- 在 GitHub issue #72 评论里贴 ADR 摘要

### 不包含

- **不写任何 `.ts` 代码**
- **不动** `src/memory/`、`src/runtime/`、`src/bridge/` 任何文件
- **不动** `mappings.json` / persistence shape / wire shape
- **不实现** Memory v2 任何部分（数据模型、召回、学习、提醒、留痕、隐私控制都不实现）
- **不创建** 新的 SQLite 表
- **不规划** implementation slice 的具体实现步骤（ADR 里只给"推荐拆分"的标题级建议，详细 slice plan 由人在 ADR 通过后另行编写）

### 行为规则

1. **保留 v1**：ADR 必须明确"v1 兼容期"——v2 上线后 v1 数据如何保留、何时下线、是否需要在线迁移。不允许设计成"v2 上线就丢 v1"。
2. **子系统边界硬性分离**：Memory、Task、Ledger 三套数据模型必须独立。不允许 ADR 设计成"一张大表分 kind 字段"。理由：召回逻辑、生命周期、隐私控制都不同。
3. **召回策略必须可降级**：v2 相关性召回如果遇到无可用 embedding / 服务降级，必须能回退到 v1 的 recent-only 行为，不能让 memory 完全断档。
4. **隐私控制是核心章节**，不是附录。必须包含：查看入口、定向删除、暂停学习、确认机制、导出格式。
5. **必须包含被拒绝方案**：至少 2 个被拒绝的备选（如"全部塞一张表""完全替换 v1 不兼容"），写明拒绝理由。
6. **不引入新依赖讨论**：ADR 在数据存储层假设继续用 SQLite + FTS5 + 向量索引，不讨论换 Postgres / Pinecone 等新依赖。

## 实现步骤

### 步骤 1：读现状

- 读 `src/memory/` 当前实现（数据模型、召回路径、turn 前注入逻辑）
- 读 #72 issue 全文（背景、期望行为、建议方案、数据模型草案）
- 读 `docs/architecture-baseline.md` 里 memory 和 shared service 的章节
- 读 `docs/adr/0001-window-session-vocabulary.md` 作为 ADR 写作格式参考

### 步骤 2：起 ADR 草案

按上面 10 个章节写。每章节 200-500 字，**总长度控制在 3000-5000 字**，不要写成万字论文。

### 步骤 3：补关键设计决策

- 数据模型：四张表的字段、索引、唯一约束
- 召回策略：相关性打分维度（recency / scope / kind / 当前消息相似度等的组合）
- 自动学习分类：用一个简单的规则 + LLM 辅助的混合，还是纯 LLM 分类？给一个具体方案
- v1 → v2 迁移：是 lazy migration 还是一次性迁移脚本？

### 步骤 4：写实现切片建议

给出推荐的 4 个 implementation slice 标题（不写步骤）：

- Slice A：数据模型分层 + v1 兼容层
- Slice B：相关性召回 + 自动学习分类
- Slice C：主动提醒 + 完成留痕
- Slice D：隐私控制入口 + 配置

每个 slice 给 2-3 行说明：包含什么、依赖什么、风险点。

### 步骤 5：写验收清单

ADR 末尾给一个"v2 上线验收清单"，列出后续 implementation slice 完成后必须满足的条件（如：v1 数据可读、有 fallback 路径、隐私控制四个入口齐全等）。

### 步骤 6：贴 issue 评论

在 #72 评论里贴 ADR 摘要（不超过 500 字）+ 指向 ADR 文件链接。

## 验收标准

- [ ] `docs/adr/0002-memory-v2-architecture.md` 存在并包含全部 10 个章节
- [ ] 四子系统边界明确，各自有独立数据模型
- [ ] v1 兼容路径有明确方案（不允许"留待后续讨论"）
- [ ] 召回策略包含降级路径
- [ ] 隐私控制章节包含四个入口（查看 / 删除 / 暂停 / 导出）
- [ ] 至少 2 个被拒绝备选方案的说明
- [ ] 实现切片建议为 4 个，每个 2-3 行
- [ ] `git diff src/ test/` 完全空
- [ ] `docs/backlog/post-freeze-backlog.md` 索引已更新
- [ ] GitHub issue #72 有 ADR 摘要评论

## 验证命令

```bash
git status --short                       # 只应出现 docs/ 下变更
git diff src/ test/                      # 必须完全空
ls docs/adr/0002-memory-v2-architecture.md
wc -l docs/adr/0002-memory-v2-architecture.md   # 期望 200-400 行
```

不需要跑 typecheck / test，本 slice 不动代码。

## 给执行 Agent 的硬约束

1. **本 slice 是设计 slice，不是实现 slice**。即使设计过程中觉得"这段实现很简单顺手就做了"，禁止动手。所有实现工作留给后续 4 个 implementation slice。
2. **不动 v1 任何代码**。v1 memory 系统继续运行，不重构、不重命名、不"顺便清理"。
3. **不创建任何 SQLite 表**。schema 定义只在 ADR 里作为文本草案。
4. **不引入新依赖讨论**。继续假设 SQLite + FTS5 + 向量索引。
5. **不写超过 5000 字**。ADR 是决策文档，不是详细设计书。如果某章节写超了，砍。
6. **被拒绝方案不要随便编**。至少 2 个，但必须是真的被讨论后排除的（issue 里隐含或显式提到的），不要凭空造一个稻草人来拒绝。
7. **不规划 slice 内部步骤**。"实现切片建议"章节只写标题 + 2-3 行说明，不写步骤、不写文件路径、不写测试列表。这些留给后续 slice plan。

## 完成总结模板

```
1. ADR 文件路径 + 行数 + 字数
2. 10 个章节是否齐全（一行确认）
3. 四子系统边界一句话摘要
4. v1 → v2 兼容路径一句话方案
5. 推荐的 4 个 implementation slice 标题
6. 已知未决问题（如有）— 留给后续讨论
7. issue 评论链接
```
