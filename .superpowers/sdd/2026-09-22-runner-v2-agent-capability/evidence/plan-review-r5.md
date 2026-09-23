# Independent planning review — agent capability program, revision 6

Reviewer: fresh-context. Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `docs/agent-capability-and-change-critique` at `c2c179fd`.

SOURCE read before the plan: `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` (APPROVED SOURCE, revision 2, 2026-09-22). Base revision named by the source: `6c166f97` on `main`.

This section was written before the plan and `STATE.md` were opened.

## STEP 2 — obligation list (from the SOURCE only)

### Scope boundary

- Keep only D1, D2, D3, and D6 in this program. D4 (change critique), D5 (risk-gated review depth), and D7 (coverage review against the original request) move to P6.6 as an owner amendment. Their text remains here only as moved pointers. Nothing is silently dropped; the owner changes, the obligation does not.
- Owner amendment: `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`.
- P6.6 already mandates an independent source-coverage review for every plan (T3) and one combined independent deliverable review per change with justified specialist review (T6), and forbids a second competing critic or coverage authority. This plan must not reintroduce a competing critic or coverage authority.
- ESC-1 option A: one further (last) repair cycle for the worker-path recording failure (plan finding B-1 / N-1). If that repair is still unsound, the verdict is NOT FIXED. Do not invent a new variation.
- ESC-2 option A: an Architect-authored plan/spec change is attributed to the Architect in git. It is not surfaced in the audit export's accepted-change list.
- Honest limits the plan must not violate: review cannot catch timing/load/real-world behaviour (that is P7); D1 does not let the Architect repair runner-private state; `architect_document` is a new task kind and real scheduler work, even though applying it costs no model tokens.

### D1 — failed context-manifest write (closes OD-3) → AC-1, AC-2, AC-3, AC-4

Problem shape the plan must match:

- `recordContextPack` (`context-manifest-store.ts`) awaits `artifacts.put` and `store.record` with no try/catch, from five call sites in four files, and none of those call sites is edited:
  - `native-architect-runtime.ts:175`
  - `native-plan-critic-runtime.ts:181`
  - `native-verifier-runtime.ts:378` and `:651`
  - `native-worker-driver.ts:161`
- The context manifest is audit-only. A side-ledger failure (locked SQLite, full disk, antivirus handle) must not kill the Build step by itself, and it must not be swallowed silently.

Control flow:

1. `recordContextPack` retries internally with bounded backoff (the common transient lock).
2. On exhaustion it throws a typed `ContextManifestRecordingError`.
3. The exhaustion writes a durable note in the scheduler store (a different database from the one that failed), not the failed ledger.
4. The run pauses. The Architect must decide. The pause uses the existing `paused` outcome (`task-scheduler.ts:278-288`), which appends `run.paused` and returns without failing the task.
5. This pause-with-typed-decision behaviour holds on all four agent paths (Architect, plan critic, verifier, worker). It never silently continues and never dies without the note.

Worker-path constraint (the B-1 repair, binding):

- `task-scheduler.ts:227-234` turns every `driver.run` rejection into a failed task. That must not be how this error is handled.
- Re-raising from that catch is also wrong: it skips `recordOutcome`, leaves the task `running`, the next tick redispatches into the same error, and an uncaught rejection becomes `autonomous_pump_error` (`native-build-manager.ts:729-736`).
- The scheduler records the existing `paused` outcome instead.

Resolutions, exactly one of three, each durable, attributed, and restart-safe:

| Resolution | Effect |
|---|---|
| `retry` | Cause addressed or transient. Resume. Recording is re-attempted within a finite budget. Exhausting that budget re-pauses with the existing note. |
| `proceed_without_manifest` | Not fixable, not fatal. Rationale required. Recording is suspended for the run. The gap is attributed, never silent. |
| `abort` | Unrecoverable. The run fails through the existing `RunSupervisor.fail` path (`run-supervisor.ts:117`) with the reason recorded. |

Waiver survival:

- Recording suspension is a runtime switch owned by `context-manifest-store.ts`.
- It is re-derived from the durable waiver event before the first dispatch whenever a runtime is constructed.
- It serves all five call sites and edits none of them.
- A crash between the waiver and the next dispatch must not redispatch into the recording failure.

Rejected: silently non-gating recording; purely fail-closed recording.

### D2 — capability model → AC-5, AC-6, AC-7, AC-8, AC-9a, AC-9b

