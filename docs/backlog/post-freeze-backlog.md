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
