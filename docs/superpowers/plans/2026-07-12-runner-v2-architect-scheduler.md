# Runner V2 Architect and Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable Architect-owned task graph, mechanically safe scheduler, worker guidance, capability-compatible worker failover, serialized semantic review, and user-controlled Architect handoff.

**Architecture:** SQLite append-only events project task, worker, guidance, review, and Architect state. The Architect changes semantic state only through native lifecycle tools. The scheduler validates graph mechanics, dispatches dependency-ready tasks into isolated workspaces, and routes worker/provider failure without deciding whether work is good or complete.

**Tech Stack:** Node.js 24.18.0, TypeScript 6, `node:sqlite`, native agent kernel, Git workspace manager, built-in Node test runner.

## Global Constraints

- Architect owns spec, task meaning, guidance, review, approval, replanning, memory promotion, and completion.
- Kernel never derives semantic pass/fail or completion from evidence, text, keywords, scores, or elapsed time.
- Invalid mechanics are duplicate task IDs, missing dependencies, dependency cycles, illegal state transitions, unavailable capabilities, exceeded permission ceilings, and exhausted hard budgets.
- Worker provider failover is automatic and capability-compatible; Architect handoff always pauses for user selection.
- Blocking guidance releases the execution slot but retains the task workspace; advisory guidance permits only work safe under every plausible answer.
- One challenge per guidance version is allowed only with a newer evidence reference.
- Every state change is append-only, idempotent, attributable, and recoverable.

---

### Task 1: Durable task graph contracts and mechanical validation

**Files:**
- Create: `runner-v2/src/task-contracts.ts`
- Create: `runner-v2/src/task-graph.ts`
- Test: `runner-v2/test/task-graph.test.ts`

**Interfaces:**
- Produces: `BuildTask`, `TaskGraph`, `TaskStatus`, `validateTaskGraph`, `readyTaskIds`, `applyTaskTransition`.
- Consumes: no scheduler interfaces.

- [ ] **Step 1: Write failing graph tests** for a valid dependency diamond, duplicate IDs, missing dependency, cycle, and illegal transition. Assert that no objective wording is interpreted.
- [ ] **Step 2: Run** `npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/task-graph.test.ts`; expect missing-module failure.
- [ ] **Step 3: Implement** stable task types, DFS cycle detection, dependency-ready selection, and an explicit transition table. Validation returns typed mechanical issues and never rejects task prose.
- [ ] **Step 4: Re-run the test and Runner V2 typecheck**; expect all graph tests to pass.
- [ ] **Step 5: Commit** `feat(runner-v2): define mechanical task graph`.

### Task 2: Append-only scheduler store and recovery

**Files:**
- Create: `runner-v2/src/scheduler-store.ts`
- Create: `runner-v2/src/sqlite-scheduler-store.ts`
- Test: `runner-v2/test/scheduler-store.test.ts`

**Interfaces:**
- Consumes: task contracts from Task 1.
- Produces: `SchedulerEvent`, `SchedulerProjection`, `SqliteSchedulerStore.append/read/rebuild`.

- [ ] **Step 1: Write failing tests** that append plan/task/assignment/guidance/review events, reopen SQLite, and recover the exact projection without duplicate idempotency keys.
- [ ] **Step 2: Run the focused test** and confirm missing-module RED.
- [ ] **Step 3: Implement** WAL storage with per-run monotonic sequence, `(run_id,idempotency_key)` uniqueness, artifact references for large payloads, and a pure projection reducer.
- [ ] **Step 4: Fault-test** corrupt payload attribution and append-before/after restart sequence continuity.
- [ ] **Step 5: Commit** `feat(runner-v2): persist scheduler state`.

### Task 3: Dependency scheduler and isolated worker dispatch

**Files:**
- Create: `runner-v2/src/task-scheduler.ts`
- Test: `runner-v2/test/task-scheduler.test.ts`

**Interfaces:**
- Consumes: `WorkspaceManager`, scheduler store, `runWorkerTask`, `WorkerRuntimeDriver`.
- Produces: `TaskScheduler.tick`, `pause`, `resume`, `stop`, and deterministic dispatch decisions.

