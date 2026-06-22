# Build Stop Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, copyable Build stop report that explains why a Build run stopped and gives enough context for debugging in a follow-up Codex thread.

**Architecture:** Build mode records structured local problem events while it runs, composes a report when it stops or fails, persists the report in the Build checkpoint and `build_stopped` event, and renders a focused "Why stopped" panel in the discussion page. No remote telemetry or upload is added.

**Tech Stack:** Next.js client app, TypeScript, plain `tsx` script tests, existing client store/checkpoint persistence.

---

### Task 1: Pure Report Model And Summary

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/orchestrator/build-stop-report.ts`
- Test: `scripts/test-build-stop-report.mts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-build-stop-report.mts` with checks that a blocked report:
- Includes the stop reason, wave, and done/total tasks.
- Promotes the most recent failed command as the primary problem.
- Includes repeated failure counts.
- Produces a Markdown copy report with enough detail to paste into Codex.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-build-stop-report.mts`
Expected: FAIL because `build-stop-report.ts` does not exist yet.

- [ ] **Step 3: Implement schema and pure helper**

Add `BuildProblem`, `BuildCommandProblemInput`, `BuildStopReport`, and `BuildStopReportInput` to `lib/db/schema.ts`. Implement `createBuildStopReport(input)` and `formatBuildStopReportMarkdown(report)` in `lib/orchestrator/build-stop-report.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-build-stop-report.mts`
Expected: PASS.

### Task 2: Engine Recording And Event Payload

**Files:**
- Modify: `lib/orchestrator/engine.ts`
- Modify: `lib/client/build-engine.ts`
- Test: `scripts/test-build-stop-report.mts`

- [ ] **Step 1: Extend `build_stopped` event type**

Add optional `report?: BuildStopReport` to the `build_stopped` event.

- [ ] **Step 2: Track local Build problems**

In `runBuildDiscussion`, maintain `buildProblems: BuildProblem[]` and `commandProblems: BuildCommandProblemInput[]`. Record malformed tool calls, empty tool batches, repeated no-progress stops, incomplete tasks, patch/edit/write issues, and failed/denied commands.

- [ ] **Step 3: Compose reports at stop boundaries**

Before `markStopped` emits `build_stopped`, compose a report from current tasks, wave, `recoveryLog`, `failureFingerprints`, recorded problems, and command failures. Save it into the checkpoint and emit it to the UI.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx scripts/test-build-stop-report.mts`
Expected: PASS.

### Task 3: UI Panel And Copy Action

**Files:**
- Create: `components/BuildStopReportPanel.tsx`
- Modify: `app/discussion/discussion-client.tsx`
- Test: `scripts/test-build-stop-report.mts`

- [ ] **Step 1: Add UI state and restore report**

Add `buildStopReport` page state. Set it from live `build_stopped` events and from the stored checkpoint when loading a discussion.

- [ ] **Step 2: Render "Why stopped" panel**

Show the panel above Build stats when a report exists. Include summary, top causes, last failed command, affected task/wave, next action, and a "Copy report" button.

- [ ] **Step 3: Include Markdown copy text**

Use `formatBuildStopReportMarkdown(report)` for the clipboard content so the user can paste it into Codex.

- [ ] **Step 4: Run type/build checks**

Run: `npx tsc --noEmit`, `npm run build`, and `npm run lint`.
Expected: zero errors; existing warnings are acceptable.