Replace the blanket read-only filter with an explicit per-role allow-list, asserted at registration across every broker the role uses, failing closed.

| Role | Read project | Run commands | Author project code | Write plans/specs | Lifecycle authority |
|---|---|---|---|---|---|
| Worker | yes | yes | yes | yes | none |
| Architect | yes | yes (new), in a disposable copy, subject to the run permission profile | no | yes (new), via D6 only | plan, review, integrate, complete |
| Independent verifier | yes | yes (new), in its own workspace | no | no | typed verdict only |
| Plan critic | yes | no | no | no | typed findings only |

Binding constraints:

- Plan critic has no command tool. It runs during planning. P6.6 forbids implementation tests and application execution during planning mode. Architect command execution granted here applies outside a new-policy planning state; P6.6 T3 owns keeping new-policy planning read-only.
- Reader execution runs in a disposable copy (Architect) or the reader's own workspace (verifier), never the user's project. `containedDirectory` (`evidence-tools.ts:243-255`) already rejects an escaping `cwd`; any new confinement must account for it.
- Architect has no filesystem mutation tool and must not author project code (it is also the reviewer; RG-6). Document writes go through D6 only, and are refused outside the investigated plan/spec allow-list.
- Unchanged for every reader: no commits, no integration, no completing the run.
- Verifier and critic cannot alter the plan or review tasks (AC-9a: cannot commit, integrate, complete, alter the plan, or review tasks).
- Architect retains `review_task`, `request_integration`, and `complete_run` (`architect-tools.ts:1338`, `:1482`, `:1528`). D2 must not delete that authority (AC-9b).
- The user's project is never mutated by a reader (AC-8).

Current defects the allow-list must close, at the cited lines:

- Verifier inspection broker admits only `readOnly && effect === "none"` and asserts it (`native-verifier-runtime.ts:884-890`, `assertReadOnlyInspectionDefinition`). `run_evidence_command` (`evidence-tools.ts:45`, `readOnly: false` at line 65) is excluded.
- Architect is filtered the same way for filesystem and git tools (`native-architect-runtime.ts:257-274`) and has no process tools at all.
- `VERIFIER_AUTHORITY_INVARIANTS` forbids authorship and lifecycle control, not execution. The blanket filter is broader than that intent.

### D3 — MCP admission → AC-10

- The Architect admits only MCP tools that `createMcpTools` maps to `readOnly === true`, as a checked class. Server-supplied names cannot be static allow-list entries.
- Mapper predicate: `readOnlyHint === true && destructiveHint === false` (`mcp-tools.ts:156-159`). The mapper always sets `effect: "external"`, so `assertReadOnlyInspectionDefinition` can never admit one. The class needs its own assert.
- Today the Architect registers every MCP tool unfiltered (`native-architect-runtime.ts:304-308`), and under `permissionProfile: "full"` the broker requires no approval for `effect: "external"` (`tool-broker.ts:272-280`). The filter must close that hole without forcing approval under `full`.
- Verifier and critic stay at zero MCP tools.
- Rejected: banning MCP for readers; forcing approval even under `full`.

### D6 — Architect plan/spec writes → AC-7, AC-17 (ESC-2)

