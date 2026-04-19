# New Feature Checklist

Use this checklist in every post-freeze feature PR.

## Automated Coverage

The following checklist items are enforced by CI:

- core boundary: `npm run lint:deps` prevents `src/runtime/app.ts`, `src/runtime/turn-executor.ts`, and `src/bridge/router.ts` from importing domain modules at runtime; type-only seam references remain allowed.
- transport boundary: `npm run lint:deps` restricts direct Feishu SDK imports to the transport and ingress boundary files.
- formatter boundary: `npm run lint:deps` prevents new runtime imports of `src/feishu/formatter.ts`, and `npm run check:formatter-exports` keeps the compatibility export surface pinned to `docs/plans/formatter-export-snapshot.json`.
- config boundary: `npm run lint` prevents direct `config.json` reads in `src` outside `src/config/loader.ts` for the common direct-read forms.
- docs boundary: `npm run check:docs-diff` emits a CI warning when seam files change without `docs/architecture-baseline.md`.

The following items still require reviewer judgment:

- module boundary: covered indirectly by the core, transport, and formatter checks, but reviewers should still verify new modules enter through the RuntimeModule assembly seam.
- state boundary: reviewer-only until the shared persisted interaction pattern has a dedicated lint rule.
- command boundary: reviewer-only until command definitions are collected into a manifest.

## Checklist

- `core` boundary: the feature does not add business-specific branching to `src/runtime/app.ts`, `src/runtime/turn-executor.ts`, or `src/bridge/router.ts`
- module boundary: the feature is implemented inside an existing `RuntimeModule`, or adds a new module through the runtime module assembly seam
- transport boundary: Feishu replies, updates, and notices go through `FeishuTransport`; the feature does not introduce new ad-hoc send/update wrappers
- state boundary: module-scoped pending interaction persistence uses the shared persisted interaction infrastructure; the feature does not copy timer + JSON persistence logic
- command boundary: each action keeps one primary command and at most one compatibility alias
- formatter boundary: new cards use the family entrypoints (`shared-primitives`, `runtime-cards`, `knowledge-cards`, `labor-cards`, `contract-cards`) instead of growing a new direct dependency surface on `formatter.ts`
- config boundary: all configuration changes go through `src/config/schema.ts` and `src/config/loader.ts`; the feature does not read `config.json` directly
- docs boundary: if the feature changes a seam, update `docs/architecture-baseline.md` in the same PR before merging

PR reviewers should reject feature changes that violate this checklist unless the baseline is updated first.
