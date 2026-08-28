# Runner V2 Robust Build Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan phase by phase and `superpowers:test-driven-development` for every implementation packet.

**Goal:** Strengthen Runner V2 for robust application delivery from user requests, audit DeepSeek Harness for beneficial missing capabilities, close any approved high-value gap, and then qualify the result with a real-world Build-mode project.

**Architecture:** Extend the existing durable scheduler, worktree, evidence, integration, recovery, and handoff kernel. Add criterion-level contracts, canonical integrated verification, durable user steering, independent high-risk verification, protected extension/LSP seams, and certified qualification without transferring lifecycle authority out of the kernel.

**Tech stack:** Strict TypeScript, Node.js maintained LTS release lines, Node built-in SQLite, Git worktrees, React 19/Next.js client surfaces, and Playwright/browser evidence.

**Canonical authority:** This file persists the plan approved in the conversation on 2026-08-26. ENV-1 records that Runner V2 must not force Node.js 24.18.0 or any other single patch release. On 2026-08-28 the owner cancelled the comparative P6 benchmark and replaced it with a source-level capability audit of the local DeepSeek Harness repository. The audit is recorded in `docs/superpowers/plans/2026-08-28-deepseek-harness-capability-audit.md`.

The plan is grounded in the live Runner V2 seams:

- [task-contracts.ts](C:/Users/b_a_s/source/repos/ai-discussion-board/runner-v2/src/task-contracts.ts:16) has no structured acceptance criteria.
- [build-runtime.ts](C:/Users/b_a_s/source/repos/ai-discussion-board/runner-v2/src/build-runtime.ts:416) currently offers completion once ordinary tasks are integrated or cancelled.
- [native-architect-runtime.ts](C:/Users/b_a_s/source/repos/ai-discussion-board/runner-v2/src/native-architect-runtime.ts:516) inspects the original project root outside task review.
- [integration-manager.ts](C:/Users/b_a_s/source/repos/ai-discussion-board/runner-v2/src/integration-manager.ts:146) already provides the durable integration branch to preserve.
- [native-build-engine.ts](C:/Users/b_a_s/source/repos/ai-discussion-board/lib/client/native-build-engine.ts:578) snapshots initial user intent but does not deliver later notes durably to an active run.
- [code-intelligence-tools.ts](C:/Users/b_a_s/source/repos/ai-discussion-board/runner-v2/src/code-intelligence-tools.ts:1) is TypeScript/JavaScript-specific.
- [process-tools.ts](C:/Users/b_a_s/source/repos/ai-discussion-board/runner-v2/src/process-tools.ts:119) currently launches approved commands with the Runner host process's ambient filesystem and environment authority.

## Execution controls applying to every phase

Product requirements have exactly one owning phase. The following controls are deliberately cross-cutting and therefore do not “own” product requirements.

1. **PREPARE**

   - Work in an isolated implementation worktree.
   - Record the starting Git revision, dirty files, Node version, Git version, state-directory location, and baseline validation results.
   - Preserve the existing unrelated changes in `lib/account-provider-runner.mjs` and `scripts/test-account-provider-runner-chat.mts`.
   - Runner state must remain outside the project.
   - Use a Node.js release line in Active LTS or Maintenance LTS status; never pin Runner V2 to one patch release.
   - Stop any active development server before `npm run build`; restart it afterward if it was running.

2. **One coherent packet**

   - Only one listed work packet may be active.
   - Each packet produces one independently testable behavior.
   - Non-critical unrelated findings go into the future-phase ledger. A critical security, data-loss, or kernel-integrity issue may interrupt the phase.

3. **Impact-based validation**

   - Run the exact failed check first.
   - Then test affected files, contracts, persistence, lifecycle transitions, and callers.
   - Reuse prior green evidence only when the impact map proves those surfaces unchanged.
   - Shared contracts, event reducers, tool registration, build configuration, or package-level changes require broader gates.

4. **Prove-red protocol**

   Every new regression test or guard must have:

   - A pre-fix failure against the old behavior.
   - A recorded expected failure signature.
   - A temporary reintroduction of the guarded fault after implementation.
   - A second demonstrated red result.
   - Reversion of the injected fault only.
   - A final green result from the same named test.
   - Red and green evidence tied to exact Git revisions.

5. **Automatic repair budget**

   - Maximum three repair cycles for the same failed check and root cause.
   - After the third, perform one evidence-backed root-cause reclassification.
   - At most two further repair cycles are allowed, for a maximum of five per packet.
   - A changed diagnosis does not reset the five-cycle cap.
   - Exhaustion permits escalation for a decision to extend the budget, change scope, or retain the control. It does not permit silently weakening a requirement.

6. **Phase close**

   - Audit every assigned requirement.
   - Run an adversarial re-audit using stale evidence, missing evidence, restart, duplicate-event, and authority-bypass cases relevant to that phase.
   - Inspect the complete phase diff and current state.
   - Close only with current evidence.

The only allowed execution outputs are exactly:

> PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN

or:

> PHASE BLOCKED — GENUINE USER DECISION REQUIRED

## 1. Master phase and dependency table

| Phase | Title | Priority | Owns | Hard dependencies | Unlocks |
|---|---|---:|---|---|---|
| P1 | Maintained-LTS runtime policy plus structured acceptance and evidence contracts | P0 Critical | ENV-1, HVI-2 | None | P2 |
| P2 | Canonical integration final-verification gate | P0 Critical | HVI-1 | P1 | P3 |
| P3 | Durable user steering and Architect `ask_user` | P0 High | HVI-3 | P2 | P4 |
| P4 | Independent high-risk verifier | P1 High | HVI-4 | P1–P3 | P5 |
| P5 | Protected plugin seams and generic LSP | P1 High | HVI-5 | P1–P4 | P6 |
| P6 | DeepSeek capability audit and gap disposition | P0 Release gate | HVI-6A | P1–P5 | Approved gap closure or P7 |
| P7 | Real-world Build-mode qualification | P0 Final gate | RW-1 | P6 disposition, every approved gap closure, and OD-1 | Release decision |

The chain is intentionally serial. Later features consume the durable state and invalidation rules established by earlier phases.

---

# 2. Detailed phase specifications

### Task 1: P1 — Maintained-LTS runtime policy plus structured acceptance and evidence contracts

**Purpose:** Turn task intent into a durable, mechanically complete criterion/evidence contract while retaining the Architect as semantic reviewer.

**Priority:** P0 Critical

**Dependencies:** None

### Entry conditions and scope

- Baseline Runner V2 suite, Runner typecheck, and current client contract tests are recorded.
- Existing event logs, completed-run fixtures, and in-flight recovery fixtures are backed up.
- Scope includes:

  - A stable `AcceptanceCriterion` for every non-cancelled task.
  - Criterion-level worker evidence mappings.
  - Criterion-level Architect verdicts.
  - Retry, task-revision, event-replay, client, audit-export, and UI support.
  - Compatibility handling for legacy in-flight runs.

### Explicit exclusions

- No final integration verification task; P2 owns it.
- No user-to-run guidance or Architect questions; P3 owns them.
- No independent verifier; P4 owns it.
- Evidence facts remain mechanical observations. Workers do not decide semantic satisfaction.
- Product Build mode must not import the legacy benchmark engine.

