# D1g step 1 — source-to-delivery reconciliation

Reviewer: fresh context. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `codex/runner-v2-agent-capability` at `c81f632a`, base `6c166f97`. Source: `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` revision 4, sections D1 (constraints 1–4), D2, D3, D6 (items 1–8), D8, section 3, AC-1..AC-10, AC-17, AC-18, AC-24, AC-25.

This STEP 2 list was written from the source alone, before the integrated diff, evidence records, or tests.

## STEP 2 — obligation list (from source only)

Out of scope for this program, named by the source so they are not scored as missing: D4, D5, D7 (moved to P6.6); AC-11..AC-16 and AC-19..AC-23 (moved as EP33–EP38); P6.6 T3 ownership of new-policy planning read-only; P6.6 deliverable reviewer and coverage reviewer; section 3 item 1 (review ceiling is P7).

### D1 — failed context-manifest write

- **OB-D1-1 (constraint 1, AC-1).** `recordContextPack` retries internally with bounded backoff, then throws a typed `ContextManifestRecordingError`. None of the five call sites (architect, plan critic, verifier ×2, worker) is edited.
- **OB-D1-2 (constraint 2, AC-3 worker path).** The worker path does not become a failed task and does not re-raise into the dispatcher. The scheduler records the existing `paused` outcome, appends `run.paused`, and returns without failing the task. It must not skip `recordOutcome` (task left `running` and redispatched) and must not surface as `autonomous_pump_error`.
- **OB-D1-3 (constraint 3, AC-4 waiver).** `proceed_without_manifest` suspends recording for the run via a runtime switch owned by `context-manifest-store.ts`. The switch is re-derived from the durable waiver event before the first dispatch whenever a runtime is constructed. It covers all five call sites. The gap is attributed, never silent. Rationale is required.
- **OB-D1-4 (constraint 4, AC-4 abort).** `abort` is terminal in both stores and reaches `RunSupervisor.fail` with the reason recorded. Order: (1) durable abort sets the scheduler run to `failed`; a failed scheduler run never dispatches and refuses `run.resumed`; (2) `cli.ts` installs a lifecycle hook that carries `failed` to the supervisor at the moment of abort, on a pump step that reports `failed`, and at startup recovery when the scheduler is `failed` but the supervisor is not. A crash between the two steps cannot redispatch.
- **OB-D1-5 (AC-2).** An exhausted failure writes a durable note to the scheduler store, not the failed ledger.
- **OB-D1-6 (AC-3).** Exhausted failure pauses the run with a typed Architect decision on all four agent paths (architect, plan critic, verifier, worker). It never silently continues and never dies without the note.
- **OB-D1-7 (AC-4 resolutions).** The Architect resolves with exactly one of `retry`, `proceed_without_manifest` (rationale required), or `abort`. Each is durable, attributed, and restart-safe.
- **OB-D1-8 (retry budget).** `retry` resumes and re-attempts recording within a finite budget; exhausting that budget re-pauses with the existing note.
- **OB-D1-9 (rejected alternatives / section 3.2).** Recording is not silently non-gating and not purely fail-closed. The Architect cannot repair runner-private state. The only resolutions are retry, waive with a reason, or stop.

### D2 — capability model

- **OB-D2-1 (AC-5).** Each role's tool surface is an explicit allow-list, asserted at registration across every broker that role uses, failing closed.
- **OB-D2-2 (role table).** Worker: read, run commands, author project code, write plans/specs; no lifecycle authority. Architect: read; run commands in a disposable copy; no project-code authorship; write `docs/project/**` and the marked `AGENTS.md` / `CLAUDE.md` sections; lifecycle authority is plan, review, integrate, complete. Independent verifier: read; run commands in its own workspace; no authorship; no plan/spec writes; typed verdict only. Plan critic: read only; no commands; no authorship; typed findings only.
- **OB-D2-3 (AC-6).** The Architect can run commands in a disposable copy, subject to the run permission profile. Confinement accounts for the existing `containedDirectory` escape rejection.
- **OB-D2-4 (AC-8).** Verifier command execution is confined to the verifier's own workspace. The plan critic has no command execution. No reader mutates the user's project tree.
- **OB-D2-5 (AC-9a).** Verifier and critic cannot commit, integrate, complete the run, alter the plan, or review tasks.
- **OB-D2-6 (AC-9b).** The Architect retains `review_task`, `request_integration`, and `complete_run`.
- **OB-D2-7 (unchanged reader limits).** No reader commits, integrates, or completes the run. Verifier and critic additionally cannot alter the plan or review tasks.

