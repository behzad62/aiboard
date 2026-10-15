# T3a evidence — planning tools, planning state, plan-only rules (implementation worker)

Task: RUNNER V2 P6.6 T3a (controller split EX-2). T3 checkboxes 1, 2, 5 and the OA-7 part.
Base revision: `5f901354` (`feat(runner-v2): P6.6 T2 durable planning state, resume and reconciliation`),
branch `codex/runner-v2-p6-6`, worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`.
All changes left uncommitted, as briefed. Nothing was staged, stashed, committed, or pushed.

Requirement ids: EP05 (partial — tools side only, no review), EP07 (partial — task/investigation
contract carriage through draft/revise, no review), EP32, EP41, T3 checkboxes 1, 2, 5.

## Files changed (sha256 of working copy at evidence time)

| File | sha256 | Change |
|---|---|---|
| `runner-v2/src/planning-tools.ts` (new, rewrote the 27-line stub) | `2a7503d768a25662d4f43df3ff1ed80170a9a78e9cb0812296a96e8e68504864` | 5 Architect lifecycle tools |
| `runner-v2/test/planning-tools.test.ts` (new) | `f5fbba57acbd36f16535bfb4ca832a40cd857f9d804614eb535d763a4317f504` | 24 tests |
| `runner-v2/src/architect-tools.ts` | `7dc062689055602c7da078dcbb7d357ac63dbc3532863facaf32b6a84b25680a` | `planningTools` option + registration |
| `runner-v2/src/build-runtime.ts` | `08f0b5555791f71eb835bd54dca881d339ac52f68168d36fae10df4544e7b36e` | new-policy registration, plan_required branch, surface + universe |
| `runner-v2/src/native-architect-runtime.ts` | `1a0e669553f74d68e36e7e1c64fad4e8cacbdbaebfa2e652d19384694bff6739` | `PlanningStateInspectionRuntime` + wiring |
| `runner-v2/src/agent-prompts.ts` | `f11e7063ff3a3066b4b391f7c7185e12441465366385ce838d9fbf5aa7dd8a58` | `NEW_POLICY_PLANNING_INSTRUCTIONS` + section |
| `runner-v2/src/task-scheduler.ts` | `591df4c17095ef854c7f1e24833815336beaf2c9365dc8ba27456974893052aa` | admission gate in `tick()` |
| `runner-v2/src/scheduler-store.ts` | `2da33b31e5a4749460f767210930099884d030ba8d158c914cbde4a29fdf257b` | `isPlanningState`, `readyPlanIdentity`, reducer gates, plan-only readiness |

Untouched as designed: `role-capabilities.ts` (planning tools are lifecycle-surface tools like
`plan_tasks`, not broker tools, so no allow-list entry is needed), all T1/T2/forbidden files,
`native-build-factory.ts`, UI/client, package files.

Line-ending note: edited CRLF files were converted to LF for editing and converted back; `git diff`
shows only the intended hunks (6 files, +243/−27). New files are LF, matching T1/T2's new files.

## What was built

1. **Planning tools** (`planning-tools.ts`, T3 checkboxes 1–2): `read_planning_source_section`
   (inventory listing plus full verified reads; sections over 64 KiB are refused, never truncated;
   digest/length drift refused; records read receipts), `persist_planning_ledger` (T1
   `validateRequirementLedger` before append), `record_planning_checkpoint` (T1 checkpoint
   validation; newly covered sections require a read receipt against the current manifest, so an
   unread/truncated section is never counted), `draft_planning_plan` (refused before the ledger;
   digest via `buildExecutionPlanRevision`, T1 `validateExecutionPlanRevision`), and
   `revise_planning_plan` (exact expected-revision binding). All validate with T1 and append through
   T2 events; the reducer re-validates (no second authority). Read returns no lifecycle signal
   (same pattern as `write_project_doc`), so a turn can read then decide. Registered for
   new-policy runs via `createArchitectTools({ planningTools })`, wired in `build-runtime.ts`
   `runArchitect` when `planningPolicyVersion === 1`; names added to `ARCHITECT_LIFECYCLE_SURFACE`
   plus one universe entry. Legacy runs keep today's tools (asserted).
2. **Planning-state predicate** (OA-7/EP41, `scheduler-store.ts:689`): `isPlanningState()` — true
   for a new-policy run with no ready plan and triage not `answer`. `readyPlanIdentity()`
   (`scheduler-store.ts:708`) returns the ready plan revision id + digest or undefined. T9 seam:
   new `planningTriageDecision` projection field (always undefined until T9's triage events land;
   undefined counts as planning state) and the T3b seam below.
3. **Command refusal** (`native-architect-runtime.ts:307,1108`): planning-state turns get
   `PlanningStateInspectionRuntime`, which filters `run_evidence_command` from definitions and
   refuses forged invokes with `planning_state_command_refused`; no disposable copy is created.
   Legacy turns unchanged.
4. **Plan-only + admission gates** (EP32/EP23, T3 checkbox 5): `buildCompletionReadiness`
   plan-only branch requires the ready identity for new-policy runs (docs gate untouched, G-3);
   `project.handoff_requested` reducer agrees; `TaskScheduler.tick()` admits nothing for new-policy
   runs without the ready identity and never for plan-only; the `task.transitioned` reducer refuses
   direct-event assigned/running for new-policy runs without the ready identity (`Worker admission
   requires a ready plan revision.`) and for plan-only (`Plan-only runs never admit workers.`).
   Source/plan changes flip durable readiness (T2), re-blocking admission until re-readiness.
5. **Prompts**: 5-line `NEW_POLICY_PLANNING_INSTRUCTIONS`, shown only when
   `planningPolicyVersion === 1` (asserted present/absent).

## Commands and results (exact counts)

Node: `C:\Program Files\nodejs\node.exe`. Tests:
`node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`, per file:

| Suite | tests | pass | fail |
|---|---|---|---|
| planning-tools (new) | 24 | 24 | 0 |
| architect-tools | 1 | 1 | 0 |
| build-runtime | 28 | 28 | 0 |
| native-architect-runtime | 19 | 19 | 0 |
| task-scheduler | 8 | 8 | 0 |
| architect-lifecycle-surface | 6 | 6 | 0 |
| role-capabilities | 14 | 14 | 0 |
| planning-state | 37 | 37 | 0 |
| planning-projection | 4 | 4 | 0 |
| replay-compatibility (unchanged) | 3 | 3 | 0 |
| scheduler-store (extra, reducer impact) | 31 | 31 | 0 |
| project-docs (extra, docs-gate impact) | 16 | 16 | 0 |
| **Total** | **191** | **191** | **0** |

- Typecheck `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- ESLint on all 8 changed files: exit 0.
- Full suite / importer sets not run (controller owns them).

