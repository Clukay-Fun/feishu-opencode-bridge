# Changelog

All notable changes to this project will be documented in this file.

The project follows Semantic Versioning.

## 0.1.59 - 2026-05-05

### Added
- Added Legal Harness V1 helpers for labor citation checking, offline fixtures, and repeatable labor analysis validation.
- Added PKULaw authority search support with labor follow-up confirmation cards and retry-safe pending interactions.
- Added knowledge-base recent material ingestion, Obsidian note export, and lawyer-visible search strategy drafting.
- Added umbrella and focused contract skills for contract routing, review, and revision workflows.

### Changed
- Recorded external authority calls in the runtime cost tracker and exposed the data through local runtime scripts.
- Updated business skill routing guidance so uploaded files and local absolute paths become material context before execution.

### Fixed
- Kept completed labor analysis cards stable when authority-search prompt delivery fails.
- Preserved authority confirmation state when follow-up authority lookup fails.
- Avoided silent Obsidian note overwrite by adding document id and checksum information to exported note filenames.

## 0.1.58 - 2026-05-04

### Fixed
- Restored image uploads as OpenCode `image_url` prompt parts while keeping local turn-file paths and extracted previews available for fallback handling.

## 0.1.57 - 2026-05-04

### Added
- Added structured invoice detection and field repair before writing invoice ledger records.
- Added natural-language skill intent routing for contract extraction, invoice recognition, case management, and contract drafting.
- Added local-path evidence inputs so contract and invoice workflows can process explicitly provided local files.
- Added troubleshooting documentation for Feishu card-action callback JSON validation failures.

### Changed
- Changed invoice ledger normalization to prefer the `购买方` field while keeping card display compatible with older `付款方` records.
- Improved Feishu Bitable record writes by filtering unknown fields against the live table schema after `FieldNameNotFound`.

## 0.1.56 - 2026-05-03

### Added
- Added local `bridge backup` / `bridge restore` for user-data backup and recovery.
- Added local AI cost visibility with runtime usage ledger, Feishu `/cost`, `bridge cost`, and daily limit protection.
- Added portable update check/download/apply/rollback commands backed by GitHub Release staging.
- Added a data-flow/privacy doctor group plus promotion-facing privacy documentation.

### Changed
- Marked external extension loading as experimental trusted-code loading rather than a stable third-party plugin platform.

## 0.1.55 - 2026-05-03

### Added
- Added `bridge guide`, a local onboarding state file, and the Feishu `/guide` card for first-run next-step guidance.
- Added `bridge doctor workspace` for diagnosing Bitable workspace configuration, table fields, access failures, and missing Base scopes.
- Added workspace starter-record seed manifests under `data/init-seeds.json` plus `bridge init workspace --reset-sample-data` for safe sample reset.
- Added reproducible Hero onboarding materials under `examples/hero/`.

### Changed
- Clarified that `bridge init workspace --force` only rewrites local Base / Table pointers and never deletes remote data.
- Quieted new-install defaults for the promotion path: knowledge auto-detect and memory remain off by default, and external OCR providers are not in the default parser order.
- Documented that the 30-minute quick-start path assumes an existing AI provider key or a manually issued temporary test key.

## 0.1.54 - 2026-04-28

### Added
- Added an invoice-recognize skill template with a runtime prompt for fuller invoice field extraction and contract matching hints.
- Added MinerU API key configuration and passed shared document parser options into contract and labor evidence extraction flows.

### Changed
- Changed the default parser order to prefer local PDF text/Markdown extraction before external OCR providers.
- Treated empty `pdf-parse` output as low quality so scanned PDFs can fall through to the configured OCR provider chain.

## 0.1.53 - 2026-04-28

### Added
- Added long-term memory user clearing support for privacy cleanup workflows.

### Fixed
- Prevented contract draft/workbench re-entry commands from resetting active contract interactions.
- Rejected spoofed HTML payloads uploaded as PDFs during evidence extraction.
- Added regression coverage for Feishu retries, SSE reconnects, file download failures, and labor failure card fallbacks.

## 0.1.52 - 2026-04-28

### Added
- Added namespace-based builtin extension configuration under `extensions["extension-id"]` while keeping legacy top-level config fields compatible.
- Added regression coverage for runtime module failure isolation, empty file rejection, knowledge keyword fallback, and labor collection edge cases.

### Changed
- Updated README and extension docs to describe the namespace config model.

## 0.1.51 - 2026-04-28

### Added
- Added local external extension package management commands for install, list, remove, and pack workflows.
- Added startup validation that requires external extensions to be isolated npm packages with dependencies resolved inside the extension directory.