### Requirements assigned

- ENV-1: Runner V2 developer, test, packaged-runner, client-policy, and published-artifact surfaces accept maintained Node.js LTS release lines and do not download, require, or advertise one fixed patch release.
- HVI-2.1: Every planned task has structured acceptance criteria.
- HVI-2.2: Every worker submission maps durable evidence to each criterion.
- HVI-2.3: Every Architect review maps a verdict, rationale, and evidence to each criterion.
- HVI-2.4: Criteria and mappings remain correct across revision, retry, restart, and audit export.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P1.0 | Replace the exact Node patch pin with a maintained-LTS compatibility contract across runtime checks, npm commands, package metadata, published artifacts, client policy, documentation, and repository guidance. Prove every accepted LTS line and rejected EOL/Current/malformed line. | Node-version, native-build-policy, deploy-artifact, and package-script tests |
| P1.1 | Create `acceptance-contracts.ts` with stable criterion IDs, evidence-link structures, review verdicts, duplicate detection, and exact coverage validators. | New `acceptance-contracts.test.ts` only |
| P1.2 | Extend `BuildTask`, `plan_tasks`, task revision/reconciliation, graph validation, and scheduler events. New plans reject empty or duplicate criteria. Criteria cannot mutate during an active attempt. | `acceptance-contracts`, `task-graph`, `guidance-review` named tests |
| P1.3 | Extend `submit_task` and `ChangeSet` with one `CriterionEvidenceLink` per criterion. Validate evidence record existence, current task/attempt ownership, artifact hashes, and exact criterion coverage. | `worker-runtime` and new `change-set` tests |
| P1.4 | Extend `review_task`, `ReviewProjection`, Architect context, and review prompts with one `CriterionReviewVerdict` per criterion. Approval is mechanically rejected unless every criterion is represented and cited evidence exists. | `guidance-review`, `native-architect-runtime` |
| P1.5 | Add append-only legacy handling: completed legacy runs remain inspectable; an in-flight legacy run enters `acceptance_contract_upgrade_required` and cannot submit or review until the Architect records criteria for every non-cancelled task. | `scheduler-store`, `build-runtime`, `recovery-smoke`, build-spec fixtures |
| P1.6 | Project the contracts through `runner-v2.ts`, audit export, task board, and observability UI. Show criterion text, submitted evidence coverage, and Architect verdict without treating evidence as a semantic verdict. | Client, observability, task-board UI tests |

### Expected files and surfaces

Create:

- `runner-v2/src/acceptance-contracts.ts`
- `runner-v2/test/acceptance-contracts.test.ts`
- `runner-v2/test/change-set.test.ts`

Modify:

- `runner-v2/src/task-contracts.ts`
- `runner-v2/src/task-graph.ts`
- `runner-v2/src/change-set.ts`
- `runner-v2/src/worker-lifecycle-tools.ts`
- `runner-v2/src/worker-runtime.ts`
- `runner-v2/src/architect-tools.ts`
- `runner-v2/src/scheduler-store.ts`
- `runner-v2/src/build-runtime.ts`
- `runner-v2/src/agent-prompts.ts`
- `runner-v2/src/native-architect-runtime.ts`
- `lib/client/runner-v2.ts`
- `components/BuildTaskBoard.tsx`
- `components/RunnerV2ObservabilityPanel.tsx`
- Related existing Runner/client/UI tests.

### Acceptance criteria

- Every new task contains at least one non-empty, uniquely identified criterion.
- A worker cannot submit with an omitted, duplicate, unknown, stale, or foreign evidence mapping.
- Artifact hashes alone cannot impersonate a current evidence record.
- An Architect cannot approve with missing or duplicated criterion verdicts.
- A rejection evaluates every criterion and identifies at least one unsatisfied criterion.
- Retried attempts cannot reuse evidence from a prior attempt unless the new mapping explicitly cites still-valid immutable evidence and the kernel validates it.
- Task revision advances the plan revision and versions the criterion set.
- Event replay yields the same criteria, mappings, reviews, and state.
- Audit and UI expose the same authoritative contract.
- Existing completed runs remain readable; old active runs cannot bypass the new contract.

### Tests, static analysis, and environment/database validation

Targeted:

- `acceptance-contracts.test.ts`
- `change-set.test.ts`
- `task-graph.test.ts`
- `guidance-review.test.ts`
- `worker-runtime.test.ts`
- `native-architect-runtime.test.ts`
- `scheduler-store.test.ts`
- `recovery-smoke.test.ts`
- `scripts/test-runner-v2-client.mts`
- `scripts/test-build-task-board-ui.tsx`
- `scripts/test-runner-v2-observability.mts`

Static and phase exit:

- `npm run typecheck:runner-v2`
- Targeted ESLint over changed files.
- `npm run test:runner-v2`
- `npm run build` because client/UI contracts change.

Database validation:

- Replay a scheduler SQLite database created before criteria support.
- Reopen with WAL present.
- Verify event ordering and idempotency remain stable.
- Verify completed legacy runs are read-only and viewable.
- Verify active legacy runs receive exactly one upgrade gate.
- Verify failed upgrade events roll back atomically.

### Required evidence and prove-red fault injections

- Delete one criterion mapping from a submission: submission test must fail red.
- Reuse evidence from another task or attempt: ownership guard must fail red.
- Approve with one omitted verdict: review guard must fail red.
- Replay an upgrade event twice: idempotency test must remain green.
- Corrupt an upgrade payload: database transaction must reject it without partial state.
- Capture criterion UI and audit-export parity evidence.

### Cleanup, rollback, and recovery

- Close all SQLite stores after every fixture.
- Delete only runner-owned temporary fixture directories.
- Never rewrite historical scheduler events.
- Roll back by reverting the coherent packet changes; legacy data remains readable because new behavior is version-gated.
- If recovery fails, restore the copied fixture and rerun only migration/replay tests before broader checks.

### Definition of Done and exit gate

- All HVI-2 requirements have direct current evidence.
- No task can be submitted or approved without exact criterion coverage.
- Recovery and client projections agree with scheduler truth.
- Final adversarial audit finds no prose-, artifact-, or stale-attempt bypass.

On success emit the exact success outcome. P2 unlocks only then.

---

### Task 2: P2 — Canonical integration final-verification gate

**Purpose:** Prevent project completion until a mandatory verification task has checked the exact integrated revision.

**Priority:** P0 Critical

**Dependencies:** P1

### Entry conditions and scope

- P1 is verified.
- Criterion contracts are authoritative.
- Scope includes:

  - A kernel-owned final-verification generation.
  - A disposable verification workspace pinned to the exact integration revision.
  - Explicit build, test, runtime-smoke, and browser categories.
  - Durable verification submissions and Architect review.
  - Repair-task creation, invalidation, restart recovery, and completion enforcement.

### Explicit exclusions

- No independent second model; P4 owns it.
- No deployment or production publishing.
- No mutation of the user checkout during verification.
- No change to final handoff policy.
- A verifier records facts; it does not silently declare the entire build complete.

### Requirements assigned

