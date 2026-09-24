# T4 independent review r1

Reviewer: independent (Claude Opus); did not write T4. Workers: Muse (started), MiMo (finished).
Workspace: `.worktrees/runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base `385fb66c`, T4 uncommitted.
No source/test file in the worktree was edited. Probes live in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t4\` (outside the repo). Prove-red ran in a
byte-identical scratch copy (`...\review-scratch-t4\pr\`; sha256 of the copied files matched the tree
before injection).

## Scope reviewed

- Brief `t4-brief.txt` (+ MiMo note), plan sections 2, 3, 4, 5.0 (G-5), T4 in full, §6 EP08/EP11/EP12/EP13, progress.md
  carry-forwards N-A and the T4 bridge.
- Full diff: `build-runtime.ts`, `planning-projection.ts`, `scheduler-store.ts`, `task-graph.ts`, `task-scheduler.ts`,
  `workspace-manager.ts`, new `task-resource-claims.ts` and its test, and the edited tests (`planning-tools`, `planning-review`,
  `planning-state`, `task-graph`, `workspace-manager`, fixture `planning-source-fixture.ts`).
- Evidence `evidence/T4.md`.

## Requirement checklist (must / must-not)

| # | Requirement | Result |
|---|---|---|
| R1 | Bridge: ready contracts become kernel scheduler tasks, deterministic ids = contract ids, replay-safe | PARTIAL: tasks materialize at `plan_ready` (id = contract id). But existing tasks keep stale dependencies after a revision (B7), and a post-ready `plan.created` can overwrite a bridged task (B5) |
| R2 | True membership: admissible only if the CURRENT ready revision contains the contract; a dropped contract is non-admissible and surfaced | MET for the drop case (`taskPlanMembership`, `droppedReadyContractTasks`, stale wake). Prove-red reproduced |
| R3 | Post-ready rogue `plan_tasks` not admitted | MET for new ids. BROKEN when the rogue call reuses a contract id (B5) |
| R4 | Kernel repair tasks (verifier + final-verification) stay admissible | MET (exempted by kind). See N3: they stay admissible even when the parent contract was dropped |
| R5 | T3a rebind rule replaced consistently | MET (`rebindMemberTasksToReadyPlan`). N6: the T3a N3 regression test arms were neutered |
| R6 | MAX_WORKERS = 4, bounded by configured maximum and actual capacity; a fifth never admitted (including restart) | BROKEN on restart (B3). The bound counts only in-process promises |
| R7 | Legacy capacity unchanged | MET in the scheduler. Legacy runs are still regressed by the workspace-manager change (B1) |
| R8 | Claims: atomic reservation before dispatch; overlapping or aliased paths; shared surfaces; semantic resources | PARTIAL: lexical case, separator, `..` and drive-letter handling works. Alias resolution depends on the process cwd and filesystem state, and it runs inside a reducer (B6) |
| R9 | Claims bound to packet/lane, worker/session, base, branch/worktree | MET on first claim. Lane is conflated with phase (N4) |
| R10 | Release only on proven completion or fencing; a caller ending does not free an unconfirmed claim | MET that nothing frees on abort. But a released claim can never be followed by a new generation (B4) |
| R11 | Restart reconciliation with authenticated ownership; ambiguous writer blocks reassignment; the run does not deadlock | BROKEN: every live claim blocks forever, including the same owner's own resume after guidance or pause, with no path to record fencing (B2) |
| R12 | Undeclared file routes to replan / claim revision | MET as an API (`claimRevisionForFile`). No pump or worker wiring (N7) |
| R13 | Workspace: no two writers in one worktree | Scheduler-level check MET. WorkspaceManager ownership is broken (B1) |
| R14 | Durable events: deterministic idempotency keys, no timestamps in payloads, no resetting counters | MET (`t4-claim:<run>:t4claim:<packet>:gen:<n>`; the generation comes from durable priors). Reducer is not pure (B6) |
| R15 | Replay compatibility | NOTE N5 (unshipped T3-era logs); B6 makes replay depend on cwd |
| R16 | Evidence accurate | NOT MET: the 11 workspace-manager failures are attributed to the sandbox but include a real defect (B1). The scheduler-store prove-red sha does not match the final file (N8) |

## Findings

### BLOCKING

**B1 — WorkspaceManager ownership breaks commit and cleanup for every run, including legacy runs, and writes the user repository's `.git/config`.**
`workspace-manager.ts:140-146` writes `git config --local aiboard.taskOwner <taskId>`. In a linked worktree, `--local` is the
repository's common config, so every task worktree shares one value and the last-created task wins.
`assertWorkspaceTaskOwner` (`:417-439`) is called from `assertOwnedWorkspace` (`:455-457`). It is reached through
`commitTask`, `ensureWorkspace` (`:382`), `commitWorkspace` (`:183`) and `cleanup` (`:278`).
- `cleanup()` builds `workspace.taskId = workspaceSegment` (`:205-213`), which never equals the recorded real task id. So cleanup throws for any existing task worktree, including single-task runs.
- Probe `probe-ws.test.ts` (real git): after creating task-a then task-b, the project `.git/config` holds `aiboard.taskOwner = "task-b"`, and task-a's worktree reads `task-b`.
  - `commitTask("task-a")` throws `...task-a-37bbbbed5f is owned by task task-b; no two writers share one worktree.`
  - `cleanup()` throws the same error.
- The existing suite test `task worktrees isolate concurrent edits and create attributable commits` fails outside any sandbox with `...task-alpha-... is owned by task ../../task beta`. The evidence's "11 sandbox failures" includes this real defect.
- Production path: `native-build-factory.ts:1348` (`createTaskWorkspace` per task/attempt) and `:625`/`:1525` (`cleanup`). Legacy runs are affected too, because the change is not gated on policy.
- The change also mutates the user's project repository config, against §2.3 ("Runner state remains outside the project").
- Minimal fix: drop the git-config owner record. Keep exclusive ownership in runner state, for example a record in `stateDirectory` keyed by the resolved worktree path, or rely on the durable scheduler claim. Never check the owner against `workspaceSegment` in `cleanup`. Treat a missing owner on a pre-T4 worktree as reconcilable, not as a throw on the normal commit path.

**B2 — New-policy tasks that are assigned or running without an in-process promise are never resumed. The run deadlocks after blocking guidance, pause/resume, or a restart.**
`task-scheduler.ts:188` calls `restartOwnership` (`:634-662`) for every assigned/running task that is not in `active`.
`reconcileClaimAfterRestart` (`task-resource-claims.ts:379-404`) returns `block_reassignment` for every `claimed` claim:
- the live writer case;
- the unknown-liveness case;
- the caller-ended case.

Only `released`/`stopped_fenced` claims resume, but `livePacketAssignment` only returns `claimed` ones. Nothing ever records `stopped_fenced` for such a claim: the only producer of `planning.assignment_released` is `recordOutcome`, and there is no runner, Architect or owner path.
- Probe PROBE-1 (real SQLite, real `TaskScheduler`, advancing clock, no restart): G1 dispatched, worker returns blocking guidance, then the Architect answers. The task goes `running`, the claim `t4claim:G1:gen:1` stays `claimed` by `worker_G1_1`, and after two ticks dispatches are still `["G1"]`. The task is never resumed; before T4 the first loop re-dispatched it.
- The same path hits `paused` outcomes and every process restart. The worker's own restart test (`task-resource-claims.test.ts:686-752`) asserts this hang as the expected behavior.
- The same controller resuming its own worker id for the same attempt is a resume, not a reassignment. T4 says ambiguity blocks *reassignment*, and that proof must be obtainable.
- Minimal fix:
  - Resume when the live claim's worker/session, attempt and worktree match the task's durable assignment and this controller holds the run.
  - For an ambiguous restart, fence the prior session (the lifecycle abort already exists), record `stopped_fenced` with evidence, then re-dispatch at the next generation.
  - Surface a durable blocked reason, not a silent `continue`.
  - Restore the T3a N3 running/assigned arms (see N6).

**B3 — The capacity bound is not durable. After a restart, a fifth (up to eighth) new-policy writer is admitted.**
`task-scheduler.ts:175` and `:244` compare `this.active.size` (in-process promises only) with `workerBound`.
- Probe PROBE-2: 8 independent contracts; the first process dispatches A1-A4; restart on the same SQLite file; the new scheduler dispatches A5-A8.
- Durable state then holds 8 `running` tasks and 8 `claimed` live claims. T4's own logic treats A1-A4 as ambiguous live writers.
- This violates "more than four requested slots admits no fifth worker" and EP13 ("race/restart fixtures").
- Minimal fix: count durable live new-policy writers against the bound: `claimed` packet claims plus assigned/running/waiting_guidance new-policy tasks, whether or not they are in `active`.

**B4 — A `released` claim permanently blocks re-dispatch of the same packet: review rejection and failure retry both stall.**
- `task-scheduler.ts:413-415` releases with state `released` on `submitted`, before the `submitted` transition is durable.
- The planning reducer (`planning-projection.ts:2020`) refuses a new claim unless the prior is `stopped_fenced`, and `assertClaimReassignable` requires `stopped_fenced`.
- So after a submit, any later re-dispatch fails. That covers rejected → planned, which is the normal repair loop, and failed → planned after a released claim. `ensurePacketClaim` throws, and the scheduler swallows it (`:292-296`, `catch { continue; }`).
- Probe PROBE-5 (real SQLite): the submit transition failed after the claim was already `released`, and the task was retried to `planned`. Two ticks later dispatches are still `["J1"]`.
  - Appending a gen-2 claim directly is refused with `Planning packet still has an owned assignment.`
- Minimal fix:
  - Treat `released` (proven completion) as a valid prior for the next generation, in the reducer and in `assertClaimReassignable` (a T1 contract; controller decision).
  - Release only after the terminal or submitted transition is durable.
  - Record a durable blocked reason instead of a silent skip.

**B5 — A post-ready `plan.created` (the `plan_tasks` tool or a direct Architect event) overwrites bridged contract tasks, dropping dependencies and resetting or forging status.**
- `scheduler-store.ts:3141-3149` removed the "second initial plan" guard for ready new-policy runs.
- `:3180-3193` replaces `bridged[task.id]` whenever the id is a contract id that already exists (always true after the bridge), and the binding keeps `contractId`, so the task stays a `member`.
- Probe PROBE-3: ready plan D1 and D2 (D2 depends on D1). `plan_tasks`-shaped `plan.created` with `D2`, `dependencies: []`, then one tick dispatches `["D1","D2"]`. The incomplete-dependency guarantee is broken.
- The direct event also accepts any `status`: `planning-tools.test.ts:2643-2690` seeds contract tasks as `integrated` this way, bypassing review and integration (§2.8: gates apply to direct event paths).
- The overwrite also resets `attempt` and running state under a live claim.
- Minimal fix: on a ready new-policy run, never overwrite an existing task. Refuse `plan.created` entries whose id is a current contract id. New non-contract ids stay non-admissible under membership.

**B6 — Alias resolution depends on the process cwd and filesystem state, and it runs inside the planning reducer. Overlaps are missed, and replay depends on cwd.**
- `resolveClaimAlias` (`task-resource-claims.ts:80-93`) calls `realpathSync` on the relative contract path, which resolves against `process.cwd()`, not the project or worktree root.
- When one side exists relative to cwd and the other does not, one becomes absolute and the other stays relative. `claimPathsOverlap` then never matches.
- Probe PROBE-4: cwd = worktree root; contracts X1 `runner-v2/src` and X2 `runner-v2/src/brand-new-t4-probe.ts`. One tick dispatches `["X1","X2"]`, so both the scheduler and the planning reducer admitted the overlapping claims.
- `planning-projection.ts:2021-2029` calls the same fs-dependent `findClaimConflict` inside `reducePlanningProjection`. `rebuildSchedulerProjection` of that same log after `process.chdir(tmpdir())` throws `Planning assignment claim conflict: Task X2 claims runner-v2/src/brand-new-t4-probe.ts, overlapping active task X1's claim runner-v2/src.` A run that was accepted can fail to load after a restart from a different cwd, or after files are created or removed.
- Minimal fix:
  - The reducer uses pure lexical normalization only; no filesystem access in reducers.
  - Scheduler-side alias checks resolve against the explicit project root. They use the nearest existing ancestor for new files, and they flag a conflict if EITHER the lexical or the resolved forms overlap.