Named-brief-test mapping (all in `planning-tools.test.ts`): source read of every section;
unread never counted; oversized refused-never-truncated; drift refused; stale manifest/unknown
section; draft-before-ledger refused; ledger→draft→revise incl. investigation contract passthrough;
invalid ledger + stale revise; checkpoint+resume incl. sqlite restart; predicate matrix
(legacy/new-policy/ready/triage build+clarify+answer); runtime refusal direct + full
NativeArchitectRuntime turn (zero disposable copies) + legacy control; prompt presence/absence;
plan-only completion incl. reducer path + legacy control; docs gate (STATE.md); plan-only zero
dispatch incl. BuildRuntime restart; admission refused→allowed→re-blocked after source change;
re-blocked after plan change with ready control; direct dispatch bypass incl. legacy controls;
direct plan-only tick zero-dispatch incl. ready arm; surface/universe inclusion.

## Prove-red records (all restored, hashes match)

Method per guard: print file sha256 BEFORE, back up bytes, disable only that guard, run the named
test (must go red because the forbidden action SUCCEEDS), record the exact assertion, restore bytes,
verify sha256 matches.

1. **Planning-state command refusal** — `runner-v2/src/native-architect-runtime.ts`
   BEFORE `1a0e669553f74d68e36e7e1c64fad4e8cacbdbaebfa2e652d19384694bff6739`.
   Mutation: `} else if (isPlanningState(projection)) {` → `} else if (false) {`.
   Named test `T3a architect turn in planning state is refused command execution before triage`
   went red at `planning-tools.test.ts:984`:
   `assert.equal(listed.includes("run_evidence_command"), false)` — actual `true` (forbidden
   command tool exposed). Supplementary `/tmp` probe (same harness shape): guard on →
   `{listed:false, creates:0}`; guard off → `{listed:true, creates:1}` (disposable copy creation
   SUCCEEDS). AFTER `1a0e6695…6739` — match; probe back to `{listed:false, creates:0}`.
2. **Worker admission before readiness** — `runner-v2/src/scheduler-store.ts`
   BEFORE `2da33b31e5a4749460f767210930099884d030ba8d158c914cbde4a29fdf257b`.
   Mutation: only the reducer's `if (!readyPlanIdentity(current))` admission branch → `if (false)`.
   Named test `T3a direct scheduler dispatch bypass is refused before readiness` went red at
   `:1563` with `Missing expected exception` (expected `/requires a ready plan revision/`) — the
   direct `assigned` append SUCCEEDED. AFTER `2da33b31…257b` — match.
3. **plan_only zero-dispatch** — `runner-v2/src/scheduler-store.ts`
   BEFORE `2da33b31e5a4749460f767210930099884d030ba8d158c914cbde4a29fdf257b`.
   Mutation: only the reducer's plan-only branch
   (`if (current.runPolicy === "plan_only")` → `if (false)`).
   Same named test went red at `:1581` with `Missing expected exception` (expected
   `/never admit workers/`) — the plan-only+ready direct `assigned` append SUCCEEDED.
   AFTER `2da33b31…257b` — match.

Supplementary (honestly recorded, not counted as the three): disabling only the `tick()` readiness
check makes the admission test red via the *reducer* catch (`Worker admission requires a ready
plan revision`) — defense in depth, but not success-side, so the reducer branch is the official
prove-red #2. The first plan_only attempt (unready run) reddened via message mismatch, so the test
was sharpened to the plan-only+ready arm before the official prove-red #3 run.

## Not done / limits (incl. the T3b seam)

- **T3b seam (correct, per EX-2):** no `planning-review.ts`, reviewer runtime,
  record-obligations-before-plan, verdicts/categories, blocking hold, re-review blindness, or
  plan_ready trigger. `readyPlanIdentity()` can only become defined via the T2 `plan_ready` event,
  which requires a bound coverage review — impossible until T3b. Tests seed coverage+ready via
  direct events as the documented T3b stand-in. A new-policy run therefore plans forever (T3a
  `plan_required` loop) until T3b lands; that is the briefed behavior.
