# Integration Message Flow Design

## Goal

Add the first high-fidelity integration test for the bridge runtime by covering the normal direct-message flow end-to-end without using a real HTTP server or real SSE transport.

## Scope

In scope:

- one new integration test file under `test/integration/`
- a single end-to-end direct-message happy-path test
- minimal fake OpenCode runtime pieces required for that path
- minimal dependency injection changes only if `BridgeApp` cannot be instantiated with fakes cleanly

Out of scope:

- permission-flow integration tests
- queue concurrency integration tests
- real HTTP server
- real SSE server
- real Feishu API calls

## Design

### Test Shape

Create `test/integration/message-flow.test.ts` with one primary test:

- `processes a direct message end-to-end`

The test should drive a real `BridgeApp` instance and verify:

- a session is created and bound
- a process card is sent or updated
- OpenCode events advance the turn
- a final reply is sent back through the outbound port
- the queue drains at the end

### Fake Runtime Strategy

Use in-memory fakes instead of transport-level mocks.

Required fake pieces:

- fake OpenCode client
- fake OpenCode event stream
- fake outbound port

`promptAsync()` should trigger a predefined event sequence and also persist a final assistant message in memory so `getSessionMessages()` can serve the fallback and finalization path.

### Injection Boundary

If current `BridgeApp` construction makes fake injection difficult, add the smallest possible constructor-level override mechanism.

Rules:

- no test-only branches in runtime logic
- production defaults unchanged
- injection only for already abstracted dependencies such as client, event stream, outbound, or logger

## Testing Strategy

The new integration test is additive. Keep all current unit tests unchanged.

Verification focus:

- process update observed
- final reply observed
- queue finished
- no hangs or arbitrary sleeps

Use condition-based waiting instead of fixed delays.
