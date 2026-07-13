# Runner V2 Model Statistics and Run Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Runner V2 run policies truthful and expose durable, provider-aware per-model usage and health in Build run stats.

**Architecture:** Runner V2 remains the source of truth. The native Build spec carries the selected run policy, the budget ledger records per-call model identity and token-source provenance, and the control plane projects safe per-model aggregates. The browser maps that projection into the existing discussion schema and renders policy-specific controls and statistics. Verifiers remain factual and the Architect remains the only semantic completion authority.

**Tech Stack:** Node.js 24.18.0, TypeScript, SQLite, Next.js 15, React 19, `node:test`, ESLint, PowerShell.

---

## Constraints

- Work only in AIBoard; never edit or coach AIPaintball.
- Preserve explicit final project handoff in every permission profile and run policy.
- `finish` must send no cumulative USD, time, model-call, tool-call, or token ceiling.
- `budgeted` must enforce the user-entered USD/time window and reject a zero/zero window.
- `plan_only` may plan and decide completion, but must never dispatch implementation workers.
- Provider-reported input/output token values win independently. Estimate only a missing dimension from the actual serialized request or returned response.
- Account-backed ChatGPT usage is `Not metered`; absent API pricing is `Unknown`, never `$0.00`.
- Existing unattributed runs may use deterministic presentation-only preview rows. New runs must use durable real attribution.
- Use exact Node.js 24.18.0 for every Runner V2 test and typecheck.

## Task 1: Make the Native Run-Policy Contract Explicit

**Files:**
- Create: `lib/client/native-build-policy.ts`
- Modify: `lib/orchestrator/build-policy.ts`
- Modify: `lib/client/native-build-engine.ts`
- Modify: `lib/client/runner-v2.ts`
- Modify: `runner-v2/src/build-spec.ts`
- Modify: `runner-v2/src/control-server.ts`
- Modify: `components/BuildRunPolicyControl.tsx`
- Test: `scripts/test-native-build-policy.mts`
- Test: `runner-v2/test/control-server.test.ts`
- Modify: `package.json`

- [ ] Add failing browser-side tests for `usesBuildBudgetControls()` and `effectiveNativeBuildPolicy()`:
  - `finish` returns `{ runPolicy: "finish", budgetLimits: {} }` even when saved budget values are non-zero.
  - `plan_only` returns `{ runPolicy: "plan_only", budgetLimits: {} }`.
  - `budgeted` converts USD to integer microdollars and minutes to milliseconds.
  - `budgeted` rejects a zero/zero window.
- [ ] Run the focused test and confirm it fails:
  ```powershell
  $env:PATH='C:\Users\b_a_s\AppData\Local\AIBoardTools\node-v24.18.0-win-x64;'+$env:PATH
  npx tsx scripts/test-native-build-policy.mts
  ```
- [ ] Implement the pure policy helpers and make `shouldStopForBuildGuardrail()` a no-op outside `budgeted`.
- [ ] Hide the USD/time fields unless `value.runPolicy === "budgeted"`; change Finish copy to say it continues until completed, blocked, or explicitly stopped.
- [ ] Add `runPolicy` to `CreateNativeBuildInput.build` and `NativeBuildSpec`; validate it in the control server.
- [ ] Replace effort-derived `buildBudgets()` with `effectiveNativeBuildPolicy()` in `native-build-engine.ts`.
- [ ] Add a control-server test proving Finish persists an empty budget limit object and Budgeted persists the converted limits.
- [ ] Run focused policy/control tests, lint touched files, then commit:
  ```powershell
  npx tsx scripts/test-native-build-policy.mts
  npx tsx --test runner-v2/test/control-server.test.ts
  git add lib/client/native-build-policy.ts lib/orchestrator/build-policy.ts lib/client/native-build-engine.ts lib/client/runner-v2.ts runner-v2/src/build-spec.ts runner-v2/src/control-server.ts components/BuildRunPolicyControl.tsx scripts/test-native-build-policy.mts runner-v2/test/control-server.test.ts package.json
  git commit -m "fix(build): make run policies explicit"
  ```

## Task 2: Record Durable Per-Model Attribution and Token Provenance

