# Slice: #65 File Workspace · Slice D · 云文档编辑封装

依据：`docs/adr/0003-file-workspace-layer.md` 第 4 节 V2、第 9 节 Slice D。

## 目标

把 `lark-cli docs/sheets/base/drive` 的飞书云文档能力封装成 `WorkspaceService` 的统一接口：

1. **`WorkspaceService.fetchFeishuDoc(url)`**：读取飞书 Docx / Wiki / Sheet / Base
2. **`WorkspaceService.updateFeishuDoc(url, command)`**：创建 / 追加 / 覆盖 / 局部替换 / 按标题插入
3. **写操作前保留原文快照**到 Journal，支持回滚提示

## 依赖

- Slice A 必须完成（`WorkspaceService` 入口 + Journal 表）
- lark-cli 已安装可用

## 范围

### 包含

- 扩展 `src/workspace/service.ts`：
  - `WorkspaceService.fetchFeishuDoc(url): Promise<WorkspaceParseResult>` —— 把云文档读成标准 schema
  - `WorkspaceService.updateFeishuDoc(url, command)` —— 写云文档
- 支持的写 command：
  - `create`（新建 docx / sheet）
  - `append`（追加内容）
  - `overwrite`（覆盖）
  - `replace`（局部替换）
  - `insertByHeading`（按标题插入）
  - `insertTable` / `insertImage`（可选，如 lark-cli 支持）
- URL 解析：识别 Docx / Wiki / Sheet / Base URL，路由到对应 lark-cli 命令
- **写前快照**：所有写操作前先 `fetchFeishuDoc` 读原文 → 存 Journal `previous_content` 字段
- 失败降级：lark-cli 不可用 / 命令报错时 → Journal `failed` + warning，不抛给上层（返回 result.parse.quality = "low" + warning）
- 测试覆盖：
  - 读 Docx / Wiki / Sheet / Base 四种类型
  - 写 5 种 command 各至少 1 个 fixture
  - 写前快照存 Journal
  - lark-cli 不可用降级
  - URL 解析错误（不是飞书云文档 URL）的处理

### 不包含

- **不重写** lark-cli（继续作为外部依赖）
- **不实现** 本地编辑（Slice C）
- **不实现** Journal 查询接口（Slice E）
- **不暴露** CLI（Slice E）
- **不实现** 云文档模板（Future）
- **不实现** 回滚操作本身（只存快照，回滚由后续 slice 或人工操作做）

### 行为规则

1. **快照存 Journal**：写前必须读原文存到 `document_operations.detail` 或新增字段 `previous_snapshot`。本 slice 决定挂哪个字段（推荐 detail JSON 中包含 snapshot 摘要 + Journal 关联 ID 指向原文 fetch 操作）。
2. **写操作需要用户明确指令**：本 slice 暴露的是接口，业务层调用时必须有明确写指令（不允许"AI 自动猜测要不要写"）。这条规则由调用方负责，本 slice 在接口文档里写明即可。
3. **URL 必须验证**：解析失败的 URL → Journal `failed` + warning，不静默成功。
4. **lark-cli 版本检测**：启动时检测 lark-cli 是否可用，不可用时所有 fetch/update 方法返回降级结果，logger.warn 提示用户。
5. **附件写入限制**：本 slice 不实现"上传本地文件到云文档作为附件"，只做文本/表格内容写入。
6. **冪等性**：相同的 `create` 调用不应重复创建。可用 idempotency key（如 `operation_id`）防重。

## 实现步骤

1. 读 Slice A 产物 + lark-cli docs/sheets/base 命令清单
2. URL 解析（Docx / Wiki / Sheet / Base 各自正则或 URL parser）
3. 实现 `fetchFeishuDoc()` 路由到 lark-cli 对应命令
4. 实现 `updateFeishuDoc()` 路由 + 写前快照
5. lark-cli 调用封装（subprocess + 超时）
6. 降级路径
7. 测试

## 验收标准

- [ ] `fetchFeishuDoc()` 支持 Docx / Wiki / Sheet / Base
- [ ] `updateFeishuDoc()` 支持 5 种 command
- [ ] 写前快照存 Journal
- [ ] lark-cli 不可用降级路径
- [ ] URL 解析错误返回 warning + Journal `failed`
- [ ] 幂等性（相同 operation_id 不重复创建）
- [ ] typecheck + workspace 测试通过
- [ ] 无新依赖（lark-cli 是已有依赖）

## 验证命令

```bash
npm run typecheck
npm test -- workspace
# 手动验证（如有飞书 sandbox）：
# 1. fetchFeishuDoc 一个测试 docx → 输出 Markdown
# 2. updateFeishuDoc append → 飞书侧确认追加成功
# 3. lark-cli 临时改名模拟不可用 → 确认降级路径
```

## 给执行 Agent 的硬约束

1. **不重写 lark-cli**。所有飞书云文档能力委托给 lark-cli subprocess。
2. **不实现回滚**。本 slice 只存快照，回滚是后续动作。
3. **写前快照是硬约束**。任何 update 命令在执行前必须先 fetch 一份存 Journal。
4. **lark-cli 调用必须有超时**。默认 60s，避免挂死。
5. **subprocess 错误必须被捕获**。lark-cli 报错不能直接抛给上层。
6. **不在本 slice 实现"AI 自动决定何时写云文档"**。接口暴露给上层，上层有明确指令时才调用。
7. **不引入新依赖**。
8. **附件 / 文件上传不在本 slice**。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. fetchFeishuDoc / updateFeishuDoc 实现位置
4. URL 解析支持的类型清单
5. 写前快照存储字段位置
6. lark-cli 降级路径单测位置
7. 幂等性实现方式
8. lark-cli 调用超时配置位置
```