**B7 — Re-readiness does not propagate revised contract dependencies to existing scheduler tasks, so the current ready plan's dependency is not enforced.**
`materializeReadyPlanTasks` (`scheduler-store.ts` ~1255-1290) creates only missing tasks ("pre-existing tasks win"). `readyTaskIds` then uses the stale `task.dependencies`.
- Probe PROBE-6: revision_1 has E1 and E2 independent. revision_2 makes E2 depend on E1 and is reviewed and ready.
- The current contract says `E2 deps ["E1"]`, the scheduler task still has `[]`, and membership is `member`. One tick dispatches `["E1","E2"]`.
- Minimal fix: derive dependency eligibility for new-policy tasks from the CURRENT ready contract. Alternatively, update non-terminal member tasks' dependencies deterministically at `plan_ready`, and reject or handle a revision that adds a dependency to an in-flight task.

### NON-BLOCKING

- **N1** `task-scheduler.ts:540-547` — an unknown active writer (no live claim) blocks on files only when it has no workspace path; the `"."` root matches everything. With a recorded `workspacePath` it contributes the absolute worktree path as its only "file", which never overlaps relative contract paths. Fail closed consistently, for example with a `"."` file claim for every unknown writer.
- **N2** `task-scheduler.ts:460` — the failure `reason` text (for example a provider error) is recorded as `writerStopEvidence`. That is defensible only because the in-process driver promise returned. Label it as such, or record the driver-returned fact explicitly.
- **N3** `scheduler-store.ts` `newPolicyTaskAdmissionBlocked` exempts every `verification_repair` from membership. A repair whose parent contract was dropped stays admissible. Consider blocking or surfacing it with the parent.
- **N4** `planning-projection.ts:2011-2013` now requires `claim.laneId === contract.accountablePhaseId`. The plan's lanes (A/B) are execution lanes, and phases are acceptance groups (§4 "Phases BP3/BP4 are acceptance groups"). This narrows an accepted T1/T2 contract and forced test edits (`planning-state.test.ts` `lane-A` → `BP1`). It needs a controller decision.
- **N5** Replaying a pre-T4 new-policy log now materializes extra contract tasks at `plan_ready` and overlays later `plan.created`. It is acceptable only because P6.6 is unshipped; record it.
- **N6** `planning-tools.test.ts:2128-2200` (T3a N3 regression): in the `running`/`assigned` arms the amendment no longer lands (`amended` expected false), because B2's block skips the task before allocation. The N3 re-check in the first loop is now untested.
- **N7** `claimRevisionForFile` exists but nothing in the pump or worker tool path calls it. The "undeclared file → replan" behavior is only an API.
- **N8** Capacity and claims across two runner processes on one store rely on the procedural single-controller label. That label is truthful, but the evidence should say capacity is also procedural across processes.