**Files:**
- Modify: `runner-v2/src/budget-ledger.ts`
- Modify: `runner-v2/src/sqlite-budget-ledger.ts`
- Modify: `runner-v2/src/budgeted-model.ts`
- Modify: `runner-v2/src/native-architect-runtime.ts`
- Modify: `runner-v2/src/worker-runtime.ts`
- Test: `runner-v2/test/budget-ledger.test.ts`
- Test: `runner-v2/test/budgeted-model.test.ts`

- [ ] Add failing ledger tests for a model reservation carrying `{ runtimeId, providerId, modelId, role, sessionId, taskId? }` and settlement carrying per-dimension token sources (`reported` or `estimated`) plus `settledAt`.
- [ ] Add failing model-wrapper tests proving reported input and output are preferred independently and that a missing output count is estimated from `JSON.stringify(turn.blocks)`, not the configured output reservation.
- [ ] Extend `BudgetReservationProjection` with optional attribution/provenance so old events still rebuild exactly.
- [ ] Require attribution for new model reservations while leaving tool reservations unchanged.
- [ ] Extend `BudgetedAgentModel` construction with immutable model-call attribution and source-aware settlement.
- [ ] Thread runtime/provider/model/role/session/task identity from Architect and worker runtime construction into the wrapper.
- [ ] Run focused tests and commit:
  ```powershell
  npx tsx --test runner-v2/test/budget-ledger.test.ts runner-v2/test/budgeted-model.test.ts
  git add runner-v2/src/budget-ledger.ts runner-v2/src/sqlite-budget-ledger.ts runner-v2/src/budgeted-model.ts runner-v2/src/native-architect-runtime.ts runner-v2/src/worker-runtime.ts runner-v2/test/budget-ledger.test.ts runner-v2/test/budgeted-model.test.ts
  git commit -m "feat(runner-v2): attribute model usage durably"
  ```

## Task 3: Project All Configured Models with Health and Cost Semantics

**Files:**
- Create: `runner-v2/src/model-usage-projection.ts`
- Modify: `runner-v2/src/native-build-factory.ts`
- Modify: `runner-v2/src/native-build-manager.ts`
- Modify: `runner-v2/src/control-server.ts`
- Modify: `runner-v2/src/provider-config-store.ts`
- Test: `runner-v2/test/model-usage-projection.test.ts`
- Test: `runner-v2/test/control-server.test.ts`

- [ ] Add a failing projection test covering configured-but-unused, healthy, cooldown, and unavailable runtimes.
- [ ] Define a safe `NativeModelUsageProjection` with runtime/provider/model IDs, roles, status, calls, input/cached/cache-write/output/total tokens, nullable cost, cost basis, usage quality, and last-used time.
- [ ] Aggregate attributed settled reservations by runtime. Derive `usageQuality` as `reported`, `mixed`, `estimated`, or `none`.
- [ ] Derive cost as:
  - `account_not_metered` and `null` for account-runner transports.
  - `api_estimate` and integer microdollars when configured pricing is known.
  - `unknown` and `null` when API pricing is absent.
- [ ] Include every configured Architect/worker runtime even when it has zero calls, using provider health for its status.
- [ ] Extend `/build/usage` and audit export without returning credentials.
- [ ] Run focused tests and commit:
  ```powershell
  npx tsx --test runner-v2/test/model-usage-projection.test.ts runner-v2/test/control-server.test.ts
  git add runner-v2/src/model-usage-projection.ts runner-v2/src/native-build-factory.ts runner-v2/src/native-build-manager.ts runner-v2/src/control-server.ts runner-v2/src/provider-config-store.ts runner-v2/test/model-usage-projection.test.ts runner-v2/test/control-server.test.ts
  git commit -m "feat(runner-v2): expose truthful model usage"
  ```

## Task 4: Enforce Plan-Only in the Scheduler

**Files:**
- Modify: `runner-v2/src/build-runtime.ts`
- Modify: `runner-v2/src/native-build-factory.ts`
- Test: `runner-v2/test/build-runtime.test.ts`

- [ ] Add a failing test proving `plan_only` can create/revise a task graph and ask the Architect for a completion decision, but never calls `scheduler.tick()`, creates a task workspace, assigns a worker, or integrates.
- [ ] Store the policy on `BuildRuntime` and branch after a valid plan exists but before worker scheduling.
- [ ] Preserve normal Architect guidance, pause, provider-failure, and explicit project-handoff behavior.
- [ ] Run the focused test and commit:
  ```powershell
  npx tsx --test runner-v2/test/build-runtime.test.ts
  git add runner-v2/src/build-runtime.ts runner-v2/src/native-build-factory.ts runner-v2/test/build-runtime.test.ts
  git commit -m "feat(runner-v2): enforce plan-only scheduling"
  ```

