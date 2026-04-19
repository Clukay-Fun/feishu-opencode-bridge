# New Feature Checklist

Use this checklist in every post-freeze feature PR.

- `core` boundary: the feature does not add business-specific branching to `src/runtime/app.ts`, `src/runtime/turn-executor.ts`, or `src/bridge/router.ts`
- module boundary: the feature is implemented inside an existing `RuntimeModule`, or adds a new module through the runtime module assembly seam
- transport boundary: Feishu replies, updates, and notices go through `FeishuTransport`; the feature does not introduce new ad-hoc send/update wrappers
- state boundary: module-scoped pending interaction persistence uses the shared persisted interaction infrastructure; the feature does not copy timer + JSON persistence logic
- command boundary: each action keeps one primary command and at most one compatibility alias
- formatter boundary: new cards use the family entrypoints (`shared-primitives`, `runtime-cards`, `knowledge-cards`, `labor-cards`, `contract-cards`) instead of growing a new direct dependency surface on `formatter.ts`
- config boundary: all configuration changes go through `src/config/schema.ts` and `src/config/loader.ts`; the feature does not read `config.json` directly
- docs boundary: if the feature changes a seam, update `docs/architecture-baseline.md` in the same PR before merging

PR reviewers should reject feature changes that violate this checklist unless the baseline is updated first.