### D3 — Architect MCP admission

- **OB-D3-1 (AC-10).** The Architect admits only MCP tools that `createMcpTools` maps to `readOnly === true`, as a checked class. Server-supplied names are not static allow-list entries. The class has its own assert, because the mapper always sets `effect: "external"` and `assertReadOnlyInspectionDefinition` cannot admit those tools. Predicate remains `readOnlyHint === true && destructiveHint === false`.
- **OB-D3-2.** Verifier and critic stay at zero MCP tools.
- **OB-D3-3 (rejected).** MCP is not banned for the Architect. Read-only MCP is not forced through an extra approval when the run permission profile is `full`.

### D6 — project documentation folder

- **OB-D6-1 (item 1, AC-7).** One lifecycle tool, `write_project_doc(path, content, summary)`, is the Architect's write path. The runner refuses `..`, absolute paths, links, and anything outside `docs/project/**` (except the marked entry-point files in item 2), both in the tool and at the durable append boundary.
- **OB-D6-2 (item 2, AC-17 splice).** The same tool may write the Architect's marked section of `AGENTS.md` (created if absent) and a one-line marked pointer in `CLAUDE.md` to `AGENTS.md`. The runner splices only between its markers. Text outside the markers is never changed. The section says what the folder holds, how to read it first, and how to update it.
- **OB-D6-3 (item 3).** A default layout template exists for the Architect to fill and keep current: `docs/project/README.md`, `STATE.md`, `specs/`, `plans/`, `decisions.md`, `evidence/`.
- **OB-D6-4 (item 4, AC-17 commit).** The write is committed on the integration branch with an Architect author and trailer, not into the user's working folder. No task, change set, or worker session is created. Applying a write costs no model call. Handoff still requires a clean project worktree and index. Documents reach the user's project at handoff with the code. The next build reads them from the project.
- **OB-D6-5 (item 5, AC-17 worker refusal).** Workers do not write `docs/project/**`. A worker change set that touches that tree is refused at integration through the existing conflict path, and the refusal names the paths.
- **OB-D6-6 (item 6).** The database stays the truth for gates. A document that claims tests passed approves nothing. Acceptance still requires recorded evidence.
- **OB-D6-7 (item 7, AC-25).** A new run, including `plan_only`, cannot complete or hand off until `docs/project/STATE.md` was written after the run's latest integrated change (for `plan_only`, at any point in the run) and the tree at that write holds `docs/project/README.md`, the marked `AGENTS.md` section, and the marked `CLAUDE.md` pointer. Runs created before this change are exempt.
- **OB-D6-8 (item 8).** A document commit changes only `docs/project/**` and the marked sections, so it does not reopen verification. The verified revision stays verified. Handoff delivers that revision plus the document commits on top.
- **OB-D6-9 (section 3.3).** During a run, documents live on the integration branch. A run that is never handed off delivers neither its code nor its documents. Documents are not written live into the user's working folder.

### D8 — reviewer independence

- **OB-D8-1 (AC-24 prefer).** Verifier and plan-critic selection prefer an eligible candidate whose model identity differs from the Architect's and from every change author's.
- **OB-D8-2 (AC-24 fallback).** Otherwise they fall back to an eligible candidate that shares a model identity, started in a new session whose event list is empty (no messages, tool results, or context from any other session). Exclusions that are not about model identity (for example a runtime excluded after a provider error) still apply.
- **OB-D8-3 (AC-24 record and show).** The review request records `independence: "distinct_model"` or `"fresh_context"` durably, and the UI shows it. Legacy events without the field replay as `distinct_model`.
- **OB-D8-4 (AC-24 pause).** The run pauses only when no eligible candidate exists at all (no healthy runtime with the required capability).
- **OB-D8-5 (rejected).** A distinct model is not required always. An existing session is not silently reused.

