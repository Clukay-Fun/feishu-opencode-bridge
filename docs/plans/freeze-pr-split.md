# Framework Freeze PR Split Draft

Date: 2026-04-19
Branch at A1: `main`

## Execution Update

B1 semantic rebuild was executed on `freeze-reorg` and is now closed.

Resulting commits:

- PR-1: `d27af2b` plus follow-up `7f9ad9d`
- PR-2: `27e1367`
- PR-3: `6da5119`
- PR-4: `8eb76c6`
- PR-5: `1ea6a99`

PR-1 contains two commits: the reconstruction commit and a follow-up that addresses a test coverage gap found during B1 step 8.

B1 step 8 semantic equivalence was confirmed for PR-1 through PR-3 scope. The only accepted non-semantic divergence is `src/runtime/app.ts` import ordering; `freeze-reorg` keeps the lint-preferred import order and does not change behavior.

Test-count note: the original freeze snapshot had 370 tests. PR-3 alias retirement reduced the count to 368 by removing alias-only expectations, and PR-5 restored the total to 370 by adding two turn-owned resource cleanup tests.

PR-5 scope notes:

- `src/runtime/turn-executor.ts` also completed a formatter-family import migration missed by PR-2.
- `executePromptWithEventStream()` names the remaining event-stream Promise body; it is not the postponed settle/fallback/watchdog third cut.
- The two new turn-owned resource cleanup tests cover a PR-1 seam, but were added in PR-5 as refactor safety coverage.

## Alias decision: alpha

Decision: alpha.

Reason: runtime behavior has already hidden or retired the compatibility aliases, and PR-3 should finish documenting that cleanup rather than carrying the aliases into the first post-freeze feature line.

## A1 Current Worktree Inventory

### `git status`

Summary:

- Current branch is `main`.
- `main` is up to date with `origin/main`.
- All freeze work is still unstaged working-tree state.
- There are no commits on top of `main`.
- `knowledge-base.db` is an untracked local artifact and must not be included in any PR.

Modified tracked files:

- `docs/plans/knowledge-base.md`
- `src/bridge/router.ts`
- `src/contract-assistant/runtime-module.ts`
- `src/feishu/api.ts`
- `src/feishu/formatter.ts`
- `src/knowledge/runtime-module.ts`
- `src/labor/runtime-module.ts`
- `src/runtime/app-helpers.ts`
- `src/runtime/app.ts`
- `src/runtime/command-handler.ts`
- `src/runtime/permission-manager.ts`
- `src/runtime/turn-card-manager.ts`
- `src/runtime/turn-executor.ts`
- `test/app-command-surface.test.ts`
- `test/contract-draft-onboard.test.ts`
- `test/contract-workbench.test.ts`
- `test/formatter.test.ts`
- `test/integration/fakes.ts`
- `test/knowledge-flow.test.ts`
- `test/labor-runtime-module.test.ts`
- `test/router.test.ts`
- `test/turn-executor.test.ts`

Deleted tracked files:

- `docs/demo-script.md`
- `docs/plans/2026-04-15-demo-packaging-strategy.md`
- `docs/plans/2026-04-15-labor-dispute-demo-flow.md`
- `docs/plans/2026-04-16-labor-demo-dialogue-and-data.md`
- `docs/qa/20260410-人工验收总结.md`
- `docs/qa/20260420-人工验收手册.md`
- `docs/qa/20260420-提交差距矩阵.md`
- `docs/项目全貌.md`

Untracked project files:

- `docs/architecture-baseline.md`
- `docs/archive/demo/2026-04-15-demo-packaging-strategy.md`
- `docs/archive/demo/2026-04-15-labor-dispute-demo-flow.md`
- `docs/archive/demo/2026-04-16-labor-demo-dialogue-and-data.md`
- `docs/archive/demo/demo-script.md`
- `docs/archive/overview/项目全貌.md`
- `docs/archive/qa/20260410-人工验收总结.md`
- `docs/archive/qa/20260420-人工验收手册.md`
- `docs/archive/qa/20260420-提交差距矩阵.md`
- `docs/plans/compatibility-cleanup.md`
- `docs/plans/formatter-migration.md`
- `docs/plans/new-feature-checklist.md`
- `src/feishu/contract-cards.ts`
- `src/feishu/knowledge-cards.ts`
- `src/feishu/labor-cards.ts`
- `src/feishu/runtime-cards.ts`
- `src/feishu/shared-primitives.ts`
- `src/runtime/feishu-transport.ts`
- `src/runtime/persisted-interaction-manager.ts`
- `src/runtime/runtime-modules.ts`
- `src/runtime/turn-owned-resources.ts`
- `test/persisted-interaction-manager.test.ts`
- `test/runtime-modules.test.ts`
- `test/turn-owned-resources.test.ts`

Untracked local artifact:

- `knowledge-base.db`

### `git diff --stat main...HEAD`

Output: empty.

Interpretation: there are no commits on top of `main`; PR split must be produced from unstaged working-tree changes.

### `git log --oneline main..HEAD`

Output: empty.

Interpretation: no existing commit stack can be reused for PR splitting.

### Old dirty-file check

The earlier old dirty files are no longer all present as independent dirty changes:

- `CHANGELOG.md`: clean in current `git status`.
- `package.json`: clean in current `git status`.
- `src/runtime/preflight.ts`: clean in current `git status`.
- `test/preflight.test.ts`: clean in current `git status`.
- `src/feishu/formatter.ts`: still dirty, now belongs to PR-2 formatter migration.

Initial scan suggested the tree was splittable via `git add -p`. Cross-PR Source Scout below later revised this to require B1 semantic rebuild; see Coverage Check at the end of this document for the current conclusion.

## A2 PR Split Draft

## Merge Order

Required merge order:

1. PR-1 Skeleton Layer.
2. PR-2 Formatter Migration.
3. PR-3 Command Surface Cleanup And Demo Archive.
4. PR-4 Governance Documents.
5. PR-6 Freeze Acceptance.

Independent lane:

- PR-5 TurnExecutor Two Cuts can be pushed and merged at any point before PR-6.

Rationale:

- PR-1 must compile before PR-2, but PR-1 staging must avoid imports that require PR-2-only card family files.
- PR-2 depends on PR-1 seams for transport and module dependencies.
- PR-3 shares files with PR-2 and should land after formatter imports are stable.
- PR-4 can be prepared after PR-1, PR-2, or PR-3, but must merge after PR-3 so `compatibility-cleanup.md` can use the completed-cleanup wording without churn.
- PR-6 is last because it records evidence from all previous PRs.

DoD for every PR:

- After the PR is applied to `main`, `npm run typecheck`, `npm run lint`, and `npm test` must all pass.
- If any PR cannot satisfy this independently, the split is wrong and must stop for re-planning.

### PR-1 Skeleton Layer

Purpose:

- Implement the runtime skeleton seams required by `docs/architecture-baseline.md`.
- Covers transport boundary, runtime module assembly, turn-owned resources, and shared persisted interaction state.

Includes:

- `src/runtime/runtime-modules.ts`
- `src/runtime/feishu-transport.ts`
- `src/runtime/turn-owned-resources.ts`
- `src/runtime/persisted-interaction-manager.ts`
- `src/runtime/app.ts`
- `src/runtime/turn-executor.ts`
- `src/knowledge/runtime-module.ts`
- `src/labor/runtime-module.ts`
- `src/contract-assistant/runtime-module.ts`
- `test/runtime-modules.test.ts`
- `test/turn-owned-resources.test.ts`
- `test/persisted-interaction-manager.test.ts`
- `test/turn-executor.test.ts`
- `test/knowledge-flow.test.ts`
- `test/labor-runtime-module.test.ts`
- `test/contract-draft-onboard.test.ts`
- `test/contract-workbench.test.ts`

Does not include:

- Formatter family extraction implementation.
- Command alias retirement behavior.
- Demo or QA document archive moves.
- TurnExecutor split.
- Governance-only documentation.

Governance mapping:

- `docs/architecture-baseline.md`: Runtime Core, Runtime Modules, Stores and Scripts, Logging and Observability.
- `docs/plans/new-feature-checklist.md`: transport boundary, module state boundary, config boundary.

Staging note:

- B1 is required for this PR. Its content must be produced as a reconstructed commit on the `freeze-reorg` branch per the B1 semantic rebuild procedure below, not by staging hunks from the current working tree.
- `src/knowledge/runtime-module.ts`, `src/labor/runtime-module.ts`, `src/contract-assistant/runtime-module.ts`, and `src/runtime/app.ts` cannot be split by `git add -p` due to intra-hunk mixing confirmed in Cross-PR Source Scout.

Definition of Done:

- PR branch independently passes `npm run typecheck`, `npm run lint`, and `npm test` before the PR is opened.
- Merged `main` passes the same three commands after the PR is applied.
- If any check fails, stop and return to A2 for re-planning. Do not force-merge.

### PR-2 Formatter Migration

Purpose:

- Convert the old monolithic formatter into a compatibility surface.
- Move card families to explicit family files.

Includes:

- `src/feishu/shared-primitives.ts`
- `src/feishu/runtime-cards.ts`
- `src/feishu/knowledge-cards.ts`
- `src/feishu/labor-cards.ts`
- `src/feishu/contract-cards.ts`
- `src/feishu/formatter.ts`
- `src/runtime/turn-card-manager.ts`
- `src/runtime/feishu-transport.ts`
- `src/runtime/command-handler.ts`
- `src/runtime/app-helpers.ts`
- `src/runtime/app.ts`
- `src/knowledge/runtime-module.ts`
- `src/labor/runtime-module.ts`
- `src/contract-assistant/runtime-module.ts`
- `src/feishu/api.ts`
- `src/runtime/permission-manager.ts`
- `test/formatter.test.ts`
- `test/integration/fakes.ts`
- `test/app-command-surface.test.ts`
- `test/contract-draft-onboard.test.ts`
- `test/contract-workbench.test.ts`
- `test/knowledge-flow.test.ts`
- `test/labor-runtime-module.test.ts`

Does not include:

- Alias retirement semantics.
- Runtime module assembly or turn resource ownership.
- Demo or QA archive moves.
- TurnExecutor split.

Governance mapping:

- `docs/architecture-baseline.md`: Output Construction.
- `docs/plans/formatter-migration.md`: family-only entrypoints and compatibility-layer role.
- `docs/plans/new-feature-checklist.md`: formatter boundary.

Staging note:

- B1 is required for this PR. Its content must be produced as a reconstructed commit on the `freeze-reorg` branch per the B1 semantic rebuild procedure below, not by staging hunks from the current working tree.
- `src/knowledge/runtime-module.ts`, `src/labor/runtime-module.ts`, `src/contract-assistant/runtime-module.ts`, and `src/runtime/app.ts` cannot be split by `git add -p` due to intra-hunk mixing confirmed in Cross-PR Source Scout.

Definition of Done:

- PR branch independently passes `npm run typecheck`, `npm run lint`, and `npm test` before the PR is opened.
- Merged `main` passes the same three commands after the PR is applied.
- If any check fails, stop and return to A2 for re-planning. Do not force-merge.

### PR-3 Command Surface Cleanup And Demo Archive

Purpose:

- Retire compatibility aliases under decision alpha.
- Archive demo-first and QA-era documents.
- Update `docs/plans/knowledge-base.md` only for alias-retirement wording so `/legal-query-*` references align with the new `/法律咨询*` and `/kb-query` command surface.

Includes:

- `src/bridge/router.ts`
- `src/runtime/command-handler.ts`
- `src/runtime/app-helpers.ts`
- `src/knowledge/runtime-module.ts`
- `src/labor/runtime-module.ts`
- `src/contract-assistant/runtime-module.ts`
- `docs/plans/knowledge-base.md`
- Deleted tracked demo and QA docs:
  - `docs/demo-script.md`
  - `docs/plans/2026-04-15-demo-packaging-strategy.md`
  - `docs/plans/2026-04-15-labor-dispute-demo-flow.md`
  - `docs/plans/2026-04-16-labor-demo-dialogue-and-data.md`
  - `docs/qa/20260410-人工验收总结.md`
  - `docs/qa/20260420-人工验收手册.md`
  - `docs/qa/20260420-提交差距矩阵.md`
  - `docs/项目全貌.md`
