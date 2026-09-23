# Independent scoped re-review — agent capability plan, revision 7

Reviewer: fresh context. Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`.
HEAD `3fc85484fd8d2b65988fb4b7f089b0646565450c` (matches the assigned revision). The capability plan and STATE are unmodified in the worktree.
SOURCE read first: `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` revision 3.
This STEP 2 section was written before the plan or STATE was opened.

## STEP 2 — obligations from SOURCE only (before the plan)

### (a) Abort — D1 constraint 4, resolution table, AC-4

1. `abort` is one of exactly three Architect resolutions (`retry`, `proceed_without_manifest` with rationale, `abort`). It is durable, attributed, and restart-safe (AC-4).
2. Meaning: unrecoverable. Effect: the run fails through the existing `RunSupervisor.fail` path (`run-supervisor.ts:117`) with the reason recorded.
3. `abort` is terminal in **both** stores, and the runner reaches the supervisor. The live `RunSupervisor` exists only in `cli.ts`.
4. Two steps, in this order:
   - **First, durable:** the abort resolution sets the **scheduler** run to `failed`. The scheduler already declares `failed` but never sets it. A failed scheduler run never dispatches and refuses `run.resumed`.
   - **Second:** the runner carries that to the supervisor through a lifecycle hook that `cli.ts` installs, the same way it already installs the pump result hook. The hook runs at the moment of abort, on a pump step that reports `failed`, and at startup recovery for a run whose scheduler state is `failed` but whose supervisor state is not.
5. A crash between the two steps cannot redispatch, because the scheduler step is first and durable.
6. The supervisor is reached by calling the existing `fail` path. The source does not require editing `run-supervisor.ts` itself; it requires the hook `cli.ts` installs to invoke that path.

### (b) Document applier — D6 reachable wiring, AC-17, ESC-2

1. An Architect plan/spec write is a kernel-applied task of kind `architect_document`. The runner, not a model, creates the task workspace, writes the file, commits it with an Architect trailer through `WorkspaceManager.commitTask`, builds the ChangeSet through `createChangeSet` using the file's content hash as its evidence, and integrates it through `IntegrationManager.integrate`. Applying it costs no model tokens (AC-17).
2. The existing integration driver that `BuildRuntime` calls loads a **worker** session and rejects a change set it does not find there (`native-build-factory.ts:1075-1093`). A document task has no worker session. Giving it one would put it on the accepted-change list that ESC-2 keeps it off. The document path therefore does **not** use that driver. The worker-session driver stays unchanged.
3. The factory already owns `WorkspaceManager` and `IntegrationManager`. It supplies `BuildRuntime` with a **separate document applier** that commits, builds the change set, and passes the **change-set object** to `IntegrationManager.integrate` directly.
4. `createChangeSet` (`change-set.ts:63-100`) needs a task id, a task commit, and at least one evidence hash. The kernel-applied task supplies those. Evidence is the file content hash, not review criteria.
5. `acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) keeps only worker sessions with a submitted ChangeSet. A kernel-applied task has no worker session, so it does not appear there. That filter is not changed. Git attribution is the Architect trailer.
6. The write is refused outside the investigated plan/spec allow-list (AC-7). The Architect does not receive filesystem mutation tools.

### (c) Reviewer independence — D8, AC-24

Same rule for independent verifier and plan critic in this program (and, in P6.6, the deliverable reviewer and the coverage reviewer — those two are named as the same rule later, not as work this program must implement):

1. Prefer a distinct model: if an eligible candidate exists whose model identity differs from the Architect's and from every change author's, choose it.
2. Otherwise fall back to a fresh context: choose an eligible candidate even if it shares a model identity, and run it in a **new session whose event list is empty** at start — no messages, tool results, or context from any other session. Exclusions that are not about model identity (for example a runtime excluded after a provider error) still apply.
3. Record which one happened. The review request records `independence: "distinct_model"` or `"fresh_context"`, durably, and the UI shows it. Legacy events without the field replay as `distinct_model`.
4. Pause only when no eligible candidate exists at all (no healthy runtime with the required capability).
5. Explicitly rejected: requiring a distinct model always; silently reusing an existing session.
6. AC-24 binds verifier and plan-critic selection. A gate that still forces a distinct model for either role is uncovered.

---

## B-1 verdict: REPAIRED