- Single lifecycle tool: `write_plan_document(path, content, summary)`, admitted only for paths on the investigated allow-list. The Architect does not receive filesystem mutation tools.
- The write becomes a kernel-applied task of a new kind, `architect_document`.
- The runner, not a model, creates the task workspace, writes the file, commits it with an Architect trailer through `WorkspaceManager.commitTask`, builds the ChangeSet through `createChangeSet` with the file's content hash as its evidence, and integrates it through `IntegrationManager.integrate` (`integration-manager.ts:474`).
- Applying it costs no model tokens.
- Why a task: every commit API needs a task workspace; `createChangeSet` (`change-set.ts:63-100`) needs a task id, a task commit, and at least one evidence hash; nothing on the Architect path constructs those. A real task supplies all three and reuses isolation, commit, integration, and handoff unchanged. Writing into `projectRoot` would bypass isolation and the P6 handoff.
- `acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) keeps only worker sessions with a submitted ChangeSet. A kernel-applied task has no worker session, so it does not appear there. That filter is not changed. Git shows who wrote the plan.
- Rejected: Architect filesystem mutation tools; plans kept only in runner-private state.

Consequences the plan must actually make true against the existing scheduler, not only describe:

- A task with no worker session must be able to reach `integrated` through the existing scheduler without a `review_task` step, and every step on that path must be owned by the packet that introduces the kind.
- A criteria-less task must not break acceptance-contract status or completion readiness.
- `commitTask` must produce a commit when the runner, not a worker, wrote the file into the workspace.

### Compatibility → AC-18

Runs created before this change keep current semantics and remain replayable.

### Moved requirements (must land in P6.6, not here)

AC-11 through AC-16 and AC-19 through AC-23 moved to P6.6 as EP33–EP38:

- D4 change critique → owner amendment requirements EP36–EP38.
- D5 risk-gated review depth → owner amendment requirement EP38.
- D7 coverage review → owner amendment EP33–EP35.

OQ-1, OQ-3, and OQ-4 moved to P6.6 with the decisions that raised them.

### Open question that stays

- OQ-2: which paths form the Architect's document allow-list. Investigated by plan packet I2 against `tsconfig` includes, `next.config`, and the test globs.

### What "coverage" means for this review

Every obligation above must be owned by an executable packet contract, with graph, lanes, dependencies, and STATE agreeing. A packet a worker cannot execute from its contract alone is uncovered. Moved ACs that do not appear in the P6.6 plan rows EP33–EP38 or the owner amendment are dropped, which the source forbids.

---

Plan and STATE were opened only after the list above was saved. HEAD confirmed `c2c179fde43f41694fd05b258e23515c167834f2`. Inspection used `C:\Program Files\nodejs\node.exe` v24.18.0, including a tsx reproduction of the existing `paused` outcome.

## B-1 verdict: NOT FIXED

The pause itself holds. The abort resolution does not, and this was the last repair cycle. No further variation is proposed.

### What the reproduction showed

A one-task scheduler, Node 24.18.0, existing `WorkerOutcome` `{ type: "paused" }`:

- `awaitIdle` resolved, and `activeCount()` was 0 afterwards.
- Run status became `paused`. The task stayed `running` at attempt 1.
- The next `tick` while paused did not dispatch (`task-scheduler.ts:119` returns unless `projection.status === "running"`). `run.paused` sets that status (`scheduler-store.ts:2688-2689`).
- `run.resumed` (`scheduler-store.ts:2701-2704`) and the next `tick` dispatched the same attempt again (`task-scheduler.ts:130-147`).

That matches the worker path B2 now specifies: on `ContextManifestRecordingError` only, append the note, then record the existing paused outcome (`task-scheduler.ts:278-288`), and do not re-raise. §5.2 no longer tells the worker to re-raise. The launch card says not to. The catch at `task-scheduler.ts:227-234` is in a file B2 may write.

`recordContextPack` in the worker runs before `runWorkerTask` (`native-worker-driver.ts:161`, then `:198`). Redispatch on resume re-attempts recording before any model call. **Retry's redispatch is correct.**

### proceed_without_manifest

B1 now owns `suspendContextRecording` / `isContextRecordingSuspended`, consulted at the start of `recordContextPack`, returning `undefined` while suspended. B1's only writable file is `context-manifest-store.ts`, and every call site stays forbidden. An early return there covers all five bare `await recordContextPack` sites without editing them.

Re-derivation before the first dispatch fits in a file B2 may write. The first dispatch is `BuildRuntime.stepOnce` → `scheduler.tick()` at `build-runtime.ts:837`. `new BuildRuntime` is called from `native-build-factory.ts:1151`, which B2 may not write (A3 only). The constructor body is `build-runtime.ts:239-316`, and B2 owns that file. The constructor creates the scheduler and does not tick. The pump ticks only after `createRuntime` returns. A process crash after the durable waiver is a new `BuildRuntime`. Scanning the waiver in that constructor, or at the top of `stepOnce` before line 837, is before the first dispatch. The in-process decision calls `suspendContextRecording` before resume. That crash window is closed on a B2 file.

### abort — still unsound

B2 says abort is `RunSupervisor.fail(runId, key, "context_recording_aborted")` (`run-supervisor.ts:117`). That method exists, and `paused → failed` is a legal supervisor transition (`reducer.ts:21-25`). Nothing B2 may write can call it.

`BuildRuntime` and `NativeBuildManager` do not hold a `RunSupervisor`. The live instance is created in `cli.ts` and passed to `ControlServer`. The only `fail` callers are bootstrap failure (`control-server.ts:375`) and startup recovery (`cli.ts:376`). The pump result hook is `syncAutonomousBuildLifecycle` (`cli.ts:300-322`): it calls `completeBuild` or `pause`. It never calls `fail`. `BuildStepResult` has no failed status (`build-runtime.ts:208-211`).

`cli.ts` and `control-server.ts` are on no packet's writable list. §3.0 forbids writing anything else. Naming `native-build-manager.ts` "the abort path" does not put the supervisor there.

Without `fail`, the scheduler task stays `running` and the supervisor run stays `paused` (or `running`, if the pump never synced). `shouldRecoverSpec` recovers every non-terminal supervisor state (`cli.ts:179-180`). The next process dispatches that running task again (`task-scheduler.ts:130-147`). A user `resume` does the same (`control-server.ts:886-888` then `activate`). Abort is not terminal, and the task redispatches into the recording failure. That is the hole the last review left open. Specifying the call did not make the call reachable.

## A5 verdict: UNSOUND

`commitTask` will commit a file the runner wrote, a criteria-less task can be exempted in files A5 owns, and `acceptedChangeSessions` will omit a task that has no worker session. The live path that reaches `integrated` cannot be built from A5's writable files, and the path that can reach it creates the worker session AC-17 forbids.

### Trace

Today a task reaches `integrated` only along `planned → assigned → running → submitted → architect_review → approved → integrating → integrated` (`task-graph.ts:11-24`). `submitted` makes `stepOnce` call the Architect for `review_required` (`build-runtime.ts:684-691`), which is a model call. `integrating` may be appended only by an architect actor (`scheduler-store.ts:5552-5559`). The runner may append `integrated` (`scheduler-store.ts:5561-5566`). There is no kernel shortcut.

A5 owns `task-graph.ts`, `scheduler-store.ts`, `task-scheduler.ts`, and `build-runtime.ts`, so it can add a runner-applied transition that never enters `submitted`. That part is owned. `tick` would otherwise dispatch the new kind to a worker (`task-scheduler.ts:150-179`); skipping it the way `isFinalVerificationTask` is skipped is also in an owned file.

`commitTask` does not care who dirtied the worktree. A non-empty porcelain status is `git add` and `commit` (`workspace-manager.ts:292-334`). A runner-written file produces a commit. An empty worktree still at baseline throws `NoTaskChangesError`. A5 owns `workspace-manager.ts` for the Architect trailer. The function today records `AIBoard-Run` and `AIBoard-Task` under author `AIBoard Worker` (`workspace-manager.ts:13-17`, `:330-331`). Adding the trailer is an owned edit.

`createChangeSet` (`change-set.ts:63-100`) does not require acceptance criteria. It does require at least one evidence hash (`:97-100`). Passing the file's content hash as `evidenceArtifactHashes`, as A5 says, satisfies that without editing `change-set.ts`.

A criteria-less non-cancelled task makes `acceptanceContractStatusForTasks` return `acceptance_contract_upgrade_required` (`scheduler-store.ts:5414-5441`). `tick` then refuses to dispatch (`task-scheduler.ts:121-124`) and `stepOnce` calls the Architect (`build-runtime.ts:624-654`), which spends model tokens and blocks completion. `buildCompletionReadiness` treats a non-terminal ordinary task as not ready and an `integrated` ordinary task as terminal (`scheduler-store.ts:857-863`). A5's exemption sentence is the right fix, and both functions live in `scheduler-store.ts`, which A5 writes. `validateTaskGraph` also rejects a criteria-less task whenever any sibling has criteria (`task-graph.ts:118-130`), and plan creation and reconciliation call it. That validator is in a file A5 owns too. The exemption has to cover both gates. That is specified work, not an unowned file.

`acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) keeps a session only when `actor.role === "worker"`, the session has a `changeSet`, and that id is the integrated task's `changeSetId`. A kernel task with no worker session is absent. The function does not need to change. That claim is true.