- **T9 seam:** `planningTriageDecision` is defined and read by `isPlanningState()` but no reducer
  sets it; triage/answer/convert tools and events are T9's. `architectLifecycleEventMatchesReason`
  `plan_required` still matches only `plan.created` (question-resume on new-policy runs is T9's).
- **Production provisioning gaps:** nothing appends `planning.policy_configured`,
  `planning.source_registered`, or source bytes in production yet (factory is forbidden to this
  task; likely T7/factory work). `readSource` falls back to `artifacts.get(artifactDigest)` when
  only artifacts are wired; otherwise the read tool errors explicitly. Note: `planning.policy`
  must be stamped while `lastSequence <= 3`, i.e. before `BuildRuntime`'s own policy appends —
  the factory must order it early.
- **Lifecycle action labels:** `agent-contracts.ts` is outside this task's writable set, so its
  closed `architect_action` union could not gain planning-specific values. Ledger/checkpoint/draft
  emit `plan_created` and revise emits `plan_reconciled`, with the ledger/checkpoint/revision id
  in `referenceId` (the tool name in the transcript is the precise label; nothing mechanical
  switches on `action`). Recommend a follow-up with agent-contracts writable add
  `planning_ledger_persisted`-style values.
- **Legacy `plan_tasks` stays registered on new-policy runs.** The admission/completion gates make
  a legacy plan inert there (no dispatch, no completion without the ready identity), but a stricter
  surface split was deferred as unrequested.
- **T2 observation (forbidden file — reported, not changed):** after a section-*retiring*
  amendment, `planning.checkpoint_recorded` looks unappendable: monotonicity requires keeping the
  retired section id, while the unknown-section check rejects it against the current manifest
  (works only if no checkpoint predates the amendment). Planning itself is unaffected (draft/revise
  need no checkpoint). Controller may want a T2-follow-up decision.
- Role-capability, factory, UI/client, and package files intentionally untouched. Full suite and
  importer sets not run (controller owns them).

## Repair cycle 1 (review r1: B1 + N1 + N3 + N4)

Review: `evidence/T3a-review-r1.md` (1 blocking, 3 cheap/non-blocking fixed here).
All changes left uncommitted, as briefed. Nothing was staged, stashed, committed, or pushed.
Forbidden files untouched: `planning-contracts.ts`, `source-manifest.ts`,
`planning-projection.ts`, `native-build-factory.ts`, UI/client, package files (verified in
`git diff --stat`: only the 6 files below plus this evidence file).

Line-ending note: the 5 edited `src/` files were converted CRLF→LF for editing and converted
back to CRLF afterwards (repo checkout convention under `core.autocrlf=true`; HEAD blobs are
LF). Prove-red hashes below are LF-byte hashes; the table hashes are the final CRLF-byte
hashes. `git diff` shows only the intended hunks.

### Files changed (sha256 of working copy at repair evidence time)

| File | sha256 | Change |
|---|---|---|
| `runner-v2/src/scheduler-store.ts` | `db6945ce6687a61f04f0f71b66574a6ef2912075eb30bc096f3af9f185c71fd0` | B1 reducer gates + ready-plan task bindings |
| `runner-v2/src/architect-tools.ts` | `80a551eccdbede43bc493c954f8d704dd1d16871ba0d80bdd2793bdaa0af9598` | B1 planning-state surface filter + tool-side checks |
| `runner-v2/src/build-runtime.ts` | `ec9e4751ec0dfaa944bda8aab9d937c849eb1814cedf6d1626ad0b9512cc412b` | B1 pass planning state + universe shape |
| `runner-v2/src/task-scheduler.ts` | `345831b8f75e30d93996ae9fb0980b13f469acc24ad74302f539c213db3a5180` | B1 per-task binding checks + N3 re-checks |
| `runner-v2/src/native-architect-runtime.ts` | `04e1cef42966a4deed53be18ae7a86b887382ca9f44176e7df6f4cd3c2cf39a6` | N4 per-invoke command guard |
| `runner-v2/test/planning-tools.test.ts` | `c5d9ac5ab1dbcf6ede72ff28994808ca6df78fe0beaf45d5293db90a8a95b655` | 30 tests (24 + 6 new; seeding reordered) |

Unchanged this cycle (hashes re-verified, match the T3a table):
`planning-tools.ts` `2a7503d7…4864`, `agent-prompts.ts` `f11e7063…8a58`.

### Finding → change → test

- **B1a (reducer refuses task creation before readiness)** — `scheduler-store.ts:2118`
  (`plan.created`), `:2187` (`acceptance_contract.upgraded`), `:2445` (`task.revised`),
  `:5506` (`applyPlanReconciliation` entry — one choke point covering `plan.reconciled`
  and review/guidance/critique resolutions carrying a reconciliation; none of the four
  callers mutates planning first, so the identity read is the pre-event one). All keyed on
  `planningPolicyVersion === 1`; legacy replays untouched. Extra tool-side check
  `newPolicyPlanNotReady` (`architect-tools.ts:2334`) in `plan_tasks` (`:1457`),
  `reconcile_plan` (`:1415`), `revise_task` (`:1526`) returns `plan_not_ready`.
  Tests: `T3a repair B1: legacy plan tools refuse before readiness and bind once ready`
  (tool path, incl. post-ready success + stamp assertion) and
  `T3a repair B1: reducer refuses task-adding and task-revising events before readiness`
  (direct path, incl. ready arm and legacy arm).
- **B1b (planning-state surface)** — `architect-tools.ts:94` (`planningState?` option),
  `:485` (omit `plan_tasks`/`revise_task` from base core), reconcile filter in the
  finish branch; `build-runtime.ts:1856` passes `planningState: true` iff
  `isPlanningState(projection)` (false for legacy and once ready); universe shape added
  at `:2392` (subset — surface assert unchanged). Required-tools assert is safe:
  `ARCHITECT_LIFECYCLE_TOOLS` is only complete/review/request_integration. A forged
  invoke of a hidden tool fails with `unknown_tool` (not registered).
  Tests: `T3a repair B1: planning-state turns hide legacy plan tools; forged invokes fail`
  plus planning-state-turn assertions inside the reworked N1 test.
- **B1c (ready-plan binding at admission)** — no forbidden file needed: the binding lives
  on `SchedulerProjection.readyPlanTaskBindings` (`scheduler-store.ts:658`, optional —
  no initializer/test breakage), stamped by the reducer in `plan.created` (`:2140`) and
  for reconciliation `newTasks` (`:5754`); revised tasks keep their original binding
  (a revision is not a re-review — fail closed). Single predicate
  `newPolicyTaskAdmissionBlocked` (`:745`) used by the `task.transitioned` gate and by
  `tick()` (loop-top skip, `task-scheduler.ts:142,187`). A task not bound to the current
  ready revision id + digest is never admitted.
  Tests: `T3a repair B1: no task outside the ready plan is ever dispatched` — the
  reviewer's reproduction (`rogue` refused before the ledger, full flow to ready, tick
  dispatches only ready-bound tasks), then R1→revise→R2 re-readiness: stale direct
  `assigned` throws `/not bound to the current ready plan/`, the tick skips the
  planned-but-stale task while an R2-added task dispatches.
