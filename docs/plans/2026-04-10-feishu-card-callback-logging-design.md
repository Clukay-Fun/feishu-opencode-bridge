# Feishu Card Callback Logging Design

## Scope

Add one callback parsing log entry at the HTTP boundary so Feishu card callback field-shape issues can be diagnosed from logs alone.

## Design

Log a single `callback event parsed` entry in `src/http/server.ts` after extracting `actorOpenId` and `openMessageId` and before forwarding the action to the runtime.

The log fields should include:

- `actorOpenId`
- `openMessageId`
- `actionValueKind`
- flattened raw callback fields under `callback.<path>` keys

Flattening rules:

- recurse through plain objects and arrays
- keep only scalar values: `string`, `number`, `boolean`, `null`
- skip functions and empty objects

## Non-Goals

- no generic logger refactor
- no full raw JSON blob logging
- no changes to permission matching behavior
