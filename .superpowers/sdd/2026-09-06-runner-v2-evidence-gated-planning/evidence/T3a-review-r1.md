# T3a independent review — round 1

Reviewer: independent reviewer (not the author; the code was written by Muse). No source or test file
was edited. Nothing was committed, staged or stashed. The only file written in the worktree is this
review. Scratch probes lived in the session scratchpad, outside the repo.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`,
base `5f901354`. T3a is uncommitted: 6 modified files and 2 new untracked files
(`runner-v2/src/planning-tools.ts`, `runner-v2/test/planning-tools.test.ts`).

## 1. Scope read (in this order)

1. Requirements first: the worker brief `t3a-brief.txt`; plan §2, §3, §5.0 (G-1..G-11), all of T3,
   T4 (to place the admission boundary), ledger rows EP05, EP07, EP23, EP32, EP41; owner amendment OA-7.
2. Code: the full `git diff` of `agent-prompts.ts`, `architect-tools.ts`, `build-runtime.ts`,
   `native-architect-runtime.ts`, `scheduler-store.ts` and `task-scheduler.ts`; all of the new
   `planning-tools.ts` and `planning-tools.test.ts`. T1/T2 APIs read where T3a depends on them:
   `planning-projection.ts` (reducer, resume index, readiness resets, monotonic checkpoint),
   `computePlanReadiness` coverage binding in `planning-contracts.ts`, the `plan.created`,
   `task.transitioned` and `applyPlanReconciliation` reducer paths, `TaskScheduler.tick`,
   `BuildRuntime.step` and `runArchitect`, `agent-loop.ts` lifecycle and compaction, and
   `role-capabilities.ts`.
3. Last: the worker's evidence `T3a.md`. I checked its claims against the code and test runs below.

### What T3a must do (written down before reading code)

- M1: new `planning-tools.ts` with Architect lifecycle tools for NEW-POLICY runs: bounded reads over
  every section of the complete manifest inventory; an unread or truncated section never counts as
  covered; the requirement ledger is persisted BEFORE any task generation; checkpoints; plan
  draft/revise carrying investigations. Validate with T1 and append through T2 events only.
- M2: register the tools only for new-policy runs; add them to `ARCHITECT_LIFECYCLE_SURFACE` and the
  universe derivation; legacy runs keep today's tools.
- M3: a kernel predicate `planning state` (OA-7/EP41) over the durable projection: no ready plan and
  triage not `answer`. While in planning state, `run_evidence_command` is refused at the tool
  boundary, not just in the prompt. Legacy runs still get commands.
- M4: plan_only new-policy runs make zero worker, test or migration calls, including after a
  restart. Plan-only completion and worker admission both require the READY plan identity, checked in
  the scheduler/admission path.
- M5: a new-policy run admits no worker until the plan is ready. A source or plan change after
  readiness blocks further admission. This must hold on direct event paths too (§2.8).
- M6: `projectDocumentationReadiness` and STATE.md stay intact (G-3).
- M7: compact prompts.

### What T3a must NOT do

- It must not build T3b: no `planning-review.ts`, no reviewer runtime, no record-before-verdict, no
  verdicts or categories, no plan_ready trigger. Plan readiness must stay unreachable without T3b's
  coverage review.
- Forbidden files: `planning-contracts.ts`, `source-manifest.ts`, `planning-projection.ts`,
  `native-build-factory.ts`, UI/client files and package files. Verified: none of them is in the diff.

## 2. Requirement checklist

| Req | Status | Evidence |
|---|---|---|
| M1 read every section; unread/truncated never counted | **Partial** | Enforced at the tool boundary: the read receipt is keyed by manifest, section and digest; oversize sections are refused rather than truncated; length and digest drift are refused (planning-tools.ts:206-260, 449-464). The receipt is in memory only, so the kernel cannot enforce it on a direct append (probe C, N2). |
| M1 ledger BEFORE task generation | **Not met** | `draft_planning_plan` is refused before the ledger (tool and reducer). However, legacy `plan_tasks` is still registered for new-policy runs and the reducer accepts `plan.created` before the ledger. Those tasks are later dispatched (probe A, **B1**). |
| M1 checkpoint + resume | Met | SQLite restart test (planning-tools.test.ts:639-707): the exact next section is resumed and a new section still needs a read. |
| M1 draft/revise with T1 validators and exact base | Met | planning-tools.ts:528-541, 612-640. The reducer re-validates (planning-projection.ts:837-862). |
| M2 registration, surface, universe, legacy tools | Met | architect-tools.ts:531-543; build-runtime.ts:1846-1854 and 2262-2282; a universe entry was added at 2382. Tests at :306 and :317. The assert stays meaningful because universe and surface must be equal as sets. |
| M3 predicate + command refusal; legacy allowed | Met (prove-red reproduced) | `isPlanningState` is at scheduler-store.ts:689. The runtime wiring is at native-architect-runtime.ts:304-309, and `PlanningStateInspectionRuntime` both filters and refuses the command. `NativeArchitectRuntime` is the only `ArchitectRuntimeDriver` (grep). Triage `build`/`clarify` is shown only at predicate level, which is the accepted T9 seam. |
| M4 plan-only completion requires ready identity | Met | `buildCompletionReadiness` plan_only branch and the `project.handoff_requested` reducer. `complete_run` is not offered before readiness (build-runtime.ts:1826-1831). Tests at :1148. |
| M4 plan-only zero dispatch incl. restart | **Partial** | The reducer and tick guards are real and one of them proves red. The "including after restart" test (:1278) has no tasks at all, so it cannot fail (N1). |
| M5 no admission before ready; re-block after source/plan change | Partial (tied to B1) | Tick gate at task-scheduler.ts:128-135 and reducer gate at scheduler-store.ts:2456-2469. The source-change test (:1364) and plan-change test (:1471) both have a ready control. The gate checks only that some ready plan exists. It does not check that the task being admitted belongs to it (B1). |
| M6 docs gate G-3 | Met | `projectDocumentationReadiness` is still called first in the plan_only branch. Test :1212 asserts the STATE.md message. |
| M7 prompts | Met | 5 lines, shown only for new-policy runs (test :1014). |
| No T3b / forbidden files untouched | Met | The diff touches only writable files. Readiness still needs a bound coverage review (`computePlanReadiness` → `validateCoverageReviewBinding`, which checks id and digest). |
| Legacy/replay unchanged | Met | replay-compatibility 3/3. Every new reducer gate is keyed on `planningPolicyVersion === 1`, and nothing in production stamps that policy yet, so no recorded legacy stream can hit the new gates. |

## 3. Findings

### B1 — BLOCKING: legacy `plan_tasks` bypasses "ledger before task generation", and tasks outside the ready revision are admitted once any plan is ready

- Where:
  - `architect-tools.ts:476-481`: `planTasksTool` is in `baseCore` and is registered unconditionally, including on new-policy runs. `reconcile_plan` (`newTasks`) and `revise_task` are also still there.
  - `scheduler-store.ts` `plan.created` / `plan.reconciled` reducer: there is no new-policy guard, so the direct event path is open as well.
  - `task-scheduler.ts:128-135` and `scheduler-store.ts:2456-2469`: admission checks only that `readyPlanIdentity(projection)` exists. It does not check that the admitted task comes from that ready revision.
- Failure scenario (reproduced, scratch probe A): on a new-policy `finish` run, the Architect calls
  `plan_tasks` before any ledger. Result: `isError:false`, `planning.ledger === undefined`, task
  `rogue` is created. The planning flow then runs normally (ledger → draft → coverage review →
  plan_ready). The ready revision's tasks are `T1..T5, T-INV`; `rogue` is in none of them. One
  `TaskScheduler.tick()` then dispatches `["rogue"]`. So a task generated before the ledger, and
  never covered by the reviewed plan, starts a worker. The worker's evidence says a legacy plan is
  "inert" on new-policy runs. That holds only until readiness.
- The worker's own tests normalise the bypass: `seedLegacyPlan` runs before the ledger at
  planning-tools.test.ts:1562, and before readiness at :1383 and :1489.
- Minimal fix:
  1. For `planningPolicyVersion === 1`, the reducer refuses `plan.created` and task-adding
     `plan.reconciled` unless `readyPlanIdentity(current)` is defined. Tasks can then only
     materialise from a ready plan, which is necessarily after the ledger.
  2. While `isPlanningState` holds, leave `plan_tasks`, `reconcile_plan` and `revise_task` out of
     the new-policy Architect surface. Keep the universe/surface assert consistent.
  3. Add a tool-path test and a direct-event test showing that `plan_tasks` / `plan.created` before
     the ledger and before readiness is refused. Reorder the existing admission tests to seed the
     legacy stand-in tasks after `plan_ready`.
  4. Either stamp the ready revision digest on the tasks created and compare it at admission, or
     record the per-task digest binding explicitly as a T4 carry-forward in the evidence. T4 already
     lists "stale ready-plan digest" in its negative proof.

### N1 — NON-BLOCKING (cheap, fix with B1): the "zero dispatch including after restart" test cannot fail

`planning-tools.test.ts:1278-1339` drives `BuildRuntime` through a plan_only run whose Architect
only uses planning tools. `projection.tasks` is empty in both the first and the restarted runtime,
so `worker.assignments === []` holds with every guard removed. The sharp plan_only tests (:1544 and
:1613) have tasks but no restart. Fix: in the restart arm, seed a ready plan plus stand-in tasks
(after B1, seed them after readiness), reopen the store, step or tick, and assert zero dispatch and
zero `workspaceFor` calls. Then prove it red against the tick plan_only branch.

### N2 — NON-BLOCKING (record as a T3b carry-forward): read receipts are per-turn memory, not durable facts

- `planning-tools.ts:108`: the receipt set lives in one `createPlanningTools` instance.
  `BuildRuntime.runArchitect` rebuilds the tools on every Architect turn (build-runtime.ts:1822).
- `persist_planning_ledger`, `record_planning_checkpoint`, `draft_planning_plan` and
  `revise_planning_plan` each end the turn, because they return an `architect_action` lifecycle.
- A checkpoint needs the ledger first (T2). So every section read before the ledger has to be read
  again in a later turn before it can be checkpointed. This fails closed, but it costs about twice
  the source tokens on every run.
- The kernel cannot enforce "read before covered". A direct `planning.checkpoint_recorded` append
  marks all 8 fixture sections covered with zero reads (probe C). Only runner code can append
  directly, and readiness depends on T3b's independent review, so this does not block T3a.
- Fix, choose one: persist a `planning.source_section_read` receipt (manifest, section, digest,
  byteLength) and check it in the reducer; or keep the receipts per run inside `BuildRuntime` across
  turns. T3b must not treat checkpoint coverage as read evidence.

### N3 — NON-BLOCKING: the tick does not re-check readiness after its async gaps

`task-scheduler.ts:139-156` and `160-190`: after `await this.workspaceFor(...)`, the code
re-checks only `hasPendingUserGuidance`. If a source amendment lands during that await:

- an `assigned` transition throws out of `tick()` through the reducer gate. That is safe, but it is
  an unhandled throw rather than a clean return;
- a task already `running` in the first loop is dispatched with no reducer transition, so it starts
  while the plan is not ready.

Fix: repeat the `planningPolicyVersion`/`readyPlanIdentity`/plan_only check wherever
`hasPendingUserGuidance` is re-checked.

### N4 — NON-BLOCKING: the command gate is decided once per Architect turn

`native-architect-runtime.ts:307` evaluates `isPlanningState` against the projection read at the
start of the turn. A readiness loss during the turn, such as an owner source amendment, returns the
run to planning state, but `run_evidence_command` stays live for the rest of that turn. Fix: have the
composed command runtime rebuild the projection and refuse on `isPlanningState` at `invoke`.

### N5 — NOTE: a steering reconciliation can set `assigned` outside the new reducer gate

`applyPlanReconciliation` (scheduler-store.ts ~5471-5596) sets `status: "assigned"` directly for
steering checkpoints. The task still cannot start a worker: the tick gate and the reducer gate on
`running` both apply. But the comment's claim that "direct-event worker admission requires a ready
plan" covers only `task.transitioned`. Either gate the steering path too or reword the comment.

### N6 — NOTE / T2 follow-up (not blocking T3a): the worker's T2 observation is confirmed

Probe B:

- Setup: register a 3-section source, persist the ledger, read and checkpoint all 3 sections, then
  record an owner amendment whose manifest drops s3 (`retiresSectionIds:["s3"]`). The reducer accepts
  the amendment.
- Result, tool path: without s3 the checkpoint is refused; with s3 it fails with
  `unknown_manifest_section`.
- Result, direct path: without s3 → "Planning checkpoints cannot drop covered source sections."; with
  s3 → "Planning checkpoint references an unknown source section."

So checkpoints can never be appended again. Cause: `assertMonotonicCheckpoint` and the
unknown-section check in `planning-projection.ts` contradict each other for retired sections that
were removed from the inventory.

Impact: readiness, draft and revise do not need checkpoints, so T3a's gates are unaffected, but
planning resume dead-ends after such an amendment. This belongs to a T2 follow-up in the forbidden
`planning-projection.ts`: apply monotonicity only to sections still in the current manifest, or
exempt ids in the amendment's recorded `retiresSectionIds`.

### N7 — NOTE

- Sections over 64 KiB are refused and can never be covered, so planning dead-ends if the manifest
  has a large section. Paged reads (every page receipted before coverage) or a T1 section-size cap
  would fix that.
- The planning tools reuse the `plan_created` / `plan_reconciled` action labels (disclosed; they
  need `agent-contracts.ts`).
- Triage `build`/`clarify` refusal is shown only at predicate level until T9 (accepted seam).
- Production never stamps `planning.policy_configured` or provisions source bytes yet (disclosed).

## 4. Worker claims checked

- All 8 file sha256 values in T3a.md match the working tree (checked with `sha256sum`).
- The test counts I re-ran match the claims (see below).
- Prove-red #1 (planning-state command refusal) reproduced independently, with the result below.
- The claim that legacy `plan_tasks` on new-policy runs is "inert" because of the gates is **refuted
  after readiness** (B1).
- The T2 observation is confirmed (N6).

## 5. Commands run (exact counts)

Node `C:\Program Files\nodejs\node.exe`, `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`:

| File | tests | pass | fail |
|---|---|---|---|
| runner-v2/test/planning-tools.test.ts | 24 | 24 | 0 |
| runner-v2/test/replay-compatibility.test.ts | 3 | 3 | 0 |
| runner-v2/test/architect-lifecycle-surface.test.ts | 6 | 6 | 0 |
| runner-v2/test/task-scheduler.test.ts | 8 | 8 | 0 |
| runner-v2/test/planning-state.test.ts | 37 | 37 | 0 |
| scratchpad probe `t3a-review-probe.test.mts` (A, B, C; outside the repo) | 3 | 3 | 0 |

The probes pass because they assert that each defect exists. Probe A output was
`plan_tasks before ledger isError: false ledger? false tasks: ['rogue']`, then
`dispatched: ['rogue']`.

Independent prove-red, planning-state command guard (`runner-v2/src/native-architect-runtime.ts`):

- BEFORE sha256 `1a0e669553f74d68e36e7e1c64fad4e8cacbdbaebfa2e652d19384694bff6739`, the same as the
  worker's recorded hash.
- Mutation: `} else if (isPlanningState(projection)) {` → `} else if (false) {`. The needle occurred
  exactly once. INJECTED sha256 `e78b4555…9611`, and the file no longer contained the guard, which
  proves the injection took effect.
- Test `T3a architect turn in planning state is refused command execution before triage`: 1 test,
  0 pass, 1 fail, at `planning-tools.test.ts:984` (`actual: true, expected: false`). The forbidden
  command tool was exposed, so the failure is success-side, not a changed message.
- Restored from a byte backup. AFTER sha256 `1a0e669553f74d68e36e7e1c64fad4e8cacbdbaebfa2e652d19384694bff6739`
  matches BEFORE.

Not run: typecheck, eslint and the full suite. The controller owns the importer matrix.

## 6. Verdict

One blocking finding (B1). N1 is cheap and should be fixed together with B1. N2-N4 can be fixed now
or recorded as carry-forwards. N6 needs a T2 follow-up decision from the controller.

T3a REVIEW r1 — REPAIR REQUIRED — 1 blocking
