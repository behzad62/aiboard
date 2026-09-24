# T3a independent review — round 3

Reviewer: independent reviewer. I am not the author: Muse wrote the code and both repair cycles, and I
have no memory of rounds 1 or 2. I edited no source or test file and committed, staged or stashed
nothing. This review is the only file I wrote in the worktree. Scratch helpers are in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-r3\` (`mutate.mjs`), outside the repo. Every
mutation was restored byte-exact; the sha256 values are below. `git status --short` after the review
matches the start: 6 modified files and 2 untracked T3a files.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`,
base `5f901354`.

## 1. Scope

1. **Requirements.** Read `t3a-brief.txt`, `t3a-repair1.txt` and `t3a-repair2.txt`, then the
   `T3a-review-r1.md` and `T3a-review-r2.md` reviews. EP23 matters most here: a change blocks admission
   only "until re-readiness". EP32 covers plan-only and ready-identity admission. EP41 covers the
   planning-state command refusal.
2. **Code.** Read the full current `git diff` of:
   - `scheduler-store.ts`, `task-scheduler.ts`, `build-runtime.ts`;
   - `architect-tools.ts`, `native-architect-runtime.ts`, `agent-prompts.ts`;
   - the cycle-2 tests in `planning-tools.test.ts` (:2297–3160).

   Also re-read these for context:
   - `dispatchStep` in full (`build-runtime.ts:678-1003`), including the order of the wake points;
   - `runArchitect`'s "typed action" rule;
   - `architectLifecycleEventMatchesReason`;
   - the T2 readiness reducer (`planning-projection.ts:802-898`). `readiness: "ready"` is set only by
     `planning.plan_ready`; every other planning event resets it to `not_ready`;
   - the `reduceSchedulerEvent` clone (`next`), and `consumeRepairCycle`, which replaces the object and
     never mutates `current`.

   I enumerated every task-writing path again (grep `tasks[...] =` / `.tasks =`) against the binding
   writes.
3. **Claims last.** Read `T3a.md` "## Repair cycle 2", then checked its hashes, its counts and one
   prove-red against the tree.

## 2. Verification of prior findings

| Item | Verdict | Evidence |
|---|---|---|
| **B2** plan revision strands every task | **Fixed** | `rebindReadyPlanTaskBindings` (`scheduler-store.ts:779-795`) runs only on `planning.plan_ready` (`:2076-2080`), after the T2 sub-reducer, on `next`. Every non-terminal task with a stale binding is re-stamped to the new ready identity. Terminal tasks and never-bound tasks are left alone. Readiness can only become `ready` through `plan_ready`, so no ready state is reachable in which a bound task is stale. Test `…re-readiness rebinds tasks… (probe B)` (:2297) covers R1 → tasks → revise R2 → ready R2: the bindings move to R2, a direct `assigned` is accepted, and tick dispatches `["a","b"]`. Prove-red reproduced below. |
| B2 deterministic on replay | **Yes** | The rebind is a pure function of the post-event projection: statuses plus the ready identity from the log. The test compares an incremental `reduceSchedulerEvent` chain with the store's projection (:2413-2418). A repeated `plan_ready` for the same revision is a no-op, because an equal binding is skipped. |
| B2 wake instead of idle | **Satisfied; the new post-tick wake is dead code (N-D)** | After `plan_required` is woken, the Architect has actionable tools: planning tools while in planning state, and `reconcile_plan` once ready. **Not-ready window:** the only reachable stale-only state is readiness lost with tasks pending. `dispatchStep` already sends that state to `plan_required` at `:770-777`, before the tick; this branch predates cycle 2. **Ready state:** `newPolicyStaleTasksRequireArchitect` (`:806-815`, wired at `build-runtime.ts:995-1001`) cannot fire. Readiness is regained only through `plan_ready`, which rebinds, and every creation path stamps. **No loop:** the wake cannot fire every step. It needs a ready plan, a tick with zero progress, and every pending non-FV task blocked, and that combination is unreachable. **Not for legacy runs:** `planningPolicyVersion !== 1` returns false. **Not for plan_only:** `dispatchStep` returns at `:798-804`, before the tick. |
| **B3** repair tasks never bound | **Fixed** | `createVerifierRepairTasks` stamps at `:4434-4440` and `createFinalVerificationRepairTasks` at `:4601-4607`, with the current ready identity. Tests `B3: verifier repair…` (:2699) and `B3: final-verification repair…` (:2868) each drive the real `*.repairs_planned` event and a real `TaskScheduler.tick()`. They assert the binding and the dispatch (`["repair-api"]`, and `["repair-browser","repair-tests"]`). Both fail without the stamp; the worker's prove-red #2 and #3 redden at the binding assert, and tick would skip the task through `newPolicyTaskAdmissionBlocked`. |
| B3 refusal before `consumeRepairCycle` | **No leak, no deadlock** | The refusal (`:4306-4313`, `:4495-4502`) throws inside the reducer. The whole event is rejected and `next` is discarded, and `consumeRepairCycle` never mutates `current` anyway, so the order is harmless either way. **Failed verdict while not ready:** the verdict is its own event (`verifier.verdict_submitted` / `final_verification.review_decided`), is not gated, and stays in the projection. While the plan is not ready, `dispatchStep` returns `plan_required` before FV/verifier advancement, and the repair tools are offered only for their own reasons, so no repair is attempted. After re-readiness, the step order raises `final_verification_repair_plan_required` / `verifier_repair_plan_required` again from the retained state. The rebind also covers repair tasks bound under an earlier revision. |
| **N-B** wiring test | **Fixed; really fails with the passthrough** | Test at :3014 runs a real `NativeArchitectRuntime` turn: it starts ready, a lifecycle tool amends the source, then `run_evidence_command` is called. Reproduced: with the review's passthrough mutation, the test goes red at :3151 (`'tool_execution_failed'` vs `'planning_state_command_refused'`). |
| N-A (true membership → T4) | Carried; **not worsened relative to pre-T3a** | The rebind is keyed on status and ignores membership. A task whose contract R2 dropped is therefore rebound and can dispatch again after R2 is ready. Before T3a, new-policy runs had no admission gate at all, so this is no worse than the baseline. It is looser than r2, but r2 deadlocked. The evidence states N-A plainly under "Not done". |
| Legacy / old logs | **Unchanged** | The rebind runs only inside the planning-event branch, which already requires `planningPolicyVersion === 1`. The wake predicate and both B3 refusals and stamps are gated on the policy. `replay-compatibility.test.ts` is not in the diff and passes 3/3. |
| No second authority | Holds | Every new read goes through `readyPlanIdentity`, which reads the T2 `planning` projection. The bindings are derived only in the reducer. |
| `tick()` never throws | Holds | `task-scheduler.ts` is byte-identical to r2 (`345831b8…3180`). |
| B1 gates, planning-state filtering, N1, N3, N4 | Hold | `architect-tools.ts`, `task-scheduler.ts`, `native-architect-runtime.ts` and `planning-tools.ts` are byte-identical to r2. The `scheduler-store.ts` cycle-2 hunks are additive only: the rebind, the predicate and the B3 blocks. `planning-tools.test.ts` is 36/36, which includes the B1, N1, N3 and N4 tests. |

