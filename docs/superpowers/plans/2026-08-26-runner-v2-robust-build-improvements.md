# Runner V2 Robust Build Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan phase by phase and `superpowers:test-driven-development` for every implementation packet.

**Goal:** Strengthen Runner V2 for robust application delivery from user requests, audit DeepSeek Harness for beneficial missing capabilities, close any approved high-value gap, and then qualify the result with a real-world Build-mode project.

**Architecture:** Extend the existing durable scheduler, worktree, evidence, integration, recovery, and handoff kernel. Add criterion-level contracts, canonical integrated verification, durable user steering, independent high-risk verification, protected extension/LSP seams, a portable capability-selected execution-safety boundary, and certified qualification without transferring lifecycle authority out of the kernel or making a platform-specific primitive a product requirement.

**Tech stack:** Strict TypeScript, Node.js maintained LTS release lines, Node built-in SQLite, Git worktrees, React 19/Next.js client surfaces, and Playwright/browser evidence.

**Canonical authority:** This file persists the plan approved in the conversation on 2026-08-26. ENV-1 records that Runner V2 must not force Node.js 24.18.0 or any other single patch release. On 2026-08-28 the owner cancelled the comparative P6 benchmark and replaced it with a source-level capability audit of the local DeepSeek Harness repository. Later that day the owner rejected the audit's Windows-first gap design and approved a portable-core design with deterministic capability-selected adapters, optional Windows Job enhancement, and AI-authored operating-system commands restricted to exceptional recovery. The amended audit is recorded in `docs/superpowers/plans/2026-08-28-deepseek-harness-capability-audit.md`.

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

**2026-09-06 scoped P6.6 amendment, source updated 2026-09-08:** The owner replaced P6.6's workflow prompt with `Plan_Prompt_4.txt`, preserved at `docs/superpowers/specs/2026-09-08-runner-v2-evidence-gated-planning-source.txt`; its identity, complete traceability and readiness live in the P6.6 plan/state index. Sections 2 and 8 of `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md` govern its delivery. The source sets a maximum of four implementation workers; the actual T4/T5 DAG uses only two. It requires resumable planning, exclusive assignment, default three evidence-backed repairs per stable issue (explicit project overrides preserved), meaningful original RED/GREEN without redundant same-invariant mutation, one combined independent deliverable review with scoped correction review, and impact-based validation with the full suite on the final candidate unless a stronger mandate applies. This changes no P1–P6.5/P7 control, existing run policy or active cleanup budget. Source replacement is not execution authorization; parent phase exits remain unchanged.

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
| P6 | DeepSeek capability audit and portable gap closure | P0 Release gate | HVI-6A | P1–P5 | P6.5 after verified gap closure |
| P6.5 | Review-gap closure: plan critique, exit-code gate, repair-cycle cap, worker replan, context manifests, two-pass verifier (`docs/superpowers/plans/2026-09-02-runner-v2-p6-5-review-gap-closure.md`) | P1 High | RG-1–RG-6 | P6 verified | P6.6 |
| P6.6 | Evidence-gated specification-to-plan delivery (`docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md`) | P0 High | EP01–EP32; exact leaf ownership in its section 6 | P6.5 verified | P7 subject to OD-1 |
| P7 | Real-world Build-mode qualification | P0 Final gate | RW-1 | P6.6 verified and OD-1 | Release decision |

The top-level chain is intentionally serial. Later features consume the durable state and invalidation rules established by earlier phases. P6.6's internal BP3/BP4 acceptance groups permit only the independent task lane documented in its plan; they do not allow overlap with unfinished P6 or P6.5.

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
- HVI-6A.4: Give every local Runner child-process family one portable durable
  identity/lifecycle contract, consistent scrubbed environment, deterministic
  capability-selected tree ownership, cancellation, quiescence, restart
  recovery, and bounded exceptional AI recovery; give command/evidence families
  bounded tail plus optional complete output artifacts without failing solely
  for log volume.
- HVI-6A.5: Add capability-selected, fail-closed generated-process file-write
  confinement with exact permission grants and honest enforcement reporting.
  No operating-system primitive may be a product requirement; strict modes use
  an attested isolated executor or qualifying optional native backend, and Full
  access is the only ordinary unconfined bypass.
- HVI-6A.6: Prevent repository/user-controlled Git hooks, filters, helpers,
  configuration, and related programs from bypassing the execution boundary.
