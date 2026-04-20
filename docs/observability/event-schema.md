# Observability Event Schema

> Last updated: 2026-04-19
>
> This document defines the first stable event vocabulary for bridge runtime logs.
> It is documentation-first on purpose: code should migrate toward these names instead of inventing new text per call site.

## Goal

Make one bridge turn traceable from ingress to final delivery with stable event names and predictable fields.

The runtime already has a shared logger. The next observability phase should add request context propagation, JSON line output, and event helpers without replacing that logger wholesale.

## Common Envelope

Every structured bridge event should use this envelope:

- `ts`: ISO timestamp emitted by the logger
- `level`: `debug`, `info`, `warn`, or `error`
- `scope`: stable logger scope, such as `bridge/queue` or `feishu/reply`
- `event`: one of the event names in this document
- `msg`: short human-readable message for local debugging
- `correlationId`: id shared by one inbound Feishu event and all work it triggers
- `turnId`: bridge turn id, when a turn exists
- `sessionId`: OpenCode session id, when available
- `chatId`: Feishu chat id, when available
- `userId`: Feishu sender id, when available
- `messageId`: Feishu message id, when available

Field rules:

- Event-specific fields may be added, but must use stable names.
- Raw user message content must not be logged by default.
- Message previews must follow the configured message logging policy.
- Transcript files remain separate from structured bridge events.

## Event Names

### `turn.started`

Emitted when a queued turn begins execution.

Required fields:

- `turnId`
- `sessionId`
- `chatId`
- `conversationKey`

Trigger point:

- `TurnExecutor` after the turn enters active execution.

### `turn.completed`

Emitted when a turn finishes successfully.

Required fields:

- `turnId`
- `sessionId`
- `durationMs`

Optional fields:

- `replyLength`
- `processMessageId`
- `finalMessageId`

Trigger point:

- `TurnExecutor` after final reply delivery and cleanup.

### `turn.failed`

Emitted when a turn fails before normal completion.

Required fields:

- `turnId`
- `chatId`
- `conversationKey`
- `errorKind`
- `detail`

Optional fields:

- `sessionId`
- `durationMs`

Trigger point:

- `TurnExecutor` catch path around turn execution.

### `turn.fallback_triggered`

Emitted when the bridge falls back to a degraded turn behavior.

Required fields:

- `turnId`
- `fallbackKind`
- `reason`

Optional fields:

- `sessionId`
- `chatId`

Trigger point:

- Runtime fallback branches, such as degraded reply or process-card fallback.

### `permission.asked`

Emitted when the bridge asks the user to approve or deny a runtime permission request.

Required fields:

- `turnId`
- `permissionId`
- `permissionKind`
- `chatId`

Optional fields:

- `sessionId`
- `toolName`

Trigger point:

- `PermissionManager` after sending the permission card.

### `permission.decided`

Emitted when the user or timeout path decides a permission request.

Required fields:

- `turnId`
- `permissionId`
- `decision`
- `decisionSource`

Optional fields:

- `sessionId`
- `chatId`
- `durationMs`

Allowed values:

- `decision`: `approved`, `denied`
- `decisionSource`: `user`, `timeout`, `system`

Trigger point:

- `PermissionManager` card action and auto-deny paths.

### `module.invoked`

Emitted when a runtime module claims or processes a message or hook.

Required fields:

- `moduleId`
- `hook`
- `result`

Optional fields:

- `turnId`
- `chatId`
- `conversationKey`
- `durationMs`

Allowed values:

- `hook`: `handleMessage`, `beforeTurn`, `afterTurn`, `stop`
- `result`: `claimed`, `ignored`, `completed`

Trigger point:

- `RuntimeModuleManager` around module hook dispatch.

### `module.failed`

Emitted when a runtime module hook throws or returns an invalid result.

Required fields:

- `moduleId`
- `hook`
- `errorKind`
- `detail`

Optional fields:

- `turnId`
- `chatId`
- `conversationKey`

Trigger point:

- `RuntimeModuleManager` error handling around module hook dispatch.

### `transport.sent`

Emitted when the Feishu transport successfully sends or updates a bridge-owned message.

Required fields:

- `chatId`
- `messageId`
- `transportAction`
- `payloadKind`

Optional fields:

- `turnId`
- `textPreview`
- `len`

Allowed values:

- `transportAction`: `send`, `update`, `reply`, `thread_reply`
- `payloadKind`: `card`, `post`, `text`, `markdown`

Trigger point:

- Feishu transport and turn card manager send/update success paths.

### `transport.failed`

Emitted when the Feishu transport fails to send or update a bridge-owned message.

Required fields:

- `transportAction`
- `payloadKind`
- `errorKind`
- `detail`

Optional fields:

- `turnId`
- `chatId`
- `messageId`

Trigger point:

- Feishu transport and turn card manager send/update failure paths.

## Privacy Policy

Structured logs should default to operational metadata, not content.

Default redaction list:

- `feishu.appSecret`
- `opencode.apiKey`
- raw inbound user message content
- raw OpenCode reply content
- file contents and attachment contents

Recommended message policies:

- `none`: do not log message content or preview
- `hash`: log only a deterministic hash
- `preview`: log a short normalized preview
- `full`: log full content only for local diagnosis

The default production policy should be `preview` or stricter.

## Migration Order

1. Add request context propagation so `correlationId` and `turnId` are automatic.
2. Add JSON line output while keeping pretty local output configurable.
3. Add `logger.event(event, fields)` with the event names above.
4. Migrate seam files one group at a time.

Initial seam groups:

- ingress: `src/feishu/ws.ts`, `src/http/server.ts`
- turn runtime: `src/runtime/turn-executor.ts`
- permissions: `src/runtime/permission-manager.ts`
- modules: `src/runtime/runtime-modules.ts`
- transport: `src/runtime/feishu-transport.ts`, `src/runtime/turn-card-manager.ts`
