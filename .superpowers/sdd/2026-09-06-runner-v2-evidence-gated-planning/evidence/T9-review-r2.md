# T9 independent review — round 2

Reviewer: independent reviewer (not the T9 author; no memory of round 1 beyond `T9-review-r1.md`). Read-only on source and tests; the only file written is this review. Nothing committed.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base `57e80f45`, T9 plus repair cycle 1 uncommitted (13 modified files, 2 untracked).

## Scope

- Requirements: `t9-brief.txt`, `t9-repair1.txt`, `T9-review-r1.md`, plan T9 / T3 predicate / §5.0, amendment OA-3, OA-7, OA-10 #2 (as cited by the briefs and round 1).
- Code: full `git diff` of `scheduler-store.ts`, `build-runtime.ts`, `architect-tools.ts`, `planning-tools.ts`, `planning-review.ts`, `native-architect-runtime.ts`, `agent-prompts.ts` (T9 hunks), `native-build-factory.ts`; `request-triage.ts` read in full; the repair tests B1/B2/B3/N1/N2/N3 read.
- Probes (outside the repo): `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t9-r2\probe-r2.test.mts` (Q1 x2, Q2, Q3) and `q4.test.mts` (Q4). All drive the real `SqliteSchedulerStore` with an advancing clock; Q1/Q2 drive the real pump (`BuildRuntime.step` / `runUntilBlocked`); Q2 uses the real `NativeAnswerReviewRuntime` with SQLite session, evidence and context-manifest stores and the real `RuntimeRouter.selectVerifier`.

## Verification of round-1 findings

| R1 finding | Repair claim | Verified? | Basis |
|---|---|---|---|
| **B1** stale verdict satisfies an opt-in | readiness requires a verdict with `answerSequence === requestAnswer.sequence` (`scheduler-store.ts:881` `currentAnswerReviewVerdict`); pump re-reviews with the prior verdict attached | **Fixed as specified** | Code read; OA-10 #2 ordering is reducer-enforced (release requires recorded own findings with the same `priorReviewId`; verdict requires the release and exactly one check per prior finding). Identical re-recorded text gets a new sequence, so it is re-reviewed (correct). A restart replays the same projection. Prove-red reproduced (below). Residual weakness via opt-out → re-answer → re-opt-in: **N-A** below. |
| **B2** opt-in makes pump fail / no opt-in at start | opt-in accepted on any non-terminal new-policy run incl. before triage (`scheduler-store.ts` `answer.review_opted_in`); `advanceAnswerPath` returns `paused/project_handoff_requested` when the handoff is already requested (`build-runtime.ts:2528`) | **Fixed** | Code read; test `:2367` (handoff pause → resume → review → select) and `:2474` (opt-in at creation → pump → review once → completed; inert on build). A triage-`build` run can never become `answer` (re-triage refused, conversion is answer→build only), so an opt-in on a build run stays inert permanently; a clarify→answer run correctly picks it up. |
| **B3** user guidance deadlocks answered/planning runs | route guidance for any new-policy non-terminal run (`build-runtime.ts:827`); inline `acknowledge_user_guidance` on new-policy `plan_required` turns | **Partially fixed — still BLOCKING (B3-r2)** | Routing is fixed and the prove-red reproduces. But on a planning-state run (pre-triage, `clarify`, `build` without a ready plan) the acknowledgement it routes to is **unsatisfiable in production**: see B3-r2. The repair's planning-state test passes only because it seeds a fabricated evidence record. |
| N1 clarify loop unbounded | kernel + tool refuse `clarify → clarify` without an answered question after the last triage | **Fixed** | `scheduler-store.ts` `request.triaged` (uses `lastAnsweredArchitectQuestionSequence`, set in `architect.question_answered`). No deadlock: a user who never replies leaves the run `blocked` on the open question, which is the intended state; if `ask_user` fails (version/open-question) the tool errors and the Architect retries in the same loop; `clarify → answer/build` stays allowed without a reply. |
| N2 no opt-out / silent stall | `answer.review_opted_out` (user-only, `scheduler-store.ts:2595`) clears opt-in and the unavailable gate; unavailable reviewer pauses with a visible reason | **Fixed** | Q2 stop 1 shows `paused / answer_reviewer_unavailable` with `answerReviewUnavailable.reason = answer_review_suspended`, `detail = model_ended_without_lifecycle`, and the reason surfaced in readiness issues. Opt-out without opt-in is refused. |
| N3 test fidelity | real `runAgentLoop` model-call count; SQLite for fresh-context / re-review | **Fixed** | Test `:1354` drives the real agent loop over the real tool registry: 7 model calls, 3 actions, no critic/coverage/answer-review pass. Fresh-context and re-review tests use SQLite. |
| N4 requirement IDs | corrected | **Fixed** | Evidence header now attributes triage to EP39, independence to OA-3/EP37, commands to OA-5 #7 + EP41/OA-7; EP36 and EP40 dropped. |
| N5 answer turns noisy | answer turns get triage-status + answer-path instructions only; planning tools reduced to the durable read | **Fixed** | `agent-prompts.ts:473-483`, `planning-tools.ts:116`, `architect-tools.ts:596`. (Cosmetic: the triage-status header still says "record_triage is your first action" on answer turns; NOTE-2.) |
| N6 T3-era logs no longer replay | recorded, no code change | **Recorded** | Evidence "not done / limits". Out of scope (unshipped). |

