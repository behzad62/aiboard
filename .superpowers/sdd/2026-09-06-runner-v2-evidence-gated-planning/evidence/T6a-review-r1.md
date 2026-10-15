# T6a independent review — r1

Reviewer: independent (Opus). The worker (MiMo) wrote the code; I wrote none of it. I edited no source or test file and committed nothing.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `6286a9ee`. T6a is uncommitted: `build-runtime.ts` and `scheduler-store.ts` are modified; `delivery-acceptance.ts` and its two tests are untracked.
Probe file (reviewer scratch, not a deliverable): `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a\probe-t6a.test.mts`. It uses the real SQLite scheduler, evidence and session stores, an advancing clock and the real `BuildRuntime.step` pump.

## Scope

- Brief `t6a-brief.txt` (EX-3 split).
- Plan §2, §3, §5.0 (G-4, G-6, G-7, G-11), task T6 in full, and §6 rows EP10, EP12, EP20–EP26, EP31, EP34, EP36–EP38, EP42 and EP43.
- OA-3, OA-4 and OA-10.
- Carry-forwards N-R3-1 and N-R3-2 (T4-review-r3.md) and T5's caller contract.

Main question: is the deliverable review actually part of the production flow?

## Headline

The worker addressed the controller's send-back by adding pump branches to `BuildRuntime` (`build-runtime.ts:970-973`, `:1041-1046`). Those branches call an **optional** `deliveryFlow` driver.

**Nothing in production builds that driver.** `native-build-factory.ts:1300` constructs `BuildRuntime` with `coverageReview`, `answerReview`, `independentVerifier` and `planCritic`, but no `deliveryFlow`. That is the wiring pattern T3b and T9 followed at `:1113-1200`, and T6a does not follow it.

The consequence: on a new-policy run, the first worker submission throws out of `step()` and the run stays `running` (P1). The driver itself is also mostly a pass-through for caller-supplied data:
- The reviewer gets `tools: []`.
- Medium tier's "repository inspection" is a boolean.
- High tier executes no command.
- The OA-11 probe and the OA-13 report are whatever the caller passes in.
- The boundary checks are ids stamped `passed: true`.
- Prior-finding resolutions are hard-coded to `"resolved"` by the runtime.

## Requirement checklist

