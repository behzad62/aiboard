# T4 independent review r3

Reviewer: independent (Claude Opus). I did not write T4 or either repair cycle. Apart from the r1 and r2 files, I have no memory of earlier rounds.

Workspace: `.worktrees/runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base `385fb66c`. T4 and repair cycles 1 and 2 are uncommitted.

I edited no source or test file in the worktree and made no commits. My probes are in `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t4-r3\`. The prove-red runs used a byte-identical scratch copy in `...\review-scratch-t4-r3\pr\`, and I restored every injected file to its original sha256.

## Scope

- **Inputs read:**
  - the briefs `t4-brief.txt`, `t4-repair1.txt` and `t4-repair2.txt`;
  - the reviews `T4-review-r1.md` and `T4-review-r2.md`;
  - the full diff (7 src files, 9 test files);
  - `evidence/T4.md` "Repair cycle 2".
- **Hashes:** all 16 sha256 values in "Repair cycle 2 / Changed-file SHA-256" match the tree exactly. `progress.md` is the controller's file and I ignored it.
- **Owner test-run rule:** I re-ran no worker-green suite. I ran only probes, plus two targeted prove-red runs in the scratch copy.
- **Harness:** every probe used the real SQLite store, the real `TaskScheduler` and an advancing clock. Where stated, it went through the real pump (`BuildRuntime.step`, `pause`/`resume`, `submitManagedUserGuidance`, `completeManagedUserGuidanceInterruption`).
- **Prior probes:** the r1 probes (`review-scratch-t4`) and r2 probes (`review-scratch-t4-r2`) were re-run as inverted checks. For the r3 copies I made two changes only:
  - I removed imports of helpers the repair deleted as dead code.
  - The R2-P5 pump probe's post-restart driver now settles (`failed`) instead of hanging. The old probe hung only because the task now dispatches into a never-settling driver, which means it was resumed.

## Verification of round-2 findings

| r2 finding | How it was verified | Result |
|---|---|---|
| **R2-B1** resume vs capacity | Probes run inverted:<br>• R2-P1 (`maxConcurrency=1` plus answered guidance) → `["G1","G1"]`<br>• R2-P2 (restart with 4 of 4 in flight and A5 ready) → A1–A4 resume and **A5 is not admitted**<br>• R2-P3 (restart, `max=1`) → `["S1"]`<br>• R2-P4 (four answered guidance questions) → 8 dispatches<br>• R2-P5 real pump after restart → S1 re-dispatched (`workers_advanced`)<br>New R3-P1: at the limit, G1 answered while A5 is ready, both in-process and after restart. Dispatch goes to G1, not A5. Active count is 4, durable in-flight count is 4, and there is no fifth.<br>The bound for new admissions stays durable (`capacityInUse` = max(active, durable assigned/running/waiting_guidance), `task-scheduler.ts:263`, `:524-537`). The resume loop is bounded by `active.size` (`:173`).<br>With the pump, `step()` awaits idle after every tick, so the resume loop can never push durable assigned/running above the bound. Concurrent `tick()` calls are serialized by `tickQueue`. Repair tasks are counted. Runner-v2 has no split mechanism. | **FIXED** (prove-red reproduced below) |
| **R2-B2** contract-less kernel repairs | Kernel repairs get a `kernel-repair:<task>` packet (`task-resource-claims.ts:316-327`), which the reducer accepts (`planning-projection.ts:2009-2013`). They also get a whole-worktree `"."` claim (`task-scheduler.ts:709-749`).<br>The restored empty-dependency test is `planning-tools.test.ts` (FV repairs with `dependencies: []`). It dispatches both repairs one after the other: the `"."` claim plus the ephemeral `shared:repair/admission` resource serialize repairs against each other and against active writers.<br>Serialization lasts only while a repair is in flight. The claim is released on submit and fenced on fail, guidance, pause or abort, so the run is not serialized forever. | **FIXED** |
| **R2-B3** reconciliation rewrite | R2-P6 inverted: `plan.reconciled` that drops D2→D1 is refused (`scheduler-store.ts:6802-6830`), and only D1 dispatches.<br>The guard sits in the single `applyPlanReconciliation` choke point, so it also covers guidance-ack `plan_reconciled`, review and critique resolutions.<br>Planned-loop admission also reads the **contract** dependencies (`currentDependencyBlock`, `task-scheduler.ts:539-553`), which is defense in depth. | **FIXED** (sibling path: N-R3-1) |
| **R2-B4** revision while waiting on guidance | R2-P7 inverted: after guidance and a `plan.reconciled` revise, the dispatches are `["W1","W1"]`. Gen 1 is `stopped_fenced` ("driver returned: guidance", recorded at `task-scheduler.ts:468-473` after the driver settled), gen 2 is `claimed` by `worker_W1_2`, and the run keeps running. | **FIXED** |
| **R2-B5** managed interruption and steering | R2-P9 inverted: `awaitIdle` resolves. The claim is `stopped_fenced` with "lifecycle aborted before outcome settlement", recorded in the `.then`/`.catch` after the driver returned (`:378-396`). The steered worker `worker_W1_1_plan_2` dispatches.<br>New R3-P6 exercises the whole flow through the **real pump**:<br>• `step` dispatches<br>• `submitManagedUserGuidance` aborts; the step returns `workers_advanced` and does not throw<br>• `completeManagedUserGuidanceInterruption`, then the Architect's `plan_reconciled` ack<br>• `step` dispatches `W1:worker_W1_1_plan_2`<br>`planning.assignment_released` is allowed under pending guidance (`scheduler-store.ts:1445`) and under an open Architect question (`:1481`).<br>`restartOwnership` treats a non-`claimed` latest claim as reassignable (`:781`); the reducer's `assertClaimSuccessor` still requires evidence on `stopped_fenced`. | **FIXED** (prove-red reproduced below) |
| **N-R2-1** project-doc seeding | `project-doc-commit.test.ts:1109` seeds with `{role:"runner", id:"integration-manager"}`. The rule is unchanged. | FIXED (the controller runs the git suite) |
| **N-R2-2** junction alias | R2-P8 inverted: J1 dispatches and the run stays `running` (skipped, not paused). The candidate path is now resolved against its allocation before the pre-check (`task-scheduler.ts:677-685`). | FIXED |
| **N-R2-3** root realpath | The root is realpath'd (`task-resource-claims.ts:101-107`). | FIXED |
| **N-R2-4** running-task revision | `materializeReadyPlanTasks` no longer rewrites dependencies of assigned/running/waiting_guidance tasks (`scheduler-store.ts:1279-1290`). Planned admission uses the contract dependencies. The regression test is weak (N-R3-4). | FIXED |
| **N-R2-5** undeclared file | Recorded as not done, with claims described as advisory. | Acceptable as recorded |
| **N-R2-6** test hygiene | The hand-built projections are gone, and the non-failing `findClaimConflict(repairClaim,[repairClaim])` is gone. `R1-B3`, which asserted the deadlock, has been replaced by `R2-B1`. Residual issues are in N-R3-4. | Mostly FIXED |
| **N-R2-7** dead code | `planClaimRevisionForFile`, `claimCoversFile`, `isForeignLiveClaim`, `reconcileClaimAfterRestart`, `resolveClaimAlias`, `CLAIM_PROTECTION`, `unknownActiveWriters` and `releaseTaskWorkspace` are removed. Residue is in N-R3-3. | Mostly FIXED |
| **N-R2-8** cancelled-claim label | Cancelled tasks are now released as `stopped_fenced` with evidence "managed interruption completed before cancellation" (`task-scheduler.ts:855-861`). R3-P4: after a steering cancel, the overlapping task K2 dispatches, so there is no leak. | FIXED |

### Regression hunt (the last cycle's deadlock risk)

| Scenario | Probe | Result |
|---|---|---|
| Restart with 4 in flight and a 5th ready | R2-P2 | 4 resume, no fifth |
| Answered guidance at the limit plus a new ready task, in-process and after restart | R3-P1 | The answered task resumes, no fifth; 4 active / 4 durable |
| Concurrent ticks | code | Serialized by `tickQueue`. The pump awaits idle after each tick. |
| Pause then resume through the real pump | R3-P7 | The step returns `paused/worker_paused` and does not throw. Gen 1 is `stopped_fenced`. After resume the same worker dispatches under gen 2. |
| Managed guidance, steering and a new worker through the real pump | R3-P6 | No crash, and the new worker dispatches |
| Crash between claim reservation and dispatch | R3-P5 | The restart reuses the reserved gen-1 claim (same deterministic worker id) and dispatches with no error or pause |
| Claim release on terminal paths | code + probes | • submitted → `released`<br>• failed, guidance and paused outcomes → `stopped_fenced` after the driver returns<br>• aborted → `stopped_fenced`<br>• integrated/cancelled → sweep<br>• R3-P4 cancel frees the overlapping claim<br>Capacity counts task status, not claims, so a leaked claim can never leak capacity. |
| Legacy runs | code | Every T4 path early-returns on `planningPolicyVersion !== 1`: `capacityInUse` falls back to `active.size`, and `restartOwnership`, `claimConflictFor`, `ensurePacketClaim`, `releasePacketClaim` and the sweep return early. Legacy `bound` is the configured maximum, and the aborted path appends nothing on legacy. The one global change is the integrated-authority actor id; r2 confirmed that real logs still replay. |
| Idempotency and replay | code | • Keys are `t4-claim:<run>:t4claim:<packet>:gen:<n>`, `t4-release:<run>:<claim>:<state>` and `assignment-claim-error:<task>:<lastSequence>`.<br>• No payload carries a timestamp. Generations derive from durable priors.<br>• The reducer does no filesystem I/O.<br>• The bridge and membership are pure functions of the post-event projection. |
| T3a/T3b/T9 | code | The T3a admission re-checks after the async gaps are intact (`:204-211`, `:298-302`, `:250`, `:326`). T9 answered runs never reach `plan_ready`, and reconciliation is refused on them first. |
| Real-git workspace | `probe-r2-ws` | Passes. It commits each task, uses a restart-equivalent manager and runs cleanup, and the project `.git/config` is untouched. The r1 `probe-ws` now fails only because the old `aiboard.taskOwner` git-config key no longer exists, which is the B1 fix. |

## New findings

### BLOCKING

None.

### NON-BLOCKING

**N-R3-1: `task.revised` (the Architect's `revise_task` tool) can still rewrite a bridged contract task's dependencies and acceptance criteria.**
- Where: `scheduler-store.ts:3556` ff. It has no guard like the one at `:6802-6830`. The payload comes from `architect-tools.ts:1575-1589`.
- Probe R3-P2: on a ready plan where D2 depends on D1, `task.revised {patch:{dependencies:[], acceptanceCriteria:[other]}}` is **accepted**. The durable D2 now has `dependencies: []` and a replaced criterion.
- Admission is **not** broken: one tick dispatches only `["D1"]`, because `currentDependencyBlock` reads the ready contract's dependencies.
- It is still the same class the R2-B3 brief closed ("contract-bound fields change only through a new ready plan revision"). The acceptance criteria can now diverge from the contract that T5 and review will read.
- Minimal fix: apply the same membership-contract guard in the `task.revised` reducer, refusing `dependencies` that differ from the contract and any `acceptanceCriteria` or `requiredCapabilities` patch.

**N-R3-2: a repair whose parent contract was dropped becomes admissible after re-readiness.** This regresses r1-N3 through a path that is now reachable.
- Where: `scheduler-store.ts:1342-1348`. At `plan_ready`, a `verification_repair` whose parent is `dropped` gets `repairParentContractId(...) === undefined` and is rebound **without** a `contractId`.
- `newPolicyTaskAdmissionBlocked` (`:1112-1117`) exempts such bindings.
- Since R2-B2, `ensurePacketClaim` (`task-scheduler.ts:709-711`) gives it a kernel `"."` claim, so the repair of a dropped contract now dispatches. Before R2-B2 the claim threw.
- r2 marked N3 fixed on the strength of a hand-built projection test, which has since been removed. The same rebind code was present in r2.
- Not reproduced by probe: seeding a verifier/FV repair and then a re-ready plan revision that drops its already-integrated parent is heavy. This finding is from code inspection.
- Precondition (rare): a later revision drops a contract after its verification repair exists.
- Minimal fix: in the rebind, keep the old `contractId` when the parent is `dropped`, so membership stays `dropped` and the task is surfaced. Only contract-less-from-birth repairs should rebind without a `contractId`.

**N-R3-3: residual dead code and stale comments.**
- `task-graph.ts:193` `dependencyBlockReason` has no src caller (test-only).
- `workspace-manager.ts:160`: the doc comment for the deleted `releaseTaskWorkspace` now sits above `commitTask`, and `TaskWorkspaceOwner.active` is never read.
- `task-scheduler.ts:869-872`: the `unknownActiveWriters` comment now sits above `transition`.
- `task-scheduler.ts:804-809`: the "best-effort release" comment sits above `recordAssignmentClaimFailure`.
- `task-scheduler.ts:696-698` still says repair tasks "carry no durable packet claim … checked ephemerally", which is false since R2-B2.

**N-R3-4: test hygiene.**
- `R2-N4` claims to test "a dependency added to a running task", but the revision adds the dependency to **R2** (planned) while it asserts on R1. It never exercises the named case.
- `R2-B5` sets the private `lifecycleSignal` through a cast instead of the constructor option, and it is scheduler-level only. R3-P6 shows the pump path works.
- The FV/verifier repair dispatch tests in `planning-tools.test.ts` run on `MemorySchedulerStore`, not SQLite.

**N-R3-5: competing live controllers are not refused (procedural only). The evidence should say so.**
- Probe R3-P3: a second `TaskScheduler` on the same store re-dispatches C1 while the first controller still holds it. That gives two writers with the same worker id and the same claim.
- The cause is the R1-B2/R2-B1 same-owner resume rule. Durable state cannot tell a restart from a second live process.
- There is no run-level lease or lock in runner-v2.
- r1 (N8) accepted the "procedural-single-controller" label. That label remains truthful, but brief item 2 says "refuse competing controllers". The evidence should state plainly that two live runner processes on one state store are **not** refused.
- A run-level lease is the real fix, and it is out of T4 scope.

### NOTE

- `materializeReadyPlanTasks` throws when a later revision's contract id equals an existing kernel repair id (`scheduler-store.ts:1276`), which makes the `plan_ready` append fail. It also silently adopts a pre-existing rogue task whose id equals a newly added contract id, keeping the rogue task's objective and criteria.
- Kernel-repair claims use `acceptedBaseRevision` "kernel repair base" when no allocation baseline is known, so that binding is nominal.
- A claim that leaks through a hard crash inside the synchronous claim→assigned window, on a task that is later dropped rather than cancelled, would keep blocking overlapping files. Capacity is unaffected.
- On a `failed` scheduler run (context-recording abort), the release append is refused ("terminal Build cannot accept planning events"). That rejects the worker promise, but `task.transitioned` already rejected there before T4, so this is not new.

## Prove-red reproduced (scratch copy, final files)

| Guard | File | sha256 before | Injection | sha256 injected | Red (exact) | sha256 after restore | Green after |
|---|---|---|---|---|---|---|---|
| R2-B1 resume ignores its own slot | `pr/runner-v2/src/task-scheduler.ts` | `0f4d0148…1012b` (= tree) | `:173` `if (this.active.size >= bound) break;` → `if (this.capacityInUse(projection) >= bound) break;` (1 line, diff-verified) | `58eae95a…e379` | `R2-B1 resume ignores its existing slot…` at `task-resource-claims.test.ts:1384`: `actual: []`, `expected: ['A1','A2','A3','A4']`. `R2-B1 real pump…` times out in `waitFor` (`:1592`). 2/2 fail. | `0f4d0148…1012b` | 2/2 pass |
| R2-B5 release allowed under pending guidance | `pr/runner-v2/src/scheduler-store.ts` | `6b244f88…56da` (= tree) | `:1445` `event.type === "planning.assignment_released" ||` → `false ||` (1 line, diff-verified) | `529e9d7d…520f` | `R2-B5 managed interruption…` fails at `:1511` (`await scheduler.awaitIdle()`) with `Pending user guidance must be acknowledged before planning.assignment_released may advance the run.` 1/1 fail. | `6b244f88…56da` | 1/1 pass |

Both are consistent with the worker's recorded prove-red rows for the same guards (same before-hashes).

## Commands and exact counts

Every command was `C:\Program Files\nodejs\node.exe .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 --test-reporter=spec <file>`, run from the worktree (or from `pr\` for the scratch runs).

| File | Tests | Pass | Fail | Meaning |
|---|---:|---:|---:|---|
| r1 `probe-sched` | 4 | 3 | 1 | PROBE-1, 2 and 4 are green. The PROBE-3 "failure" is the refusal `reuses a bridged ready-plan contract id`, which is the B5 fix working. |
| r1 `probe-reject` | 1 | 1 | 0 | PROBE-5: re-dispatch at gen 2 |
| r1 `probe-revdeps` | 1 | 1 | 0 | PROBE-6: the B7 dependency is enforced |
| r1 `probe-ws` (real git) | 1 | 0 | 1 | The probe reads the removed git-config key; the absence of that key is the B1 fix |
| r2 `probe-r2-sched` (P1–P4) | 4 | 4 | 0 | R2-B1 fixed |
| r2 `probe-r2-pump` (P5, driver settles) | 1 | 1 | 0 | R2-B1 through the real pump |
| r2 `probe-r2-mut` (P6, P7) | 2 | 2 | 0 | R2-B3 and R2-B4 fixed |
| r2 `probe-r2-steer` (P9) | 1 | 1 | 0 | R2-B5 fixed |
| r2 `probe-r2-steer2` (P10) | 1 | 0 | 1 | Probe artifact: its manual fence finds no live claim because the abort path already fenced it (`TypeError … reading 'claim'`) |
| r2 `probe-r2-alias` (P8) | 1 | 1 | 0 | N-R2-2 fixed (skip, no pause) |
| r2 `probe-r2-ws` (real git) | 1 | 1 | 0 | B1 holds |
| r3 `probe-r3` (P1–P7) | 7 | 7 | 0 | P1 (limit plus guidance plus restart), P4 (cancel frees the claim), P5 (crash window), P6 (pump steering), P7 (pump pause/resume) all pass. P2 records N-R3-1 and P3 records N-R3-5; both log-only, no dual admission in P2. |
| scratch `task-resource-claims.test.ts --test-name-pattern=R2-B1`, injected / restored | 2 / 2 | 0 / 2 | 2 / 0 | Prove-red R2-B1 |
| scratch `task-resource-claims.test.ts --test-name-pattern=R2-B5`, injected / restored | 1 / 1 | 0 / 1 | 1 / 0 | Prove-red R2-B5 |

I did not re-run any worker-green suite. The sandbox-blocked process/git suites (`final-verification-browser`, `-cleanup`, `-profile`, `-runtime-b1`, `-runtime`, `project-doc-commit`, `workspace-manager`) remain for the controller.

## Verdict

T4 REVIEW r3 — ACCEPT
