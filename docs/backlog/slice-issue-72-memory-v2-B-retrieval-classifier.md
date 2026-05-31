# Slice: #72 Memory v2 · Slice B · 相关性召回 + 自动学习分类

依据：`docs/adr/0002-memory-v2-architecture.md` 第 4 节、第 5 节、第 8 节 Slice B。

## 目标

在 Slice A 数据层基础上实现 v2 的两个核心能力：

1. **v2 相关性召回**：组合 recency / scope / kind / embedding 四维度打分，替换 v1 默认 retriever
2. **自主学习分类**：规则 + LLM 混合分类器，把对话事实分入 6 种 kind（profile / project / preference / constraint / fact / task_candidate）
3. **冲突检测**：相似度 > 0.9 且语义冲突时标记旧 memory 为 `superseded`

v1 的 `recent-retriever` 和 `embedding-retriever` 保留作为 fallback，不删除。

## 依赖

- Slice A 必须完成且已上线（新 schema + 三张新表）

## 范围

### 包含

- 新建 `src/memory/v2-retriever.ts`（或合理路径）实现相关性召回
- 打分函数：组合 `recency`（指数衰减）+ `scope`（同项目/用户优先）+ `kind`（按当前消息匹配的权重）+ `embedding` 相似度（如可用）+ `status`（active > superseded > archived）
- 新建 `src/memory/v2-classifier.ts` 实现规则 + LLM 混合分类
  - 第一层：规则过滤（闲聊 / 重复 / 过短过长）
  - 第二层：LLM 分类到 6 种 kind
  - `task_candidate` 写入 `work_tasks` 表，其余写入 `memories` 表
- 新建 `src/memory/v2-conflict-detector.ts` 实现冲突检测
  - 写入前用 embedding 相似度检索同 user/scope 的 memories
  - 相似度 > 0.9 且语义冲突时，标记旧 memory.status = `superseded`，新 memory.superseded_by 指向旧 ID
- Memory 写入路径切换到 v2 classifier（v1 extractor 保留但默认不调用）
- **召回降级路径**：embedding 服务不可用 / 报错时，自动回退到 `recent-only + scope/kind 过滤`，不允许 memory 完全断档
- 测试覆盖：
  - 四维度打分各自的边界（embedding 缺失、scope 不匹配、status 不同）
  - 6 种 kind 分类（每种至少 1 个 fixture 对话）
  - 冲突检测：相似 + 冲突 → superseded；相似 + 不冲突 → 共存
  - embedding 降级路径

### 不包含

- **不动** Slice A 的 schema 和 CRUD
- **不实现** Task 状态流转（Slice C）
- **不实现** 主动提醒（Slice C）
- **不实现** 任何 `/memory` 命令（Slice D）
- **不删** v1 的 `recent-retriever`、`embedding-retriever`、`extractor`（保留作 fallback）
- **不改** v1 的 obsidian-sync（继续同步 `kind=fact` 的 memories）
- **不引入** 新的 embedding 模型或外部向量库

### 行为规则

1. **embedding 降级是硬性要求**：任何场景下 embedding 不可用，召回必须能继续工作。测试必须包含 embedding 故意失败的场景。
2. **LLM 分类失败 fallback**：LLM 分类报错或返回非 6 种 kind 之一时，默认归为 `fact`，不丢候选。
3. **冲突检测只在写入路径触发**：不在召回路径做实时冲突检测（性能考虑）。
4. **相似度阈值 0.9 写死为常量**，便于未来调优。不在本 slice 内做"动态阈值"。
5. **写入候选必须经过两层规则**：规则过滤 → LLM 分类。直接绕过规则的写入入口不允许保留。

## 实现步骤

1. 读 Slice A 产物 + v1 retriever / extractor
2. 实现 v2 打分函数（纯函数，可单测）
3. 实现 v2 retriever（调用打分函数 + 数据访问）
4. 实现规则过滤层
5. 实现 LLM 分类层（含 fallback）
6. 实现冲突检测
7. 把写入入口切到 v2 classifier
8. 召回入口默认走 v2，降级回 v1
9. 测试

## 验收标准

- [ ] v2 相关性召回支持 recency / scope / kind / embedding 四维度打分
- [ ] embedding 不可用时自动降级到 recent-only
- [ ] 6 种 kind 分类覆盖完整（test fixture 各至少 1 条）
- [ ] 冲突检测：相似度 > 0.9 且冲突时标 superseded
- [ ] v1 retriever / extractor 保留可调用
- [ ] obsidian-sync 行为未变（继续同步 `kind=fact`）
- [ ] typecheck + memory 全量测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- memory
npm test -- knowledge-flow

# 手动验证（可选）：
# 1. 关闭 embedding 服务，发一条对话，确认 memory 仍能召回
# 2. 触发两条冲突事实，确认旧的被 superseded
```

## 给执行 Agent 的硬约束

1. **降级路径必须有单测**。不允许只在代码里写 `try { ... } catch { fallback }` 就算数。
2. **不删 v1 文件**。`recent-retriever.ts`、`embedding-retriever.ts`、`extractor.ts` 一行不动。
3. **LLM 调用必须有超时和错误处理**。LLM 慢 / 失败时 fallback 到 `fact`，不阻塞对话。
4. **相似度阈值 0.9 是 ADR 决策**，不要在 slice 内调成"自适应"。
5. **写入路径只允许一个入口**：v2 classifier。不允许保留多个写入入口给上层"按需选择"。
6. **不引入新依赖**。embedding 继续用项目现有方案。
7. **任何"顺手把 v1 清理一下"的冲动忽略**——v1 下线条件在 ADR 第 6 节明确写了"v2 稳定运行 30 天后"，不是本 slice 的事。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. 四维度打分实现位置 + 单测位置
4. 6 种 kind 分类测试 fixture 位置
5. embedding 降级路径单测位置
6. 冲突检测单测位置
7. v1 文件未触及确认
```
