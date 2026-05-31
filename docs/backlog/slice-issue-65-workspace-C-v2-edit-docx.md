# Slice: #65 File Workspace · Slice C v2 · 补齐 edit() 命令 + docx 模板

接续 Slice C v1(`slice-issue-65-workspace-C-local-edit-template.md`)。v1 完成了 `create()`、`edit(append|replace)` 和文本模板 `{{var}}`,但**漏了 3 个 edit 命令和 docx 模板**。本 slice 补齐到 C 闭环。

## 目标

把 `WorkspaceService.edit()` 和 `template.ts` 补齐到 ADR 第 4 节 V2 的完整能力:

1. **`edit()` 补 3 个命令**:`delete-section` / `insert-table` / `insert-image`
2. **docx 模板填充**:复用合同助手现有的 docxtemplater 工具链,把 `.docx` 模板按数据填充并返回缺口清单
3. **测试覆盖**:每个新命令 + docx 模板至少 1 个 fixture

## 依赖

- Slice C v1 已完成(已落地:`create()` + `edit(append|replace)` + 文本模板)
- 合同助手现有的 docxtemplater + Python docx 工具链稳定

## 范围

### 包含

#### 1. `edit()` 命令扩展

修改 `src/workspace/service.ts:306` `edit()` 方法的 `command` 类型签名,新增 3 个:

```ts
command: "append" | "replace" | "delete-section" | "insert-table" | "insert-image"
```

各命令语义:

- **`delete-section`**:按标题(Markdown `#` / `##` 或 docx 段落级别)删除整章,需要 `target: string`(标题名)
- **`insert-table`**:在 `target`(锚点文字 / 标题)之后插入表格,需要 `content` 为 `{ headers: string[]; rows: string[][] }` 的 JSON 字符串
- **`insert-image`**:在 `target` 之后插入图片,需要 `content` 为图片本地路径

支持文件类型:`.md`(全部 5 个命令)+ `.docx`(全部 5 个命令)

#### 2. docx 模板支持

新建 `src/workspace/docx-template.ts`:

- `fillDocxTemplate(templatePath, data, outputPath)` —— 调用合同助手现有的 docxtemplater 包装(或 Python docx 工具)
- 返回与 `TemplateGapAnalysis` 同形态的结果:`{ allPlaceholders, providedFields, missingFields, outputPath }`
- 占位符语法保持合同助手现有约定(通常 `{xxx}` 或 `{{xxx}}`)

修改 `src/workspace/service.ts` 的 `create()`:

```ts
async create(input: {
  type: "docx" | "md";
  templatePath?: string;
  data: Record<string, string>;
  outputPath?: string;
}): Promise<{ outputPath: string; missingFields: string[] }>
```

- `type: "md"` + `templatePath`:走现有 `loadAndFillTemplate`(文本模板)
- `type: "docx"` + `templatePath`:走新增 `fillDocxTemplate`
- 缺口清单字段 `missingFields` 在两条路径上行为一致

#### 3. 复用合同助手工具链

- **不重写** 合同助手的 docxtemplater 包装。从 `src/contract-assistant/` 找到现有的 docx 模板填充实现,在 `docx-template.ts` 里 import 或转用
- 如果合同助手没有暴露公共函数,在合同助手模块加一个最小的 public export(不重命名、不重构内部逻辑)
- 合同助手现有的发票模板 / 合同模板填充路径**继续按原逻辑跑**,本 slice 不改它们

#### 4. 测试

- `test/workspace-service.test.ts` 扩展:每个新 edit 命令至少 1 个 .md fixture + 1 个 .docx fixture
- `test/workspace-template.test.ts` 扩展:docx 模板填充 + 缺口清单
- 至少 1 个用例验证 `create({type: "docx"})` 调用了合同助手的工具链(用 spy)

### 不包含

- **不重写** 合同助手的 docxtemplater 包装(只复用)
- **不实现** PDF 编辑(PDF 在 workspace 是只读)
- **不实现** 导出为 PDF(属于 Future)
- **不实现** 云文档模板(属于 Future)
- **不动** Slice A/B/D/E 的现有代码
- **不动** 合同助手现有的发票 / 合同模板填充路径
- **不引入** 新依赖(docxtemplater 应该已经是合同助手的依赖)

### 行为规则

