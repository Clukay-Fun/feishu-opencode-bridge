# 4/20 Submission Checklist Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the 4/20 submission checklist with a clear sequence of implementation, automated verification, and manual acceptance steps for startup, DM/group flows, permission cards, memory, and deployment.

**Architecture:** Use the existing split of `runtime/preflight.ts`, `runtime/app.ts`, `bridge/router.ts`, `http/server.ts`, and `feishu/ws.ts` as the core implementation surfaces. Expand missing behavior with test-first changes in the nearest existing test files, and treat deployment/memory/demo items as environment-backed acceptance work unless the codebase currently lacks the required hooks.

**Tech Stack:** TypeScript, Node.js, Vitest, ESLint, OpenCode Server API, Feishu WS SDK, Caddy.

---

### Task 1: Baseline Audit And Gap Matrix

**Files:**
- Read: `package.json`
- Read: `src/runtime/preflight.ts`
- Read: `src/runtime/app.ts`
- Read: `src/bridge/router.ts`
- Read: `src/http/server.ts`
- Read: `src/feishu/ws.ts`
- Read: `docs/demo-script.md`
- Read: `docs/deploy.md`
- Test inventory: `test/preflight.test.ts`, `test/group-chat.test.ts`, `test/app-permission-actions.test.ts`, `test/app-whitelist-commands.test.ts`, `test/app-helpers.test.ts`, `test/session-windows.test.ts`
- Create: `docs/qa/20260420-提交差距矩阵.md`

**Step 1: Map every checklist item to code ownership**

Create a matrix with columns:

```md
| Checklist item | Code path | Existing test | Missing work | Verification mode |
| --- | --- | --- | --- | --- |
```

Include all seven sections from the user checklist.

**Step 2: Mark each item as one of three buckets**

- `automated-now`: can be covered with unit/integration tests in repo
- `manual-env`: needs real Feishu/OpenCode/Caddy/device environment
- `blocked-by-scope`: needs memory or external subsystem not yet present in repo

**Step 3: Save the matrix**

Write the file:

```text
docs/qa/20260420-提交差距矩阵.md
```

**Step 4: Review matrix against the user checklist**

Run a manual diff against the provided checklist and confirm every bullet has exactly one row.

**Step 5: Commit**

```bash
git add docs/qa/20260420-提交差距矩阵.md
git commit -m "docs: map 4/20 submission checklist coverage"
```

### Task 2: Startup And Preflight Coverage

**Files:**
- Modify: `src/runtime/preflight.ts`
- Modify: `src/index.ts`
- Test: `test/preflight.test.ts`
- Possibly create: `test/index-startup.test.ts`

**Step 1: Write failing tests for startup edge cases**

Add tests for these cases if missing:

```ts
it("fails when config.json is missing", async () => {
  await expect(loadOrStart(...)).rejects.toThrow(/config\.json/i);
});

it("fails when data dir is not writable", async () => {
  await expect(runStartupPreflight(...)).rejects.toThrow(/数据目录/i);
});

it("fails when Feishu credentials are invalid", async () => {
  await expect(runStartupPreflight(...)).rejects.toThrow(/飞书鉴权/i);
});

it("fails when OpenCode is unavailable", async () => {
  await expect(runStartupPreflight(...)).rejects.toThrow(/OpenCode 健康检查/i);
});

it("fails when worktree mismatches", async () => {
  await expect(runStartupPreflight(...)).rejects.toThrow(/工作目录/i);
});

it("fails when card actions are enabled without publicBaseUrl", async () => {
  await expect(runStartupPreflight(...)).rejects.toThrow(/publicBaseUrl/i);
});
```

**Step 2: Run targeted tests to verify they fail**

Run:

```bash
npm test -- test/preflight.test.ts
```

Expected: failing assertions for the newly added startup cases.

**Step 3: Implement minimal startup/preflight fixes**

Keep logic in `src/runtime/preflight.ts` and process entry behavior in `src/index.ts`. Prefer explicit thrown errors with the exact failed check name.

**Step 4: Re-run targeted tests**

Run:

```bash
npm test -- test/preflight.test.ts
```

Expected: PASS.

**Step 5: Run startup toolchain verification**

Run:

```bash
npm ci && npm run build && npm run typecheck && npm run lint && npm test
```

Expected: all commands exit 0.

**Step 6: Commit**

