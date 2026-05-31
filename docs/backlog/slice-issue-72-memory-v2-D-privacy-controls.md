# Slice: #72 Memory v2 · Slice D · 隐私控制入口 + 配置

依据：`docs/adr/0002-memory-v2-architecture.md` 第 7 节、第 8 节 Slice D。

## 目标

为 Memory v2 暴露用户可见的隐私控制能力：

1. **查看入口**：`/memory`、`/memory all`、`/tasks`、`/ledger` 命令
2. **定向删除**：`/memory delete <id>`、`/memory delete kind:<kind>`、`/task delete <id>`
3. **暂停/恢复学习**：`/memory pause`、`/memory resume`
4. **确认机制**：高风险记忆（`kind=constraint` 或涉及他人信息）写入前用户确认
5. **导出**：`/memory export` 输出 JSON 含 memories + tasks + ledger
6. **配置 schema**：更新 `config.json` 的 `memory` 配置

## 依赖

- Slice A（数据层）+ Slice B（学习分类，确认机制需要在 classifier 输出后插入）

## 范围

### 包含

- 在 `src/runtime/command-handler.ts` 注册 6 个命令：
  - `/memory` / `/memory all` / `/memory delete ...` / `/memory pause` / `/memory resume` / `/memory export`
  - `/tasks` / `/task delete <id>`
  - `/ledger`
- 命令实现委托到 `src/memory/v2-commands.ts`（新建），不在 command-handler 里写业务逻辑
- 暂停状态持久化（新增 `memory_settings` 表或在现有配置 store 里存 `learning_paused: boolean`）
- 高风险确认：在 Slice B 的 classifier 输出后，对 `kind=constraint` 或检测到他人姓名/联系方式的候选，发飞书卡片"确认保存 / 跳过"
- 导出格式：`{ memories: [...], tasks: [...], ledger: [...] }`，按当前 user_id 过滤
- 配置 schema 更新：在 `src/config/schema.ts` 的 `memory` 节加：
  - `requireConfirmationForKinds: string[]`（默认 `["constraint"]`）
  - `exportFormat: "json"`（暂时单选）
  - `confirmationCardTtlMinutes: number`（默认 30）
- 测试覆盖：
  - 每个命令的成功路径 + 主要错误路径（id 不存在 / 权限错 / 暂停时学习真的暂停）
  - 暂停恢复跨重启持久化
  - 高风险确认：模拟写入触发卡片，确认 / 跳过路径
  - 导出 JSON 结构

### 不包含

- **不改** Slice A/B/C 的核心逻辑
- **不实现** 多用户 ACL（当前一个 user = 一个飞书 openId）
- **不实现** 命令的图形化 UI（飞书卡片够用）
- **不引入** 新存储（暂停状态用现有配置或 memory db）

### 行为规则

1. **暂停状态必须持久化跨重启**。用内存 flag 不算。
2. **删除是真删，不是软删**。`memory delete` 是 SQL DELETE，不是 status=archived。`archived` 是分类器的产物，不是用户删除的产物。
3. **导出是当前用户范围**。不能导出别人的 memories（隐私）。
4. **确认卡 TTL**：默认 30 分钟。超时未确认按"跳过"处理，候选丢弃。
5. **命令解析在 core router**，命令执行在 `v2-commands.ts`。不允许在 router 写业务逻辑。
6. **删除 kind 时给二次确认**：`/memory delete kind:constraint` 会一次性删多条，必须发卡片二次确认。
7. **`/memory pause` 不影响 v2 召回**，只暂停"从对话中学习新事实"。

## 实现步骤

1. 读 Slice A/B 产物 + `src/runtime/command-handler.ts`
2. 设计命令解析（参照现有命令风格）
3. 实现 `src/memory/v2-commands.ts` 各命令
4. 实现暂停持久化
5. 实现确认机制（在 classifier 输出后插入审查层）
6. 实现导出
7. 更新 config schema + loader 默认值
8. 测试

## 验收标准

- [ ] 6 个 `/memory*` + 2 个 `/task*` + 1 个 `/ledger` 命令可用
- [ ] 删除是 SQL DELETE，不是状态变更
- [ ] 暂停状态跨重启保留
- [ ] 高风险写入触发确认卡，确认 / 跳过 / 超时三路径正确
- [ ] 导出 JSON 含 memories / tasks / ledger 三类
- [ ] 配置 schema 增加 3 个字段且有默认值
- [ ] typecheck + 全量测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- memory
npm test -- app-command-surface
npm test -- config
```

## 给执行 Agent 的硬约束

1. **删除是真删**。任何 `status = 'deleted'` 之类的"软删"实现不允许。
2. **command-handler 只做命令解析**。业务逻辑在 `v2-commands.ts`。本规则与 #73 V2 / 现有命令一致，不要破坏分层。
3. **暂停持久化用现有存储**。不允许新建 SQLite 文件。优先在 memory db 里加 `memory_settings` 表（单行），或挂在现有 config persistence。
4. **确认卡 TTL 是配置项**，不要写死 30 分钟。
5. **导出只导出当前用户**。函数签名必须接 user_id，不能默认 "all users"。
6. **`/memory pause` 暂停的是学习入口，不是召回**。不要在 retriever 里检查 `learning_paused`。
7. **不引入新依赖**。
8. **不动 Slice A/B/C 的核心逻辑**。需要时通过新增小函数包装，不修改既有签名。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. 命令注册位置 + 命令实现文件
4. 暂停持久化方案（表名或字段名）
5. 高风险确认卡实现位置 + TTL 配置项位置
6. 导出函数 user_id 过滤位置
7. 配置 schema 新增字段
8. 删除是真删的代码确认（SQL DELETE 语句位置）
```