1. **复用,不重写**:docxtemplater 工具链由合同助手出力,workspace 是包装层。
2. **缺口清单格式统一**:文本模板和 docx 模板返回 `missingFields: string[]`,语义一致。
3. **target 锚点匹配规则**:`delete-section` / `insert-table` / `insert-image` 的 `target` 在 Markdown 里按行级标题匹配,在 docx 里按段落文本精确匹配。匹配不到时抛错 + Journal `failed`,不静默跳过。
4. **输出路径白名单**:所有 create / edit 输出仍必须在 `dataDir/workspace-output/`(Slice C v1 已实现的约束保留)。
5. **insert-image 安全**:图片路径必须可读且大小符合 `maxFileSizeBytes`。
6. **临时文件清理**:docx 编辑过程的临时副本在操作完成/失败后删除(用 try/finally)。

## 实现步骤

### 步骤 1:盘点合同助手 docxtemplater 工具链

```bash
grep -rn "docxtemplater\|fillDocx\|render.*docx\|template.*docx" src/contract-assistant/
```

找到现有的 docx 模板填充实现。如果它是私有的,加一个最小 public export。

### 步骤 2:实现 `docx-template.ts`

- 包装合同助手工具链
- 提供 `fillDocxTemplate(templatePath, data, outputPath)`
- 提取占位符 + 缺口清单(可能需要先解析 docx 拿到所有 `{xxx}` 标记)

### 步骤 3:扩展 `create()`

- 增加 `type: "docx" | "md"` 分支
- docx 走新增工具,md 走现有 `loadAndFillTemplate`
- 统一返回 `{ outputPath, missingFields }`

### 步骤 4:扩展 `edit()`

- 类型签名加 3 个命令
- 每个命令实现 .md 和 .docx 两条路径
- Markdown 路径用纯文本处理(标题正则、表格 Markdown 语法、图片 `![alt](path)`)
- docx 路径调合同助手工具或新增 Python docx helper(优先复用,避免新写)

### 步骤 5:测试

按上面"测试"小节补 fixture 和断言。

## 验收标准

- [ ] `edit()` 支持 5 个命令:`append` / `replace` / `delete-section` / `insert-table` / `insert-image`
- [ ] 每个命令在 `.md` 和 `.docx` 上都跑通(各至少 1 个 fixture)
- [ ] `create({type: "docx", templatePath})` 调用合同助手的 docxtemplater 工具链
- [ ] `create({type: "md", templatePath})` 走 Slice C v1 现有 `loadAndFillTemplate`
- [ ] 缺口清单 `missingFields` 在两条路径上行为一致
- [ ] 输出路径白名单约束仍生效
- [ ] target 匹配不到时抛错 + Journal `failed`
- [ ] 临时文件清理(try/finally)
- [ ] 合同助手现有发票 / 合同模板路径未触及
- [ ] document-pipeline 未触及
- [ ] typecheck + 全量测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- workspace
npm test -- contract            # 合同助手现有路径未回归
npm test
```

## 给执行 Agent 的硬约束

1. **不重写 docxtemplater 工具链**。从合同助手 import 或转用,不在 workspace 内重新实现 docx 填充。
2. **不动合同助手现有发票 / 合同模板填充路径**。仅暴露最小 public export(如果需要)。
3. **PDF 是只读**。如果发现在写 PDF 编辑代码,说明走错了。
4. **target 匹配不到要抛错**,不允许静默跳过。
5. **输出路径白名单是硬约束**。任何写到 `dataDir/workspace-output/` 之外的代码不允许。
6. **临时文件用 try/finally 清理**。
7. **insert-image 大小校验**:复用 `maxFileSizeBytes`。
8. **缺口清单格式统一**:文本和 docx 返回 `missingFields: string[]`,不允许两套字段名。
9. **不引入新依赖**。docxtemplater 应该已是合同助手的依赖,直接复用。
10. **不动 Slice A/B/D/E 现有代码**。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. 合同助手 docxtemplater 工具链定位 + 是否新增了 public export
4. edit() 5 个命令实现位置 + 测试 fixture 位置
5. docx 模板填充实现位置 + 测试 fixture 位置
6. target 锚点匹配规则在 .md 和 .docx 上的差异说明
7. 输出路径白名单 + 临时文件清理代码位置
8. 合同助手现有路径未触及确认
9. document-pipeline 未触及确认
```

## 完成后的 issue 状态

此 slice 完成后,**#65 issue 的 Slice C 部分完整闭环**,可勾掉。
