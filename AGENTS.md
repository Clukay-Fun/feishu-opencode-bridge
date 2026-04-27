# Bridge Runtime Rules

## Runtime Ownership

- The bridge owns session control for `/new`, `/sessions`, `/switch`, and `/status`.
- The bridge owns runtime process cards, final replies, and other operational status messages sent back to Feishu.
- Follow the Feishu output Markdown rules in `docs/feishu-markdown.md`.
- For long-form bridge output such as architecture walkthroughs, use `###` section headings, render call chains as fenced code blocks, keep explanations in short sentences, and do not inline file paths or line numbers into narrative paragraphs.
- Output formatting constraints:
  - Use blank lines to group code blocks, around every 3-5 lines.
  - Render call chains with indentation, not natural-language prose.
  - Do not inline file paths or line numbers into body paragraphs.
  - Use `###` sections for long output, and keep each section within roughly one screen.
  - Leave one blank line between prose and code blocks.
- Plain Post is only for passthrough text output, ultra-short confirmations, and card fallback. Bridge-owned commands, structured lists, and system notices must use cards instead.
- Do not simulate session creation, switching, closing, or renaming inside the agent response.
- Treat bridge-injected system state as authoritative for the current window, active session, and visible sessions.
- Long-term user facts may be injected into `system` as a `[Memory Recall]` block; treat them as stable background context, not current window state.

## Feishu And Lark Operations

- Use `lark-cli` only when the user explicitly asks to operate on Feishu or Lark resources.
- When the user asks to operate on Feishu or Lark resources, prefer `lark-cli` and the installed `lark-*` skills over ad-hoc code exploration or custom bridge-side implementations.
- Knowledge CLI fast path:
  - When the user asks to query the knowledge base, do not search the codebase for the entrypoint.
  - Go straight to `npm run --silent kb -- query --question "<问题>"`.
  - For local file ingest, go straight to `npm run --silent kb -- ingest file --path "<绝对路径>"`.
  - For URL ingest, go straight to `npm run --silent kb -- ingest url --url "<URL>"`.
  - For PDF parsing diagnostics, go straight to `npm run --silent kb -- parse pdf --path "<绝对路径>"`.
  - For knowledge-base diagnostics, go straight to `npm run --silent kb -- doctor`.
  - Prefer the CLI entrypoint over repository exploration unless the user explicitly asks to inspect or modify the knowledge-base implementation.

## GitHub And Delivery Rules

- For GitHub pull requests, use Chinese titles and descriptions by default.
- Preferred PR title format: `[codex] <动词><变更主题>`.
- Preferred PR body sections: `变更内容`, `变更原因`, `影响`, `验证`.
- PR body expectations:
  - `变更内容`: summarize the concrete changes.
  - `变更原因`: explain why the change is needed.
  - `影响`: describe user, developer, runtime, or compatibility impact.
  - `验证`: list the commands, tests, or manual checks actually run.
- The repository PR template lives in `.github/PULL_REQUEST_TEMPLATE.md`; follow it unless the user explicitly asks for a different format.
- Existing commit history does not need retroactive renaming; apply the commit naming convention only to new commits going forward.
- Preferred commit title format: `[codex][<type>] <动词><变更主题>`.
- Preferred commit types:
  - `feat`: new feature or capability expansion
  - `fix`: bug fix or compatibility fix
  - `test`: test coverage or test baseline update
  - `refactor`: structural change without intended behavior change
  - `docs`: documentation, design note, or troubleshooting note
  - `ci`: CI, build, container, or deployment workflow change
  - `merge`: merge-main conflict resolution or integration branch merge commit
  - `followup`: feedback-driven or validation-driven follow-up patch
- Post-freeze feature PRs should include the new-feature checklist self-check when relevant.
- Keep updating the same branch and PR while the related feature line is still open and unmerged.
- Once a PR has been merged into `main`, do not reopen or reuse it for follow-up work; create a new branch and a new PR instead.

## Maintainer Responsibilities

- Treat pull request review, issue triage, release preparation, release notes, and related repository governance as `core maintainer responsibilities`.
- When the user asks for repository maintenance work, this usually includes:
  - pull request review and merge-readiness checks
  - issue classification, priority sorting, and follow-up recommendations
  - release-oriented changelog and version coordination
  - post-release verification, regression follow-up, and maintenance documentation updates
- Keep maintainer work distinct from feature implementation:
  - feature work changes product behavior or architecture
  - maintainer work keeps the repository healthy, reviewable, and releasable
- When summarizing this category in Chinese, prefer the term `核心维护职责`.

## Issue Authoring Rules

- Use issue titles with English type labels and Chinese content:
  - `[Bug] <动词><问题对象>`
  - `[Feature] <动词><能力>`
  - `[Enhancement] <动词><现有能力增强>`
  - `[Tech Debt] <动词><架构或维护问题>`
  - `[Docs] <动词><文档主题>`
  - `[Spike] <动词><调研主题>`
- Do not use `[codex]` in newly created issue titles unless the user explicitly asks to preserve an old style.
- Keep titles concrete and searchable. Prefer verbs such as `修复`、`支持`、`统一`、`抽象`、`补充`、`放宽`.
- Standard issue body sections:
  - `背景`
  - `问题 / 需求`
  - `影响`
  - `期望行为`
  - `建议方案`
  - `验收标准`
  - `非目标`
  - `备注`
- For small, clear bugs, a shorter body is acceptable:
  - `背景`
  - `问题`
  - `影响`
  - `期望行为`
  - `建议方案`
  - `验收标准`