- New archived copies:
  - `docs/archive/demo/2026-04-15-demo-packaging-strategy.md`
  - `docs/archive/demo/2026-04-15-labor-dispute-demo-flow.md`
  - `docs/archive/demo/2026-04-16-labor-demo-dialogue-and-data.md`
  - `docs/archive/demo/demo-script.md`
  - `docs/archive/overview/项目全貌.md`
  - `docs/archive/qa/20260410-人工验收总结.md`
  - `docs/archive/qa/20260420-人工验收手册.md`
  - `docs/archive/qa/20260420-提交差距矩阵.md`
- `test/router.test.ts`
- `test/app-command-surface.test.ts`
- `test/knowledge-flow.test.ts`
- `test/labor-runtime-module.test.ts`
- `test/contract-workbench.test.ts`

Does not include:

- Formatter family extraction except import-level overlaps required by already-moved builders.
- Runtime module assembly or persisted interaction extraction.
- Freeze acceptance document.

Governance mapping:

- `docs/architecture-baseline.md`: Command Surface, Demo-Specific Behavior, Archive policy.
- `docs/plans/compatibility-cleanup.md`: alias retirement state.
- `docs/plans/new-feature-checklist.md`: command surface and docs boundary.

Staging note:

- B1 is required for this PR. Its content must be produced as a reconstructed commit on the `freeze-reorg` branch per the B1 semantic rebuild procedure below, not by staging hunks from the current working tree.
- `src/knowledge/runtime-module.ts`, `src/labor/runtime-module.ts`, and `src/contract-assistant/runtime-module.ts` cannot be split by `git add -p` due to intra-hunk mixing confirmed in Cross-PR Source Scout.

Definition of Done:

- PR branch independently passes `npm run typecheck`, `npm run lint`, and `npm test` before the PR is opened.
- Merged `main` passes the same three commands after the PR is applied.
- If any check fails, stop and return to A2 for re-planning. Do not force-merge.

### PR-4 Governance Documents

Purpose:

- Add the framework-freeze rules that future work must obey.

Includes:

- `docs/architecture-baseline.md`
- `docs/plans/new-feature-checklist.md`
- `docs/plans/compatibility-cleanup.md`
- `docs/plans/formatter-migration.md`

Does not include:

- Runtime implementation changes.
- Formatter implementation changes.
- Alias runtime behavior changes.
- Demo archive moves.
- Freeze acceptance.

Governance mapping:

- This PR defines the governance source of truth rather than implementing one specific code seam.

Staging note:

- `docs/plans/compatibility-cleanup.md` uses completed-cleanup wording.
- `docs/plans/formatter-migration.md` uses completed-migration retrospective wording.
- This PR must merge after PR-3 to avoid wording churn.

Definition of Done:

- PR branch independently passes `npm run typecheck`, `npm run lint`, and `npm test` before the PR is opened.
- Merged `main` passes the same three commands after the PR is applied.
- If any check fails, stop and return to A2 for re-planning. Do not force-merge.

### PR-5 TurnExecutor Two Cuts

Purpose:

- Reduce `TurnExecutor` density without behavior changes.

Includes:

- `src/runtime/turn-executor.ts`
- `test/turn-executor.test.ts`

Does not include:

- TurnExecutor third cut.
- Any formatter, command, module assembly, or transport changes.

Governance mapping:

- `docs/architecture-baseline.md`: Turn Execution backlog / runtime orchestration cleanup.
- `docs/plans/post-freeze-backlog.md`: future TurnExecutor third cut should remain outside this PR.

Staging note:

- This is cleanly separable from the other PRs.

Definition of Done:

- PR branch independently passes `npm run typecheck`, `npm run lint`, and `npm test` before the PR is opened.
- Merged `main` passes the same three commands after the PR is applied.
- If any check fails, stop and return to A2 for re-planning. Do not force-merge.