```bash
git add src/runtime/preflight.ts src/index.ts test/preflight.test.ts test/index-startup.test.ts
git commit -m "test: harden startup preflight coverage"
```

### Task 3: Direct Message Command Surface

**Files:**
- Modify: `src/bridge/router.ts`
- Modify: `src/runtime/app.ts`
- Modify: `src/runtime/session-windows.ts`
- Modify: `src/opencode/client.ts`
- Test: `test/router.test.ts`
- Test: `test/app-helpers.test.ts`
- Test: `test/app-whitelist-commands.test.ts`
- Possibly create: `test/app-model-commands.test.ts`

**Step 1: Write failing tests for missing DM commands**

Add coverage for:

- `/new`
- `/sessions`
- `/switch 2`
- `/switch 999`
- `/status`
- `/model`
- `/model use openai/gpt-5.4`
- `/model reset`
- `/model use nonexistent`
- `/abort` with and without active task

Example test skeleton:

```ts
it("shows current session in /sessions output", async () => {
  const result = await routeIncomingText(...);
  expect(result.kind).toBe("command");
  expect(rendered).toContain("← 当前");
});
```

**Step 2: Run targeted tests to verify failures**

Run:

```bash
npm test -- test/router.test.ts test/app-helpers.test.ts test/app-whitelist-commands.test.ts test/app-model-commands.test.ts
```

Expected: FAIL for the newly introduced command scenarios.

**Step 3: Implement minimal DM command behavior**

Prefer keeping command parsing in `src/bridge/router.ts`, state transitions in `src/runtime/app.ts`, and session bookkeeping in `src/runtime/session-windows.ts`.

**Step 4: Verify targeted tests pass**

Run the same targeted command again.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/bridge/router.ts src/runtime/app.ts src/runtime/session-windows.ts src/opencode/client.ts test/router.test.ts test/app-helpers.test.ts test/app-whitelist-commands.test.ts test/app-model-commands.test.ts
git commit -m "feat: complete dm command coverage"
```

### Task 4: Group Binding And Session Isolation

**Files:**
- Modify: `src/feishu/ws.ts`
- Modify: `src/runtime/app.ts`
- Modify: `src/store/whitelist.ts`
- Modify: `src/store/mappings.ts`
- Test: `test/group-chat.test.ts`
- Test: `test/whitelist.test.ts`
- Test: `test/session-windows.test.ts`

**Step 1: Write failing tests for the full group checklist**

Add tests for:

- first `@bot` binds sender
- bound sender can speak without `@`
- unbound sender without `@` is ignored
- `@bot /who` reports binding status without mutating binding
- `/leave` unbinds
- unbound after `/leave` is ignored again
- topic windows inherit whitelist
- two topics isolate `sessionId`

**Step 2: Run targeted tests to verify failures**

Run:

```bash
npm test -- test/group-chat.test.ts test/whitelist.test.ts test/session-windows.test.ts
```

Expected: FAIL for the new binding/isolation behaviors.

**Step 3: Implement minimal group logic changes**

Keep ingress mention parsing in `src/feishu/ws.ts`, group command behavior in `src/runtime/app.ts`, whitelist persistence in `src/store/whitelist.ts`, and session isolation in `src/runtime/session-windows.ts` plus `src/store/mappings.ts`.

**Step 4: Re-run targeted tests**

Run the same command again.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/feishu/ws.ts src/runtime/app.ts src/store/whitelist.ts src/store/mappings.ts test/group-chat.test.ts test/whitelist.test.ts test/session-windows.test.ts
git commit -m "feat: finish group binding and topic isolation"
```

### Task 5: Permission Flow And Command Fallbacks

**Files:**
- Modify: `src/runtime/app.ts`
- Modify: `src/feishu/formatter.ts`
- Modify: `src/http/server.ts`
- Test: `test/app-permission-actions.test.ts`
- Possibly create: `test/http-server.test.ts`

**Step 1: Write failing tests for missing permission behaviors**

Cover:

- allow once
- allow always
- deny
- timeout click returns timed-out notice
- repeated click is idempotent
- non-requester click rejected
- text `/allow once`
- text `/allow always`
- text `/deny`
- `/close` blocked while running

**Step 2: Run targeted tests to verify failures**

Run:

```bash
npm test -- test/app-permission-actions.test.ts test/http-server.test.ts
```

Expected: FAIL for whichever permission cases are still missing.

**Step 3: Implement minimal permission flow fixes**

