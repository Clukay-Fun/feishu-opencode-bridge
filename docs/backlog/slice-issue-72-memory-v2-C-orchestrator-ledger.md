# Slice: #72 Memory v2 · Slice C · 主动提醒 + 完成留痕

依据：`docs/adr/0002-memory-v2-architecture.md` 第 4 节、第 8 节 Slice C。

## 目标

在 Slice A 数据层之上实现：

1. **Task 状态流转**：`todo → doing → done / canceled` 的状态机
2. **到期提醒**：未完成 task 且 `due_at <= now` 或在未来 24h 内时，自动参与召回
3. **Context Orchestrator**：每轮 turn 前决定注入哪些 Memory / Task / Checklist
4. **Ledger 写入**：状态变化（created / reminded / completed / skipped / canceled / archived）自动写入 ledger

## 依赖

- Slice A 必须完成（三张新表 + CRUD）

可与 Slice B 并行开发，但 Slice B 不存在时 Orchestrator 调用 v1 retriever 即可（不阻塞）。

## 范围

### 包含

- 新建 `src/memory/v2-task-machine.ts` 实现 Task 状态机
  - 合法转移：todo → doing / canceled，doing → done / canceled
  - 任何转移自动写 ledger
- 新建 `src/memory/v2-orchestrator.ts` 实现 Context Orchestrator
  - 输入：当前消息、当前 user / project scope
  - 输出：`{ memories: [...], tasks: [...], checklists: [...], ledgerSummary?: ... }`
- 在 turn 前调用 Orchestrator，把结果作为 `[Memory Recall]` / `[Tasks Due]` / `[Checklist]` 注入 prompt
- 到期检测：Orchestrator 内查询 `work_tasks` where `status IN ('todo', 'doing')` AND `due_at <= now + 24h`
- 提醒触发时写 ledger 事件 `type=reminded`
- Task 完成时（调用 status=done）自动写 ledger `type=completed`，不删除 task（只改状态）
- 测试覆盖：
  - 状态机合法/非法转移
  - 到期触发：`due_at` 已过 / 在 24h 内 / 在 24h 外
  - Orchestrator 输出结构
  - 自动写 ledger
  - 提醒频率控制（同一 task 一天内不重复提醒）

### 不包含

- **不实现** `/memory` `/tasks` `/ledger` 命令（Slice D）
- **不实现** 用户手动暂停 / 删除 / 导出（Slice D）
- **不实现** 高风险确认机制（Slice D）
- **不改** Slice A 的 schema
- **不改** Slice B 的相关性召回（Orchestrator 只是组合 retriever 输出，不重写召回打分）
- **不动** v1 retriever / extractor / obsidian-sync

### 行为规则

1. **状态机严格**：非法转移（如 done → todo）必须抛错或返回 false，不允许静默忽略。
2. **提醒频率控制**：同一 task 在 24h 内不重复提醒。实现方式：查 ledger `type=reminded` AND `related_task_id=X` AND `created_at >= now - 24h`，存在则跳过。
3. **Orchestrator 输出可裁剪**：如果 memories + tasks + checklists 总长度超过 `maxContextChars`（配置项，默认 2000），按优先级裁剪（到期 task > 高 confidence memory > checklist > 历史 memory）。
4. **ledger 只写不改**：所有写入只 append，不 update。
5. **Orchestrator 不持有数据**：所有数据从 Slice A 的 DB 读，Orchestrator 只做决策和组合。

## 实现步骤

1. 读 Slice A 产物
2. 实现 Task 状态机（纯函数 + DB 写入）
3. 实现到期检测查询
4. 实现 Orchestrator 决策逻辑
5. 实现提醒频率控制
6. 接入 turn 前调用（找 turn-executor / runtime 注入点）
7. 测试

## 验收标准

- [ ] Task 状态机：todo → doing → done / canceled 合法，其余抛错
- [ ] 到期 task 自动参与召回
- [ ] Orchestrator 输出 `{ memories, tasks, checklists, ledgerSummary? }`
- [ ] 状态变化自动写 ledger
- [ ] 同一 task 24h 内不重复提醒
- [ ] 上下文超长时按优先级裁剪
- [ ] typecheck + memory 全量测试通过
- [ ] v1 行为未回归

## 验证命令

```bash
npm run typecheck
npm test -- memory
npm test -- app-command-surface     # 确认 turn 注入未破坏其他逻辑
```

## 给执行 Agent 的硬约束

1. **状态机不允许"灵活"**。状态字符串集合固定为 `todo | doing | done | canceled`，不接受其他值，不允许 nullable。
2. **不在 Orchestrator 里做召回打分**——那是 Slice B 的事。Orchestrator 只调用现有 retriever。
3. **提醒频率控制必须用 ledger 查询**，不允许在内存里维护"已提醒列表"（重启会丢）。
4. **任何"用户手动操作"的入口都属于 Slice D**，本 slice 不实现。
5. **Orchestrator 不持有自己的 DB 表**。如果发现需要新表（如"已提醒缓存"），说明设计错了，重新读 ADR。
6. **ledger 只 append**。任何"修改/删除 ledger 事件"的代码不允许出现。
7. **不引入新依赖**。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. 状态机实现位置 + 单测
4. 到期检测查询位置
5. Orchestrator 输入/输出 schema
6. 提醒频率控制实现位置
7. turn 前注入接入点
8. v1 行为未回归确认
```