The fifth review's hole was that `RunSupervisor.fail` (`run-supervisor.ts:117`) lives only on the instance `cli.ts` constructs, and no packet could write `cli.ts`. Revision 7 puts `cli.ts` on B2 and installs a hook there. The forbidden files do not need edits.

### Trace

`RunSupervisor.fail` already appends `run.failed`. `reducer.ts:15-26` already allows `running → failed` and `paused → failed`. B2's forbidden list (`run-supervisor.ts`, `reducer.ts`, `control-server.ts`) matches files that stay unchanged.

Scheduler terminal state is writable. `SchedulerProjection.status` already includes `"failed"` (`scheduler-store.ts:474`) and nothing in the reducer sets it (`run.paused` / `run.resumed` are the only run-status writes, at `:2688` and `:2701`). B2 owns `scheduler-store.ts`, so the abort event can set `status: "failed"` and refuse `run.resumed` plus task transitions. `task-scheduler.ts:119` already returns from `tick` unless `projection.status === "running"`, so a failed projection does not dispatch even before the new reducer guard. `stepOnce` (`build-runtime.ts:584-585`) already returns on `completed` and `paused` before `scheduler.tick()` at `:837`. Adding `"failed"` beside those two returns is in a file B2 owns.

Supervisor terminal state is reachable from files B2 owns:

- `NativeBuildManagerOptions` (`native-build-manager.ts:71-95`) is where `onPumpResult` already sits. `onBuildFailed` is the same kind of option. B2 owns this file.
- `cli.ts:190-196` already installs `onPumpResult` as `syncAutonomousBuildLifecycle`. B2 now owns `cli.ts`, so it can install `onBuildFailed` as a guarded `supervisor.fail` that returns when `isTerminalRunState` (`cli.ts:325-327`) is already true. `syncAutonomousBuildLifecycle` (`cli.ts:300-322`) can grow the same call for a pump result whose status is `failed`.
- Recovery (`native-build-manager.ts:132-222`) constructs the runtime, quiesces, then reads `projection().status` before `shouldAutoRun` and before `activate` (`:250-259`). The plan's recovery call sits in that window, in a file B2 owns.

Live abort does not depend on the pump. Recording failure pauses the scheduler, the pump returns `paused`, and `syncAutonomousBuildLifecycle` pauses the supervisor. `shouldAutoRun` (`cli.ts:189`) is `supervisor.state === "running"`, so a paused run is not pumped. The plan's moment-of-abort call is the manager hook immediately after the durable append, not a later pump result. The pump-result branch covers a step that itself returns `failed` while a pump is still inside `runUntilBlocked`. Both are in B2 files.

Crash after the durable abort and before the hook: the scheduler projection is already `failed`, so `tick` does not dispatch and the new `stepOnce` check returns before `tick`. On restart, `shouldRecoverSpec` (`cli.ts:179-180`) still recovers the spec because the supervisor is not terminal yet. Recovery calls `onBuildFailed` before `activate`. `shouldAutoRun` is false while the supervisor remains `paused`, so the run is not started. The plan's restart test (append, do not call the hook, restart, zero dispatches, supervisor becomes `failed`) matches this order. Removing the recovery call leaves the supervisor `paused`, which is why that call is mandatory and why the design does not use the pump to close a paused run.

User resume after a completed abort is refused without editing `control-server.ts`. `applyCommandInside` (`control-server.ts:873-874`) calls `supervisor.resume` before `builds.resume`. From `failed`, `run.resumed` is not a legal supervisor transition (`reducer.ts` has no `failed` row). `supervisor.resume` throws. The scheduler refusal of `run.resumed` is a second gate if a build resume is reached. `shouldRecoverSpec` then returns false because `failed` is terminal (`cli.ts:325-327`).

No regression was seen in the pause, retry, or waiver paths from this edit. Those still use the existing `paused` outcome and B1's suspension switch; abort is the only resolution that sets `failed`.

## A5 verdict: NOT FIXED

