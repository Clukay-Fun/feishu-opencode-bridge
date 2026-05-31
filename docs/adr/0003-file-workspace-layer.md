# ADR 0003：File/Document Workspace 能力层

- **状态**：草案（2026-05-29）
- **关联**：Issue #65、`src/document-pipeline/` 现有实现

## 1. 背景与现状

文件相关能力分散在多个模块中：

| 模块 | 文件相关职责 | 位置 |
|------|-------------|------|
| document-pipeline | PDF/DOCX/TXT/MD/HTML/XLSX → Markdown/纯文本/sections | `src/document-pipeline/index.ts` |
| knowledge | 文件入库、OCR、chunk 切分、embedding | `src/knowledge/index.ts` |
| contract-assistant | 合同模板填充、发票 OCR、docx 编辑 | `src/contract-assistant/index.ts` |
| labor | 材料收集、证据提取、分析报告生成 | `src/labor/index.ts` |
| feishu-drive | 云空间文件上传/下载 | `lark-cli drive` |
| feishu-doc | 云文档创建/读取/更新 | `lark-cli docs` |
| feishu-sheets | 电子表格读写 | `lark-cli sheets` |
| feishu-base | 多维表格读写 | `lark-cli base` |

每个模块各自处理来源识别、解析、模板、输出和错误处理，导致：
- 解析逻辑重复（合同助手和知识库各自调用 OCR）
- 模板能力不统一（合同助手用 docxtemplater，劳动模块手写 Markdown）
- 输出格式不一致（有的返回本地路径，有的返回飞书链接，有的返回 Markdown）
- 没有统一的操作日志和错误追溯

## 2. 9 个能力边界现状覆盖度

| # | 能力边界 | 当前覆盖位置 | 完整度 | 重复实现 |
|---|---------|-------------|--------|---------|
| 1 | 文件输入 | document-pipeline（本地）、feishu-api（上传）、contract-assistant（本地路径推断）、labor（文件夹收集） | 部分 | 本地路径解析在 contract-assistant 和 labor 各有一份 |
| 2 | 解析 | document-pipeline（统一入口）、knowledge（OCR 调用）、contract-assistant（发票 OCR） | 部分 | OCR 调用在 knowledge 和 contract-assistant 各有一份 |
| 3 | 本地编辑 | contract-assistant（docxtemplater + Python docx 编辑） | 部分 | 仅合同助手使用 |
| 4 | 云文档编辑 | lark-cli docs/sheets/base（外部 CLI） | 部分 | 各模块直接调用 lark-cli |
| 5 | 模板 | contract-assistant（本地 .docx 模板）、labor（手写 Markdown） | 部分 | 两套模板机制 |
| 6 | 输出 | 各模块各自返回（本地路径 / 飞书链接 / Markdown） | 缺失 | 无统一输出 schema |
| 7 | CLI | `npm run kb --`（知识库）、无通用文件 CLI | 缺失 | 无 |
| 8 | 权限 | 各模块各自校验扩展名和大小 | 部分 | 白名单在 material-support.ts 统一，但校验分散 |
| 9 | Journal | logger.ts（通用日志）、transcript（对话副本） | 缺失 | 无专用文件操作日志 |

## 3. 标准化输出 schema

```typescript
/** 文件/文档工作区统一解析结果 */
interface WorkspaceParseResult {
  /** 文件元信息 */
  meta: {
    fileName: string;
    extension: string;
    mimeType?: string | undefined;
    size: number;
    source: "upload" | "local-path" | "feishu-doc" | "feishu-drive" | "zip-entry";
    sourceUrl?: string | undefined;
  };

  /** 解析产出 */
  content: {
    /** 原始文本（如果可用） */
    rawText?: string | undefined;
    /** 标准化 Markdown */
    markdown?: string | undefined;
    /** 结构化章节 */
    sections?: ParsedDocumentSection[];
    /** 表格数据（XLSX/CSV） */
    sheets?: Array<{ name: string; headers: string[]; rows: unknown[][] }>;
    /** OCR 文本（图片/扫描 PDF） */
    ocrText?: string | undefined;
    /** 附件/嵌入资源索引 */
    attachments?: Array<{ name: string; path?: string; url?: string }>;
  };

  /** 解析质量与 fallback */
  parse: {
    used: DocumentParserUsed;
    quality: DocumentParseQuality;
    fallbackChain: DocumentParserUsed[];
    warnings: string[];
    elapsedMs: number;
  };

  /** 操作记录（写入 Journal） */
  journal?: {
    operationId: string;
    operationType: "read" | "parse" | "create" | "edit" | "upload";
    inputPath?: string | undefined;
    outputPath?: string | undefined;
    status: "success" | "partial" | "failed";
    detail?: string | undefined;
  };
}
```

