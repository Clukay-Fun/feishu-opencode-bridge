# Post-Freeze Backlog

Status: closed as of 2026-04-19.

These items were not blockers for framework freeze acceptance. They were reviewed after freeze and either completed with code/tests or closed as already satisfied by the frozen architecture.

## TurnExecutor Third Cut

- Final state: closed.
- Resolution: `TurnExecutionSettlement` now owns turn settlement, fallback timer cleanup, unsubscribe, watchdog cleanup, and resolver/reject plumbing.
- Verification: `test/turn-executor.test.ts` covers the first-SSE fallback path with fake timers.

## Runtime Module Dependency Tightening

- Final state: closed.
- Resolution: `createRuntimeModules()` now requires a complete outbound resource port at the type boundary instead of accepting `Partial<KnowledgeResourcePort>` and narrowing later. `BridgeApp` adapts its outbound dependency into that complete port and fails early when resource-backed modules are enabled without required Feishu resource methods.
- Verification: `test/runtime-modules.test.ts` assembles modules with a complete outbound resource stub, and flow tests cover the app-level adapter path.

## FeishuTransport Notice Convenience

- Final state: closed.
- Resolution: `sendNotice()` remains the only transport-level card-building convenience and is explicitly documented as a narrow exception.
- Verification: no additional card-family convenience helpers were added.

## Contract Transport Call Style

- Final state: closed.
- Resolution: contract and labor modules both call `this.deps.transport.sendPayload()` / `updatePayload()` directly for runtime sends.
- Verification: no contract-specific private transport wrapper remains.

## PersistedInteractionManager Error Semantics

- Final state: closed.
- Resolution: `flush()` is documented as non-throwing, and persist failures are logged by `schedulePersist()`.
- Verification: `test/persisted-interaction-manager.test.ts` covers non-throwing `flush()` on persist failure.

## Expired Interaction Set Semantics

- Final state: closed.
- Resolution: `set()` ignores already-expired interactions by deleting any existing entry and returning without scheduling an immediate timer.
- Verification: `test/persisted-interaction-manager.test.ts` covers already-expired `set()` input.

## Contract Card Family Follow-Up

- Final state: closed.
- Resolution: `contract-cards.ts` is an independent card family, and `formatter.ts` is a compatibility re-export surface.
- Verification: `test/formatter.test.ts` covers contract-family compatibility re-exports.

## New Follow-Up Candidate

### Module Resource Requirements

- Current state: `BridgeApp` still knows which configured features require Feishu resource methods when adapting its outbound dependency for `createRuntimeModules()`.
- Why not part of this closure: moving that requirement into module self-declaration would widen this cleanup into module metadata design.
- Suggested trigger: before adding the next runtime module that needs Feishu resource download or Bitable access.

### DOCX Edit Capability Spike

- Current state: a Python PoC exists in `scripts/python/docx_edit.py` for DOCX package inspection, unpack, pack, single-run replacement, and candidate reachability analysis.
- Boundary: existing `docxtpl` rendering remains the right path for template-owned placeholders; `docx_edit` is only valuable for existing DOCX files that were not prepared with placeholders.
- Layering: `contract_edit.py` is still a contract-specific paragraph-level editor built on `python-docx`; `docx_edit.py` intentionally stays at the `zipfile` + `lxml` package/XML layer.
- Real-template measurement: on `templates/contracts/委托代理合同-民事.docx`, 5 of 6 representative phrases are reachable inside a single `w:t` node, for an 83.33% single-run coverage rate.
- Cross-run evidence: `聘请方（甲方）：` is visible at paragraph level but not single-run reachable, so a formal v1 should prioritize cross-run replacement before promising broad editing coverage.
- Revision scan: the template contains revision markers in `word/document.xml`, several headers/footers, and `word/styles.xml`; replacement PoC preserves the before/after revision marker presence.
- Validation: automated checks cover structure stability, small XML diff, text extraction readability, unsupported input failure, and missing `word/document.xml` failure.
- Manual check: Microsoft Word is not installed in the current environment; only WPS was detected, so Word visual confirmation must be repeated before promoting this PoC to a supported CLI.
- Tracked changes difficulty: low for simple `w:ins` / `w:del` element emission, medium when run properties and style inheritance must be preserved, high when Word-compatible revision view, rsid metadata, comments, headers/footers, and existing revisions must all remain coherent.
- Recommendation: do not formalize a single-run-only `replace` as the user-facing v1. Open a follow-up only if it includes cross-run replacement, revision-preserving tests, and a real Word visual QA step.
