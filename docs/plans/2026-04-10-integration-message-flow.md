# Integration Message Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the first in-memory integration test that exercises the bridge from incoming direct message through OpenCode events to final outbound reply.

**Architecture:** Keep the production runtime real and substitute only transport-facing dependencies with in-memory fakes. The first slice covers one direct-message happy path and establishes reusable fake infrastructure for later permission-flow and queue-concurrency tests.

**Tech Stack:** TypeScript, Vitest, existing `BridgeApp`, fake OpenCode client/event stream, fake outbound port.

---

### Task 1: Save The Approved Integration-Test Design

**Files:**
- Create: `docs/plans/2026-04-10-integration-message-flow-design.md`

**Step 1: Write the design note**

Document the one-test scope, fake runtime strategy, and minimal injection rule.

**Step 2: Review scope control**

Confirm this slice does not include permission flow, queue concurrency, or real HTTP/SSE transport.

### Task 2: Add The Failing Integration Test

**Files:**
- Create: `test/integration/message-flow.test.ts`
- Create or Modify: `test/integration/fakes.ts`

**Step 1: Write the failing test**

Add a test like:

```ts
it("processes a direct message end-to-end", async () => {
  const fake = createFakeOpenCodeRuntime({
    finalText: "集成测试回复",
  });
  const app = createBridgeAppWithFakes(fake);

  await app.handleIncomingMessage(createDirectMessage("帮我写个函数"));

  await waitFor(() => expect(fake.outbound.messages).toContainEqual(
    expect.objectContaining({ textPreview: expect.stringContaining("集成测试回复") }),
  ));
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test -- test/integration/message-flow.test.ts
```

Expected: FAIL because the fake runtime/injection path does not exist yet.

### Task 3: Add Minimal Fake Runtime Support

**Files:**
- Create or Modify: `test/integration/fakes.ts`
- Modify: `src/runtime/app.ts` only if constructor injection is required

**Step 1: Implement fake outbound port**

Record sent, replied, and updated messages in memory.

**Step 2: Implement fake OpenCode client**

Provide the minimal methods needed for the happy path:

- `createSession`
- `promptAsync`
- `getSessionMessages`
- startup-safe methods if app construction needs them

**Step 3: Implement fake event stream**

Allow subscribers and emit the predefined assistant delta and idle events when `promptAsync()` runs.

**Step 4: Keep production defaults unchanged**

If production code needs constructor overrides, make them optional and preserve existing behavior.

### Task 4: Make The Integration Test Pass

**Files:**
- Create: `test/integration/message-flow.test.ts`
- Create or Modify: `test/integration/fakes.ts`
- Modify: `src/runtime/app.ts` only if needed for injection

**Step 1: Verify the expected flow inside the test**

Assert:

- a session was created
- process output was emitted
- final assistant text reached outbound
- queue drained after completion

**Step 2: Replace sleeps with condition waits**

Use `vi.waitFor()` or equivalent condition-based polling.

### Task 5: Verify The Slice

**Files:**
- Test: `test/integration/message-flow.test.ts`

**Step 1: Run the focused integration test**

Run:

```bash
pnpm test -- test/integration/message-flow.test.ts
```

Expected: PASS.

**Step 2: Run lint and full suite**

Run:

```bash
npm run lint && npm test
```

Expected: PASS with zero failures.

**Step 3: Commit the isolated integration slice**

```bash
git add test/integration/message-flow.test.ts test/integration/fakes.ts src/runtime/app.ts docs/plans/2026-04-10-integration-message-flow-design.md docs/plans/2026-04-10-integration-message-flow.md
git commit -m "[codex] 增加普通消息全链路集成测试"
```
