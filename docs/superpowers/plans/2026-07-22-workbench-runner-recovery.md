# WorkBench Runner Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover safely from invalid lifecycle batches, classify Runner V2 benchmark failures accurately, preserve failed-attempt metrics, and raise token safety caps by 10x.

**Architecture:** Runner V2 consumes rejected tool calls durably and publishes structured pause state. A benchmark-only continuation path resumes without renewing the user budget window, while the WorkBench adapter routes pause reasons into typed certified outcomes and always records available audit data.

**Tech Stack:** TypeScript, Node.js 24.18.0, node:test, Next.js client modules, SQLite-backed Runner V2 projections.

## Global Constraints

- Keep token usage as a benchmark metric.
- Raise only WorkBench input/output token caps by exactly 10x.
- Preserve Architect semantic authority and final project handoff behavior.
- Do not expose verifier oracle files to agents.

---

### Task 1: Durable lifecycle-batch rejection

**Files:**
- Modify: `runner-v2/test/agent-loop.test.ts`
- Modify: `runner-v2/src/agent-loop.ts`

**Interfaces:**
- Consumes: `AgentLoopCheckpoint`, `ToolResult`, and lifecycle metadata from `AgentToolRuntime`.
- Produces: rejected calls represented by durable `protocol_error` tool results.

- [ ] Add a test where `plan_tasks` and `fs.read` appear together and assert neither executes.
- [ ] Run the focused test and verify it fails because the invalid calls remain pending.
- [ ] Add durable rejected-call results and legacy-checkpoint quarantine.
- [ ] Re-run the focused test and verify a resumed invocation reaches a fresh valid model turn.

### Task 2: Structured pauses and non-renewing benchmark continuation

**Files:**
- Modify: `runner-v2/src/scheduler-store.ts`
- Modify: `runner-v2/src/build-runtime.ts`
- Modify: `runner-v2/src/build-runtime-registry.ts`
- Modify: `runner-v2/src/native-build-manager.ts`
- Modify: `runner-v2/src/contracts.ts`
- Modify: `runner-v2/src/control-server.ts`
- Modify: `lib/client/runner-v2.ts`
- Modify relevant Runner V2 tests.

**Interfaces:**
- Produces: `SchedulerProjection.pauseReason` and the `continue` run command.
- Guarantees: `resume` renews a budget window; benchmark `continue` does not.

- [ ] Add failing reducer/runtime/control tests.
- [ ] Implement pause-reason projection and clearing.
- [ ] Implement authenticated benchmark continuation without budget renewal.
- [ ] Run the focused Runner V2 tests.

### Task 3: Typed WorkBench failures and failure audit

**Files:**
- Modify: `scripts/test-workbench-native-runner-adapter.mts`
- Modify: `scripts/test-workbench-executor.mts`
- Modify: `lib/benchmark/workbench/native-runner-adapter.ts`
- Modify: `lib/benchmark/workbench/executor.ts`

**Interfaces:**
- Produces: native execution errors with certified status, failure code, retained paths, and partial build metrics.
- Records: native model traces, tool traces, and audit artifact before either return or throw.

- [ ] Add failing adapter and executor tests for protocol, budget, unknown pauses, and failure metrics.
- [ ] Implement bounded pause routing and typed errors.
- [ ] Move audit recording into a reusable success/failure path.
- [ ] Make executor classification prefer typed failure metadata and partial build results.
- [ ] Run focused WorkBench tests.

### Task 4: Tenfold token safety caps and verification

**Files:**
- Modify: `lib/benchmark/workbench/corpus.ts`
- Modify: `scripts/test-workbench-current-challenges.mts`

**Interfaces:**
- Produces: built-in caps of 3,500,000 input tokens and 1,000,000 output tokens.

- [ ] Add assertions for the new exact caps and unchanged call/tool caps.
- [ ] Run the assertion and verify it fails against current corpus values.
- [ ] Update the two token caps.
- [ ] Run `npm run test:runner-v2`, focused WorkBench scripts, `npm run lint`, and `npm run build` with the dev-server caveat observed.