The fifth review's worker-session hole is closed. `IntegrationManager.integrate` (`integration-manager.ts:474`) takes a `ChangeSet` and does not load a session. `createChangeSet` (`change-set.ts:63-100`) treats acceptance criteria as optional and, without them, requires a non-empty `evidenceArtifactHashes` list. `artifacts.put` (`artifact-store.ts:75-79`) returns an `ArtifactRecord` whose `hash` satisfies `assertArtifactHash`. `acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) still keeps only worker sessions that carry a change set; a kernel task with no session stays off that list, and the plan forbids editing the filter. `native-build-factory.ts` is on A5's writable list and is ordered `A3 → A5` in §5.2. The factory already closes over `WorkspaceManager` and `IntegrationManager` beside the worker driver (`:1075-1100`, runtime construction `:1151`). `assertCompatible` (`integration-manager.ts:1537-1566`) accepts a change set whose baseline is the current integration revision, including equality (`merge-base --is-ancestor` is true for a commit against itself).

The named calls still do not commit that workspace, so they never reach `integrate`.

`createTaskWorkspace` (`workspace-manager.ts:85-126`) honors `workspaceId` and `baselineRevision`. The plan passes `workspaceId: "<taskId>:document"` and `baselineRevision: integrationManager.revision`. That descriptor's path and branch are `safeName("<taskId>:document")` (`describe`, `:346-360`).

`commitTask(taskId, summary)` (`:129-133`) does not take that descriptor. It calls `ensureWorkspace(taskId)` (`:337-343`), which rebuilds the descriptor as `describe(taskId, taskId, this.baselineRevision)`: workspace id equals the task id, and the baseline is the run baseline stored on the manager, not the integration revision. The document worktree was never created at that path, so `ensureWorkspace` throws `Task workspace ${taskId} has not been created.` The new `{ author: "architect" }` option does not change the lookup. `commitWorkspace(workspace, summary)` (`:136-146`) would commit the object `createTaskWorkspace` returned; the plan does not call it.

`writeDocument(taskId, path, content)` is specified with the same task-id lookup shape. Implemented on `ensureWorkspace(taskId)`, it writes the other worktree, or throws before the write.

A worker who follows the contract therefore never builds a `TaskCommit`, never calls `createChangeSet`, and never calls `integrate`. AC-17 is still not executable from the named sequence. This is a new defect; the worker-session driver is no longer the blocker. No new mechanism is proposed here.

The rest of the A5 contract is implementable from A5's files and is not what fails:

- `planned → integrated` is rejected today (`task-graph.ts:11-12` and `applyTaskTransition` at `:222`). A5 owns `task-graph.ts` and says the exception is this kind only, through a runner-actor event. `assertTransitionAuthority` (`scheduler-store.ts:5561-5566`) already requires the runner for `integrated`.
- `acceptanceContractStatusForTasks` (`scheduler-store.ts:5434-5441`) and `validateTaskGraph` (`task-graph.ts:118-130`) both reject a criteria-less sibling. Both files are A5's, and the plan tells them to skip the kind.
- `buildCompletionReadiness` (`scheduler-store.ts:857-863`) already waits until every ordinary task is `integrated` or `cancelled`.
- `tick` (`task-scheduler.ts:129`) already skips `isFinalVerificationTask`. Skipping `architect_document` the same way is in a file A5 owns. `stepOnce` applying the kind before `:837` is in `build-runtime.ts`, which A5 writes after B2, A1b, and A4.
- Restart lookup is implementable from the factory without editing `integration-manager.ts`. The API is the factory's existing `GitRunner` against the public `integrationManager.path`, reading commit bodies (`git log` format `%B`) for `AIBoard-Task: <taskId>` and `AIBoard-Author: architect`. `IntegrationManager.history` is the wrong API: `historyAtRevision` (`integration-manager.ts:277-295`) returns only `subject`, capped at 100, and the trailers are written in the commit body (`workspace-manager.ts:323-331`), which `cherry-pick -x` (`integration-manager.ts:533-538`) preserves. `history()` cannot see them.
- Filesystem routing does not redden. `workspace-manager.ts` is already in `privateOwners` (`filesystem-mutation-routing.test.ts:13-25`) and already imports `node:fs/promises`. Adding `writeFile` on that importer stays inside a reviewed owner. The stop rule (report and stop; the test file is the controller's) is the right rule if some other new importer appears.

## R1 verdict: NOT FIXED

Selection fallback and the fresh session are real. The durable record of a same-model verifier is not, and the rejecting function is in a file R1 cannot write.

### Trace

`RuntimeRouter.selectVerifier` (`runtime-router.ts:174-208`) returns `unavailable` / `no_independent_healthy_capability_match` when every eligible candidate shares the Architect's or a change author's model identity. R1 owns `runtime-router.ts` and can keep that first choice, then fall back to the first eligible allowed runtime that is only excluded by model identity. Provider-error exclusion stays: the verifier runtime already puts a provider-suspended runtime into `excludedRuntimeIds` (`native-verifier-runtime.ts:224-242`) before calling `selectVerifier`. `unavailable` remains when no eligible candidate exists. `build-runtime.ts:1261-1276` and `:1723-1728` pause on that `unavailable` result. R1 correctly leaves those lines alone (`build-runtime.ts` and `build-spec.ts` are forbidden). `alwaysRequireIndependentVerifier` does not force a distinct model. It is a risk flag: `build-runtime.ts:1147-1148` passes it as `stricterQualification`, and `assessBuildRisk` (`risk-policy.ts:183-185`) only adds a `stricter_qualification` reason. No other gate in the selection path excludes a model identity.

Fresh context is already how a new review starts, and the sentinel test proves it. Verifier session ids are `verifierSessionId(runId, targetRevision, runtimeId, digest, mode)` (`native-verifier-runtime.ts:293-299`). Plan-critic ids are `planCriticSessionId(runId, planRevision, runtimeId, digest)` (`native-plan-critic-runtime.ts:175-179`). Neither id is an Architect or worker session. When `sessions.events(sessionId)` is empty, the runtime calls `sessions.create` (`native-verifier-runtime.ts:410-416` and `:681-687`; `native-plan-critic-runtime.ts:238-244`) and the first request is the role system message plus that role's context pack (`:392-407`, `:665-678`, `:225-234`). Checkpoint messages are loaded only when that same session id already has events. A sentinel written into the Architect session and a worker session is absent from that request. R1 owns both runtimes, so the test can drive them. Reusing the Architect session would put the sentinel in the provider request. That is a real proof, not a string compare on a label.

Recording is where AC-24 breaks.

`verifierExcludedModels` (`native-verifier-runtime.ts:1001-1026`) always puts the Architect's model identity in `excludedModels`. The plan critic does the same (`native-plan-critic-runtime.ts:195-199`). The review request is then appended, and the reducer rejects a runtime whose model identity is in that list:

- Verifier: `parseVerifierReviewRequest` (`verifier-contracts.ts:110-116`) throws `Verifier model is not independent from the Architect or an accepted change author.` `recordVerifierReviewRequest` (`scheduler-store.ts:3567`) calls that parser before the event is projected. `verifier-contracts.ts` is not on R1's writable list, not on §5.2, and §3.0 forbids everything else.
- Plan critic: `applyPlanCritiqueRequested` (`scheduler-store.ts:4622-4624`) throws `Plan critic model is not independent from the Architect.` That function is in `scheduler-store.ts`, which R1 may edit. The contract never says to lift it.

There is a second verifier check in an owned file: `scheduler-store.ts:3582-3591` requires the excluded Architect runtime id to be the assigned Architect. R1 can relax that one. It cannot relax `parseVerifierReviewRequest` without editing `verifier-contracts.ts` or replacing the parser. The plan does neither. A single-model verifier fallback therefore cannot append `verifier.review_requested`. The run still pauses, which is the behavior D8 rejects. `build-runtime.ts` staying forbidden is correct for the zero-candidate pause; it does not make this gate go away.

`independence` on the two request events, legacy replay as `distinct_model`, and the panel label are all in files R1 owns (`verifier-verdict-authority.ts:73`, `plan-critique-authority.ts:54`, `scheduler-store.ts`, the panel). They do not help if the append throws first.

P6.6's deliverable and coverage reviewers are named in D8 and PD-22 as the same rule later. They are not in this program. That split is consistent with the source.

## Graph and lanes

Edge list, STATE rows, and packet `Depends on` fields match.

```
A0 → A1 → A2 → A3 → A4 → A5 → R1 → D1g     (8 nodes)
A0 → B1 → B2 → A1b → A4 → A5 → R1 → D1g    (8 nodes)
```

Longest path is 8 nodes, two of them, as the plan says. Acyclic. `A3 → R1` is also implied by `A3 → A4 → A5 → R1`; listing it is justified because R1 writes A3's verifier and plan-critic runtimes. Every packet has a path to D1g. D1g's only predecessor is R1.

§5.2 orders every file that more than one of these packets writes:

| Surface | Order in §5.2 | Packets that write it |
|---|---|---|
| `build-runtime.ts` | B2 → A1b → A4 → A5 | B2, A1b, A4, A5. R1 is forbidden. |
| `scheduler-store.ts` | B2 → A4 → A5 → R1 | B2, A4, A5, R1 |
| `architect-tools.ts` | B2 → A4 | B2, A4 |
| `task-scheduler.ts` | B2 → A5 | B2, A5 |
| `native-build-factory.ts` | A3 → A5 | A3, A5 |
| `native-verifier-runtime.ts`, `native-plan-critic-runtime.ts` | A1 → A3 → R1 | A1, A3, R1 |
| `lib/client/runner-v2.ts`, the panel | B2 → R1 | B2, R1 |
| `cli.ts`, `native-build-manager.ts` | B2 only | B2 |
| `workspace-manager.ts`, `task-graph.ts`, `task-contracts.ts`, `acceptance-contracts.ts` | A5 only | A5 |
| `runtime-router.ts`, `verifier-verdict-authority.ts`, `plan-critique-authority.ts` | R1 only | R1 |

`user-steering-contracts.ts` is B2 only, so it does not need a multi-writer row. Lane B's launch order (A0, B1, B2, A1b, A4, A5, R1) matches the edges, and the card says A4 waits for I2 and A3, A5 does not touch the worker driver or `acceptedChangeSessions`, and R1 waits for A3 and A5. No file two packets write is missing from §5.2.

No regression was found in pause, retry, waiver, D2, D3, or moved scope from the revision-7 edits.

## Findings

### BLOCKING

**A5-1. The document applier's commit does not address the workspace it creates.**

- Location: plan A5 named mechanism step 2; `workspace-manager.ts:85-126` (`createTaskWorkspace`), `:129-133` and `:337-343` (`commitTask` / `ensureWorkspace`).
- Why: the plan creates workspace id `<taskId>:document` at the integration revision, then commits with `commitTask(taskId, summary, { author })`. `commitTask` looks up workspace id `taskId` at the run baseline and throws because that worktree does not exist. `integrate` is never called. The worker-session defect is gone; this sequence still does not reach `integrated`.
- Fix: do not add another integration design. Point the commit and the write at the `TaskWorkspace` object `createTaskWorkspace` already returns (`commitWorkspace` at `workspace-manager.ts:136` takes that object). The author trailer stays a `commitTask` / `commitWorkspace` option in `workspace-manager.ts`, which A5 owns.

**R1-1. A same-model verifier cannot be recorded, and the rejection is outside R1's files.**

- Location: `verifier-contracts.ts:110-116` (`parseVerifierReviewRequest`), called from `scheduler-store.ts:3567`. Companion check the packet can edit but does not mention: `scheduler-store.ts:4622-4624` (plan critic) and `:3582-3591` (excluded Architect runtime id must match). `verifierExcludedModels` at `native-verifier-runtime.ts:1001-1026`.
- Why: D8 and AC-24 require falling back to that same model in a new empty session and recording `fresh_context`. The verifier reducer throws if the selected model identity is in `excludedModels`, and that list always includes the Architect. `verifier-contracts.ts` is not writable by R1. The append never lands, so the run still pauses for a single-model user. The fresh-session behavior and the sentinel test are sound; they never get that far for the verifier.
- Fix: put `verifier-contracts.ts` on R1 and on §5.2 (R1 only, unless another packet already writes it — none does). State that both identity rejections accept the selected runtime when `independence` is `fresh_context`, and that `excludedModels` still records the Architect and the change authors. Leave the distinct-model preference in `selectVerifier`, and leave the zero-candidate pause in `build-runtime.ts` untouched.

### IMPORTANT

None.

### MINOR

None.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

B-1 `abort` is repaired: scheduler `failed` first, no dispatch, supervisor `fail` through a hook `cli.ts` installs, including recovery before activation for a paused run, without editing `run-supervisor.ts`, `reducer.ts`, or `control-server.ts`.

Blocking conditions, last cycle for A5 and first review for R1:

1. A5's named `commitTask(taskId)` does not commit the `<taskId>:document` workspace, so the document never reaches `IntegrationManager.integrate`.
2. R1's same-model verifier fallback is rejected by `parseVerifierReviewRequest` in `verifier-contracts.ts`, which R1 cannot write.