### Changed
- Updated the Chinese README and extension documentation to describe the local extension package workflow.

## 0.1.50 - 2026-04-28

### Added
- Added the public `extension-api` contract, startup-time external extension loading, and an adapter that maps external modules into the RuntimeModule seam without exposing deep bridge internals.
- Added external extension config normalization, dependency-boundary checks, a minimal hello-world external extension example, and regression coverage for the new loading path.

### Changed
- Documented the constrained external extension model across README, AGENTS, architecture baseline, and business extension development guidance.

## 0.1.49 - 2026-04-27

### Changed
- Removed the extension meta registry's direct runtime dependency on the AppConfig key list while preserving config definition key consistency checks.

## 0.1.48 - 2026-04-27

### Changed
- Split builtin extension declarations into data-only `extension.meta.ts` files and runtime `extension.ts` files.
- Added dependency-boundary guardrails for data-only extension meta, reverse-selected business directories, and cross-business imports.
- Refreshed README and extension development docs for the meta/runtime extension split.

## 0.1.47 - 2026-04-27

### Changed
- Refreshed README project news, architecture diagrams, configuration notes, and verification baseline for the internal extension manifest architecture.
- Documented the builtin extension boundary in AGENTS, docs index, architecture baseline, feature checklist, and knowledge-base module notes.

## 0.1.46 - 2026-04-27

### Changed
- Moved contract assistant and labor skill configuration into module-owned config definitions.
- Added internal builtin extension manifests for runtime module assembly, command ownership metadata, and business card template ownership.
- Kept legacy legal consultation aliases out of the core router by letting the knowledge runtime module claim them through passthrough handling.

## 0.1.45 - 2026-04-27

### Changed
- Clarified the architecture boundary between framework capabilities and business extensions.

## 0.1.44 - 2026-04-26

### Fixed
- Honored `pdf-parse` precedence when it appears before later PDF providers in the document parser order.
- Prevented the DOCX edit unpack action from deleting an existing output directory.

## 0.1.43 - 2026-04-24

### Fixed
- Fixed Feishu assistant reply formatting for top-level headings and single-backtick pseudo code blocks.
- Improved `/models` cards to show the current window model and OpenCode provider defaults separately.
- Extended session selection validity and masked hidden session titles in `/sessions all` cards.

## 0.1.42 - 2026-04-24

### Added
- Added GitHub community health files for code of conduct, contributing guidance, security reporting, and issue templates.

## 0.1.41 - 2026-04-24

### Added
- Added an archived issue completion report covering recently closed GitHub issues and release regression checks.

## 0.1.40 - 2026-04-24

### Changed
- Added maintainer responsibility and file-header comment guidance to the repository agent rules.
- Refreshed README architecture notes to reflect module registries, document pipeline reuse, business card templates, and current maintenance status.
- Added Chinese file-header comments across important source, test, and tooling files.

## 0.1.39 - 2026-04-24

### Added
- Added an internal module config registry and moved knowledge-base config normalization into the knowledge module boundary.
- Added configurable document parser provider options for MinerU, PaddleOCR-VL, local PDF parsers, and image OCR.
- Added shared case workflow helpers for evidence ledger sync, timeline Mermaid generation, and Feishu workbench output.
- Added DOCX package/XML diagnostics and single-run replacement proof-of-concept coverage.

### Changed
- Reused the knowledge service factory across Bridge runtime modules and the local knowledge CLI.
- Routed labor analysis evidence ledger and workbench generation through shared workflow helpers.

## 0.1.38 - 2026-04-23

### Added
- Added window-level `/model use <provider/model>` and `/model reset` handling, with model overrides threaded into OpenCode prompt requests.
- Added keyword filtering for `/sessions all` plus direct hard-delete confirmation by session id.
- Added DOCX logical-page deletion support in `contract_edit.py`.

### Changed
- Normalized Feishu Markdown code fences by removing language markers before post/card rendering.
- Preserved fallback parser warnings when the document pipeline falls back from Python conversion to local parsers.

## 0.1.37 - 2026-04-23

### Added
- Added a unified document pipeline that converts common files into Markdown, plain text, sections, parser quality, fallback chains, and warnings.
- Added Feishu reply/create short-term message context injection so follow-up turns can reference known inbound messages or bridge outputs.
- Added labor-skill workflow layering documentation for domain workflows, specialist capabilities, and shared workflow boundaries.

### Changed
- Rewired knowledge parsing to consume the shared document pipeline instead of maintaining separate PDF/DOCX/TXT parsing branches.

