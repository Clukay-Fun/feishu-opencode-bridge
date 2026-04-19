# Architecture Baseline

> Last updated: 2026-04-18
>
> This document defines the architecture baseline for the post-demo phase.
> If it conflicts with demo-oriented notes, this document wins for code organization.

## Goal

Framework is frozen at the seams; features expand inside them.

This repository is now moving from "demo-first stabilization" to "framework freeze + feature expansion".

The goal of the baseline is not to redesign the project.
The goal is to fix the boundaries that must stay stable while new features continue to land.

Current scope remains intentionally narrow:

- Feishu is the only channel
- OpenCode remains the only runtime backend owned by the bridge
- deployment stays single-host
- the bridge remains a TypeScript service, not a desktop app and not a multi-channel platform

## Product Positioning

This project is a Feishu-native runtime bridge for OpenCode.

It is not:

- a generic IM bot framework
- a desktop AI shell
- a multi-channel agent platform
- a pure business workflow app

It is:

- a Feishu ingress and egress layer
- a session-aware runtime shell
- a bridge-owned command and process-control surface
- a host for business modules such as knowledge, contract assistant, labor, and memory

## Baseline Principles

### 1. Keep the Core Small

`core` owns runtime mechanics only.

It may know:

- message ingress and egress
- session windows
- queueing
- turn lifecycle
- process cards and final replies
- permission and question interactions
- bridge-owned commands

It must not keep growing business-specific branches.

### 2. Feishu-Only, But Not Feishu-Spaghetti

We do not need a generic multi-channel abstraction.
We do need a clean Feishu transport boundary.

That means Feishu-specific delivery concerns should converge behind stable transport-style APIs instead of being reimplemented inside every module.

### 3. Business Logic Lives in Modules and Services

Business modules may own:

- command interpretation inside their own namespace
- pending interactions
- feature state persistence
- prompt overlays
- orchestration of their own services and workflows

Business modules must not take over bridge session control.

### 4. Expansion Must Reuse Existing Seams

New features should plug into:

- `RuntimeModule.handleMessage()`
- `RuntimeModule.beforeTurn()`
- `RuntimeModule.afterTurn()`
- service / workflow helpers
- dedicated stores

New features should not expand the core through ad-hoc hooks.

## Target Layer Boundaries

```text
Feishu Transport
  -> Core Runtime
    -> Runtime Modules
      -> Domain Services / Workflows
        -> Stores / External APIs / Local Tools
```

### 1. Feishu Transport

Current implementation is spread across:

- `src/feishu/api.ts`
- `src/feishu/ws.ts`
- `src/feishu/formatter.ts`
- parts of `src/http/server.ts`
- parts of `src/runtime/app.ts`

Stable responsibilities:

- parse Feishu inbound messages and attachments
- send and update messages and cards
- normalize callback inputs
- handle Feishu markdown and card payload rules
- encapsulate delivery details such as reply vs thread reply
- emit logs and transcripts through the shared logger pipeline using stable scope naming and the observability event schema

Must not own:

- business command semantics
- session switching logic
- knowledge / contract / labor decisions
- custom log sinks or feature-specific transcript stores

Target direction:

- converge repeated `sendPayload` / `updatePayload` / notice-card flows into a stable Feishu transport helper layer

### 2. Core Runtime

Current implementation is mainly:

- `src/runtime/app.ts`
- `src/runtime/command-handler.ts`
- `src/runtime/turn-executor.ts`
- `src/runtime/permission-manager.ts`
- `src/runtime/session-windows.ts`
- `src/bridge/*`

Stable responsibilities:

- route inbound messages into command, pending interaction, module chain, or default turn flow
- own bridge command surface such as `/new`, `/sessions`, `/status`, `/close`, `/delete`
- own queueing, turn execution, watchdog, process-card lifecycle, and final reply delivery
- own session-window state and interaction mode state
- emit turn, permission, and module lifecycle events using the observability event schema

Must not own:

- feature-specific pending state machines
- feature-specific ingest queues
- feature-specific persistence files
- feature-specific command aliases

### 3. Runtime Modules

Current modules:

- `knowledge`
- `contract-assistant`
- `labor`
- `memory`

Stable responsibilities:

- claim or ignore messages through `RuntimeModule`
- inject system prompt blocks through `beforeTurn`
- do feature-specific after-turn work through `afterTurn`
- persist only their own state
- implement `stop()` when owning timers, workers, handles, or temporary runtime resources

Must not own:

- direct manipulation of other modules' state
- bridge session creation, deletion, rename, or switch semantics
- generic Feishu delivery policy

Stop contract:

- `stop()` must leave no owned timer, interval, worker, temp resource, or pending background handle behind
- cleanup that is required for correctness must not be deferred to process exit

### 4. Domain Services and Workflows

Representative files:

- `src/knowledge/index.ts`
- `src/contract-assistant/index.ts`
- `src/labor/index.ts`
- `src/workflows/evidence-extract.ts`

Stable responsibilities:

- pure or mostly pure feature logic
- OpenCode prompt composition for domain tasks
- local file and data transformations
- external system interaction wrappers relevant to that feature

Must not own:

- chat UI behavior
- pending interaction TTL management
- conversation routing

### 5. Stores and Scripts

Representative files:

- `src/store/*`
- `scripts/*`

Stable responsibilities:

- persistence
- local CLI entrypoints
- startup and diagnosis tools

Must not leak back into runtime flow as feature orchestration shortcuts.

`src/runtime/preflight.ts` and `scripts/checks.mjs` belong to the same diagnostic surface:

- preflight runs during startup as a runtime gate
- doctor and checks run standalone without entering the runtime handler chain

### 6. Configuration

Representative files:

- `src/config/schema.ts`
- `src/config/loader.ts`

Stable responsibilities:

- define the shared configuration schema and cross-field validation
- resolve paths, URLs, defaults, and compatibility fallbacks into a runtime-ready config object
- provide the single configuration entrypoint for core, modules, and scripts

Must not own:

- runtime state
- feature interaction state
- per-feature ad-hoc config loading paths

Rule:

- all feature configuration goes through the shared schema and loader
- modules may consume injected config only; they must not read `config.json` directly or maintain parallel feature config files

### 7. Logging and Observability

Representative files:

- `src/logging/logger.ts`
- transcript and payload logging call sites in `src/runtime/*` and feature modules

Stable responsibilities:

- provide the shared logging and transcript pipeline for runtime, transport, and modules
- enforce consistent scope naming so logs remain queryable across features

Rule:

- features must log through the shared logger only
- log scopes should follow `area/subject` style such as `bridge/app`, `knowledge/sync`, or `contract-assistant/state`
- features must not introduce separate log sinks, sidecar log files, or ad-hoc transcript stores

## Fixed Extension Seams

These are the preferred places to extend the system.

### New Runtime Capability

Use a new `RuntimeModule`.

Good fit:

- a feature that needs its own command surface
- a feature that needs pending interaction state
- a feature that needs prompt overlays or after-turn hooks

Bad fit:

- a single helper function
- a one-off formatting tweak

### New Business Logic

Use a service or workflow helper.

Good fit:

- parsing, extraction, normalization, rendering, syncing

Bad fit:

- inline logic directly inside `app.ts` or `turn-executor.ts`

### New Persistence

Use a dedicated store or a module-owned state file.

Rule:

- state belongs to exactly one feature owner

### New Prompt Rule

Use:

- bridge-level system prompt only for bridge runtime rules
- module `beforeTurn()` for feature overlays

Rule:

- prompt additions must be layered, not appended ad hoc across unrelated files

## What Must Stop Growing

The following growth paths are now explicitly disallowed.

### 1. New Business Branches in Core

Do not add more feature-specific `if` branches into the core runtime just because it is convenient.

Examples of bad direction:

- core learning feature-specific ingest modes
- core storing feature-specific pending interactions
- core special-casing one module's commands or outputs

### 2. Raw Delivery Logic Scattered Across Modules

Modules should not each reinvent:

- notice-card delivery
- processing-card transitions
- reply threading policy
- payload logging metadata

The current codebase still has repetition here.
New code must reduce that repetition, not copy it.

### 3. Command Alias Explosion

Every new alias increases:

- parser complexity
- test matrix size
- documentation cost

Rule:

- one primary command name per feature action
- at most one compatibility alias when justified

### 4. Demo-Specific Behavior in Production Paths

Demo copy, demo shortcuts, and half-connected commands must not remain in active product flows.

If a command is not really supported, do one of two things:

- complete it
- remove or hide it

Do not keep expanding recognized-but-not-implemented surfaces.
Any recognized-but-not-implemented command must be completed, hidden, or removed before the next major feature PR lands.

### 5. Cross-Feature State Coupling

No feature may directly persist or mutate another feature's internal state file or in-memory interaction state.

## Enforcement

Reviewers reject PRs that violate these rules.
If a violation is genuinely unavoidable, update this baseline first, then proceed.
Feature PRs should also run through [new-feature-checklist.md](/Users/clukay/Program/feishu-opencode-bridge/docs/plans/new-feature-checklist.md).
Compatibility debt tracked during freeze lives in [compatibility-cleanup.md](/Users/clukay/Program/feishu-opencode-bridge/docs/plans/compatibility-cleanup.md).

## Current Debt That Blocks Clean Expansion

These are the most important debts to address before major feature growth.

### P1. Core Still Knows Too Much About Concrete Modules

`BridgeApp` still constructs and wires concrete modules directly.
That is acceptable for now, but the dependency surface should stop growing.

Near-term rule:

- no new feature should require widening `BridgeApp` with more feature-specific behavior outside module registration and stable deps

### P1. Ordinary File Handling Leaks Temp Files

Regular uploaded files are written to temp directories for OpenCode turns.
Those paths are not yet cleaned up after turn completion.

This should be fixed before file-heavy features grow further.

### P1. Module State Persistence Is Reimplemented Per Feature

Contract assistant and labor each maintain similar patterns for:

- restore
- TTL timers
- persist chain
- flush

This should become shared infrastructure instead of a copied pattern.

### P2. Output Construction Is Becoming a New Monolith

`src/feishu/formatter.ts` is now large enough to become the next structural bottleneck.

Target split should be by view family, not by arbitrary helper extraction.
The split should happen in two levels:

- shared post and notice primitives
- feature-facing card families that depend on those primitives

Suggested direction:

- runtime cards
- session cards
- knowledge cards
- contract cards
- labor cards
- shared post / notice primitives

### P2. Turn Execution Is Too Dense

`TurnExecutor.executeTurn()` is still the hardest logic path in the codebase.

Before adding more runtime behaviors, split it by responsibility:

- stream session setup
- event accumulation
- permission and question handling
- fallback resolution
- finalize and cleanup

### P2. Command Parsing Needs a Registry Direction

`src/bridge/router.ts` currently encodes many rules inline.
This is still manageable, but it should not continue scaling linearly forever.

Do not rewrite it prematurely.
Do treat command growth as a signal to move toward registries.

## Deletion and Archival Direction

The following cleanup direction is part of the baseline.

### Archive

- demo-only plans and script materials
- one-off submission and acceptance notes
- outdated scale and metrics snapshots

Suggested home:

- `docs/archive/demo/`
- `docs/archive/qa/`

Archived documents are read-only snapshots and should not be edited in place.

### Remove or Consolidate

- thin wrapper scripts that duplicate a single CLI entrypoint
- obsolete command aliases after a compatibility window
- feature surfaces that are recognized but not actually implemented

## Definition of Done for "Framework Freeze"

The framework can be considered frozen enough for expansion when all of the following are true:

- adding a new feature does not require adding business logic to `core`
- adding a new feature does not require copying another module's state persistence pattern
- adding a new feature does not require duplicating raw Feishu delivery code
- prompt additions can be placed in a known layer without ambiguity
- unsupported commands are removed instead of acknowledged vaguely

DoD is verified by attempting one real feature addition and checking whether any of the rules above were violated.
If a real feature cannot land cleanly inside these seams, the framework has not yet been frozen enough.

## Next Recommended Sequence

1. Fix temp file cleanup for ordinary uploaded files
2. Extract shared module interaction-state persistence helpers
3. Narrow `BridgeApp` module wiring surface and stop widening feature-specific deps
4. Split `feishu/formatter.ts` into per-feature card families plus shared post / notice primitives
5. Tighten command surface and remove weak aliases
6. Archive demo-first documents that no longer define the product direction

## Relationship to Existing Docs

- `docs/runtime-layering.md` describes the runtime split direction
- this document defines the stricter post-demo baseline and extension rules
- feature plans under `docs/plans/` remain useful, but they do not override this baseline