### Compatibility

- **OB-AC18.** Runs created before this change keep current semantics and remain replayable. This covers unstamped legacy runs for the completion check (AC-25 exemption) and legacy review events without `independence` (D8 item 3).

### Cross-packet questions the source implies (scored after the diff)

- Pause for a recording failure must still be able to complete once resolved, including interaction with synchronous document commit and the completion check.
- Reader command tools must be present on the fallback reviewer, in the correct workspace, and must still pass the allow-list asserts.
- New-run stamp, legacy unstamped replay, and abort/failed status must not contradict each other.
- Worker refusal of `docs/project/**` must not block the Architect's own document commits from reaching handoff.
- No reader mutates the user's project tree.
- No new silent failure path.
- Diff hunks outside the planned surfaces need a recorded controller decision (CD-1..CD-4 / PD-24 / PD-25) or they are unexplained.

---

## Obligation table

Integrated tree: `git diff 6c166f97..c81f632a` (52 files under `runner-v2`, `lib`, `components`, `scripts`). Evidence files were used only to locate tests. Status is from the code and the named tests.

| Obligation | Code | Test | Status |
|---|---|---|---|
| OB-D1-1 / AC-1 | `recordContextPack` retries up to `CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS` (3) with `CONTEXT_MANIFEST_RECORD_BACKOFF_MS` `[50, 150]`, then throws `ContextManifestRecordingError` (`runner-v2/src/context-manifest-store.ts`). `git diff` shows no change to any `recordContextPack(` call in the architect, plan-critic, verifier, or worker driver. | `runner-v2/test/context-manifest-store.test.ts` (bounded retry, exhaustion throws, artifact-put failures count) | DELIVERED |
| OB-D1-2 | `TaskScheduler.dispatch` catches `ContextManifestRecordingError`, appends `context_manifest.recording_failed`, then `recordOutcome` with `paused` (`task-scheduler.ts` `appendContextRecordingFailure` / `recordOutcome`). `tick` returns immediately unless `status === "running"`. If the note append throws, the original error is rethrown and is not recorded as a failed task. | `runner-v2/test/task-scheduler.test.ts` — "worker context recording failure appends one note and pauses without failing or redispatching"; "a context recording note whose scheduler append throws keeps the original error"; "a worker error other than context recording still fails the task" | DELIVERED |
| OB-D1-3 | `suspendContextRecording` / `isContextRecordingSuspended` in `context-manifest-store.ts`. Waiver stored on `contextRecording.waiver`. `BuildRuntime` constructor calls `rederiveContextRecordingSuspension()` before `new TaskScheduler`. Suspended `recordContextPack` returns without writing. Rationale required in `applyContextRecordingResolved`. | `context-manifest-store.test.ts` (suspension skips recording and is per-run); `scheduler-store.test.ts` ("proceed_without_manifest without a rationale is rejected"); `build-runtime.test.ts` (waiver suspends, restart re-derives — resolution harness) | DELIVERED |
| OB-D1-4 | Abort sets `status: "failed"` and `failureReason: "context_recording_aborted"` and clears `pauseReason` (`applyContextRecordingResolved`). Reducer refuses `run.resumed`, `task.transitioned`, and `worker.runtime_assigned` on a failed run. `tick` does not dispatch unless running. `cli.ts` installs `onBuildFailed` → `failBuildIfActive` and `onPumpResult` → `syncAutonomousBuildLifecycle`. Startup recovery in `NativeBuildManager.recover` calls `onBuildFailed` when the scheduler is `failed`. | `scheduler-store.test.ts` (abort fails the run; failed run refuses resume); `cli.test.ts` (`failBuildIfActive`, pump `failed`); `native-build-manager.test.ts` (startup recovery of a scheduler-failed run reaches the supervisor) | DELIVERED |
| OB-D1-5 / AC-2 | Note is `context_manifest.recording_failed` on the scheduler log, actor `runner`. It is not a context-manifest ledger write. | `scheduler-store.test.ts`; `task-scheduler.test.ts`; `build-runtime.test.ts` | DELIVERED |
| OB-D1-6 / AC-3 | Architect, plan critic, and verifier throws are caught by `BuildRuntime.stepOnce` and paused with a note (`recordContextRecordingFailure`). Worker path is OB-D1-2. Pump runs `resolveContextRecordingFailure` before reporting the pause (`native-build-manager.ts` `pump`, CD-1). | Architect: `build-runtime.test.ts`. Plan critic: `plan-critique-runtime.test.ts`. Verifier: `verifier-contracts.test.ts` ("verifier context recording failure pauses…"). Worker: `task-scheduler.test.ts`. | PARTIAL — the four paths pause with a note, but a completion-ready `finish`/`budgeted` run can hand off during the decision turn without a resolution. See BLOCKING finding. |
| OB-D1-7 / AC-4 | Tool `resolve_context_recording` allows only `retry`, `proceed_without_manifest`, `abort`. Reducer attributes actor and note sequence, requires rationale for the waiver, and is restart-safe because it is an event. User resume appends one `retry` ("User resumed the run.") before `run.resumed`, and `run.resumed` is rejected while the latest note is unresolved. | `architect-tools.test.ts`; `scheduler-store.test.ts`; `build-runtime.test.ts` (all three resolutions, user resume) | PARTIAL — the three resolutions work; handoff is a fourth way off the pause. Same BLOCKING finding. |
| OB-D1-8 | `CONTEXT_RECORDING_RETRY_LIMIT = 3`. A further `retry` throws and leaves the run paused on the unresolved note. A later failure appends a new note and pauses again. | `scheduler-store.test.ts` ("the context recording retry budget refuses a fourth retry"; one retry covering two notes uses one unit) | DELIVERED |
| OB-D1-9 / §3.2 | No silent success on exhaustion (throws). Not fail-closed at the first lock (bounded retry, then pause). No repair of the manifest database: only retry, waive, or abort. | `context-manifest-store.test.ts`; resolution tests above | DELIVERED for the recording function. The handoff bypass is the exception, scored under OB-D1-6. |
| OB-D2-1 / AC-5 | `role-capabilities.ts` `SURFACES` plus `assertRoleToolSurface` at architect inspection, verifier inspection/expectations, plan-critic inspection, and worker task registration. Unknown broker throws. Extra or missing required names throw. MCP names are not static allow-list entries. | `runner-v2/test/role-capabilities.test.ts` | DELIVERED |
| OB-D2-2 | Surfaces match the role table: worker has read, command, write, and git tools and no `complete_run` / `review_task` / `request_integration`. Architect inspection has `run_evidence_command` as optional and no project writes. Verifier inspection has the command; expectations do not. Plan critic has neither the command nor lifecycle tools. `READER_AUTHORITY_FORBIDDEN_TOOLS` and `ARCHITECT_LIFECYCLE_TOOLS` name the lifecycle split. | `role-capabilities.test.ts`; `architect-lifecycle-surface.test.ts` | DELIVERED |
| OB-D2-3 / AC-6 | `createArchitectCommandBroker` / `LazyArchitectCommandRuntime` (`native-architect-runtime.ts`). `architectCommandWorkspacePath` returns the disposable copy and ignores `projectRoot`. Broker `permissionProfile` is the run profile (`native-build-factory.ts` passes `spec.permissionProfile`). `containedDirectory` still binds command cwd (`evidence-tools.ts`). | `role-capabilities.test.ts` (disposable copy, `full` profile does not add an approval, project tree hash unchanged) | DELIVERED |
| OB-D2-4 / AC-8 | `verifierCommandWorkspacePath` returns the verifier workspace and ignores `projectRoot`. `createVerifierCommandBroker` registers only `run_evidence_command`. Plan-critic surface has no command tool. | `role-capabilities.test.ts` (verifier write lands in the workspace; project hash unchanged; uncontained double still cannot target the project through the production broker; plan-critic assert rejects an extra tool) | DELIVERED |
| OB-D2-5 / AC-9a | Verifier and critic surfaces exclude commit, integrate, complete, plan, and review tools. Reducer rejects verifier actors except verdict, expectations, and critique submission. | `role-capabilities.test.ts`; `native-verifier-runtime.test.ts` (forbidden names absent); `native-plan-critic-runtime.test.ts` | DELIVERED |
| OB-D2-6 / AC-9b | `createArchitectTools` still registers `review_task`, `request_integration`, and `complete_run` for non-`plan_only` runs. | `architect-lifecycle-surface.test.ts`; `architect-tools.test.ts` | DELIVERED |
| OB-D2-7 | Same surfaces and the verifier-actor reducer guard. | Same tests as AC-9a/AC-9b | DELIVERED |
| OB-D3-1 / AC-10 | `createMcpTools` sets `readOnly` from `readOnlyHint === true && destructiveHint === false` and always `effect: "external"` (`mcp-tools.ts`). Architect policy `read-only-class` admits only `readOnly && effect === "external" && name starts with "mcp."`. `assertArchitectInspectionMcpClass` is separate from `assertReadOnlyInspectionDefinition`. Names are `mcp.<server>.<tool>`, not a static list. | `role-capabilities.test.ts` ("Architect inspection admits only the read-only MCP class from a three-shape stub"); `mcp-tools.test.ts` | DELIVERED |
| OB-D3-2 | Verifier and plan-critic `mcpPolicy: "none"`. An `mcp.` name fails the assert. | `role-capabilities.test.ts` | DELIVERED |
| OB-D3-3 | Read-only MCP is registered. Under `permissionProfile: "full"` the class test records no approval call. | `role-capabilities.test.ts` (approvals array stays empty) | DELIVERED |
| OB-D6-1 / AC-7 | `write_project_doc` and `validateProjectDocPath` refuse empty, NUL, absolute, backslash, `..`, `.`, case variants, and paths outside `docs/project/**` plus `AGENTS.md` / `CLAUDE.md`. The reducer runs the same check on `project_doc.requested` and `project_doc.committed`. Symlinks are refused by `IntegrationManager.refuseProjectDocLink` before the write. | `project-docs.test.ts`; `project-doc-commit.test.ts`; `scheduler-store` path rejection via `applyProjectDocRequested` | PARTIAL — lexical refusal is in the tool and the append. Symlink refusal is only at commit. See MINOR finding. |
| OB-D6-2 / AC-17 splice | `spliceMarkedArchitectSection`, `agentsMarkedSectionSatisfies`, `claudePointerSatisfies`. Commit writes the splice for `AGENTS.md` / `CLAUDE.md` and raw content otherwise. Prompt `ARCHITECT_PROJECT_DOCS_INSTRUCTIONS` includes the holds / read-first / update text. | `project-docs.test.ts`; `project-doc-commit.test.ts` ("marked AGENTS.md bytes outside the section stay identical") | DELIVERED |
| OB-D6-3 | `DEFAULT_README_TEMPLATE`, `DEFAULT_STATE_TEMPLATE`, `DOCS_LAYOUT_LINES` (`project-docs.ts`), injected by `ARCHITECT_PROJECT_DOCS_INSTRUCTIONS`. | `project-docs.test.ts` | DELIVERED |
| OB-D6-4 / AC-17 commit | `IntegrationManager.commitProjectDocuments` commits on the integration worktree with `ARCHITECT_DOC_IDENTITY`, trailers `AIBoard-Run`, `AIBoard-Author: architect`, `AIBoard-Doc-Request`. `bindProjectDocCommit` performs that commit inside the tool call. No task, change set, or worker session is created. `applyToProject` still requires a clean project worktree. Next run reads the project after handoff. | `project-doc-commit.test.ts` (trailers, idempotent request id, `applyToProject` leaves files on the project, no model call on the commit path) | DELIVERED |
| OB-D6-5 / AC-17 worker | `projectDocumentConflictPaths` returns `docs/project` and `docs/project/**` before cherry-pick, status `conflict`, `conflictPaths` set. | `project-doc-commit.test.ts` ("a worker change under docs/project conflicts before cherry-pick") | DELIVERED |
| OB-D6-6 | `projectDocumentationReadiness` uses commit metadata only (path, sequence, entry-point booleans). It does not read document prose. Existing evidence gates are unchanged. | `project-doc-commit.test.ts` readiness cases; handoff test still records evidence before approval | DELIVERED |
| OB-D6-7 / AC-25 | New runs append `project_docs.policy_configured` version 1 before `run.initialized` (`configureProjectDocsPolicy`). `projectDocumentationReadiness` requires `docs/project/STATE.md` after `latestIntegratedTaskSequence` (any commit in the run for `plan_only`) plus README, marked AGENTS section, and marked CLAUDE pointer. `projectDocsPolicyVersion !== 1` skips the check. Handoff and `assertBuildCompletionReady` both call it. Integrating a task clears `documentTip` and stamps `latestIntegratedTaskSequence`. | `project-doc-commit.test.ts` (missing STATE, stale STATE, entry-point facts, `plan_only`, policy absent); `replay-compatibility.test.ts` | DELIVERED |
| OB-D6-8 | Document commits do not call `advanceIntegrationRevision`. A later task integration that is a strict descendant clears the tip and invalidates verification; an integrated revision equal to or behind the tip keeps the canonical integration revision (`build-runtime.ts` integrate branch). `revisionMatchesIntegrationOrDocumentTip` keeps a verdict on the code revision current after document commits. | `project-doc-commit.test.ts` ("handoff after STATE.md keeps final verification current"; tip-clear / stale STATE) | DELIVERED |
| OB-D6-9 / §3.3 | Writes go to the integration worktree. `applyToProject` is the handoff onto the user project and still requires a clean worktree and index. | `project-doc-commit.test.ts` (`applyToProject`; project hash before handoff) | DELIVERED |
| OB-D8-1 / AC-24 prefer | `RuntimeRouter.selectVerifier` prefers a candidate whose canonical model identity differs from the architect and every accepted change author. Plan critic uses the same selector. | `runtime-router.test.ts` | DELIVERED |
| OB-D8-2 | Otherwise the first remaining eligible candidate is `fresh_context`. `excludedRuntimeIds` still apply. `assertFreshContextRequest` requires zero prior session events and only the role pack messages. `assertFreshContextSessionStarted` requires the new session's only event to be `session.created`. A fresh-context load of another actor throws. Session ids are `verifier:<run>:` / `plan-critic:<run>:`, not the architect session. | `runtime-router.test.ts`; `native-verifier-runtime.test.ts` ("fresh-context verifier request omits architect and worker session text"); `native-plan-critic-runtime.test.ts` fresh-context cases; `verifier-contracts.test.ts` | DELIVERED |
| OB-D8-3 | `independence` is stored on the verifier review and plan-critique request. `parseReviewerIndependence(undefined)` and `recordedReviewerIndependence` return `distinct_model`. UI: `RunnerV2ObservabilityPanel.tsx` ("same model, fresh context"). | `verifier-contracts.test.ts`; `plan-critique.test.ts`; `scripts/test-runner-v2-observability.mts` | DELIVERED |
| OB-D8-4 | `selectVerifier` returns `unavailable` / `no_independent_healthy_capability_match` only when no eligible candidate remains. Provider-unhealthy runtimes are excluded by `eligible()`. | `runtime-router.test.ts` | DELIVERED |
| OB-D8-5 | Distinct model is not mandatory. Fresh context does not load the architect or worker session. | Same D8 tests | DELIVERED |
| OB-AC18 | Unstamped runs have no `projectDocsPolicyVersion`, so the documentation gate is skipped. Legacy reviews without `independence` replay as `distinct_model`. Captured pre-capability fixture re-parses. | `replay-compatibility.test.ts` with `runner-v2/test/support/pre-capability-run.fixture.json`; `project-doc-commit.test.ts` (policy version undefined); independence replay tests | DELIVERED |

