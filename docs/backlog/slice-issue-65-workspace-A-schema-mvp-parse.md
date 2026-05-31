# Slice: #65 File Workspace · Slice A · 标准化 schema + MVP 读/解析

依据：`docs/adr/0003-file-workspace-layer.md` 第 3 节、第 4 节、第 9 节 Slice A。

## 目标

为 File/Document Workspace 能力层落地最小可执行版本：

1. **定义 `WorkspaceParseResult` 接口**（ADR 第 3 节 schema）
2. **`WorkspaceService.parse()`**：包装 `parseKnowledgeFile()`，返回标准化结果
3. **覆盖类型**：PDF / DOCX / TXT / MD / XLSX / CSV / PNG / JPG
4. **输入来源**：本地绝对路径、飞书上传文件、zip 压缩包
5. **新增 `document_operations` Journal 表**
6. **权限校验**：复用 `material-support.ts` 的扩展名白名单和大小限制

**纯包装层，不改 document-pipeline 任何底层逻辑。**

## 范围

### 包含

- 新建 `src/workspace/` 目录（或合理位置）
  - `src/workspace/types.ts`：`WorkspaceParseResult` 接口完整定义（meta / content / parse / journal 四层）
  - `src/workspace/service.ts`：`WorkspaceService.parse(input)` 实现
  - `src/workspace/journal-db.ts`：Document Operation Journal 的 CRUD
  - `src/workspace/index.ts`：模块出口
- `document_operations` 表创建 + 索引（ADR 第 6 节 schema）
- `WorkspaceService.parse()` 实现：
  - 接受 `input: { path?: string; buffer?: Buffer; fileName: string; source: ... }`
  - 校验扩展名白名单和大小（复用 `material-support.ts`）
  - 内部调用 `parseKnowledgeFile()`（document-pipeline 现有函数）
  - 把 `ParsedDocument` 映射成 `WorkspaceParseResult`
  - 写 Journal（success / partial / failed）
- zip 输入：解压后递归调用 parse，返回 array
- 测试覆盖：
  - 8 种类型各至少 1 个 fixture
  - 本地路径、buffer、zip 三种输入
  - 扩展名不在白名单 → 拒绝并写 Journal `failed`
  - 大小超限 → 拒绝
  - 解析失败 → Journal `failed` 记录 warning
  - Journal 表 CRUD

### 不包含

- **不实现** OCR（Slice B）
- **不实现** 本地编辑 / 模板（Slice C）
- **不实现** 云文档读写（Slice D）
- **不暴露** CLI（Slice E）
- **不改** `src/document-pipeline/` 任何文件
- **不改** `src/knowledge/`、`src/contract-assistant/`、`src/labor/` 现有调用路径（让它们继续直接调用 document-pipeline，本 slice 不强制迁移）
- **不引入** 新依赖（zip 解压用 Node 内置或现有依赖）

### 行为规则

1. **纯包装层**：document-pipeline 一行不动。WorkspaceService 是上层接口，底层由 document-pipeline 出力。
2. **Journal 写入失败不阻塞解析**：Journal 是观测层，DB 写错只记 logger.warn，不抛错。
3. **schema 字段全填**：`WorkspaceParseResult` 的 meta / parse 区必填字段（fileName、extension、size、source、used、quality、elapsedMs）不能为空。content 区可选。
4. **复用现有白名单**：不在本 slice 重新定义白名单常量。从 `material-support.ts` 引用。
5. **zip 输入处理**：解压到临时目录，处理完删除。不允许残留。
6. **错误分类**：拒绝（白名单/大小）→ Journal `failed` + WARNING；解析失败 → Journal `failed` + ERROR；部分成功 → Journal `partial`。
7. **不强制迁移现有调用方**：现有 knowledge / contract / labor 继续直调 document-pipeline，本 slice 不动它们。后续 slice 决定何时迁移。

## 实现步骤

1. 读 `src/document-pipeline/index.ts`（`parseKnowledgeFile` 签名 + `ParsedDocument` 类型）
2. 读 `src/runtime/material-support.ts`（白名单 + 大小限制）
3. 定义 `WorkspaceParseResult` 接口（types.ts）
4. 创建 Journal 表 + DAO
5. 实现 `WorkspaceService.parse()`（service.ts）
6. zip 解压逻辑
7. 测试

## 验收标准

- [ ] `WorkspaceParseResult` 接口包含 meta / content / parse / journal 四层
- [ ] `WorkspaceService.parse()` 覆盖 PDF / DOCX / TXT / MD / XLSX / CSV / PNG / JPG
- [ ] 输入来源支持本地路径 / buffer / zip
- [ ] 白名单 + 大小校验生效
- [ ] Journal 表创建，每次 parse 有记录
- [ ] document-pipeline 文件未触及（git diff src/document-pipeline/ 为空）
- [ ] knowledge / contract / labor 调用路径未触及
- [ ] typecheck + workspace 全量测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- workspace
npm test -- knowledge-flow         # 确认 document-pipeline 行为未回归
npm test -- contract               # 确认合同助手未回归
npm test -- labor                  # 确认劳动模块未回归
git diff src/document-pipeline/ src/knowledge/ src/contract-assistant/ src/labor/ 2>/dev/null  # 应为空
```

## 给执行 Agent 的硬约束

1. **本 slice 是包装层 slice**。document-pipeline、knowledge、contract、labor 一行不动。
2. **不实现任何 V2/Future 能力**。OCR、编辑、模板、云文档、CLI 都不在本 slice。
3. **Journal 失败不阻塞**：用 try/catch + logger.warn，不抛错给上层。
4. **白名单复用**：从 `material-support.ts` 引用 `SUPPORTED_MATERIAL_EXTENSIONS`，不另定义。
5. **zip 解压必须清理临时文件**。用 try/finally 保证。
6. **接口 schema 完整**：即使本 slice 不填某些字段（如 attachments），也要在 types.ts 里声明完整。
7. **不引入新依赖**。zip 用 Node 内置（如果不行用项目已有依赖）。
8. **不强制现有模块迁移**。本 slice 后，knowledge / contract / labor 继续按原方式调 document-pipeline。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单（应只在 src/workspace/ + test/workspace*/）
3. WorkspaceParseResult 接口定义位置 + 字段清单
4. Journal 表创建位置
5. 8 种类型测试 fixture 位置
6. 白名单复用引用位置
7. zip 清理逻辑位置（try/finally）
8. 现有模块未触及确认（git diff 输出空）
```