- **B1d (seeding reorder)** — admission test seeds after `plan_ready` (pre-ready tick now
  asserts empty tasks); revise test seeds after `plan_ready`; direct-bypass unready arm
  is now ready→seed→amend→refused; plan_only tick unready arm is ready→seed→amend→tick.
  New `appendSourceAmendment` helper (test file).
- **N1 (plan_only restart test)** — reworked `T3a plan_only new-policy run dispatches zero
  workers, including after restart`: after 3 planning turns it seeds coverage+ready plus
  two tasks, ticks (zero dispatch, zero `workspaceFor` calls, both stay planned, direct
  `assigned` throws `/never admit workers/`), restarts over sqlite, and repeats the tick
  + direct assertions on the reopened store (readiness still `ready`, tasks still there).
- **N3 (re-check after await)** — `task-scheduler.ts`: `newPolicyAdmissionClosed` helper
  (`:428`); loop-top per-task skip; after each `await workspaceFor` a global
  return + per-task continue (`:150,:196`); a final check before each dispatch
  (`:163,:201`, also covering the no-await `workspacePath` path). Check and
  transition/dispatch are synchronous, so no change can land between them and `tick()`
  never throws an admission error — the task is skipped cleanly.
  Test: `T3a repair N3: a source change during workspace allocation cannot dispatch`
  (delayed `workspaceFor` amends mid-await; arms `running`/`assigned`/`planned`; the
  running arm is first because an already-running task dispatches with no reducer
  transition, so the tick re-check is its sole enforcement).
- **N4 (per-invoke refusal)** — `PlanningStateCommandGuard`
  (`native-architect-runtime.ts:1152`) wraps the composed command inspection (`:313`);
  every `run_evidence_command` invoke re-reads the durable projection and is refused
  with `planning_state_command_refused` once the run is back in planning state. The
  turn-start `PlanningStateInspectionRuntime` path is unchanged (shares the refusal
  constructor). Other tools delegate untouched.
  Test: `T3a repair N4: command refusal is evaluated on every invoke` (ready → passes
  through; amend mid-turn → same guard refuses while the tool stays listed).

### Commands and results (exact counts, post-CRLF bytes)

Node `C:\Program Files\nodejs\node.exe`,
`node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`, per file:

| Suite | tests | pass | fail |
|---|---|---|---|
| planning-tools | 30 | 30 | 0 |
| planning-state | 37 | 37 | 0 |
| planning-projection | 4 | 4 | 0 |
| architect-tools | 1 | 1 | 0 |
| build-runtime | 28 | 28 | 0 |
| native-architect-runtime | 19 | 19 | 0 |
| task-scheduler | 8 | 8 | 0 |
| scheduler-store | 31 | 31 | 0 |
| architect-lifecycle-surface | 6 | 6 | 0 |
| role-capabilities | 14 | 14 | 0 |
| project-docs | 16 | 16 | 0 |
| replay-compatibility (unchanged) | 3 | 3 | 0 |
| **Total** | **197** | **197** | **0** |