- HVI-1.1: Mandatory final-verification task.
- HVI-1.2: It verifies the canonical integrated state.
- HVI-1.3: Build and test checks.
- HVI-1.4: Runtime smoke where applicable.
- HVI-1.5: Browser evidence where applicable.
- HVI-1.6: Completion remains impossible until current integrated-state verification is green.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P2.1 | Create verification contracts. `plan_final_verification` must represent all four categories as `required` or `not_applicable`; every omission and unjustified skip is rejected. | New `final-verification-contracts.test.ts` |
| P2.2 | Add a runner-owned disposable verification workspace pinned to `IntegrationManager.revision`. Record target revision and verify containment. | `integration-manager`, `workspace-manager`, new verification-workspace tests |
| P2.3 | Implement `FinalVerificationRuntime` and `submit_final_verification`. Run exact command arrays without shell interpolation, capture command/browser evidence, repository revision, timeout, and cancellation state. No change set is produced. | Final-verification runtime and evidence tests |
| P2.4 | Extend scheduling with one singleton final-verification task per integration generation. On failure, the Architect may add narrowly scoped repair tasks; integration of any repair invalidates the old generation and schedules a fresh verification task. | `build-runtime`, scheduler, task-scheduler tests |
| P2.5 | Guard `complete_run`. It is unavailable unless all implementation tasks are terminal, the final-verification task is approved, every required check is green, and its target revision equals the current integration revision. | Completion-gate tests |
| P2.6 | Add restart recovery, cleanup, audit export, client projection, and user-facing verification status. | Recovery, manager-cleanup, client, observability, Playwright tests |

### Expected files and surfaces

Create:

- `runner-v2/src/final-verification-contracts.ts`
- `runner-v2/src/final-verification-runtime.ts`
- `runner-v2/src/verification-workspace.ts`
- Corresponding test files.
- `tests/e2e/runner-v2-final-verification.spec.ts`

Modify:

- `build-runtime.ts`
- `task-contracts.ts`
- `scheduler-store.ts`
- `architect-tools.ts`
- `agent-prompts.ts`
- `native-architect-runtime.ts`
- `native-build-factory.ts`
- `native-build-manager.ts`
- `integration-manager.ts`
- `workspace-manager.ts`
- `worker-runtime.ts`
- `build-observability.ts`
- `control-server.ts`
- `lib/client/runner-v2.ts`
- `RunnerV2ObservabilityPanel.tsx`
- `BuildTaskBoard.tsx`

### Acceptance criteria

- Completion cannot be requested immediately after the last ordinary integration.
- Exactly one current verification generation exists.
- Build, tests, runtime smoke, and browser checks are each explicitly represented.
- `not_applicable` requires a non-empty rationale and supporting repository inspection.
- Detected build/test commands cannot be silently marked inapplicable.
- Commands execute only in the disposable workspace at the recorded revision.
- Verification-created files never enter the integration branch.
- Non-zero exit, timeout, cancellation, console error policy violation, failed network event policy, or missing required evidence prevents approval.
- Any new integration revision makes all earlier verification evidence stale.
- A failed verification creates repair work; it cannot be converted to success by prose.
- Restart resumes only incomplete checks and never duplicates a completed evidence record.

### Tests and validation

Targeted:

- New verification contract/runtime/workspace tests.
- `build-runtime.test.ts`
- `integration-manager.test.ts`
- `workspace-manager.test.ts`
- `worker-runtime.test.ts`
- `native-architect-runtime.test.ts`
- `native-build-manager.test.ts`
- `native-build-cleanup.test.ts`
- `recovery-smoke.test.ts`
- `control-server.test.ts`
- Client/observability scripts.
- `npx playwright test tests/e2e/runner-v2-final-verification.spec.ts`

Exit:

- Runner typecheck.
- Targeted ESLint.
- Full Runner V2 suite.
- Production build.

Environment validation:

- Maintained-LTS Node compatibility and Git preflight.
- Fixture projects covering no build script, build/test scripts, runtime server, and browser UI.
- Verification state directory outside each fixture project.
- Windows path, spaces, cancellation, process-tree cleanup, and port release.

### Required evidence and prove-red injections

- Make task-local tests green but break the integrated result: final verification must catch it.
- Replace the recorded target revision with a previous commit: approval must fail.
- Add a UI regression while omitting browser evidence: completion must fail.
- Terminate Runner V2 between two checks: restart must retain completed facts and rerun only the pending check.
- Inject a non-zero test exit: repair work must be scheduled.
- Advance the integration branch after approval: verification must become stale.
- Write generated files during build verification: cleanup must remove them without touching canonical integration history.

### Cleanup, rollback, and recovery

- Remove only runner-owned verification worktrees after evidence is durably committed.
- Stop managed processes and close browser sessions on success, failure, pause, and restart.
- Preserve failed-workspace diagnostics until audit export is complete.
- If cleanup fails, record a durable cleanup failure and prevent final handoff.
- Rollback disables the new completion gate only by reverting the entire phase before release; there is no runtime bypass flag.

### Definition of Done and exit gate

- HVI-1 is verified against actual integrated revisions.
- Completion has no alternate path around verification.
- Faults, staleness, restart, and cleanup are proven.
- P3 unlocks only after the exact success outcome.

---

### Task 3: P3 — Durable user steering and Architect `ask_user`

**Purpose:** Let users steer an active build and answer Architect questions without mutating or replacing the immutable initial objective.

**Priority:** P0 High

**Dependencies:** P2

### Entry conditions and scope

- P2 invalidation and generation semantics are available.
- Scope includes append-only user guidance, safe lifecycle interruption, Architect acknowledgement/reconciliation, questions, answers, API/client/UI delivery, restart recovery, and final-verification invalidation.

### Explicit exclusions

- No rewriting the original objective.
- No arbitrary binary-attachment transport into an active runner. In-flight guidance is text-only; the UI must explain that attached files require a follow-up pass.
- No routine questions for technically determinable issues.
- Completed/applied builds receive a new build pass rather than mutating history.

### Requirements assigned

- HVI-3.1: Durable mid-run user guidance.
- HVI-3.2: Active runs consume guidance without losing the original objective.
- HVI-3.3: Architect `ask_user`.
- HVI-3.4: Questions and answers recover across browser or runner restart.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P3.1 | Add `user.guidance_submitted`, `user.guidance_acknowledged`, `architect.question_requested`, and `architect.question_answered` events and projections with monotonic versions and idempotency. | New `user-steering.test.ts`, scheduler tests |
| P3.2 | Add safe steering interruption. Append guidance first, cancel current lifecycle at a checkpoint, keep the run durable, and prioritize guidance before review/integration/completion. | Build-runtime and concurrent-worker tests |
| P3.3 | Add Architect lifecycle tools `acknowledge_user_guidance` and `ask_user`. Acknowledgement records either an evidence-backed no-plan-change rationale or an atomic plan reconciliation. | Architect-tool and prompt tests |
| P3.4 | Add authenticated control-plane endpoints and client helpers for submitting guidance and answering a versioned question. | Control-server and client tests |
| P3.5 | Route active native-build notes through the runner endpoint. Add pending/acknowledged guidance and question-answer UI. Prevent false claims that an in-flight attachment has reached Runner V2. | Discussion-client and UI tests |
| P3.6 | Handle guidance during final verification or pending handoff: revoke the pending verification/handoff generation, reconcile, and require fresh verification. Prove restart and duplicate-request behavior. | Recovery and end-to-end tests |

