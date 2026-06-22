# Build Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Build mode from reporting a job as done when repo state, PR state, verification, or tests are incomplete.

**Architecture:** Add a pure Build completion gate that classifies the final repo/check state before the final summary. Wire it into `runBuildDiscussion` so failed gates become a resumable blocked stop report instead of a completed hand-off.

**Tech Stack:** Next.js client app, TypeScript, plain `tsx` script tests, existing local runner repo status endpoints.

---

### Task 1: Pure Quality Gate

**Files:**
- Create: `lib/orchestrator/build-quality-gates.ts`
- Create: `scripts/test-build-quality-gates.mts`

- [ ] **Step 1: Write failing tests**

Cover dirty tree, branch ahead without push, stale PR head, failed required checks, missing tests, and linked open issues.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-build-quality-gates.mts`
Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement pure helper**

Export `evaluateBuildQualityGate(input)` and `formatBuildQualityGateSummary(result)` with deterministic blocker/warning messages.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-build-quality-gates.mts`
Expected: PASS.

### Task 2: Build Engine Final Gate

**Files:**
- Modify: `lib/client/build-engine.ts`
- Modify: `lib/orchestrator/build.ts`

- [ ] **Step 1: Refresh repo status before final summary**

After tasks are complete and before `final_answer`, refresh runner repo status and evaluate the quality gate.

- [ ] **Step 2: Block completion on hard failures**

If the gate has blockers, create a `BuildStopReport`, save the checkpoint as blocked, emit `build_stopped`, and return without marking the discussion completed.

- [ ] **Step 3: Surface warnings in the final summary**

If only warnings remain, append them to the deterministic repository workflow summary.

### Task 3: Verification And Publish

**Files:**
- No additional source files.

- [ ] **Step 1: Run focused tests**

Run: `npx tsx scripts/test-build-quality-gates.mts` and existing Build script tests.

- [ ] **Step 2: Run full checks**

Run: `npx tsc --noEmit`, `npm run lint`, and `npm run build`.

- [ ] **Step 3: Merge and publish**

Commit the branch, push it, fast-forward `main`, push `main`, and watch the deploy run to completion.
