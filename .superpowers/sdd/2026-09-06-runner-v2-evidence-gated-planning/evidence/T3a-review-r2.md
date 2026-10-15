# T3a independent review — round 2

Reviewer: independent reviewer (not the author; code by Muse, repaired by Muse). No source or test file
was edited; nothing committed/staged/stashed. Only this file was written in the worktree. Scratch probes
and mutation helpers live in `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch\` (outside the repo).
Every mutation was restored byte-exact (sha256 shown below); `git status` afterwards is identical to the
start (6 modified + 2 untracked T3a files).

Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base
`5f901354`.

## 1. Scope

Read in order: `t3a-brief.txt`, `t3a-repair1.txt`, `T3a-review-r1.md`, plan §2, §3, §5.0, T3 and T4
(for the admission boundary and the "stale ready-plan digest" carry-forward). Then the full current
`git diff` (architect-tools, build-runtime, native-architect-runtime, scheduler-store, task-scheduler,
agent-prompts), plus the new-in-cycle tests in `planning-tools.test.ts` (B1 ×4, N1, N3, N4) and the
seeding helpers. Every task-creating reducer path in `scheduler-store.ts` was enumerated
(`plan.created`, `applyPlanReconciliation` and its 4 callers, `task.revised`,
`acceptance_contract.upgraded`, `final_verification.generation_created`,
`createVerifierRepairTasks`, `createFinalVerificationRepairTasks`) and checked against the new
binding map. Claims in `T3a.md` "Repair cycle 1" were read last.

## 2. Per-finding verification (round-1 items fixed this cycle)

| Item | Verdict | Evidence |
|---|---|---|
| B1a reducer refuses task creation/revision before readiness (new-policy only) | **Fixed** | Gates at `scheduler-store.ts:2118` (`plan.created`), `:2187` (`acceptance_contract.upgraded`), `:2445` (`task.revised`), `:5506` (`applyPlanReconciliation` entry — covers `plan.reconciled`, review/guidance/critique reconciliations). All keyed on `planningPolicyVersion === 1`. Probe A: direct `plan.created` refused before the ledger AND between draft and ready. |
| B1b planning-state surface | **Fixed** | `architect-tools.ts:485-495` and the reconcile filter; `build-runtime.ts` passes `planningState` iff `isPlanningState`. Hidden tools are not registered, so a forged invoke is `unknown_tool`; the tool-side `newPolicyPlanNotReady` (`architect-tools.ts:2334`) refuses too (probe A: `plan_not_ready`). Universe entry keeps the surface assert consistent. |
| B1c per-task ready-plan binding at admission | **Built, but binds incompletely — see B2, B3, N-A** | `readyPlanTaskBindings` stamped at `plan.created` (`:2140`) and reconciliation `newTasks` (`:5756`) only; `newPolicyTaskAdmissionBlocked` (`:745`) used by the `task.transitioned` gate (`:2551`) and by `tick()` (loop-top, post-await, pre-dispatch). Replay-deterministic: identity is read from the pre-event projection; probe B (reduce-chain vs rebuild) and probe C (SQLite reopen) give identical bindings. |
| B1d tests / seeding reorder | Fixed | Seeding now happens after `plan_ready`; reviewer's reproduction encoded in `T3a repair B1: no task outside the ready plan is ever dispatched`. |
| B1e legacy / old logs unchanged | **Fixed** | Every new gate requires `planningPolicyVersion === 1`; `planning.policy_configured` is refused once a plan/tasks exist (`:2036-2040`), so an old log cannot acquire the policy mid-stream. `replay-compatibility.test.ts` unchanged in the diff and 3/3. |
| N1 plan_only zero dispatch after restart | **Fixed** | Test now seeds ready plan + 2 tasks before and after SQLite reopen; asserts zero dispatch, zero `workspaceFor`, direct `assigned` refused. Not vacuous (worker's prove-red #3 reddens it via the reducer branch). Tick-only plan_only branch is backstopped by the per-task predicate — acceptable. |
| N3 re-check after await, no throw | **Fixed** | `task-scheduler.ts:150-155, 163-167, 194-203`. Reproduced prove-red below (running arm dispatches `['a']` with the guard off). Check-then-transition is synchronous, so `tick()` cannot throw an admission error from a concurrent append in-process. |
| N4 per-invoke refusal | **Fixed in code; wiring untested (N-B)** | `PlanningStateCommandGuard` (`native-architect-runtime.ts:1152`) wired at `:313`. Its test drives the class directly; removing the wiring leaves every test green (below). |

Reviewer's `rogue` reproduction (probe A): `plan_tasks` before the ledger → `isError:true plan_not_ready`;
direct `plan.created` refused; ledger → draft → coverage → ready → tick dispatches `[]`. **The literal
reproduction is fixed.**

## 3. New findings

### B2 — BLOCKING: any plan revision after tasks exist permanently strands every existing task; the run idles with no Architect wake

- Where: `scheduler-store.ts:2140-2150` and `:5752-5766` (binding stamped once, at creation, with the
  then-ready identity); `:745-765` (admission requires binding == current ready identity); `:2445`
  comment "a revision is not a re-review" (task.revised keeps the old binding); `plan.created` is
  single-shot (`:2112`), so there is no rebind path. `build-runtime.ts` step (~937-990): with
  non-terminal, non-failed tasks it only ticks and returns `idle / no_mechanical_progress`.
- Scenario (probes B and D): ready R1 → `plan.created` for exactly the plan's contract ids
  `T1..T5, T-INV` → `revise_planning_plan` to R2 with the *same* task contracts → coverage + ready R2.
  Every task reports `Task T1 is not bound to the current ready plan revision revision_2.`; tick
  dispatches `[]`; three `BuildRuntime.step()` calls return
  `{"status":"idle","action":"no_mechanical_progress"}` with **zero Architect calls**. The only way out
  (cancel each task and re-add it under a new id via `reconcile_plan`) is never prompted.
- Why blocking: the brief (item 4, EP23) says a changed source/plan "blocks further admission **until
  re-readiness**"; this implementation blocks forever after re-readiness. Plan revision after an owner
  amendment is the normal path (T3 checkbox 4), so the run deadlocks silently. The worker's test
  (`planning-tools.test.ts` ~2150-2200) encodes the stranding as intended ("b stays planned").
- Minimal fix (pick one, record the choice): (a) at `planning.plan_ready`, re-stamp every non-terminal
  task that the new ready revision still contains (membership by task-contract id / lineage), leaving
  only removed tasks stale; or (b) replace the time-of-creation stamp with a membership predicate
  (task id ∈ current ready revision's task contracts) evaluated at admission. In either case, when a
  non-terminal task is stale, wake the Architect with a typed reason instead of idling. Add a test:
  R1 → tasks → R2 containing them → re-ready → tick dispatches; R2 dropping one → that one never
  dispatches and the Architect is woken.

### B3 — BLOCKING: verifier and final-verification repair tasks are never bound, so post-ready repair flows deadlock

- Where: `createVerifierRepairTasks` (`scheduler-store.ts:4243`, tasks inserted at `:4366`) and
  `createFinalVerificationRepairTasks` (`:4412`, inserted at `:4513`) add implementation tasks without
  writing `readyPlanTaskBindings` (the map is written only at `:2143-2150` and `:5760-5764`, verified by
  grep). These tasks are ordinary worker tasks (`readyTaskIds` includes them); `tick()` skips them via
  `newPolicyTaskAdmissionBlocked` and the reducer refuses their `assigned` transition.
- Scenario: new-policy ready run → tasks integrate → final verification fails (or the independent
  verifier returns unsatisfied) → Architect plans repairs (`final_verification.repairs_planned` /
  `verifier.repairs_planned`) → repair tasks are never admitted → the same idle loop as B2. The
  repair brief's own regression bar ("the gates must not deadlock the post-ready flow, e.g. …
  final verification") is not met, and the evidence's scope note only discusses
  `final_verification.generation_created` (the kernel task), not the repair tasks.
- Not covered by any test: no new-policy test drives a repair plan.
- Minimal fix: stamp `readyPlanIdentity(projection)` for the new repair task ids in both creators
  (new-policy only; they are only reachable after readiness), or fold them into the B2 membership rule;
  add a new-policy repair-plan → tick-dispatches test.

### N-A — NON-BLOCKING (T4 carry-forward): binding is "created while some plan was ready", not "task is in the ready plan"

Probe A continued: after readiness the Architect calls `plan_tasks` with `rogue` (ready contract ids are
`T1, T2, T3, T4, T5, T-INV`) → accepted, stamped, and `tick()` dispatches `['rogue']`. The brief allowed
a revision-digest stamp, and T4 owns the plan→task bridge / "stale ready-plan digest", so this is not
blocking for T3a — but the evidence should state plainly that admission does not check membership in
the ready plan. Fix option (b) of B2 closes it too.

### N-B — NON-BLOCKING: the N4 wiring is not covered by a test

Replacing `inspectionTools = new PlanningStateCommandGuard(` with an identity passthrough
(`native-architect-runtime.ts:313`) leaves `planning-tools.test.ts` 30/30 and
`native-architect-runtime.test.ts` 19/19 green. The N4 test constructs the guard class directly, so
the prove-red only proves the class, not that turns use it. Fix: drive a `NativeArchitectRuntime`
turn that starts ready, amends the source mid-turn (e.g. from a prior tool call), then calls
`run_evidence_command` and asserts refusal.

### N-C — NOTE

- The second-loop pre-dispatch check (`task-scheduler.ts:201`) re-tests the same projection as the
  post-await check (`:196`) — harmless redundancy.
- A stale unbound task at its attempt limit still triggers the tick's `run.paused` budget append before
  the binding skip (`:176-187`); cosmetic ordering, fold into the B2 fix.
- Carried items N2/N5/N6 were not made worse (N5: the new reconciliation entry gate additionally refuses
  steering reconciliations pre-ready, as the evidence says).

## 4. Claims checked

- sha256 of all 8 files match `T3a.md` "Repair cycle 1" (scheduler-store `db6945ce…1fd0`,
  architect-tools `80a551ec…598`, build-runtime `ec9e4751…412b`, task-scheduler `345831b8…3180`,
  native-architect-runtime `04e1cef4…39a6`, planning-tools.test `c5d9ac5a…b655`, planning-tools
  `2a7503d7…4864`, agent-prompts `f11e7063…8a58`).
- Test counts reproduced (below). Forbidden files untouched.
- Claim "A task not bound to the current ready revision id + digest is never admitted" — true, and
  that is exactly B2/B3: correctly-planned tasks and repair tasks are among the never-admitted.
- Claim that FV is safe because "the tick + task.transitioned gates still block any FV dispatch" —
  true for safety, but omits that repair tasks are blocked forever (B3).

## 5. Commands (exact counts)

Node `C:\Program Files\nodejs\node.exe .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`:

| File | tests | pass | fail |
|---|---|---|---|
| runner-v2/test/planning-tools.test.ts | 30 | 30 | 0 |
| runner-v2/test/task-scheduler.test.ts | 8 | 8 | 0 |
| runner-v2/test/replay-compatibility.test.ts | 3 | 3 | 0 |
| runner-v2/test/native-architect-runtime.test.ts (run under the N-B wiring mutation only) | 19 | 19 | 0 |
| scratch `review-scratch/t3a-r2-probe.test.mts` (A, B, C, D — assert/print observed behaviour) | 4 | 4 | 0 |

Probe output (verbatim excerpts): `A post-ready dispatched: [ 'rogue' ] rogue in contract ids? false`;
`B dispatched after R2: []`; `B replay deterministic: true`; `C bindings equal after reopen: true`;
`D steps: [{"status":"idle","action":"no_mechanical_progress"} ×3] architect calls: [] dispatched: []`.

Prove-red reproduced — N3 re-check after await (`runner-v2/src/task-scheduler.ts`, CRLF):
- BEFORE `345831b8f75e30d93996ae9fb0980b13f469acc24ad74302f539c213db3a5180` (= evidence table).
- Mutation (each needle count 1, CRLF-aware): first-loop post-await `newPolicyAdmissionClosed … return;`
  + per-task `continue`, and the pre-dispatch per-task `continue` → `if (false)`. INJECTED
  `2ffb9c7ec424965e87760032565f1a2dc8124b0bab002befae916647d859af0f`; `if (false)` present at lines
  154, 155, 167 — injection took effect.
- `--test-name-pattern="T3a repair N3"`: tests 1, pass 0, fail 1 at `planning-tools.test.ts:2272`,
  `AssertionError: running` — actual `[ 'a' ]`, expected `[]` (worker dispatched after readiness loss:
  success-side red).
- RESTORED `345831b8f75e30d93996ae9fb0980b13f469acc24ad74302f539c213db3a5180` — matches BEFORE.

N-B wiring mutation (`native-architect-runtime.ts`): BEFORE `04e1cef4…39a6`, INJECTED
`569cef72…2bcc`, suites stayed green (see table), RESTORED `04e1cef42966a4deed53be18ae7a86b887382ca9f44176e7df6f4cd3c2cf39a6` — matches.

Not run: typecheck, eslint, full suite (controller owns the importer matrix).

## 6. Verdict

B1's safety half is real (no pre-readiness task creation by tool or direct event; legacy replay
unchanged; binding replay-deterministic), and N1, N3 and N4 are fixed. The binding design breaks
liveness, though. Every task becomes permanently inadmissible after any plan revision (B2), and
verifier and final-verification repair tasks are never admissible (B3). In both cases the run idles
without waking the Architect.

T3a REVIEW r2 — REPAIR REQUIRED — 2 blocking