## 0.1.36 - 2026-04-23

### Added
- Added a business card template runtime plus labor-analysis template definitions and regression coverage for template rendering.
- Added `RuntimeModule.claimFileInstruction()` so modules can reclaim generic file-await-instruction flows before bridge fallback handling.

### Changed
- Routed labor analysis cards through the new business-template runtime and tightened dependency boundaries so runtime and business modules do not import `src/feishu/templates/*` directly.

## 0.1.35 - 2026-04-23

### Added
- Added contract prompt-override helpers plus regression coverage for loading external skill prompt templates into contract-assistant workbench flows.

### Fixed
- Fixed knowledge mirror sync so local mirrored entries and orphaned synced documents are removed after their Bitable records are deleted.

## 0.1.34 - 2026-04-23

### Changed
- Reorganized `scripts/` into clearer `runtime`, `checks`, `kb`, `wrappers`, and `python` subdirectories.
- Updated package entrypoints, setup/start launchers, and script-focused tests to reference the new script locations.
- Added directory README notes for script and ops assets, and refreshed related documentation references.

## 0.1.33 - 2026-04-22

### Changed
- Added role-focused code comments across bridge runtime, Feishu transport, runtime modules, stores, memory, and knowledge-base files to make ownership and call paths easier to review.
- Trimmed archive documentation down to long-lived reference material and added README guidance for retained historical directories.
- Rewrote active documentation pages in Chinese and aligned them more clearly with `AGENTS.md`, the architecture baseline, and the post-freeze checklist.

## 0.1.32 - 2026-04-20

### Changed
- Reorganized documentation into current entry points, guidelines, modules, backlog, and archive directories.
- Updated README links, architecture references, and formatter export snapshot checks to use the new documentation layout.
- Added an issue writing standard for normalizing future GitHub issues.

## 0.1.31 - 2026-04-20

### Changed
- Polished knowledge-ingest completion cards so single-file and session summaries share the same compact stats, tag chart, elapsed time, and knowledge-base link layout.
- Updated demo knowledge-query examples to split the labor dispute walkthrough into smaller focused questions.

### Fixed
- Fixed runtime module outbound adaptation so Feishu API resource methods keep their original client binding.

## 0.1.30 - 2026-04-19

### Added
- Added the first observability event schema for bridge runtime logs.
- Added structured logger context propagation, JSON log output, message logging policies, and event helpers.

### Changed
- Threaded correlation and turn context through Feishu ingress, HTTP callbacks, runtime modules, permission handling, turn cards, and turn execution.
- Updated architecture documentation to describe the observability boundary and stable event vocabulary.

## 0.1.29 - 2026-04-19

### Changed
- Polished the Chinese README localization with clearer section titles, Chinese architecture labels, localized project layout notes, and expanded documentation link descriptions.

## 0.1.28 - 2026-04-19

### Changed
- Polished the Chinese and English README presentation with a stronger project intro, news section, capability overview, and clearer architecture/command sections.
- Synchronized README formatting so both language entrypoints share the same public-facing structure.

## 0.1.27 - 2026-04-19

### Added
- Added an English README and linked it from the main project README.

### Changed
- Reworked the main README as the Chinese project homepage with updated status, architecture diagrams, command overview, and documentation links.
- Reduced `README.zh-CN.md` to a compatibility pointer that redirects readers to the main README and English README.

## 0.1.26 - 2026-04-19

### Changed
- Refactored TurnExecutor settlement handling so fallback timers, watchdog cleanup, unsubscribe, and final resolution are owned by a dedicated settlement helper.
- Tightened runtime module resource wiring so BridgeApp adapts the outbound resource port once before assembling resource-backed modules.
- Closed the post-freeze runtime cleanup backlog with verification notes and a smaller follow-up candidate.

### Fixed
- Fixed persisted interaction handling so already-expired interactions are dropped instead of scheduling immediate expiry work.
- Fixed first-SSE fallback coverage to verify the latest completed assistant message is streamed and settled when OpenCode events never arrive.

## 0.1.25 - 2026-04-19

### Added
- Added architecture freeze acceptance documentation and post-freeze planning notes for the runtime boundary cleanup.
- Added runtime boundary helpers for Feishu transport, persisted interactions, runtime module wiring, and turn-owned resource tracking.

### Changed
- Split Feishu card rendering into domain-specific card modules and shared primitives to reduce formatter coupling.
- Refactored turn execution, runtime module coordination, and command ownership boundaries around the frozen bridge architecture.
- Archived demo planning material into a dedicated documentation area and updated knowledge-base follow-up planning.

