# Build Tool Call Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, copyable Tool Call Review report that appears for completed and stopped Build runs whenever tool calls, MCP calls, command calls, or file-tool operations produced warnings/errors.

**Architecture:** Reuse the existing `BuildProblem` and `BuildCommandProblem` streams as the source of truth. Add a small pure report builder under `lib/orchestrator/`, persist the report in the Build checkpoint, emit it on completion/stop events, and render a panel in the discussion page.

**Tech Stack:** Next.js client app, TypeScript strict mode, plain `tsx` test scripts, existing client store/checkpoint model.

---

### Task 1: Pure Report Builder

**Files:**
- Create: `lib/orchestrator/build-tool-review-report.ts`
- Modify: `lib/db/schema.ts`
- Test: `scripts/test-build-tool-review-report.mts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-build-tool-review-report.mts` with cases for:
- a completed run with `malformed_tool_call`, `empty_tool_batch`, `tool_warning`
- an MCP Playwright failure using `source: "mcp"`, `code: "command_failed"`, `action: "mcp:playwright.browser_navigate ..."`
- generated Markdown includes the Playwright failure and grouped counts

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-build-tool-review-report.mts`
Expected: module-not-found failure for `build-tool-review-report`.

- [ ] **Step 3: Implement minimal report builder**

Add `BuildToolReviewReport` schema fields, `createBuildToolReviewReport`, and `formatBuildToolReviewMarkdown`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-build-tool-review-report.mts`
Expected: all checks PASS.

### Task 2: Engine Persistence And MCP Problem Capture

**Files:**
- Modify: `lib/client/build-engine.ts`
- Modify: `lib/orchestrator/engine.ts`
- Test: extend `scripts/test-build-tool-review-report.mts` if needed

- [ ] **Step 1: Persist review report in checkpoints**

Add `toolReviewReport?: BuildToolReviewReport | null` to checkpoints and save it for completed, stopped, and blocked runs.

- [ ] **Step 2: Emit review report to UI**

Add optional `toolReviewReport` to `build_stopped` and `final_answer` events so the page can update live without reload.

- [ ] **Step 3: Record MCP failures**

When `executeTool` returns `result.isError`, throws, or is denied, record a `BuildProblem` with `source: "mcp"` and action/details from the failed tool call.

### Task 3: UI Panel

**Files:**
- Create: `components/BuildToolReviewPanel.tsx`
- Modify: `app/discussion/discussion-client.tsx`

- [ ] **Step 1: Render panel from checkpoint/live events**

Load `toolReviewReport` from the checkpoint and update it from live `build_stopped` / `final_answer` events.

- [ ] **Step 2: Add copyable report**

Show grouped counts, latest examples, failed MCP/command evidence, and a Copy report button.

### Task 4: Verification And Publish

**Files:**
- No source changes unless verification reveals a bug.

- [ ] **Step 1: Run focused tests**

Run:
`npx tsx scripts/test-build-tool-review-report.mts`
`npx tsx scripts/test-build-stop-report.mts`
`npx tsx scripts/test-build-stop-diagnostics.mts`

- [ ] **Step 2: Run app checks**

Run:
`npx tsc --noEmit`
`npm run lint`
`npm run build`

- [ ] **Step 3: Commit, push, merge to main, publish**

Push the feature branch, fast-forward `main`, wait for deploy, and verify `https://aiboard.me/` plus `/discussion` return HTTP 200.
