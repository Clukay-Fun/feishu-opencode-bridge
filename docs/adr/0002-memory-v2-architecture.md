# ADR 0002：Memory v2 工作记忆架构

- **状态**：草案（2026-05-29）
- **关联**：Issue #72、`src/memory/` 现有实现

## 1. 背景与现状

当前 Memory v1 是一个单表系统：一张 `memories` 表存所有用户事实，提取靠 LLM 从对话后抽取，召回靠最近访问排序或 embedding 相似度。它能工作，但有三个结构性问题：

- **分类缺失**：用户偏好、项目事实、待办意图、完成记录全部混在同一张表，召回时无法区分"用户喜欢中文回复"和"下周要发布 v0.3"。
- **召回粗糙**：默认 `recent-retriever` 按访问时间排序倾倒，`embedding-retriever` 按向量相似度返回。两者都不感知当前消息的意图、项目上下文或时间敏感性。
- **无生命周期**：记忆一旦写入就永久存在，没有过期、归档、冲突处理或用户确认机制。

Memory v2 的目标是把"知道什么"（Memory）、"要做什么"（Task）、"做过什么"（Ledger）分离，让系统能自主学习、主动提示、完成留痕，同时保持 v1 数据可用。

## 2. 四子系统职责边界

### Memory（长期事实记忆）

存储用户画像、项目背景、协作偏好、长期约束等稳定事实。生命周期长，召回频率高，写入需去重和冲突检测。

### Task（待办 / 提醒 / Checklist）

存储用户明确或系统推断的待办事项、带时间/条件触发的提醒、可复用检查清单。状态流转：`todo → doing → done / canceled`。到期时参与召回，完成后转入 Ledger。

### Ledger（完成留痕）

存储已完成、已创建、已提醒、已跳过、已取消的事件记录。只写不改，不参与常规召回，用户主动查询时按时间或类型检索。

### Context Orchestrator（召回编排）

每轮 turn 前决定：注入哪些 Memory、提示哪些 Task/Reminder、展示哪些 Checklist 项、是否显示最近 Ledger 摘要。它是决策层，不持有自有数据。

## 3. 数据模型

### memories 表

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',          -- user | project | global
  kind TEXT NOT NULL DEFAULT 'fact',            -- profile | project | preference | constraint | fact
  fact TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'active',        -- active | superseded | archived
  source_message TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  expires_at INTEGER,                           -- NULL = 永不过期
  superseded_by INTEGER REFERENCES memories(id)
);

