# Architect Plan Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Architect atomically cancel or revise stale pending tasks when new evidence changes the plan, without adding a model call per integration or allowing the kernel to make semantic decisions.

**Architecture:** A typed reconciliation payload is reduced by the scheduler as one durable event. The same payload is accepted by a standalone Architect tool and optionally by `review_task`, while the reducer enforces only task-state and graph mechanics.

**Tech Stack:** TypeScript 6, Node.js 24.18.0, SQLite event stores, Node test runner.

## Global Constraints

- The Architect is the sole semantic authority.
- Verifiers only gather evidence.
- The kernel validates mechanics and never infers task completeness.
- Existing durable events must continue to replay.
- Final project handoff still requires explicit user choice.

---

### Task 1: Durable reconciliation contract

**Files:**
- Modify: `runner-v2/src/scheduler-store.ts`
- Modify: `runner-v2/src/task-contracts.ts`
- Test: `runner-v2/test/scheduler-store.test.ts`

**Interfaces:**
- Produces: `PlanReconciliation`, `PlanTaskUpdate`, and replay support for `plan.reconciled` plus review-embedded reconciliation.

- [ ] Write a failing scheduler replay test that cancels T2 and rewires T3 from T2 to T1 in one revision.
- [ ] Write a failing test rejecting a candidate graph where a live task still depends on cancelled T2.
- [ ] Add the typed reconciliation payload and `plan.reconciled` event type.
- [ ] Apply reconciliation to a candidate task map, validate legal source states and the final graph, then commit the candidate projection atomically.
- [ ] Reuse the reducer from `review.decided` when `planReconciliation` is present.
- [ ] Run `npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/scheduler-store.test.ts` and expect all tests to pass.

### Task 2: Architect lifecycle tools and prompting

**Files:**
- Modify: `runner-v2/src/architect-tools.ts`
- Modify: `runner-v2/src/native-architect-runtime.ts`
- Test: `runner-v2/test/architect-tools.test.ts`
- Test: `runner-v2/test/native-architect-runtime.test.ts`

**Interfaces:**
- Consumes: `PlanReconciliation` from Task 1.
- Produces: `reconcile_plan` and optional `review_task.planReconciliation`.

- [ ] Write a failing tool test for a standalone reconciliation that returns `architect_action: plan_reconciled`.
- [ ] Write a failing tool test for review plus reconciliation being persisted as one event.
- [ ] Add exact JSON schemas and semantic-free validation for both tool paths.
- [ ] Add Architect guidance to reconcile stale assumptions and avoid fabricated changes when baseline evidence already satisfies a task.
- [ ] Run the two focused test files and expect all tests to pass.

### Task 3: Exhausted-task recovery and regression verification

**Files:**
- Modify: `runner-v2/test/build-runtime.test.ts`

**Interfaces:**
- Consumes: `reconcile_plan` through the existing Architect driver tool registry.
- Produces: regression coverage that no third worker attempt starts before Architect reconciliation.

- [ ] Write a failing BuildRuntime test with an exhausted planned task and a dependent task.
- [ ] Have the test Architect reconcile the stale task and rewire its dependent in the existing failure-resolution turn.
- [ ] Assert the worker driver is not invoked for the stale task and the dependent becomes mechanically ready.
- [ ] Run the focused BuildRuntime test and expect it to pass.
- [ ] Run `npm run test:runner-v2`, `npx eslint` on changed files, and `git diff --check`.
- [ ] Commit and push the verified AIBoard change, restart the paused Runner V2 service, resume once, and confirm the live Architect reconciles T2 before another worker attempt.
