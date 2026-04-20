# Command Handler Notice Refactor Design

## Goal

Reduce repeated `buildNoticeCardPayload + sendPayload` boilerplate inside `src/runtime/command-handler.ts` without changing command behavior, output text, or test setup.

## Scope

Only refactor notice-style command responses inside `src/runtime/command-handler.ts`.

In scope:

- busy-session warnings
- delete confirmation prompts
- expired confirmation notices
- no-active-task notice
- no-pending-permission notice
- model-provider mismatch notice
- other branches already using `buildNoticeCardPayload` directly

Out of scope:

- `buildSessionTransitionCardPayload`
- `buildStatusCommandCardPayload`
- `buildSessionListCardPayload`
- `buildModelListCardPayload`
- `sendMarkdown`
- `BridgeAppContext` changes
- command routing or command semantics

## Design

Add a private `sendNotice()` helper inside `CommandHandler`.

The helper accepts:

- the incoming command message
- a small options object with `title`, `template`, `icon`, and `message`

The helper owns the repeated mechanics:

- builds the notice card payload
- calls `context.sendPayload`
- uses the notice message as `textPreview`
- derives `len` from the same message
- always replies to the source `message.messageId`

This keeps the refactor local to `CommandHandler` and avoids introducing a wider runtime abstraction before it is needed.

## Testing Strategy

Do not reorganize tests for this refactor.

Primary verification stays with existing command-level regressions:

- `test/app-command-surface.test.ts`
- `test/app-whitelist-commands.test.ts`

Only add a new test if the refactor reveals an uncovered notice branch that cannot be validated through current coverage.

## Risk Control

- no behavior changes
- no new command branches
- no payload schema changes
- no helper extraction outside `command-handler.ts`
- no context/interface churn in `BridgeApp`
