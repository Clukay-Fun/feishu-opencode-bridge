---
name: invoice-recognize
description: 用户上传发票图片、照片或 PDF，需要识别完整发票字段、写入飞书多维表并返回确认卡片时，优先使用 /识别发票 或 /invoice-recognize。
---

# Invoice Recognize

当用户要识别发票并写入飞书多维表时，优先走这条专项 skill。

这份 skill 对应仓库中的 `contract-assistant` 专项能力，并遵守 `docs/modules/labor-skill-workflows.md` 中对专项能力与 shared workflow 的分层约定。

运行时 prompt 覆盖文件：

- `references/runtime-prompt.txt`

bridge 会优先读取 `~/.opencode/skills/invoice-recognize/references/runtime-prompt.txt`；仓库内这份文件是部署模板骨架，用于同步到约定的用户级 skill 目录。

OCR / 文档解析不由本 skill 私有实现。运行时通过 bridge 的 `document-pipeline` 共享入口复用 MinerU Agent、PaddleOCR-VL、tesseract、PDF 转 Markdown 等 provider。

## 触发

用户触发任一指令：

```bash
/识别发票
/invoice-recognize
```

然后附带 1 份发票文件。

支持场景：

- 发票图片
- 发票照片
- 发票 PDF
- 已转成文本的发票 `.txt` / `.md`

## 目标流程

```text
用户发送发票图片/PDF
  -> 发票字段识别
  -> 根据合同号、付款方、金额、开票日期匹配合同台账
  -> 写入发票记录表
  -> 输出确认卡片
```

## 识别字段

至少应尝试提取这些业务字段：

- 发票号
- 发票类型
- 开票方
- 收票方
- 不含税金额
- 税额
- 价税合计
- 开票日期
- 纳税人识别号

如果合同识别需要，还应补充这些落表辅助字段：

- 合同号
- 付款方
- 备注

## 字段完整性要求

- 信息要尽量完整，不能只抽最少字段就结束。
- 如果关键字段缺失，必须明确提醒用户，不要假装完整。
- 缺字段时仍可继续写入记录，但要在结果卡片里标记“待补充”。
- 不允许伪造未识别出的字段。

建议把以下字段视为关键字段：

- 发票号
- 发票类型
- 开票方
- 收票方
- 价税合计
- 开票日期

## 付款方识别保护

- `付款方` 必须指向发票购买方、客户、委托人或收票方。
- `北京市隆安（深圳）律师事务所` 通常是销售方、服务方或开票方，不应写入 `付款方`。
- `matchHints.clientName` 和 `matchHints.payer` 也必须指向购买方或客户，不要填律所名称。
- 如果无法判断购买方，应留空并在 `备注` 中写明需要人工复核，不要用开票方兜底。

## 文件处理方式

### 图片 / 照片

- 优先走 `document-pipeline` 的图片 OCR provider 顺序。
- 已配置外部 OCR 时，可使用 PaddleOCR-VL / MinerU Agent。
- 未配置外部 OCR 时，回退到本地 tesseract 或模型视觉识别。
- 适用于手机拍照发票、截图版电子发票、PNG/JPG/JPEG。

### PDF

- 先保存本地临时文件。
- 再走 `document-pipeline` 的 PDF provider 顺序。
- 转出的 Markdown 作为补充文本送入识别 prompt。
- 可按配置使用 MinerU Agent、PaddleOCR-VL、PyMuPDF4LLM、Docling、pdf-parse。

### 文本文件

- `.txt` / `.md` 直接作为补充文本输入。
- 这种情况更偏结构化提取，不完全依赖视觉识别。

## 飞书多维表目标

写记录前，优先读取真实表结构，不要只凭模板猜字段。

当前合同助手配置中，发票记录由 `contractAssistant.storage.invoiceTableId` 指定；skill 文件只维护字段语义和 prompt 约束，不直接拥有运行时配置。

默认字段骨架：

- 关联合同
- 合同号
- 付款方
- 发票号
- 开票日期
- 发票金额
- 附件
- 团队成员
- 年月
- 周
- 28%

如果实际表里还加了这些扩展字段，优先一并写入：

- 发票类型
- 开票方
- 收票方
- 不含税金额
- 税额
- 纳税人识别号
- 备注

## 写表规则

- 写记录前，优先读取真实表结构，不要只凭规划文档猜字段。
- 附件字段不要伪造 JSON 值，附件上传要走附件专用命令。
- 公式字段和系统字段不要手写。
- 如果找不到某个扩展字段，应保留已识别信息并提醒“表结构未包含该字段”。

## 合同关联规则

根据这些线索匹配合同台账：

- 合同号
- 付款方
- 金额
- 开票日期

目标分支：

- 唯一匹配：自动关联
- 多个候选：列出候选让用户选择
- 无匹配：只写发票表，不关联

## 当前代码现状

当前仓库里已经有 `invoice-recognize` 基础链路：

- `/识别发票` / `invoice-recognize` 触发
- 图片 OCR / 多模态识别
- document-pipeline 转 Markdown 补充文本
- 写入基础发票记录
- 尝试自动关联合同
- 完成/失败通知卡片

## 实现参考

- `docs/modules/labor-skill-workflows.md`
- `docs/guidelines/business-extension-development.md`
- `src/contract-assistant/runtime-module.ts`
- `src/contract-assistant/index.ts`
- `src/contract-assistant/prompts.ts`
- `src/workflows/evidence-extract.ts`

## 规则

- 如果用户只是想临时看看发票内容，不一定要写表。
- 如果用户明确要“识别并录入发票记录”，优先使用 `/识别发票` 或 `/invoice-recognize`。
- 结果信息要尽量完整，缺失项必须提醒。
- 不要伪造字段，不要伪造合同关联，不要假装多候选交互已经完成。
