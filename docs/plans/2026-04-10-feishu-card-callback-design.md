# Feishu Card Callback Compatibility Design

## Scope

Fix permission card callbacks that fail when Feishu sends alternate callback field shapes. Keep the change narrow to callback parsing and permission interaction matching.

## Root Cause

`src/http/server.ts` currently forwards only top-level `open_id` and `open_message_id` fields to the runtime. Real Feishu card callbacks do not always place these values at the top level.

`src/runtime/app.ts` currently treats `open_message_id` as a required match key. When Feishu omits that field, the action is rejected even when `nonce`, `sessionId`, `permissionId`, `turnId`, and `conversationKey` all match.

## Design

### Callback Parsing

Normalize the actor and message identifiers at the HTTP boundary before calling `handlePermissionCardAction()`.

Supported actor paths:

- `operator.open_id`
- `operator.operator_id.open_id`
- `context.open_id`
- `open_id`

Supported message-id paths:

- `context.open_message_id`
- `open_message_id`

If a field is absent, pass an empty string instead of `undefined` so the runtime sees a stable shape.

### Permission Matching

Keep the existing matching keys:

- `conversationKey`
- `permissionId`
- `sessionId`
- `turnId`
- `nonce`

Only compare `open_message_id` when the callback payload actually includes one. If Feishu omits the field, treat the other identifiers as sufficient.

## Testing

Add regression coverage in:

- `test/http-server.test.ts` for nested actor/message-id extraction
- `test/app-permission-actions.test.ts` for missing `open_message_id`

## Non-Goals

- No generic callback normalization layer
- No logging schema cleanup in this patch
- No unrelated permission-card refactor
