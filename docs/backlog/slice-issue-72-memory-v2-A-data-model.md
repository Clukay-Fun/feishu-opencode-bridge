# Slice: #72 Memory v2 · Slice A · 数据模型分层 + v1 兼容层

依据：`docs/adr/0002-memory-v2-architecture.md` 第 8 节 Slice A。

## 目标

在不破坏 v1 行为的前提下，为 Memory v2 准备四张表的数据层基础：

- 扩展 v1 `memories` 表字段（`scope` / `kind` / `confidence` / `status` / `expires_at` / `superseded_by`）
- 新建 `work_tasks`、`checklists`、`ledger_events` 三张表
- 实现 `TaskDb` / `LedgerDb` 基础 CRUD（不实现状态流转、不实现召回、不实现命令）

**v1 的所有行为保持不变。** v2 的召回 / 学习 / 命令 / 提醒由后续 Slice B/C/D 承接。

## 范围

### 包含

- `src/memory/` 下 schema 迁移：`ALTER TABLE memories ADD COLUMN ...`，新增 6 个字段，全部有默认值
- 新建 `src/memory/task-db.ts`（或合理路径）实现 `TaskDb`：create / get / list / update / delete
- 新建 `src/memory/ledger-db.ts` 实现 `LedgerDb`：appendEvent / queryByTime / queryByType
- 新建 `checklists` 表的 DAO（位置看现有 db 文件组织习惯，可挂在 `TaskDb` 文件或独立）
- 索引：`idx_memories_user_kind`、`idx_memories_accessed`、`idx_tasks_user_status`、`idx_ledger_user_time`
- 测试覆盖：
  - v1 旧 `memories` 数据在新 schema 下可读，未填字段取默认值
  - 三张新表 CRUD
  - 迁移幂等性：连续 init 两次不报错

### 不包含

- **不实现** v2 相关性召回（Slice B）
- **不实现** 学习分类器（Slice B）
- **不实现** 冲突检测 / `superseded_by` 写入逻辑（Slice B）
- **不实现** Task 状态流转（Slice C）
- **不实现** Context Orchestrator（Slice C）
- **不实现** 任何 `/memory` `/tasks` `/ledger` 命令（Slice D）
- **不动** v1 的 `recent-retriever`、`embedding-retriever`、`extractor`、`obsidian-sync`
- **不删** v1 任何代码或文件
- **不引入** 新依赖

### 行为规则

1. **v1 行为 0 变更**：本 slice 完成后，v1 的 memory 全链路（写入、召回、obsidian 同步）必须与本 slice 前完全一致。回归测试不允许失败。
2. **schema 迁移用 ALTER TABLE 增量**，不允许 `DROP TABLE` + 重建。新字段必须有 DEFAULT 值。
3. **新字段不写入逻辑**：本 slice 内 `scope` / `kind` / `confidence` / `status` 等新字段保持默认值，由 Slice B 的分类器负责填充。
4. **三张新表只暴露 CRUD**：不在本 slice 实现"自动到期检测""ledger 自动归档"等行为。这些是 Slice C 的事。
5. **迁移幂等**：bridge 启动多次不应重复 ALTER 或报"column already exists"。

## 实现步骤

1. **读现状**：`src/memory/db.ts`（或等价文件）、`src/memory/index.ts`、v1 的 schema 初始化逻辑
2. **扩展 memories 表**：增加 6 个新字段 + 2 个新索引；写 migration 函数检测字段是否存在再 ALTER
3. **新建 work_tasks 表** + `TaskDb` CRUD
4. **新建 ledger_events 表** + `LedgerDb` append / query
5. **新建 checklists 表** + DAO
6. **测试**：
   - v1 数据兼容性（用 fixture 模拟 v1 db 文件，启动后字段读取正常）
   - 三张新表 CRUD
   - 迁移幂等

## 验收标准

- [ ] `memories` 表有 6 个新字段，旧数据可读
- [ ] `work_tasks` / `checklists` / `ledger_events` 表存在
- [ ] `TaskDb` / `LedgerDb` 提供基础 CRUD
- [ ] 索引齐全（4 个新索引）
- [ ] 迁移幂等
- [ ] v1 retriever / extractor / obsidian-sync 全部未触及
- [ ] typecheck + 全量 memory 测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- memory
npm test -- knowledge-flow       # 间接确认 v1 行为未回归
git diff src/memory/index.ts src/memory/recent-retriever.ts src/memory/embedding-retriever.ts src/memory/extractor.ts 2>/dev/null   # 应为空
```

## 给执行 Agent 的硬约束

1. **本 slice 是数据层 slice**，不实现任何业务逻辑。所有"哎这里顺手能做"的冲动留给后续 slice。
2. **不动 v1 retriever / extractor / obsidian-sync 文件**。
3. **新字段必须有 DEFAULT 值**，不允许 NOT NULL 无默认。
4. **migration 必须幂等**：用 `PRAGMA table_info()` 或等价方式检测后再 ALTER。
5. **新表 CRUD 只做 CRUD**：不写"到期检测""自动归档"等业务逻辑。
6. **测试必须包含 v1 fixture**：用模拟 v1 db 文件验证兼容。
7. **不引入新依赖**。继续用现有 better-sqlite3 或等价。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单（应在 src/memory/ + test/memory*/）
3. 6 个新字段定义位置（schema 文件 + 行号）
4. 3 张新表创建位置
5. 迁移幂等性测试位置
6. v1 兼容性测试位置
7. v1 文件未触及的 git diff 确认
```