- Issue label guidance:
  - `[Bug]` usually maps to `bug`
  - `[Feature]` and `[Enhancement]` usually map to `enhancement`
  - Add domain labels such as `knowledge-base`, `contract-assistant`, `labor`, or `feishu` when they exist
- For design-heavy issues, prefer the Obsidian knowledge-note style:
  - start with one short defining paragraph or quote block
  - use Chinese headings with optional English hints
  - use `---` between major phases when the issue is long
  - cite source anchors explicitly, for example `源码依据：src/runtime/app.ts -> handleCommand`

## Architecture Guardrails

- Framework is frozen at the seams; new features must expand inside existing seams instead of widening the core casually.
- Framework capability should solve problems any business may need; business extensions should solve domain-specific problems.
  - Framework examples: knowledge-base infrastructure, file recognition, OCR, document parsing, short-term context, permissions, Feishu transport, card primitives, runtime modules, and workflow orchestration.
  - Business extension examples: legal judgment, labor-dispute strategy, contract review policy, invoice-specific field interpretation, domain prompts, business schemas, and business card templates.
  - If a capability contains domain semantics such as "legal", "labor", "contract", "invoice", or "finance", default to implementing it as a business extension on top of framework seams rather than in bridge core.
- Keep the core small:
  - `core` may own ingress/egress, session windows, queueing, turn lifecycle, process cards, permission/question interactions, and bridge-owned commands
  - `core` must not keep growing business-specific branches
- Feishu transport boundary:
  - Feishu-specific delivery concerns should converge behind stable transport-style APIs
  - do not reimplement send/update/reply logic inside feature modules
- Runtime module boundary:
  - features should plug into `RuntimeModule.handleMessage()`, `beforeTurn()`, `afterTurn()`, services, workflows, and dedicated stores
  - business modules must not take over bridge session creation, deletion, rename, or switch semantics
  - modules that own timers, workers, temp resources, or background handles must clean them up in `stop()`
- Domain service boundary:
  - service/workflow code may own feature logic, prompt composition, local transforms, and feature-specific external integrations
  - service/workflow code must not own chat UI behavior, pending interaction TTL management, or conversation routing
- State and persistence boundary:
  - no feature may directly persist or mutate another feature's internal state file or in-memory interaction state
  - module-scoped pending interaction persistence should reuse the shared persisted interaction infrastructure
- Configuration boundary:
  - all feature configuration goes through `src/config/schema.ts` and `src/config/loader.ts`
  - modules may consume injected config only; they must not read `config.json` directly or maintain parallel feature config files
- Logging and observability boundary:
  - shared logging and transcript behavior goes through `src/logging/logger.ts`
  - runtime and transport events should follow the observability event schema instead of inventing ad-hoc event names

## Feature Checklist

- Automated coverage currently enforced by CI:
  - `npm run lint:deps` enforces core, transport, and formatter dependency boundaries
  - `npm run check:formatter-exports` pins the formatter compatibility export surface
  - `npm run lint` enforces the common config direct-read restrictions
  - `npm run check:docs-diff` warns when seam files change without `docs/architecture-baseline.md`
- Reviewer-only checks still matter:
  - module boundary: new modules must enter through the runtime module assembly seam
  - state boundary: avoid copying timer + JSON persistence patterns
  - command boundary: each action keeps one primary command and at most one compatibility alias
- High-frequency implementation rules:
  - do not add business-specific branching to `src/runtime/app.ts`, `src/runtime/turn-executor.ts`, or `src/bridge/router.ts` unless the architecture baseline is updated first
  - new cards should use the card family entrypoints: `shared-primitives`, `runtime-cards`, `knowledge-cards`, `labor-cards`, `contract-cards`
  - if a feature changes a seam, update `docs/architecture-baseline.md` in the same PR before merge
  - 代码注释默认使用中文，除非注释内容是外部 API 原文、协议字段、错误码或必须保持英文的术语
  - 为新增的重要文件添加文件头注释，沿用项目现有的 `职责 / 关注点` 模板
  - 为非显而易见的代码路径添加简洁注释，尤其是兼容逻辑、fallback 行为、并发/定时器处理、外部 API 特殊行为和跨模块契约
  - 注释应解释代码为什么存在、保护什么不变量、或规避什么历史问题；不要添加逐行复述代码的低价值注释

## File Header Comment Template

- TypeScript / JavaScript / MJS 文件头注释使用：

```ts
/**
 * 职责: 用一句话说明本文件负责的稳定职责。
 * 关注点:
 * - 说明本文件收口的第一类行为。
 * - 说明本文件保护的边界或复用场景。
 * - 如有必要，说明它不负责什么。
 */
```

- Python 文件头注释使用模块 docstring：

```py
#!/usr/bin/env python3
"""
职责: 用一句话说明本脚本负责的稳定职责。
关注点:
- 说明本脚本收口的第一类行为。
- 说明输入输出协议、fallback 或外部工具边界。
"""
```

- 简单类型定义、纯 re-export、极短测试 fixture 可以不写文件头；一旦文件承载跨模块契约、外部 API 适配、业务 workflow、持久化、配置或脚本入口，就应补文件头。

## Documentation References

- The active architecture contract lives in `docs/architecture-baseline.md`.
- Post-freeze feature PRs should follow `docs/guidelines/new-feature-checklist.md`.
- Active documentation index lives in `docs/README.md`.
- Observability event naming and fields live in `docs/observability/event-schema.md`.
- Current docs layout:
  - `docs/guidelines/`: active rules and checklists
  - `docs/modules/`: module-specific design notes
  - `docs/backlog/`: still-relevant future work
  - `docs/archive/`: historical design, demo, QA, and submission materials
- Module-specific background lives under `docs/modules/`.
- Active future work lives under `docs/backlog/`.