Keep click handling in `src/runtime/app.ts`, card payload changes in `src/feishu/formatter.ts`, and callback endpoint behavior in `src/http/server.ts`.

**Step 4: Re-run targeted tests**

Run the same command again.

Expected: PASS.

**Step 5: Commit**

```bash
git add src/runtime/app.ts src/feishu/formatter.ts src/http/server.ts test/app-permission-actions.test.ts test/http-server.test.ts
git commit -m "feat: complete permission card lifecycle"
```

### Task 6: HTTP, Deployment, And Health Checks

**Files:**
- Modify: `src/http/server.ts`
- Modify: `docs/deploy.md`
- Possibly create: `ops/Caddyfile`
- Possibly create: `test/http-server.test.ts`

**Step 1: Write failing tests for HTTP acceptance**

Add tests for:

```ts
it("returns 200 on /healthz", async () => {
  expect(await fetchHealthz()).toEqual({ ok: true });
});

it("returns 404 for unknown routes", async () => {
  expect(status).toBe(404);
});
```

**Step 2: Run targeted HTTP tests to verify failures**

Run:

```bash
npm test -- test/http-server.test.ts
```

Expected: FAIL if the HTTP surface is incomplete.

**Step 3: Implement minimal HTTP/deploy updates**

Keep runtime endpoint logic in `src/http/server.ts`. Update `docs/deploy.md` so the exact deployment steps match the real code and config keys.

**Step 4: Re-run targeted HTTP tests**

Run the same command again.

Expected: PASS.

**Step 5: Manual deployment acceptance on target box**

Run:

```bash
curl http://127.0.0.1:3000/healthz
curl https://<domain>/healthz
```

Expected: both return `{"ok":true}` through the intended path.

**Step 6: Commit**

```bash
git add src/http/server.ts docs/deploy.md ops/Caddyfile test/http-server.test.ts
git commit -m "docs: align deployment and health checks"
```

### Task 7: Memory Module Reality Check

**Files:**
- Read: entire `src/` tree for memory-related code
- Read: package.json dependencies
- Create: `docs/qa/20260420-memory范围说明.md`

**Step 1: Verify whether memory exists in this repo**

Search for:

```text
embedding
memory
vector
obsidian
profile.md
recall
fact extraction
```

**Step 2: Record the result explicitly**

If no memory module exists in this repository, write that these checklist bullets are out of scope for the current codebase and require a separate subsystem.

**Step 3: Save the status note**

Write:

```text
docs/qa/20260420-memory范围说明.md
```

**Step 4: Commit**

```bash
git add docs/qa/20260420-memory范围说明.md
git commit -m "docs: record memory module scope for 4/20"
```

### Task 8: Manual End-To-End Acceptance Runbook

**Files:**
- Modify: `docs/demo-script.md`
- Create: `docs/qa/20260420-人工验收手册.md`

**Step 1: Convert the user checklist into a runbook**

Split the runbook into:

- local automated checks
- private chat checks
- group chat checks
- permission card checks
- deployment checks
- recording checklist

**Step 2: For each item, define exact operator action and expected result**

Example:

```md
1. Send `/abort` in DM with no active task.
Expected: grey notice card containing `无任务可中止`.
Evidence: screenshot + latest bridge log lines.
```

**Step 3: Save the runbook**

Write:

```text
docs/qa/20260420-人工验收手册.md
```

**Step 4: Commit**

```bash
git add docs/demo-script.md docs/qa/20260420-人工验收手册.md
git commit -m "docs: add 4/20 acceptance runbook"
```

### Task 9: Final Verification Pass

**Files:**
- Verify current worktree only

**Step 1: Run full automated verification**

Run:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: all pass.

**Step 2: Run local process smoke test**

Run:

```bash
npm run dev:once
```

Expected: startup preflight passes and the process reaches steady state without startup exceptions.

**Step 3: Run manual env-backed checks**

Execute the runbook in:

```text
docs/qa/20260420-人工验收手册.md
```

Capture screenshots/log snippets for every card type and failure-mode test.

**Step 4: Prepare delivery summary**

Summarize:

- automated pass/fail items
- manual pass/fail items
- blocked items
- evidence locations

**Step 5: Commit final documentation updates**

```bash
git add docs/qa/20260420-*.md docs/demo-script.md
git commit -m "docs: finalize 4/20 submission validation package"
```