CREATE INDEX idx_memories_user_kind ON memories(user_id, kind, status);
CREATE INDEX idx_memories_accessed ON memories(user_id, accessed_at DESC);
```

### work_tasks 表

```sql
CREATE TABLE work_tasks (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',          -- todo | doing | done | canceled
  due_at INTEGER,                               -- NULL = 无截止时间
  source TEXT,                                   -- conversation | manual | inferred
  related_memory_ids TEXT,                       -- JSON array of memory IDs
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_user_status ON work_tasks(user_id, status, due_at);
```

### checklists 表

```sql
CREATE TABLE checklists (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  name TEXT NOT NULL,
  reusable INTEGER NOT NULL DEFAULT 0,          -- 0 = 一次性, 1 = 可复用
  items TEXT NOT NULL,                           -- JSON array of { text, checked }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### ledger_events 表

```sql
CREATE TABLE ledger_events (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  type TEXT NOT NULL,                            -- created | reminded | completed | skipped | canceled | archived
  summary TEXT NOT NULL,
  related_task_id INTEGER REFERENCES work_tasks(id),
  related_issue_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_ledger_user_time ON ledger_events(user_id, created_at DESC);
```

TypeScript 接口草案与 SQL 字段一一对应，不重复列出。

## 4. 召回策略

### v1 → v2 召回升级

v1 的两种 retriever 保持可用，v2 新增按 kind 和 scope 过滤的召回路径：

- **recent-only**（v1 默认）：按 `accessed_at DESC` 返回最近 N 条。保留作为 fallback。
- **embedding 相似度**（v1 可选）：按向量距离返回 top-K。保留作为 fallback。
- **v2 相关性召回**：组合以下维度打分：
  - `recency`：`accessed_at` 越近越高（指数衰减）
  - `scope`：同项目/同用户 scope 优先
  - `kind`：当前消息匹配 profile / project / preference / fact 的权重不同
  - `embedding 相似度`：如果可用，加入语义相似度分
  - `status`：`active` > `superseded` > `archived`

### 降级路径

如果 embedding 服务不可用或返回错误，自动回退到 `recent-only + scope/kind 过滤`。不允许 memory 完全断档。

### Task / Reminder 召回

- 未完成 task 且 `due_at <= now` 或 `due_at` 在未来 24h 内：自动提示
- 未完成 checklist 且关联当前项目：自动展示未勾选项
- 最近 7 天 ledger：按需摘要，不自动注入

## 5. 自主学习分类机制

采用**规则 + LLM 辅助的混合分类**：

### 第一层：规则过滤

对话结束后，提取用户消息和 assistant 回复中的候选事实。规则过滤掉：
- 明显的闲聊、问候、重复信息
- 已存在于 memories 表的同义事实（模糊匹配）
- 过短（< 10 字）或过长（> 500 字）的片段

### 第二层：LLM 分类

对通过规则过滤的候选，调用 LLM 分类为 6 种 kind：

| kind | 示例 |
|------|------|
| `profile` | "用户偏好中文回复"、"用户是独立开发者" |
| `project` | "feishu-opencode-bridge 使用 SQLite 存储"、"v0.3 目标是 portable 包" |
| `preference` | "回复不要超过 4 行"、"不要用 emoji" |
| `constraint` | "不要提交 secrets"、"法律扩展默认关闭" |
| `fact` | "用户住深圳"、"用户用 macOS" |
| `task_candidate` | "下周要发布 v0.3"、"需要补回发票缓存" |

`task_candidate` 进入 Task 表，其余进入 Memory 表。

### 冲突检测

新事实写入前，用 embedding 相似度检索已有 memories。如果相似度 > 0.9 且语义冲突，标记旧 memory 为 `superseded`，新 memory 的 `superseded_by` 指向旧 ID。

## 6. v1 → v2 兼容路径

### 数据保留

- v1 的 `memories` 表数据**全部保留**。v2 新增的字段（`scope`、`kind`、`confidence`、`status`、`expires_at`、`superseded_by`）均有默认值，v1 数据无需迁移即可读取。
- v1 的 `memory.db` 文件路径不变。

### 兼容期

- v2 上线后，v1 的 `recent-retriever` 和 `embedding-retriever` 继续作为 fallback 可用。
- v1 的 `extractor` 逻辑被 v2 的"规则 + LLM 分类"替代，但提取结果格式兼容。
- v1 的 `obsidian-sync` 继续工作，只同步 `kind=fact` 的 memories。

### 下线条件

当 v2 相关性召回稳定运行 30 天且无回归，可以将 v1 的 `recent-retriever` 标记为 deprecated，但不删除代码。

## 7. 隐私控制

### 查看入口

- `/memory` 命令：列出当前用户最近 20 条 memories，按 kind 分组
- `/memory all`：列出全部 active memories
- `/tasks`：列出未完成 tasks
- `/ledger`：列出最近 30 天 ledger events

### 定向删除

- `/memory delete <id>`：删除指定 memory
- `/memory delete kind:profile`：删除指定 kind 的全部 memories
- `/task delete <id>`：删除指定 task

### 暂停学习

- `/memory pause`：暂停自动学习，已有 memories 保留但新对话不提取
- `/memory resume`：恢复自动学习

### 确认机制

- 高风险记忆（`kind=constraint`、涉及他人信息）写入前需用户确认
- 确认方式：飞书卡片按钮"确认保存"/"跳过"

### 导出

- `/memory export`：导出为 JSON 文件，包含 memories + tasks + ledger
- 格式：`{ memories: [...], tasks: [...], ledger: [...] }`

## 8. 实现切片建议

### Slice A：数据模型分层 + v1 兼容层

新增 `work_tasks`、`checklists`、`ledger_events` 三张表。在 `MemoryDb` 中扩展 v1 的 `memories` 表字段（`scope`、`kind`、`confidence`、`status`、`expires_at`、`superseded_by`），保持 v1 数据可读。实现 `TaskDb`、`LedgerDb` 基础 CRUD。

依赖：无。风险：v1 数据迁移可能导致 embedding 索引失效。

### Slice B：相关性召回 + 自动学习分类

实现 v2 相关性召回（recency + scope + kind + embedding 组合打分）。实现规则 + LLM 混合分类器。实现冲突检测和 superseded 标记。替换 v1 的 extractor。

依赖：Slice A。风险：LLM 分类准确率需要调优；embedding 降级路径需充分测试。

### Slice C：主动提醒 + 完成留痕

实现 Task 状态流转和到期提醒。实现 Context Orchestrator 在 turn 前注入相关 task/reminder/checklist。实现 ledger 事件写入。

依赖：Slice A。风险：提醒频率过高会打扰用户。

### Slice D：隐私控制入口 + 配置

实现 `/memory`、`/tasks`、`/ledger` 命令。实现暂停/恢复、定向删除、确认机制、导出。更新 `config.json` 的 `memory` 配置 schema。

依赖：Slice A + B。风险：低。

## 9. 被拒绝的备选方案

### 方案 A：所有记忆类型塞一张表，用 `kind` 字段区分

**拒绝理由**：虽然减少了表数量，但 memories、tasks、ledger 的生命周期、召回逻辑、隐私控制完全不同。tasks 有状态流转和到期逻辑，ledger 是只写日志，memories 需要去重和冲突检测。混在一张表会导致查询条件复杂、索引效率低、代码分支混乱。

### 方案 B：v2 上线后立即删除 v1 代码

**拒绝理由**：v1 的 recent-retriever 和 embedding-retriever 已经稳定运行，v2 的相关性召回需要时间验证。立即删除 v1 会导致 v2 出问题时无 fallback。保留 v1 作为降级路径，等 v2 稳定后再 deprecate。

### 方案 C：用外部向量数据库（Pinecone / Milvus）替代 SQLite

**拒绝理由**：引入新依赖增加部署复杂度，与"不引入新依赖"约束冲突。SQLite + FTS5 + 本地 embedding 索引已满足当前规模，未来如果数据量增长再评估。

## 10. 验收清单

- [ ] v1 的 `memories` 表数据在 v2 上线后可正常读取
- [ ] v2 相关性召回支持 recency / scope / kind / embedding 四维度打分
- [ ] embedding 服务不可用时自动降级到 recent-only
- [ ] 自动学习分类覆盖 6 种 kind（profile / project / preference / constraint / fact / task_candidate）
- [ ] 冲突检测：相似度 > 0.9 且语义冲突时标记 superseded
- [ ] Task 状态流转：todo → doing → done / canceled
- [ ] 到期 task 自动提示
- [ ] ledger 事件写入和查询
- [ ] 隐私控制四个入口：查看 / 删除 / 暂停 / 导出
- [ ] 高风险记忆写入前需确认
- [ ] v1 的 obsidian-sync 继续工作
- [ ] 无新外部依赖引入