## 4. MVP 子集

### MVP（1-2 个 implementation slice 可完成）

- **统一读取 + 解析接口**：`WorkspaceService.parse(input)` 覆盖 PDF / DOCX / TXT / MD / XLSX / CSV / PNG / JPG
- 输入来源：本地绝对路径、飞书上传文件、zip 压缩包
- 输出：`WorkspaceParseResult` 标准化 schema
- 复用 document-pipeline 现有解析逻辑，包装为新接口
- 权限：扩展名白名单、文件大小限制（复用 material-support.ts）
- Journal：记录每次 parse 操作的基本信息

### V2（后续 slice）

- 本地编辑（create / edit / template fill）
- 云文档编辑（feishu doc/sheet/base 读写）
- CLI 暴露
- 模板变量识别与缺口清单

### Future

- 云文档模板
- 多端输出（本地 + 云文档 + 飞书上传）
- 操作回滚

## 5. 权限与安全清单

| # | 约束 | 实现位置 |
|---|------|---------|
| 1 | 文件大小限制 | `material-support.ts` → `maxFileSizeMb`（默认 20MB） |
| 2 | 扩展名白名单 | `material-support.ts` → `SUPPORTED_MATERIAL_EXTENSIONS` |
| 3 | 解析失败降级 | document-pipeline fallback chain（pdf-parse → pymupdf4llm → docling → OCR） |
| 4 | 敏感信息日志脱敏 | `logger.ts` 脱敏策略（appSecret、apiKey 等） |
| 5 | 输出路径限制 | workspace service 写入 `dataDir/workspace-output/`，不写项目根目录 |
| 6 | 临时文件清理 | parse 过程中的临时文件在操作完成后删除 |
| 7 | 写操作确认 | 写操作（create/edit/upload）需用户明确指令，不自动执行 |
| 8 | 云文档快照 | 云文档编辑前保留原文内容到 Journal，支持回滚 |

## 6. Document Operation Journal

```sql
CREATE TABLE document_operations (
  id INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,          -- UUID
  operation_type TEXT NOT NULL,                -- read | parse | create | edit | upload | fetch-feishu
  input_path TEXT,                             -- 本地路径或 URL
  output_path TEXT,                            -- 输出路径或 URL
  source_type TEXT NOT NULL,                   -- upload | local | feishu-doc | feishu-drive | zip
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  status TEXT NOT NULL,                        -- success | partial | failed
  used_parser TEXT,                            -- 实际使用的解析器
  quality TEXT,                                -- high | medium | low
  fallback_chain TEXT,                         -- JSON array of parsers tried
  warnings TEXT,                               -- JSON array of warning messages
  elapsed_ms INTEGER NOT NULL,
  detail TEXT,                                 -- 错误详情或操作摘要
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_doc_ops_time ON document_operations(created_at DESC);
CREATE INDEX idx_doc_ops_status ON document_operations(status);
```

**TypeScript 接口实现**：查询主接口为 `DocumentOperationJournal.query(options)`，支持 `status` / `operationType` / `fileName` / `since` / `until` / `limit` 组合过滤。`queryByStatus` / `queryByType` / `queryByFileName` / `queryByTimeRange` 为便捷 wrapper，内部转发到 `query()`。

## 7. CLI 形态草案

```bash
# 读取文件并输出解析结果（JSON）
npm run files -- read --input /path/to/file.pdf

# 解析文件并输出 Markdown
npm run files -- parse --input /path/to/file.docx --format markdown

# 基于模板创建文档
npm run files -- create --type docx --from-template /path/to/template.docx --data '{"name":"张三"}' --output /path/to/output.docx

# 编辑本地文档
npm run files -- edit --input /path/to/file.docx --command "替换 第三条 为 新内容"

# 读取飞书云文档
npm run files -- fetch-feishu-doc --url https://xxx.feishu.cn/docx/xxx

# 更新飞书云文档
npm run files -- update-feishu-doc --url https://xxx.feishu.cn/docx/xxx --command append --content "追加内容"
```

