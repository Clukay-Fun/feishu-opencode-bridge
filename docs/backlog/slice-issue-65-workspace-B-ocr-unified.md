# Slice: #65 File Workspace · Slice B · OCR 统一与调用方迁移(v2)

依据：`docs/adr/0003-file-workspace-layer.md` 第 8 节 / 第 9 节 Slice B。
本方案在 Slice A 落地后重写，基于真实交付物指明集成点。

## 背景：Slice A 已经做了什么

`src/workspace/service.ts:146` 已经在 `parseSingleFile()` 内调用 `parseDocument()`（document-pipeline 公共入口）。`parseDocument()` **本身就已经包含 OCR**：通过 `DocumentParserOptions.pdfProviderOrder` / `imageProviderOrder` 选择 PaddleOCR-VL、MinerU、Tesseract 等 provider。

所以 OCR 调用**不需要重新实现**。Slice B 的真实工作是：

1. **OCR 结果字段映射**：把 `parseDocument()` 返回的 OCR 产物正确填进 `WorkspaceParseResult.content.ocrText`，区分 `rawText`（普通文本提取）和 `ocrText`（OCR 提取）
2. **xlsx/csv → sheets 映射**：把 XLSX/CSV 解析结果填进 `WorkspaceParseResult.content.sheets`
3. **knowledge 迁移**：把 `src/knowledge/` 直接调 `parseDocument()` 的位置改为调 `WorkspaceService.parse()`
4. **contract-assistant 发票路径迁移**：把 `EvidenceExtractService.prepareFile()` 内部的 parse 步骤改为通过 `WorkspaceService.parse()` 走，**保留发票识别 SHA-256 缓存层和 LLM 提取层不动**

## 依赖

- Slice A 已完成（已确认，`src/workspace/` 全套交付）
- document-pipeline 已稳定（OCR provider chain 不动）

## 范围

### 包含

#### 1. service.ts 字段映射增强

修改 `src/workspace/service.ts:163-183` 的 `WorkspaceParseResult` 构造：

- 当 `parsed.parserUsed` 属于 OCR provider（`paddleocr-vl` / `paddleocr-vl-aistudio` / `mineru-agent` / `tesseract`）时，把 `parsed.plainText` 同时填入 `content.ocrText`（注意：`rawText` 也保留，便于上层不关心来源时直接用）
- 当 `parsed.parserUsed` 是 XLSX/CSV 解析器（`pymupdf4llm` 不算，主要是新增 XLSX/CSV 支持时）：把表格数据映射到 `content.sheets`
- 如果 document-pipeline 没有暴露 sheets 数据，这一项标记为 follow-up，**不在本 slice 修改 document-pipeline**

#### 2. knowledge 迁移到 WorkspaceService

- 在 knowledge 的入库流程中（具体位置先 grep `parseDocument\|parseKnowledgeFile` 在 `src/knowledge/`），把直接调用 `parseDocument()` 的位置改为：
  ```ts
  const result = await workspaceService.parse({ buffer, fileName, source: "upload" });
  // 消费 result.content.rawText / markdown / sections / ocrText
  ```
- 通过 RuntimeModuleAssembly 或等价 DI 注入 `WorkspaceService` 实例到 knowledge module
- knowledge 的 chunking / embedding / 入库逻辑**不动**，只换 parse 入口

#### 3. contract-assistant 发票 OCR 路径迁移

- 修改 `src/contract-assistant/index.ts:373` 附近：`evidenceExtractor.prepareFile()` 内部如果会调 OCR，把这部分换成 `workspaceService.parse()`
- **缓存层完全保留**：`src/contract-assistant/index.ts:374-397` 的 SHA-256 缓存逻辑一字不动
- **LLM 字段提取保留**：`src/contract-assistant/index.ts:422-459` 的 `extractPreparedJson` LLM 调用不动
- 迁移后行为必须等价：相同发票输入产生相同输出（含缓存命中行为）

#### 4. 测试覆盖

- `test/workspace-service.test.ts` 扩展：
  - PNG/JPG 图片解析时 `ocrText` 字段被填充
  - 扫描 PDF 解析时 `ocrText` 字段被填充（如有 fixture）
  - 普通文本 PDF 解析时 `ocrText` 为空、`rawText` 填充
- `test/knowledge-flow.test.ts` 回归：迁移后入库行为不变
- `test/contract-edit-python.test.ts` 等：迁移后发票识别行为不变（含缓存命中）

### 不包含

- **不修改** document-pipeline 任何文件
- **不切换** OCR provider 默认选择（保持现状）
- **不重写** contract-assistant 的 SHA-256 缓存层
- **不重写** contract-assistant 的 LLM 字段提取层
- **不实现** 本地编辑（Slice C）
- **不实现** 云文档读写（Slice D）
- **不暴露** CLI（Slice E）
- **不引入** 新依赖

### 行为规则

