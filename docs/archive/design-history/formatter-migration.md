# Formatter Migration Plan

## Goal

Freeze `src/feishu/formatter.ts` as a compatibility re-export layer, not a growth point.

Family entrypoints are the only legal import surface for card builders and their view types:

- `src/feishu/shared-primitives.ts`
- `src/feishu/runtime-cards.ts`
- `src/feishu/knowledge-cards.ts`
- `src/feishu/labor-cards.ts`
- `src/feishu/contract-cards.ts`

Callers must not add new imports from `src/feishu/formatter.ts`. Existing direct imports should be removed as each family migrates.

This rule mirrors the checklist in [new-feature-checklist.md](/Users/clukay/Program/feishu-opencode-bridge/docs/guidelines/new-feature-checklist.md).

## Migration Order

1. `runtime`
2. `knowledge`
3. `labor`
4. `contract`

## Per-Family Workflow

1. Scout the family in `formatter.ts`.
2. Move shared helpers into `shared-primitives.ts` first.
3. Move family-local types and payload builders into the family file.
4. Update callers to import only from family entrypoints.
5. Run the family's targeted regression tests.

Each step should be a physical move, not a behavior rewrite.

## Scout Workflow

Before moving a family, list:

- exported payload builders in that family
- exported `*View` and related button/value types used by those builders
- private helpers they call directly
- second-order helpers called by those private helpers

Classify each helper into exactly one bucket:

- `shared`: reused across multiple families or part of the stable transport/post surface
- `family-local`: only used by the family being migrated
- `formatter-residual`: still needed only by families that have not moved yet

Only move the `shared` bucket into `shared-primitives.ts` before moving the family body. This keeps each migration one-way and avoids helper duplication or circular imports.

## Expected Shape After Each Family Move

After a family migrates:

- its callers import only from the family file plus `shared-primitives.ts`
- `formatter.ts` retains only unmigrated families and residual helpers, and eventually becomes pure compat re-export
- no migrated family types remain exported only from `formatter.ts`
- no new helper is added back to `formatter.ts` for a migrated family

## Runtime Family Scout Baseline

Runtime payload builders:

- `buildTurnStatusCardPayload`
- `buildStatusCommandCardPayload`
- `buildSessionListCardPayload`
- `buildSessionTransitionCardPayload`
- `buildWhoCommandCardPayload`
- `buildLeaveCommandCardPayload`
- `buildModelListCardPayload`
- `buildPermissionRequestCardPayload`

Runtime exported types:

- `TurnStatusCardView`
- `StatusCommandCardView`
- `SessionListCardView`
- `SessionTransitionCardView`
- `WhoCommandCardView`
- `LeaveCommandCardView`
- `ModelListCardView`
- `PermissionActionButton`
- `PermissionRequestCardView`

Runtime shared-helper candidates:

- `buildInteractivePayload`
- `buildDivider`
- `buildFooterTipBlock`
- `escapeText`

Runtime family-local helper candidates:

- `resolveCardState`
- `buildTurnBodyElements`
- `buildToolElements`
- `buildOutputElements`
- `buildToolBlock`
- `buildOutputBlock`
- `buildSpacerBlock`
- `buildFooter`
- `shortSessionId`
- `formatOutputText`
- `formatOutputLine`
- `formatEscapedMarkdownSegment`
- `neutralizeMarkdownTables`
- `isMarkdownTableRow`
- `isMarkdownTableSeparator`
- `splitMarkdownTableCells`
- `formatMarkdownTableRowAsText`
- `splitMarkdownByCodeFence`
- `fileNameFromPath`
- `buildPermissionRequestBlock`
- `buildPermissionActionBlock`
- `buildModelProviderBlock`
- `buildModelChip`
- `buildStatusCurrentSessionBlock`
- `buildStatusSystemBlock`
- `buildStatusChip`
- `mapStatusChipBackground`
- `buildTwoColumnBadgeRow`
- `buildSessionListItemBlock`
- `formatSessionListTitle`
- `buildEmptyStateBlock`
- `buildSessionTransitionRow`
- `formatToolDisplay`
- `mapToolIcon`
- `CardState`

## Targeted Tests

Run after the `runtime` family moves:

- `test/formatter.test.ts`
- `test/app-command-surface.test.ts`
- `test/app-permission-actions.test.ts`
- `test/turn-executor.test.ts`

## Knowledge Family Scout Baseline

Knowledge payload builders:

- `buildKnowledgeQueryPayload`
- `buildKnowledgeQueryEmptyPayload`
- `buildKnowledgeIngestReadyPayload`
- `buildKnowledgeIngestSessionPayload`
- `buildKnowledgeIngestSessionFinalPayload`
- `buildKnowledgeIngestPayload`
- `buildKnowledgeIngestQueuedPayload`
- `buildKnowledgeIngestFailurePayload`
- `buildKnowledgeIngestProcessingPayload`

Knowledge exported types:

- `KnowledgeQueryEmptyCardView`
- `KnowledgeIngestProgressCardView`
- `KnowledgeIngestQueuedCardView`
- `KnowledgeIngestFailureCardView`
- `KnowledgeIngestSessionSummaryView`

Knowledge builders that use domain result shapes directly:

- `buildKnowledgeQueryPayload(view: KnowledgeQueryResult)`
- `buildKnowledgeIngestPayload(view: KnowledgeIngestResult)`

These function signatures must move with the builders into `knowledge-cards.ts`. Do not leave knowledge-only card signatures behind in `formatter.ts`.