## New findings

### BLOCKING

**B3-r2 — User guidance on a planning-state new-policy run is still a hard deadlock in production. The repair test hides this by seeding fabricated evidence.**

- Where: routing `build-runtime.ts:827-829`; the acknowledgement tool `architect-tools.ts:1968-2056`; the pending-guidance gate `scheduler-store.ts:1075` (`assertPendingUserGuidanceAllowsEvent`); the command guard `native-architect-runtime.ts:1199-1201` (`PlanningStateCommandGuard`); the reconciliation gate in `applyPlanReconciliation` (T3a: "requires a ready plan revision").
- Why it deadlocks: the acknowledgement has exactly two resolutions.
  - `no_plan_change` needs at least one evidence id that exists in the current run's evidence store. The schema requires `minItems: 1` and the tool rejects missing ids.
  - `plan_reconciled` is refused by the kernel on every new-policy run without a ready plan.

  In planning state the Architect has no way to create evidence: `run_evidence_command` is refused by `PlanningStateCommandGuard`, and the other inspection tools (files, git, code intelligence, memory, MCP) record no evidence. Browser tools do record evidence, but only when a browser backend is configured. Meanwhile the gate refuses `request.triaged`, `request.answered` and every planning event while the guidance is pending, so neither the Architect nor the user has a way to move the run forward.
- Scenario (probe Q1, real SQLite and real pump, no seeded evidence). The user submits guidance ("Prefer the minimal fix.") at either of two points: (a) before triage, or (b) after triage to `build` while planning. The routing fix sends the Architect a `user_guidance_required` turn, which offers `acknowledge_user_guidance`. Every path fails:
  - `no_plan_change` with `[]` gives `invalid_arguments`.
  - `no_plan_change` with an unknown id gives `invalid_guidance_evidence`.
  - `plan_reconciled` is refused by the kernel with "Plan reconciliation on a new-policy run requires a ready plan revision." (Q4 confirms this on the store for a well-formed payload.)
  - `record_triage` gives "Pending user guidance must be acknowledged before request.triaged may advance the run." in case (a), or `already_building` in case (b).

  All three consecutive `step()` calls throw `Architect returned from user_guidance_required without a typed action.`, and the guidance stays `submitted`. Under `NativeBuildManager` this becomes the same repeating `autonomous_pump_error` pause as in round 1. The user has no withdrawal event, so the run can only be stopped.
- The same applies to `clarify` runs (planning state) and to `plan_only` runs on the answer path, which never execute commands (EP32, stated in the evidence), so they cannot mint evidence either. A `finish` answered run can escape only by running an unrelated command in the disposable copy to mint an evidence id to cite. That works, but it is a workaround, and the Architect's system prompt (`native-architect-runtime.ts:229`) steers it the other way ("otherwise reconcile the plan, including newTasks"), which is exactly what the kernel refuses here.
- Contract broken: the repair brief item 3 says "guidance on an answered run and on a planning-state run is acknowledged and the run proceeds". User steering during planning is the normal case (planning is the longest pre-worker phase). The repair's own test `T9 repair B3: user guidance on a planning-state run routes without planRevision` (`request-triage.test.ts:2726`) passes only because it writes a synthetic `browser_screenshot` evidence record straight into the evidence store (`:2772-2786`, idempotency key `evidence:guidance`). No production path can create that record in this state. The answered-run test (`:2569`, seed at `:2627-2640`) and the inline-offer test (`:2833`, seed near `:2855`) seed the same way. This is seeding around the code under test.
- Minimal fix: give new-policy runs without a ready plan a way to acknowledge guidance that needs no evidence and changes nothing. There are two candidates:
  1. Accept a `no_plan_change`-style acknowledgement whose evidence list may be empty, but only while the run has no ready plan. The kernel re-checks that condition. The rationale is that there is no plan to prove unchanged, and the guidance becomes input to the plan still being drafted, or to the answer.
  2. Add a resolution such as `folded_into_planning` that the kernel allows only in planning state or on the answer path.

  The evidence requirement lives in `user-steering-contracts.ts` and `sqlite-scheduler-store.ts:363`. If those files are outside the T9 writable set, the controller must widen the set or assign the fix. Also update the Architect prompt line at `native-architect-runtime.ts:229` to describe the new option. Replace the three seeded-evidence tests with pump-driven tests that seed no evidence: guidance before triage, during planning (triage `build`), under `clarify`, and on a `plan_only` answered run. Each must show the guidance acknowledged and the run advancing.