### What A5 cannot reach

The scheduler loop does not call `IntegrationManager.integrate`. It calls `integrationDriver.integrate({ taskId, changeSetId })` (`build-runtime.ts:706-710`). The only implementation loads a worker session and throws if that session has no matching change set (`native-build-factory.ts:1075-1093`):

```1082:1093:runner-v2/src/native-build-factory.ts
        const sessionId = resolveWorkerSessionId(
          spec.runId,
          taskId,
          task.attempt,
          task.assignedWorkerId ?? standardWorkerId(taskId, task.attempt),
          projection.runtime.workerAssignments[`${taskId}:${task.attempt}`]?.sessionId
        );
        const session = await sessions.load(sessionId);
        if (!session.changeSet || session.changeSet.id !== changeSetId) {
          throw new Error(`Submitted change set ${changeSetId} is unavailable.`);
        }
        const result = await integrationManager.integrate(session.changeSet);
```

`IntegrationManager` and `WorkspaceManager` are constructed inside that factory closure (`native-build-factory.ts:607`, and the driver above). `BuildRuntime` receives `artifacts`, `workspaceFor` (path only), and that session-gated driver (`:1192-1219`). It does not receive `commitTask` or `integrate(changeSet)`.

A5's writable list is `task-contracts.ts`, `task-graph.ts`, `acceptance-contracts.ts`, `scheduler-store.ts`, `task-scheduler.ts`, `build-runtime.ts`, `workspace-manager.ts`, and their tests. `native-build-factory.ts` is A3 only (§5.2). `integration-manager.ts` and the session store are on nobody's list. Submitting through `sessions.submit` (`worker-runtime.ts:407` is the only caller) on a worker session is exactly what `acceptedChangeSessions` lists. A worker-role session makes AC-17 false. Any other role is never loaded, because the driver always resolves a worker session id.

