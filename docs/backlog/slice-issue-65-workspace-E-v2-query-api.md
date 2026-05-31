# Slice: #65 File Workspace · Slice E v2 · Journal 查询 API 统一与文档

接续 Slice E v1(`slice-issue-65-workspace-E-journal-cli.md`)。v1 实际实现了**单一 `query(options)` 多参数方法**,而原计划/ADR 第 7 节描述的是 `queryByTimeRange / queryByStatus / queryByType / queryByFileName` 四个独立方法。

这是 API 风格不一致(非功能缺失)。本 slice 做最小处理:**保留 `query()` 作为主接口,加 4 个 thin wrapper 满足计划字面接口,同时更新 ADR 反映现实**。这样既不破坏现有调用方,也不留接口期望差。

## 目标

1. 在 `DocumentOperationJournal` 加 4 个 thin wrapper 方法
2. 更新 ADR 0003 第 7 节 / 实现建议章节,把 `queryByXxx` 标为 wrapper,主接口标为 `query(options)`
3. 在 CLI(`bin/files.ts`)的 journal 子命令上保留 v1 现有用法,验证 wrapper 不破坏 CLI

## 依赖

- Slice E v1 已完成(已落地:`query(options)` + CLI + Journal 表)

## 范围

### 包含

#### 1. 加 4 个 wrapper 方法

在 `src/workspace/journal-db.ts` 加:

```ts
/** 按状态查询(wrapper around query)。 */
queryByStatus(status: string, options?: { limit?: number }): DocumentOperationRecord[] {
  return this.query({ status, limit: options?.limit });
}

/** 按操作类型查询。 */
queryByType(operationType: string, options?: { limit?: number }): DocumentOperationRecord[] {
  return this.query({ operationType, limit: options?.limit });
}

/** 按文件名 pattern 查询。 */
queryByFileName(fileName: string, options?: { limit?: number }): DocumentOperationRecord[] {
  return this.query({ fileName, limit: options?.limit });
}

/** 按时间范围查询。 */
queryByTimeRange(from: number, to: number, options?: { limit?: number }): DocumentOperationRecord[] {
  return this.query({ since: from, until: to, limit: options?.limit });
}
```

**全部是 thin wrapper,内部转发到 `query()`。** 不重新实现 SQL,不额外加索引。

#### 2. 测试

在 `test/workspace-journal-query.test.ts` 加 4 个用例,各调用一个 wrapper,验证转发结果与直接调 `query()` 等价。

#### 3. ADR 更新

修改 `docs/adr/0003-file-workspace-layer.md`:

- 第 7 节"CLI 形态草案"末尾加一段:**TypeScript 接口实现细节**,说明 `DocumentOperationJournal` 的查询主接口是 `query(options)`,`queryByXxx` 系列是便捷 wrapper
- 第 9 节 Slice E 描述里把"`queryByTimeRange / queryByStatus / queryByType / queryByFileName`"改为"`query(options)` 主接口 + 4 个 wrapper 方法"

#### 4. CLI 验证

跑一次 v1 已有的 CLI 命令,确认 wrapper 加入后 CLI 行为完全没变:

```bash
npm run files -- journal --status failed --limit 5
npm run files -- journal --since 2026-05-01
```

### 不包含

- **不重新实现** SQL 查询(全部转发到 `query()`)
- **不改** 表结构或索引
- **不改** CLI 子命令
- **不改** `query()` 主方法签名
- **不改** Slice A/B/C/D 任何代码
- **不引入** 新依赖

### 行为规则

1. **wrapper 必须是 thin wrapper**:每个方法 1-2 行,只转发参数。不允许在 wrapper 里加额外逻辑。
2. **主接口仍是 `query(options)`**:wrapper 是为了满足 ADR 字面 API,不取代主接口。
3. **行为等价**:`queryByStatus("failed")` ≡ `query({ status: "failed" })`,所有字段一致。
4. **ADR 更新要明确**:不要把 wrapper 写成"实现细节",要在 ADR 里说明 wrapper 存在的意义(向后兼容 ADR 原 API)。
5. **不动 CLI**:v1 CLI 已经直接调 `query(options)` 或类似,不需要为 wrapper 重写 CLI。

## 实现步骤

1. 在 `journal-db.ts` 加 4 个 wrapper 方法(每个 1-2 行)
2. 在 `workspace-journal-query.test.ts` 加 4 个用例
3. 更新 ADR 0003 第 7 节和第 9 节相关段落
4. 跑 typecheck + workspace 测试
5. 手动跑一次 CLI 验证未回归

## 验收标准

- [ ] 4 个 wrapper 方法存在并转发到 `query()`
- [ ] 每个 wrapper 至少 1 个测试用例
- [ ] ADR 0003 第 7 节加 TypeScript 接口说明
- [ ] ADR 0003 第 9 节 Slice E 描述更新
- [ ] CLI v1 现有命令行为未变
- [ ] `query()` 主接口签名未变
- [ ] typecheck + workspace 测试通过
- [ ] 表结构 / 索引未改
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- workspace
npm run files -- journal --limit 5             # CLI 烟测
npm run files -- journal --status success --limit 3
git diff src/workspace/journal-db.ts | head -30 # 应只见 wrapper 增量
```

## 给执行 Agent 的硬约束

1. **wrapper 必须是 thin wrapper**。每个方法体不超过 2 行(return + 函数调用)。
2. **不重新实现 SQL**。所有 wrapper 转发到 `query()`。
3. **不改 `query()` 主方法**。签名、SQL、参数处理一字不动。
4. **不改表结构 / 索引**。
5. **不改 CLI 子命令**。如果发现自己在动 `bin/files.ts`,说明走错了。
6. **ADR 更新要说明 wrapper 存在的意义**(向后兼容,不仅是实现细节)。
7. **不引入新依赖**。
8. **不动 Slice A/B/C/D 任何代码**。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单(应只有 src/workspace/journal-db.ts、test/workspace-journal-query.test.ts、docs/adr/0003-file-workspace-layer.md)
3. 4 个 wrapper 方法位置 + 每个方法体行数
4. 测试用例位置
5. ADR 0003 更新段落引用
6. CLI 未回归确认(手动烟测输出)
7. query() 主方法未触及确认
```

## 完成后的 issue 状态

此 slice 完成后:

- **#65 issue 的 Slice E 部分完整闭环**
- 配合 Slice B v3 和 Slice C v2 完成,**#65 issue 整体可以 close**
- 剩余的 labor 模块迁移(待 #58 稳定后)、sheets 结构化数据(待 document-pipeline 扩展)可单独开新 issue 跟踪,不阻塞 #65 close