- HVI-6A.7: Add a trusted last-mile fence to every filesystem mutation and
  optimistic revision/create guards to text replacement/creation while retaining
  the explicit external-TOCTOU limitation.
- HVI-6A.8: Do not unlock P7 until every discovered high-value gap in the
  approved portable design is verified.

### Work packets

| Packet | Executable work | Smallest initial validation |
|---|---|---|
| P6.1 | Verify both revisions and perform the read-only capability audit. | Evidence/path/revision review |
| P6.2 | Persist the audit, update plan traceability, and delete only the abandoned P6 benchmark files. | Git diff and repository search for removed P6 surfaces |
| P6.3 | Present the smallest high-value gap-closure design, resolve the portability boundary, and record architectural approval. | Requirement/design audit |
| P6.4a | Freeze the portable threat model, capability/grant types, generic process identity/result/output records, backend SPI, capability-contract version, and migration refusal. | Platform-neutral contract/schema/recovery tests |
| P6.4b | Implement centrally scrubbed child environments and private bounded tail/spill with lossy continuation independently of process ownership. | Environment/output one-shot fixtures |
| P6.4c | Implement deterministic ownership, escalation, quiescence, and restart reconciliation behind the backend SPI: POSIX group/session, Windows baseline with optional Job enhancement, and isolated-executor adapters. | Backend contract, tree, PID-reuse, cancellation, and restart fixtures |
| P6.4d | Implement capability discovery and attested isolation-provider selection, exact one-call path grants, strict-mode fail-closed behavior, Full bypass, enforcement disclosure, and lease recovery/revocation. | Fake-provider contracts and isolated-executor integration fixtures |
| P6.4e | Route one-shot, evidence, final-verification, managed, Git, LSP, MCP, and locally spawned provider surfaces through the shared primitives while retaining only protocol framing. | Per-family process regressions and raw-spawn audit |
| P6.4f | Harden every Runner Git command against hooks, helpers, filters, external diff/textconv, ambient configuration/credentials, and outside writes. | Repository-controlled Git escape fixtures |
| P6.4g | Add the portable trusted filesystem mutation fence, existing-file revision requirement, create-only primitive, symlink/junction-race handling, and honest external-TOCTOU classification. | Filesystem stale/create/alias/symlink fixtures |
| P6.4h | Implement bounded AI exceptional recovery with durable proposals, birth/scope/authority validation, typed routine-recovery refusal, user escalation, and audit/client disclosure. | Recovery-contract, recycled-PID, ambiguity, authority, and client projection tests |
| P6.4i | Complete cleanup integration, documentation, packaged artifacts, cross-platform contract CI, final adversarial re-audit, and the phase exit gate. | Cleanup/package/platform gates, then one final broad gate |

The owner approved the portable design. P6.4a–P6.4i execute in order after the
persisted design review gate. The former Windows-first implementation is not an
approved alternative and cannot satisfy P6.

### Expected files and surfaces

- `docs/superpowers/plans/2026-08-28-deepseek-harness-capability-audit.md`
- This canonical plan and its execution ledger.
- Removal of `lib/benchmark/robust-build/*` and corresponding P6-only scripts
  introduced after P5.
- Expected protected-kernel surfaces include a shared subprocess runtime,
  platform-neutral process record, backend SPI, child-environment/output-spool
  modules, a POSIX group/session adapter, a Windows adapter with optional Job
  enhancement, an attested isolated-executor provider, an opaque execution-grant
  contract, a filesystem mutation fence, the central Git runner, ToolBroker
  integration, capability contract/recovery/audit/client projections, Runner
  packaging, documentation, CI, and focused fixtures/tests. Exact filenames are
  frozen in P6.4a after current source-convention inspection; no extension or
  model-loaded code may own these seams, and no platform-specific model tool is
  added.

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
- Every local child-process family has one platform-neutral durable process
  identity and lifecycle contract, one scrubbed environment/output policy, and
  deterministic capability-selected ownership. Command/evidence families add
  bounded tail and optional complete-output artifacts. Output beyond either
  memory or spill capacity becomes a lossy-output fact and never kills or
  reclassifies a command solely for log volume. Cleanup requiring proof settles
  only after the selected backend verifies tree quiescence or records a typed
  blocking failure.
- The model-facing tools, durable process schema, permission semantics, and
  recovery protocol are the same on Windows, Linux, and macOS. Job Objects are
  optional; managed-process and LSP availability is capability-selected rather
  than Windows-only, and a call pauses only when its requested semantic
  capability is unavailable.