## Task 5: Map Native Usage and Provide a Deterministic Legacy Preview

**Files:**
- Create: `lib/client/native-model-usage.ts`
- Modify: `lib/client/runner-v2.ts`
- Modify: `lib/client/discussion-live-state.ts`
- Modify: `lib/db/schema.ts`
- Test: `scripts/test-native-model-usage.mts`
- Test: `scripts/test-build-live-state.mts`
- Modify: `package.json`

- [ ] Add failing mapping tests for roles, health, provenance, nullable cost, last-used time, and aggregate preservation.
- [ ] Add a failing compatibility test for old usage payloads with no `models` array.
- [ ] Extend `BuildUsageModelTotal` with optional role/status/quality/cost-basis/last-used fields so existing stored discussions remain readable.
- [ ] Map real native rows directly when present.
- [ ] For a legacy unattributed aggregate only, synthesize presentation rows with deterministic largest-remainder allocation: Architect weight 2, each assigned worker weight 1. Preserve exact aggregate calls and token columns; never persist the preview back to Runner state.
- [ ] Run focused tests and commit:
  ```powershell
  npx tsx scripts/test-native-model-usage.mts
  npx tsx scripts/test-build-live-state.mts
  git add lib/client/native-model-usage.ts lib/client/runner-v2.ts lib/client/discussion-live-state.ts lib/db/schema.ts scripts/test-native-model-usage.mts scripts/test-build-live-state.mts package.json
  git commit -m "feat(build): map per-model runner usage"
  ```

## Task 6: Redesign Build Run Stats Around Policy and Model State

**Files:**
- Modify: `components/BuildRunStats.tsx`
- Modify: `app/discussion/DiscussionClient.tsx`
- Modify: `lib/client/discussion-live-state.ts`
- Test: `scripts/test-build-run-stats.mts`
- Modify: `package.json`

- [ ] Add failing render-contract tests for:
  - Finish showing calls, tokens, active time, and cost without a Limits card.
  - Budgeted showing USD/time progress.
  - Plan only showing no implementation-budget language.
  - Project handoff showing `Awaiting project handoff`, not `Failed` or generic stopped text.
  - Per-model rows showing role, health, usage quality, calls, input/output/total, cost label, and last used.
- [ ] Implement policy-aware summary cards.
- [ ] Render `Not metered` for account-backed rows and `Unknown` for missing API pricing.
- [ ] Render unused configured models with zero counts and their current health.
- [ ] Keep the existing branch/PR presentation and partial-pricing warning only when applicable.
- [ ] Run focused tests and commit:
  ```powershell
  npx tsx scripts/test-build-run-stats.mts
  npx tsx scripts/test-build-live-state.mts
  git add components/BuildRunStats.tsx app/discussion/DiscussionClient.tsx lib/client/discussion-live-state.ts scripts/test-build-run-stats.mts package.json
  git commit -m "feat(build): show truthful runner model stats"
  ```

## Task 7: Full Verification, Integration, and Live Acceptance

- [ ] Run the complete static and test suite with exact Node 24.18.0:
  ```powershell
  $env:PATH='C:\Users\b_a_s\AppData\Local\AIBoardTools\node-v24.18.0-win-x64;'+$env:PATH
  npm run lint
  npx tsc --noEmit
  npm run test:runner-v2
  ```
- [ ] Do not run `npm run build` while the dev server is active. If a production build is required, stop the dev server, build, then restart it.
- [ ] Inspect `git diff --check`, branch history, and the worktree for unrelated files.
- [ ] Push `codex/runner-v2-stats-policy`, merge it into `main` only after verification, and push `main`.
- [ ] Restart only the exact localhost Runner V2 process when required, verify `/v2/health`, refresh the existing Chrome discussion, and confirm:
  - Finish hides budget controls and shows no limit.
  - Budgeted shows/enforces its configured window.
  - Model rows are distinct and health-aware.
  - The recovered paintball run uses deterministic preview rows without mutating durable usage.
  - The page remains at mandatory user project handoff with both choices available.
- [ ] Never select the project handoff choice. Leave that final decision to the user.