## 0.1.24 - 2026-04-17

### Fixed
- Fixed startup preflight directory checks so writable directories with dotted names such as `data.v1` are validated directly instead of accidentally falling back to their parent directory.
- Fixed knowledge-ingest runtime flow so queued materials continue to be accepted during an active ingest session instead of being blocked by the bridge queue limit.

### Changed
- Updated knowledge-ingest final summary cards to use a denser overview plus compact per-file details for larger batch imports.

## 0.1.23 - 2026-04-17

### Added
- Added labor runtime/workbench regression coverage plus a sample command script for the labor-and-knowledge demo walkthrough.

### Changed
- Updated contract-assistant workflows with case todo/reminder commands, stronger draft matching, and cleaner signature-block finalization for generated contracts.
- Updated knowledge and labor runtime cards so query, ingest, and analysis flows use clearer batch/progress surfaces and richer linked results.
- Updated startup checks and formatting/router helpers to better support demo-time bridge reuse and explicit knowledge-query routing.

## 0.1.22 - 2026-04-16

### Added
- Added a contract finalization Python helper and expanded contract-draft onboarding tests for the demo-ready drafting flow.
- Added a labor demo dialogue and data-preparation note to stabilize recording inputs and narration.

### Changed
- Updated contract-assistant drafting, prompts, command routing, and runtime cards to support richer guided contract finalization.
- Updated labor prompts and document text extraction handling for the competition demo material flow.

## 0.1.21 - 2026-04-16

### Added
- Added a labor-dispute demo flow note for the competition presentation and expanded runtime test coverage for the polished card surfaces.

### Changed
- Polished knowledge-ingest cards with queued, progress, failure, and final-summary states suited for demo recording.
- Updated labor and runtime reply surfaces so demo-oriented entrypoints, card layout, and streaming updates are clearer and more stable.

## 0.1.20 - 2026-04-15

### Added
- Added turn-executor regression coverage and a demo-packaging strategy note for the competition presentation phase.

### Changed
- Polished bridge command handling, queue/session behavior, Feishu card formatting, and runtime reply delivery for more stable demo flows.
- Updated knowledge, labor, and contract-assistant runtime surfaces to align with the presentation-focused stabilization pass.

## 0.1.19 - 2026-04-15

### Added
- Added Python-backed contract rendering, editing, and parsing helpers plus shared Python tool wrappers for legal document workflows.
- Added contract workbench export/edit regression coverage and repository checks for the Python toolchain requirements.

### Changed
- Updated contract-assistant prompts, runtime flow, and template metadata so contract drafting can support richer workbench-style editing and export behavior.
- Updated knowledge PDF parsing entrypoints to reuse the newer Python conversion path and aligned local CLI/script helpers with the same toolchain.

## 0.1.18 - 2026-04-15

### Fixed
- Fixed contract draft Word export file names so they no longer append timestamps by default and only add numbered suffixes when the target file name already exists.
- Fixed contract ledger writes to normalize `签约日期` into Bitable-friendly datetime values, including natural-language inputs such as `今天`.

## 0.1.17 - 2026-04-15

### Added
- Added local DOCX contract-template rendering with reusable template metadata, template field guides, and regression coverage for contract-draft post-processing.
- Added guided contract-draft onboarding flows plus the bundled civil entrustment template files needed for local draft generation.

### Changed
- Updated contract-assistant runtime handling so draft requests can render local Word files, surface warnings, and reuse richer template-aware prompts.
- Updated sanitization and notice-card rendering to better mask organization identities and keep notice cards icon-free by default.

## 0.1.16 - 2026-04-14

### Added
- Added contract assistant workflows for contract drafting, contract extraction, invoice recognition, case management, and reminder-oriented Bitable updates.
- Added a reusable evidence extraction pipeline with spreadsheet support plus new labor workflow modules, prompts, and tests.
- Added updated demo and planning docs for contract assistant and labor workflow rollout.

### Changed
- Updated runtime/config/router wiring so contract assistant and labor workflows can coexist with the bridge and knowledge-base flows.
- Updated sanitization, Feishu API helpers, and repository skills/documentation to match the new legal-workflow direction.

## 0.1.15 - 2026-04-14

### Added
- Added local knowledge-base CLI entrypoints for querying, file and URL ingest, extraction preview, document inspection, stats, and doctor checks.
- Added local knowledge document list/detail/stats views and a repository skill that teaches private-chat knowledge CLI usage.
- Added Python-backed PDF-to-Markdown parsing support with parser provenance reporting and dedicated regression coverage.

