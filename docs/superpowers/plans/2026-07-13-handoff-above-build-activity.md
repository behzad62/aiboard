# Handoff Above Build Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the final project-handoff decision before Runner V2 Build activity.

**Architecture:** This is a render-order-only change in the discussion client. A source-order contract prevents the handoff card from drifting below the observability panel again.

**Tech Stack:** React 19, Next.js, TypeScript, TSX contract tests

## Global Constraints

- Keep final project-handoff behavior, copy, styling, options, and handlers unchanged.
- Render the final project handoff after `BuildRunStats` and before `RunnerV2ObservabilityPanel`.
- Do not reorder Architect-runtime handoff or Runner permission prompts.

---

### Task 1: Reorder the final handoff card

**Files:**
- Modify: `scripts/test-build-activity-layout.mts`
- Modify: `app/discussion/discussion-client.tsx`

**Interfaces:**
- Consumes: existing `projectHandoff` state and `handleProjectHandoff` handler.
- Produces: unchanged handoff UI rendered before Build activity.

- [ ] **Step 1: Write the failing layout assertion**

Locate `The Architect has finished` and `<RunnerV2ObservabilityPanel` in the discussion source and assert the handoff marker has the lower source index.

- [ ] **Step 2: Verify RED**

Run `npx tsx scripts/test-build-activity-layout.mts`. Expected: FAIL because the handoff currently follows Build activity.

- [ ] **Step 3: Move the existing JSX block**

Move the complete `discussion.mode === "build" && projectHandoff` block to immediately after `BuildRunStats` and before `RunnerV2ObservabilityPanel`; do not edit its contents.

- [ ] **Step 4: Verify GREEN and regressions**

Run `npx tsx scripts/test-build-activity-layout.mts`, `npx tsx scripts/test-build-live-state.mts`, `npx tsx scripts/test-native-build-pause-gates.mts`, and `npx tsc --noEmit`. Expected: PASS.