1. **OCR provider 不切换**：现有选型保持，本 slice 只统一调用入口和字段映射。
2. **缓存层 100% 保留**：contract-assistant 的 SHA-256 缓存命中率、缓存写入位置、缓存格式不变。
3. **行为等价是硬约束**：迁移前后 knowledge 入库和 contract-assistant 发票识别的所有字段输出必须一致。
4. **降级路径**：OCR provider 报错时，`WorkspaceService.parse()` 应在 Journal 写 `partial` + warnings，不抛错给上层；调用方收到 `result.parse.warnings` 自行决定如何处理。Slice A 已有此路径，本 slice 验证未回归。
5. **ocrText 与 rawText 不互斥**：OCR 来源的文本同时填两个字段，便于上层不关心来源时直接用 `rawText`，关心来源时查 `ocrText`。
6. **不强制迁移所有调用方**：knowledge 和 contract-assistant 是本 slice 的迁移目标；labor 模块可以等后续 slice 再迁，本 slice 不动。

## 实现步骤

### 步骤 1：摸清现状

```bash
# knowledge 中 parseDocument 直接调用点
grep -rn "parseDocument\|parseKnowledgeFile" src/knowledge/

# contract-assistant 中 evidenceExtractor / OCR 触发点
grep -rn "evidenceExtractor\|prepareFile" src/contract-assistant/

# document-pipeline 是否暴露 XLSX/CSV 的 sheets 数据
grep -n "sheets\|rows\|headers" src/document-pipeline/index.ts
```

### 步骤 2：service.ts 字段映射增强

在 `parseSingleFile()` 返回值构造里加 OCR provider 判断和 `ocrText` 填充。如果 document-pipeline 暴露了 sheets 数据，同时填 `content.sheets`；如果没暴露，留 follow-up，不动 document-pipeline。

### 步骤 3：knowledge 迁移

- 找到 knowledge 中调 `parseDocument` 的位置（步骤 1 grep 出来）
- 通过依赖注入获取 `WorkspaceService` 实例（参考 RuntimeModuleAssemblyOptions 的注入模式）
- 替换调用并适配返回字段
- 跑 `npm test -- knowledge-flow` 确认无回归

### 步骤 4：contract-assistant 发票路径迁移

- 找到 `evidenceExtractor.prepareFile()` 内部的解析路径
- 替换为 `workspaceService.parse()`
- 保留缓存层和 LLM 层完全不变
- 跑 `npm test -- contract` 确认无回归

### 步骤 5：测试扩展

按上面"测试覆盖"小节补 fixture 和断言。

## 验收标准

- [ ] `WorkspaceService.parse()` 在 OCR provider 解析时正确填充 `ocrText`
- [ ] `WorkspaceService.parse()` 在 XLSX/CSV 解析时填充 `sheets`（如 document-pipeline 暴露）
- [ ] knowledge 不再直接调用 `parseDocument()`
- [ ] contract-assistant 发票 OCR 走 `WorkspaceService.parse()`，**缓存层和 LLM 层未触及**
- [ ] knowledge 入库回归测试通过
- [ ] contract-assistant 发票识别回归测试通过（含缓存命中）
- [ ] document-pipeline 任何文件未触及
- [ ] OCR provider 不可用时降级路径未回归（Slice A 测试仍通过）
- [ ] typecheck + 全量测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- workspace
npm test -- knowledge-flow
npm test -- contract
# 现有 OCR 集成测试
npm test -- ocr
# 全量
npm test

# 关键文件未触及确认
git diff src/document-pipeline/ 2>/dev/null  # 应为空
git diff src/contract-assistant/index.ts | grep -E "createFileHash|readInvoiceRecognitionCache|writeInvoiceRecognitionCache|extractPreparedJson"  # 应为空（缓存层和 LLM 层未动）
```

## 给执行 Agent 的硬约束

1. **不动 document-pipeline 任何文件**。OCR provider 选型、parser chain、错误处理全部不动。
2. **不重写 SHA-256 缓存层**。`src/contract-assistant/index.ts` 的 `readInvoiceRecognitionCache` / `writeInvoiceRecognitionCache` / `createFileHash` 一行不动。
3. **不重写 LLM 提取层**。`extractPreparedJson` / `extractStructuredInvoice` 等函数不动。
4. **行为等价是硬约束**。迁移后任何字段输出变化、缓存命中变化、错误处理变化都不允许。
5. **ocrText 和 rawText 不要互斥处理**。两个字段都填，让上层选用。
6. **如果 document-pipeline 没暴露 sheets 数据**，sheets 映射留 follow-up，不要顺手改 document-pipeline 来"补齐"。
7. **labor 模块不在本 slice 迁移**。
8. **不引入新依赖**。
9. **DI 注入用现有模式**。看 RuntimeModuleAssembly 怎么注入其他 service，照搬，不发明新模式。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. service.ts 字段映射增强位置（行号）
4. knowledge 迁移位置 + 替换前后调用对比
5. contract-assistant 发票迁移位置 + 缓存层未触及确认（git diff 行）
6. ocrText 字段填充逻辑（OCR provider 判断条件）
7. sheets 字段处理（已实现 / follow-up + 原因）
8. document-pipeline / 缓存层 / LLM 层未触及的 git diff 输出
9. 回归测试通过情况（knowledge-flow / contract / ocr）
```
