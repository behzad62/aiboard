# T3b independent review r4 (narrow; after repair cycle 3)

Reviewer: Opus (independent; did not write T3b or any repair; no memory of r1–r3 beyond their files).
Worker: Muse. Date 2026-09-24. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`,
branch `codex/runner-v2-p6-6`, base `630dba59`, T3b + repairs 1–3 uncommitted (11 modified + 3 untracked).
No source or test file was edited. Probes are in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t3b-r4\`: `probe.test.ts` is the current
`planning-review.test.ts` with absolute imports plus the `PROBE r4-*` tests in `probes.part.ts`.
Logs: `probe-run1.txt`, `probe-run2.txt`, `r3-probes-rerun.txt`, `provered-r3-1.txt`, `postrestore.txt`.

## Scope

- Inputs: `T3b-review-r3.md`, brief `t3b-repair3.txt`, and `evidence/T3b.md` "Repair cycle 3".
- Code read:
  - `planning-review.ts`: `recordSuspended` (`:447-484`), plus every other coverage idempotency key (`:285`, `:306`, `:337`, `:360`, `:403`, `:441`, `:492`, `:520`).
  - `planning-projection.ts`: the `coverage_review_suspended`, `retry_authorized`, `unavailable` and `plan_ready` reducer cases (`:1800-1938`), and `coveragePlanReadinessInput` (`:820`).
  - `build-runtime.ts`: `advanceCoverageReview` (`:2180-2350`) and `pauseForCoverageGate` (`:2360-2370`). This file is unchanged in cycle 3.
  - `planning-contracts.ts`: `computePlanReadiness` (`:2303`), read-only.
  - The worker's new tests `T3b-R3 *` (`planning-review.test.ts:5111-5400`).

## Verification

### R3-1: fixed

- **The key.** It is now `coverage:suspended:${reviewId}:${sequence}:${attempts}:${reason}` (`planning-review.ts:474`). `sequence` is the number of durable `planning.coverage_review_suspended` events for that review that exist before the append (`:464-468`).
  - The sequence is a pure function of the durable log, filtered by type and `payload.reviewId`. It is therefore deterministic and replay-safe.
  - It never resets, because the retry reducer deletes only the projected `coverageSuspended[reviewId]` and the gate; it never touches the log.
- **Write path vs projection.** The two do not have to agree, and they cannot collide.
  - The sequence drives only the key. The N6 bound still reads the projected per-epoch `attempts`.
  - The sequence counts one review's events only, so it does not count across reviews.
  - The store stores exactly one event per distinct key, and a refused append persists nothing. So the sequence rises by exactly 1 per committed suspension, and keys are unique by construction.
  - Probe r4-A saw keys `…:0:1`, `…:1:2`, `…:2:1`, …, `…:7:2`: 8 events and 8 distinct keys.
- **Exact re-delivery.** Probe r4-B re-appended the identical event (same key, payload, actor and `occurredAt`) on SQLite. The store returned the existing event: the log length stayed 9, and `attempts` stayed 1. The same key with a different payload raised `idempotency conflict`, so nothing is silently swallowed.
- **Re-invoking `recordSuspended` after a crash.** A re-invocation (as opposed to a re-delivery) gets a new sequence and counts as a new attempt. That matches the old behaviour, because the old key also used the post-commit projected count. It is also correct: after a crash, the step re-runs the reviewer, which is a real new attempt (see NOTE-A).
- **Audit of other keys.**
  - Keys scoped by identity: `coverage:obligations`, `coverage:correction-view`, `coverage:plan-delivered`, `coverage:release`, `coverage:verdict` and `coverage:plan-ready`. Obligations and the correction view are reused from the durable log before re-recording (`:1876`, `:2055`), and plan-delivered is guarded by `planDelivered`.
  - Keys scoped by durable-log occurrence: `unavailable` and `review-retry`.
  - `coverage-paused` uses the global monotonic `lastSequence`.
  - None is built from the counter the retry resets. **The worker's claim holds.**
- **Replay.** Probe r4-A opened a second `SqliteSchedulerStore` connection on the same file. It rebuilt a `deepEqual` projection and an identical key sequence (30 events).

### N-R3-1: fixed

- **Scope of the exemption** (`planning-projection.ts:1892-1902`). It applies only when all of these hold:
  - `gate.reason === "plan_ready_blocked"`;
  - `gate.planRevisionId` is the current revision;
  - `gate.sourceManifestId` is the current manifest;
  - `gate.reviewId` is either the bound `coverageReview.id` or undefined. Every runtime record site passes `bound.id` (`build-runtime.ts:2234`, `:2253`, `:2270`), so undefined cannot come from the runtime.
- **What still runs after the exemption.** All the checks below it:
  - unread sections;
  - cumulative open blocking prior findings;
  - `computePlanReadiness`: revision validation, verdict and finding holds, review binding (id + digest + manifest), host capabilities, and requirement removal against the prior revision.
  - The exemption bypasses only the gate check itself.
- **Clearing.** The gate clears only on the successful `plan_ready` (`:1937`). A refused append persists nothing, so the gate and its original detail survive a refusal.
- **Abuse probe r4-E: every case refused.**
  - A forged `plan_ready_blocked` gate for the bound review, while the review had a blocking `missing` verdict and a blocking finding: `Plan is not ready: A blocking missing or weakened coverage verdict is unresolved. Unresolved blocking finding …`. The gate detail stayed `forged`, and readiness stayed not ready.
  - A `no_coverage_review_driver` gate: refused with `explicit outstanding coverage gate`.
  - A terminal `coverage_review_suspended_exhausted` gate: refused with the same message.
  - A `plan_ready_blocked` gate naming a different review id: refused with the same message.
- **Probe r4-D (r3-D inverted).** After a restart with the host-capabilities provider, the first step was `progressed/plan_ready`. Readiness was `ready`, and the gate was `undefined`. There was exactly 1 unavailable event, and it still carried the original detail `No host capabilities provider is configured.`.
- **Replay.** Before this change, a `plan_ready` beside any gate threw, so no previously valid log contains that sequence. Adding `coverageUnavailable: undefined` on success is a no-op for old logs, because a successful `plan_ready` previously implied no gate.

### No regression

- **r3-B** (non-owner forged retry refused for architect, verifier, runner and worker; a restart on a terminal gate re-pauses) and **r3-C** (a non-coverage resume authorizes nothing): both re-run and passed (2/2).
- **r3-A and r3-D:** re-run in inverted form as r4-A, r4-C and r4-D, all passing.
- **Restart mid-epoch:** covered by r4-A across 3 epochs. It re-pauses with `coverage_reviewer_unavailable`, `attempts` returns to 2, and there are 0 `autonomous_pump_error` pauses.
- **Failover (r4-C):** tested across two owner retries. Keys `0..5` are distinct, with google then fallback reviewers, and there was no conflict.

## Findings

### BLOCKING
None.

### NON-BLOCKING
None.

### NOTES
- **NOTE-A: the key de-duplicates only a byte-identical re-append, not a re-run of `recordSuspended`.**
  - **Where:** `planning-review.ts:464-474`.
  - **Scenario:** a crash after the suspended event commits but before the step returns. The next step re-runs the reviewer, and its suspension is recorded as a new attempt.
  - **Why it is acceptable:** this is the same as before cycle 3, and it is correct, because a real new model attempt was made. The N6 bound still caps it. No change is needed.
- **NOTE-B: the exemption also accepts a `plan_ready_blocked` gate that has no `reviewId`.**
  - **Where:** `planning-projection.ts:1897`.
  - **Why it is acceptable:** only a runner actor can append this gate, and the runtime always sets `reviewId`. Even for such a gate, every real readiness check still runs.
- The r3 NOTES 1–3 are unchanged, and the evidence acknowledges them.

## Commands and results

- **Tree identity:**
  - `sha256sum -c` over all 14 files in the "Repair cycle 3" file table gave **14/14 OK**. It was run before any work and again after the prove-red restore.
  - `git status --short` lists 14 entries.
  - Per the owner rule, the worker suites (18 files, 364/364, tsc 0, eslint 0) were not re-run. The hashes tie those results to this tree.
- **r4 probes:** `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 --test-name-pattern "^PROBE r4" <scratch>\probe.test.ts`
  - **`probe-run1.txt`:** r4-A, r4-B, r4-C and r4-D passed. r4-E failed only because my fixture used an invalid finding category (`missing_obligation`), so the verdict tool rejected the turn and the review suspended.
  - **`probe-run2.txt`:** with the category corrected to `missing_coverage`, r4-E gave tests 1, pass 1, fail 0.
- **r3 probes re-run (`r3-probes-rerun.txt`):** `--test-name-pattern "^PROBE r3-(B|C)"` on the r3 scratch file gave tests 2, pass 2, fail 0.
- **Prove-red reproduction (R3-1 sequence in the key), `runner-v2/src/planning-review.ts` (CRLF), with helper `review-scratch-t3b-r3\mutate.mjs`:**
  - BEFORE: `badf89c82759d939d1f20e4445c260cc65e6baecb2e54f8bc8e2acfd5d69e81e`.
  - Injection: needle `${input.reviewId}:${sequence}:${attempts}` (count 1) replaced with `${input.reviewId}:${attempts}`.
  - INJECTED: `ae63da51e025f567ab10ccb1828e026e6dc640f532395608c23f14e7f7775499` (changed: true). Line 474 was shown to be mutated, and the hash equals the worker's recorded MUTATED hash.
  - Result (`provered-r3-1.txt`): tests 3, pass 0, fail 3.
    - `T3b-R3 R3-1` failed with `Error: Coverage suspension was not durably projected.`.
    - `T3b-R3 R3-1 (failover)` failed with `Error: Scheduler idempotency conflict for coverage:suspended:coverage_1:1:model_ended_without_lifecycle.`.
    - `PROBE r4-A` failed with actual `THREW Coverage suspension was not durably projected.`.
  - Restored by byte copy. AFTER: `badf89c8…e81e`, which matches, and line 474 is restored.
  - Unmutated re-run (`postrestore.txt`, `^(T3b-R3|PROBE r4)`): tests 8, pass 8, fail 0.

## Verdict

- Repair cycle 3 fixes R3-1. The suspended-attempt key is now scoped by a durable, monotonic, per-review sequence. As a result:
  - owner retries, restarts and failover never collide;
  - N6 exhaustion re-engages with the coverage reason every epoch;
  - an exact re-delivery still de-duplicates;
  - replay is identical.
- It also fixes N-R3-1. The `plan_ready_blocked` exemption is limited to that gate kind, the current revision and manifest, and the bound review. Every real blocker is still re-evaluated, and the gate clears durably with its original detail kept.
- No regression was found.

T3b REVIEW r4 — ACCEPT