### PR-6 Freeze Acceptance

Purpose:

- Close stage 5 with evidence, validation, and post-freeze backlog.

Includes:

- `docs/plans/freeze-acceptance.md`
- `docs/plans/post-freeze-backlog.md`
- `docs/plans/freeze-pr-split.md`

Does not include:

- Code changes.
- Alias runtime changes.
- Demo archive moves.

Governance mapping:

- `docs/architecture-baseline.md`: Enforcement and Definition of Done.
- `docs/plans/new-feature-checklist.md`: stage 5 feature-addition seam verification.
- `docs/plans/compatibility-cleanup.md`: final alias state.

Staging note:

- PR-6 should be last and should reference merged PR numbers from PR-1 through PR-5.
- Before PR-6 is opened, re-read this file and update any A-stage assumptions that were invalidated during execution, including whether B1 was triggered and whether any PRs were merged, split, or reordered.

Definition of Done:

- PR branch independently passes `npm run typecheck`, `npm run lint`, and `npm test` before the PR is opened.
- Merged `main` passes the same three commands after the PR is applied.
- If any check fails, stop and return to A2 for re-planning. Do not force-merge.

## Cross-PR Source Scout

Scout command:

- `git diff -- <file>`
- Hunk counts were measured with `git diff -- <file> | rg '^@@' | wc -l`.

### `src/knowledge/runtime-module.ts`

Observed hunk count: 29.

Semantic split:

- PR-1: `FeishuTransport` dependency injection, replacement of direct `deps.sendPayload/updatePayload`, and shared transport helper methods.
- PR-2: imports from `knowledge-cards` and `shared-primitives`, including `buildKnowledgeQueryEmptyPayload({ question })` signature changes.
- PR-3: `/legal-query*` alias retirement notices and command wording updates.

Risk judgment:

- Crosses 3 PRs and exceeds the B1 hunk threshold.
- The first import hunk mixes PR-1 transport types with PR-2 card-family imports.
- Under the intra-hunk policy below, this file triggers B1.

### `src/labor/runtime-module.ts`

Observed hunk count: 13.

Semantic split:

- PR-1: `PersistedInteractionManager`, `FeishuTransport`, dependency injection, stop/restore/persist cleanup.
- PR-2: imports from `labor-cards` and `shared-primitives`.
- PR-3: `/labor-start` and `/labor-end` alias retirement.

Risk judgment:

- Crosses 3 PRs and exceeds the B1 hunk threshold.
- The first import hunk mixes PR-1 state/transport seams with PR-2 card-family imports.
- Under the intra-hunk policy below, this file triggers B1.

### `src/contract-assistant/runtime-module.ts`

Observed hunk count: 47.

Semantic split:

- PR-1: `PersistedInteractionManager`, `FeishuTransport`, dependency injection, stop/restore/persist cleanup.
- PR-2: imports from `contract-cards` and `shared-primitives`, plus removal of local contract card builders.
- PR-3: `/contract-workbench`, extra reminder aliases, and `/案件更新待办` retirement behavior.

Risk judgment:

- Crosses 3 PRs and greatly exceeds the B1 hunk threshold.
- The first import hunk mixes PR-1 state/transport seams with PR-2 contract-card extraction.
- This is the highest-risk staging file and triggers B1.

### `src/runtime/app.ts`

Observed hunk count: 15.

Semantic split:

- PR-1: module assembly through `createRuntimeModules`, `createFeishuTransport`, and turn-owned resource cleanup.
- PR-2: imports from `shared-primitives` instead of the compatibility formatter surface.

Risk judgment:

- Crosses 2 PRs and exceeds 6 hunks, but not the "crosses 3 PRs" numeric threshold.
- It still has possible intra-hunk mixing in the import block, so B1 execution should treat it as high risk.

### `src/runtime/command-handler.ts`

Observed hunk count: 3.

Semantic split:

- PR-2: imports from `runtime-cards` and `shared-primitives`.
- PR-3: `/model` listing alias retirement and `/models` wording.

Risk judgment:

- Crosses 2 PRs and hunk count is below 6.
- Does not independently trigger B1.

### `src/runtime/app-helpers.ts`

Observed hunk count: 2.

Semantic split:

- PR-2: type imports from `shared-primitives` and `runtime-cards`.
- PR-3: provider-list footer wording from `/model <provider>` to `/models <provider>`.

Risk judgment:

- Crosses 2 PRs and hunk count is below 6.
- Does not independently trigger B1.

### `src/feishu/api.ts`

Observed hunk count: 1.

Semantic split:

- PR-2: `FeishuPostPayload` type import moves from `formatter` to `shared-primitives`.

Risk judgment:

- This file should belong to PR-2 only after scout.
- It was previously listed as PR-1/PR-2 cross-PR, but the actual diff shows no PR-1 behavior.

### `src/runtime/permission-manager.ts`

Observed hunk count: 1.

Semantic split:

- PR-2: `buildNoticeCardPayload` and `FeishuPostPayload` imports move from `formatter` to `shared-primitives`.

Risk judgment:

- This file should belong to PR-2 only after scout.
- It was previously listed as PR-1/PR-2 cross-PR, but the actual diff shows no PR-1 behavior.

## Cross-PR Test Scout

Scout command:

- `git diff -- <file>`

### `test/knowledge-flow.test.ts`

Observed hunk count: 5.

Semantic split:

- PR-1: regular-file temp cleanup assertions and outbound bitable resource guard stubs.
- PR-2: knowledge card signature and formatter-family alignment expectations.
- PR-3: retired `/legal-query*` alias expectations.

Risk judgment:

- Crosses 3 PRs and sits exactly at the manual-staging risk edge.
- B1 is not triggered yet because hunk count is below 6, but this file must be staged with extra care.

### `test/labor-runtime-module.test.ts`

Observed hunk count: 4.

Semantic split:

- PR-1: `createFeishuTransport` dependency injection and persisted interaction restart coverage.
- PR-2: labor card family import alignment.
- PR-3: `/labor-start` retirement notice coverage.

Risk judgment:

- Crosses 3 PRs but hunk count is below 6.
- B1 is not triggered yet.

### `test/contract-workbench.test.ts`

Observed hunk count: 5.

Semantic split:

- PR-1: transport injection and module stop cleanup.
- PR-2: contract card family extraction support.
- PR-3: `/contract-workbench` retirement notice and `/合同起草开始` primary command coverage.

Risk judgment:

- Crosses 3 PRs and sits exactly at the manual-staging risk edge.
- B1 is not triggered yet because hunk count is below 6, but this file must be staged with extra care.

### `test/app-command-surface.test.ts`

Observed hunk count: 3.

Semantic split:

- PR-2: formatter/runtime card import compatibility through command surface.
- PR-3: `/models` command surface and legacy `/model` retirement notice.

Risk judgment:

- Crosses 2 PRs and hunk count is below 6.
- B1 is not triggered.

## Intra-hunk Mixing Policy

Default decision: option c.

If a single hunk mixes changes from two or more PRs, trigger B1 immediately.

Rejected alternatives:

- Option a, `git add -e`: allowed by Git, but rejected for this freeze because hand-editing hunks would make the PR split too fragile and weaken the independent DoD.
- Option b, keeping old imports in an earlier PR: rejected for this freeze because it would produce intermediate states that intentionally differ from the final seam and would make evidence harder to trust.

Operational rule:

- Do not hand-edit mixed hunks.
- Do not leave temporary old imports solely to make a partial PR compile.
- Once intra-hunk mixing is found in a cross-PR file, stop normal PR slicing and use B1.

## B1 Trigger Thresholds

Trigger B1 immediately if any of these conditions occurs:

- A file's `git add -p` split produces 6 or more hunks and those hunks span 3 or more PRs.
- Any PR slice fails `npm run typecheck` after being applied to `main`.
- Any PR slice causes `npm test` failures outside that PR's declared scope.
- Any cross-PR file cannot be staged without mixing runtime behavior from two PRs into one commit.