### Expected files and surfaces

Create:

- `runner-v2/src/user-steering-contracts.ts`
- `runner-v2/test/user-steering.test.ts`
- `tests/e2e/runner-v2-user-steering.spec.ts`

Modify:

- `scheduler-store.ts`
- `build-runtime.ts`
- `architect-tools.ts`
- `agent-prompts.ts`
- `native-architect-runtime.ts`
- `build-runtime-registry.ts`
- `native-build-manager.ts`
- `control-server.ts`
- `lib/client/runner-v2.ts`
- `lib/client/native-build-engine.ts`
- `lib/client/api.ts`
- `lib/client/build-notes.ts`
- `app/discussion/discussion-client.tsx`
- `RunnerV2ObservabilityPanel.tsx`

### Acceptance criteria

- Guidance is persisted before the API acknowledges receipt.
- Duplicate submission with the same idempotency key produces one event.
- The immutable objective remains byte-identical.
- Guidance added during worker execution reaches the next Architect action without disappearing.
- Every guidance item is acknowledged exactly once.
- The Architect cannot acknowledge an instruction that changes scope without reconciling the plan.
- `ask_user` creates a durable blocking question and pauses semantic progress.
- Only the user can answer; stale or duplicate versions are rejected.
- Answering resumes the exact pending Architect action.
- Guidance received after final verification invalidates it.
- Guidance received before final handoff can withdraw that handoff; guidance after completed handoff starts a new run.
- Browser and runner restart preserve all states.

### Tests and validation

Targeted scheduler, build-runtime, Architect, manager, control-server, recovery, client, and discussion UI tests, followed by:

- Runner typecheck.
- Targeted ESLint.
- Full Runner suite.
- `npx playwright test tests/e2e/runner-v2-user-steering.spec.ts`
- Production build.

Database validation:

- Crash after guidance append but before HTTP response.
- Crash after question creation but before UI polling.
- Answer followed by immediate runner restart.
- Concurrent guidance submissions with unique and duplicate idempotency keys.
- WAL reopen and event replay parity.

### Required evidence and prove-red injections

- Drop the in-memory callback after persistence: guidance must still be recovered.
- Deliver guidance during an active worker call: old-intent integration must not pass unreviewed.
- Answer a stale question version: reducer must reject it.
- Simulate browser reload with an unanswered question: question UI must reappear.
- Try worker/runner authority on a user answer: reject.
- Submit guidance after final-verification approval: completion must become unavailable.

### Cleanup, rollback, and recovery

- Cancel only active model/process calls; never delete guidance events.
- Remove stale in-memory note queues from the native active-run path while preserving benchmark/follow-up compatibility.
- Rollback by reverting API/UI routing and event support as one phase; do not leave UI copy promising unsupported delivery.
- Resume from the latest durable scheduler sequence after restart.

### Definition of Done and exit gate

- HVI-3 is demonstrated through API, event log, Architect context, UI, and restart.
- No note or answer depends solely on browser memory.
- P4 unlocks only after the exact success outcome.

---

### Task 4: P4 — Independent high-risk verifier

**Purpose:** Remove Architect self-certification for high-risk integrated builds while preserving the Architect’s planning and completion-request authority.

**Priority:** P1 High

**Dependencies:** P1–P3

### Entry conditions and scope

- Criteria, final verification, user questions, and invalidation are verified.
- Scope includes deterministic risk classification, distinct verifier selection, a restricted verifier runtime, typed verdicts, budget accounting, completion gating, recovery, and UI/audit support.

### Explicit exclusions

- No multi-verifier voting or quorum.
- No verifier edits, commits, integration, plan ownership, or lifecycle authority.
- No silent downgrade from high risk.
- Low-risk builds do not require the independent gate unless the run explicitly opts into stricter qualification.

### Requirements assigned

- HVI-4.1: Identify high-risk builds.
- HVI-4.2: Use an independent verifier model.
- HVI-4.3: Give it the current integrated revision, criteria, guidance, change history, and final-verification evidence.
- HVI-4.4: Block completion until its current verdict is positive.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P4.1 | Create `BuildRiskAssessment`. High risk is the maximum of Architect declaration and kernel facts: destructive/credential/external-write effects, integration conflict, security/auth/crypto paths, migrations/schema/data paths, dependency lockfiles, CI/deployment/infrastructure paths, or explicit qualification policy. Risk may be raised, never lowered. | New `risk-policy.test.ts` |
| P4.2 | Extend provider/build configuration with verifier candidates. Select a model identity distinct from the current Architect and from any model that authored an accepted change set. | Build-spec, runtime-router, provider-config tests |
| P4.3 | Implement `NativeVerifierRuntime` with a separate session and restricted read-only tools over the exact integration snapshot. It receives objective, criteria, reviews, guidance, diffs, final-verification facts, and risk reasons. | New verifier-runtime tests |
| P4.4 | Add typed `submit_verifier_verdict`: every build criterion receives `satisfied` or `unsatisfied`, evidence, and rationale. The kernel checks revision, model independence, evidence existence, and completeness. | Verifier contract and scheduler tests |
| P4.5 | Add completion enforcement and repair routing. Unsatisfied verdicts create Architect repair work; a new revision invalidates the verdict. Missing compatible models create a typed user-selection pause. | Build-runtime, manager, recovery tests |
| P4.6 | Add audit, budget attribution, risk/verdict UI, and high-risk qualification override. | Usage, client, observability, UI tests |

### Expected files and surfaces

Create:

- `runner-v2/src/risk-policy.ts`
- `runner-v2/src/verifier-contracts.ts`
- `runner-v2/src/native-verifier-runtime.ts`
- Corresponding tests.

Modify:

- `build-spec.ts`
- `sqlite-build-spec-store.ts`
- `runtime-router.ts`
- `native-build-factory.ts`
- `build-runtime.ts`
- `scheduler-store.ts`
- `agent-prompts.ts`
- `budget-ledger.ts` attribution types
- `model-usage-projection.ts`
- `build-observability.ts`
- `control-server.ts`
- `lib/client/runner-v2.ts`
- Build settings/model selection UI.
- `RunnerV2ObservabilityPanel.tsx`

### Acceptance criteria

- Risk assessment is deterministic and durable.
- Architect/model prose cannot lower a kernel-triggered high-risk result.
- The verifier has a distinct model identity and session.
- Verifier tools cannot plan, review tasks, integrate, complete, or write.
- Verdict covers every build-level criterion.
- Verdict target revision equals the current integration revision.
- A positive verdict cannot override failed or missing P2 evidence.
- A negative verdict cannot be converted to completion without repair and fresh verification.
- All verifier calls and evidence count toward the run budget.
- Budget exhaustion, provider loss, or unavailable independence pauses instead of waiving the gate.
- Restart does not duplicate model calls after a durable verdict.

### Tests and validation

Targeted:

- Risk policy and verifier tests.
- Build-spec migration tests.
- Runtime-router and provider-health tests.
- Build-runtime, scheduler, recovery, budget, usage, manager, control-server, client, and UI tests.

