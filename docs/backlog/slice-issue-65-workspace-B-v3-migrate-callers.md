# Slice: #65 File Workspace · Slice B v3 · knowledge + contract-assistant 迁移

接续 Slice B v2(`slice-issue-65-workspace-B-ocr-unified.md`)。v2 完成了字段映射(`ocrText` / OCR provider 判断),但 **knowledge 和 contract-assistant 仍然直接调用 `parseDocument()` 和 `EvidenceExtractService`**,导致 WorkspaceService 当前是孤立的库。本 slice 把这两条调用链真正切过来。

## 目标

让 knowledge 入库流程和 contract-assistant 发票识别流程**都通过 `WorkspaceService.parse()`** 获取解析结果:

1. **knowledge**: `src/knowledge/parser.ts:44 parseKnowledgeFile()` 内部从直接调 `parseDocument()` 改为调 `WorkspaceService.parse()`
2. **contract-assistant**: `src/contract-assistant/index.ts:373 / 423 / 808` 的 `evidenceExtractor.prepareFile()` 内部解析步骤改为 `WorkspaceService.parse()`

**严格保留**:
- contract-assistant SHA-256 缓存层(`createFileHash` / `readInvoiceRecognitionCache` / `writeInvoiceRecognitionCache`)
- contract-assistant LLM 提取层(`extractPreparedJson` / `extractStructuredInvoice`)
- knowledge chunking / embedding / 入库链路

## 依赖

- Slice A + B v2 已完成(已落地)
- `WorkspaceService.parse()` 行为稳定

## 范围

### 包含

#### 1. knowledge 迁移

修改 `src/knowledge/parser.ts`:

- `parseKnowledgeFile(fileName, buffer, options)` 内部从直接调用 `parseDocument()` 改为通过 `WorkspaceService.parse()`
- 把 `WorkspaceParseResult` 映射回 knowledge 现有的 `ParsedKnowledgeFile`(或等价结构),**对外接口保持不变**——`src/knowledge/index.ts:336` 调用方零修改
- DI 注入 `WorkspaceService` 到 knowledge module(参考 RuntimeModuleAssemblyOptions 现有的 service 注入模式)

#### 2. contract-assistant 发票路径迁移

定位 `EvidenceExtractService.prepareFile()` 的具体文件(应在 `src/contract-assistant/` 下),把其中文件解析步骤(可能调 `parseDocument` 或 Python OCR 工具)替换为 `WorkspaceService.parse()`:

- **保留** `prepareFile()` 的对外签名,调用方(`index.ts:373/808`)零修改
- **保留** OCR provider 选型(由 WorkspaceService 透传现有 `DocumentParserOptions`)
- **完全保留** SHA-256 缓存层:`index.ts:374-397` 缓存命中早返回逻辑一字不动
- **完全保留** LLM 提取层:`extractPreparedJson` / `extractStructuredInvoice` 不动

#### 3. DI 注入链

- 在 RuntimeModuleAssembly 的 options 增加 `workspaceService: WorkspaceService` 字段
- knowledge module 构造时接收
- contract-assistant module 构造时接收
- 主入口(`src/runtime/app.ts` 或等价)创建单例 WorkspaceService 注入两个模块

#### 4. 测试

- `test/knowledge-flow.test.ts`(或对应文件):验证迁移后入库行为不变,fixture 一致输出
- `test/contract-edit-python.test.ts`(或对应文件):验证发票识别字段输出一致,缓存命中行为一致
- 新增至少 1 个用例:验证 WorkspaceService 被实际调用(用 spy/mock)

### 不包含