If B1 is triggered, execute the semantic rebuild procedure. This is not re-staging; `git add -p` cannot split intra-hunk mixing and must not be used for the high-mixing files.

Semantic rebuild procedure:

1. Preserve the current working tree as a specification before creating the reorg branch:
   - Run `git diff --binary > /tmp/freeze-worktree.patch`.
   - Run `git status --porcelain > /tmp/freeze-worktree-status.txt`.
   - Copy all untracked project files into a snapshot directory such as `/tmp/feishu-freeze-untracked-snapshot/`.
   - The status file alone is not enough because it only records untracked paths, not file contents.
2. Stash or set aside the dirty working tree so `main` is clean.
3. Create `freeze-reorg` from `main`.
4. Reconstruct PR-1 semantics from scratch by re-editing files on `freeze-reorg` to match only the PR-1 scope (transport injection, module assembly, turn-owned resources, persisted interaction state). Use the preserved diff as reference only; do not copy intra-hunk mixed content wholesale.
5. Run `npm run typecheck && npm run lint && npm test`. All three must pass before committing. If any fails, stop and re-plan; do not commit a red state.
6. Commit PR-1.
7. Repeat steps 4-6 for PR-2 (formatter family extraction + new imports), then PR-3 (alias retirement + demo archive).
8. After the PR-3 commit, `git diff main..freeze-reorg` must be semantically equivalent to `/tmp/freeze-worktree.patch` for PR-1 through PR-3 scope, plus the restored untracked snapshot content. Review any divergence before proceeding to PR-4/PR-5/PR-6.

Intermediate-commit DoD:

- Each of the three reconstruction commits on `freeze-reorg` must independently pass `npm run typecheck`, `npm run lint`, and `npm test`.
- `freeze-reorg` history must be "every commit green", not "only tip green".

Operational bans:

- Once B1 is triggered, do not use `git add -p` anywhere in the PR-1/PR-2/PR-3 reconstruction.
- Do not use `git add -e`.
- Do not hand-edit staged hunks.
- Rebuild each PR semantically on `freeze-reorg`, then use ordinary whole-file `git add` for that reconstructed PR slice.
- Do not use `git rebase -i` or `git reset --hard`.
- Do not commit any intermediate state that fails typecheck, lint, or test.

## Files That Require Explicit Handling

### Local artifact excluded from all PRs

- `knowledge-base.db`

Disposition:

- Do not commit.
- Remove or ignore before staging PRs.
- This is not part of A-stage because A is inventory and planning only.

### Files with cross-PR hunks

These files should not be staged wholesale:

- `src/runtime/app.ts`
- `src/runtime/command-handler.ts`
- `src/runtime/app-helpers.ts`
- `src/knowledge/runtime-module.ts`
- `src/labor/runtime-module.ts`
- `src/contract-assistant/runtime-module.ts`
- `test/app-command-surface.test.ts`
- `test/knowledge-flow.test.ts`
- `test/labor-runtime-module.test.ts`
- `test/contract-workbench.test.ts`

Disposition:

- B1 has already been required by Cross-PR Source Scout findings. Do not use `git add -p` on the three runtime-module files or on `src/runtime/app.ts`; follow the B1 semantic rebuild procedure.
- During B1, do not use `git add -p` on any file. Rebuild PR-1/PR-2/PR-3 contents semantically, then stage whole reconstructed files with ordinary `git add`.

## Coverage Check

All current tracked and untracked project files from A1 are assigned to one of:

- PR-1 Skeleton Layer.
- PR-2 Formatter Migration.
- PR-3 Command Surface Cleanup And Demo Archive.
- PR-4 Governance Documents.
- PR-5 TurnExecutor Two Cuts.
- PR-6 Freeze Acceptance.
- Local artifact excluded from all PRs: `knowledge-base.db`.

Current judgment:

- The worktree is conceptually splittable, but not safely via direct PR slicing from the current mixed working tree.
- B1 is required before B/C because source scout found threshold-breaking cross-PR files and intra-hunk mixing.
- The risky part is not conceptual coverage; it is rebuilding the work into independently compiling PR slices without mixed hunks.
