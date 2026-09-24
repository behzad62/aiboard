# T9 independent review — round 3 (narrow)

Reviewer: independent reviewer (not the T9 author). Read-only on source and tests; the only file written in the repo is this review. Nothing committed, staged or stashed.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base `57e80f45`, T9 + repair cycles 1–2 uncommitted (14 modified, 2 untracked — unchanged by this review).

## Scope

- Round-2 findings to verify: **B3-r2** (planning-state guidance deadlock, blocking) and **N-A** (answer-review findings not bound to an answer). N-B recorded "not done" (T7).
- Read: `T9-review-r2.md`, brief `t9-repair2.txt` (controller widening: `user-steering-contracts.ts`, `sqlite-scheduler-store.ts` ack rules, `native-architect-runtime.ts` prompt), evidence `T9.md` "## Repair cycle 2".
- Cycle-2 delta obtained by diffing the round-2 byte-identical copy (`review-scratch-t9-r2\copy`) against the tree: 4 source files changed (`user-steering-contracts.ts`, `scheduler-store.ts`, `architect-tools.ts`, `native-architect-runtime.ts`) plus `request-triage.test.ts`. `sqlite-scheduler-store.ts` unchanged (confirmed not needed: `requiresAuthoritativeEvidenceStore` and `validateSchedulerEvidenceEvent` only engage for `no_plan_change`; the reducer is the single decision point, and SQLite is the only production `SchedulerStore`; the test memory stores run the same reducer).
- Probes (outside the repo): `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t9-r3\probe-r3.test.mts` (R1, R1b, R2, R3, R4) — real `SqliteSchedulerStore` (+ `SqliteEvidenceStore`), real `BuildRuntime` pump, real Architect tool registry, advancing clock, **no seeded evidence**; round-2 `probe-r2.test.mts` re-run against the current tree.

## Verification of round-2 findings

| Finding | Claim | Verified? | Basis |
|---|---|---|---|
| **B3-r2** planning-state guidance deadlock | new `folded_into_planning` resolution, no evidence, kernel accepts only on a new-policy run with no ready plan | **Deadlock fixed** — but the new resolution opens a guidance-swallow path: **B4-r3** below | Code: `scheduler-store.ts:3509` → `acceptFoldedIntoPlanningAcknowledgement` `:6332-6347` (policy 1 + `!readyPlanIdentity(current)`, checked at append time on the current projection, so a mid-turn readiness flip is refused, and replay is deterministic); parser `user-steering-contracts.ts:247` (exact keys — `evidenceIds` smuggling refused: R2 "Unknown user-steering payload field(s): evidenceIds."); tool schema enum/validation/clone `architect-tools.ts:1981,2255,2620`; prompt `native-architect-runtime.ts:229`. Probe R3 (triage `build` and `clarify`): guidance → `user_guidance_required` → folded ack → next step `plan_required`, guidance `acknowledged`, 0 evidence records. Worker tests cover pre-triage (`request-triage.test.ts:2926`), clarify (`:3011`), plan_only answered (`:3100`), answered (`:2570`), triage-build (`:2712`), inline (`:2804`); the three fake `browser_screenshot` seeds are gone (grep: no `browser_screenshot`/evidence writes in the file). Refusals: legacy → "requires a new-policy run" (R2); ready plan → "requires no ready plan" direct event (R1b + worker `:3208`) and tool path `mechanical_transition_rejected` (worker `:3208`); `no_plan_change` with unknown id still `invalid_guidance_evidence` (legacy rule unchanged). |
| **B3-r2** probe Q1 inverted | — | **Yes** | Round-2 Q1 still shows the *old* three resolutions failing (that probe never tries the new type) — expected; the inverted behavior is R3 plus worker tests above. |
| **B3-r2** guidance content still available | — | **Yes** | The Architect's `task-graph` section renders `projection.userGuidance` incl. text for every status (`agent-prompts.ts:516`); R3 shows the next `plan_required` turn's projection carries `g1.text`. The coverage reviewer's request snapshots **all** guidance, any status (`build-runtime.ts:2399-2402`), so folded guidance is visible to any review **requested after** the fold — see B4-r3 for the case where none is. |
| **N-A** findings bound to answer | kernel stamps `answerSequence` on findings; verdict refused if its or its findings' sequence ≠ current; `nextAnswerReviewId` skips stale-findings ids | **Fixed** | `scheduler-store.ts:634,2678` (stamped from `current.requestAnswer`, payload field refused: R4 "Unknown triage payload field(s): answerSequence."), `:2750-2763`, `:910-922`. Re-run of round-2 probes: **Q2 now fails its defect assertion** ("own findings predate the answer") — the pump re-reviews as `answer_review_2` with findings on TWO; **Q3** logs "verdict binds answer sequence 1004, not the current answer 5" (refused). Crash-resume: R4 — findings for the current answer with no verdict → `nextAnswerReviewId` = `answer_review_1` (same id). `nextAnswerReviewId` is only called when no current verdict exists (`build-runtime.ts:2474-2476`); every recorded verdict's findings share its sequence, so the two skip loops cannot return an id that already holds a verdict. |