A combined 12-file run also reports 197/197/0. Typecheck
`tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. ESLint on all 6 changed files:
exit 0. Full suite / importer sets not run (controller owns them).

### Prove-red records (all restored byte-exact, hashes match)

Method per guard: record file sha256 BEFORE, back up bytes to `/tmp`, mutate only that
guard (needle asserted unique; injection verified by re-grep), run the named test (must
go red because the forbidden action SUCCEEDS), record the exact assertion, restore bytes,
verify sha256 matches BEFORE.

1. **B1 reducer refusal of `plan.created`** — `runner-v2/src/scheduler-store.ts`
   BEFORE `5ebf7b71113b0b8386d9c733e267d8cde079bc2a47d4384b965dfa242db6fc10`.
   Mutation: `if (current.planningPolicyVersion === 1 && !planReady) {` → `if (false) {`
   (needle count 1; INJECTED `380011fb…a006a6`; guard string absent after injection).
   Named test `T3a repair B1: reducer refuses task-adding and task-revising events before
   readiness` went red at `planning-tools.test.ts:1867`:
   `Missing expected exception` (expected `/require a ready plan revision/`) — the
   direct `plan.created` append SUCCEEDED. AFTER `5ebf7b71…6fc10` — match.
2. **B1 per-task ready-plan binding** — `runner-v2/src/scheduler-store.ts`
   BEFORE `5ebf7b71113b0b8386d9c733e267d8cde079bc2a47d4384b965dfa242db6fc10`.
   Mutation: only the binding branch in `newPolicyTaskAdmissionBlocked`
   (`if (!binding || revisionId/digest mismatch)` → `if (false)`; needle count 1;
   INJECTED `54d3d435…26cf428`; guard absent after injection).
   Named test `T3a repair B1: no task outside the ready plan is ever dispatched` went
   red at `:2159`: `Missing expected exception` (expected
   `/not bound to the current ready plan/`) — the stale direct `assigned` append
   SUCCEEDED. AFTER `5ebf7b71…6fc10` — match.
3. **N1 plan_only zero dispatch** — `runner-v2/src/scheduler-store.ts`
   BEFORE `5ebf7b71113b0b8386d9c733e267d8cde079bc2a47d4384b965dfa242db6fc10`.
   Mutation: only the reducer's plan-only branch
   (`if (projection.runPolicy === "plan_only")` → `if (false)`, block body kept so the
   file stays syntactically valid; needle count 1; INJECTED `b778e426…ab8aa8`; guard
   absent after injection).
   Named test `T3a plan_only new-policy run dispatches zero workers, including after
   restart` went red at `:1431`: `Missing expected exception` (expected
   `/never admit workers/`) — the plan-only+ready direct `assigned` append SUCCEEDED.
   AFTER `5ebf7b71…6fc10` — match. (First mutation attempt replaced the whole
   if/return/brace block with a bare `if (false) {`, which unbalanced braces and failed
   at file load; it was restored from backup before the official run above. The tick's
   own plan_only branch is backstopped by the loop-top per-task checks plus this
   reducer branch, so a tick-only disable cannot go success-side red.)
4. **N3 re-check after await** — `runner-v2/src/task-scheduler.ts`
   BEFORE `fdcb876aa721337a39d927a9c7e9f1c6d0a7e2f5ed384391b310450b11f04acf`.
   Mutation: the first-loop N3 re-verification as one guard — the post-await block
   (`if (newPolicyAdmissionClosed…) return;` + per-task `continue`) and the
   pre-dispatch line, each → `if (false)` (both needles count 1;
   INJECTED `4b13a023…3d3b6`; both guards absent after injection; the loop-top check
   and the reducer are untouched).
   Named test `T3a repair N3: a source change during workspace allocation cannot
   dispatch` went red at `:2272` in the `running` arm:
   `assert.deepEqual(driver.assignments, [])` — actual `['a']` (the worker STARTED
   after readiness loss, with no reducer transition to catch it). AFTER
   `fdcb876a…f04acf` — match. (First attempt hung: the test asserted after
   `awaitIdle`, which waits on the dispatched worker; the test was reordered to assert
   before `awaitIdle` — green re-verified — then the official run above.)
5. **N4 per-invoke refusal** — `runner-v2/src/native-architect-runtime.ts`
   BEFORE `251e96fcb535df702f79ea19d4a6a257dcd7a6f54fa2dd37fed8c4c6db0914d3`.
   Mutation: `if (call.name === "run_evidence_command" &&
   isPlanningState(this.readProjection())) {` → `if (false) {` (needle count 1;
   INJECTED `28221682…31153`; guard absent after injection).
   Named test `T3a repair N4: command refusal is evaluated on every invoke` went red
   at `:2330`: `assert.equal(refused.isError, true)` — actual `false` (the forbidden
   command EXECUTED after readiness loss). AFTER `251e96fc…0914d3` — match.

### Not done (controller carry-forwards, per brief — do-not-fix list)

- **N2 (read receipts durability → T3b):** untouched, as instructed. Receipts remain
  per-`createPlanningTools`-instance memory; T3b must persist a
  `planning.source_section_read` receipt (or equivalent) and must not treat checkpoint
  coverage as read evidence.
- **N5 (steering reconciliation note):** untouched as a finding. Note: the new
  `applyPlanReconciliation` entry gate additionally refuses steering-bearing guidance
  acknowledgements on new-policy runs without a ready plan; on a READY run the
  same-attempt steering path can still set `assigned` without a reducer transition, and
  the tick gate + `running` reducer gate remain the enforcement there.
- **N6 (T2 checkpoint-after-retiring-amendment → controller decision):** untouched;
  `planning-projection.ts` stays forbidden and unmodified.
- Deliberate scope note: `final_verification.generation_created` (kernel-owned task)
  is intentionally NOT gated — it can only be reached after workers complete, and the
  tick + `task.transitioned` admission gates still block any FV dispatch without the
  ready identity. T4 owns the real ready-plan→task bridge and should revisit this.
- Full suite and importer sets not run (controller owns them).

## Repair cycle 2 (review r2: B2 + B3 blocking, N-B, N-C note)

Review: `evidence/T3a-review-r2.md` (2 blocking introduced by the per-task
binding). Scratch probes reused as test basis:
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch\t3a-r2-probe.test.mts`
(probes B and D are now committed tests; probe A/C shapes folded into
existing coverage).
All changes left uncommitted, as briefed. Nothing was staged, stashed,
committed, or pushed. Forbidden files untouched (`planning-contracts.ts`,
`source-manifest.ts`, `planning-projection.ts`, `native-build-factory.ts`,
UI/client, package files — verified via `git status` on those paths).

Line-ending note: `scheduler-store.ts` and `build-runtime.ts` were converted
CRLF→LF for editing and converted back to CRLF afterwards (pure-CRLF files,
verified no lone LFs before conversion). Prove-red hashes below are LF-byte
hashes; the table hashes are the final CRLF-byte hashes. `git diff` shows
only the intended hunks (build-runtime 56→64 lines, scheduler-store
189→283 lines vs cycle 1).

### Design decision (controller rule: membership if a mapping exists, else rebind)

Checked for a task→plan-contract mapping in T1 contracts and task fields:
none exists without inventing T4's bridge. `BuildTask`
(`task-contracts.ts:64`) carries no contract-reference field — only
`verificationRepair`/`verifierRepair` provenance for repair tasks — and
scheduler task ids are free-form: the accepted T3a corpus seeds
`a`/`b`/`c`/`rogue` while the fixture plan contracts are
`T1..T5,T-INV`, and kernel-created repair/FV tasks have no contracts at
all. A membership predicate on id equality would strand every established
test task and all repair tasks, and T4 owns the plan→task bridge. So:
**rebind, not membership**. N-A (true membership — a post-ready `rogue`
id not in the ready plan still dispatches) stays open as a T4
carry-forward; see "not done".

Consequence for the wake requirement: with rebind-at-ready plus
stamp-at-creation on every task-adding path, ready-state staleness is
unreachable via public events (every `plan_ready` refreshes all
stale-bound non-terminal tasks). The live stale-only state is the
not-ready window (amendment/revision before re-readiness), which
`dispatchStep` already routes to `plan_required` — now covered by a
regression test. The new post-tick guard is defense-in-depth for the idle
return the brief names; it is predicate-tested, not live-step-tested
(cannot be constructed via events by design).

### Files changed (sha256 of working copy at repair evidence time)

| File | sha256 | Change |
|---|---|---|
| `runner-v2/src/scheduler-store.ts` | `f7db10300eec1ce199193578e2d6779bddc3a26e515c8fdf7f3f36db0f0ac5d6` | B2 rebind + stale predicate; B3 repair stamping + refusal |
| `runner-v2/src/build-runtime.ts` | `b66658234b549d0eb25518187ac5172021f8eac7318301468e2d298182f109d2` | B2 post-tick stale wake |
| `runner-v2/test/planning-tools.test.ts` | `4588e0728abb8f5583d3b1b1e15500cb760883717357328856188e55c4ccd706` | 36 tests (30 + 6 new; B1 repro reworked) |

Unchanged this cycle (hashes re-verified, match review r2 / T3a table):
`native-architect-runtime.ts` `04e1cef4…39a6`, `task-scheduler.ts`
`345831b8…3180`, `architect-tools.ts` `80a551ec…598`,
`planning-tools.ts` `2a7503d7…4864`, `agent-prompts.ts` `f11e7063…8a58`.

### Finding → design choice → change → test → prove-red

- **B2 (plan revision strands every task; idle with zero Architect calls)**
  — Choice: rebind (no mapping exists; see above). `scheduler-store.ts`:
  `rebindReadyPlanTaskBindings` (`:779`) called from the planning-event
  dispatch on `planning.plan_ready` (`:2076-2079`, after the T2
  sub-reducer). It re-stamps every non-terminal (`integrated`/`cancelled`
  excluded) task carrying a stale binding to the new ready identity;
  terminal tasks keep stamps (never need admission again), never-bound
  tasks stay unbound (fail closed). Any binding on a new-policy run was
  stamped from a ready identity, so a stale binding is necessarily from a
  previous ready revision. Pure function of the post-event projection:
  deterministic, replay-safe. Wake: exported
  `newPolicyStaleTasksRequireArchitect` (`:806` — pending non-terminal
  non-FV tasks exist but admission blocks all of them; legacy never
  fires), checked post-tick in `build-runtime.ts:995-1001` (import `:30`):
  `plan_required` (no generic reconciliation reason exists in
  `ArchitectActionReason`) instead of `idle / no_mechanical_progress`.
  Only fires when the tick made zero progress AND every pending task is
  blocked, so normal idle (dependency waits, bound work) is unchanged.
  Tests: `T3a repair B2: re-readiness rebinds tasks so they dispatch
  again (probe B)` (`planning-tools.test.ts:2297` — R1 → tasks → revise
  R2 → ready R2 → bindings equal R2, direct `assigned` succeeds, tick
  dispatches `["a","b"]`, incremental reduce derives identical
  bindings); `... a stale-only state wakes the Architect instead of
  idling (probe D)` (`:2427` — amended stale-only run,
  `BuildRuntime.step()` calls the architect once with `plan_required`,
  result `progressed/plan_required`, never idle); `... the stale-task
  predicate only fires when pending work is fully blocked` (`:2484` —
  ready→false, amended→true, legacy→false, empty→false,
  all-terminal→false, FV-kernel-task-only→false with the FV task
  provably admission-blocked, so the exclusion is load-bearing).
  The cycle-1 B1 repro test (`:2040`) had its second half reworked: the
  R1→R2 stranding assertions (stale `assigned` throws, tick skips `b`)
  encoded the bug as intended and are replaced by rebind-dispatch
  coverage in the probe-B test; the test now asserts `["a","b","c"]`
  dispatch with `rogue` never created.
- **B3 (repair tasks never bound → post-ready repair deadlock)** —
  `createVerifierRepairTasks` (`:4306-4313` refusal, `:4434-4441` stamp)
  and `createFinalVerificationRepairTasks` (`:4495-4502` refusal,
  `:4601-4608` stamp): on a new-policy run without a ready plan the
  event is refused (B1a-consistent — every task-adding path requires
  readiness; checked BEFORE `consumeRepairCycle` so a refusal spends no
  repair budget; leaving them unbound would strand them past re-readiness
  since rebind skips never-bound tasks), otherwise the new repair ids are
  stamped with the current ready identity. Legacy untouched (all gated on
  `planningPolicyVersion === 1`). Tests (helpers `:2565-2697`, mirroring
  the FV/verifier fixtures): `T3a repair B3: verifier repair tasks are
  bound ...` (`:2699` — ready → integrated plan → green approved FV →
  verifier request → unsatisfied verdict → `verifier.repairs_planned` →
  binding stamped → tick dispatches `["repair-api"]`); `...:
  final-verification repair tasks are bound ...` (`:2868` — semantic
  `repair_required` in tests+browser → `final_verification.repairs_planned`
  → both bindings stamped → tick dispatches both repair tasks).
- **N-B (N4 wiring untested)** — test only, no source change:
  `T3a repair N-B: mid-turn readiness loss refuses later commands through
  the real runtime wiring` (`:3014`). Full `NativeArchitectRuntime` turn
  starting ready (command layer composed behind the guard): scripted
  model calls a lifecycle tool that appends `source_amended`, then
  `run_evidence_command`. Asserts the tool was listed at turn start, the
  run is back in planning state, the post-amendment invoke is refused
  with `planning_state_command_refused`, and zero disposable copies are
  created. Prove-red below uses the review's exact passthrough mutation
  (same injected hash).
- **N-C (cosmetic tick issues)** — left untouched, as permitted: (1) the
  second-loop pre-dispatch re-check is harmless redundancy; (2) the
  budget-pause-before-binding-skip ordering only matters for a stale
  task while global admission is open (ready), which is unreachable via
  public events post-fix (rebind + stamp-at-creation). Zero reachable
  effect; not worth the churn.

Keep-clauses honored: every new gate/refusal requires
`planningPolicyVersion === 1` (legacy runs and old logs unchanged;
`replay-compatibility` 3/3); no second authority (all reads go through
`readyPlanIdentity`/`newPolicyTaskAdmissionBlocked` over the T2
projection); `tick()` never throws (unchanged control flow — the wake
lives in `dispatchStep`, and tick still only skips).

### Commands and results (exact counts, post-CRLF bytes)

Node `C:\Program Files\nodejs\node.exe`,
`node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`, per file:

| Suite | tests | pass | fail |
|---|---|---|---|
| planning-tools | 36 | 36 | 0 |
| planning-state | 37 | 37 | 0 |
| planning-projection | 4 | 4 | 0 |
| architect-tools | 1 | 1 | 0 |
| build-runtime | 28 | 28 | 0 |
| native-architect-runtime | 19 | 19 | 0 |
| task-scheduler | 8 | 8 | 0 |
| scheduler-store | 31 | 31 | 0 |
| architect-lifecycle-surface | 6 | 6 | 0 |
| role-capabilities | 14 | 14 | 0 |
| project-docs | 16 | 16 | 0 |
| replay-compatibility (unchanged) | 3 | 3 | 0 |
| final-verification-completion | 9 | 9 | 0 |
| final-verification-execution | 8 | 8 | 0 |
| final-verification-integrity | 11 | 11 | 0 |
| final-verification-observability | 3 | 3 | 0 |
| final-verification-orchestration | 9 | 9 | 0 |
| final-verification-profile | 16 | 16 | 0 |
| final-verification-repair | 13 | 13 | 0 |
| final-verification-review | 9 | 9 | 0 |
| final-verification-scheduler | 5 | 5 | 0 |
| verifier-contracts | 41 | 41 | 0 |
| verifier-observability | 1 | 1 | 0 |
| repair-cycles | 16 | 16 | 0 |
| **Total** | **344** | **344** | **0** |

The FV/verifier file set is every `final-verification-*` / `verifier-*`
test file importing `scheduler-store` (grep-verified; 11 files) plus
`repair-cycles` (repair-plan surface). Typecheck
`tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. ESLint on all 3
cycle-2 changed files: exit 0. Full suite / importer sets not run
(controller owns them).

### Prove-red records (all restored byte-exact, hashes match)

Method per guard: record file sha256 BEFORE, back up bytes to `/tmp`,
mutate only that guard (needle asserted unique — count 1 — or the run
aborts; injection verified by changed sha256), run the named test (must
go red because the forbidden action is no longer refused / the required
action no longer happens), record the exact assertion, restore bytes,
verify sha256 matches BEFORE. Helper: `/tmp/p6-6-mutate.mjs` (kept for
re-run; outside the repo).

1. **B2 rebind** — `runner-v2/src/scheduler-store.ts`
   BEFORE `29bb627634ca396f2eb24a558ce635b1a2d5dc5f86df9981879e588ecd20cce4`
   (LF bytes). Mutation: `if (event.type === "planning.plan_ready") {` →
   `if (event.type === "planning.plan_ready" && false) {` (needle count
   1; INJECTED `81a6dde5…85f4c`; sha changed).
   Named test `T3a repair B2: re-readiness rebinds tasks so they dispatch
   again (probe B)` went red at `planning-tools.test.ts:2382`:
   `deepStrictEqual` — actual `{ revisionId: 'revision_1', ... }`,
   expected `{ revisionId: 'revision_2', ... }` (bindings stuck stale —
   without the rebind the R1 tasks would never dispatch again).
   AFTER `29bb6276…0cce4` — match.
2. **B3 verifier stamp** — `runner-v2/src/scheduler-store.ts`
   BEFORE `29bb6276…0cce4`. Mutation: only the verifier creator's
   `if (repairReady) {` → `if (false) {` (needle spans the
   `Verifier repair plan is invalid` block above it for uniqueness; count
   1; INJECTED `7132f0ca…bb9b9`; sha changed).
   Named test `T3a repair B3: verifier repair tasks are bound ...` went
   red at `:2846`: `deepStrictEqual` — actual `undefined`, expected the
   R1 ready identity (the repair task is never stamped, so the tick
   would skip it forever). AFTER `29bb6276…0cce4` — match.
3. **B3 FV stamp** — `runner-v2/src/scheduler-store.ts`
   BEFORE `29bb6276…0cce4`. Mutation: only the FV creator's
   `if (repairReady) {` → `if (false) {` (needle spans the
   `Final verification repair plan is invalid` single-line throw above
   it; count 1 — a first attempt with the verifier-shaped multi-line
   needle aborted with count 0 and was corrected before any test ran;
   INJECTED `5b22d12b…58312`; sha changed).
   Named test `T3a repair B3: final-verification repair tasks are bound
   ...` went red at `:2990`: `deepStrictEqual` — actual `undefined`,
   expected the R1 ready identity. AFTER `29bb6276…0cce4` — match.
4. **N-B wiring** — `runner-v2/src/native-architect-runtime.ts` (CRLF bytes)
   BEFORE `04e1cef42966a4deed53be18ae7a86b887382ca9f44176e7df6f4cd3c2cf39a6`
   (= review r2 table — file untouched by this cycle).
   Mutation: the review's exact passthrough,
   `inspectionTools = new PlanningStateCommandGuard(` →
   `inspectionTools = ((r, _f) => r)(` (needle count 1; INJECTED
   `569cef72…2bcc` — identical to the review's injected hash, confirming
   the same mutation).
   Named test `T3a repair N-B: mid-turn readiness loss refuses later
   commands ...` went red at `:3151`: `strictEqual` — actual
   `'tool_execution_failed'`, expected `'planning_state_command_refused'`
   (the invoke reached the real command runtime and attempted execution
   instead of being refused; `tool_execution_failed` can only come from
   past `ensureBroker`/`openCopy`, so the `creates === 0` assert fails
   too). AFTER `04e1cef4…39a6` — match.
5. **Stale predicate (supplementary)** — `runner-v2/src/scheduler-store.ts`
   BEFORE `29bb6276…0cce4`. Mutation: `return pending.every(` →
   `return false && pending.every(` (needle count 1; INJECTED
   `521a1f9d…2d5ec`; sha changed).
   Named test `T3a repair B2: the stale-task predicate only fires ...`
   went red at `:2496`: `strictEqual` — actual `false`, expected `true`
   (the amended stale-only run is no longer detected, so no wake would
   fire). AFTER `29bb6276…0cce4` — match.

Not prove-reddened (no such guard built): B2 membership rejection — the
rebind option was chosen, so there is no membership predicate to remove.

### Not done (controller carry-forwards)

- **N-A (true membership → T4):** admission is still "bound while some
  plan was ready", not "task is in the ready plan". A post-ready `rogue`
  id absent from the ready plan's task contracts is accepted, stamped,
  rebound across revisions, and dispatched. Closing it needs T4's
  plan→task bridge (a durable task→contract link, which does not exist:
  scheduler ids are free-form and kernel tasks have no contracts).
- **N-C:** left as-is (harmless/unreachable post-fix; see above).
- **Ready-state post-tick wake is defense-in-depth:** unreachable via
  public events by construction (rebind + stamp-at-creation); covered by
  predicate unit tests plus the live not-ready-window step test, not by
  a live ready-state step test. If a future path introduces ready-state
  staleness, the guard fires `plan_required` instead of idling.
- **Cycle-1 prove-red #2's red site is superseded:** the stranding
  assertions it reddened (`:2159` then) were the bug; the binding branch
  itself is unchanged and still covered (unbound/new-policy-not-ready
  refusals, N1, direct-bypass tests).
- Carried from cycle 1 unchanged: N2 (read receipts → T3b), N5
  (steering note), N6 (T2 checkpoint-after-retiring-amendment →
  controller decision). `final_verification.generation_created` stays
  ungated (kernel task needs no admission: the tick skips FV tasks and
  the FV lifecycle runs on dedicated events, never `assigned`/`running`
  transitions).
- Full suite and importer sets not run (controller owns them).