- **不动** `document-pipeline/`(WorkspaceService 内部已包装)
- **不动** SHA-256 缓存层 3 个函数(`createFileHash` / `readInvoiceRecognitionCache` / `writeInvoiceRecognitionCache`)
- **不动** LLM 提取层(`extractPreparedJson` / `extractStructuredInvoice`)
- **不动** knowledge chunking / embedding / FTS5 入库
- **不迁移** labor 模块(待 #58 稳定后单独 slice)
- **不改** WorkspaceService 本身(Slice A 已稳定)
- **不引入** 新依赖

### 行为规则

1. **接口不变**:`parseKnowledgeFile` 和 `prepareFile` 的对外签名和返回类型不变。所有调用方零修改。
2. **行为等价**:迁移前后,knowledge 入库的 chunk 数量、embedding 向量、FTS5 索引内容必须一致(允许 Journal 多记录,因为多了一层调用)。
3. **缓存命中等价**:contract-assistant 发票识别,同一文件重复处理时仍命中缓存,跳过 WorkspaceService.parse 调用(在 prepareFile 内部缓存命中后早返回,不调 workspace)。
4. **OCR provider 透传**:knowledge 和 contract-assistant 原有 `DocumentParserOptions` 配置(`pdfProviderOrder` / `imageProviderOrder` 等)通过 WorkspaceService 透传给底层,选型不变。
5. **失败处理等价**:WorkspaceService.parse 抛错时,调用方收到的错误类型/消息与原来直接调 parseDocument 时等价或更详细(允许多一层 wrapping,但不能丢上下文)。

## 实现步骤

### 步骤 1:盘点改动点

```bash
# knowledge 中所有 parseDocument / parseKnowledgeFile 调用
grep -rn "parseDocument\|parseKnowledgeFile" src/knowledge/

# contract-assistant 中 evidenceExtractor 调用 + EvidenceExtractService 定义
grep -rn "evidenceExtractor\.\|class EvidenceExtractService" src/contract-assistant/
```

### 步骤 2:DI 链准备

- 阅读 `src/runtime/runtime-modules.ts` 看现有 module 装配的 service 注入模式
- 在 `RuntimeModuleAssemblyOptions` 加 `workspaceService` 字段
- 主入口创建 `WorkspaceService` 实例并注入

### 步骤 3:knowledge 迁移

- `parseKnowledgeFile` 内部改为调 `workspaceService.parse(...)`
- 写映射函数把 `WorkspaceParseResult` → `ParsedKnowledgeFile`(或现有等价类型)
- 跑 `npm test -- knowledge` 确认无回归

### 步骤 4:contract-assistant 迁移

- 找到 `EvidenceExtractService.prepareFile()` 实现
- 内部解析步骤替换为 `workspaceService.parse(...)`
- **缓存命中早返回逻辑保持在 prepareFile 入口处,不调 workspace**
- 跑 `npm test -- contract` 确认无回归

### 步骤 5:验证

- 全量 typecheck + test
- 手动确认:`git diff` 缓存层和 LLM 层 3 个关键函数完全没有

## 验收标准

- [ ] `src/knowledge/parser.ts` 内 `parseKnowledgeFile` 通过 `WorkspaceService.parse()` 解析
- [ ] `src/contract-assistant/` 的 `EvidenceExtractService.prepareFile()` 通过 `WorkspaceService.parse()` 解析
- [ ] `parseKnowledgeFile` 对外签名和返回类型不变
- [ ] `prepareFile` 对外签名不变
- [ ] SHA-256 缓存层 3 个函数 git diff 完全没有
- [ ] LLM 提取层 2 个函数 git diff 完全没有
- [ ] document-pipeline 任何文件未触及
- [ ] knowledge-flow 回归测试通过
- [ ] contract 回归测试通过(含缓存命中)
- [ ] 新增至少 1 个用例验证 WorkspaceService 实际被调用
- [ ] typecheck + 全量测试通过
- [ ] 无新依赖

## 验证命令

```bash
npm run typecheck
npm test -- knowledge-flow
npm test -- contract
npm test -- workspace
npm test

# 关键文件未触及确认
git diff src/document-pipeline/ 2>/dev/null  # 应为空
git diff src/contract-assistant/index.ts | grep -E "createFileHash|readInvoiceRecognitionCache|writeInvoiceRecognitionCache|extractPreparedJson|extractStructuredInvoice"
# 上面 grep 应无输出(缓存层 + LLM 层全部未动)
```

## 给执行 Agent 的硬约束

1. **不动 document-pipeline 任何文件**。
2. **不动 contract-assistant SHA-256 缓存层 3 个函数**(`createFileHash` / `readInvoiceRecognitionCache` / `writeInvoiceRecognitionCache`)。`git diff` 不允许出现这 3 个名字。
3. **不动 LLM 提取层 2 个函数**(`extractPreparedJson` / `extractStructuredInvoice`)。
4. **对外接口不变**。`parseKnowledgeFile` 和 `prepareFile` 的签名、返回类型、抛错时机不变。
5. **缓存命中早返回**:contract-assistant 发票识别如果命中缓存,**不调 WorkspaceService.parse**。
6. **不迁移 labor 模块**。
7. **不引入新依赖**。
8. **DI 注入用现有模式**。看 RuntimeModuleAssembly 怎么注入 memory / knowledge 等 service,照搬。
9. **行为等价是硬约束**:回归测试无失败,字段输出一致。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单
3. parseKnowledgeFile 迁移前后调用对比(代码片段)
4. EvidenceExtractService.prepareFile 迁移前后调用对比
5. DI 注入新增位置(RuntimeModuleAssemblyOptions / app.ts)
6. WorkspaceService 实际被调用的验证用例位置
7. 缓存层 + LLM 层未触及确认(git diff 输出空)
8. document-pipeline 未触及确认
9. 回归测试通过情况(knowledge-flow / contract / 缓存命中)
```

## 完成后的 issue 状态

此 slice 完成后,**#65 issue 的 Slice B 部分完整闭环**,可勾掉。