- [ ] **Step 1: Write failing tests** for bounded concurrency, dependency order, workspace reuse, blocking-guidance slot release, user pause, hard-budget pause, and restart without duplicate dispatch.
- [ ] **Step 2: Confirm RED** with the focused Node 24 command.
- [ ] **Step 3: Implement** one serialized tick transaction: reconcile active attempts, calculate mechanically ready tasks, reserve slots, create/reuse workspaces, append assignment events, then start workers.
- [ ] **Step 4: Verify** that semantic review tasks dispatch only after an explicit Architect review request event, never from verifier output.
- [ ] **Step 5: Commit** `feat(runner-v2): schedule isolated workers`.

### Task 4: Guidance, challenge, review, and Architect lifecycle tools

**Files:**
- Create: `runner-v2/src/architect-tools.ts`
- Create: `runner-v2/src/worker-lifecycle-tools.ts`
- Test: `runner-v2/test/guidance-review.test.ts`

**Interfaces:**
- Consumes: ToolBroker, scheduler store, change sets.
- Produces native tools: `plan_tasks`, `revise_task`, `ask_architect`, `challenge_guidance`, `answer_guidance`, `submit_task`, `review_task`, `request_integration`, `complete_run`.

- [ ] **Step 1: Write failing tests** proving prose cannot plan/review/complete, blocking guidance suspends one task, advisory guidance does not broaden scope, stale challenges fail mechanically, and only Architect tools can approve or complete.
- [ ] **Step 2: Confirm RED**.
- [ ] **Step 3: Implement** schema-validated tools whose execution appends typed events. `plan_tasks` calls `validateTaskGraph`; mechanical issues are returned to the Architect in the same turn, while semantic content is untouched.
- [ ] **Step 4: Verify** one-challenge-per-guidance-version with newer evidence sequence and integration approval ownership.
- [ ] **Step 5: Commit** `feat(runner-v2): add architect guidance and review tools`.

### Task 5: Provider health, worker failover, and Architect handoff pause

**Files:**
- Create: `runner-v2/src/provider-health.ts`
- Create: `runner-v2/src/runtime-router.ts`
- Test: `runner-v2/test/runtime-router.test.ts`

**Interfaces:**
- Consumes: provider-neutral `AgentModel`, capability requirements, scheduler events.
- Produces: `ProviderHealthRegistry`, `RuntimeRouter.selectWorker`, `recordFailure`, `selectArchitectHandoff`.

- [ ] **Step 1: Write failing tests** for confirmed outage cooldown, capability matching, automatic worker continuation from checkpoint, no reclaim by failed provider, all-workers-unavailable pause, and mandatory user selection for Architect handoff.
- [ ] **Step 2: Confirm RED**.
- [ ] **Step 3: Implement** typed failure classification, cooldown timestamps, deterministic healthy candidate ordering, worker handoff packages, and a distinct `architect_handoff_required` state with no automatic candidate selection.
- [ ] **Step 4: Verify** provider retry does not consume calls while a confirmed usage-limit cooldown remains active.
- [ ] **Step 5: Commit** `feat(runner-v2): route worker failover safely`.

### Task 6: Architect/scheduler recovery vertical slice

**Files:**
- Create: `runner-v2/src/build-runtime.ts`
- Test: `runner-v2/test/build-runtime.test.ts`
- Modify: `runner-v2/src/cli.ts`
- Modify: `runner-v2/src/control-server.ts`

**Interfaces:**
- Consumes all prior phase interfaces.
- Produces a persistent Build runtime owned by the runner and authenticated control endpoints for plan, tasks, guidance, review, integration, handoff, and event observation.

- [ ] **Step 1: Write a scripted-provider test** where Architect plans a dependency graph, two workers edit isolated files, one asks blocking guidance, one provider fails over, Architect reviews both, integration serializes, and only Architect `complete_run` completes.
- [ ] **Step 2: Kill/reopen** the runtime after assignment, guidance, and review checkpoints; assert no duplicate calls, tasks, commits, or integrations.
- [ ] **Step 3: Implement** the Build runtime composition and versioned `/v2/runs/:id/...` endpoints; browser presence must not affect execution.
- [ ] **Step 4: Run** all Runner V2 tests, both TypeScript checks, ESLint, and `git diff --check`.
- [ ] **Step 5: Commit** `feat(runner-v2): complete architect scheduler runtime`.

## Completion gate

The phase is complete only when a scripted Architect plans, guides, reviews, integrates, and completes a multi-worker run across runner restarts; worker failover is automatic, Architect handoff waits for the user, and no verifier/kernel path can approve a task or complete the run.