So: no worker session, and the change set never reaches `integrate`. A worker session, and the change appears in the audit list the owner said not to change. A5 cannot edit the adapter that forces that choice. AC-17 is not executable from the contract.

## Moved scope

Pre-split text from `git show 03e85149:docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`. Each row lands in the P6.6 owner amendment and in `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md`. None are MISSING.

| Moved AC | Now |
|---|---|
| AC-11 change critique at integration, before the verifier, reusing finding, gate, and resolution contracts | T6's one deliverable review, plus EP36–EP38. P6.6 already forbids a second critic. |
| AC-12 selection excludes the Architect and every change author | EP37. `RuntimeRouter.selectVerifier` with `acceptedChangeAuthorRuntimeIds`. |
| AC-13 stage 2 forms findings before seeing stage-1 findings | EP36. Findings are recorded from the source criteria and the diff before the worker report. A second stage that would reread stage 1 is the competing critic the move removes. |
| AC-14 deterministic change risk | EP38. Identical inputs, no clock, randomness, environment, or model call. |
| AC-15 low / medium / high, with a durable skip at low | EP38 has the three tiers. OA-4 replaces the skip: every task still gets the one mandatory review, and low is read-only. That replacement is written in the amendment, not dropped. |
| AC-16 high risk runs the affected tests and records them | EP38 high tier. The command is the mechanically derived affected-test command, stored as evidence. |
| AC-19 obligations come from the objective and durable guidance, not the Architect's plan or criteria | EP33 / OA-1. The deriving session reads the source, amendments, and, for a Build, the objective and durable guidance, and nothing the Architect produced. |
| AC-20 obligations are recorded before the plan or the diff; the kernel refuses a verdict with none | EP33. Recorded before the plan is provided, which is before any diff exists. The kernel refuses a coverage verdict with no prior record. |
| AC-21 per-obligation `covered` / `weakened` / `missing`, and a blocking miss or weakening holds the build | EP34 for the verdicts. T3's acceptance blocks plan-ready on an omitted obligation. T6 refuses acceptance while a mandatory finding is unresolved. |
| AC-22 four new categories, rejected when malformed, beside the existing eight | EP34. Round-trip and rejection; the existing eight still validate. |
| AC-23 a citation the evidence does not support is `unverified_claim` | EP35 / OA-2. Mechanical match on record, command, exit, revision, and artifacts; residue labelled judgement. |

OQ-1 (thresholds) is the EP38 measurement against the fourteen P6.5 commits. OQ-3 (author model tier) is the T5 investigation inside that same EP38 bullet: the tier must be available in the runner without a network call. OQ-4 (whether coverage is risk-gated) is decided by OA-1: coverage is a fresh-session kernel gate, not a risk skip. OQ-2 stays in this plan as I2.

## D2

