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

## Architecture Guardrails

- Framework is frozen at the seams; new features must expand inside existing seams instead of widening the core casually.
- Framework capability should solve problems any business may need; business extensions should solve domain-specific problems.
  - Framework examples: knowledge-base infrastructure, file recognition, OCR, document parsing, short-term context, permissions, Feishu transport, card primitives, runtime modules, and workflow orchestration.
  - Shared service module examples: knowledge and memory provide ports, factories, retrieval, context, or persistence consumed by multiple runtime modules; they may have extension meta but are not ordinary business extensions in dependency-boundary rules.
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
  - all feature configuration goes through `src/config/schema.ts`, `src/config/loader.ts`, and the internal module config registry
  - module-owned subconfig should live in `<module>/config.ts` and be exposed through `<module>/extension.meta.ts`; modules may consume injected config only and must not read `config.json` directly or maintain parallel feature config files
- Builtin extension boundary:
  - built-in business capabilities should split data-only `extension.meta.ts` from runtime `extension.ts`; meta declares `id`, `configKey`, commands, configDefinition, business card templates, and workflows, while runtime extension owns `createModule`
  - new built-in extensions must be registered in both `src/extensions/builtin-meta.ts` and `src/extensions/builtin.ts`; this is intentional startup-time sync, not dynamic plugin loading
  - external extensions must import framework contracts only from `src/extension-api/`; do not make them depend on `src/runtime/**`, `src/bridge/**`, `src/feishu/**`, `src/store/**`, or business implementation files
  - extension commands are declarations for docs, conflict checks, and future help surfaces; they must not be treated as a generic router dispatcher unless the architecture baseline changes first
  - this is not a third-party plugin API and does not imply runtime hot reload
- Logging and observability boundary:
  - shared logging and transcript behavior goes through `src/logging/logger.ts`
  - runtime and transport events should follow the observability event schema instead of inventing ad-hoc event names

## Skill Runtime Guidance

- Skill user experience should prefer `自然语言 + 材料上下文` over "先输入命令再上传文件". A user may upload a file first, paste a local absolute path, or refer to the recent material in a later message; the runtime should decide whether a skill should act from the skill description, material context, and current user intent.
- Slash commands remain deterministic overrides and compatibility entrypoints. They are useful when the model route is wrong, the user wants to force a branch, or a power user wants to skip ambiguity; they must not be the only way to invoke a file-driven business skill.
- Do not hard-code a short phrase list such as "识别并上传" or "这张发票录一下" as the product contract. Phrase examples may appear in tests and docs, but routing should generalize through skill descriptions, declared capability metadata, and material signals.
- Skill declarations under `.opencode/skills/<skill>/SKILL.md` and `references/*.txt` are the deployment skeleton for prompt/runtime behavior. Keep the repository skeleton and the installed `~/.opencode/skills/<skill>/` copy aligned when changing a built-in skill's prompt contract.
- Broad domains may have an umbrella skill plus focused sub-skills. For example, `contract` is the user-facing contract work domain, while `contract-draft`, `contract-extract`, `contract-review`, and `contract-revise` remain separate execution skills with different side effects and cards.
- Extension `commands` in `extension.meta.ts` are for docs, conflict checks, future help surfaces, and forced entry. Business routing still belongs in the owning `RuntimeModule.handleMessage()` / service workflow, not in `src/runtime/app.ts`, `src/runtime/turn-executor.ts`, or `src/bridge/router.ts`.
- File upload should create material context, not immediately force business execution. If the next user message clearly asks to process the material, the owning module may claim the turn; if intent is unclear, let the default OpenCode/file-summary path continue or ask a scoped clarification.
- Natural-language routing may claim `file-await-instruction` only when confidence is high or a slash command explicitly forces the workflow. Low-confidence matches should not hijack generic document summaries, knowledge-base ingestion, or unrelated chat.
- Natural-language skill activation must use the same visible card lifecycle as slash-command activation. When a user says things like "这张发票录一下" or "帮我提取合同信息", the matching skill should show its own in-progress, confirmation, and result cards rather than silently running in plain text.
- Local absolute paths can be treated as material context for the same workflows as uploaded files. The module should validate existence and supported file type before dispatching the skill.
- Single-item and batch-item flows should share the same execution skill. A batch request should split into an explicit worklist, run the single-item skill per item, and render a summary card with successes, failures, missing fields, and duplicate suspects instead of inventing a separate inconsistent batch prompt.
- Write-side-effect skills such as invoice ledger writes, contract table writes, case workbench updates, or document generation need explicit guardrails. Prefer confirmation cards or deterministic rejection when confidence is low, required fields are missing, or anti-signals indicate the file is not the expected material type.
- For structured domains, prefer deterministic extraction before LLM repair. Use text/Markdown/OCR output to run schema-aware detectors, field parsers, confidence scoring, and anti-signal checks before asking the model to fill gaps.
- LLM repair prompts must separate confirmed fields from missing fields. Confirmed fields are frozen, the model should return a diff/patch for missing values only, and the runtime should reject attempts to rewrite already confirmed fields.
- Detector confidence must be explainable and testable. Prefer weighted signal hits, core-field coverage, negative signals, and fuzzy matching that tolerates OCR noise, rather than a single opaque threshold.
- `document-pipeline` is shared framework capability. Business skills should consume shared parser/OCR outputs through common services such as evidence extraction instead of implementing their own OCR stack; provider order and parser credentials belong to shared config.
- Default document parsing strategy: electronic PDF first uses local text-layer extraction; complex-layout PDF falls back to local Markdown parsing; scanned PDF uses external OCR/layout providers only when earlier stages do not extract useful text; images go directly to OCR.
- Business-specific structured layers may start inside the owning module, for example `src/contract-assistant/invoice-structured.ts`. Split them into a separate shared module only after signal sets, thresholds, config shape, and write-entry boundaries are stable.
- Knowledge-base flows and labor-dispute material generation keep their own module semantics. Contract-assistant skill routing must not hijack knowledge ingestion/query commands or labor-specific generation workflows unless those modules explicitly expose a shared routing contract.
- New or changed skill routing must include fixtures and tests. Cover positive and negative samples, noisy OCR text, slash-command forced entry, natural language with recent uploaded material, natural language with local path, detector confidence, anti-signals, and prompt override loading.

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

## Documentation References

- The active architecture contract lives in `docs/architecture-baseline.md`.
- Post-freeze feature PRs should follow `docs/guidelines/new-feature-checklist.md`.
- Built-in business extension development should follow `docs/guidelines/business-extension-development.md`.
- Active documentation index lives in `docs/README.md`.
- Observability event naming and fields live in `docs/observability/event-schema.md`.
- Current docs layout:
  - `docs/guidelines/`: active rules and checklists
  - `docs/modules/`: module-specific design notes
  - `docs/backlog/`: still-relevant future work
  - `docs/archive/`: historical design, demo, QA, and submission materials
- Module-specific background lives under `docs/modules/`.
- Active future work lives under `docs/backlog/`.
