# Slice: #65 File Workspace · Slice C · 本地编辑 + 模板能力

依据：`docs/adr/0003-file-workspace-layer.md` 第 4 节 V2、第 9 节 Slice C。

## 目标

为 WorkspaceService 实现本地文档编辑和模板能力：

1. **`WorkspaceService.create(input)`**：基于模板创建本地 .docx / .md 文档
2. **`WorkspaceService.edit(input)`**：对本地 .docx / .md 做局部替换、追加段落、删除章节、插入表格
3. **模板能力**：本地 .docx 模板填充，识别占位符，返回**缺口清单**（缺哪些字段）
4. **复用现有合同助手的 docxtemplater + Python docx 工具链**，不重写底层

## 依赖

- Slice A 必须完成（`WorkspaceService` 入口）

## 范围

### 包含

- 扩展 `src/workspace/service.ts`：
  - `WorkspaceService.create(input: { type, templatePath?, data, outputPath })`
  - `WorkspaceService.edit(input: { inputPath, command, ... })`
- `src/workspace/template.ts`（新建）：
  - 占位符识别（扫描模板内 `{{xxx}}` 或等价语法）
  - 数据填充
  - 缺口清单：模板需要 [a, b, c]，数据只提供 [a, b] → 返回 missing: [c]
- 输出路径限制：写入 `dataDir/workspace-output/`，不写项目根目录（ADR 第 5 节约束）
- 测试覆盖：
  - 创建 .docx（模板填充）
  - 创建 .md
  - 编辑：局部替换 / 追加段落 / 删除章节 / 插入表格 / 插入图片
  - 模板缺口清单返回
  - 输出路径越界拒绝
  - Journal 记录 `create` / `edit` 类型

### 不包含

- **不实现** 云文档读写（Slice D）
- **不暴露** CLI（Slice E）
- **不切换** docxtemplater / Python docx 等底层依赖
- **不删** 现有 contract-assistant 的本地编辑逻辑（继续可用，**不强制迁移到 workspace service**）
- **不实现** PDF 编辑（PDF 是只读，本 slice 不动）
- **不实现** 导出 PDF（属于 Future）

### 行为规则

1. **复用合同助手底层**：现有 docxtemplater 和 Python docx 工具链不重写，workspace service 是上层接口。
2. **输出路径白名单**：所有 create / edit 输出必须在 `dataDir/workspace-output/` 下。越界写入直接拒绝并 Journal `failed`。
3. **缺口清单不报错**：模板字段缺失时返回 `{ outputPath, missing: [...] }`，不抛错。由上层（命令 / agent）决定如何处理。
4. **写操作必须有 inputPath / outputPath 检查**：禁止覆盖系统文件、配置文件、源码文件。
5. **临时文件清理**：编辑过程中的临时副本在操作完成后删除。失败时也要清理。
6. **不强制迁移 contract-assistant**：本 slice 仅暴露能力，contract-assistant 继续用现有逻辑。后续 slice 决定何时迁移。

## 实现步骤

1. 读 Slice A 产物 + 合同助手现有编辑代码
2. 设计 `create` / `edit` 输入参数（参考 ADR CLI 草案）
3. 实现 `WorkspaceService.create()`
4. 实现模板占位符识别 + 缺口清单
5. 实现 `WorkspaceService.edit()` 各 command（replace / append / delete-section / insert-table / insert-image）
6. 输出路径校验
7. Journal 记录
8. 测试

## 验收标准

- [ ] `WorkspaceService.create()` 支持 .docx / .md
- [ ] `WorkspaceService.edit()` 支持 replace / append / delete-section / insert-table / insert-image
- [ ] 模板缺口清单返回结构 `{ outputPath, missing: [...] }`
- [ ] 输出路径越界拒绝
- [ ] 临时文件清理（成功 + 失败两条路径）
- [ ] Journal 记录 create / edit
- [ ] contract-assistant 现有编辑路径未触及
- [ ] typecheck + workspace + contract 测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- workspace
npm test -- contract             # 确认 contract-assistant 现有编辑未回归
git diff src/contract-assistant/ 2>/dev/null  # 应为空
```

## 给执行 Agent 的硬约束

1. **不动 contract-assistant**。现有 docx 编辑、模板填充、Python 工具链一行不动。
2. **输出路径白名单是硬约束**。任何写到 dataDir 之外的代码不允许出现。
3. **缺口清单不抛错**。模板字段缺失是常态，不是异常。
4. **临时文件清理用 try/finally**。
5. **不引入新依赖**。docx 编辑用现有 docxtemplater + Python 工具链。
6. **PDF 是只读**。如果发现自己在写 PDF 编辑代码，说明走错了。
7. **不实现导出 PDF**（属于 Future）。
8. **不强制 contract-assistant 迁移**。仅暴露能力，由后续 slice 决定何时迁移。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. WorkspaceService.create() / edit() 实现位置
4. 模板占位符识别位置
5. 缺口清单返回结构示例
6. 输出路径校验位置
7. 临时文件清理 try/finally 位置
8. contract-assistant 未触及确认
```