## 3. New findings

### N-D — NON-BLOCKING (test attribution): "probe D" does not exercise the new post-tick wake

- Where: `planning-tools.test.ts:2427`, together with `build-runtime.ts:995-1001`.
- The test makes readiness **not ready** with a pending task and calls `step()`. That state is
  handled by the pre-existing early branch (`build-runtime.ts:770-777`), not by the new wake.
- Reproduced: I changed `if (newPolicyStaleTasksRequireArchitect(afterWorkers)) {` to
  `if (false && …)`. The test **stayed green** (1/1).
- This is not the r2 probe-D scenario either. Probe D in r2 was the ready-R2 stranding, which is now
  fixed by the rebind and covered by probe B.
- The evidence discloses this accurately ("defense-in-depth … predicate-tested, not live-step-tested").
  The wake is unreachable by construction, so no guarantee is at risk.
- Minimal fix (optional): rename the test to name the not-ready branch it actually covers, or drop the
  dead wake. Neither is needed to accept.

### NOTE

- **Rebind scope.** The rebind is intentionally status-based. After a revision, the Architect is not
  told which live tasks the new ready plan no longer contains. That is the N-A / T4 bridge, which is
  already carried.
- **N-C unchanged.** Leaving it is acceptable. The budget-pause ordering matters only for a stale
  task under an open admission gate, and that state is unreachable after the fix.
- **Carried items unchanged.** N2, N5, N6 and N-C were not made worse.

## 4. Claims checked (`T3a.md` "Repair cycle 2")

