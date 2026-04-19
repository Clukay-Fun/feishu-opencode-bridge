# Framework Freeze Acceptance

Date: 2026-04-19
Branch/Commit: `freeze-reorg` / `8eb76c6` before this acceptance commit

## 1. Baseline Seam Sampling

### Outbound ownership

Evidence command:

```sh
rg -n "outbound\\.sendMessage|outbound\\.replyMessage|outbound\\.updateMessage" src --glob '*.ts'
```

Result: direct outbound sends remain in runtime core only: `src/runtime/app.ts` and `src/runtime/turn-card-manager.ts`.

Judgment: PASS.

### Config ownership

Evidence command:

```sh
rg -n "readFileSync.*config\\.json|require\\(.*config\\.json|config\\.json" src --glob '*.ts'
```

Result: direct config file resolution is centralized in `src/config/loader.ts`.

Judgment: PASS.

### Module assembly

Evidence command:

```sh
rg -n "createRuntimeModules|new .*RuntimeModule|registerModule|modules\\.register" src/runtime/app.ts src/runtime/runtime-modules.ts --glob '*.ts'
```

Result: `BridgeApp` calls `createRuntimeModules()`, and module construction lives in `src/runtime/runtime-modules.ts`.

Judgment: PASS.

### Command cleanup

Evidence command:

```sh
rg -n "legal-query|/model\\b|labor-start|labor-end|contract-workbench|案件更新待办" src test docs/plans docs/architecture-baseline.md --glob '!docs/archive/**'
```

Result: retired aliases remain only as explicit retirement notices, passthrough tests, and compatibility-cleanup documentation.

Judgment: PASS.

## 2. New-Feature Checklist Evidence

### Core boundary

Evidence: runtime feature assembly is centralized in `src/runtime/runtime-modules.ts`; `src/runtime/app.ts` delegates module creation and transport setup.

Judgment: PASS.

### Module boundary

Evidence: knowledge, labor, contract, and memory features are registered through `createRuntimeModules()`.

Judgment: PASS.

### Transport boundary

Evidence command:

```sh
rg -n "sendMessage\\(|replyMessage\\(|updateMessage\\(|sendPayload\\(" src/knowledge src/labor src/contract-assistant --glob '*.ts'
```

Result: modules call `FeishuTransport` or local wrappers that delegate to it; they do not call outbound directly.

Judgment: PASS.

### State boundary

Evidence command:

```sh
rg -n "PersistedInteractionManager|schedulePersist|flushPersist|restore.*Interaction|setTimeout\\(" src/contract-assistant src/labor --glob '*.ts'
```

Result: contract and labor pending interactions use `PersistedInteractionManager`; duplicated timer and JSON persistence helpers are gone.

Judgment: PASS.

### Command boundary

Evidence: compatibility aliases are retired or hidden; remaining alias strings are retirement notices and tests, not active duplicate command surfaces.

Judgment: PASS.

### Formatter boundary

Evidence command:

```sh
rg -n "from .*feishu/formatter|from \"\\.\\./feishu/formatter|from \"\\.\\/formatter" src test --glob '*.ts'
```

Result: only `test/formatter.test.ts` imports the compatibility formatter surface. Runtime code uses family entrypoints.

Judgment: PASS.

### Config boundary

Evidence: config file IO remains in `src/config/loader.ts`; schema ownership remains in `src/config/schema.ts`.

Judgment: PASS.

### Docs boundary

Evidence: seam changes are documented in `docs/architecture-baseline.md`, `docs/plans/new-feature-checklist.md`, `docs/plans/formatter-migration.md`, and this acceptance note.

Judgment: PASS.

## 3. Compatibility Cleanup Status

Alias decision: alpha.

Status: compatibility aliases listed in `docs/plans/compatibility-cleanup.md` are retired in this milestone. The runtime may still recognize legacy text to show a retirement notice, but those paths no longer provide duplicate feature entrypoints.

## 4. Test Baseline

Final verification commands:

```sh
npm run typecheck
npm run lint
npm test
```

Final main verification after PR #38 merge: all three passed on commit `e37eb44`. `npm test` reported 52 test files and 370 tests passing.

Test-count note: PR-3 reduced the count from 370 to 368 when alias-only tests were removed; PR-5 added two turn-owned resource cleanup tests, returning the total to 370.

## 5. B1 Semantic Equivalence

B1 step 8 compared the reconstructed `freeze-reorg` branch against the preserved working-tree spec.

Result: PR-1 through PR-3 scope is semantically equivalent.

Accepted divergence: `src/runtime/app.ts` import ordering differs from the spec replay. The `freeze-reorg` form is lint-preferred and has no behavior change.

Spec preservation:

- `/Users/clukay/Program/feishu-opencode-bridge-freeze-specs/20260419-b1/freeze-worktree.patch`
- `/Users/clukay/Program/feishu-opencode-bridge-freeze-specs/20260419-b1/untracked-files.tar`
- `stash@{0}: On main: freeze-b1-working-tree-spec`

## 6. Scope Bleed Notes

These were accepted as benign and are recorded for audit clarity:

- PR-1 includes follow-up `7f9ad9d`, adding restart/restore coverage for contract onboarding interactions discovered during B1 step 8.
- PR-5 completed a missed formatter-family import migration in `src/runtime/turn-executor.ts`.
- PR-5 introduced `executePromptWithEventStream()` to name the remaining event-stream body; the settle/fallback/watchdog third cut remains deferred.
- PR-5 added two tests for PR-1's turn-owned resource cleanup seam.

## 7. Post-Freeze Backlog

Backlog: `docs/plans/post-freeze-backlog.md`.

## 8. Final Sign-Off

Prepared by: Codex
Accepted by: Clukay / Codex
Commit: `e37eb44`
Date: 2026-04-19