## Cross-packet findings

### Recording pause, decision turn, and document commit

A resolved recording pause can continue, and a later completion still has to pass the document gate.

- `resolveContextRecordingFailure` suspends recording only for that turn (`suspendContextRecording(runId, "context_recording_decision_turn")`) and clears it in `finally` unless a waiver was recorded. That suspension makes `recordContextPack` return `undefined`. It does not wrap `write_project_doc`.
- `bindProjectDocCommit` commits on the integration branch inside the tool call, including while the run is paused. A crash after `project_doc.requested` and before `project_doc.committed` is recovered by `recoverPendingProjectDocs` on the next step that sees `status === "running"`, which is after `retry` or `proceed_without_manifest` appends `run.resumed`.
- After resume, `dispatchStep` no longer returns early for the recording pause, so the normal completion path runs. `projectDocumentationReadiness` still requires `STATE.md` after the latest integrated task (any point in the run for `plan_only`). A STATE.md written during the decision turn does not satisfy that check if a later task integration advances `latestIntegratedTaskSequence`.
- `plan_only` does not register `complete_run` on the recording decision turn (`planOnlyCompletionAvailable` is true only for `completion_decision_required`).

The hole is the opposite case: a `finish` or `budgeted` run that is already completion-ready. `createArchitectTools` always registers `complete_run` for those policies, including `context_recording_decision_required`. `project.handoff_requested` does not look at unresolved recording notes. It sets `projectHandoff.status` to `requested`, forces `paused`, and deletes `pauseReason`. `finishContextRecordingResolution` then returns `"unresolved"` because the note has no resolution, and the pump breaks while still reporting `context_recording_failed`. The projection the UI reads prefers handoff (`lifecycleLabel` checks `projectHandoff` before the recording pause), so the user can select handoff. `project.handoff_selected` sets `completed` without a `retry`, `proceed_without_manifest`, or `abort`. This is reachable when `recordContextPack` fails at the start of a completion turn that was already ready: the decision turn can hand off immediately.