Exit:

- Runner typecheck.
- Targeted ESLint.
- Full Runner suite.
- Production build.

Database validation:

- Recover old specs without verifier fields.
- Classify existing active runs before completion.
- Replay risk and verdict events.
- Restart immediately before and after verdict persistence.
- Verify distinct session/model attribution in budget and audit stores.

### Required evidence and prove-red injections

- Select the Architect runtime as verifier: reject.
- Select a model that authored an accepted change set: reject.
- Approve a stale revision: reject.
- Omit one criterion: reject.
- Return positive verdict while P2 has a failed test: completion stays blocked.
- Fail the verifier provider: route to another independent candidate or typed pause.
- Restart after the model response but before duplicate invocation: one durable verdict must remain.

### Cleanup, rollback, and recovery

- Verifier workspaces and sessions follow P2 cleanup rules.
- Never delete a negative verdict; supersede it with a new revision-bound generation.
- Rollback must restore pre-P4 build specs using version-aware decoding; high-risk runs created under P4 cannot be completed by an older runner.
- No emergency bypass flag is allowed.

### Definition of Done and exit gate

- Every high-risk build demonstrably requires an independent current verdict.
- Identity, authority, staleness, budget, and recovery bypasses are closed.
- P5 unlocks only after the exact success outcome.

---

### Task 5: P5 — Protected plugin seams and generic LSP

**Purpose:** Gain DeepSeek-style extensibility and multi-language code intelligence without exposing scheduler, worktree, integration, permission, or completion authority.

**Priority:** P1 High

**Dependencies:** P1–P4

### Entry conditions and scope

- All kernel authority gates are stable and covered.
- Scope includes trusted local extension discovery, capability registration, extension lifecycle, generic language intelligence, an LSP stdio client, and migration of TypeScript intelligence behind the new interface.

### Explicit exclusions

- No replacement of Runner V2 scheduling, task isolation, integration, evidence, budgets, or handoff.
- No remote plugin marketplace, automatic downloads, untrusted code sandbox, or hot reload.
- Plugins cannot register lifecycle tools or receive raw scheduler/integration stores.
- No copied DeepSeek implementation code; use its architectural seams as design input only.
- MCP remains supported and is not replaced by plugins.

### Requirements assigned

- HVI-5.1: Add protected plugin seams inspired by DeepSeek Harness.
- HVI-5.2: Add generic LSP support.
- HVI-5.3: Retain Runner V2’s scheduler/worktree/integration kernel.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P5.1 | Create extension contracts: manifest/API version, capability provider, tools, bounded context contributors, language providers, and start/close lifecycle. | New extension-contract tests |
| P5.2 | Implement allowlisted local plugin discovery. Resolve real paths, reject escapes/symlinks, duplicate IDs/tools, incompatible API versions, and lifecycle-tool registration. | Plugin-loader and containment tests |
| P5.3 | Route plugin tools through the existing ToolBroker, permission checks, budget ledger, artifact store, and tool ledger. Context contributors go through ContextAssembler limits. | Tool-broker, budget, permission tests |
| P5.4 | Introduce `LanguageIntelligenceProvider` and move current TypeScript intelligence behind it while preserving existing `code.*` tool names and response shapes. | Existing TypeScript/code-intel tests |
| P5.5 | Implement the generic LSP stdio client: initialize, document sync, definition, references, workspace symbols, diagnostics, cancellation, shutdown, bounded restart, UTF-16 positions, and contained file URIs. | New LSP client tests with fixture server |
| P5.6 | Add configured language-server routing by extension/root marker, process cleanup, CLI configuration validation, audit metadata, and extension documentation. | Worker/Architect/factory/CLI integration tests |

### Expected files and surfaces

Create:

- `runner-v2/src/runner-extension.ts`
- `runner-v2/src/capability-registry.ts`
- `runner-v2/src/plugin-loader.ts`
- `runner-v2/src/language-intelligence.ts`
- `runner-v2/src/lsp-client.ts`
- `runner-v2/src/lsp-language-provider.ts`
- `runner-v2/test/fixtures/lsp-server.mjs`
- Extension/LSP test files.
- `docs/runner-v2/extensions.md`

Modify:

- `code-intelligence-tools.ts`
- `typescript-intelligence.ts`
- `worker-runtime.ts`
- `native-architect-runtime.ts`
- `native-build-factory.ts`
- `tool-registry.ts`
- `tool-broker.ts`
- `managed-process.ts`
- `cli.ts`
- Runner configuration parsing and observability.

### Acceptance criteria

- A valid allowlisted extension can contribute ordinary tools and bounded context.
- It cannot contribute lifecycle tools or access kernel stores.
- Every extension tool is permissioned, budgeted, logged, and attributed.
- Duplicate names and incompatible versions fail startup atomically.
- Existing TypeScript behavior and tool names remain compatible.
- Configured language servers support standard code-intelligence calls for non-TypeScript fixtures.
- Malformed frames, timeout, crash, cancellation, or out-of-workspace URIs return bounded errors.
- A crashed server may restart only within the configured retry limit.
- Runner shutdown leaves no language-server process.
- Scheduler, worktree, integration, verification, and verifier tests remain unchanged and green.

### Tests and validation

Targeted:

- New capability, plugin-loader, LSP, and language-provider tests.
- Existing TypeScript and code-intelligence tests.
- Worker, Architect, ToolBroker, permission, budget, managed-process, factory, cleanup, and recovery tests.

Exit:

- Runner typecheck.
- Targeted ESLint.
- Full Runner suite.
- CLI smoke on Windows.
- Production build only if client-visible configuration is added.

Environment validation:

- Paths containing spaces and non-ASCII names.
- UTF-16 LSP line/column conversion.
- Missing executable, malformed JSON-RPC, partial frame, timeout, process crash, and shutdown.
- TypeScript fallback with no external server.
- At least one non-TypeScript fixture server.

### Required evidence and prove-red injections

- Plugin attempts to register `complete_run`: startup must fail.
- Plugin declares a duplicate `filesystem.read`: fail atomically.
- Plugin tool requests a protected path: permission layer must block it.
- LSP returns `file://` outside the workspace: result must be rejected.
- Kill LSP mid-request: bounded restart or typed failure.
- Send a stale document version: synchronization test must catch it.
- Disable the new registry: existing kernel lifecycle tests must prove no authority moved into plugins.

### Cleanup, rollback, and recovery

- Track every started extension and language-server process and close in reverse order.
- A partial plugin-start failure shuts down all earlier plugins.
- Disable all optional extensions through configuration while retaining the built-in TypeScript provider.
- Rollback keeps current code-intelligence behavior available.
- No plugin may leave state in the project directory.

### Definition of Done and exit gate

- HVI-5 is delivered without weakening kernel invariants.
- TypeScript compatibility and non-TypeScript LSP behavior are both proven.
- P6 unlocks only after the exact success outcome.

---

### Task 6: P6 — DeepSeek capability audit and gap disposition

**Purpose:** Inspect the current local DeepSeek Harness source for capabilities
that materially strengthen robust application building, without spending effort
on comparative scoring or copying broad general-agent product features.

**Priority:** P0 Release gate

**Dependencies:** P1–P5