- Guarded/Project generated commands select an attested backend that can enforce
  the exact granted roots or fail closed before launch. Native local execution
  is never mislabeled as confined. The explicit Full bypass and every partial,
  unavailable, or unverified capability are durable and user-visible; none is
  described as a container or absolute security boundary. Full bypass never
  disables environment scrubbing, output bounds, deterministic ownership, or
  cleanup accounting.
- AI-authored platform commands are restricted to bounded exceptional recovery
  after Runner validates process birth, target scope, and authority. Routine
  lifecycle control and crash cleanup never require a model call.
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
- For P6.4 packets, run the exact failed check first, then affected tests,
  Runner typecheck, targeted ESLint, platform-neutral backend/provider contract
  tests, current-host process/isolation inspection, and only the impact-bounded
  wider gates.
- P6.4 phase exit requires the complete Runner V2 gate, both maintained Node LTS
  lines, relevant product Build surfaces, reproducible Runner archives, Git
  preflight, external state/temp roots, Windows/Linux/macOS CI for the portable
  contract and native ownership adapters, at least one attested isolated-executor
  integration, and an audit with no residual processes, helpers, leases, grants,
  or spills.

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
  transports; PID reuse, missing opaque identity, backend disappearance, and a
  false capability claim; output above memory tail and spill cap with lossy
  continuation; spill permission/close/disk faults; inherited fake secrets;
  unavailable/broken/partial isolation providers; outside writes, symlinks,
  junctions, hard-link residuals, one-call path escalation and revocation
  failure; Git hooks/filters/helpers/fsmonitor/textconv; stale replacement,
  create races, and a controlled external writer race proving the documented
  non-CAS limitation; attempted routine AI cleanup, validated bounded recovery,
  recycled-PID recovery denial, and authority-required destructive recovery.

### Cleanup, rollback, and recovery

- Preserve the DeepSeek `.vs/` directory and all pre-existing user changes.
- Delete only the three tracked benchmark files introduced after P5 and the four
  abandoned untracked drafts named in the capability audit.
- The capability report remains durable through implementation and rollback.
- If gap implementation fails, restore the last verified P5 product state,
  retain the audit, and keep P7 locked.
- P6.4 owns every process-owner handle/token, isolation lease or grant, private
  temp/cache, and spill. Startup reconciles or revokes leftovers before new
  work; cleanup failure never falls back to an ambient spawn or an AI-generated
  routine command. Older active capability contracts pause for explicit
  migration/restart.

### Definition of Done and exit gate

- The benchmark is recorded as skipped by owner decision.
- The source audit and capability disposition are current and complete.
- Benchmark-only code is removed.
- Every high-value gap is verified through the approved portable gap phase.
- P6.4a–P6.4i meet every audit acceptance criterion with current
  red/revert/green evidence, cleanup, recovery, maintained-LTS, package-parity,
  cross-platform contract evidence, and final adversarial evidence.
- This exact P6 outcome unlocks P6.5, not P7 directly; P6.5 and P6.6 must also be verified before P7.

---

### Task 7: P7 — Real-world Build-mode qualification

**Purpose:** Build a non-trivial application through the actual product Build-mode path and prove the improved system works as intended without manual code repair.

**Priority:** P0 Final gate

**Dependencies:** P6.6 verified and OD-1

### Entry conditions and scope