| File | sha256 (tree) | Evidence |
|---|---|---|
| scheduler-store.ts | `f7db10300eec1ce199193578e2d6779bddc3a26e515c8fdf7f3f36db0f0ac5d6` | match |
| build-runtime.ts | `b66658234b549d0eb25518187ac5172021f8eac7318301468e2d298182f109d2` | match |
| planning-tools.test.ts | `4588e0728abb8f5583d3b1b1e15500cb760883717357328856188e55c4ccd706` | match |
| native-architect-runtime.ts | `04e1cef42966a4deed53be18ae7a86b887382ca9f44176e7df6f4cd3c2cf39a6` | match (unchanged) |
| task-scheduler.ts | `345831b8f75e30d93996ae9fb0980b13f469acc24ad74302f539c213db3a5180` | match (unchanged) |
| architect-tools.ts | `80a551eccdbede43bc493c954f8d704dd1d16871ba0d80bdd2793bdaa0af9598` | match (unchanged) |
| planning-tools.ts | `2a7503d768a25662d4f43df3ff1ed80170a9a78e9cb0812296a96e8e68504864` | match (unchanged) |
| agent-prompts.ts | `f11e7063ff3a3066b4b391f7c7185e12441465366385ce838d9fbf5aa7dd8a58` | match (unchanged) |

- The design decision is sound. `BuildTask` has no contract-reference field, so membership would need
  T4's bridge; rebind is the fallback the controller sanctioned.
- The claim that the wake is "defense-in-depth, unreachable via public events" is true. See §2 and N-D.
- The claim "checked BEFORE `consumeRepairCycle` so a refusal spends no repair budget" is true, but it
  would hold even without the reorder, because a reducer throw discards `next`.

## 5. Commands (exact counts)

Node `C:\Program Files\nodejs\node.exe .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`:

| File | tests | pass | fail |
|---|---|---|---|
| runner-v2/test/planning-tools.test.ts | 36 | 36 | 0 |
| runner-v2/test/build-runtime.test.ts | 28 | 28 | 0 |
| runner-v2/test/replay-compatibility.test.ts | 3 | 3 | 0 |

Typecheck `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. ESLint and the full suite were not run;
the controller owns the importer matrix.

Prove-red reproductions. All three files are CRLF; the helper keeps the original bytes and restores
them in `finally`. Needle count was 1 each time.

1. **B2 rebind** (`scheduler-store.ts`).
   - BEFORE `f7db1030…ac5d6`.
   - Mutation: `if (event.type === "planning.plan_ready") {` → `… && false) {`. INJECTED
     `42386ddc…0b53`, so the injection changed the file.
   - `--test-name-pattern="T3a repair B2: re-readiness"`: tests 1, pass 0, fail 1 at
     `planning-tools.test.ts:2382`, `deepStrictEqual`. Actual
     `{ revisionId: 'revision_1', digest: '9d70edfe…35cc' }`, expected
     `{ revisionId: 'revision_2', digest: 'dcaa133b…209a' }`. The tasks stay stale, so admission never
     reopens.
   - RESTORED `f7db10300eec1ce199193578e2d6779bddc3a26e515c8fdf7f3f36db0f0ac5d6`: MATCH.
2. **N-B wiring** (`native-architect-runtime.ts`).
   - BEFORE `04e1cef4…39a6`.
   - Mutation: `inspectionTools = new PlanningStateCommandGuard(` → `inspectionTools = ((r, _f) => r)(`.
     INJECTED `569cef7294ac874be98ad0042a22f1867449d7f0cf5b2697bbd0bdbfe8322bcc`, which is identical to
     the r2 and worker injected hash.
   - `--test-name-pattern="T3a repair N-B"`: fail 1 at `:3151`. Actual `'tool_execution_failed'`,
     expected `'planning_state_command_refused'`. The command reached the real runtime.
   - RESTORED `04e1cef42966a4deed53be18ae7a86b887382ca9f44176e7df6f4cd3c2cf39a6`: MATCH.
3. **Wake coverage probe (N-D)** (`build-runtime.ts`).
   - BEFORE `b6665823…09d2`.
   - Mutation: `if (newPolicyStaleTasksRequireArchitect(afterWorkers)) {` → `if (false && …) {`.
     INJECTED `8b8feb46…1e30`.
   - `--test-name-pattern="T3a repair B2: a stale-only state"`: tests 1, **pass 1**, fail 0. The test
     does not cover the wake.
   - RESTORED `b66658234b549d0eb25518187ac5172021f8eac7318301468e2d298182f109d2`: MATCH.

## 6. Verdict

- **B2 is fixed.** Re-readiness rebinds the stale tasks deterministically, and admission reopens. The
  only reachable stale-only state is the not-ready window, and the Architect is woken there.
- **B3 is fixed.** Repair tasks from both creators are stamped and dispatched by the real tick. A
  refusal while the plan is not ready leaks no cycle and loses no verdict.
- **N-B is fixed** and proven red through the real runtime wiring.
- **No regressions.** Legacy runs and replay are unchanged, B1, N1, N3 and N4 still hold, and `tick()`
  is untouched.
- **Remaining finding.** N-D is non-blocking: the "probe D" test covers the pre-existing not-ready
  branch rather than the dead post-tick wake.

T3a REVIEW r3 — ACCEPT