### Entry conditions and scope

- All P1–P5 production improvements are verified.
- Record exact local Runner V2 and DeepSeek Harness revisions and preserve both
  worktrees.
- Inspect shipped implementation, tests, package limitations, and default
  composition across execution, recovery, safety, extensibility, context,
  coordination, tools, language intelligence, and external control surfaces.
- Classify each material capability as Runner stronger, equivalent/different,
  DeepSeek stronger and beneficial, or broader but not beneficial to robust
  application building.

### Explicit exclusions

- No head-to-head workload, parity contract, score, leaderboard, result bundle,
  or fairness claim.
- No changes to the DeepSeek Harness repository.
- No copying DeepSeek implementation code.
- Breadth alone is not a Runner requirement. Hot reload, self-modification,
  in-process workflow code, advisory Team scopes, hook compatibility, webhooks,
  and overlapping SDK/control protocols stay out unless a concrete build
  reliability requirement independently justifies them.
- No weakening of Runner scheduler, worktree, integration, permission,
  verification, or completion authority.

### Requirements assigned

- HVI-6A.1: Audit the current local DeepSeek Harness source without benchmarking.
- HVI-6A.2: Identify only shipped capabilities that materially benefit robust
  application building and cite exact evidence and limitations.
- HVI-6A.3: Remove abandoned benchmark-only implementation from this branch and
  record the cancelled HVI-6.1–HVI-6.9 requirements as owner-withdrawn.
- HVI-6A.4: Give every local Runner child-process family consistent scrubbed
  environment, tree ownership, cancellation, quiescence, and recovery; give
  command/evidence families bounded tail plus optional complete output
  artifacts without failing solely for log volume—or record an explicit owner
  waiver.
- HVI-6A.5: Add fail-closed generated-process file-write confinement with exact
  permission grants and honest enforcement reporting—or record an explicit
  owner waiver.
- HVI-6A.6: Prevent repository/user-controlled Git hooks, filters, helpers,
  configuration, and related programs from bypassing the execution boundary—or
  record an explicit owner waiver.
- HVI-6A.7: Add a trusted last-mile fence to every filesystem mutation and
  optimistic revision/create guards to text replacement/creation—or record an
  explicit owner waiver with the external-TOCTOU limitation.
- HVI-6A.8: Do not unlock P7 while any discovered high-value gap remains neither
  verified nor explicitly waived with its named residual risks.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P6.1 | Verify both revisions and perform the read-only capability audit. | Evidence/path/revision review |
| P6.2 | Persist the audit, update plan traceability, and delete only the abandoned P6 benchmark files. | Git diff and repository search for removed P6 surfaces |
| P6.3 | Present the smallest high-value gap-closure design and obtain any genuine architectural approval or waiver. | Requirement/design audit |
| P6.4a | If approved, freeze the execution-safety threat model, Windows enforcement/grant contracts, process output/result types, capability-contract version, and migration refusal. | Contract/schema/recovery tests |
| P6.4b | Implement shared scrubbed child environments, private bounded tail/spill with lossy continuation, Windows Job-owned tree lifecycle, escalation, quiescence, and orphan recovery. | Env/output/tree one-shot fixtures |
| P6.4c | Implement the probed Windows restricted-token/ACL write boundary, exact one-call path grants, partial-enforcement disclosure, Full bypass, and revocation/recovery. | Disposable NTFS/ACL integration fixtures |
| P6.4d | Route one-shot, evidence, final-verification, managed, Git, LSP, MCP, and locally spawned provider surfaces through shared low-level environment/tree/quiescence primitives while retaining only protocol-specific framing. | Per-family process regressions and raw-spawn audit |
| P6.4e | Harden every Runner Git command against hooks, helpers, filters, external diff/textconv, ambient configuration/credentials, and outside writes. | Repository-controlled Git escape fixtures |
| P6.4f | Add the trusted filesystem mutation fence, existing-file revision requirement, create-only primitive, symlink-race handling, and honest external-TOCTOU classification. | Filesystem stale/create/symlink fixtures |
| P6.4g | Wire durable audit/client disclosure, recovery cleanup, documentation, packaged artifacts, final adversarial re-audit, and the phase exit gate. | Affected integration gates, then one final broad gate |

P6.4a–P6.4g execute only after approval. A waiver skips all seven packets,
records every named residual risk from the audit, and goes directly to the P6
gate; it is not represented as successful implementation.

### Expected files and surfaces

- `docs/superpowers/plans/2026-08-28-deepseek-harness-capability-audit.md`
- This canonical plan and its execution ledger.
- Removal of `lib/benchmark/robust-build/*` and corresponding P6-only scripts
  introduced after P5.
- If P6.4 is approved, expected protected-kernel surfaces include a shared
  subprocess runtime, child-environment/output-spool/process-sandbox modules, a
  Windows containment helper, an opaque execution-grant contract, a filesystem
  mutation fence, the central Git runner, ToolBroker integration, capability
  contract/recovery/audit/client projections, Runner packaging, documentation,
  and focused fixtures/tests. Exact filenames are frozen in P6.4a after current
  source-convention inspection; no extension may own these seams.

### Acceptance criteria

- Both exact source revisions are recorded.
- Every audited claim distinguishes shipped/default, optional, experimental, and
  documented limitation states.
- The report explains why broad DeepSeek features are accepted, rejected, or
  already covered; it does not equate package count with build strength.
- Every material DeepSeek advantage relevant to robust building has an explicit
  disposition.
- No comparator process or scored workload is run.
- No obsolete P6 benchmark production or test surface remains on the branch.
- Any recommended gap has a bounded design, affected surfaces, security model,
  tests, fault injections, cleanup, rollback, recovery, and P7 gate impact.
- If P6.4 is approved, every local child-process family has one scrubbed
  environment/tree ownership policy; command/evidence families add bounded
  tail and optional complete-output artifacts. Output beyond either memory or
  spill capacity becomes a lossy-output fact and never kills or reclassifies a
  command solely for log volume. Cleanup settles only after tree quiescence or
  a typed blocking failure.
- Guarded/Project generated commands fail closed outside exact granted roots.
  Windows partial enforcement and the explicit Full bypass are durable and
  user-visible; neither is described as a container or absolute security
  boundary.
- Repository/user Git hooks, helpers, fsmonitor, external diff/textconv, and
  unapproved filter drivers cannot execute outside the same boundary.
- Every filesystem mutation re-canonicalizes its actual target at the trusted
  seam. Existing-file text replacement requires the current observed revision,
  and creation is create-if-absent. The implementation does not claim atomic CAS
  against external writers.

### Tests and validation

- Verify both Git revisions and status without modifying DeepSeek.
- Inspect the Runner diff back to the P5 exit revision and confirm benchmark-only
  removal does not touch product Build mode.
- Search for imports or package commands referring to removed robust-build parity
  and adapter modules.
- For P6.1–P6.3, run static/type/test checks only if cleanup can affect executable
  product code; otherwise prove the product surfaces equal the verified P5 exit.
- For approved P6.4 packets, run the exact failed check first, then affected
  tests, Runner typecheck, targeted ESLint, Windows Job/ACL/process inspection,
  and only the impact-bounded wider gates.