### NON-BLOCKING

**N-A — Answer-review findings are not bound to an answer, so a verdict for the current answer can carry findings formed on a superseded answer.** Locations: `request-triage.ts:1155` (the findings pass reuses durable findings for the same `reviewId`), `scheduler-store.ts:898` (`nextAnswerReviewId` counts verdicts only), and `scheduler-store.ts:2617` / `:2693` (the findings record has no `answerSequence`, and the verdict's `answerSequence` is never checked against the current answer or against the findings).
- Scenario (probe Q2, real pump, real review runtime, SQLite):
  1. The user opts in and answer ONE is recorded at sequence 8.
  2. The findings pass records f1 ("Answer ONE blames a stale cache…", blocking) at sequence 9.
  3. The verdict pass ends without its lifecycle tool, and the run pauses `answer_reviewer_unavailable`.
  4. The owner opts out (the N2 escape hatch) and resumes. The Architect records answer TWO at sequence 14.
  5. The owner opts in again. `nextAnswerReviewId` still returns `answer_review_1` because no verdict exists. The findings pass is skipped because findings for that id are already durable. The verdict pass sees answer TWO, and the verdict is recorded with `answerSequence: 14` and findings `[f1 about ONE]`.

  The pump then returns `completion_decision_required` with `{"ready":true,"issues":[]}`. The kernel's record-before-verdict rule (verdict findings must equal the recorded findings) stops the reviewer from recording findings about TWO. OA-10 #2 says the reviewer records its own view of the answer first, but the reviewer never recorded a view of TWO.
- Probe Q3: the kernel accepts `answer.review_recorded` with `answerSequence` = current + 999.
- Why this is not blocking: the literal repair contract (`answerSequence ===` current) holds. The path needs a failed verdict pass, an owner opt-out, a re-answer and a re-opt-in. The verdict pass does judge the current text.
- Minimal fix:
  - Stamp `answerSequence` on `answer.review_findings_recorded`.
  - In the reducer, refuse a verdict whose `answerSequence` differs from the current answer's or from its findings' `answerSequence`.
  - Make `nextAnswerReviewId` skip an id whose recorded findings were bound to a superseded answer.

**N-B — No production entry point exists for the opt-in or opt-out.** `answer.review_opted_in` and `answer.review_opted_out` are appended only by tests. No `NativeBuildManager` method, HTTP route or runtime API emits them (grep over `runner-v2/src`). "Accepted at creation" is true of the reducer, but no caller exists yet. This is acceptable if T7 owns it; T7 should be told explicitly.

### NOTES

- **NOTE-1 — Verified unchanged or holding:**
  - Kernel zero-mutation guards for answered runs: `plan.created`, task revise/upgrade, `integration.revision_advanced`, final-verification generation, both repair creators, `applyPlanReconciliation` (which also covers the guidance `plan_reconciled` acknowledgement, pinned by a negative test), and dispatch admission (`newPolicyTaskAdmissionBlocked`). These are still present after the repair.
  - The triage-first gate on plan-progressing `planning.*` events.
  - Command execution under `answer` only through `answerCommandRevision` in the disposable copy. The per-invoke `PlanningStateCommandGuard` still refuses under `build` without a ready plan, under `clarify`, and before triage (Q1 shows `planning_state_command_refused` in both states).
  - Idempotency keys are deterministic, with no timestamps and no reset counters:
    - `request-*:${lastSequence}`
    - `answer:findings|release|verdict:${reviewId}`
    - `answer:unavailable:…:${monotonic event count}`
    - `answer-paused:${reviewId}:${reason}:${lastSequence}`
  - The inline acknowledgement on `plan_required` turns does not bypass T3 gates. `no_plan_change` only marks the guidance acknowledged, and `plan_reconciled` still goes through the T3a ready-plan refusal and the T9 answered refusal.
- **NOTE-2** — On answer turns the triage-status header still reads "record_triage is your first action" (`agent-prompts.ts:480`). This is cosmetic.
- **NOTE-3** — An answered run with the opt-in can loop between re-answer and re-review. Each new answer after a verdict drives another review, and only the budget stops the loop. This is acceptable because the verdict is advisory, but T7 or the prompt should discourage re-answering solely to chase `answerAccurate:true`.

## Claims check

- **sha256 values:** all 15 in "Repair cycle 1 → Changed files" match the tree (15/15). They were recomputed with `sha256sum`:
  - request-triage.ts `41a1b27a…`
  - scheduler-store.ts `359d76e5…`
  - build-runtime.ts `4210e2a6…`
  - architect-tools.ts `17ad9c8c…`
  - planning-tools.ts `9f488b29…`
  - planning-review.ts `430474b5…`
  - native-architect-runtime.ts `8a1b45d5…`
  - agent-prompts.ts `1752ce9e…`
  - role-capabilities.ts `2e80c499…`
  - native-build-factory.ts `3df5086e…`
  - request-triage.test.ts `31bb57da…`
  - role-capabilities.test.ts `4c1fd47c…`
  - planning-state.test.ts `d692c6c7…`
  - planning-tools.test.ts `5b76bcf9…`
  - planning-review.test.ts `b7a30474…`
- **Worker suites (20 files, 414/414) were not re-run**, per the owner's rule.
- **Prove-red 1, B3 routing (reproduced).** The classifier rule applied, so this ran in a byte-identical scratch copy at `review-scratch-t9-r2\copy`, with `node_modules` as a junction to the worktree's. The copy's hashes matched the worktree before the injection.
  - BEFORE: `build-runtime.ts` `4210e2a619eb38bf835b8718383e8ec5043cdf75679174cdcb116674f52ae6ac` (the file is CRLF).
  - Injection: line 827 `projection.planRevision > 0 ||` became `projection.planRevision > 0 || false &&`. `diff` shows exactly one changed line.
  - DURING: `51b1dbb4da73082e883afa4617a11b74defca682c147a09bbe411295b090b8a0`.
  - Red: `request-triage.test.ts` ran 26 tests: 24 passed, 2 failed, and the two failures are exactly the B3 pump tests. On the answered run, `record_answer` was refused with "Pending user guidance must be acknowledged before request.answered may advance the run."; the planning-state test failed on its strict-equal assertion.
  - Restored from the saved original. AFTER: `4210e2a6…`, which equals BEFORE and equals the worktree file. The re-run passed 26/26.
  - (The worker recorded a different DURING hash because its injection text differed. The failing set is identical.)
- **Prove-red 2, B1 binding (reproduced).** In the same scratch copy, I removed the `.filter((verdict) => verdict.answerSequence === answer.sequence)` line from `currentAnswerReviewVerdict`.
  - BEFORE: `359d76e5b355f0ba86cde756defbb2c012f95c1691334711e77ca557d2a0121d`.
  - DURING: `3517d53cf90d80b228ba4fef839a50c2ffb98444e1b6cf6d0d304d09af92e141`, byte-identical to the worker's recorded DURING hash. `diff` shows exactly one deleted line (887).
  - Red: 26 tests, 25 passed, 1 failed: only `T9 repair B1…`, with `AssertionError ["docs/project/STATE.md has not been committed."]`. The stale verdict satisfied the review.
  - Restored. AFTER: `359d76e5…`, which equals BEFORE and equals the worktree file. The re-run passed 26/26.
- **The worktree was never modified.** `git status --short` is unchanged apart from this review file, and the worktree hashes for `build-runtime.ts` and `scheduler-store.ts` match BEFORE.
- **The evidence claim "B3 fixed … guidance on a planning-state run is acknowledged and the run proceeds" is not supported in production.** The test proves it only with fabricated evidence (see B3-r2).

## Commands and exact counts

- `sha256sum` over the 15 evidence files: 15/15 match.
- `probe-r2.test.mts`: 4 tests, 4 pass (the asserts demonstrate the defects).
  - Q1 pre-triage and Q1 triage-build: 3/3 steps threw, and the guidance stayed `submitted`.
  - Q2: `ready:true` with stale findings.
  - Q3: the kernel accepted `answerSequence` 1004 against a current sequence of 5.
- `q4.test.mts`: 1 test, 1 pass. The kernel refuses a `plan_reconciled` acknowledgement in planning state.
- Prove-red B3 in the scratch copy: 26 tests, 24 pass, 2 fail with the guard injected; 26/26 after restoring.
- Prove-red B1 in the scratch copy: 26 tests, 25 pass, 1 fail with the guard injected; 26/26 after restoring.
- Nothing else was run: no full suite and no re-run of the worker's suites. Two earlier invocations of `q4.test.mts` failed on a harness error in my own probe setup (guidance was seeded without the managed interruption protocol) and were superseded by the run above.

## Verdict

T9 REVIEW r2 — REPAIR REQUIRED — 1 blocking