CLI 是 OpenCode 可调用方式之一，不是唯一。TypeScript service 直接调用是主要方式。

## 8. 与现有模块的衔接路径

### document-pipeline → workspace service

- **当前**：`parseKnowledgeFile()` 返回 `ParsedDocument`
- **迁移**：包装为 `WorkspaceService.parse()` 返回 `WorkspaceParseResult`
- **策略**：先包装，不重写。document-pipeline 继续作为底层实现，workspace service 作为上层接口

### 知识库入库 → workspace service

- **当前**：knowledge 直接调用 `parseKnowledgeFile()` 和 OCR
- **迁移**：改为调用 `WorkspaceService.parse()`，消费标准化 `WorkspaceParseResult`
- **优先级**：中（knowledge 的解析逻辑已稳定，迁移收益主要是统一 schema）

### 合同助手 → workspace service

- **当前**：contract-assistant 自己处理发票 OCR、docx 编辑、模板填充
- **迁移**：发票 OCR 改为调用 workspace service 的 parse；模板填充改为调用 workspace service 的 create
- **优先级**：低（contract-assistant 的逻辑已稳定，迁移风险大于收益）

### 劳动工作台 → workspace service

- **当前**：labor 自己处理材料收集和证据提取
- **迁移**：材料解析改为调用 `WorkspaceService.parse()`
- **优先级**：中（labor 的文件夹收集刚实现，趁热迁移成本低）

## 9. 实现切片建议

### Slice A：标准化输出 schema + MVP 读/解析

定义 `WorkspaceParseResult` 接口。将 document-pipeline 的 `parseKnowledgeFile()` 包装为 `WorkspaceService.parse()`。覆盖 PDF / DOCX / TXT / MD / XLSX / CSV / PNG / JPG。新增 Document Operation Journal 表。

依赖：无。风险：低，纯包装层不改底层逻辑。

### Slice B：图片 OCR 接入

将 knowledge 和 contract-assistant 的 OCR 调用统一到 workspace service。支持扫描 PDF 和图片的 OCR 解析。

依赖：Slice A。风险：OCR provider 切换可能影响解析质量。

### Slice C：本地编辑 + 模板能力

实现 `WorkspaceService.create()` 和 `WorkspaceService.edit()`。支持本地 .docx / .md 模板填充。返回缺口清单。

依赖：Slice A。风险：docx 编辑的格式兼容性。

### Slice D：云文档编辑封装

封装 lark-cli docs/sheets/base 为 `WorkspaceService.fetchFeishuDoc()` / `updateFeishuDoc()`。支持读取、创建、追加、覆盖。

依赖：Slice A。风险：lark-cli 版本兼容。

### Slice E：Journal + CLI 暴露

`query(options)` 主接口 + 4 个 wrapper 方法（`queryByStatus` / `queryByType` / `queryByFileName` / `queryByTimeRange`）。暴露 `npm run files --` CLI。

依赖：Slice A。风险：低。

## 10. 被拒绝的备选方案

### 方案 A：一次性重写所有文件模块

**拒绝理由**：document-pipeline、knowledge、contract-assistant、labor 都有稳定的解析逻辑，一次性重写会引入大量回归风险。渐进迁移（先包装，再迁移）更安全。

### 方案 B：完全替换 document-pipeline

**拒绝理由**：document-pipeline 的 fallback chain 和解析质量已经过验证，不应废弃。workspace service 应作为上层接口包装 document-pipeline，而不是替代它。

## 11. 验收清单

- [ ] `WorkspaceParseResult` 接口定义完整，覆盖 meta / content / parse / journal 四层
- [ ] MVP 解析覆盖 PDF / DOCX / TXT / MD / XLSX / CSV / PNG / JPG
- [ ] 输入来源支持本地路径、飞书上传文件、zip 压缩包
- [ ] 权限约束：扩展名白名单、文件大小限制、解析降级
- [ ] Document Operation Journal 表结构定义并可写入
- [ ] 至少一个业务模块改为消费 workspace service
- [ ] 被拒绝方案至少 2 个
