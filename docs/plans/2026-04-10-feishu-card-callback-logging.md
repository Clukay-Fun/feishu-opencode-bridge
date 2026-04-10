# Feishu Card Callback Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Emit a parse-time callback log with flattened scalar Feishu event fields so card callback compatibility issues are easy to diagnose.

**Architecture:** Keep the logging change local to `src/http/server.ts`, where the raw Feishu callback event is still available. Add one focused regression test in `test/http-server.test.ts`, then implement a small event-flattening helper used only by the callback handler.

**Tech Stack:** TypeScript, Node.js, Vitest.

---

### Task 1: Save The Approved Logging Design

**Files:**
- Create: `docs/plans/2026-04-10-feishu-card-callback-logging-design.md`

**Step 1: Write the design note**

Document the log location, required summary fields, and scalar-only flattening rule.

**Step 2: Review scope**

Confirm the design avoids a logger-wide refactor.

### Task 2: Add A Failing Logging Regression Test

**Files:**
- Modify: `test/http-server.test.ts`

**Step 1: Write the failing test**

Add a test that posts a nested callback payload and asserts the logger receives a `callback event parsed` call containing:

```ts
{
  actorOpenId: "ou_nested",
  openMessageId: "om_nested",
  actionValueKind: "permission",
  "callback.operator.operator_id.open_id": "ou_nested",
  "callback.context.open_message_id": "om_nested",
  "callback.action.value.kind": "permission",
}
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- test/http-server.test.ts`

Expected: FAIL because no callback parsing log exists yet.

### Task 3: Implement Minimal Callback Logging

**Files:**
- Modify: `src/http/server.ts`

**Step 1: Add a scalar flatten helper**

Create a small helper that converts nested callback objects into `callback.<path>` fields.

**Step 2: Emit the callback parsing log**

Log the parsed identifiers and flattened callback fields before calling `handlePermissionCardAction()`.

**Step 3: Keep the change local**

Do not move formatting into the shared logger or change other scopes.

### Task 4: Verify The Logging Change

**Files:**
- Test: `test/http-server.test.ts`

**Step 1: Run targeted tests**

Run:

```bash
pnpm test -- test/http-server.test.ts
```

Expected: PASS.

**Step 2: Run the callback regression pair**

Run:

```bash
pnpm test -- test/http-server.test.ts test/app-permission-actions.test.ts
```

Expected: PASS with zero failures.