## Findings

### BLOCKING

**B4-r3 — `folded_into_planning` lets guidance that arrives after a passing coverage verdict (but before `plan_ready`) be acknowledged with no evidence and no plan change; the pump then marks the unchanged plan ready. The guidance is never reflected in the plan or seen by any coverage review.**

- Where: kernel accept `scheduler-store.ts:6341` (only checks `readyPlanIdentity`); pump `build-runtime.ts:896-899` → `advanceCoverageReview` `:2284-2356` (a bound passing review goes straight to `appendPlanReady`, with no Architect turn); readiness reducer `planning-projection.ts:1882-1938` (never checks guidance); reviewer guidance snapshot taken at review time `build-runtime.ts:2399`.
- Scenario (probe R1, real SQLite and real pump, no seeding beyond the real planning events):
  1. Triage `build`, ledger, full reads, checkpoint, `plan_drafted` rev 1, then coverage requested and recorded (passing). `plan_ready` has not been appended yet.
  2. The user submits guidance "Also add an audit log entry for every login (new scope)." This is realistic, because the coverage reviewer's model call is a long step and the user can steer during it.
  3. Step 1 → `user_guidance_required`. The Architect follows the system prompt ("While the run has no ready plan … use folded_into_planning") and the kernel accepts the ack.
  4. Step 2 → `{"status":"progressed","action":"plan_ready"}`. The ready identity is `revision_1`, the same digest. The coverage reviewer made **0** calls, and the Architect ran only once (`["user_guidance_required"]`).

  The Architect also has no way to fold the guidance in. Planning events are refused while the guidance is pending (`assertPendingUserGuidanceAllowsEvent`), and after the ack the next pump step appends `plan_ready` before any Architect planning turn.
- Control (R1b): the same guidance submitted one event later, after `plan_ready`, is refused `folded_into_planning`. It must go through `no_plan_change` with evidence or `plan_reconciled`. Whether the kernel enforces the steering contract therefore depends on which side of an internal pump step the user's message lands.
- The same window exists on re-readiness. Readiness drops to `not_ready` on `source_amended`, `plan_revised`, `coverage_review_recorded` and `coverage_review_unavailable` (`planning-projection.ts:1374,1482,1790,1878`). A run that already had a ready plan and tasks can therefore take a folded acknowledgement in its re-planning window, and then re-ready on a review that predates the guidance. This was found by code reading, via the same mechanism.
- Contract broken: the resolution's own contract (`user-steering-contracts.ts:22-30`, `scheduler-store.ts:6323-6330`) is that "the guidance folds into the plan … still being drafted". The steering rule that guidance is either proven not to change the plan (evidence) or reconciled into it is bypassed.
- Minimal fix (kernel-side, keeps B3-r2 deadlock-free):
  1. Record the sequence of the latest `folded_into_planning` acknowledgement on the planning projection.
  2. Make `planning.plan_ready` refuse unless the bound coverage review was **requested after** that sequence. The reviewer snapshot then contains the guidance.
  3. Mirror this in `advanceCoverageReview`: a bound review older than the latest fold returns `undefined`, so the Architect gets `plan_required` and must revise or re-request coverage review.

  Equivalently, the folded ack could clear or stale the current coverage binding.
- Required tests: a pump test for R1 (guidance after a passing verdict → folded → no `plan_ready` until a post-fold coverage review; the reviewer input contains the guidance), and a prove-red that removes the new readiness check.

### NON-BLOCKING

- **N-C — The answered-run folded ack does not require the answer to reflect the guidance, and the answer review never sees guidance.** On an answered run whose answer is already recorded, `folded_into_planning` is accepted and the run can go straight to handoff/completion with the pre-guidance answer. The opted-in answer review input carries no guidance (`request-triage.ts`, no guidance reference). This is advisory-path only (zero mutation holds), so it is not blocking. Suggested fix: pass guidance to the answer-review input, or make an ack after the answer require a re-answer. Otherwise T7 should state this explicitly.
- **N-D — Client type drift.** `lib/client/runner-v2.ts:250-260` `NativeUserGuidanceProjection.resolution` lacks `folded_into_planning`. No client code dereferences the resolution today (grep), so nothing crashes. T7 (client surfaces) should add it.

### NOTES

- **NOTE-1:** The Architect system prompt line (`native-architect-runtime.ts:229`) is unconditional, so legacy runs also read "while the run has no ready plan … use folded_into_planning". `readyPlanIdentity` is always undefined on legacy runs. A legacy Architect may try folded once and get a kernel refusal (`mechanical_transition_rejected`), after which the other resolutions remain usable. This costs a wasted call and is not a deadlock. Consider saying "on new-policy runs".
- **NOTE-2:** The brief's "compact prompts" update was not needed: `agent-prompts.ts` names no resolution types (grep). The file is unchanged this cycle, and its hash matches.
- **NOTE-3 — regressions checked and holding:**
  - Legacy `no_plan_change` evidence rule: tool pre-check `architect-tools.ts:2021-2034` and SQLite `validateSchedulerEvidenceEvent` `scheduler-store.ts:1716-1723`, both unchanged.
  - `plan_reconciled` path (`:3502-3535`) unchanged.
  - Zero-mutation, triage-first, idempotency keys and T3 admission/coverage code are untouched this cycle. Only the hunks listed above changed.
  - The tool idempotency key `user-guidance-ack:${id}:${version}` is deterministic. A refused folded attempt persists nothing, so a retry with another resolution does not conflict.
  - The tool schema enum and the parser agree on three types, and `architect-lifecycle-surface` still passes.

