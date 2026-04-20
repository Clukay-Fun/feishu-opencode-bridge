# Issue Writing Standard

Use this standard when creating or rewriting GitHub issues for this repository.

The goal is not to make every issue long.
The goal is to make issues easy to scan, easy to compare, and easy for AI agents to turn into implementation plans later.

## Title Format

Use an English type label and Chinese content:

```text
[Type] 动词 + 对象 / 能力
```

Recommended type labels:

- `[Bug]`: incorrect behavior, data inconsistency, failed sync, regression
- `[Feature]`: new user-facing or workflow-facing capability
- `[Enhancement]`: improvement to an existing capability
- `[Tech Debt]`: architecture, cleanup, extraction, refactor, maintainability
- `[Docs]`: documentation-only work
- `[Spike]`: research, validation, or design exploration before implementation

Examples:

- `[Bug] 修复 Bitable 删除记录未同步清理本地知识库`
- `[Feature] 支持飞书右键回复/创建触发上下文贯通`
- `[Feature] 支持图片、扫描件与扫描版 PDF 入库`
- `[Enhancement] 支持先上传文件后触发合同/发票识别`
- `[Tech Debt] 统一 contract-assistant prompt 外置机制`

Title rules:

- Keep the title concrete and searchable.
- Prefer verbs such as `修复`、`支持`、`统一`、`抽象`、`补充`、`放宽`.
- Do not use `[codex]` in issue titles. Reserve author/tool prefixes for commits and PRs.
- Avoid vague titles such as `优化知识库` or `上下文问题`.

## Standard Body Template

Use this template for most feature, enhancement, and tech-debt issues:

```md
## 背景

说明这件事出现的业务或技术背景。写清楚为什么现在会有这个问题。

## 问题 / 需求

明确当前缺口。Bug 写现状与错误行为；Feature 写需要新增的能力。

## 影响

说明不处理会造成什么问题，或做好后带来什么价值。

## 期望行为

描述完成后系统应该如何表现。尽量写成用户可感知或系统可验证的行为。

## 建议方案

记录当前倾向的实现方向、可选路径、重要设计约束。不要求一次定死。

## 验收标准

- 可验证结果 1
- 可验证结果 2
- 必要测试、CLI、日志或诊断要求

## 非目标

明确本 issue 暂不处理什么，防止范围膨胀。

## 备注

补充阶段判断、拆分建议、历史上下文或风险。
```

Section rules:

- Keep headings in Chinese.
- Use `##` headings only.
- Use bullets for parallel items.
- Use fenced code blocks for examples, commands, data shapes, or flow diagrams.
- Omit a section only when it truly does not apply.

## Bug Body Template

Use this shorter template for clear defects:

```md
## 背景

相关模块、数据源或触发场景。

## 问题

当前错误行为是什么。

## 影响

会导致哪些实际后果。

## 期望行为

正确行为是什么。

## 建议方案

初步修复方向。

## 验收标准

- 复现路径通过
- 修复后行为正确
- 增加必要测试
```

Bug rules:

- Prefer concrete reproduction or trigger conditions.
- Name the affected data source or file when relevant.
- If the bug is about sync, state the source of truth and the stale copy.

## Label Guidance

Use GitHub labels for filtering, not as a replacement for title type labels.

Suggested mapping:

- `[Bug]` -> `bug`
- `[Feature]` -> `enhancement` or a dedicated feature label if one exists
- `[Enhancement]` -> `enhancement`
- `[Tech Debt]` -> `tech-debt` if available; otherwise leave unlabeled or use the closest existing label
- Domain labels such as `knowledge-base`, `contract-assistant`, `labor`, or `feishu` should be added when available

If a label does not exist, do not block issue creation just to create labels.

## Rewriting Existing Issues

When normalizing old issues:

- Preserve the original meaning.
- Do not silently remove constraints, risks, or non-goals.
- Prefer moving content into the standard sections over rewriting from scratch.
- Remove `[codex]` or other tool prefixes from issue titles.
- Update only issues that are likely to be worked on soon, unless the user asks for a full backlog cleanup.

Recommended first cleanup set:

- `#47`: Bitable deletion sync bug
- `#48`: Feishu reply/create context continuity
- `#33`: image, scan, and scanned-PDF knowledge ingest
- `#31`: upload-first contract/invoice recognition
- `#29`: contract-assistant prompt externalization