The table and the packets agree. Architect commands run in a disposable copy (A3, the critic's provider pattern). Verifier commands use its verification workspace. The plan critic gets no command tool. The Architect gets `write_plan_document` and no filesystem mutation tool (A4). A1 and A1b keep `review_task`, `request_integration`, and `complete_run` on both the inspection broker and `createArchitectTools`. A3 leaves `evidence-tools.ts` and `tool-broker.ts` untouched, so `containedDirectory` stays. This category is clean.

## Graph, lanes, serialization

Authoritative edges match every `Depends on` and every STATE row. Acyclic. Longest path, counted as packets:

- `A0 → A1 → A2 → A3 → A4 → A5 → D1g` is 7
- `A0 → B1 → B2 → A1b → A4 → A5 → D1g` is 7

No longer path. `A0 → A1 → A1b → A4 → A5 → D1g` is 6. `I2 → A4 → A5 → D1g` is 4. Every packet has a path to D1g. A5 is D1g's only predecessor.

The parallel window is A1–A3 beside B1–B2. Those sets share no file. A1b (after A1 and B2) can overlap A3; A1b writes only `build-runtime.ts`, A3 does not. §5.2 sequences every file both lanes write: `role-capabilities.ts` is `A1 → A2 → A3 → A4`, and A4 depends on A3. `build-runtime.ts`, `scheduler-store.ts`, `task-scheduler.ts`, and `architect-tools.ts` are Lane B only, in dependency order. No file two lanes would write is missing from §5.2.

STATE's packet table, lanes, and PD-12 through PD-19 match revision 6. This category is clean.

## Executable contracts

| Packet | From the contract alone? |
|---|---|
| I2, A0, A1, A1b, A2, A3, A4, B1, D1g | Yes. Writable files contain the behavior the contract names. |
| B2 | The pause, the note, retry, and the waiver re-derivation, yes. Abort, no. See B-1. |
| A5 | No. See the A5 trace. |

## Findings

### BLOCKING

**B-1. NOT FIXED. Abort cannot reach `RunSupervisor.fail` from any file B2 may write.**

- Location: plan B2, "`abort`: `RunSupervisor.fail`"; `run-supervisor.ts:117`; `cli.ts:300-322` and `:376`; `control-server.ts:375` and `:817-838`; `task-scheduler.ts:130-147` and `:278-288`.
- Why: the paused outcome holds the task only while the run stays paused, and resume dispatches the same `running` attempt. That is correct for `retry` and, with B1's suspension re-derived in `build-runtime.ts` before `stepOnce`'s tick, correct for `proceed_without_manifest`. `fail` is what makes abort terminal. The supervisor instance lives in `cli.ts` / `control-server.ts`, which this plan lets no packet write, and the pump hook those files already install only pauses or completes. A recovered or resumed run dispatches the recording failure again.
- Fix: none proposed. This was the last permitted cycle.

**A5. The kernel-applied task cannot reach `integrated` without a worker session, and a worker session puts it on the accepted-change list.**

- Location: plan A5; `build-runtime.ts:684-710`; `native-build-factory.ts:1075-1093` and `:1151-1219`; `native-build-factory.ts:2725-2743`; §5.2 (`native-build-factory.ts` is A3 only).
- Why: `commitTask` will commit a runner-written file, and the audit filter already drops a session that is not a worker. The object that integrates, and the object that commits, are closed over in the factory. The driver `BuildRuntime` actually calls loads `resolveWorkerSessionId` and rejects a missing change set. A5's writable list does not include that driver. Creating the worker session the driver requires makes `acceptedChangeSessions` list the change, which is the outcome ESC-2 and AC-17 forbid, and the plan says that filter is not to be edited.
- Fix: put the production wiring on a packet that may write it. A5 has to receive `WorkspaceManager.commitTask` and `IntegrationManager.integrate(changeSet)` — the change-set object, not the worker-session lookup — and `native-build-factory.ts` has to be on that packet's writable list and in §5.2 after A3. Do not satisfy the driver by submitting a worker session.

### IMPORTANT

None.

### MINOR

None.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking conditions:

1. B-1 is **NOT FIXED**. `retry` and `proceed_without_manifest` match the scheduler. `abort` via `RunSupervisor.fail` is not reachable from B2's files, so the running task is dispatched again after resume or recovery. Last cycle. No new repair variation.
2. A5 cannot apply `architect_document` through the existing integrate path unless it creates the worker session `acceptedChangeSessions` is defined to list. The factory that holds `commitTask` and `integrate` is not writable by A5.
