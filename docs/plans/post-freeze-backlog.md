# Post-Freeze Backlog

These items are explicitly not blockers for framework freeze acceptance.

## TurnExecutor Third Cut

- Current state: `prepareTurnExecution()`, `executePromptWithEventStream()`, and `handlePermissionAskedEvent()` reduce the first dense areas.
- Why not a blocker: settle, fallback, and watchdog behavior remained intact during freeze, and the current shape is covered by the existing turn executor and integration tests.
- Suggested trigger: first post-freeze runtime orchestration change or any bug that touches fallback/watchdog behavior.

## Runtime Module Dependency Tightening

- Current state: `createRuntimeModules()` accepts an outbound shape that is narrower at the type boundary than some knowledge-resource consumers need.
- Why not a blocker: runtime guards and tests cover the current assembly path.
- Suggested trigger: before adding another module that downloads or updates Feishu resources.

## FeishuTransport Notice Convenience

- Current state: `sendNotice()` is a known convenience that couples transport to notice-card construction.
- Why not a blocker: it is intentionally Feishu-only and avoids repeated notice-send plumbing.
- Suggested trigger: if another card-family convenience method is proposed.

## Contract Transport Call Style

- Current state: contract and labor modules both use `FeishuTransport`, but their local call style is not perfectly identical.
- Why not a blocker: behavior and ownership are correct; this is consistency cleanup.
- Suggested trigger: next contract-assistant runtime-module edit.

## PersistedInteractionManager Error Semantics

- Current state: `flush()` is designed to log persistence failures rather than throw them back into feature flows.
- Why not a blocker: this preserves current runtime behavior and avoids failing user-facing flows on best-effort persistence writes.
- Suggested trigger: if a caller needs hard durability acknowledgement.

## Expired Interaction Set Semantics

- Current state: restored interactions are filtered for expiry; explicitly setting an already-expired interaction may schedule an immediate expiry.
- Why not a blocker: current callers set future TTLs.
- Suggested trigger: before exposing `PersistedInteractionManager` beyond pending runtime interactions.

## Contract Card Family Follow-Up

- Current state: `contract-cards.ts` exists and business callers use family entrypoints.
- Why not a blocker: formatter compatibility is preserved and tests cover contract cards.
- Suggested trigger: when removing or shrinking the remaining compatibility surface in `formatter.ts`.