- P6.4 phase exit requires the complete Runner V2 gate, both maintained Node LTS
  lines, relevant product Build surfaces, reproducible Runner archives, Git
  preflight, non-admin NTFS validation, external state/temp roots, and an OS
  audit with no residual Jobs, helpers, ACL grants, or spills.

### Required evidence and prove-red injections

- Audit evidence is the exact source paths/lines and revision identities in the
  persisted report.
- Benchmark cleanup must prove no remaining import or command reaches a removed
  module.
- P6.1–P6.3 are documentation/disposition packets and introduce no runtime guard,
  so prove-red is not applicable to them.
- Every runtime guard added by an approved P6.4 gap plan must be proven red,
  reverted, and proven green under the global doctrine.
- Mandatory P6.4 faults cover: a surviving grandchild and TERM-ignoring tree;
  timeout/cancellation/restart across command, LSP, MCP, and configured-provider
  transports; output above memory tail and spill cap with lossy continuation;
  spill ACL/close/disk faults; inherited fake secrets; unavailable/broken/partial
  sandbox backends; outside writes, symlinks, junctions, hard-link residuals,
  one-call path escalation and revocation failure; Git hooks/filters/helpers/
  fsmonitor/textconv; stale replacement, create races, and a controlled external
  writer race proving the documented non-CAS limitation.

### Cleanup, rollback, and recovery

- Preserve the DeepSeek `.vs/` directory and all pre-existing user changes.
- Delete only the three tracked benchmark files introduced after P5 and the four
  abandoned untracked drafts named in the capability audit.
- The capability report remains durable even if the proposed gap is waived.
- If gap implementation fails, restore the last verified P5 product state,
  retain the audit, and keep P7 locked.
- Approved P6.4 owns every Job handle, ACL entry, private temp/cache, and spill.
  Startup reconciles or revokes leftovers before new work; cleanup failure never
  falls back to an ambient spawn. Older active capability contracts pause for
  explicit migration/restart.

### Definition of Done and exit gate

- The benchmark is recorded as skipped by owner decision.
- The source audit and capability disposition are current and complete.
- Benchmark-only code is removed.
- Every high-value gap is either verified through its approved gap phase or has
  an explicit owner waiver with residual risk.
- If approved, P6.4a–P6.4g meet every audit acceptance criterion with current
  red/revert/green evidence, cleanup, recovery, maintained-LTS, package-parity,
  and final adversarial evidence.
- P7 unlocks only after this exact outcome.

---

### Task 7: P7 — Real-world Build-mode qualification

**Purpose:** Build a non-trivial application through the actual product Build-mode path and prove the improved system works as intended without manual code repair.

**Priority:** P0 Final gate

**Dependencies:** P6 disposition, every approved gap closure, and OD-1

### Entry conditions and scope

- The user selects the project/repository and business brief.
- Acceptance criteria are frozen before model execution.
- The target must be suitable for exercising:

  - Multiple independently schedulable work areas.
  - Cross-module integration.
  - A user-facing browser flow.
  - Build and automated tests.
  - Runtime smoke.
  - Persistent data or another meaningful application boundary.
  - At least one deliberate mid-run guidance event.
  - One controlled runner restart.
  - Independent-verifier qualification mode.
  - Generic language-intelligence use where the selected stack supports it.

### Explicit exclusions

- No direct manual edits to rescue the application.
- No production deployment, destructive migration, real customer data, or production credentials unless separately authorized.
- No altering acceptance criteria after seeing failures.
- Qualification failure cannot be called partial success.

### Requirements assigned

- RW-1.1: Implement a real-world project using improved Build mode.
- RW-1.2: Verify that the modifications and overall system work as intended.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P7.1 | Freeze the qualification charter: brief, acceptance criteria, browser journeys, external boundaries, model team, budget, risk policy, restart point, guidance injection, and independent oracle. | Charter consistency and oracle self-test |
| P7.2 | Prepare a clean isolated repository and runner state. Verify reference/negative controls, tools, LSPs, browser, providers, and recovery hooks before model calls. | Environment certification |
| P7.3 | Start the application exclusively through the product Build-mode UI/native control plane. Capture the initial objective, planned criteria, model assignments, and integration baseline. | Provision/start smoke |
| P7.4 | During execution, submit the frozen guidance item and perform the controlled runner restart after a durable event boundary. Answer any legitimate Architect question through the product UI. | Guidance/restart projection checks |
| P7.5 | Let Runner V2 repair technically determinable failures, complete final verification, run the independent verifier, and reach explicit project handoff without manual repository edits. | Live criterion and gate audit |
| P7.6 | Run the external oracle, inspect the handed-off Git result, browser flows, audit bundle, recovery trail, LSP/plugin evidence, budgets, cleanup, and absence of unauthorized effects. | Full qualification gate |

### Expected surfaces

Primarily exercised rather than newly modified:

- Build-mode UI and native client.
- Runner V2 control plane.
- Scheduler/event/evidence/session/budget SQLite stores.
- Task and verification workspaces.
- Integration branch and final handoff.
- Browser, managed processes, plugin/LSP, provider routing, and recovery.
- Certified qualification report.

If P7 finds a product defect, implementation occurs only by reopening the owning phase, not by editing the target application manually.

### Acceptance criteria

- The resulting application satisfies every frozen criterion.
- Every task submission and Architect review has exact criterion evidence.
- Final verification targets the handed-off integration revision.
- Build, tests, runtime smoke, and browser checks are current and green.
- The independent verifier is genuinely independent and approves the same revision.
- Mid-run guidance is durably acknowledged and reflected in the plan or a recorded no-change rationale.
- Runner restart loses no task, evidence, question, budget, or integration state.
- Generic language intelligence is observed where configured.
- No protected oracle, unauthorized external effect, or user working-tree overwrite occurs.
- Final Git history and audit export agree.
- Runner-owned processes, worktrees, browser sessions, and state leases clean up correctly.

### Tests, evidence, and fault injections

Required evidence bundle:

- Initial objective hash and frozen charter.
- Complete task/criterion matrix.
- Worker evidence mappings and Architect verdicts.
- User-guidance and question/answer events.
- Pre- and post-restart scheduler/session projections.
- Integration commit history.
- Final-verification plan and facts.
- Independent-verifier risk assessment and verdict.
- External build/test/runtime/browser oracle.
- Screenshots, browser events, and network/console results.
- Plugin/LSP traces where applicable.
- Budget and provider-health records.
- Cleanup and handoff report.

Prove-red controls:

- Run the external oracle against the negative-control revision.
- Suppress one required criterion link in a cloned audit: audit must fail.
- Point verification at an earlier revision: qualification checker must fail.
- Remove the verifier verdict from a cloned projection: checker must fail.
- Replay the restart without its recovery event: recovery assertion must fail.
- Revert each injected fault and prove the full qualification checker green.

### Cleanup, rollback, and recovery

- Preserve the qualification audit and selected handoff result.
- Delete only disposable qualification worktrees/state after export.
- Keep the user’s original project baseline recoverable.
- If a defect is found, return to its owning phase, repair it within that phase’s budget, rerun affected regression gates, then restart P7 from a clean baseline.
- No failed qualification workspace is promoted.

### Definition of Done and exit gate

