# Slice: #65 File Workspace · Slice E · Journal 查询 + CLI 暴露

依据：`docs/adr/0003-file-workspace-layer.md` 第 6 节、第 7 节、第 9 节 Slice E。

## 目标

1. **完善 Document Operation Journal 查询接口**：按时间 / 状态 / 类型 / 文件名查询
2. **暴露 `npm run files --` CLI**：让 OpenCode 和外部脚本可以直接调用 WorkspaceService

## 依赖

- Slice A 必须完成（Journal 表 + `WorkspaceService.parse()`）
- 建议 Slice B/C/D 至少完成 1 个（让 CLI 有意义的命令可暴露）

## 范围

### 包含

- `src/workspace/journal-db.ts` 扩展：
  - `queryByTimeRange(from, to)`
  - `queryByStatus(status)`
  - `queryByType(operation_type)`
  - `queryByFileName(pattern)`
  - 组合查询（按时间 + 状态等）
  - 分页（`limit` / `offset`）
- 新建 `bin/files.ts`（或 `scripts/files.ts`）：
  - `npm run files -- read --input <path>` → 调用 `WorkspaceService.parse()`，输出 JSON
  - `npm run files -- parse --input <path> --format markdown` → 输出 Markdown
  - `npm run files -- journal --status failed --limit 20` → 查 Journal
  - `npm run files -- journal --since 2026-05-01`
  - 如 Slice C 已完成：`npm run files -- create --type docx --from-template ... --data ...`
  - 如 Slice D 已完成：`npm run files -- fetch-feishu-doc --url ...`
- `package.json` 添加 `"files": "tsx bin/files.ts"` script
- CLI 错误输出格式统一（exit code + JSON error message）
- 测试覆盖：
  - Journal 查询每种条件
  - CLI 命令成功路径
  - CLI 错误路径（参数缺失 / 文件不存在 / 解析失败）

### 不包含

- **不实现** MCP 协议封装（属于 ADR 提到的"未来"）
- **不暴露** 写权限较高的命令（如批量 update-feishu-doc）作为 CLI 默认能力——需要明确单条命令
- **不改** Slice A/B/C/D 的核心逻辑
- **不引入** 新的 CLI 框架（如 commander / yargs），用 Node 内置 `process.argv` 或现有 `npm scripts` 风格

### 行为规则

1. **CLI 是 OpenCode 可调用方式之一，不是唯一**：TypeScript service 仍然是主要调用方式。CLI 不强求每个 service 方法都有命令。
2. **CLI 错误输出 JSON**：失败时 `process.exit(1)` + 输出 `{ error: ..., detail: ... }` 到 stderr。便于 OpenCode 解析。
3. **CLI 默认输出 JSON**，可加 `--format markdown` 或 `--format text` 切换。
4. **Journal 查询有 limit 默认值**：不传 limit 时默认 50，最大 500。避免误查全表。
5. **CLI 不允许写危险操作的默认**：`update-feishu-doc` 没有 `--confirm` 时不执行，避免误触。
6. **不引入交互式 CLI**：所有参数从 argv 传入，不弹 prompt 问用户。

## 实现步骤

1. 读 Slice A 的 Journal 表 + DAO
2. 扩展 Journal 查询方法
3. 设计 CLI 命令分发（一个主入口 + 子命令）
4. 实现各子命令（按 Slice A/B/C/D 已完成的能力）
5. 错误输出格式统一
6. `package.json` 加 script
7. 测试

## 验收标准

- [ ] Journal 支持按 time / status / type / fileName 查询
- [ ] Journal 查询支持分页
- [ ] `npm run files -- <subcommand>` 可用
- [ ] CLI 子命令覆盖：read / parse / journal（Slice B/C/D 完成的对应加 ocr / create / edit / fetch-feishu-doc / update-feishu-doc）
- [ ] CLI 错误输出 JSON 到 stderr + exit code 非 0
- [ ] update-feishu-doc 等危险命令需要 `--confirm`
- [ ] typecheck + workspace 测试通过
- [ ] 无新 CLI 框架依赖

## 验证命令

```bash
npm run typecheck
npm test -- workspace
npm run files -- read --input README.md      # 简单 smoke test
npm run files -- journal --limit 5
npm run files -- journal --status failed --limit 10
```

## 给执行 Agent 的硬约束

1. **不引入 commander / yargs / oclif 等 CLI 框架**。用 `process.argv` 手写解析。
2. **CLI 主入口只做分发**，业务逻辑停在 `WorkspaceService`。
3. **Journal 查询默认 limit 50**，不允许默认全表扫描。
4. **危险命令必须有 `--confirm`**。update-feishu-doc / overwrite / 大批量删除等。
5. **错误输出必须能被解析**：JSON 到 stderr，exit code 非 0。不允许只 console.error 字符串。
6. **不实现 MCP**。MCP 是 ADR 提到的未来方向，不在本 slice。
7. **不实现交互式 prompt**。所有参数 argv 传入。
8. **不引入新依赖**。

## 完成总结模板

```
1. 跑的验证命令 + 输出（含 smoke test）
2. 变更文件清单
3. Journal 查询接口扩展位置
4. CLI 主入口文件
5. CLI 子命令清单（依据 Slice B/C/D 完成情况）
6. 错误输出格式确认（JSON to stderr + non-zero exit）
7. --confirm 守护的危险命令清单
```
