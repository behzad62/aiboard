# Runner Page Error Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Runner V2 record uncaught Playwright page exceptions as durable browser errors so broken browser workflows cannot appear console-clean.

**Architecture:** Extend the existing Playwright session observer rather than adding a parallel evidence type. Normalize `pageerror` exceptions into `BrowserConsoleEvent` entries with `type: "error"`, allowing the current `browser.events` artifact and `consoleErrorCount` calculation to include them automatically.

**Tech Stack:** Node.js 24.18.0, TypeScript, Playwright, Node test runner.

## Global Constraints

- Verifiers gather mechanical facts; they never decide whether the project is complete.
- The Architect remains the semantic authority.
- Preserve the existing `BrowserBackend.events()` response shape and durable evidence schema.
- Keep Playwright headless by default.
- Implement test-first and do not edit AIPaintball.

---

### Task 1: Capture uncaught page exceptions

**Files:**
- Modify: `runner-v2/test/browser-tools.test.ts`
- Modify: `runner-v2/src/browser-tools.ts`

**Interfaces:**
- Consumes: `PlaywrightBrowserBackend.events(sessionId)` returning `{ console, network }`.
- Produces: uncaught Playwright `pageerror` exceptions represented as `BrowserConsoleEvent` values with `type: "error"` and stack-or-message text.

- [ ] **Step 1: Write the failing real-browser test**

Add a test that starts a local HTTP server whose page runs:

```html
<script>
  setTimeout(() => { throw new Error("uncaught render failure"); }, 25);
</script>
```

Open it with `PlaywrightBrowserBackend`, wait until the page has settled, call `events`, and assert that `events.console` contains an entry with `type === "error"` and text containing `uncaught render failure`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-name-pattern="uncaught page exceptions" runner-v2/test/browser-tools.test.ts
```

Expected: FAIL because the current backend does not subscribe to `pageerror`.

- [ ] **Step 3: Implement minimal capture**

In `PlaywrightBrowserBackend.observe`, add:

```ts
session.page.on("pageerror", (error) => {
  pushBounded(session.console, {
    type: "error",
    text: error.stack || error.message,
    occurredAt: new Date().toISOString(),
  });
});
```

- [ ] **Step 4: Verify GREEN and regression coverage**

Run:

```powershell
node node_modules/tsx/dist/cli.mjs --test runner-v2/test/browser-tools.test.ts
npm run lint
```

Expected: all browser tool tests pass and lint exits 0.

- [ ] **Step 5: Commit**

```powershell
git add runner-v2/src/browser-tools.ts runner-v2/test/browser-tools.test.ts docs/superpowers/specs/2026-07-14-runner-page-error-evidence-design.md docs/superpowers/plans/2026-07-14-runner-page-error-evidence.md
git commit -m "fix(runner): capture uncaught browser page errors"
```

