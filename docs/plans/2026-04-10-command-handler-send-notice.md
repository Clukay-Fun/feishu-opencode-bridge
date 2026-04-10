# Command Handler Send Notice Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove repeated notice-card sending boilerplate from `CommandHandler` while preserving all current command behavior and test coverage.

**Architecture:** Keep the refactor entirely inside `src/runtime/command-handler.ts` by adding a private `sendNotice()` helper and routing existing notice-style command branches through it. Do not change `BridgeAppContext`, routing, or non-notice card types.

**Tech Stack:** TypeScript, Vitest, existing Feishu formatter payload builders.

---

### Task 1: Save The Approved Refactor Design

**Files:**
- Create: `docs/plans/2026-04-10-command-handler-send-notice-design.md`

**Step 1: Write the design note**

Document the exact in-scope notice branches, the out-of-scope payload types, and the requirement to keep test organization unchanged.

**Step 2: Review scope control**

Confirm the design does not modify `BridgeAppContext`, command routing, or command semantics.

### Task 2: Identify Notice-Only Call Sites

**Files:**
- Modify: `src/runtime/command-handler.ts`

**Step 1: List the direct notice send sites**

Identify each branch currently using this pattern:

```ts
await this.context.sendPayload(message.chatId, buildNoticeCardPayload({ ... }), {
  event: "final message sent",
  transcriptType: "outbound-final",
  textPreview: "...",
  len: ...,
}, { replyToMessageId: message.messageId });
```

**Step 2: Keep non-notice payloads untouched**

Leave session list, transition, status, and model list payloads unchanged.

### Task 3: Add The Failing Refactor Check

**Files:**
- Test: `test/app-command-surface.test.ts`
- Test: `test/app-whitelist-commands.test.ts`

**Step 1: Run existing command regression tests before refactor**

Run:

```bash
pnpm test -- test/app-command-surface.test.ts test/app-whitelist-commands.test.ts
```

Expected: PASS on the current baseline before touching the implementation.

**Step 2: Decide whether extra test coverage is needed**

If current tests already cover the replaced notice branches, do not add new tests. If a replaced branch is uncovered, add one minimal regression test before the implementation step.

### Task 4: Implement `sendNotice()`

**Files:**
- Modify: `src/runtime/command-handler.ts`

**Step 1: Add a private helper**

Add a method with a shape like:

```ts
private async sendNotice(
  message: CommandMessage,
  options: {
    title: string;
    template: "yellow" | "grey" | "blue" | "red" | "orange";
    icon: string;
    message: string;
  },
): Promise<void>
```

**Step 2: Implement the repeated payload send flow once**

Inside the helper:

- call `buildNoticeCardPayload`
- call `this.context.sendPayload`
- set `textPreview` to `options.message`
- set `len` to `options.message.length`
- reply to `message.messageId`

**Step 3: Replace only notice branches**

Update each in-scope branch to call `sendNotice()` instead of open-coding the payload send.

### Task 5: Verify The Refactor

**Files:**
- Test: `test/app-command-surface.test.ts`
- Test: `test/app-whitelist-commands.test.ts`
- Modify: `src/runtime/command-handler.ts`

**Step 1: Run lint and command regressions**

Run:

```bash
npm run lint && pnpm test -- test/app-command-surface.test.ts test/app-whitelist-commands.test.ts
```

Expected: PASS.

**Step 2: Run full suite if command regressions pass**

Run:

```bash
npm test
```

Expected: PASS with zero failures.

**Step 3: Commit the isolated refactor**

```bash
git add src/runtime/command-handler.ts docs/plans/2026-04-10-command-handler-send-notice-design.md docs/plans/2026-04-10-command-handler-send-notice.md
git commit -m "[codex] 精简命令通知卡片发送逻辑"
```