### NOTE

- **Test file line 1** is a plain `import assert ...`; no limitations note exists there. The header comment (`task-resource-claims.test.ts:66-73`) claims "never in-memory fakes", but:
  - "kernel repair tasks stay admissible" (`:867-916`) and "stale ready-plan digest" (`:918-942`) hand-build projections, bypassing the reducer paths under test;
  - `findClaimConflict(repairClaim, [repairClaim])` (`:910-913`) cannot fail, because the same task id is skipped;
  - `schedulerFor` uses a fixed clock (`() => SEED_AT`), not the advancing clock.
- Evidence prove-red "dropped-membership-dispatched" records scheduler-store sha before/after `721f3594…`, which differs from the final file `e939933b…`. The record predates later edits. I re-proved the guard on the final file (below).
- `newPolicyStaleTasksRequireArchitect` now wakes the Architect whenever any dropped task exists. That wake is reached only on the no-progress path, so it is acceptable.

## Commands and exact counts

All run with `C:\Program Files\nodejs\node.exe .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1`, from the worktree root unless noted.

| Command | Tests | Pass | Fail | Purpose |
|---|---:|---:|---:|---|
| `review-scratch-t4\probe-ws.test.ts` (real git) | 1 | 0 | 1 | B1 demonstrated (expected red) |
| `review-scratch-t4\probe-sched.test.ts` (real SQLite, real TaskScheduler, advancing clock) | 4 | 0 | 4 | PROBE-1 B2, PROBE-2 B3, PROBE-3 B5, PROBE-4 B6 (all expected red) |
| `review-scratch-t4\probe-reject.test.ts` | 1 | 0 | 1 | PROBE-5 B4 (expected red) |
| `review-scratch-t4\probe-revdeps.test.ts` | 1 | 0 | 1 | PROBE-6 B7 (expected red) |
| `runner-v2\test\workspace-manager.test.ts --test-name-pattern="task worktrees isolate concurrent edits"` | 1 | 0 | 1 | Existing test fails for B1, not sandbox |
| Scratch copy, `task-resource-claims.test.ts` capacity test, baseline | 1 | 1 | 0 | Prove-red baseline |
| Same, capacity guard injected | 1 | 0 | 1 | Prove-red reproduced |
| Same, membership `dropped` guard injected | 1 | 0 | 1 | Prove-red reproduced |