- P6.5 and P6.6 are verified; the qualification charter enables the new source-traceable planning/evidence policy together with plan critique, two-pass verification, and context manifests. Validate the same product path's source coverage, meaningful/reused evidence, integration acceptance and recovery; do not add a comparative benchmark.
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
| HVI-6A.4 | Portable child-process identity/lifecycle/environment/output and bounded AI exceptional recovery | P6 | P6.4a, P6.4b, P6.4c, P6.4e, P6.4h, P6.4i |
| HVI-6A.5 | Capability-selected generated-process confinement and exact grants without a required OS primitive | P6 | P6.4a, P6.4d, P6.4i |
| HVI-6A.6 | Git indirect-execution boundary | P6 | P6.4f |
| HVI-6A.7 | Trusted filesystem fence and optimistic freshness guards | P6 | P6.4g |
| HVI-6A.8 | P7 remains locked until every approved portable gap is verified | P6 | P6 exit gate |
| RW-1.1 | Build a real-world project through Build mode | P7 | Product-path qualification run |
| RW-1.2 | Verify modifications and intended operation | P7 | Frozen charter and external oracle |
| RG-1.1 | Plan-time risk is deterministic, durable, and raise-only | P6.5 | `assessPlanRisk` + reducer tests (P6.5.5a) |
| RG-1.2 | Independent read-only plan critic over the baseline revision | P6.5 | Critic runtime tests (P6.5.5b) |
| RG-1.3 | Typed findings bound to the plan revision | P6.5 | Contract parser + reducer tests (P6.5.5a) |
| RG-1.4 | Blocking findings force one Architect resolution before any worker | P6.5 | Build-runtime ordering test (P6.5.5c) |
| RG-1.5 | Unavailable or failed critic pauses or skips durably, never silently | P6.5 | Pause/skip tests (P6.5.5c) |
| RG-1.6 | Plan critique visible in UI and audit | P6.5 | Client/UI tests (P6.5.5d) |
| RG-2.1 | Satisfied verdicts citing failing command evidence are rejected unless explicitly accepted | P6.5 | Acceptance-contract + scheduler gate tests (P6.5.1) |
| RG-2.2 | Rule applies to Architect reviews and verifier verdicts | P6.5 | `validateSchedulerEvidenceEvent` tests (P6.5.1) |
| RG-2.3 | Accepted failures visible in audit and UI | P6.5 | Task-board render test (P6.5.1) |
| RG-3.1 | Durable per-run repair-plan limit (default 3) | P6.5 | `repair.policy_configured` reducer test (P6.5.3) |
| RG-3.2 | Reducer rejects repair plans beyond the limit | P6.5 | Reducer block test (P6.5.3) |
| RG-3.3 | Runner pauses at the limit; only the user extends | P6.5 | Build-runtime pause + actor tests (P6.5.3) |
| RG-3.4 | Cap survives restart and duplicate events | P6.5 | Replay/idempotency tests (P6.5.3) |
| RG-4.1 | Typed worker `request_replan` lifecycle tool | P6.5 | Worker lifecycle tool test (P6.5.2) |
| RG-4.2 | Architect reconciles the plan or refuses with evidence | P6.5 | Reducer auto-answer + reason tests (P6.5.2) |
| RG-4.3 | Replan requests visible in UI | P6.5 | Observability summary test (P6.5.2) |
| RG-5.1 | Every Architect, worker, and verifier context pack records a manifest | P6.5 | Runtime tests for all roles (P6.5.4) |
| RG-5.2 | Manifests durable, run-scoped, audit-exported | P6.5 | SQLite store + audit tests (P6.5.4) |
| RG-5.3 | Optional full pack text artifact | P6.5 | Spec flag + artifact test (P6.5.4) |
| RG-5.4 | Historical runs open manifests read-only | P6.5 | Read-only store test (P6.5.4) |
| RG-6.1 | Verifier records expectations from the baseline before seeing the implementation | P6.5 | Pass-1 context/tool tests (P6.5.6) |
| RG-6.2 | Kernel refuses a two-pass verdict without expectations | P6.5 | Reducer test (P6.5.6) |
| RG-6.3 | Adversarial prompt; unsatisfied verdicts carry location and reproduction | P6.5 | Prompt + parser tests (P6.5.6) |
| RG-6.4 | Two-pass verification restart-safe with baseline cleanup | P6.5 | Resume + cleanup tests (P6.5.6) |
| EP01–EP32 | Complete resumable evidence-gated specification-to-plan workflow; revised Plan_Prompt_4 source references and expanded obligations are defined in P6.6 section 6 | P6.6, through each row's single BP1–BP6 leaf owner | Same 32 stable IDs with updated sub-obligations, tasks and evidence; current planning verdict in its state index; no duplicate RG ownership |

Coverage index: **88 active requirements: 56 individually indexed above plus 32 EP requirements individually defined in the referenced P6.6 ledger.** Each has one acceptance-owning phase; P6.6 is the parent of its BP leaf owners, not a second owner. The nine former HVI-6.1–HVI-6.9 comparison requirements were withdrawn by the owner on 2026-08-28 and are not active requirements. The 24 RG requirements were added on 2026-09-02 with P6.5; their ownership and gates are unchanged. The 32 EP requirements were added on 2026-09-06 with the owner's separate P6.6 placement authorization. Mapping coverage does not claim implementation completion.

### Doctrine applicability matrix