### Reader commands, allow-lists, and the fresh-context reviewer

The fallback reviewer uses the same broker as a distinct-model reviewer. Independence does not change tool registration or the workspace.

- Verifier: `createVerifierReviewBroker` adds `run_evidence_command` on a broker whose cwd is `verifierCommandWorkspacePath` (the verifier workspace, not `projectRoot`). `native-verifier-runtime.test.ts` asserts the command is present and lifecycle tools are absent. The fresh-context test uses `inspect()` with the architect's model id and asserts a new `verifier:<run>:` session that does not contain architect or worker session text.
- Plan critic: `createPlanCriticInspectionBroker` asserts the critic surface, which has no `run_evidence_command` and `mcpPolicy: "none"`.
- Architect commands stay on the disposable copy under the run permission profile. Read tools may use the project root; the allow-list has no project writes.

### New-run stamp, legacy replay, and abort

`configureProjectDocsPolicy` writes version 1 only when the log is empty, and only as sequence 1. The reducer accepts `run.initialized` after that stamp and rejects a second initialization. The pre-capability fixture has no stamp, `projectDocumentationReadiness` returns no issues, and missing `independence` replays as `distinct_model`. Abort sets the scheduler to `failed` before the supervisor hook; a failed scheduler run does not dispatch and refuses `run.resumed`. Those three do not contradict each other.

