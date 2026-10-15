# T9 independent review — round 1

Reviewer: independent reviewer (not the T9 author). Read-only on source and tests; the only file written is this review.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base `57e80f45`, T9 uncommitted (13 modified files plus the untracked `runner-v2/src/request-triage.ts` and `runner-v2/test/request-triage.test.ts`).

## Scope

- Requirements: the brief (`t9-brief.txt`); plan §2, §3, §5.0 (G-1..G-11), T3 (planning-state predicate), T9, and the §6 rows that name T9 (EP32 note, EP37, EP39, EP41, EP42); owner amendment OA-3, OA-5, OA-7, OA-8, OA-10 #2; the capability program's AC-17 and AC-25 for the docs-gate decision.
- Code: the full `git diff` of all 13 files plus both new files. I read `request-triage.ts` in full, the scheduler-store delta in full, and the build-runtime, architect-tools, native-architect-runtime, role-capabilities, planning-tools, planning-review, agent-prompts and factory deltas in full. I read enough of the test file to know what each test pins.
- Probes: scratch files in `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t9\` (`probe1.test.mts`, `probe2.test.mts`). They drive the real `BuildRuntime`, the real `SqliteSchedulerStore` with an advancing clock, a restart (store reopened), and the real `NativeAnswerReviewRuntime` with SQLite sessions, evidence and context-manifest stores.

## Must / must-not (written before reading the code)

| # | Obligation | Source |
|---|---|---|
| M1 | Triage is the Architect's first action on a new-policy run, inside its normal turn rather than as an extra model call. The decision (`answer` / `build` / `clarify`) is durable. | OA-5 #1, EP39 |
| M2 | An `answer` run completes with no plan, no workers, no integration and no final verification. The answer is durable. | OA-5 #2 |
| M3 | The kernel enforces that an answered run changes nothing: no task, no dispatch, no integration, no project mutation. The tool path, direct events and replay all refuse it; a prompt instruction is not enough. | OA-5 #3, T9 review line |
| M4 | A needed change converts explicitly to `build` through a durable event and never edits quietly. After conversion the run follows the normal planning flow. | OA-5 #4 |
| M5 | A mixed request goes to `build`. | OA-5 #5 |
| M6 | `clarify` pauses through `ask_user` and returns to triage, including after a restart, without deadlock. | OA-5 #6 |
| M7 | Commands run only in a disposable copy and the project tree hash stays unchanged. They are refused under `build` without a ready plan, under `clarify`, and before triage. | OA-5 #7, EP41 |
| M8 | No critic, coverage review or verifier runs by default. The answer lists the parts it addresses in the same turn. The answer review runs only when the user opts in for that run. | OA-5 #8 |
| M9 | Legacy runs are unchanged. | OA-5 #9 |
| M10 | A `plan_only` run given a pure question is answered. | T9 |
| M11 | The opt-in reviewer is selected through `selectVerifier` (no second selector). `fresh_context` means a new session with an empty event list. Independence is durable. OA-10 #2 applies when a review follows another review. | OA-3, G-6, EP37, EP42 |
| M12 | New readiness sits beside `projectDocumentationReadiness` and never bypasses it. The docs-gate decision for a pure answer is stated. | G-3, AC-25 |
| MN1 | Must not: add a second selector or authority, bypass T3 planning-state or admission guarantees, put timestamps in idempotent payloads, or use reset counters in keys. | G-6, T3, brief |

## Requirement checklist (result)

| # | Result | Basis |
|---|---|---|
| M1 | Met, with a note | `record_triage` is a lifecycle tool offered on every new-policy turn. The kernel refuses plan-progressing `planning.*` events until triage is `build` (`scheduler-store.ts` ~2307). The planning tools refuse with `triage_required`. Note: triage ends the Architect action, so it takes one action on its own (see NOTE-3). |
| M2 | Met | `advanceAnswerPath` (`build-runtime.ts:2445`) runs before planning, critique, workers, integration and final verification. |
| M3 | Met for tasks, dispatch, integration, final verification, repairs, reconciliation and revisions (reducer guards, tool guards, direct and replay negatives). The docs commit is allowed (see M12 and NOTE-1). | Prove-red reproduced (below). |
| M4 | Met | `request.converted_to_build` flips the decision to `build`; `isPlanningState` becomes true again. |
| M5 | Prompt-level only, which is inherent | The Architect makes the semantic routing decision. |
| M6 | Resume works, including across a restart (P5). The loop is unbounded (N1). Guidance deadlock: **B3**. | |
| M7 | Met | Reuses the capability program's `LazyArchitectCommandRuntime` and `PlanningStateCommandGuard`, with a per-invoke re-check. `plan_only` never executes (NOTE-4). |
| M8 | Not met: the opted-in review can be bypassed by a later answer (**B1**), and the opt-in path crashes the pump (**B2**). The default path is met. | |
| M9 | Met for pre-policy runs. T3-era policy-v1 logs no longer replay (N6). | |
| M10 | Met | |
| M11 | Mostly met: `selectVerifier` is reused, fresh sessions are asserted, and the OA-10 #2 reducer gates exist. The OA-10 #2 re-review path cannot be reached from the pump (tied to B1). | |
| M12 | Met | `answeredRunReadiness` runs beside `projectDocumentationReadiness`. The decision to require STATE.md matches AC-25 ("a new run, including `plan_only`"). |
| MN1 | Met | Keys are deterministic (`request-triaged:${lastSequence}`; the unavailable key uses a monotonic occurrence count). Payloads carry no timestamps. The verifier allow-list gains exactly the two review appends. |

## Findings

### BLOCKING

**B1 — An opted-in answer review is not bound to the answer the user receives. A re-recorded answer completes unreviewed.**
`scheduler-store.ts:876` (`answeredRunReadiness`: `answerReviewOptIn && !hasAnswerReviewVerdict`). The `request.answered` reducer at `scheduler-store.ts:2449` accepts any number of answers while triage is `answer`, including after a verdict exists. `build-runtime.ts:2451` drives exactly one review (`ANSWER_REVIEW_ID`) and never re-reviews.

- Scenario (probe P1, real SQLite): answer ONE is recorded at seq 5, the user opts in, and the verdict binds `answerSequence: 5`. The Architect then records answer TWO at seq 9 and the entry-point docs are committed. `buildCompletionReadiness` returns `{"ready":true,"issues":[]}`. The user is shown "Answer TWO (unreviewed)" alongside a verdict for a different answer.
- Why this is realistic: `advanceAnswerPath` runs the review immediately after the first answer and before the docs turns. On those later `plan_required` turns, `record_answer` is the one lifecycle tool that still succeeds besides `write_project_doc`. The prompt shows `answerReviews`, so an Architect that folds in a reviewer's `answerAccurate:false` findings will naturally re-record. The review the user asked for then covers a superseded answer.
- The same gap leaves OA-10 #2 unreachable in production: `priorReview` is never supplied by the pump.
- Minimal fix: readiness requires a verdict whose `answerSequence === requestAnswer.sequence`. When a newer answer exists, the pump drives `answer_review_{n+1}` with `priorReview` set to the latest verdict, which is where OA-10 #2 applies. The alternative is to have the reducer refuse `request.answered` once opted-in review findings exist. Add a SQLite test in which the answer is re-recorded after the verdict.

**B2 — The realistic per-run opt-in path makes the pump fail. An opt-in at run start is impossible.**
The `answer.review_opted_in` reducer at `scheduler-store.ts:2504-2515` requires triage to already be `answer`. `build-runtime.ts:2491-2497` re-runs the completion decision even when `projectHandoff` is already `requested`. `complete_run` uses the fixed key `project-handoff-requested` (`architect-tools.ts:1860`), so the call dedups.

- Scenario (probe P2, real SQLite, real `BuildRuntime`): the pump runs straight from triage through the answer and the docs to the handoff pause. That pause is the first point at which a user who has read the answer can opt in. The opt-in is accepted, but `selectProjectHandoff` is then refused ("The opted-in answer review has not been recorded."). The user must resume. The review runs, then the completion turn calls `complete_run`, which appends nothing, and the pump throws `Architect returned from completion_decision_required without a typed action.` In `NativeBuildManager.pump`, that becomes an `autonomous_pump_error` pause. It can be recovered only because a manual handoff selection happens to pass afterwards.
- The window between triage and the handoff is a race against a pump running at machine speed. The user cannot record the opt-in at creation because triage does not exist yet. So "the user opts in for that run" has no clean path.
- Minimal fix: (a) accept `answer.review_opted_in` on any non-terminal new-policy run before handoff selection; the review runs only if and when the run is answered, and the opt-in stays inert on build runs. (b) In `advanceAnswerPath`, when `projectHandoff?.status === "requested"` and readiness holds, return a paused-awaiting-selection result instead of another completion turn. Add a test: opt in at the handoff pause, resume, then select, with no pump error.

**B3 — User guidance on an answered run deadlocks it.** The root predates T9, because T3 has the same gap, but the answer path has no way out.
The `build-runtime.ts:819` guard (`if (projection.planRevision > 0)`) routes `user_guidance_required` only after a legacy plan exists. On a new-policy run, `planRevision` stays 0 until tasks exist, and an answered run never gets tasks. `assertPendingUserGuidanceAllowsEvent` refuses `request.triaged`, `request.answered` and `request.converted_to_build`, because they are not on its allow-list.

- Scenario (probe P3, real SQLite): after triage, the user submits guidance ("Also mention caching."), which is a normal steering action. The Architect's `record_answer` is refused ("Pending user guidance must be acknowledged before request.answered may advance the run."). `acknowledge_user_guidance` is never offered, because the reason is never `user_guidance_required`. The turn appends nothing, and the pump throws "Architect returned from plan_required without a typed action." Every resume repeats this, so the run can never complete.
- The build-path planning events are refused the same way (`planning-tools.ts` calls the same assert). By inspection of the unchanged guard, the root is a T3 seam. The controller may assign the fix to T3 follow-up; T9's own flow is unusable under steering until it lands.
- Minimal fix: route pending user guidance for new-policy runs regardless of `planRevision` (for example `planRevision > 0 || planningPolicyVersion === 1`), and verify that `acknowledge_user_guidance` with a no-plan-change resolution works on the answer path. Add a SQLite test: guidance mid-answer, acknowledge, answer, complete.

### NON-BLOCKING

- **N1 — The `clarify` re-triage has no kernel bound.** `scheduler-store.ts` ~2430 lets `clarify` re-triage to anything, including `clarify` again, with no `ask_user` in between. Probe P4: 8 Architect turns produced 8 `request.triaged(clarify)` events and no question, and the run yielded `step_allowance_yielded`. Only the budget stops it. Fix: refuse `clarify → clarify` unless an Architect question was answered after the last triage.
- **N2 — The advisory verdict has no withdrawal path.** `answerAccurate:false` and blocking-severity findings do not hold completion. That is defensible, because the contract does not make the answer review a gate, but it should be stated in user-facing terms (T7). When no reviewer is ever eligible, the run pauses on every resume with no opt-out and no bounded suspension, unlike the T3b pattern. Offer a user `answer.review_opt_out` or a bounded-retry-then-owner-decision path.
- **N3 — The tests are not production-faithful in two places.**
  - (a) "answer path makes no extra model pass by default" uses a scripted driver that performs four `write_project_doc` calls in one action. `write_project_doc` is a lifecycle tool, and `agent-loop.ts` (~950) requires a lifecycle call to be the only call in its turn and ends the loop on it. A real pure answer therefore costs at least 7 Architect actions (triage, answer, 4 doc writes, completion) when the entry-point docs are missing. The model-pass count is understated.
  - (b) The fresh-context and re-review tests use the in-memory `MemorySchedulerStore`, contrary to the brief. My P6 probe covered the review runtime on SQLite with a restart: a crash after the durable findings, a restart, then a verdict. That path works.
- **N4 — Evidence mislabels requirement IDs.** `evidence/T9.md` maps "EP36 (triage first action)", "OA-7 (answer review independence)" and "OA-5 (… disposable commands)" incorrectly. In the ledger, EP36 is the T6 deliverable-review ordering, triage is EP39, OA-7 is "planning stays read-only", and commands are OA-5 #7 plus EP41. Correct the mapping.
- **N5 — The answer path is noisy.** Answer turns still register 7 planning tools that always refuse, and they carry `NEW_POLICY_PLANNING_INSTRUCTIONS` next to `ANSWER_PATH_INSTRUCTIONS` (`agent-prompts.ts` ~470-488). That is contradictory guidance and wasted tokens on the path that OA-5 #8 says should be economical. Omit both on answer turns.
- **N6 — Policy v1 semantics changed without a version bump.** A T3-era new-policy log, with `planning.*` progress and no `request.triaged`, now fails replay with "Planning progress … requires a durable triage decision of build". Nothing is released, so the impact is limited to development or evaluation stores. State this explicitly, or gate triage-first on a new policy stamp.

### NOTES

- **NOTE-1 — The docs-gate decision is consistent.** AC-25 applies to "a new run, including `plan_only`", and AC-17 keeps the project working folder untouched until handoff. A pure answer therefore commits STATE.md on the integration branch and changes the project only if the user picks `apply_to_project` at handoff. That choice carries the docs commits into the project. This is an owner-visible tension with OA-5 #3 ("no project mutation"), not a defect, and T7 should label it.
- **NOTE-2 — Restart and replay behave correctly.** Clarify, then `ask_user`, then a restart with the store reopened, then resume: re-triage and answer work and `q1` is `consumed` (P5). The answer review survives a crash between passes on SQLite (P6).
- **NOTE-3 — Triage ends the Architect action because it is a lifecycle tool.** This is not a separate classifier pass, and the model-call count matches a non-lifecycle design apart from batching. The context is re-sent once more, though. Acceptable.
- **NOTE-4 — `plan_only` plus `answer` never executes commands.** This is the conservative reading of EP32 and is documented. The literal EP41 positive half has no `plan_only` exception, so the owner should confirm it.
- **NOTE-5 — Findings and verdict can come from different reviewers after failover (not probed).** `selectVerifier` runs per `review()` call. If the findings pass ran on runtime A and a later retry selects runtime B, the verdict records B's id and independence while the findings actor was A. The reducer accepts this because the findings are equal.

## Claims check

- **Every sha256 in `evidence/T9.md` matches the tree (15/15):** request-triage.ts `fccc7d94…`, scheduler-store.ts `56763e26…`, build-runtime.ts `76c82e25…`, architect-tools.ts `efc6c25d…`, planning-tools.ts `c19f127f…`, planning-review.ts `430474b5…`, native-architect-runtime.ts `8a1b45d5…`, agent-prompts.ts `e4eadaaa…`, role-capabilities.ts `2e80c499…`, native-build-factory.ts `3df5086e…`, request-triage.test.ts `9fdcec93…`, role-capabilities.test.ts `4c1fd47c…`, planning-state.test.ts `d692c6c7…`, planning-tools.test.ts `5b76bcf9…`, planning-review.test.ts `b7a30474…`. `planning-projection.ts` is unchanged, as the evidence says.
- **Worker suites were not re-run**, per the owner's rule.
- **Prove-red reproduced: the kernel zero-mutation task-creation guard.** The auto-mode classifier refused an in-tree edit, so I ran it in a byte-identical scratch copy (`review-scratch-t9\copy\runner-v2`, `node_modules` junctioned). The worktree file was never modified; its sha256 is `56763e26…` before and after.
  - BEFORE `56763e266c6a8541c43b3d1f92a18cf7f4ab4db8ee1e9500c3a32bd478e91e7b`. The file uses CRLF.
  - Injection: `if (false && current.planningPolicyVersion === 1 && current.planningTriageDecision === "answer")` on the `plan.created` guard. `diff` shows exactly one changed line (2724).
  - DURING `40d39ca88257781a84af18c40451b2a654985b2d76ba5f5d11c306b37fba1eff`.
  - Red: `request-triage.test.ts`, 18 tests, **2 failed**. "T9 zero-mutation guards … even with a ready plan" failed with `Missing expected exception` at request-triage.test.ts:2139, meaning the forbidden creation succeeded on the synthetic ready plus answered projection. "T9 answer-path mutation attempts …" failed with `AssertionError: plan.created` at :701, meaning the direct event was refused by the T3a readiness layer with a different message. This matches the evidence's description, which cites line :2142 for the first.
  - Restored by copying the original bytes back. AFTER `56763e266c6a8541c43b3d1f92a18cf7f4ab4db8ee1e9500c3a32bd478e91e7b`, identical to BEFORE. Re-run: 18/18 pass.
- **The one-guard claim is accurate.** In the real flow the answered `plan.created` guard is defense in depth: without it, the T3a readiness gate still refuses. The dispatch, integration and final-verification guards are each the only answered-specific gate on their event and are pinned by direct-event tests.

## Commands and exact counts

- `sha256sum` over the 15 evidence files: 15/15 match.
- Probe `probe1.test.mts` (P1 stale review, P2 opt-in at handoff, P3 guidance deadlock, P4 clarify loop): 4 tests, 4 pass. The asserts demonstrate the defects, and the console output is quoted above.
- Probe `probe2.test.mts` (P5 clarify restart, P6 review crash and restart, SQLite): 2 tests, 2 pass.
- Prove-red in the scratch copy: `request-triage.test.ts` injected gives 18 tests, 16 pass, 2 fail; restored gives 18 tests, 18 pass.
- Nothing else was run: no full suite and no re-run of the worker's suites.

## Verdict

T9 REVIEW r1 — REPAIR REQUIRED — 3 blocking