| Doctrine | P1 | P2 | P3 | P4 | P5 | P6 | P6.5 | P6.6 | P7 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| PREPARE and baseline evidence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| One coherent packet | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Scoped parallel lane | ✓ |
| Smallest safe validation first | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audit all assigned requirements | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Governed automatic repair | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Scoped finite budget | ✓ |
| Failed/affected reruns before broad gates | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Prove red, revert fault, prove green | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Meaningful proof; no redundant mutation | ✓ |
| Final adversarial re-audit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Source/cross-task reconciliation; reuse valid reviews | ✓ |
| No unrelated phase expansion | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Exact two parent phase outcomes only | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

# 4. Execution queue

P6.5 is specified in `docs/superpowers/plans/2026-09-02-runner-v2-p6-5-review-gap-closure.md` and starts only after the exact P6 success output. P6.6 is specified in `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md` and starts only after the exact P6.5 success output and execution is resumed. P7 starts only after the exact P6.6 parent phase success output and OD-1. The 2026-09-06 placement amendment itself was planning only. The owner's subsequent instruction to finish P6 resumed the existing P6 execution; it did not start P6.5/P6.6/P7 or change their gates. Current proof is in `.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/progress.md`.

P1–P5 are verified. P6.1 source audit and P6.2 benchmark cleanup closed in the
clean publication commit. P6.3 is resolved by the owner's approval of the
portable-core, capability-selected design. The execution status as of
2026-09-06 is recorded in the portable execution-safety and cleanup packet reports:

> **Current checkpoint, 2026-09-11: P6 remains IN PROGRESS; cleanup-coordination C1–C5 is VERIFIED and its Task 8.0B3/P6.4e handback is UNBLOCKED. The final complete Runner graph passed 2,264 tests with zero failures plus all 12 configured client commands; the Windows POSIX-only skip is covered by the actual Linux 21/21 gate. Source binding, Runner static checks and owner-authorized self-review passed. This is not B3/P6 completion or a P6.5/P6.6/P7 unlock. The cleanup SDD packet's closure-2026-09-11/phase-c-final-report.md and closure-acceptance-proof.json own the exact result and preserved historical exceptions.**

Preserved earlier checkpoint:

> **P6: IN PROGRESS. P6.4e / Task 8.0B3 remains in cleanup coordination. The explicitly adjudicated C1 dispatcher prerequisite is independently accepted; C5 fourth MCP fixture correction is active. C3 round4 is independently verified and the exact retained fixture recovered successfully. C5 scoped acceptance and stable sources gate the exact native tests. B3 and P6 have no verified exit. The cleanup ledger owns current evidence, counters and routing.**

Independent spec adjudication classified the old current-task retained evidence
row as an existing C3 recovery omission, not Task11 residue or a C2 eighth repair.
Task3 already owns finalized evidence/manifest and store/runtime integration;
existing fourth-of-five authority is sufficient. The cleanup packet's round4
ruling/brief/baseline require effect-free full manifest verification, exact fenced
atomic observation, unchanged generic terminal-finalization policy, causal and
guard fault proofs, affected checks and independent review. C5 remains three of
five test repairs, C2 seven total, C4 two of five; no counters reset.

Preserved C5 readiness entry:

C3 round3 passed independent review, 156 affected checks, fault/restored proof
and static checks. The latest native failure differs from the earlier evidence
cleanup failure: durable acceptance was mistaken for delivery-ready output while
evidence writes were pending. Authenticated retained state has all six cleanup
resources verified and session released. Independent classification routes the
readiness correction to C5 round3, without production changes or counter reset.
The cleanup ledger records both native attempts and exact root dispositions.

Preserved earlier C3 entry:

The new persistent-output run has complete TAP/exit/handle and authenticated
read-only state: quiescence/output verified, finalized lossy continuation,
evidence blocked. Its exact root remains preserved. Independent diagnosis maps
the overlapping live/replacement spool cleanup lifecycle to C3/spec C/E. C3
round3 (of five, two previously used) requires nonnative causal RED, preserved
ownership refusal, material faults, affected checks and independent review before
native rerun. See the cleanup packet `task-3-round3-brief.md` and current ledger.
No eighth C2 round, C5 counter reset, or historical fixture control is authorized.

C2 round 7 is verified; its report and independent review are in the cleanup
ledger directory. OD-C2-7 below is resolved for that one correction. This reopens
C5's exact failed integration only, producing the current results above. C5 has used two test-repair cycles of five,
which do not fund C2 production work. The third exact MCP attempt's terminal
TAP/exit result is unknown due to a lost command handle, but authenticated
read-only retained state proves a cleanup blocker. Independent source review
identified the cycle; see the cleanup ledger and `task-5-report.md` for exact
evidence and the retained fixture's ownership-safe disposition.