### Worker `docs/project/**` versus Architect documents at handoff

Worker paths under `docs/project/**` conflict before cherry-pick and the conflict names the paths. Architect document commits are separate integration-branch commits and are included in `applyToProject`. The handoff test keeps final verification current after `STATE.md`. A worker conflict does not block a later Architect document commit.

### Diffs outside the original file lists

Explained by recorded controller decisions or by the obligations above:

- CD-1 / PD-24: the pump runs the decision turn before reporting the pause; that turn suspends recording; user resume is `retry`.
- CD-2 / PD-25: `control-server.ts` status union adds `"failed"`; `agent-contracts.ts` and `agent-loop.ts` add `context_recording_resolved`; new `cli-lifecycle.ts`.
- CD-3 (A4 evidence): `project-docs.ts` holds constants, templates, lexical checks, and splice; git and symlink checks live in `integration-manager.ts`.
- CD-4 (R1 evidence): optional `independence` on `PlanCritiqueProjection` (`plan-critique-contracts.ts`, `plan-critique-authority.ts`). The same field on the verifier authority is AC-24.
- `user-steering-contracts.ts` adds `context_recording_decision_required`. `worker-runtime.ts` asserts the worker allow-list. UI files show independence and the recording note.

No unexplained product diff in the integrated range.