I did not re-run suites the worker ran green (per the owner rule).

SHA-256: all 14 files listed in `evidence/T4.md` match the tree exactly (verified with `sha256sum`).

### Prove-red reproduced

1. **Capacity** (`task-resource-claims.ts`): `let bound = Math.min(MAX_WORKERS, input.configuredMax);` → `let bound = input.configuredMax;`.
   - sha before `cb34c5ad…31df`, injected `d94b0e90…9920` (identical to the worker's recorded injected hash), after `cb34c5ad…31df` (byte-exact restore).
   - Red at `task-resource-claims.test.ts:485` `assert.deepEqual(driver.assignments.sort(), ["A1","A2","A3","A4"])` with extra `'A5'`: the fifth worker was admitted.
2. **Membership** (`scheduler-store.ts`, final file): `if (membership.status === "dropped") {` → `if (false && membership.status === "dropped") {`.
   - sha before `e939933b…e916`, injected `86ac8d8c…828d`, after `e939933b…e916`.
   - Red at the membership admission assertion: the dropped task M2 became admissible, so `newPolicyTaskAdmissionBlocked(after,"M2")` returned undefined. The dropped task is rebound at re-readiness, so this guard is the sole protection, and it is real.

## Verdict

T4 REVIEW r1 — REPAIR REQUIRED — 7 blocking