Tasks 1–7 and 8.0A/B1/B2 have prior verified exits. B3 has no exit yet; its
September 2 usage-limit blocker is historical and independent review has resumed.
The strengthened same-adapter retained-output recovery checks exposed a cleanup
latch bug; its narrow repair and current evidence are tracked in
`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0b3-report.md`.

The fifth repair round's review had no blocking code findings, but final real
integration was non-green (5/7). The subsequent focused architecture review
identified cross-component protocol, recovery, evidence and witness-lifecycle
defects. On September 5 the owner explicitly approved implementation of the
recommended redesign. Its specification and C1–C5 queue are saved in
`docs/superpowers/specs/2026-09-05-runner-v2-cleanup-coordination-design.md` and
`docs/superpowers/plans/2026-09-05-runner-v2-cleanup-coordination.md`; current
evidence is in that plan's SDD ledger. This replaces the exhausted patch campaign,
not its historical evidence. The old recordless CLI process chain separately
still requires exceptional cleanup approval and remains excluded from mutation.
No verified exit has been issued. Only B3's verified exit unlocks 8.1 Git, then 8.2 MCP,
8.3 LSP, 8.4 managed processes and the local-provider/static launch audit.
Tasks 9–12 (Git hardening, filesystem fence, recovery/disclosure, packaging and
platform gates) still precede the P6 exit. B3 completion is not P6 completion;
neither P6.5, P6.6 nor P7 is unlocked by B3 alone.

Full queue:

```text
P1.0 → P1.1 → P1.2 → P1.3 → P1.4 → P1.5 → P1.6 → P1 gate
P2.1 → P2.2 → P2.3 → P2.4 → P2.5 → P2.6 → P2 gate
P3.1 → P3.2 → P3.3 → P3.4 → P3.5 → P3.6 → P3 gate
P4.1 → P4.2 → P4.3 → P4.4 → P4.5 → P4.6 → P4 gate
P5.1 → P5.2 → P5.3 → P5.4 → P5.5 → P5.6 → P5 gate
P6.1 audit → P6.2 benchmark cleanup → P6.3 portable design approved
  → P6.4a → P6.4b → P6.4c → P6.4d → P6.4e → P6.4f → P6.4g → P6.4h → P6.4i → P6 gate
P6.5.0 → P6.5.1 → P6.5.2 → P6.5.3 → P6.5.4 → P6.5.5a → P6.5.5b → P6.5.5c → P6.5.5d → P6.5.6 → P6.5 gate
P6.6: T1 → T2 → T3 → (T4 || T5, isolated writers) → integrate T4 then T5 → T6 → T7 → T8 → P6.6 gate
P7.1 → P7.2 → P7.3 → P7.4 → P7.5 → P7.6 → final gate
```

# 5. Genuine unresolved owner decisions

OD-C2-7 is resolved for the seventh bounded correction. OD-1 remains a later
qualification decision and does not block P6:

**OD-C2-7 — Bounded cleanup architecture correction authority**

Resolved 2026-09-06: `resume the work` directly followed the explicit question
requesting approval of this correction, including tests and independent review.
It authorizes one additional C2 repair round (seventh total, not a counter reset)
to transfer the live family attachment to its existing evidence-only cleanup
reader before workload quiescence, without awaiting output exhaustion. Draining
and ACKs must continue while stopping proceeds; separate output settlement,
fences, evidence bounds, deadlines and backend/witness proofs stay mandatory.
Require the combined accepted-but-undelivered frame/stopped family pump/
ACK-dependent termination regression RED, material reversal RED, restored GREEN,
affected contracts/static checks and independent re-review before resuming C5.
The independently reviewed defect belongs to C2's existing Host split/ordering
requirement; it must not be renamed C5 work to bypass exhausted authority.

**OD-1 — Real-world qualification target**

Before P7, the user must choose or approve the actual application brief/repository and its business acceptance criteria. It should be non-trivial, browser-testable, safe to run in isolation, and free of production data or credentials.

The former OD-2 is resolved: the owner approved the portable-core,
capability-selected execution design and rejected the earlier Windows-first
proposal. P6.4 implementation is therefore mandatory before P7 and cannot be
replaced by a Windows-only implementation or a residual-risk waiver.

OD-1 does **not** block P6. OD-C2-7 no longer blocks the scoped correction.
No routine technical question or waiver of controls is requested.