## Claims check

- **sha256 of all 16 files in "Repair cycle 2 → Changed files" match the tree (16/16).** Recomputed with `sha256sum`:
  - request-triage.ts `41a1b27a…`
  - scheduler-store.ts `ecd2a3b8…`
  - build-runtime.ts `4210e2a6…`
  - architect-tools.ts `89f2b517…`
  - planning-tools.ts `9f488b29…`
  - planning-review.ts `430474b5…`
  - native-architect-runtime.ts `7743fe3b…`
  - agent-prompts.ts `1752ce9e…`
  - role-capabilities.ts `2e80c499…`
  - native-build-factory.ts `3df5086e…`
  - user-steering-contracts.ts `20ea9e77…`
  - request-triage.test.ts `c38b7e7d…`
  - role-capabilities.test.ts `4c1fd47c…`
  - planning-state.test.ts `d692c6c7…`
  - planning-tools.test.ts `5b76bcf9…`
  - planning-review.test.ts `b7a30474…`
- **Worker suites (15 files, 364/364) were not re-run** (owner rule).
- **Prove-red reproduced in a byte-identical scratch copy** (`review-scratch-t9-r3\copy`; every tracked and untracked `runner-v2` file was hash-compared to the worktree, 0 diffs; `node_modules` is a junction). Injections used a byte-preserving Node replace, because `sed -i` rewrote the CRLF file. That first attempt was discarded and restored from the saved original before any run.
  1. **Folded refused after readiness:**
     - Injection: `scheduler-store.ts:6341` `if (readyPlanIdentity(current))` → `if (false && readyPlanIdentity(current))`. `diff` shows exactly 1 line changed.
     - Hashes: BEFORE `ecd2a3b8…`; DURING `cc0f79366cfda143…`, which is **identical to the worker's DURING hash**.
     - Result: `request-triage.test.ts` 32 tests, 31 pass, 1 fail. The failure is exactly "T9 repair B3-r2: folded_into_planning is refused once a ready plan exists …" with `AssertionError: Missing expected exception.`
  2. **Verdict answerSequence check (N-A):**
     - Injection: `:2754` `false &&`. `diff` shows exactly 1 line changed.
     - Hash: DURING `fad63e7e…`, which is identical to the worker's.
     - Result: 32 tests, 31 pass, 1 fail. The failure is exactly "T9 repair N-A: a verdict whose answerSequence is not the current answer is refused", `Missing expected exception.`
  3. **Superseded-findings check (extra, not in the worker's evidence):**
     - Injection: `:2759` `false &&`. `diff` shows 1 line changed.
     - Hash: DURING `1cd97861…`.
     - Result: 32 tests, 31 pass, 1 fail. The failure is exactly "T9 repair N-A: findings formed on a superseded answer cannot back a verdict; …", `Missing expected exception.`
  - After each injection the file was restored from the saved original. AFTER hash `ecd2a3b8…`, which equals BEFORE and equals the worktree file.
- **The worktree was never modified.** `git status --short` is identical before and after, apart from this review file, and the worktree `scheduler-store.ts` is `ecd2a3b8…`.

## Commands and exact counts

- `sha256sum` over the 16 evidence files: 16/16 match.
- `probe-r3.test.mts`: 5 tests, 5 pass. The R1 asserts demonstrate the B4-r3 defect: `plan_ready` on the unchanged `revision_1`, 0 coverage calls, Architect reasons `["user_guidance_required"]`. R1b, R2, R3 and R4 demonstrate correct behavior. An earlier run had 4/5 pass because of a harness error in my stub (the coverage driver was missing `candidateRuntimeIds`); that run was superseded.
- Round-2 `probe-r2.test.mts` re-run: 4 tests, 3 pass, 1 fail. Q2's defect assertion now fails, which is the intended inversion. Q3 logs the refusal. Q1 exercises only the old resolution types.
- `final-verification-completion.test.ts` + `architect-lifecycle-surface.test.ts` (both import the touched surface and were not in the worker's list): 15 tests, 15 pass, 0 fail.
- Prove-red in the scratch copy, `request-triage.test.ts`: 32 tests, 31 pass, 1 fail for each of the 3 injections, each failing exactly the targeted test.
- No full suite was run, and no suite from the worker's list was re-run.

## Verdict

T9 REVIEW r3 — REPAIR REQUIRED — 1 blocking