## Findings by severity

### BLOCKING

**A completion-ready run can hand off during a context-recording decision without resolving the note.**

- Where: `runner-v2/src/architect-tools.ts` `createArchitectTools` (non-`plan_only` always includes `completeRunTool`, and adds `resolve_context_recording` only as an extra tool). `runner-v2/src/scheduler-store.ts` `project.handoff_requested` (about line 2943) and `project.handoff_selected` (about line 2967). `runner-v2/src/build-runtime.ts` `resolveContextRecordingFailure` / `finishContextRecordingResolution`. `runner-v2/src/native-build-manager.ts` `pump` (breaks on `"unresolved"` and keeps the previous `{ status: "paused", action: "context_recording_failed" }`).
- Why: AC-3 says an exhausted manifest failure pauses for a typed decision and never silently continues. AC-4 and D1 constraint 4 / section 3.2 allow only `retry`, `proceed_without_manifest` (rationale required), or `abort`. `complete_run` appends `project.handoff_requested`. That reducer does not check `latestUnresolvedContextRecordingNote`. It deletes `pauseReason`. Handoff selection then sets `completed`. The unresolved note stays unresolved, so the audit gap is never waived and never aborted. The system prompt says to use one lifecycle tool for the requested decision and does not fail closed. This is the turn that runs when recording fails on an already-ready completion step.
- Fix: Reject `project.handoff_requested` and `run.completed` while an unresolved context-recording note exists. Do not register `complete_run` on `context_recording_decision_required`. After the decision turn, if the projection is no longer a recording pause, do not report `context_recording_failed`.

