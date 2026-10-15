# T3b independent review r3 (source-coverage review gate, after repair cycle 2)

Reviewer: Opus (independent; did not write T3b or either repair; no memory of r1/r2 beyond their files).
Worker: Muse. Date 2026-09-24. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`,
branch `codex/runner-v2-p6-6`, base `630dba59`, T3b + repairs 1-2 uncommitted (11 modified + 3 untracked).
No source or test file was edited. Probes are in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t3b-r3\`: `probe.test.ts` is the current
`planning-review.test.ts` with absolute imports plus the `PROBE r3-*` tests in `probes.part.ts`,
and `mutate.mjs` is the byte-exact mutate/restore helper. Logs are `probe-run1..5.txt`,
`provered-r23.txt` and `r2-probes-rerun.txt`.

## Scope

Requirements came first:
- Briefs: `t3b-brief.txt`, `t3b-repair1.txt` (obligations are source-derived and plan-independent) and `t3b-repair2.txt` (the retry is modelled on the verifier `selection_required` path; the kernel refuses reused finding ids).
- Reviews: `T3b-review-r1.md` and `T3b-review-r2.md`.
- Plan: task T3 and §5.0.
- Ledger: EP05, EP33, EP34, EP42, EP44.
- Amendments: OA-1, OA-2, OA-3, OA-10.

Code read:
- **Repair cycle 2 changes:**
  - `build-runtime.ts`: `resumeInternal` terminal-gate clearing, `advanceCoverageReview`, `pauseForCoverageGate`.
  - `planning-review.ts`: `SchedulerCoverageReviewAuthority.recordUnavailable`, `authorizeCoverageRetry`, `recordSuspended`, verdict tool id refusal.
  - `planning-projection.ts`: actor-role table, `coveragePlanReadinessInput`, `retireFindingsForAmendment`, `openBlockingCoverageFindings`, `assertFindingIdsUnused`, `requiredPriorFindingIds`, and the suspended / retry_authorized / unavailable / plan_ready reducer cases.
  - `agent-prompts.ts`: status readiness input.
- **Cross-read:**
  - `native-build-manager.ts`: pump catch leading to `autonomous_pump_error`.
  - `native-build-factory.ts`: `planningHostCapabilities` wiring.
  - `sqlite-scheduler-store.ts`: idempotency rule.

Claims came last: `evidence/T3b.md` "Repair cycle 2".

## Verification of earlier findings

| Finding | Status | Evidence |
|---|---|---|
| R2-1 silent gate / terminal dead end | **fixed on the first owner retry; broken on the second attempt** | Unavailable, source-bytes, no-driver and exhaustion gates append a runner `run.paused` (`coverage_reviewer_unavailable`) and return `paused`. A non-terminal suspension is `progressed`, and the pump retries up to the N6 bound. There is no timed wake; that is stated, and owner resume is the trigger. On resume, `resumeInternal` (`build-runtime.ts:505-520`) appends the user-actor `planning.coverage_review_retry_authorized` event only when a terminal gate is present, so resuming a pause for any other reason authorizes nothing (probe r3-C). A forged retry by an architect, runner, worker or verifier actor is refused (probe r3-B). A restart on a terminal gate re-pauses with 0 reviewer calls and no throw (probe r3-B). There is no runner-actor pause loop: a non-terminal pause re-attempts selection on every resume, and a terminal one is cleared by it. **However,** after the owner's retry the count reset makes the next suspension collide with attempt 1's idempotency key, and the step throws (new BLOCKING R3-1). |
| R2-2 finding-id reuse launders | **fixed** | `assertFindingIdsUnused` (`planning-projection.ts:1134-1152`) is enforced on the verdict event. The tool path refuses too (worker test `T3b-R2 R2-2`, both paths). Only two things can close a blocking finding: a `resolved` prior-finding check, or retirement in the owner's `source_amended` reducer case. The r2 collision probe no longer reproduces (`r2-probes-rerun.txt`). |
| R2-3 gate re-record crashes on SQLite | **fixed for the gate event; the same bug class remains in `recordSuspended`** (R3-1) | `recordUnavailable` has a durable-log de-dup, a deterministic occurrence key and a timestamp-free payload. The reducer falls back to `occurredAt`, so old `recordedAt`/`updatedAt` events replay identically. `authorizeCoverageRetry` and `pauseForCoverageGate` keys are occurrence- or sequence-scoped with a constant payload. The r2 flap and `plan_ready_blocked` probes no longer throw. The prove-red was reproduced (below). |
| N-R2-1 shared readiness input | **fixed** | The reducer (`:1918`), the runtime (`build-runtime.ts:2247`) and status (`agent-prompts.ts:634`) all call `coveragePlanReadinessInput`, which includes `amendmentHistory`. No other `computePlanReadiness` call site exists. |
| N-R2-2 retired rule | **fixed (see NOTE-1)** | Retirement happens only in the `planning.source_amended` case. That event is user-actor only, enforced by `assertPlanningActor`. A finding retires only when every section of its requirement is absent from the new manifest; partial removal leaves it open. The retirement is durable, visible in status, and a retired finding cited by a later verdict is refused. |
| B2 blind obligations / true-stamp refusal | holds | Unchanged since r2. |
| B4 failover | holds | Unchanged since r2. |
| N1, N4, N6 bound | holds | Unchanged since r2. |
| Read-only reviewer surface | holds | `role-capabilities.ts` is unchanged since r2. |
| legacy / verifier / `selectVerifier` / G-9 / replay-compatibility | holds | `runtime-router.ts`, `native-build-manager.ts`, `planning-contracts.ts` and `source-manifest.ts` have an empty `git diff`, and the verifier family is untouched. |
| Round-2 probes re-run | defects gone | `PROBE r2-*`: 4 tests, 0 pass, 4 fail. Each probe asserted that its defect exists, so all four failing means none reproduces. |

## New findings

### BLOCKING

**R3-1: after the owner's retry, the next suspended attempt throws out of `step()`. The N6 bound
never re-engages, and every later resume crashes the pump.**

The cause is in `planning-review.ts` `recordSuspended` (`:447-470`):
- The idempotency key is `coverage:suspended:${reviewId}:${attempts}:${reason}`, where `attempts` comes from the projected count.
- The new `retry_authorized` reducer case deletes `coverageSuspended[reviewId]` (`planning-projection.ts:1842-1843`). The R2-1 count reset therefore sets `attempts` back to 1.
- After a reset, the first suspension with the same reason reuses attempt 1's key.
- If the payload is the same (same reviewer), the SQLite store silently returns the old event. The projection then has no count, and `recordSuspended` throws `Coverage suspension was not durably projected.`.
- If the runtime differs (failover reviewer), the store throws `Scheduler idempotency conflict`.

Scenario (probe `PROBE r3-A`, real `SqliteSchedulerStore`, ticking clock, real `NativeCoverageReviewRuntime` + `BuildRuntime`, limit 2):
1. The reviewer ends two turns without the lifecycle tool: `progressed/coverage_review_suspended`, then `paused/coverage_reviewer_unavailable`.
2. The owner resumes: the gate clears, `coverageSuspended` is `{}`, and the run is `running`.
3. The reviewer suspends again, and `step()` throws `Coverage suspension was not durably projected.`.
4. The durable log holds only the keys `…:1:model_ended_without_lifecycle` and `…:2:…`. The third attempt was swallowed.

Impact:
- The manager catches the throw and pauses with `autonomous_pump_error` (`native-build-manager.ts:775-792`). The coverage reason is lost, and no N6 gate is recorded.
- Every later owner resume gets one attempt and then the same crash. The bound never re-engages, and the owner sees a pump error rather than the coverage gate.
- A reviewer that has just exhausted N attempts is the one most likely to suspend again. So the owner-retry path that R2-1 delivers crashes in its most likely case.
- This breaks the repair-2 contract in two places: "resume … resets the suspended-retry count; the review then runs again" (R2-1), and "restart and resume do not throw" (R2-3).

The worker's N6 test hides the defect because its post-resume review succeeds on the first attempt.

Minimal fix, either option works:
- Scope the key to the retry generation, e.g. `coverage:suspended:${reviewId}:${generation}:${attempts}:${reason}`, where `generation` is the count of `retry_authorized` events for the review.
- Or derive the key suffix from the durable count of all `coverage_review_suspended` events for the review, as `recordUnavailable` already does.

Add a SQLite + ticking-clock regression test for this sequence: exhaust → owner resume → suspend again → `progressed`, then exhaust again → `paused` with the exhaustion gate, all with no throw.

### NON-BLOCKING

- **N-R3-1: a recorded `plan_ready_blocked` gate refuses its own resolution for the same bound review.**
  - **Where:** the `plan_ready` reducer refuses whenever `coverageUnavailable` is set (`planning-projection.ts:1886`). `advanceCoverageReview` does not clear a `plan_ready_blocked` gate once the pre-check passes. It calls `appendPlanReady`, catches the refusal and records a second gate whose detail is the self-referential `Plan readiness is blocked by an explicit outstanding coverage gate: plan_ready_blocked.`.
  - **Probe:** `PROBE r3-D` ran in memory. The first run had no host-capabilities provider, which recorded the gate. After a restart with the provider, 4 steps made 0 progress toward ready, and the original blocker text was overwritten in status.
  - **Why it is not blocking:** in production the factory always wires `planningHostCapabilities`. The remaining blockers are plan-shaped, and the Architect fixes them by revising and re-requesting, which clears the gate. The Architect cannot re-request for the same revision (`coverage_review_current`).
  - **Fix:** skip the gate check in the runtime pre-check path for its own `plan_ready_blocked` gate (clear or supersede it when the pre-check passes). Alternatively, exempt `plan_ready_blocked` for the bound review in the reducer. Keep the original detail.

### NOTES

- **NOTE-1: retirement uses the ledger requirement's sections, not the obligation's sections.**
  - **Mechanism:** a finding retires through `finding.requirementId` → ledger `requirement.reference.sectionIds`. It does not use the blind obligation's `sectionIds`, because the T1 `PlanningFinding` has no obligation link and `planning-contracts.ts` is forbidden.
  - **Edge case:** an Architect-authored requirement that is narrower than the obligation (the requirement cites s3, the obligation spans s3 + s4) retires the finding when only s3 is removed.
  - **Mitigation:** a source amendment forces a fresh blind derivation, which needs a verdict for every re-derived obligation. A live residue in s4 therefore still surfaces as `missing` or `weakened`. The residual risk is that the reviewer is not pointed at the old finding.
  - **Status:** the evidence states this limit. It is acceptable for T3b.
- **NOTE-2:** `resumeInternal` appends the retry authorization before `run.resumed`, and the two appends are not atomic. A crash between them leaves the gate cleared while the run is still paused. The next resume simply resumes, so this is harmless.
- **NOTE-3:** "Resolved once, resolved forever" still holds for unique ids: a later `outstanding` check of an already-resolved id is not re-opened. With run-unique ids and the required set built from open findings, no realistic path depends on this.

## Commands and results

- **Tree identity:** `sha256sum -c` over all 14 files in "Repair cycle 2" gave **14/14 OK** before any work and again after the prove-red restore. `git status --short` shows the same 11 modified + 3 untracked files. The worker suites (361/361, tsc 0, eslint 0) were not re-run, per the owner rule, and are tied to this tree by those hashes.
- **r3 probes:** `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 --test-name-pattern "^PROBE" <scratch>\probe.test.ts`
  - **`probe-run1.txt`:** tests 3, pass 2, fail 1. r3-B failed only on my over-specific regex; the verifier forgery is refused with `The verifier has no scheduler lifecycle authority.`.
  - **Re-run of r3-B (`probe-run2.txt`):** tests 1, pass 1, fail 0. All four non-owner roles were refused, and a restart re-pauses without throwing.
  - **r3-A:** pass, asserting the defect. The step after the owner retry THREW `Coverage suspension was not durably projected.`. There were 3 reviewer calls, and the log holds only the suspended keys `:1` and `:2`.
  - **r3-C:** pass. Resuming a user-paused run appends 0 retry authorizations.
  - **r3-D (`probe-run5.txt`):** tests 1, pass 1. After the restart with caps there were 4 steps without plan_ready, 2 unavailable events, and a self-referential gate detail.
- **Round-2 probes re-run (`r2-probes-rerun.txt`):** tests 4, pass 0, fail 4. Every old defect is gone.
- **Prove-red reproduction (R2-3 durable de-dup), `runner-v2/src/planning-review.ts` (CRLF):**
  - BEFORE: `c2fb678f07ca9fa939856f623e3cf0020cb211cb49413491b47a1bc50224cf1b` (needle `    if (sameGate) {`, count 1).
  - Injection: `    if (false) {`. INJECTED: `ee2241ebca16b1be29e837d56dc35d3d491468ae94c7803360dd4c04848bbe42` (changed: true; grep shows line 385 mutated). This equals the worker's recorded MUTATED hash `ee2241eb…e42`.
  - Result: `T3b-R2 R2-3: plan_ready_blocked across two steps records once and never throws` gave tests 1, pass 0, fail 1, with `AssertionError … actual: 2, expected: 1` at `planning-review.test.ts:4685`.
  - Restored by byte copy. AFTER: `c2fb678f…cf1b`, which matches.
  - Re-run unmutated: tests 1, pass 1, fail 0.

## Verdict

Repair cycle 2 fixed R2-2, N-R2-1 and N-R2-2. It made coverage gates pause with an owner-visible reason and a user-only retry authorization, and it made gate re-records idempotent on SQLite. The count reset that R2-1 introduced reuses the suspended-attempt idempotency key. As a result, the first suspension after an owner retry crashes the step on the real store, and the N6 bound never re-engages (R3-1). The fix is one line plus a regression test.

T3b REVIEW r3 — REPAIR REQUIRED — 1 blocking
