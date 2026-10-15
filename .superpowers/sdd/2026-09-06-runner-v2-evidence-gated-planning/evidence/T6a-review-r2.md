# T6a independent review — r2

Reviewer: independent (Opus). The worker (MiMo) wrote the code and repair cycle 1; I wrote none of it and have no memory of r1. I did not edit any source or test file and committed nothing.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `6286a9ee`, T6a uncommitted.

Scratch folder (reviewer-only, not deliverables): `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a-r2\`
- `probe-r2.test.mts` holds probes Q1–Q10 and prove-red assertions PR-*.
- `prove-red.sh` and `copy\` (a byte-identical copy of `runner-v2/src` and `runner-v2/test`) were used for the prove-reds.
- `notes.md` and the `probe-run*.txt` outputs are raw logs.

## Scope

**Read:**
- The briefs `t6a-brief.txt` and `t6a-repair1.txt`.
- The r1 review and `evidence/T6a.md`.
- The full diff of `delivery-acceptance.ts`, `build-runtime.ts`, `scheduler-store.ts`, `native-build-factory.ts`, `role-capabilities.ts` and `architect-tools.ts`.
- The comment-only diffs of the T4 files.
- The relevant code in `runtime-router.selectVerifier`, `planning-review.ts` (the T3b pattern), `agent-prompts.architectContextSections`, `native-architect-runtime.context`, `sqlite-scheduler-store.append` (idempotency semantics), the two static audits, and the failing T3a tests.

**Probes:**
- Real `SqliteSchedulerStore`, `SqliteEvidenceStore` and `SqliteAgentSessionStore`, an advancing clock, and the real `BuildRuntime.step` pump.
- A delivery-flow driver shaped exactly like the one in `native-build-factory.ts`:
  - a constructor-time `acceptedChangeAuthorRuntimeIds: []`;
  - `changeAuthorModelIdentities` taken from the worker assignment;
  - real evidence records;
  - result-shaped boundary checks.
- The real factory's `build()` needs Git, ExecutionHost and worktree fixtures. I therefore read the factory closure code directly, and the probes drive a driver with the same shape.

**Tree integrity:** all 12 sha256 values matched the controller's list, both at the start and at the end (`4625ae5a 5ceb088f d6fa6808 22e285ce 10e0b46a db3a167f 3a0e8c5a c9ad2110 968e3a3d fb07ac38 3ac996e1 e4e7cf73`).

The T4 file diffs (`task-graph.ts`, `task-scheduler.ts`, `workspace-manager.ts`) are comment-only: mojibake from HEAD replaced by `—`. There is no code change.

## Verification of the r1 findings

| r1 finding | r2 status | Evidence |
|---|---|---|
| B1 production wiring | **Wired, but the wired driver is not real**; see R2-B1, R2-B3 and R2-B4 | `native-build-factory.ts:1482` passes `deliveryFlow`. The candidates get `deliverable_review` (`:861-862`) and there is a `verifier:delivery` surface. Prove-red B1: removing the wiring leaves every T6a test green (15/15), so no test goes through the production construction path. |
| B2 reviewer unavailable → pause | **Partially met** | Q8: durable `delivery.review_suspended` plus `run.paused`, and resume retries. But the pause reason is `coverage_reviewer_unavailable` (reused `pauseForCoverageGate`). Retries of a first review deadlock (R2-B5). |
| B3 findings routed; kernel refuses approval/integration | **Kernel met; Architect routing not met** | Kernel: `scheduler-store.ts:4356` (approval) and `:3792` (integrating). Prove-red B3 went red when disabled. Q5 shows dispositions work only if the caller already knows the finding ids. The production Architect never sees them (R2-B6). |
| B4 re-review resolutions from the reviewer | **Met** | Q6: every fix re-review records `priorFindingChecks` produced by the reviewer's own claims turn. The kernel checks them against `history.at(-1)` (`scheduler-store.ts:4868-4874`). |
| B5 depth and boundaries performed | **Not met** | See R2-B1 (fabricated or no-op depth evidence), R2-B2 and R2-B3 (boundary), and CF-1 (raw process). |
| B6 transient error → fresh session, bounded retry | **Not met** | See R2-B5. Q10: a `fresh_context` transient error causes an idempotency-conflict crash-loop. |
| B7 kernel self-review on recorded authors | **Met** | `scheduler-store.ts:4800` checks `current.acceptedChangeAuthorRuntimeIds` and recorded model identities. Q7 and prove-red B7 went red when disabled. Minor gap: N3. |
| B8 phase acceptance and final-ready | **Partially met** | Q1: `BP1` was accepted durably through the pump, `BP2` stayed open on `REQ-CONDITIONAL` (correct), and the kernel validation went red under prove-red B8. But acceptance is reachable only as a side effect of a task acceptance, and the exit checks are not run (R2-B8). |
| N2 unverified claims block | **Kernel met** | `assertDeliveryReviewAllowsTask` refuses on `unverified`. But the Architect cannot see the claims or disposition them (R2-B6). |
| N3 high-tier gate independent of the obligations event | **Met** | `requestedTier` is checked at `:4831`. But see R2-B7: the whole event log is written after the fact. |
| N4 T6b seams are hook sites | **Met** | `beforeRepairDecisionDispatch` (`build-runtime.ts:1235`) and `beforeFailingCheckRepairCharge` (`:1406`). |
| N1 encoding | **Met** | No BOM. The controller repaired the comment-only mojibake. |
| N-R3-1 / N-R3-2 | **Retained** | `scheduler-store.ts:3703-3716`, `:1280-1281`. |
| Legacy runs | **Unchanged** | Every new pump and kernel branch is gated on `planningPolicyVersion === 1`. The controller's matrix shows `replay-compatibility` green. |

## The 5 controller failures, diagnosed

### CF-1 (BLOCKING): 2 static-audit failures, one root cause

The failing audits:
- `static-adapter-policy.test.ts` "raw child_process access is confined to explicit audited platform adapter boundaries"
- `task8-raw-launch-closure.test.ts` "Task 8 production tree has no raw execution or ambient environment escape outside exact hosts"

**Root cause:** `native-build-factory.ts:10` adds `import { spawnSync } from "node:child_process"`. `executeAffectedTests` (`:1310-1316`) then runs `spawnSync(process.execPath, ["--test", …])` directly in a `mkdtempSync` + `cpSync` copy. That bypasses the ExecutionHost, execution grants and managed-process authority, and it is not a listed audited boundary. `native-build-factory.ts` is only allow-listed for `ambient-process-env`.

**Minimal fix:**
- Remove the `child_process` import.
- Run the high-tier affected-test command through an audited host. Two paths already exist:
  - the same `commandExecution` / `FinalVerificationRuntime` path that `finalVerificationDriver` uses (`native-build-factory.ts:1393-1415`, with `verificationWorkspace` and `managedProcessAuthority: { executionGrants, … }`);
  - or the reviewer's `run_evidence_command` (`evidence-tools.ts`) disposable-copy broker.
- Record the resulting `EvidenceRecord`.

### CF-2 (BLOCKING): 3 T3a regressions in `planning-tools.test.ts`, one root cause

The failing tests:
- "T3a repair B2: the stale-task predicate only fires when pending work is fully blocked"
- "T3a repair B3: verifier repair tasks are bound to the ready plan and dispatched by tick"
- "T3a repair B3: final-verification repair tasks are bound to the ready plan and dispatched by tick"

I ran the three by name. Each fails with `Error: Task approval requires a completed mandatory deliverable review for the current submission.` at `assertDeliveryReviewAllowsTask` (`scheduler-store.ts:1793`), called from the new `task.transitioned: integrating` guard (`scheduler-store.ts:3792`).

**Root cause:** the shared fixture `integrateReadyContractTasks` (`planning-tools.test.ts:2683-2738`) drives new-policy tasks through submitted → approved → integrating without any deliverable review. The new T6a kernel guard is the intended contract and should not be weakened. T6a simply did not migrate this importer suite.

**Minimal fix:** in the fixture, between `submitted` and `integrating`, append a kernel-valid completed review for the current submission:
1. `delivery.review_requested`
2. `delivery.criteria_and_diff_delivered`
3. `delivery.findings_recorded` (verifier)
4. `delivery.report_delivered`
5. `delivery.review_recorded` (verifier)

This could be a shared test helper. Then re-run the three tests to confirm that the repair-dispatch assertions after integration still hold.

## Prove-red records

Method: the byte-identical scratch copy, sha256 before, one guard disabled, the named probe run against the copy (`T6A_ROOT` points the probe at the copy), a byte-exact restore by copying from the worktree, and sha256 after.

| Guard | File:line (copy) | sha before | sha injected | Result | sha after |
|---|---|---|---|---|---|
| B3 kernel approval refusal | `scheduler-store.ts:4356` `if (false && decision === "approved") …` | `10e0b46a…c2ec6` | `4cc8d12f…5662b` | **RED** `PR-B3`: T1 status `'approved'`, expected `'submitted'` (the forbidden approval succeeded) | `10e0b46a…` MATCH |
| B7 recorded-author check | `scheduler-store.ts:4800` `acceptedAuthors.includes(reviewerRuntimeId)` → `false` | `10e0b46a…` | `fdccfa6e…3bea` | **RED** `PR-B7`: `Missing expected exception` (the author runtime was accepted as a `distinct_model` reviewer while the payload author list was `[]`) | `10e0b46a…` MATCH |
| B8 phase-acceptance validation | `scheduler-store.ts:4770-4771` `… && false) throw` | `10e0b46a…` | `24be61ca…9373` | **RED** `PR-B8`: `Missing expected exception` (`BP2` was accepted with `REQ-CONDITIONAL` still `conditional_pending`) | `10e0b46a…` MATCH |
| B1 factory wiring | `native-build-factory.ts:1482` `deliveryFlow,` deleted | `d6fa6808…00f86` | `75d4fc05…0b737` | **NOT RED**: `delivery-acceptance.test.ts` + `delivery-acceptance-runtime.test.ts` gave 15 tests, 15 pass. No regression test covers production wiring (N1). | `d6fa6808…` MATCH |

My first B7 injection (`false && (a) || …`) left the recorded-author clause live and stayed green. I redid it on the exact clause; only the corrected run counts.

## Findings

### BLOCKING

**CF-1 and CF-2**, as diagnosed above.

**R2-B1: The high-tier and medium-tier depth evidence is fabricated or a no-op in the production driver** (`native-build-factory.ts:1274-1335`).

- **Repository inspection is fabricated.** `repositoryInspectionEvidenceIds: [recordCommandEvidence(…, "git", ["status","--short"], { status: 0, stdout: "", stderr: "" }, …)]` (`:1308`) records a command evidence that was never executed.
- **The OA-11 probe is fabricated.** `runBreakItProbe({ files: [], …, runner: { run: async () => ({ exitCode: 0, … }) } })` (`:1318-1333`) uses a stub runner with no files, so it mutates nothing and runs nothing. It is then recorded as a `kind:"command"` evidence with exit 0.
- **The affected-test command ignores `computeAffectedTests`.** It runs `node --test` over the whole inventory (`:1313`), and not the OA-12 command.
- **The OA-13 reading is wrong.** The node TAP stdout goes through `readJUnitReport` (`:1316`), so the reading is never a real JUnit reading.
- **The recorded evidence is false.** It records `cwd: projectRoot` while the command ran in a tmp copy, and it ignores `result.error`.
- **The inventory is broken** (`collectProjectInventory`, `:1348-1363`):
  - `allFiles` and `buildFiles` are never populated, so the T5 Gradle build-logic `fileContents` contract is not addressed.
  - The test regex `/(\.test\.|\btest\b|spec)/i` matches any name containing "spec" (for example `inspector.ts`).
  - It falls back to a placeholder `/__complete_full_suite__`, which `node --test` would then try to run.
- **The runtime never checks that evidence ids exist.** `DeliveryReviewRuntime` accepts any non-empty id. Its only "real id" check is a string blacklist, `probe.evidenceId.includes("not-an-evidence-id")` (`delivery-acceptance.ts:259`).

Minimal fix:
- Run the repository inspection, the computed affected-test command and the OA-11 probe for real through the audited host (CF-1), with the real mutation runner and the changed files.
- Read the report with the reader for the format the command actually produced.
- Build the complete root-relative inventory, including `allFiles` and the Gradle build-logic contents.
- In the runtime, resolve every depth evidence id against the `EvidenceStore` before the review is recorded.

**R2-B2: The kernel records a failed integrated-boundary check as passed, so acceptance after an unverified merge is accepted.**
- Where: `scheduler-store.ts:4884` builds the boundary projection with `passed: true` regardless of `event.payload.passed`.
- Q2: after `boundaryChecks` returned `failed`, the projection showed `passed: true`. A `task.acceptance_recorded` from the legitimate `runner/build-runtime` authority was then **ACCEPTED**. `PR-B2boundary` is RED on the worktree: actual `true`, expected `false`.
- `deliveryAcceptanceReadiness` also treats that boundary as passed.
- Minimal fix: store `passed: event.payload.passed` (and the per-check outcomes). Refuse acceptance unless every check in the matching boundary passed.

**R2-B3: The integrated-boundary checks are a no-op, and a failing check livelocks the run.**
- The production "boundary checks" are `git diff-tree --name-only -r <rev>` run twice under two ids (`native-build-factory.ts:1337-1346`). They pass whenever the commit exists; nothing builds or tests the integrated snapshot (G-11 / EP23).
- On a failure, `advanceDeliveryAcceptance` appends `run.paused` with the fixed key `boundary:<task>:<rev>:blocked` (`build-runtime.ts:2345`).
- Q2: after the owner resumes, that pause is deduplicated. The run stays `running` while `step()` returns `paused`, and the checks are re-run on every step (7 calls). Nothing routes the failure to the Architect or to a repair.
- If a re-run produces a different outcome, `boundary:<task>:<rev>` (`:2341`) hits an idempotency conflict (`sqlite-scheduler-store.ts:113-125`).
- Minimal fix:
  - Run the required affected boundary validations (affected tests / combined validation) on the integrated revision through the audited verification workspace.
  - Make the boundary and pause keys attempt-scoped, for example by durable check generation.
  - Route a failing boundary to the Architect or to a repair (the T6b flaky seam) instead of a bare pause.

**R2-B4: The reviewer's tool surface is advertised but never executed; a reviewer that uses its tools stalls the run permanently.**
- `DeliveryReviewRuntime.review` makes exactly three `model.complete` calls and parses text only (`delivery-acceptance.ts:216/232/244`, `parseJsonTurn`). No tool loop exists.
- Q4: a findings turn containing a `tool_use` block gives `Deliverable reviewer returned no parseable findings.` The run pauses with `coverage_reviewer_unavailable` and stays paused after every resume, with 0 tasks accepted.
- Medium- and high-tier "repository inspection" by the reviewer is therefore impossible in production.
- Minimal fix: run each stage as an agent-loop session with the `verifier:delivery` tools, as the coverage and answer reviewers do. Give it tier-appropriate tools (low tier read-only; see N4).

**R2-B5: Review retries deadlock (B6 not fixed), including the common two-model configuration.**
- **The retry generation never advances for a first review.** `delivery.review_started` and `delivery.review_suspended` only update an existing `deliveryReviews[task]` record (`scheduler-store.ts:4781-4788`). A first review has no record, so `retryGeneration` stays at 1 (`build-runtime.ts:2192`), and every retry reuses the same `reviewId` and session id. The next failure appends `${reviewId}:suspended` (`:2214`) with a different `detail`, which is an idempotency conflict thrown out of `step()` on every step.
- **Q10**: a `fresh_context` reviewer hit one transient 529 on its claims turn. The result: `Scheduler idempotency conflict for delivery:T1:1:retry:1:suspended.` on every step, status `running`, 0 accepted.
- **Q9a (one model) and Q9b (Architect model X plus worker model Y, both verifier candidates):**
  - `selectVerifier` returns `fresh_context` on `architect-runtime`, which is correct by design.
  - `assertDeliveryReviewOrder` refuses that pairing, `reviewer cannot be the Architect runtime` (`delivery-acceptance.ts:72`). The kernel allows it (Q7).
  - The retry then gives the same idempotency-conflict crash-loop, with 0 accepted.
  - Every setup without a third distinct model can therefore never pass a deliverable review.
- There is no bounded transient retry: the first error pauses.
- Minimal fix:
  - Make `delivery.review_started` create or advance a durable generation even when no record exists, and derive `reviewId` and `sessionId` from it.
  - Make runtime independence match `selectVerifier` and the kernel. `fresh_context` on the Architect's model with a new empty session is the specified fallback; if a policy excludes the Architect runtime, pass it via `excludedRuntimeIds` so selection and validation agree.
  - Retry transient errors a bounded number of times before pausing.

**R2-B6: The Architect never sees the reviewer's findings or claim verdicts, so it cannot route or disposition them (B3 routing, N2).**
- The `review_required` reason is still `{type, taskId, changeSetId}` (`build-runtime.ts:980`; Q1 shows the keys).
- `architectContextSections` includes `projection.reviews` but not `deliveryReviews` (`agent-prompts.ts:527-539`).
- The Architect therefore cannot know the finding ids that `review_task.findingDispositions` requires. It gets only the kernel refusal text (Q5b: `Unresolved blocking deliverable findings prevent task approval or integration.`, and the Architect returns without a typed action).
- There is no disposition path at all for an `unverified` worker claim. The only escape is reject → re-attempt until `maxTaskAttempts`, so a false-positive finding or claim fails the task.
- `evidence/T6a.md` says "The request/projection exposes findings and unverified claims to the Architect". The projection holds them; the Architect's context does not.
- Minimal fix:
  - Add the current delivery review (finding ids, severity, claim, evidence refs, claim verdicts, prior checks) to the `review_required` reason and context.
  - Add an Architect disposition for unverified claims, or a route that says how an unverified claim is resolved.

**R2-B7: The OA-3 and OA-10 #4 review order is not kernel-enforced; it is a log written after the fact.**
- All six delivery events are appended by `appendDeliveryReviewEvents` after the three model turns finish (`build-runtime.ts:2217`). The `verifier`-actor events (obligations, findings, review) are written by `build-runtime` impersonating the reviewer.
- The `verifier:delivery` surface has no record tools (`role-capabilities.ts`, second argument `[]`).
- The kernel therefore orders a log that the same runtime writes. It cannot stop the diff or the report from reaching the model before the findings or obligations are durable. A crash between turns leaves no record.
- T3b's pattern (`planning-review.ts:623`, `recordPlanDelivered`) records the reviewer's own view durably, through the authority, before the kernel releases the next input.
- Minimal fix:
  - Record obligations (high tier), then diff delivery, then findings, then report delivery, each at the moment it happens and between turns, through a reviewer record tool or authority.
  - Deliver the diff or the report only after the kernel has accepted the preceding record.

**R2-B8: Phase acceptance is reachable only as a side effect of a task acceptance, and its exit checks are not performed.**
- **Single trigger.** `recordPhaseAcceptancesIfReady` has exactly one call site, `advanceDeliveryAcceptance` (`build-runtime.ts:2367`).
- **Unreachable after a later resolution.** A phase that becomes acceptable only later is never recorded. For example, the fixture's `REQ-CONDITIONAL` (`accountablePhaseId: BP2`) is resolved by a later ready revision after the investigation task `T-INV` is accepted, and no further task acceptance follows. Final-ready is then unreachable.
  - This is code-read: plan revisions keep already-accepted tasks, so no new task acceptance occurs.
  - Q1 shows `BP2` still open after every task was accepted.
- **Exit checks are text, not checks.** `exitCheckIds: phase.exitCriteria` (`:2388`) records the phase's exit-criterion prose as passed "check ids". `requiredCombinedValidation` (`["typecheck","targeted-tests"]`) is ignored, and nothing runs.
- **The key is not revision-bound.** `phase-acceptance:<phaseId>` means a changed phase in a later revision keeps its stale acceptance, and re-acceptance with a different payload is an idempotency conflict.
- Minimal fix:
  - Evaluate phase acceptance in the pump whenever no phase-accepted state matches the current revision, not only after a task acceptance.
  - Run the phase's combined validation / exit checks on the integrated snapshot and record their evidence ids.
  - Key and bind phase acceptance to the plan revision.

### NON-BLOCKING

- **N1: No regression test goes through the production construction path.** Prove-red B1 is not red, and the brief required it. `delivery-acceptance-runtime.test.ts` builds its own driver with invented evidence ids (`affected:T1`, `probe:T1`, `repository:T1`) and never asserts final readiness or phase acceptance. `evidence/T6a.md` calls it "production-shaped factory dependencies".
- **N2: The pause reason for every delivery-review pause is `coverage_reviewer_unavailable`** (via `pauseForCoverageGate`, `build-runtime.ts:2215`). This is not owner-legible for a deliverable review, and Q8 recorded an unavailable reviewer as `delivery_review_provider_error`.
- **N3: The kernel's `distinct_model` model-identity check is skipped when `reviewerModelIdentity` is absent** (`scheduler-store.ts:4800`; Q7 `same-model-no-identity` was ACCEPTED). The kernel should require the identity for `distinct_model`.
- **N4: Low tier gives the reviewer `run_evidence_command`.** It gets the same `verifier:delivery` tools at every tier (`native-build-factory.ts:1244`), while OA-4 low tier is read-only.
- **N5: `task.acceptance_recorded.requiredChecks` stamps every criterion `outcome:"passed"`** (`build-runtime.ts:2362`), independent of the reviewer's claim verdicts.
- **N6: Dead or suspicious fallbacks.**
  - `reviewerPriorFindingChecks` falls back to caller-supplied `input.priorFindingChecks` when the claims turn is an array (`delivery-acceptance.ts:248`). `build-runtime` never passes it, but the fallback reopens B4 if a caller ever does.
  - The `"not-an-evidence-id"` blacklist (`:259`).
- **N7: `delivery.review_started` embeds the run-global `acceptedChangeAuthorRuntimeIds` in an idempotent payload** (`build-runtime.ts:2237`). Combined with R2-B5's reused `reviewId`, a retry after another task's submission (concurrency above 1) is another idempotency conflict.
- **N8: The factory adds new `mkdtempSync`, `cpSync` and `rmSync` temp sites** (`:1311-1314`, `:1327-1328`). The brief left OA-17 temp-path cleanup and mkdtemp sites to T6b. The `.git` substring filter also drops `.github` and `.gitignore`.

### NOTE

- B4 (reviewer-owned prior-finding checks), B7 (recorded-author kernel check) and the forged-acceptance actor check are genuinely fixed. The T6b seams are real call sites.
- Legacy runs are unaffected, since every new path is gated on `planningPolicyVersion === 1`.
- A direct `task.transitioned: approved` by the Architect is not guarded; only `review.decided` and `integrating` are. `integrating` still blocks, so this is not exploitable today.

## Commands and counts

| Command | Tests | Pass | Fail |
|---|---|---|---|
| sha256 of the 12 files, start and end | — | 12/12 match both times | — |
| `tsc -p runner-v2/tsconfig.json --noEmit` | — | exit 0 | — |
| `tsx --test delivery-acceptance.test.ts delivery-acceptance-runtime.test.ts` (worktree) | 15 | 15 | 0 |
| `tsx --test --test-name-pattern="T3a repair B[23]" planning-tools.test.ts` (diagnosis only) | 3 | 0 | 3 (same error, CF-2) |
| `probe-r2.test.mts` Q1–Q8 (observational; each pass records behavior) | 8 | 8 | 0 |
| `probe-r2.test.mts` Q9–Q10 | 2 | 2 | 0 |
| `probe-r2.test.mts` `^PR-` on the worktree | 4 | 3 (B3, B7, B8) | 1 (`PR-B2boundary`, the R2-B2 defect) |
| Prove-red B3 / B7 / B8 on the scratch copy (injected) | 1 each | 0 | 1 each (red as intended) |
| Prove-red B1 (injected copy): the two T6a suites | 15 | 15 | 0 (not red; N1) |

I did not re-run the controller's full matrix of 74 files and 1068 tests (1063 pass, 5 fail).

`T6a REVIEW r2 — REPAIR REQUIRED — 10 blocking`