### IMPORTANT

None beyond the blocking hole. The resolved path (retry, waiver, or user resume) does resume, document commits during the decision turn are not dropped by the recording suspension, and completion after that resume still enforces AC-25.

### MINOR

**Symlink refusal is not at the tool or the scheduler append.**

- Where: `validateProjectDocPath` in `runner-v2/src/project-docs.ts` (lexical only; its comment says symlinks are an A5 commit check). `applyProjectDocRequested` uses that function. `IntegrationManager.refuseProjectDocLink` (`integration-manager.ts`) `lstat`s and throws before `writeFile`.
- Why: D6 item 1 and AC-7 say `..`, absolute paths, links, and anything outside the folder are refused in the tool and at the durable append boundary. A symlink path can be appended as `project_doc.requested`. The commit then refuses it, so the user project and the integration tree are not written. The refusal is fail-closed, but it is not at the append.
- Fix: Refuse a symlink path before `store.append` in `write_project_doc`, or reject it in the reducer if the commit port reports a link, so the request never becomes durable.

## Verdict

**NOT RECONCILED**

Blocking condition: a `finish` or `budgeted` run paused for context-manifest recording can request and complete project handoff from the decision turn without `retry`, `proceed_without_manifest`, or `abort`, leaving the recording note unresolved. AC-3 and AC-4 are not held on that path.

Everything else in the STEP 2 list is delivered, except the MINOR symlink-at-append gap. That minor gap is not the blocking condition.