### Changed
- Updated private-chat legal-query commands to act as guidance-only entrypoints instead of bridge-side knowledge-mode switching.
- Updated ordinary file follow-up turns to pass local file paths into OpenCode instead of pre-parsing file contents inside the bridge.

## 0.1.14 - 2026-04-14

### Fixed
- Fixed ordinary file handling to reject unsupported file types and oversized uploads before entering the normal follow-up flow.

## 0.1.13 - 2026-04-14

### Added
- Added an Apache 2.0 `LICENSE` file for the repository.

## 0.1.12 - 2026-04-14

### Added
- Added runtime version exposure through `src/version.ts`, startup logs, and the `/healthz` response.

## 0.1.11 - 2026-04-14

### Fixed
- Fixed fallback final replies so direct markdown responses stay attached to the original Feishu message thread when process cards cannot be created.

## 0.1.10 - 2026-04-14

### Added
- Added persisted active knowledge-ingest session state so in-flight ingest sessions can be restored and tracked separately from normal pending interactions.

### Changed
- Updated knowledge-ingest flow to use session-level queue summaries, queued item processing, and explicit session idle configuration.
- Updated Feishu reply delivery so ingest and permission replies can opt into threaded replies when needed.

## 0.1.9 - 2026-04-14

### Fixed
- Fixed Feishu turn-status cards so tool updates are no longer truncated from the toolbar display.

## 0.1.8 - 2026-04-14

### Fixed
- Fixed knowledge-flow tests so CI does not require a real OpenCode server on `127.0.0.1:4096`.

## 0.1.7 - 2026-04-14

### Added
- Added a file-intent follow-up flow so uploaded files outside ingest mode can be processed as normal OpenCode turns.
- Added tests for non-legal text fallback while knowledge mode is enabled and ordinary chat during background ingest.

### Changed
- Updated knowledge ingestion to process long documents in batches instead of truncating to the first `maxExtractChunks` chunks.
- Made legal question and web-ingest detection more conservative to reduce accidental knowledge-mode routing.

## 0.1.6 - 2026-04-13

### Added
- Added a regression test covering dedicated ingest-session creation and previous-session restore on `/kb-ingest-end`.

## 0.1.5 - 2026-04-13

### Added
- Added staged extraction persistence so interrupted knowledge-base ingest jobs can resume from completed chunks.
- Added retry handling and coverage for transient OpenCode extraction interruptions.

### Changed
- Reused semantic-dedupe embeddings during knowledge-base writes to avoid duplicate embedding requests.
- Added chunk-limit warnings and ingest-session state needed for safer long-running knowledge ingestion.

## 0.1.4 - 2026-04-13

### Added
- Added knowledge-base commands, mode switching, ingest progress cards, and legal-query result cards in bridge runtime.
- Added end-to-end tests for knowledge-mode routing, file ingest flow, and knowledge-base message handling.
- Added README documentation for knowledge-base usage and required Feishu Bitable permissions.

### Changed
- Extended session-window state to track interaction mode and persist knowledge-mode selection across command flows.

## 0.1.3 - 2026-04-13

### Added
- Added knowledge base parser, SQLite storage, embedding retrieval, and Feishu Bitable sync primitives.
- Added knowledge base config schema, sample config, and Feishu/OpenCode resource helpers needed by ingestion.
- Added doctor output for Obsidian sync readiness and tests covering knowledge-base/config compatibility.

### Changed
- Unified shared embedding provider configuration under `embeddings.*`, while keeping legacy memory settings compatible.
- Marked macOS shell entrypoints as executable for direct launch.

## 0.1.2 - 2026-04-12

### Added
- Added OpenCode provider auth and model availability checks to `doctor` / `onboard`.
- Added onboarding tests for `lark-cli auth login`, `opencode providers login`, and start-offer flow.
- Added an actionable runtime fallback hint for missing or expired OpenCode provider credentials.

### Changed
- Updated onboarding to prompt for provider login and optional stack startup when the environment is nearly ready.

## 0.1.1 - 2026-04-12

### Added
- Added `npm run onboard`, `npm run doctor`, and cross-platform setup/start entrypoints.
- Added environment diagnosis and onboarding helper scripts for OpenCode and `lark-cli`.
- Added script-focused tests for health checks, onboarding, startup, and setup entrypoints.

### Changed
- Updated `npm start` to launch `dist/src/index.js` so the built entry matches the current TypeScript output layout.
- Updated logger daily rotation to use the local calendar date instead of UTC.
- Renamed and reorganized planning documents for onboarding and solution ideas.
