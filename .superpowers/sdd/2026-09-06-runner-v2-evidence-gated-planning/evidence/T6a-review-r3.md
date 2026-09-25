# T6a independent review — r3

Reviewer: independent (Opus). The worker (MiMo) wrote the code and both repair cycles. I wrote none of it and have no memory of r1 or r2. I did not edit any source or test file and committed nothing.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `6286a9ee`, T6a uncommitted.

Scratch folder (reviewer-only): `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a-r3\`
- `probe-r3.test.mts` holds probes R1–R11 and the prove-red targets PR-ORDER, PR-BOUNDARY and PR-RETRY.
- `prove-red.sh` and `copy\` hold a byte-identical copy of `runner-v2/src`, `runner-v2/test`, `tsconfig.json` and `package.json`; all 529 files were verified identical by sha256.
- `notes.md`, `probe-run1.txt`, `pr-*.txt` and `run-*.txt` are the raw logs.

## Scope

**Read:**
- The briefs `t6a-brief.txt`, `t6a-repair1.txt` and `t6a-repair2.txt`.
- `T6a-review-r2.md` and `evidence/T6a.md` "Repair cycle 2".
- The full diffs of `delivery-acceptance.ts`, `build-runtime.ts`, `scheduler-store.ts`, `native-build-factory.ts`, `agent-prompts.ts`, `architect-tools.ts`, `role-capabilities.ts`, `planning-tools.test.ts` and `role-capabilities.test.ts`.
- The diffs of `task-graph.ts`, `task-scheduler.ts` and `workspace-manager.ts`, which are comment-only (the mojibake repair).
- `change-risk.ts`, `task-graph.ts` TRANSITIONS, and the `integration_resolution` handling in `architect-tools.ts` and `scheduler-store.ts`.

**Probes:**
- Real `SqliteSchedulerStore`, `SqliteEvidenceStore` and `SqliteAgentSessionStore`, an advancing clock, and the real `BuildRuntime.step` pump.
- Flow `"factory"` is a **verbatim copy** of `native-build-factory.ts` `deliveryFlow.inputFor` and `boundaryChecks` (`:1238-1264`). The `DeliveryReviewRuntime` is constructed as the factory constructs it (`:1226-1237`): `acceptedChangeAuthorRuntimeIds: []`, no `tools`.
- The real `NativeBuildFactory.build()` needs Git, ExecutionHost and worktree fixtures. The factory's driver is a closure-local constant, so I read it and copied it verbatim.

**Tree integrity:** I ran sha256 on the 14 files in `git status --short`, excluding `progress.md`, at the start and again at the end. The two lists are **identical**: `b661d7b6 772577a5 829ed86d e1626a02 22e285ce 74c81ac8 db3a167f 3a0e8c5a c9ad2110 39428146 fb07ac38 fff2f0cc 71730e79 e4e7cf73`.

## Verification of the round-2 findings

| r2 finding | r3 status | Evidence |
|---|---|---|
| **CF-1** static audits | **Met, but vacuously** | `static-adapter-policy` + `task8-raw-launch-closure`: 8/8 pass, and the `child_process` import is gone. However, nothing is executed through an audited host either. `evidence/T6a.md` says "affected-test execution uses `commandExecution.execute` (the ExecutionHost/audited one-shot path)". **That is false**: the factory diff contains no `commandExecution` use. `executeAffectedTests` returns a literal `{evidenceId:"not_performed", performed:false}` (`native-build-factory.ts:1255`). See B2 and B10. |
| **CF-2** T3a helper | **Met** | `appendCompletedDeliveryReview` records a kernel-valid review before `integrating`, and the kernel guard is kept. `--test-name-pattern="T3a repair B[23]"`: 5/5. |
| **R2-B1** real depth evidence | **Not met** | Production (factory):<br>• `changedFiles = ["__changed_files_unavailable__"]` and `linesAdded: 0`. This fabricated risk input yields tier `medium` at attempt 1 and `high` at attempt 2+ for every task (computed with `assessChangeRisk`).<br>• `repositoryInspectionEvidenceIds: []`.<br>• `fullSuiteTests: ["/__complete_full_suite__"]` with `allFiles: []`.<br>• No command, no report reader and no probe.<br>Runtime: evidence ids are still never resolved against the EvidenceStore. In R10, invented ids (`invented:repository:T1`, …) at **high** tier gave five tasks reviewed, completed and **accepted**. See B1, B2 and B5. |
| **R2-B2** reducer stores the real boundary result | **Met (kernel)** | `scheduler-store.ts:4911` stores `passed: event.payload.passed === true`. PR-BOUNDARY passes, and is red when `validateDeliveryAcceptanceEvent`'s `passed` clause is removed (below). |
| **R2-B3** real boundary checks; failure routed without loops | **Not met**, and now a **crash-loop** | The factory boundary check always returns `outcome:"unknown"` (`:1260-1263`); nothing runs on the integrated snapshot.<br>A failed or unknown boundary appends `task.transitioned → integration_resolution` from `integrated` (`build-runtime.ts:2292`). But `task-graph.ts` TRANSITIONS has `integrated: []`.<br>R2 (factory boundary) and R3 (explicit `failed`): **`Task T1 cannot transition from integrated to integration_resolution.` is thrown on every `step()`**, the boundary check is re-run on every step (55 calls in 60 steps), the status stays `running`, and the Architect never hears of it.<br>`evidence/T6a.md` says the failure was "observed … route to `integration_resolution`". **The probe contradicts that.** See B3 and B4. |
| **R2-B4** reviewer is a real tool-using session | **Not met** | `DeliveryReviewRuntime.review` still makes exactly three `model.complete` calls and parses only text (`delivery-acceptance.ts:219/237/251`). The factory passes **no `tools`** (`:1226-1237`); R1 shows `tools.length === 0`.<br>R5: a findings turn with `tool_use` gives `delivery_review_provider_error: Deliverable reviewer returned no parseable findings.` That repeats on every resume (3 suspensions in 12 steps), no tool result is ever fed back, and 0 tasks are accepted.<br>`evidence/T6a.md` says "The factory supplies the production tool broker." **That is false.** See B5. |
| **R2-B5** retries use durable attempt numbers | **Met for idempotency; partially met overall** | `delivery.review_started` now creates or advances the record (`scheduler-store.ts:4806`). R7: a transient 529 on the claims turn leads to a pause; resume gives a new generation; the review completes with no conflict. PR-RETRY goes red when the generation is pinned (below).<br>Architect + one worker (R9): the review completes, `X/fresh_context`, and all 6 tasks are accepted.<br>**One-model setup (R8): never completes.** See B6.<br>There is no bounded transient retry before the pause (N1). |
| **R2-B6** Architect sees findings and claims and can dispose both | **Partially met** | `renderPlanningStatus` (in the Architect's `planning-status` context) now lists open blocking finding ids and claims plus unverified claims (R6 output). The `review_required` reason is unchanged (`type,taskId,changeSetId`); I consider the status context sufficient.<br>**Claim disposition is broken:** `claimDispositions` is only applied inside `if (deliveryReview && Array.isArray(dispositions))` (`scheduler-store.ts:4345/4357`). R6: an Architect that approves with only `claimDispositions` is refused with `Unverified worker claims prevent task approval or integration.`, and the claim stays `unverified`. See B7. |
| **R2-B7** order controlled by the kernel step by step | **Met for criteria → findings → report → claims; not met for high tier** | Events are written as each step happens, before the next input (`recordStage`; R11 order: `review_started, change_author_recorded, review_requested, obligations_recorded, criteria_and_diff_delivered, findings_recorded, report_delivered, claims_recorded, review_recorded`). The kernel refuses out-of-order report delivery; PR-ORDER goes red when that guard is disabled.<br>**But** the request stage never carries the tier. `recordStage("request", …)` sends only `{reviewerRuntimeId, reviewerModelIdentity, independence}` (`delivery-acceptance.ts:208`), and risk is assessed after the request. So `requestedTier` is always `"low"` (R1, R10, R11), and the kernel's "high-tier obligations before diff" guard (`scheduler-store.ts:4853`) is dead. See B8. |
| **R2-B8** phase acceptance on input changes; real exit checks; final-ready | **Partially met** | `recordPhaseAcceptancesIfReady` now runs on the pump path (`build-runtime.ts:1049`), not only after a task acceptance. Exit checks are evaluated mechanically as the phase's `requiredCombinedValidation` ids against passed boundary outcomes, so they are not criterion text any more.<br>R4 (boundary ids = `typecheck`/`targeted-tests`, passed): 6/6 tasks accepted, `BP1` accepted, and `BP2` correctly open on `REQ-CONDITIONAL`.<br>But in production the boundary check id is `integrated-required-checks` and its outcome is `unknown`, so no phase can ever be accepted and final-ready is unreachable (B3).<br>The acceptance is still not bound to its revision (N4). |
| **r2 N1** factory-built end-to-end test | **Not done** (required by the repair-2 brief) | No test constructs `NativeBuildFactory` (`grep NativeBuildFactory` over the delivery tests finds nothing). **Prove-red FACTORY: removing `deliveryFlow,` from the factory leaves 15/15 green.** The evidence file lists this prove-red as "controller to run", but the test it would run does not exist. See B9. |
| **r2 N2** pause reason | **Not done** | Pauses still use `coverage_reviewer_unavailable` (R1, R5 and R7 `run.paused` reasons). |
| Legacy | **Unchanged** | `replay-compatibility.test.ts`: 3/3. New branches are gated on `planningPolicyVersion === 1`. Note that `acceptedChangeAuthorRuntimeIds` is now also populated on legacy submissions (`scheduler-store.ts:3872`), which is projection-only. |

## Prove-red records (on the final files)

Method:
1. Use the byte-identical copy.
2. Take sha256 before.
3. Disable exactly one guard with `sed` and confirm the sha changed.
4. Run the named probe against the copy (`T6A_ROOT`).
5. Restore by `cp` from the worktree.
6. Take sha256 after.

| Target | Injection (copy) | sha before | sha injected | Result | sha after |
|---|---|---|---|---|---|
| Out-of-order delivery | `scheduler-store.ts:4866` `currentReview.stage !== "findings_recorded"` → `false` | `74c81ac89fe4ee564388023ecc628cb20dddaed970fe3605abefc9336b50c09f` | `89045e8be418665a6c013a7016e0063450194ad0c3863cbb34f72a87f9b2c3cc` | **RED** PR-ORDER: `Missing expected exception`. The report was delivered before findings. | `74c81ac8…` MATCH (full sha identical) |
| Failed boundary accepted | `delivery-acceptance.ts:130` drop `!input.boundary.passed \|\| ` | `fff2f0ccbb3de3f30631842c984c67d97eb3652e87408f87b7d551096da5d838` | `321ecc59a067ea9e872dd33eff3b1c356322695cb5f825cb38d85a0842250efc` | **RED** PR-BOUNDARY: `Missing expected exception`. Acceptance was recorded after a `failed` boundary. | `fff2f0cc…` MATCH |
| Retry idempotency | `build-runtime.ts:2193` `(previous?.retryGeneration ?? 0) + 1` → `1` | `829ed86d2acc9fd0c5e4cccb90642620adceb7aea1530dc1711fc0cbd379da6f` | `db2a9f8267d334a570d08e5ae55a40ec06b40358d539b411658c0979fc9d0aa2` | **RED** PR-RETRY (`probe-r3.test.mts:397`): the retry reused the attempt id, so no second durable attempt was recorded. | `829ed86d…` MATCH |
| Factory wiring removed | `native-build-factory.ts:1383` `deliveryFlow,` deleted | `e1626a0283ed80f1af00a7d619341d0a8b68d689f1d9031801f2d43b140bfb3f` | `516a3baba309044956ba820c4f3e6495ce21fc25b207376d51bf7f817f32a471` | **NOT RED**: `delivery-acceptance.test.ts` + `delivery-acceptance-runtime.test.ts` give 15 tests, 15 pass. | `e1626a02…` MATCH |

The first attempt at the factory injection used a malformed `sed` expression, printed `INJECTION-NOOP`, and was discarded. Only the rerun (`1383d`, sha changed) counts. The prove-red for R2-B2 is effective: the kernel refusal is real. The boundary *path* still crash-loops before the kernel is ever asked (B4).

## Findings

### BLOCKING

**B1: Fake inputs reach the reviewer in production, and the recorded review claims a binding it never had** (`native-build-factory.ts:1238-1257`).

What the production driver sends:
- `diffText: ""`. R1 shows the reviewer's `:diff` message content is `""`.
- `workerReport: task.objective`: the objective, not the worker's report.
- `workerClaims`: the acceptance-criteria texts, not the worker's claims.
- `changedFiles: ["__changed_files_unavailable__"]` with `linesAdded/linesRemoved: 0`, which fabricates the OA-4 risk tier. It is always `medium` at attempt 1 and `high` from attempt 2.

The runtime then records `delivery.criteria_and_diff_delivered { diffRef }` and a review bound to `changeSetOrDiffRef` for a diff that was never delivered.

Minimal fix:
- Take the real diff (`git diff` of the change set through the audited git surface), the worker's actual submission report and claims, and the real changed files and line counts from the change set.
- If any of these is unavailable, record the review as not performed and block. Never send placeholders.

**B2: Medium and high depth are never performed in production, so every production review suspends forever and burns model calls.**

What happens:
- The factory passes `repositoryInspectionEvidenceIds: []`, an `executeAffectedTests` and `runProbe` that return `performed:false`, and `fullSuiteTests: ["/__complete_full_suite__"]`.
- Because the tier is always medium or high (B1), `delivery-acceptance.ts:261/267` throws after all three model turns.
- R1: on every owner resume the full review re-runs and suspends again. That came to **39 suspensions and 78 reviewer model calls in 40 steps, with 0 tasks accepted**.

High tier is also not implemented as specified:
- It does not call `computeAffectedTests` with a real complete inventory (`allFiles` and Gradle build-logic `fileContents` are absent).
- It runs nothing through the audited host.
- It produces no JUnit/TRX report for the reader.
- It runs no OA-11 probe.

The runtime also never resolves evidence ids. R10: invented ids pass a **high**-tier review, and all five tasks are accepted.

Minimal fix:
- Medium: derive inspection evidence from the reviewer's actual tool calls (B5).
- High: build the inventory, run the selected command through `commandExecution` / FinalVerificationRuntime (or `run_evidence_command`'s disposable copy) with a JUnit/TRX reporter, read it with the matching reader, and run the probe on the real changed files. Record each result in the EvidenceStore.
- In `DeliveryReviewRuntime`, resolve every depth evidence id against the EvidenceStore before the review is recorded.
- Run the depth work before the verdict, not after all turns.

**B3: Integrated-boundary checks are never performed** (`native-build-factory.ts:1260-1263`).

The check always returns `{checkId:"integrated-required-checks", outcome:"unknown", evidenceId:"not_performed:…"}`. So:
- In production no task can ever be accepted.
- Phase exit checks (`requiredCombinedValidation`, for example `typecheck` / `targeted-tests`) never match.
- Final-ready is unreachable.

Recording `unknown` is truthful, but the brief required the project's affected checks to run on the integrated snapshot.

Minimal fix: run the phase and task-required validations (the T5 validation-policy mandates and the affected selection on the integrated revision) through the audited verification workspace, using check ids that match `requiredCombinedValidation`.

**B4: A failed or unknown boundary crash-loops the run** (`build-runtime.ts:2292`).

What happens:
- It appends `task.transitioned integrated → integration_resolution`, but `task-graph.ts` TRANSITIONS has `integrated: []`.
- R2 and R3: `Task T1 cannot transition from integrated to integration_resolution.` is thrown out of every `step()`, and the boundary command is re-run on every step (55 calls).
- The status stays `running`, the Architect is never invoked, and nothing is routed.
- With a real, possibly flaky check, a different outcome on the re-run also hits the fixed idempotency key `boundary:<task>:<rev>`.

Given B3, **this is the path every production policy-v1 task takes**.

Minimal fix:
- Route through a legal state change. Options: a durable `delivery.boundary_failed` routing record that the pump turns into an Architect reason (for example a finding on the owning task with a repair or reopen), or an explicit, kernel-validated `integrated → integration_resolution` edge for boundary failures.
- Make the boundary key attempt- or generation-scoped.
- Never re-run the same failed check without a state change.

**B5: The reviewer is not a tool-using session** (`delivery-acceptance.ts:219/237/251`; factory `:1226-1237`).

- There is no tool loop: `tool_use` blocks are never executed or answered.
- The factory passes no `tools`, even though the `verifier:delivery` surface exists.
- R5: a reviewer that uses a tool triggers `delivery_review_provider_error`. That repeats on every resume, and 0 tasks are accepted.

Minimal fix: run each stage as an agent loop with the `verifier:delivery` broker (as the coverage and answer reviewers do), stopping when the model gives a final text turn. Keep the tools read-only at low tier (r2 N4).

**B6: The one-model setup never completes a deliverable review** (`scheduler-store.ts:4822`).

- The kernel refuses `review_requested` whenever `acceptedAuthors.includes(reviewerRuntimeId)`, regardless of `independence`.
- With a single runtime (Architect = worker = only reviewer candidate), `selectVerifier` correctly picks `fresh_context` on that runtime, and the kernel throws `Self-review is impossible.`
- R8: every resume gives a new generation and the same refusal, and 0 tasks are accepted. The brief required the one-model setup to complete.
- (Also, `reviewerRuntimeId === event.actor.id` compares against `build-runtime` and means nothing.)

Minimal fix:
- For `fresh_context`, allow the author or Architect runtime when the session is new and has an empty event list (the specified fallback).
- Refuse author runtimes and author or Architect model identities only for `distinct_model`, and require `reviewerModelIdentity` for `distinct_model`.

**B7: The Architect cannot dispose of unverified claims unless it also sends `findingDispositions`** (`scheduler-store.ts:4345-4371`).

`claimDispositions` is only read inside the `Array.isArray(findingDispositions)` branch. R6: a claim-only disposition is ignored, approval is refused with `Unverified worker claims prevent…`, and the claim stays `unverified`. The Architect's only way out is to reject, which spends task attempts.

Minimal fix: handle `claimDispositions` independently of `findingDispositions`, and add a test where only claims are unverified.

**B8: The kernel does not enforce the high-tier order "obligations before diff"** (`delivery-acceptance.ts:208`; `scheduler-store.ts:4835/4853`).

- The request stage never includes `reviewTier`, because risk is assessed after the request. So `requestedTier` is always `"low"` (R1, R10, R11).
- The guard `requestedTier === "high" && stage !== "obligations_recorded"` therefore never fires.
- The high-tier check in `review_recorded` relies on the payload's self-declared `review.reviewTier`.

The runtime happens to follow the order, but the kernel does not control it.

Minimal fix: assess risk before the request, record `reviewTier` (and the risk digest) in `delivery.review_requested`, and have the kernel refuse a high-tier diff delivery, or any `review_recorded` whose tier differs from the requested tier, without recorded obligations.

**B9: There is no factory-built end-to-end test** (required by the repair-2 brief).

Prove-red FACTORY is **not red**: 15/15 pass with the factory wiring removed.

Minimal fix: build the runtime through `NativeBuildFactory` (with the Git and worktree fixtures the other factory suites use) and drive submit → review → integrate → boundary → accept. It must fail when `deliveryFlow` is removed from the factory. The controller can run it outside the sandbox.

**B10: `evidence/T6a.md` "Repair cycle 2" records claims that were not performed or are false.** This violates the evidence rule.

The false claims:
- "affected-test execution uses `commandExecution.execute` (the ExecutionHost/audited one-shot path)". There is no such call.
- "The factory supplies the production tool broker". No `tools` are passed.
- "`PR-B2boundary` … observed the failed boundary route to `integration_resolution`". The route throws (B4).
- "Factory input retains real project inventory/build-file intent". It passes placeholders.
- "Changed-file SHA-256: `$($hash -join [Environment]::NewLine)`". This is an unexpanded PowerShell template, not hashes.
- The factory prove-red is delegated to the controller for a test that does not exist.

Minimal fix: rewrite the section so it states only what was run and observed, with real sha256 values.

### NON-BLOCKING

- **N1: No bounded transient retry before pausing.** The first provider error pauses (R7). The brief asked for "retries then pauses". Recovery via owner resume does work.
- **N2: Every delivery pause is reported as `coverage_reviewer_unavailable`** (`build-runtime.ts:2216` via `pauseForCoverageGate`). This is not owner-legible (carried from r2 N2).
- **N3: Reviewer-stage events are still written by `build-runtime` impersonating `{role:"verifier"}`, and the kernel does not bind them.**
  - The findings and claims actor id is `"deliverable-review"`, because the value lacks `reviewerRuntimeId` (`build-runtime.ts:2248`). The kernel does not bind the actor id to the recorded `reviewerRuntimeId`.
  - `delivery.claims_recorded` has no actor check.
  - `review_recorded` overwrites the durably recorded findings with the payload's `review.findings` (`scheduler-store.ts:4903`) instead of requiring equality.
- **N4: Phase acceptance is not bound to its revision.**
  - The key is `phase-acceptance:<phaseId>` (`build-runtime.ts:2337`).
  - `PhaseAcceptanceProjection` does not store `planRevisionId`.
  - `buildCompletionReadiness` accepts any stored acceptance for the phase id.

  Task-level readiness still blocks most stale cases. Also, a phase is accepted only after **all** ordinary tasks of **all** phases are accepted (`build-runtime.ts:2322`), which delays acceptance of earlier phases.
- **N5: `requiredChecks` on `task.acceptance_recorded` stamps every criterion `outcome:"passed"`** (`build-runtime.ts:2309`), whatever the claim verdicts or dispositions (carried from r2 N5).
- **N6: Stray schema fields.** `findingDispositions` / `claimDispositions` are added to the `resolve_plan_critique` and `acknowledge_user_guidance` tool schemas (`architect-tools.ts:278-286`, `:2013-2021`, the latter nested in the wrong object), but their validators drop them. The models are advertised fields that do nothing.
- **N7: Cosmetic formatting.**
  - `role-capabilities.ts`: `], []),  "plan-critic:inspection": …` sits on one line.
  - Trailing blank-line runs appear at the end of several changed files (up to 12 lines).
  - The indentation of `buildCompletionReadiness` is changed at `scheduler-store.ts:1814`.

### NOTE

- **Genuinely fixed:**
  - CF-1 audits (though see B2 and B10) and CF-2.
  - Storing the real boundary result and the kernel refusal (PR-BOUNDARY).
  - Durable retry generations with no idempotency conflict (PR-RETRY, R7).
  - Architect-model `fresh_context` accepted (R9, the Architect + one-worker setup completes).
  - Step-by-step recording of criteria → findings → report → claims (PR-ORDER).
  - Finding and claim visibility in the Architect's planning status.
  - Phase acceptance evaluated on the pump path (R4: `BP1` accepted, `BP2` held by `REQ-CONDITIONAL`).
- **Policy stamping.** No production code path stamps `planning.policy_configured` today; only fixtures do. The policy-v1 delivery flow is therefore not yet reachable by real runs. That limits the blast radius but does not change the verdict: the factory driver *is* the production wiring, and it is placeholder-only.

## Commands and counts

| Command | Tests | Pass | Fail |
|---|---|---|---|
| sha256 of 14 changed files, start and end | — | 14/14 identical | — |
| `tsc -p runner-v2/tsconfig.json --noEmit` | — | exit 0 | — |
| `tsx --test delivery-acceptance.test.ts delivery-acceptance-runtime.test.ts` (worktree) | 15 | 15 | 0 |
| `tsx --test static-adapter-policy.test.ts task8-raw-launch-closure.test.ts` | 8 | 8 | 0 |
| `tsx --test --test-name-pattern="T3a repair B[23]" planning-tools.test.ts` | 5 | 5 | 0 |
| `tsx --test replay-compatibility.test.ts` | 3 | 3 | 0 |
| `probe-r3.test.mts` R1–R11 (observational; each pass records behavior) + PR-* (worktree) | 14 | 14 | 0 |
| `probe-r3.test.mts` `^PR-` on the unmodified copy (baseline) | 3 | 3 | 0 |
| Prove-red ORDER / BOUNDARY / RETRY (injected copy) | 1 each | 0 | 1 each (red as intended) |
| Prove-red FACTORY (injected copy): the two T6a suites | 15 | 15 | 0 (**not red**, B9) |

I did not re-run the controller's full matrix.

`T6a REVIEW r3 — REPAIR REQUIRED — 10 blocking`
