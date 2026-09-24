# T4 independent review r2

Reviewer: independent (Claude Opus). I did not write T4 or its repair, and I carry no memory of r1 beyond the r1 file.
Workspace: `.worktrees/runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base `385fb66c`, T4 plus repair cycle 1 uncommitted.
I edited no source or test file in the worktree and made no commits. Probes are in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t4-r2\`. Root-cause checks and the prove-red ran in a byte-identical
scratch copy (`...\review-scratch-t4-r2\pr\`), and each file was restored to its original sha256.

## Scope

- Inputs read: brief `t4-brief.txt`, repair brief `t4-repair1.txt` (lanes ≠ phases is binding), `T4-review-r1.md`, the full diff, and `evidence/T4.md` "Repair cycle 1".
- Diff files: `build-runtime.ts`, `planning-projection.ts`, `scheduler-store.ts`, `task-graph.ts`, `task-scheduler.ts`, `workspace-manager.ts`, the new `task-resource-claims.ts` and its test, and the edited tests (`planning-tools`, `planning-review`, `planning-state`, `scheduler-store`, `task-graph`, `workspace-manager`, fixture).
- Hashes: all 15 sha256 values in "Repair cycle 1 / Changed-file SHA-256" match the tree exactly.
- Channels probed:
  - tool / direct events: `plan.created`, `plan.reconciled`, `user.guidance_acknowledged` (plan_reconciled), `task.transitioned`;
  - replay from another cwd;
  - restart on the same SQLite file;
  - pause/resume, answered worker guidance, managed user-guidance interruption (lifecycle abort);
  - the real pump (`BuildRuntime.step`).
- Every probe used the real SQLite store, the real `TaskScheduler`, and an advancing clock.

## Controller result folded in (outside sandbox)

The controller ran 37 files / 484 tests: 482 pass, 2 fail. Both failures are in `project-doc-commit.test.ts` (:177, :225): `Only the integration authority may transition a task to integrated.` My classification (N-R2-1 below) is that the tests seed through a now-forbidden shortcut; the rule is not a replay break for real logs.
- `workspace-manager` and the five final-verification suites pass outside the sandbox. B1 is confirmed fixed on those suites.
- Root `tsc` exits 0.

## Verification of round-1 findings

| r1 | Claim in repair evidence | Verified how | Result |
|---|---|---|---|
| B1 workspace ownership | Owner ledger in `stateDirectory/workspace-owners/<run>.json`; no git config | `probe-r2-ws` (real git): 3 task worktrees; commit task-a and task-b; a new manager instance (restart-equivalent) commits task-c; a second writer on task-a's worktree is refused `already owned by task task-a`; `cleanup()` succeeds; project `.git/config` is byte-identical before and after, with no `aiboard` key. Controller confirms that `workspace-manager.test.ts` passes. | **FIXED** |
| B2 same-owner resume, no `running` forever | `restartOwnership` resumes the same worker; lifecycle abort → `stopped_fenced` | Single task at `maxConcurrency=4`: answered guidance resumes (round-1 PROBE-1 now green), and pause/resume resumes. **But** at capacity, nothing resumes: `maxConcurrency=1` plus answered guidance (R2-P1); restart at 4/4 (R2-P2); restart at `maxConcurrency=1` (R2-P3); four answered guidance questions (R2-P4); real pump after restart (R2-P5 `idle / no_mechanical_progress` forever, task `running`). The managed user-guidance abort crashes the pump, and a steered writer never takes over, even with fencing proof (R2-P9/P10). | **NOT FIXED** → R2-B1, R2-B4, R2-B5 |
| B3 durable capacity | `capacityInUse` counts durable assigned/running/waiting_guidance | R2-P2: after restart with 4 in flight, A5 is not admitted (bound holds). Repair tasks are counted. No split-task mechanism exists in runner-v2 (`split_task` has no src hits). The fix counts the task being resumed against its own slot, which causes R2-B1. | **Bound FIXED; introduces deadlock (R2-B1)** |
| B4 released → next generation | `assertClaimSuccessor` accepts `released`/`stopped_fenced`; release after durable submit; errors → console + `run.paused` | Round-1 PROBE-5: failed → planned re-dispatches at gen 2. Worker test R1-B4 covers rejected → planned. Errors are surfaced (`recordAssignmentClaimFailure` → `run.paused {reason: assignment_claim_error}`), not swallowed. But see R2-B2/R2-B3: when the claim is structurally impossible, the surfaced error re-pauses the run on every resume. | **FIXED** (surfacing now exposes R2-B2/R2-B4) |
| B5 post-ready mutation | `plan.created` refuses contract-id reuse and `integrated`; `integrated` only from `integration-manager` | Round-1 PROBE-3 is now refused at append. I reproduced the prove-red myself (below). **`plan.reconciled` (and `user.guidance_acknowledged` plan_reconciled) still rewrites a bridged contract task's `dependencies`**: R2-P6 dispatches `["D1","D2"]` although the current ready contract says D2 depends on D1. | **PARTIAL** → R2-B3 |
| B6 pure reducer, root-relative paths | Reducer compares recorded paths lexically; `resolveClaimPathAgainstRoot` at claim time | Round-1 PROBE-4 is now green: the directory claim blocks the file inside it, and replay after `chdir(tmpdir())` gives no error and the same projection. `planning-projection.ts` calls `findClaimConflict` with the default lexical resolver, with no fs access. | **FIXED** (see N-R2-2, N-R2-3) |
| B7 revised deps applied | `materializeReadyPlanTasks` refreshes non-terminal member deps | Round-1 PROBE-6 is now green: E2 gets `["E1"]` and only E1 dispatches. | **FIXED** (in-flight edge: N-R2-4) |
| N1 unknown writer with workspace path | `"."` file claim | Code at `task-scheduler.ts` `activeWriterClaims`: a contract-less active writer claims `"."`. | FIXED |
| N2 stop-evidence label | `driver returned: …` | Code | FIXED |
| N3 dropped-parent repair | `newPolicyTaskAdmissionBlocked` uses the parent `contractId` | The test (R1-N3) still hand-builds the projection | FIXED (test hygiene N-R2-6) |
| N4 lane ≠ phase | Equality rule removed | `planning-projection.ts:2005-2025`: the rule is gone. Test R1-N4. | FIXED |
| N6 T3a N3 arms | Restored with `amended === true` | Diff of `planning-tools.test.ts` ~2146-2222 | FIXED |
| N7 `claimRevisionForFile` | Removed and recorded as not done | See N-R2-5 | Acceptable (not a deadlock) |
| Test hygiene | Header fixed, advancing clock | The header is accurate and `schedulerFor` advances. Hand-built projections remain, `findClaimConflict(repairClaim,[repairClaim])` cannot fail, and R1-B3 asserts the deadlock as expected behavior | **NOT FIXED** → N-R2-6 |

## New findings

### BLOCKING

**R2-B1: capacity counts the task being resumed, so an in-flight new-policy task cannot resume at capacity.**
- Where: `task-scheduler.ts:173`. The first (resume) loop breaks on `capacityInUse(...) >= bound`, and `capacityInUse` (`:501`) counts every durable assigned/running/waiting_guidance task, including the one about to be resumed. Resuming does not add a writer.
- Effect: the run stays `running` forever whenever the durable in-flight count reaches the bound. Every case below is a real SQLite probe that fails with nothing re-dispatched:
  - R2-P1: `maxConcurrency=1` and one answered blocking guidance question. Dispatches stay `["G1"]`.
  - R2-P2: process restart with 4/4 in flight. After restart dispatches are `[]`. A1-A4 are `running` with live claims and never resume.
  - R2-P3: restart with `maxConcurrency=1` and one task. Dispatches `[]`.
  - R2-P4: four workers all ask guidance and all are answered, with no restart. Dispatches stay at 4, not 8.
  - R2-P5: real pump. After restart, `BuildRuntime.step()` returns `{status:"idle", action:"no_mechanical_progress"}` three times, the Architect is never called, and S1 stays `running`.
- Why the suite missed it: the worker's own test `R1-B3` asserts `recoveredDriver.assignments == []`, which encodes this deadlock as the expected result.
- Root cause confirmed in the scratch copy. With `:173` changed to `if (this.active.size >= bound) break;` (sha `5b5162d5…` → `a3239c30…`, then restored to `5b5162d5…`):
  - R2-P1 through R2-P4 all pass;
  - R2-P2 re-dispatches exactly A1-A4, and A5 is still not admitted (the bound holds in the planned-task loop).
- Minimal fix:
  - The resume loop must not count the resumed task against its own slot, for example by gating that loop on `active.size`.
  - Keep the durable count for new admissions only.
  - Invert `R1-B3` to expect the four same-owner resumes and no fifth task.

**R2-B2: final-verification repair tasks whose dependencies do not map to a contract can never dispatch; the run re-pauses on every resume.**
- Where: `task-scheduler.ts:653-662` (`ensurePacketClaim` throws `has no ready contract to claim`) with `scheduler-store.ts:1113` (admission exempts `verification_repair` bindings without a `contractId`).
- `createFinalVerificationRepairTasks` accepts `dependencies: []`: the tool schema (`architect-tools.ts:646`) has no `minItems`, and an empty list is natural after full integration. `repairParentContractId` then returns undefined.
- The tick therefore admits the repair, fails the claim, and appends `run.paused {reason:"assignment_claim_error"}`. Each resume repeats this.
- Probe FVPROBE: a scratch copy of the T3a B3 final-verification repair test with `dependencies: []`. Dispatched `[]`, run `paused`, `pauseReason.taskId = repair-browser`. Before T4 these repairs dispatched (identity-bound exemption).
- This regresses the T3a/T9 repair loop. The worker's version of the test was changed to `dependencies: ["T1"]` / `["T3"]` (it was `["implementation-one"]` before), so it no longer covers the empty case.
- The doc comment on `ensurePacketClaim` says repair tasks "carry no durable packet claim … checked ephemerally", which the code contradicts.
- Minimal fix (pick one):
  - Give contract-less kernel repairs an ephemeral scheduler claim (worktree plus the `shared:repair/admission` resource, as `schedulerTaskWriteClaim` already builds) and skip the durable packet claim.
  - Bind them to a synthetic repair packet the reducer accepts.

**R2-B3: B5 is only half closed. `plan.reconciled` still rewrites a bridged contract task's dependencies, so an incomplete dependency is dual-admitted.**
- Where: `scheduler-store.ts:6885-6890`. `applyPlanReconciliation` applies `taskUpdates[].dependencies` (and objective/criteria) to any planned/failed/rejected/waiting_guidance task, including bridged contract tasks.
- The admission path reads `task.dependencies` (`readyTaskIds`, `dependencyBlockReason`), not the current contract.
- Probe R2-P6: ready plan D1 and D2 (D2 depends on D1). `plan.reconciled {taskUpdates:[{taskId:"D2", action:"revise", dependencies:[]}]}` is accepted. One tick dispatches `["D1","D2"]`.
- The same reducer runs for `user.guidance_acknowledged` plan_reconciled and review/critique resolutions.
- The repair brief named reconciliation explicitly ("plan_tasks / plan.created / reconciliation must not overwrite").
- Minimal fix (pick one):
  - On a ready new-policy run, refuse reconciliation updates to contract-bound tasks that change `dependencies` (and other contract-derived fields); contract changes go through `planning.plan_revised` → re-readiness.
  - Derive new-policy dependency eligibility from the current ready contract rather than `task.dependencies`.

**R2-B4: after worker guidance, an Architect revision of the waiting task leaves the old claim live, and the fresh attempt is refused forever.**
- Where: `task-scheduler.ts:450` (a guidance outcome records nothing on the claim) and `scheduler-store.ts:6898` (`waiting_guidance` → `planned` on reconciliation).
- The next dispatch uses `standardWorkerId(task, attempt+1)` = `worker_W1_2`. `ensurePacketClaim` finds the live gen-1 claim owned by `worker_W1_1` and throws `owned by another writer`, which pauses the run with `assignment_claim_error`. It repeats on every resume.
- The prior writer has provably returned: its driver promise settled with the guidance outcome.
- Probe R2-P7: dispatch → guidance → `plan.reconciled` revise W1 → 3 ticks. Dispatches `["W1"]`, run `paused`, claim `t4claim:W1:gen:1 claimed`.
- Minimal fix: when a worker settles with a guidance outcome, record `stopped_fenced` ("driver returned: guidance") so either same-owner resume or a new attempt can take the next generation. Alternatively, release it at the `waiting_guidance → planned` transition.

**R2-B5: managed user-guidance interruption crashes the pump on new-policy runs, and a steered (different) writer can never take over even with stopped/fenced proof.**
- (a) Crash. `BuildRuntime.submitManagedUserGuidance` (`build-runtime.ts:669-693`) appends `user.guidance_submitted` and then aborts the lifecycle. The aborted worker path (`task-scheduler.ts:360-376`) appends `planning.assignment_released`. The pending-guidance gate (`scheduler-store.ts:1423-1453`) refuses it (`Pending user guidance must be acknowledged before planning.assignment_released may advance the run.`). The `.catch` retries the same append, so the operation rejects and `awaitIdle()` rejects inside `step()`. Before T4 the aborted path appended nothing.
- (b) Stuck. The Architect's plan_reconciled acknowledgement moves the running task to `assigned` with `worker_W1_1_plan_2`. `restartOwnership` (`task-scheduler.ts:717-742`) resumes only when the claim is live with the same worker, or when the latest claim is the same worker's. A released or `stopped_fenced` claim from a different worker falls through to `!live` → "unknown running writer", and the task is skipped silently forever.
- Probe R2-P9: `awaitIdle REJECTED: Pending user guidance must be acknowledged before planning.assignment_released…`. Claim still `claimed`. After steering the task is `assigned`, and dispatches stay `["W1"]`.
- Probe R2-P10: the same flow with an explicit `stopped_fenced` release recorded after acknowledgement. The claim is `stopped_fenced` with evidence, and the task still never dispatches. This contradicts r1-B2's requirement that a different writer may take over with stopped/fenced proof.
- Minimal fix:
  - Allow the claim-release event under pending guidance (it is a fencing fact, like `integration.revision_advanced`), or record the fence where the abort is issued.
  - In `restartOwnership`, treat a latest claim in `released` state, or `stopped_fenced` state with evidence, as reassignable to any worker id (the reducer's `assertClaimSuccessor` already enforces the rule).
  - Record a durable blocked reason instead of the silent `continue` at `:187`.

### NON-BLOCKING

- **N-R2-1** (controller's 2 `project-doc-commit` failures). The rule at `scheduler-store.ts:7676-7686` is not policy-gated, so it applies to legacy runs too. It does not break replay of real logs: the only production writer of `integrated`/`integration_resolution` transitions is `build-runtime.ts:987-1000`, actor `{role:"runner", id:"integration-manager"}`, unchanged since build-runtime was introduced (`90d70179`, git log -S). Pre-T4 real logs therefore replay. The failing tests seed with `runner()` = `{role:"runner", id:"build-runtime"}` (`project-doc-commit.test.ts:1104`), a shortcut the new rule forbids.
  - Classification: tests seed through a now-forbidden shortcut. Fix: seed with the integration-manager actor, as `planning-tools.test.ts` now does. The suite must be green before acceptance.
  - Note: the actor id is self-declared, so this is defense in depth, not authentication.
- **N-R2-2** (probe R2-P8, junction alias). The scheduler pre-check (`claimConflictFor`) compares LEXICAL candidate paths with the actives' RECORDED resolved paths, so `srcalias/x.ts` (a junction to `src/`) passes the pre-check. The reducer then refuses the claim (no dual admission, which is good), but the refusal becomes `run.paused` for the whole run instead of a clean skip. Fix: resolve the candidate against its allocation before the pre-check.
- **N-R2-3** `resolveClaimPathAgainstRoot` (`task-resource-claims.ts:113-121`) compares `realpath(candidate)` with the un-realpath'd root. With a symlinked worktree root, every recorded path becomes absolute per worktree, and cross-task overlaps disappear. This is unreachable today, because `WorkspaceManager.assertOwnedWorkspace` requires the git toplevel to equal the path. Realpath the root anyway.
- **N-R2-4** B7 edge: `materializeReadyPlanTasks` also rewrites dependencies of in-flight (running) tasks. An in-process worker continues despite the new unmet dependency. After a restart the resume loop skips the task (`:182`) while its live claim can block the dependency, which is a possible deadlock on overlapping claims. Also, `dependencyBlockReason` at `:182` is not policy-gated, which is a small legacy behavior change for steering-revised running tasks. Reject (or fence and requeue) revisions that add dependencies to in-flight tasks.
- **N-R2-5** Undeclared-file routing is not wired, and that is recorded as not done. `writableSurfaces` are enforced nowhere in worker tools (only three src files mention them), so a worker needing an undeclared file is not deadlocked: it can write it, or ask guidance and let the Architect revise the plan. The claim is therefore advisory for undeclared files, and integration conflict detection is the backstop. Acceptable as recorded; say so in the evidence.
- **N-R2-6** Test hygiene is still open:
  - "kernel repair tasks stay admissible" (`:906`), "stale ready-plan digest" (`:957`) and "R1-N3" (`:1170`) hand-build projections;
  - `findClaimConflict(repairClaim, [repairClaim])` (`:949`) cannot fail;
  - R1-B3 asserts the R2-B1 deadlock as expected;
  - R1-B2 exercises the scheduler only, not the pump, and only at `maxConcurrency` 4 with one task.
- **N-R2-7** Code with no src caller:
  - `planClaimRevisionForFile`, `claimCoversFile`, `isForeignLiveClaim`, `reconcileClaimAfterRestart`, `resolveClaimAlias`, `CLAIM_PROTECTION`, `unknownActiveWriters` (test-only);
  - `WorkspaceManager.releaseTaskWorkspace`, which is never called, and `createTaskWorkspace` ignores `active:false` anyway.
- **N-R2-8** `releaseTerminalPacketClaims` releases a cancelled task's claim as `released` rather than `stopped_fenced`. That is safe only because the managed interruption stops writers before acknowledgement. Label it that way.

### NOTE

- Idempotency keys are deterministic, and no idempotent payload carries a timestamp:
  - `t4-claim:<run>:t4claim:<packet>:gen:<n>`;
  - `t4-release:<run>:<claim>:<state>`;
  - `assignment-claim-error:<task>:<lastSequence>`.
- The generation derives from durable priors, so nothing resets.
- T9 answered runs never reach `plan_ready`, so there is no bridge on them. The T3a admission gates and re-checks after the async gap are intact.

## Prove-red reproduced (worker's B5, final file, scratch copy)

- File: `pr/runner-v2/src/scheduler-store.ts`.
- Injection: `        if (reusedContract) {` → `        if (false && reusedContract) {`. The pattern occurs exactly once.
- sha256: before `2ce034fd…9dec` (matches the tree), injected `696bf3cc…4dc7`, after restore `2ce034fd…9dec`.
- Red: `R1-B5 post-ready plan events cannot overwrite contract tasks or forge integration` fails at `task-resource-claims.test.ts:1354` with `Missing expected exception … expected: /reuses a bridged ready-plan contract id/`. It is green again after the restore.

## Commands and exact counts

All commands used `C:\Program Files\nodejs\node.exe .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1`.

| Command | Tests | Pass | Fail | Meaning |
|---|---:|---:|---:|---|
| r1 `probe-sched`, `probe-reject`, `probe-revdeps` (worktree) | 6 | 5 | 1 | PROBE-1, 2, 4, 5, 6 green. PROBE-3 "fails" only because the append is now refused, which is the B5 fix working |
| `probe-r2-sched.test.ts` (R2-P1..P4) | 4 | 0 | 4 | R2-B1 reproduced |
| Same probes against the scratch copy with the `:173` one-line change | 4 | 4 | 0 | R2-B1 root cause confirmed (scratch restored to `5b5162d5…`) |
| `probe-r2-pump.test.ts` (R2-P5, real `BuildRuntime.step`) | 1 | 0 | 1 | R2-B1 through the pump |
| `planning-tools-fvprobe.test.ts --test-name-pattern=FVPROBE` (scratch) | 1 | 0 | 1 | R2-B2 |
| `probe-r2-mut.test.ts` (R2-P6, R2-P7) | 2 | 0 | 2 | R2-B3, R2-B4 |
| `probe-r2-steer.test.ts` (R2-P9) | 1 | 0 | 1 | R2-B5 (a)+(b) |
| `probe-r2-steer2.test.ts` (R2-P10) | 1 | 0 | 1 | R2-B5 (b) with fencing proof |
| `probe-r2-alias.test.ts` (R2-P8) | 1 | 0 | 1 | N-R2-2 (run paused; no dual admission) |
| `probe-r2-ws.test.ts` (real git) | 1 | 1 | 0 | B1 fixed |
| Scratch `task-resource-claims.test.ts --test-name-pattern=R1-B5`, injected | 1 | 0 | 1 | Prove-red |
| Same, restored | 1 | 1 | 0 | Restore verified |

I did not re-run any suite the worker ran green (owner rule). All 15 evidence sha256 values match the tree.

## Verdict

T4 REVIEW r2 — REPAIR REQUIRED — 5 blocking