The qualification closes only when every frozen project criterion and every Runner V2 improvement exercised by the charter has current objective evidence.

The final output must be the exact success outcome. Otherwise it remains at the exact blocked outcome until a genuine decision or external dependency is resolved.

---

# 3. Requirement-to-phase traceability

| Requirement | Canonical requirement | Sole owning phase | Verification anchor |
|---|---|---|---|
| ENV-1 | Maintained-LTS Node policy with no fixed patch pin | P1 | Runtime/client/package/publication compatibility tests |
| HVI-1.1 | Mandatory final-verification task | P2 | Singleton verification-generation test |
| HVI-1.2 | Verify canonical integration state | P2 | Target-revision/workspace proof |
| HVI-1.3 | Build and tests | P2 | Required-category command evidence |
| HVI-1.4 | Runtime smoke where applicable | P2 | Managed-process/runtime evidence |
| HVI-1.5 | Browser evidence where applicable | P2 | Playwright snapshot/screenshot/events |
| HVI-1.6 | Green current verification before completion | P2 | `complete_run` authority/gate tests |
| HVI-2.1 | Structured criteria for every task | P1 | Plan/task validators |
| HVI-2.2 | Submission evidence mapped per criterion | P1 | Submission/change-set guards |
| HVI-2.3 | Architect review mapped per criterion | P1 | Review projection and approval guards |
| HVI-2.4 | Criteria durable across lifecycle | P1 | Retry/revision/recovery/audit tests |
| HVI-3.1 | Durable mid-run user guidance | P3 | Scheduler events and SQLite replay |
| HVI-3.2 | Guidance consumed without objective replacement | P3 | Objective hash/context tests |
| HVI-3.3 | Architect `ask_user` | P3 | Lifecycle/API/UI tests |
| HVI-3.4 | Durable answer and restart recovery | P3 | Question-version/recovery tests |
| HVI-4.1 | High-risk determination | P4 | Deterministic risk policy |
| HVI-4.2 | Independent verifier model | P4 | Runtime/model/author independence |
| HVI-4.3 | Verifier receives integrated evidence | P4 | Context and evidence coverage tests |
| HVI-4.4 | High-risk completion requires verdict | P4 | Completion/staleness gates |
| HVI-5.1 | DeepSeek-style plugin seams | P5 | Extension API and loader |
| HVI-5.2 | Generic LSP | P5 | Multi-language LSP fixtures |
| HVI-5.3 | Retain Runner kernel | P5 | Scheduler/worktree/integration regression gates |
| HVI-6A.1 | Source-level DeepSeek capability audit, no benchmark | P6 | Revision-bound persisted audit |
| HVI-6A.2 | Material robust-build capability disposition | P6 | Evidence matrix and limitations |
| HVI-6A.3 | Withdraw benchmark requirements and remove abandoned code | P6 | Owner amendment, diff, and import search |
| HVI-6A.4 | Shared safe child-process lifecycle/environment/output | P6 | P6.4a, P6.4b, P6.4d or named owner waiver |
| HVI-6A.5 | Generated-process file-write confinement and exact grants | P6 | P6.4a, P6.4c, P6.4g or named owner waiver |
| HVI-6A.6 | Git indirect-execution boundary | P6 | P6.4e or named owner waiver |
| HVI-6A.7 | Trusted filesystem fence and optimistic freshness guards | P6 | P6.4f or named owner waiver |
| HVI-6A.8 | P7 remains locked until every gap is verified or waived | P6 | P6 exit gate |
| RW-1.1 | Build a real-world project through Build mode | P7 | Product-path qualification run |
| RW-1.2 | Verify modifications and intended operation | P7 | Frozen charter and external oracle |

Coverage: **32 of 32 active requirements assigned once; zero unowned and zero multiply owned.** The nine former HVI-6.1–HVI-6.9 comparison requirements were withdrawn by the owner on 2026-08-28 and are not active requirements.

### Doctrine applicability matrix

| Doctrine | P1 | P2 | P3 | P4 | P5 | P6 | P7 |
|---|---:|---:|---:|---:|---:|---:|---:|
| PREPARE and baseline evidence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| One coherent packet | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Smallest safe validation first | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audit all assigned requirements | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Governed automatic repair | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Failed/affected reruns before broad gates | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Prove red, revert fault, prove green | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Final adversarial re-audit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| No unrelated phase expansion | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Exact two phase outcomes only | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

# 4. Execution queue

P1–P5 are verified. P6.1 source audit and P6.2 benchmark cleanup close with the
clean commit that force-tracks the reviewed report and this amendment. The next
eligible packet after that publication gate is:

> **P6.3 — Approve or waive the cohesive execution-safety gap design**

Its first execution actions are:

1. Review the persisted capability audit and its evidence anchors.
2. Confirm that no benchmark executable or import remains.
3. Present the recommended shared process lifecycle/output/environment seam,
   Windows write boundary and grant semantics, Git indirect-execution policy,
   trusted filesystem fence/freshness guards, audit, cleanup, and recovery scope.
4. If approved, execute P6.4a–P6.4g in order under the global doctrine before P7.
5. If waived, record the explicit owner waiver and residual host-safety/data-loss
   risk before P7.

Full queue:

```text
P1.0 → P1.1 → P1.2 → P1.3 → P1.4 → P1.5 → P1.6 → P1 gate
P2.1 → P2.2 → P2.3 → P2.4 → P2.5 → P2.6 → P2 gate
P3.1 → P3.2 → P3.3 → P3.4 → P3.5 → P3.6 → P3 gate
P4.1 → P4.2 → P4.3 → P4.4 → P4.5 → P4.6 → P4 gate
P5.1 → P5.2 → P5.3 → P5.4 → P5.5 → P5.6 → P5 gate
P6.1 audit → P6.2 benchmark cleanup → P6.3 owner decision
  approved → P6.4a → P6.4b → P6.4c → P6.4d → P6.4e → P6.4f → P6.4g → P6 gate
  waived   → durable named-risk waiver → P6 gate
P7.1 → P7.2 → P7.3 → P7.4 → P7.5 → P7.6 → final gate
```

# 5. Genuine unresolved owner decisions

Two current owner decisions remain:

**OD-1 — Real-world qualification target**

Before P7, the user must choose or approve the actual application brief/repository and its business acceptance criteria. It should be non-trivial, browser-testable, safe to run in isolation, and free of production data or credentials.

**OD-2 — DeepSeek gap-closure design**

The source audit found one cohesive execution-safety gap with four facets:
inconsistent child environment/output/tree ownership; no operating-system
file-write boundary for generated commands; repository-controlled programs that
can execute indirectly through Runner-owned Git; and a missing trusted
last-mile filesystem fence plus optional revision on existing-file `fs.write`.
The recommended Windows-first design, exact permission escalation and partial
enforcement semantics, seven implementation packets, residual limits, tests,
faults, rollback, and recovery are specified in
`docs/superpowers/plans/2026-08-28-deepseek-harness-capability-audit.md`. The
owner must approve that design or explicitly waive every named residual risk
before P7.

OD-1 does **not** block P1–P6. OD-2 blocks P6.4 and therefore P7. No other
routine technical question or owner decision is currently required.
