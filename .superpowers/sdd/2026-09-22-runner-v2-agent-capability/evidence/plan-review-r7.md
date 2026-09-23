# Independent scoped re-review — agent capability plan, revision 8

Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `docs/agent-capability-and-change-critique`. Source is revision 4 of `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`. Scope is only (a) R1-1, (b) new D6 packets A4/A5 plus AC-7/AC-17/AC-25, (c) I2 removal and the graph, lanes, section 5.2, STATE rows, and launch cards. Prior review `plan-review-r6.md` stays reused, including B-1 abort REPAIRED.

## STEP 2 — Obligations (written before opening the plan)

### (a) R1 repair of r6 finding R1-1

Source: D8 and AC-24. The prompt names the repair: `verifier-contracts.ts` is added to the packet, and identity rejections are lifted only for `fresh_context`.

1. `verifier-contracts.ts` is on R1's writable file list, so the identity-rejection change is reachable from the files that packet may edit.
2. Same-model identity rejections (Architect identity, and every accepted change author's identity) are waived only when the recorded independence is `fresh_context`.
3. `distinct_model` keeps those identity rejections. A legacy event with no `independence` field replays as `distinct_model` and keeps them too.
4. Exclusions that are not about model identity (a runtime excluded after a provider error, and any other non-identity exclusion) still apply under `fresh_context`.
5. The fresh-context path still starts a new session whose event list is empty (no messages, tool results, or context from any other session). Recording `distinct_model` | `fresh_context`, UI display, and pause-only-when-no-eligible-candidate remain as AC-24 states them; this review does not re-open those unless the R1-1 repair breaks them.

### (b) New D6 — A4 (`write_project_doc`) and A5 (`commitProjectDocuments`, worker refusal, AC-25)

Source: D6 revision 4, D2 Architect "write plans/specs" cell, honest limit 3, AC-7, AC-17, AC-25, OQ-2 closed. `architect_document` is explicitly rejected and must not remain as the mechanism.

**A4 — the tool and the boundary (AC-7, D6.1–D6.3, OQ-2)**

1. One lifecycle tool, `write_project_doc(path, content, summary)`. Allow-list is exactly `docs/project/**` plus the marked `AGENTS.md` section and a one-line marked pointer in `CLAUDE.md`. Nothing else.
2. Refusal of `..`, absolute paths, links, and any path outside that allow-list happens in the tool and again at the durable append boundary.
3. `AGENTS.md` is created if absent. The runner splices only between its markers. Text outside the markers is never changed. `CLAUDE.md` gets only the one-line marked pointer to `AGENTS.md`. The section states what the folder holds, how to read it first, and how to update it.
4. Default layout the Architect fills and keeps current: `docs/project/README.md`, `STATE.md`, `specs/`, `plans/`, `decisions.md`, `evidence/`.
5. The database remains the gate truth. A document that says tests passed approves nothing.

**A5 — commit, worker refusal, completion (AC-17, AC-25, D6.4–D6.7, honest limit 3)**

6. The write is committed on the runner's integration branch with an Architect author and trailer. It is not written into the user's working folder during the run. No task, change set, or worker session is created. Applying a write costs no model call.
7. The commit must land on the integration worktree and advance the integration revision, so a later worker integration still passes `assertCompatible`. A commit that does not advance the revision the compatibility check reads would make the next integration fail closed or race.
8. Documents reach the user's project at handoff, together with the code. A run that is never handed off delivers neither. At the next build the Architect reads them from the project.
9. Restart safety: the commit trailer (request id) and `git log --format=%B` must make a replayed write idempotent rather than a second commit or a lost write.
10. A worker change set that touches `docs/project/**` is refused at integration through the existing conflict result, and the refusal names the paths. Callers of that conflict result must treat it as a real refusal, not as success or as a retry that lands the write.
11. AC-25: a new run cannot complete until `docs/project/STATE.md` was written after that run's latest integrated change. Runs created before this change are exempt. The plan must say how a run is classified new versus legacy. If that classification lives in a policy version on the run record (`build-spec.ts`), `build-spec.ts` is on A5's file list or A5 has another reachable way to tell the two apart. Legacy exemption must not be "skip the check whenever the field is missing" in a way that also exempts new runs that forget to record the version.
12. The completion check is on the path that actually completes the run (`buildCompletionReadiness` or the equivalent the code uses). If project handoff is reachable without completion, AC-25 does not put `STATE.md` on the branch that handoff delivers, and the plan must close that hole.
13. Wiring: the commit/refusal/completion port must be reachable from files A5 may edit (`native-build-factory.ts` port, `build-runtime.ts` `stepOnce` applying the write before `tick`, `scheduler-store.ts` readiness). A mechanism named in prose but not in the packet's files is the defect revision 4 replaced.
14. If a new write in `integration-manager.ts`, or a new file such as `project-docs.ts`, must be registered in `filesystem-mutation-routing.test.ts`, that registration is in the plan. If that test file is controller-owned, the plan assigns it to the controller rather than pretending a packet may edit it.

### (c) Removal of I2, and the changed graph, lanes, section 5.2, STATE rows, launch cards

1. I2 is removed. No graph edge, lane, section 5.2 step, STATE row, or launch card still schedules, depends on, or describes I2.
2. `architect_document` does not remain as a task kind, packet, graph node, or launch target.
3. Section 5.2 describes the revision-4 mechanism: `write_project_doc`, commit on the integration branch, worker refusal, AC-25, marker splice. It does not describe the rejected task kind or an open OQ-2 investigation.
4. STATE rows and launch cards match the packets that exist after the replacement (A4, A5, and the R1 file-list repair), including ownership of any controller-owned file the new writes require.

## R1-1 verdict: REPAIRED

r6 said `parseVerifierReviewRequest` (`verifier-contracts.ts:110-116`, called from `scheduler-store.ts:3567`) throws when the selected model is in `excludedModels`, and R1 could not write that file. The companion identity rejection is `applyPlanCritiqueRequested` (`scheduler-store.ts:4622-4624`). The Architect-runtime-id check at `scheduler-store.ts:3582-3591` is a different predicate (the excluded Architect runtime id must be the assigned one).

Revision 8 puts `verifier-contracts.ts` on R1's writable list and on §5.2 as R1 only. Packet step 3a says both identity rejections accept the selected runtime only when `independence` is `fresh_context`, and keep today's throw for `distinct_model` or a missing field. `excludedModels` still records the Architect and every change author. The runtime-id check stays. `build-runtime.ts` pauses at the existing zero-candidate sites stay forbidden. The acceptance test covers a provider-error-excluded runtime returning `unavailable`, and a same-model `fresh_context` append for both roles. Those are the files and the predicates r6 named. No third identity rejection exists (`not independent` / `excludedIdentities` appear only at those two sites).

## A4 / A5 verdict: NOT FIXED

What is implementable, checked against the repository:

- **Commit on the integration worktree.** `IntegrationManager.path` is the run's integration worktree. `integrate` (`integration-manager.ts:474`) and the clean-tree handoff check (`:601-610`) both run inside `serialized` (`:1676`). A sibling `commitProjectDocuments` on that mutex can `git add` and `git commit` there. The integration lifecycle allows `add`, `commit`, and `log` (`git-run-context.ts:53-54`). Author overrides `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` are permitted (`git-execution-policy.ts:11-13`), so author `AIBoard Architect` does not have to keep `RUNNER_IDENTITY` (`integration-manager.ts:27-32`). `findIntegratedRevision` already reads bodies with `git log --format=%H%x00%B%x00` (`:1609-1614`), so an `AIBoard-Doc-Request` trailer is a real idempotency key. Writes use `writeFile` in a file that already imports it; they do not touch the user's `repositoryRoot`, which is what `applyToProject` requires to be clean.
- **Later worker integrations still pass `assertCompatible`.** The check is ancestry, not equality: `changeSet.baselineRevision` must be an ancestor of `this.revision` (`:1552-1566`). A document commit that updates `this.currentRevision` from `head()`, as `integrate` does at `:566`, leaves an older worker baseline legal. Cherry-pick (`:533`) of non-overlapping paths still applies. The "document commit between two worker integrations" acceptance test matches this code.
- **Worker refusal through the existing conflict result.** `changedPaths` is `git diff --name-only -z` from the task baseline to the task revision (`workspace-manager.ts:408-422`), copied onto the change set (`change-set.ts:137`). `integrate` can return `{ status: "conflict", conflictPaths }` before cherry-pick. The forbidden worker `integrationDriver` (`native-build-factory.ts:1075-1100`) already forwards `conflictPaths`. `stepOnce` (`build-runtime.ts:706-731`) records `integration_resolution` and names those paths; the next step asks the Architect (`:734-740`). A5 does not need to edit the driver.
- **Port.** The factory already owns `integrationManager` (`native-build-factory.ts:617-627`) and passes options into `new BuildRuntime` (`:1151`). `BuildRuntimeOptions` is in `build-runtime.ts`, which A5 writes. `projectDocs.commit` can close over `commitProjectDocuments` without touching `integrationDriver`.
- **Filesystem registration.** `integration-manager.ts` is already in `privateOwners` (`filesystem-mutation-routing.test.ts:13-17`). A new write in that file adds no importer. `project-docs.ts` as layout constants, marker splice, and templates imports no `node:fs`. §3.0 already says a packet that does add a `node:fs` importer reports it and stops; §5.2 leaves that test controller-owned. Handled.
- **Handoff is not a side door around completion for a finish or budgeted run.** `project.handoff_requested` calls `assertBuildCompletionReady` unless `runPolicy === "plan_only"` (`scheduler-store.ts:2733-2738`). `project.handoff_selected` always calls it (`:2764`). `run.completed` calls it (`:2719`). `native-build-manager.ts:555` calls it again before `handle.projectHandoff`. Putting AC-25 inside `buildCompletionReadiness` (`:848`) does gate those paths, for a projection that actually carries the new-run bit.

What does not work:

### BLOCKING

**A5-1. Pending document writes are applied only on the fall-through to `scheduler.tick()`, and the completion path returns before that.**

- Location: plan A5 step 4 (`stepOnce` applies `project_doc.requested` before `build-runtime.ts:837`). Code: `build-runtime.ts:827-837` and `:862-875`.
- Why: Once every task is `integrated` or `cancelled`, `stepOnce` calls the Architect with `completion_decision_required` and returns (`:827-833`). It never reaches `tick` at `:837`. The same return happens inside final verification after an approved review (`:865-875`). A4's tool only appends `project_doc.requested`. The commit happens on a later step that reaches `tick`. That later step does not exist: the next `stepOnce` hits the same completion branch, or, if handoff was requested, returns `paused` at `:584-585`. `complete_run` and `project.handoff_requested` both call `assertBuildCompletionReady` in the Architect's turn, before any later step. A `STATE.md` write in that turn is still uncommitted, so AC-25 rejects the completion, and nothing afterwards commits it. The prompt tells the Architect to write `STATE.md` before completing, which is this turn.
- Fix: Apply pending `project_doc.requested` events at the start of `stepOnce`, after the `completed` / `paused` returns and before any Architect call, and commit them in the tool handler before it returns so a later `complete_run` or handoff request in that same turn sees `project_doc.committed`. Do not cite `:837` as the apply site.

**A5-2. A document commit moves integration HEAD off the revision completion and handoff treat as canonical. Reconciling those two revisions invalidates final verification.**

- Location: plan A5 step 1 ("the integration revision advances exactly as it does after `integrate`"). Code: `assertCompatible` ancestry at `integration-manager.ts:1552-1566` (worker path, fine); `advanceIntegrationRevision` at `scheduler-store.ts:2971-3035`; handoff match at `scheduler-store.ts:2777-2783`; `applyToProject` returns `this.revision` via `descriptor` (`integration-manager.ts:188-208`); `selectProjectHandoff` stores that value (`build-runtime.ts:528-546`); readiness requires `current.targetRevision === integrationRevision` (`scheduler-store.ts:876-878`).
- Why: `integrate` advances the scheduler projection only when a task becomes `integrated` (`scheduler-store.ts:2186-2189`). A document commit advances `IntegrationManager.currentRevision` and the branch HEAD, and `applyToProject` reports that HEAD. `project.handoff_selected` throws unless that value equals `projection.integrationRevision`. After AC-25's `STATE.md` commit, those two hashes differ, so the handoff the acceptance test requires is rejected. Calling `advanceIntegrationRevision` to make them match is the function that drops the current final-verification generation, build-risk assessment, and verifier review to `invalidated`. Readiness then fails closed until verification is repeated, and the plan never says to do that or to exempt a docs-only descendant from the equality check.
- Fix: State one accounting rule. Either handoff and readiness accept a HEAD that is the verified revision plus architect-doc commits only (record both hashes; do not call `advanceIntegrationRevision`), or a docs commit is a real revision advance that invalidates final verification and the packet owns the re-verification. The acceptance test must cover handoff after the `STATE.md` commit, not only a docs commit sandwiched between two worker integrations.

**A5-3. AC-25's new-versus-legacy bit is a spec policy field A5 cannot store, and `buildCompletionReadiness` cannot see the spec.**

- Location: plan A5 step 7 ("a spec policy version field; runs without it are legacy and exempt"). A5's writable list has no `build-spec.ts`. R1 forbids `build-spec.ts`. Code: `NativeBuildSpec` is `version: 2` with optional fields copied only if `build-spec.ts` names them (`build-spec.ts:23-49`, `cloneBuildSpec` at `:220-243`). New specs are object literals in `control-server.ts:387-413`, which A5 does not own. `buildCompletionReadiness` takes only a `SchedulerProjection` (`scheduler-store.ts:848-850`). The projection is rebuilt from events (`:1047-1052`). `verifierTwoPass` is the existing optional (`build-spec.ts:42-43`); the factory treats a missing value as the new behavior (`native-build-factory.ts:1004`, `?? true`), which is the opposite of "missing means legacy exempt." Current runs are already version 2, so the existing `version` field does not mark this change.
- Why: A run created by current code has no new field. A5 cannot add the field to the type, the validator, the clone, or the create-run literal. If "missing means exempt," every run is exempt and AC-25 never binds. If the new runtime instead hardcodes the check on for every process it starts, a legacy run resumed after the upgrade is not exempt, which breaks AC-18. The readiness function never receives the spec even if the field existed only there.
- Fix: Put the durable stamp where A5 can write it and readiness can read it. On first configuration of a run whose event log does not already contain the stamp, append a runner event (from `build-runtime.ts`, which already appends `run.policy_configured` at `:1570`) carrying the policy version; the reducer records it on the projection; absence on a replayed log is the legacy exemption. Do not rewrite an already-stored policy event. Name `build-spec.ts` and `control-server.ts` only if the stamp stays on the spec, and then add both to the packet.

### IMPORTANT

**A5-4. Plan-only completion and handoff request skip the readiness body AC-25 would be added to.**

- Location: `buildCompletionReadiness` returns at `scheduler-store.ts:852-855` for `plan_only`. `project.handoff_requested` does not call `assertBuildCompletionReady` for that policy (`:2733-2736`). `project.handoff_selected` does call it (`:2764`), and the early return makes that call succeed with no `STATE.md`.
- Why: AC-25 says a new run. A plan-only run completes through handoff selection (`:2800` sets `completed`) with no integrated task and, under the plan's check as written ("sequence after the latest integrated task event"), no defined obligation. D6's folder is the plan those runs exist to produce.
- Fix: Say explicitly whether plan-only is exempt. If it is not, require a `project_doc.committed` for `docs/project/STATE.md` on that early-return path, and call the same check from the plan-only handoff request.

**A5-5. Symlink refusal is assigned to the pure reducer.**

- Location: A4 validation "in the reducer for `project_doc.requested`," including "not a link escaping the folder." The reducer is pure (`scheduler-store.ts` comment above `validateSchedulerEvidenceEvent`, `:1056-1059`). A5 re-checks the path rule only when writing inside the integration worktree.
- Why: `..`, absolute paths, and foreign directories are lexical and can be refused in the tool and the reducer. A symlink is not. AC-7 and the ledger require the link case to fail on a direct append. A pure append cannot see it. The integration worktree, which is the tree that can contain `docs/project` as a link, is not available to `architect-tools.ts` or the reducer.
- Fix: Keep lexical refusal in the tool and the reducer. Refuse links in `commitProjectDocuments` with `lstat` on the integration worktree, and point the AC-7 link test at that rejection.

**A5-6. The marked `AGENTS.md` / `CLAUDE.md` entry point is never required.**

- Location: A4 instructions (read `README.md` and `STATE.md` if present, keep the folder current, write `STATE.md` before complete). A5 step 6 exports a default `AGENTS.md` section from `project-docs.ts` and says the runner never writes documentation itself.
- Why: D6.2 is a marked section that says what the folder holds, how to read it first, and how to update it, plus a one-line marked pointer in `CLAUDE.md`. D6.3 is the default layout. Only `STATE.md` is gated. Nothing tells the Architect to write the template, the marked section, or the `CLAUDE.md` pointer, so a run can complete with none of them.
- Fix: Put the template body and the one-line `CLAUDE.md` pointer in the A4 prompt, and require those writes at the start of a new run. Keep the runner from inventing later content.

**A5-7. STATE's next action is still the revision 7 review.**

- Location: `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/STATE.md` section 2 (`:40-45`), against the header (`:12`) and BL-8 (`:104`).
- Why: Section 2 tells the controller to re-review revision 7 against source revision 3, scoped to B2 abort and the old A5, and to escalate under ESC-3 if still unsound. ESC-4 already replaced that A5. The resume procedure follows section 2. Packet rows in section 4 match the new graph; this block does not.
- Fix: Replace section 2 with one action: this revision 8 re-review. After a sufficient verdict, the next action is A0, not another ESC-3 cycle.

### MINOR

**A5-8. Lane B's note still says "the new task kind."**

- Location: plan §5.1 Lane B notes. The launch card and A5 say there is no task kind. `architect_document` remains only as superseded PD-16 and PD-21 in STATE, which is the right record.
- Fix: Delete "the new task kind" from the lane note.

## Graph, lanes, §5.2, STATE rows, launch cards

I2 is gone from the ledger, phase list, packet body, edge list, §5.2, launch cards, and the STATE packet table. No edge names `architect_document`.

Edges match the packet `Depends on` fields and STATE section 4. Acyclic. Longest path is 8 nodes, twice: `A0 → A1 → A2 → A3 → A4 → A5 → R1 → D1g` and `A0 → B1 → B2 → A1b → A4 → A5 → R1 → D1g`. `A3 → R1` is also implied by `A3 → A4 → A5 → R1`; listing it is justified because R1 writes A3's verifier and plan-critic runtimes. Every packet reaches D1g. D1g's only predecessor is R1.

§5.2 matches the writers: `build-runtime.ts` is `B2 → A1b → A4 → A5` (R1 is forbidden); `scheduler-store.ts` is `B2 → A4 → A5 → R1`; `native-build-factory.ts` is `A3 → A5`; `integration-manager.ts` and `project-docs.ts` are A5 only; `verifier-contracts.ts` is R1 only; `filesystem-mutation-routing.test.ts` is controller only. Lane B's launch order matches the edges, and the card says A4 waits for A3, A5 creates no task kind and does not touch the worker driver, and R1 waits for A3 and A5.

The graph and the packet rows are clean. The lane phrase in A5-8 and the STATE next-action block in A5-7 are the exceptions.

## Findings by severity

### BLOCKING

1. **A5-1** — apply-before-`tick` never runs on the completion path, so `STATE.md` is requested and never committed, and AC-25 then refuses completion. Fix: commit before the Architect tool returns, and apply pending requests before any Architect call.
2. **A5-2** — document HEAD and `projection.integrationRevision` diverge, so `project.handoff_selected` rejects the handoff that is supposed to deliver the documents. `advanceIntegrationRevision` would invalidate final verification. Fix: one explicit accounting rule and a handoff-after-`STATE.md` test.
3. **A5-3** — the legacy exemption is a spec field A5 cannot write and readiness cannot read, so either every run is exempt or resumed legacy runs are not. Fix: a durable scheduler stamp written from `build-runtime.ts` on first configuration only.

### IMPORTANT

4. **A5-4** — plan-only readiness returns before any `STATE.md` check, and the plan-only handoff request skips readiness.
5. **A5-5** — link refusal cannot run in the pure reducer; it has to run against the integration worktree at commit time.
6. **A5-6** — the marked `AGENTS.md` section, the `CLAUDE.md` pointer, and the default layout are exported and not required.
7. **A5-7** — STATE section 2 still dispatches the closed revision 7 review.

### MINOR

8. **A5-8** — Lane B still says "the new task kind."

## Verdict

**PLAN COVERAGE INSUFFICIENT**

R1-1 is repaired. I2 is removed. The graph, §5.2, packet rows, and launch cards match the new packets, aside from the lane phrase and STATE section 2.

Blocking conditions:

1. A5 applies `project_doc.requested` only before `scheduler.tick()`, which the completion and final-verification paths return before, so AC-25's `STATE.md` commit never lands and completion stays refused.
2. A5 advances integration HEAD without a rule that `project.handoff_selected` and final-verification readiness can both accept, so the documents do not survive handoff.
3. A5 classifies legacy runs by a spec policy field that is outside the packet and invisible to `buildCompletionReadiness`, so AC-25 does not bind new runs.
