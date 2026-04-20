# Feishu Card Callback Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make permission card callbacks keep working when Feishu sends nested actor identifiers or omits `open_message_id`.

**Architecture:** Normalize callback identifiers at the HTTP server boundary, then keep runtime matching strict on `nonce`, `sessionId`, `permissionId`, `turnId`, and `conversationKey` while treating `open_message_id` as optional. Cover both boundaries with focused regression tests.

**Tech Stack:** TypeScript, Node.js, Vitest, Feishu card callback adapter.

---

### Task 1: Document The Accepted Callback Shapes

**Files:**
- Create: `docs/plans/2026-04-10-feishu-card-callback-design.md`

**Step 1: Write the design note**

Document the supported actor and message-id field paths and the rule that `open_message_id` is optional for runtime matching.

**Step 2: Review for scope control**

Confirm the design does not introduce a generic parser or unrelated logging work.

### Task 2: Add Failing HTTP Callback Tests

**Files:**
- Modify: `test/http-server.test.ts`

**Step 1: Write the failing test**

Add a test that posts a nested callback payload such as:

```ts
{
  operator: { operator_id: { open_id: "ou_nested" } },
  context: { open_message_id: "om_nested" },
  action: { value: { kind: "permission" } },
}
```

Expect `handlePermissionCardAction("ou_nested", "om_nested", { kind: "permission" })`.

**Step 2: Run test to verify it fails**

Run: `pnpm test -- test/http-server.test.ts`

Expected: FAIL because the server still reads only top-level fields.

### Task 3: Add Failing Runtime Matching Test

**Files:**
- Modify: `test/app-permission-actions.test.ts`

**Step 1: Write the failing test**

Add a test that invokes `handlePermissionCardAction()` with an empty `openMessageId` for an otherwise valid permission interaction.

**Step 2: Run test to verify it fails**

Run: `pnpm test -- test/app-permission-actions.test.ts`

Expected: FAIL with the expired or mismatched interaction notice.

### Task 4: Implement The Minimal Fix

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/runtime/app.ts`

**Step 1: Add minimal callback field extraction**

In `src/http/server.ts`, extract actor open id from the allowed nested paths and extract `open_message_id` from the supported paths. Default missing values to `""`.

**Step 2: Relax only the message-id check**

In `src/runtime/app.ts`, compare `interaction.permissionMessageId` with `openMessageId` only when `openMessageId` is non-empty.

**Step 3: Keep the rest of the match unchanged**

Do not change nonce, session, turn, permission, or conversation matching.

### Task 5: Verify The Regression Fix

**Files:**
- Test: `test/http-server.test.ts`
- Test: `test/app-permission-actions.test.ts`

**Step 1: Run targeted tests**

Run:

```bash
pnpm test -- test/http-server.test.ts test/app-permission-actions.test.ts
```

Expected: PASS with zero failures.

**Step 2: Review diff scope**

Confirm only the two source files and two test files changed, plus the plan/design docs.