Knowledge shared-helper candidates:

- `cardMarkdown`
- `buildWeightedColumn`
- `buildStretchColumnSet`
- `buildTitleLine`
- `buildGreyPanel`
- `buildQuoteLine`
- `buildElapsedLine`
- `buildStatsRow`
- `buildTagChartSection`
- `buildKnowledgeIngestProgressStepElements`
- `resolveElapsedText`
- `formatDurationMs`
- `formatKnowledgeIngestInlineStatus`
- `normalizeKnowledgeIngestDetail`
- `mapKnowledgeIngestStepIcon`

Helpers that `labor` already uses or is expected to reuse in its migration:

- `buildTitleLine`
- `buildQuoteLine`
- `buildElapsedLine`
- `buildStatsRow`
- `buildTagChartSection`
- `buildKnowledgeIngestProgressStepElements`
- `resolveElapsedText`
- `formatDurationMs`
- `formatKnowledgeIngestInlineStatus`
- `normalizeKnowledgeIngestDetail`
- `mapKnowledgeIngestStepIcon`

Move these into `shared-primitives.ts` before moving the knowledge family body, even if the current `labor` entrypoint still re-exports from `formatter.ts`.

Knowledge family-local helper candidates:

- `buildKnowledgeIngestFinalDetailLines`
- `buildKnowledgeRecordUrl`

Suggested knowledge migration verification:

- confirm local edits in `test/knowledge-flow.test.ts` are unrelated before changing formatter files
- `test/formatter.test.ts`
- `test/knowledge-flow.test.ts`
- `test/app-command-surface.test.ts`
- any knowledge-focused runtime tests touched by import changes
- one full `npm test` sweep after the knowledge migration settles, to protect the later labor move

## Labor Family Scout Baseline

Labor payload builders:

- `buildLaborAnalysisProgressPayload`
- `buildLaborAnalysisCompletedPayload`

Labor exported types:

- `LaborAnalysisProgressCardView`
- `LaborAnalysisCompletedCardView`

Labor shared-helper dependencies already extracted before this move:

- `buildInteractivePayload`
- `buildKnowledgeIngestProgressStepElements`
- `buildTitleLine`
- `buildQuoteLine`
- `buildElapsedLine`
- `buildStatsRow`
- `buildTagChartSection`
- `buildDivider`
- `escapeText`
- `resolveElapsedText`

Labor family-local helper candidates:

- none

Suggested labor migration verification:

- `test/formatter.test.ts`
- `test/labor-runtime-module.test.ts`
- one full `npm test` sweep after the move

## Contract Family Scout Baseline

Contract payload builders:

- `buildCaseCreateProcessingPayload`
- `buildContractDraftProgressPayload`
- `buildContractDraftCompletedPayload`
- `buildCaseCreateCompletedPayload`
- `buildInvoiceRecognizeProgressPayload`
- `buildInvoiceRecognizeCompletedPayload`
- `buildReminderProgressPayload`
- `buildTodayTodoPayload`
- `buildCaseReminderAddCompletedPayload`

Contract exported types:

- `ContractDraftProgressView`
- `InvoiceRecognizeProgressView`
- `ReminderListResult`

Contract shared-helper dependencies:

- `buildNoticeCardPayload`
- `type FeishuPostPayload`

These stay in `shared-primitives.ts`; the contract family imports them but does not recreate them.

Contract family-local helper candidates:

- `buildInteractiveCardPayload`
- `caseMarkdown`
- `casePlainDiv`
- `caseColumnSet`
- `caseColumn`
- `buildCaseChipRow`
- `buildCaseDisplayItems`
- `buildInvoiceChipGroup`
- `buildReminderTodoRow`
- `caseDivider`
- `buildElapsedDiv`
- `parseCaseCreateRequestPreview`
- `normalizeCaseCreateCause`
- `normalizeCaseCreateStage`
- `normalizeCaseCreateStatus`
- `buildContractDraftMetaRows`
- `buildReminderItems`
- `parseCaseReminderLine`
- `parseContractReminderLine`
- `parseInvoiceReminderLine`
- `localizeReminderTitle`
- `classifyCaseTodoTitle`
- `reminderBackground`
- `formatReminderDue`
- `buildInvoiceStepText`
- `mapInvoiceStepIcon`
- `contractDraftSteps`
- `buildContractDraftStepText`
- `mapContractDraftStepIcon`
- `inferContractDraftMeta`
- `extractLabeledValue`
- `cleanupDraftMetaValue`
- `extractContractDraftFee`
- `matchFirst`
- `escapeRegExp`
- `normalizeMoneyText`
- `formatElapsedSeconds`
- `readCaseField`
- `readInvoiceAmount`
- `splitInvoiceSummary`
- `truncateCardText`
- `escapeCardMarkdown`
- `shortProjectPath`

Contract runtime-orchestration helpers that stay in `src/contract-assistant/runtime-module.ts`:

- `renderReminderPlainText`
- `buildBitableRecordUrl`
- `renderWorkbenchSummaryMessage`

Suggested contract migration verification:

- `test/formatter.test.ts`
- `test/contract-draft-onboard.test.ts`
- `test/contract-workbench.test.ts`
- `test/contract-workbench-export.test.ts`
- one full `npm test` sweep after the move

## Compatibility Test Scope

`test/formatter.test.ts` is the compatibility-layer regression test.

It should verify that `src/feishu/formatter.ts` still re-exports the supported public card surface. Family behavior details belong in family or runtime-module tests, not in new formatter-only unit tests.