| Req | Verdict | Evidence |
|---|---|---|
| Submission is ready-for-review, never accepted (G-11, EP21) | **met** (pre-existing) | `submit_task` is unchanged. Acceptance is the separate `task.acceptance_recorded` event (`scheduler-store.ts:4781-4790`). |
| ONE mandatory review bound to criteria, diff, surrounding behavior and evidence — **wired into production** | **not met** | No `deliveryFlow` in `native-build-factory.ts:1300-1360`. P1: `New-policy deliverable review requires the delivery flow driver.`, 11/12 steps throw, status `running`. No role-capabilities surface exists (`role-capabilities.ts:41-44` has only inspection/expectations/coverage/answer). No candidate carries the `deliverable_review` capability the runtime requires (`delivery-acceptance.ts:175`). The reviewer has no tool surface (`tools: []` at `:197`, `:213`, `:225`) and no context pack, so "surrounding behavior and evidence" is never shown to it. |
| `selectVerifier` with the **real** `acceptedChangeAuthorRuntimeIds` (EP37) | **partial** | The author set is tracked durably on `submitted` (`scheduler-store.ts:3835-3838`). But `DeliveryReviewRuntime` selects with a **constructor-time static list** (`delivery-acceptance.ts:162`, `:178`), not the projection's list. P5: with a stale static list, a reviewer on `author-model` (the same model as the author) is recorded as `distinct_model`, and the kernel accepts it. |
| Self-review impossible (kernel) | **not met** | `scheduler-store.ts:4712`: <br>• compares the reviewer against `event.actor.id` (always `build-runtime`) <br>• compares against the **payload's** author list, not `current.acceptedChangeAuthorRuntimeIds` <br>• compares runtime ids, not canonical model identity. <br>P8: a direct `delivery.review_requested` naming `author-runtime` as a `distinct_model` reviewer with `acceptedChangeAuthorRuntimeIds: []` is **ACCEPTED**, while the projection lists `["author-runtime"]`. |
| OA-3 order: criteria + diff → findings → report → claim verdicts (EP36) | **partial** | The message order inside `DeliveryReviewRuntime.review` is correct (`delivery-acceptance.ts:203-228`), and the kernel enforces the event order request → diff → findings → report → record (`scheduler-store.ts:4735-4772`). But all six events are appended **after** the three model turns finish (`build-runtime.ts:2206-2276`), so the kernel orders a post-hoc log, not the reviewer's actual delivery. Claim verdicts are the model's raw output. T5's mechanical `unverified_claim` (`decideDeliveryClaim`) is unused in production. The projection drops `workerClaimVerdicts`, and readiness rebuilds them as `[]` (`scheduler-store.ts:1831`), so an `unverified` claim never blocks acceptance. `deliveryAcceptanceFor` (the only unverified-claim check) is used only by tests. |
| OA-10 #4: high tier, obligations before the diff (EP43) | **partial** | Correct inside the runtime (`delivery-acceptance.ts:193-201`). Kernel: the request event stores no tier. The diff-before-obligations guard (`scheduler-store.ts:4740`) fires only if `depth.tier === "high"`, and only the obligations event itself sets that. So a high-tier review that **skips** obligations passes `criteria_and_diff_delivered`. `review_recorded` then checks only the self-reported `highTierObligationsRecordedBeforeDiff` array (code read; not probed). |
| OA-4 depth tiers (EP38) | **not met** | `repositoryInspection` is a boolean derived from the tier (`delivery-acceptance.ts:235`), and the reviewer has no tools. High tier calls `computeAffectedTests` on a caller-supplied list and **executes nothing**. The OA-13 reader parses caller-supplied XML, and the OA-11 probe is a caller-supplied object copied verbatim (`:238`). P6: `fullSuiteTests: []` (which breaks T5's complete-list contract) and `probe {rung:"made-up", evidenceId:"not-an-evidence-id:T1"}` are recorded as high-tier evidence. The Gradle build-logic `fileContents` contract is not addressed. EP38 says "an arbitrary command does not satisfy high". Here no command is needed at all. |
| OA-10 #2: re-reviewer records own findings first, then checks each prior finding (EP42) | **not met** | Own-view-first message order is correct (`delivery-acceptance.ts:218-224`). But the per-finding resolution is **fabricated by the runtime**: `build-runtime.ts:2200` marks every prior finding `resolved`, with rationale "Fix delta re-review checked the prior finding.", before the reviewer runs. The reviewer is never asked for resolutions. P4: prior blocking `finding-2` recorded `resolved`, while the same re-review raised a new blocking finding. The kernel check (`scheduler-store.ts:4764-4771`) verifies only that the ids cover the prior findings. |
| Findings routed to the owning task; unrelated evidence retained; fix-delta rerun; specialist reason | **not met** | No Architect prompt, tool or context reads `deliveryReviews` (grep: only `build-runtime.ts`, `scheduler-store.ts` and `delivery-acceptance.ts`). P3: the `review_required` reason is `{type, taskId, changeSetId}` with no findings. No event sets a finding `disposition`. There is no fix-delta rerun of failed or newly affected checks, and no specialist-review reason. "Independent evidence survives an unrelated fix" is tested only at library level. |
| Integration, boundary checks on the integrated snapshot, then acceptance (EP12, EP23) | **partial** | Ordering is kernel-enforced: boundary requires `integrated` (`:4776`), and acceptance requires a matching passed boundary plus a completed review (`:4781-4788`). But `boundaryChecks` returns only ids and the runtime stamps `passed: true` (`build-runtime.ts:2301`). Nothing runs a check on the integrated snapshot. `integration-manager.ts` is untouched (G-11 says affected-boundary validation there is new T6 work). The "unverified merge" guarantee therefore rests on an unconditional literal. |
| Forged acceptance refused (direct event and replay) | **met** | Actor check `delivery-acceptance.ts:119`, used by the reducer at `:4784`. The runtime test covers the direct event and replay. The prove-red was reproduced (below). The actor check trusts the declared actor, which is the same model as earlier tasks. |
| Phase acceptance from obligations and exit checks; cancelled-only coverage open (EP24) | **not met** | `buildCompletionReadiness` demands `planning.acceptances["phase:<id>"]` (`scheduler-store.ts:1809-1813`), but **nothing computes or records phase acceptance**: there are zero `planning.acceptance_recorded` emitters in `src`. The T6a task acceptance lives in a parallel `taskAcceptances` map, not in the planning `acceptances` store that phase validation reads. The cancelled-only check exists (`finalReadyCoverageIssues`) and is wired into readiness. |
| Final-ready in `buildCompletionReadiness` beside existing gates | **partial** | Added beside the existing gates, which are not bypassed (the diff there is otherwise indentation only). But it is unreachable. P7: every fixture task accepted through the real pump, and readiness still reports `Phase BP1 lacks durable acceptance.` and `Phase BP2 …`, with 0 phase-acceptance events. Every new-policy build run is therefore permanently non-completable. |
| N-R3-1 | **met** (narrow) | The guard at `scheduler-store.ts:3670-3685` refuses contract dependency, criteria and capability rewrites through `task.revised`. It is skipped for repair tasks whose contract has left the current revision (no `revisionContract`). |
| N-R3-2 | **met** | `repairParentContractId` prefers the retained `readyPlanTaskBindings[...].contractId` and no longer requires `status === "member"`. |
| Legacy runs unchanged | **met** | Every new branch is gated on `planningPolicyVersion === 1`. The legacy completion path is identical apart from whitespace. Production does not yet emit `planning.policy_configured`, so legacy production runs are unaffected. |
| Idempotency keys deterministic, with no timestamps or reset counters | **partial** | The keys are `delivery:<task>:<attempt>:<stage>`, `boundary:<task>:<rev>` and `acceptance:<task>:<rev>`, all deterministic. But the review is not resumable: see B6. |
| Reviewer unavailable pauses with an owner-visible reason (T3b pattern, EP37) | **not met** | P2: `No independent deliverable reviewer is available.` is thrown on every step. There are no pause, `selection_required` or unavailable events, and the status stays `running`. |
| T6b seams present and named | **partial** | `T6B_REPAIR_DECISION_HOOK` and `T6B_FLAKY_ISOLATION_HOOK` are exported string constants (`delivery-acceptance.ts:44-45`) referenced only by a test. No hook exists at a repair-dispatch or failing-check site. |

## Findings

### BLOCKING

**B1 — The deliverable review exists only as a library and test driver; production never wires it.**
- Where: `native-build-factory.ts:1300` (no `deliveryFlow`), `build-runtime.ts:2185`, `:2282`, and `role-capabilities.ts` (no reviewer surface).
- Scenario: P1. Any new-policy run throws at its first submitted task, on every step.
- Minimal fix:
  - Add a `NativeDeliveryReviewRuntime` in the factory, modeled on the coverage/answer reviewers (router, candidates, models, sessions, budget/ledger, context manifests, provider health).
  - Add a `verifier:delivery` read-only inspection surface in `role-capabilities.ts`.
  - Give the reviewer a context pack with the real diff (integration-manager or change set), the criteria and recorded evidence (`inspect_evidence`, G-4).
  - Give the candidates the required capability.

**B2 — Reviewer unavailable: a throw instead of an owner-visible pause.**
- Where: `delivery-acceptance.ts:180`.
- Scenario: P2. There are 11 throws, no durable reason, and the status stays `running`. This is the exact r1 defect T3b was sent back for, and it contradicts EP37 "pause only with no eligible candidate".
- Minimal fix: return an `unavailable` result, then record it and pause through the verifier `selection_required` mechanism, as `pauseForCoverageGate` does. The owner's resume re-drives the review.

**B3 — Blocking findings are unroutable, so an integrated task crash-loops at acceptance.**
- Where: the Architect sees no findings (P3 reason payload), no event sets `disposition`, and the kernel does not require a completed deliverable review before `review.decided` or integration. The acceptance throw is at `scheduler-store.ts:4788`.
- Scenario: P3. The reviewer reports a blocking finding and the Architect (blind to it) approves. The task integrates, and then every step throws `Missing mandatory finding resolution blocks task acceptance.` (15/20 steps). The run is stuck `running`.
- Minimal fix:
  - Put the current review's findings into the Architect's `review_required` context.
  - Add an Architect disposition/routing path for findings (route to the owning task as a fix).
  - Refuse `review.decided: approved` / `integrating` in the reducer while the current submission has an unresolved blocking finding or no completed review.
  - When the pump reaches a blocked acceptance, hand control to the Architect instead of throwing.

**B4 — OA-10 #2 fix re-review: prior-finding resolutions are fabricated.**
- Where: `build-runtime.ts:2200`.
- Scenario: P4. Every prior finding is recorded `resolved` by `build-runtime` before the reviewer is invoked, and the reviewer never emits a resolution. This defeats "a fix re-review then checks each prior finding's resolution" and the missing-finding-resolution negative proof.
- Minimal fix: after the own-findings turn and the prior-findings delivery, ask the reviewer for a per-finding `{findingId, resolution, rationale}` and parse and validate it. The kernel should also require a reviewer-actor event carrying the checks.

**B5 — Depth tiers and integrated-boundary checks are asserted, not performed.**
- Where: `delivery-acceptance.ts:230-238`, `build-runtime.ts:2287-2301`.
- Scenario:
  - P6: a high-tier review records `fullSuiteTests: []` and a made-up probe id as evidence, and no command runs.
  - Medium tier's "repository inspection" is `true` with a reviewer that has no tools.
  - Boundary checks are `passed: true` for any list of ids.
- Minimal fix:
  - High tier executes the affected-test command through the runner's `run_evidence_command` / inspection path and records an evidence id. The OA-13 reader reads that recorded output, and the OA-11 probe result is a recorded `EvidenceRecord` looked up by id.
  - Reject an empty or non-root-relative full-suite list, and pass the Gradle build-logic files.
  - `boundaryChecks` returns per-check outcomes with evidence ids produced on the integrated revision (`integration-manager.ts`), and the runtime records the real pass/fail.

**B6 — A transient provider error during review stalls the run permanently.**
- Where: `delivery-acceptance.ts:183-185` (deterministic `sessionId`, fresh-context refusal of an existing session).
- Scenario: P9. One 529 on the claims turn is followed by `A fresh-context deliverable reviewer cannot reuse a session.` on every retry (9 errors). No delivery stage is recorded, and the status is `running`. In the `distinct_model` case the retry re-creates the same session id.
- Minimal fix:
  - Include a durable retry generation in the session and review identity (for example, a recorded `delivery.review_requested` generation). The T3b r3 lesson: no reset counters, no timestamps.
  - Record the request before calling the model, so a failed attempt is visible.
  - Treat provider errors as a suspension or pause, not a throw.

**B7 — Self-review is not kernel-enforced.**
- Where: `scheduler-store.ts:4712`, `delivery-acceptance.ts:162/178`.
- Scenario: P8 (a direct event making the author a `distinct_model` reviewer is accepted) and P5 (a same-model reviewer is labelled `distinct_model`).
- Minimal fix:
  - In the reducer, check the reviewer against `current.acceptedChangeAuthorRuntimeIds` and the Architect runtime, not the payload.
  - Compare canonical model identity. The reducer needs the runtime-to-model mapping recorded (for example, a model id on `worker.runtime_assigned` and on the request).
  - Refuse `distinct_model` when the model matches.
  - Pass the projection's author list into `selectVerifier` on each review instead of a constructor snapshot.

**B8 — Phase acceptance is not implemented, so final-ready is unreachable.**
- Where: `scheduler-store.ts:1809-1813`. There is no phase-acceptance computation or recorder.
- Scenario: P7. All tasks are accepted through the pump, yet readiness is permanently blocked by `Phase BP1/BP2 lacks durable acceptance.`, with 0 recorders.
- Minimal fix: compute phase acceptance from the phase's accountable requirements, their task acceptances and exit checks, and record it through the existing `planning.acceptance_recorded kind:"phase"` authority. Either unify T6a's `taskAcceptances` with the planning task acceptance, or bridge them explicitly, so there is no duplicate acceptance store (§3 "Reuse P6.5 contracts rather than introduce duplicate … stores").

### NON-BLOCKING

- **N1 — Encoding corruption.** `build-runtime.ts`, `scheduler-store.ts` and `delivery-acceptance.ts` gained a UTF-8 BOM. Every em dash in existing comments was mojibaked: 16 in `build-runtime.ts`, and all 25 in `scheduler-store.ts`, 5 of them double-encoded to `Ã¢â‚¬â€`. This is a diff-noise and history regression. Restore the original bytes outside the T6a hunks.
- **N2 — Unverified claims do not block acceptance.** `workerClaimVerdicts` is not projected (readiness hard-codes `[]`, `scheduler-store.ts:1831`), and `decideDeliveryClaim` / `deliveryAcceptanceFor` are unused outside tests.
- **N3 — Stale kernel gates.** The high-tier obligations-before-diff kernel gate depends on the obligations event itself (see the checklist). `acceptance.requiredChecks` are all stamped `passed` from the criteria list (`build-runtime.ts:2318`), and `boundary_checked` does not verify that `integrationRevision` equals the task's.
- **N4 — T6b seams are constants, not hook sites.** Name the hook at the actual repair-dispatch point and failing-check point (for example, a no-op function that is called).
- **N5 — Evidence overstates the runtime test.** T6a.md says the runtime test covers "blocking finding → rejected fix attempt". The test's fake reviewer emits only `advisory` findings, and the Architect rejects attempt 1 unconditionally.

### NOTE

- N-R3-1 does not guard repair tasks whose contract left the current revision (the guard needs `revisionContract`). This is acceptable for the carry-forward as written.
- No production path emits `planning.policy_configured` yet, so B1–B8 are latent for today's users. They are still contract breaks for T6a and would hit the first new-policy run.

## Commands and counts

| Command | Tests | Pass | Fail |
|---|---|---|---|
| `sha256sum` of the 5 changed files | — | 5/5 match T6a.md | — |
| `tsx --test probe-t6a.test.mts` (P1–P8, real SQLite + pump) | 8 | 8 | 0 |
| `tsx --test --test-name-pattern=P9 probe-t6a.test.mts` | 1 | 1 | 0 |
| Prove-red baseline, scratch copy `delivery-acceptance.test.ts --test-name-pattern="forged acceptance"` | 1 | 1 | 0 |
| Same, injected | 1 | 0 | 1 |
| Same, restored | 1 | 1 | 0 |

The probe passes record observations; each "pass" confirms the defect behavior described above.

Per the owner rule, I did not re-run the worker's green suites. The importer matrix is the controller's.

**Prove-red reproduced (forged acceptance)**
- Setup: a byte-identical scratch copy at `…\review-scratch-t6a\copy\runner-v2`. `delivery-acceptance.ts` sha256 was `23c3b96c…0d9637` in both the worktree and the copy.
- Injection: line 119 was changed to `if (false) throw new Error("Forged acceptance…`, which gives sha256 `0ad76fed…ce44f38`.
- Result: the test went RED with `AssertionError [ERR_ASSERTION]: Missing expected exception.`, because the forged Architect-actor acceptance succeeded.
- Restore: the file was restored, sha256 is back to `23c3b96cf0f6b9c33d0ce4e53c718faa070c23ef55b4e4c67c20969eae9d0637`, and the test is green again.

**SHA-256 verified**, all matching T6a.md:

| File | SHA-256 |
|---|---|
| `delivery-acceptance.ts` | `23c3b96cf0f6b9c33d0ce4e53c718faa070c23ef55b4e4c67c20969eae9d0637` |
| `build-runtime.ts` | `ca2194169e08183664e64a35454119aa39b4d4d00fa6bd57648330131f65317b` |
| `scheduler-store.ts` | `6cbbaa40f4bafbfc50f8b3e76b8c14351e887455956e20a6033090f18ff30d40` |
| `delivery-acceptance.test.ts` | `4a11a9a2f5cf0cdfb002ce798737b8a5982271f2ef59d7ef5011b5180d13141f` |
| `delivery-acceptance-runtime.test.ts` | `d0568feca9801e3722878aac8b68ba99ab4aa509a11c57f831ff9dc5d55ab9bd` |

T6a REVIEW r1 — REPAIR REQUIRED — 8 blocking
