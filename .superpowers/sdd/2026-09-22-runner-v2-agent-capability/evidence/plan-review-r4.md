# Re-review — plan revision 4

Reviewer context: fresh. Read-only. No edits to the workspace.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`
Branch: `docs/agent-capability-and-change-critique` at `70245f47` (tree clean; `git rev-parse HEAD`).
Node: `C:\Program Files\nodejs\node.exe` v24.18.0, used to execute the scheduler pause, resume, and restart shapes.
Prior reviews: `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/evidence/plan-review-r1.md`, `plan-review-r2.md`, `plan-review-r3.md`.
Plan: `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md`
State: `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/STATE.md`

Scope was N-1 through N-10 from the round 3 report, plus regressions from revision 4's rewrites of the edge list, the Phase C rule, the OQ-4 default, B2, A1b, A5, E1, the launch cards, and the Depends-on fields. B-3, B-2, D7-1, regressions 1 and 2, and the nine r1 IMPORTANT findings were not re-audited except for a spot check where those rewrites touch them.

N-1 is on its last permitted repair cycle. It is not sound. No further repair is proposed. Under plan §8 this is an exhausted REPAIR_BUDGET and goes to the owner.

---

## Repair claims

| ID | Verdict | How it was verified |
|---|---|---|
| N-1 (B-1) | **NOT FIXED** | `task-scheduler.ts:278-288` does append `run.paused` and does not fail the task. A Node run of that outcome resolved `awaitIdle`, left the task `running`, and did not dispatch on the next tick while the run stayed paused. `run.resumed` then dispatched the same attempt again. The waiver registry is not in B1's contract and is not on a file B2 may write. §5.2 still says the catch must re-raise. Detail below. |
| N-2 (B-5) | **NOT FIXED** | §2, C1's Depends-on, the edge list, and STATE's C1 row open C1 on A0, I1, and I3. §5.1, the Lane C header, and STATE's lane row still open the lane after B2. The Lane C body says C1 needs only I1 and I3. §2 says those texts state one rule. They do not. |
| N-3 (B-4, regression 3) | **NOT FIXED** | `A5 → C2` and `A5 → C4` are in the edge list, C2 depends on A5, and the controller card says B2 unblocks neither. The commit table names `createTaskWorkspace`, `architect:plan`, `commitTask`, a content hash, an `actor` field, and both audit gates. `commitTask` throws `NoTaskChangesError` on a workspace still at baseline (`workspace-manager.ts:298-302`). `acceptedChangeSessions` only sees a session that already has `changeSet`, and the only `sessions.submit` caller is `worker-runtime.ts:407`. A5's steps still say "Define how". §5.1 still gives Lane C `scheduler-store.ts` at B2. |
| N-4 | **NOT FIXED** | B2's release sentence and the Lane B card no longer hand the files over at B2. §5.1's Lane C owner cell still says Lane C inherits `scheduler-store.ts` and `build-runtime.ts` after B2. §5.2 and the controller card hold both through A1b and A5. |
| N-5 | **REPAIRED** | A1b's writable list is `build-runtime.ts` and its tests only. `role-capabilities.ts` stays on Lane A through A4. A1b does not depend on A4 and does not write that file. |
| N-6 | **NOT FIXED** | E2 records "stage-1 coverage is never skipped," including a low-plan-risk run whose plan critique is skipped. STATE PD-11 still records the predicate N-6 rejected: stage-1 coverage runs when plan critique runs, plus at medium change risk, called "one tier lower." |
| N-7 | **NOT FIXED** | `A1 → A1b`, `A5 → C2`, and `A5 → C4` are in the edge list, and C2, C4, and STATE name A5 (C4 names A1b inside the release phrase). The plan still says every Depends-on and every STATE row is an exact copy of that list. D1g's contract is "A, B, C, E accepted." The list's edges into D1g are only A4, A5, C5, and E3. A2 has no path to D1g. The drawing says `all → D1g` and does not draw `A0 → C1`. |
| N-8 | **REPAIRED** | E1's acceptance says AC-19 is not accepted there, the section-id check is a helper, and E1 is graded on AC-20 and AC-22. The ledger's AC-19 cell is the message, tool-result, and loaded-session assertion, which E2 owns. E1's requirements cell and §1.1 still list AC-19 beside E1; the acceptance paragraph is the one a worker is graded on, and it does not use the helper as the proof. |
| N-9 (regression 4) | **REPAIRED** | The edge list has `A0 → C1`. C1 depends on A0. §2 says C1 writes source and that no source packet starts before A0. The Lane C body's "only I1 and I3" is the N-2 split, not a missing edge. |
| N-10 | **NOT FIXED** | The stated path `A0 → B1 → B2 → C2 → C3 → E1 → E2 → E3 → D1g` is nine packets and is still in the graph via `B2 → C2`. `A5 → C2` makes a longer path. `A0 → A1 → A4 → A5 → C2 → C3 → E1 → E2 → E3 → D1g` is ten packets, and every edge is in the list. The graph is acyclic. The count is still wrong. |

Continuity with the round 3 table:

| ID | Verdict | How it was verified |
|---|---|---|
| B-1 | **NOT FIXED** | Same as N-1. Last repair cycle. |
| B-2 | **REPAIRED** (not re-opened) | Spot check only. `### A1b` is still a contract. The edge list has `A1b → C4`. §5.2, the controller card, the Lane C card, and STATE's C4 row still put A1b before C4. Those five still agree. The roster sentence that releases at B2 is N-4. |
| B-4 | **NOT FIXED** | Same as N-3. |
| B-5 | **NOT FIXED** | Same as N-2. |
| D7-1 | **REPAIRED** (not re-opened) | Spot check only. E2 still requires a new session with an empty event list and still grades the deriving turn's messages, tool results, and loaded session. E1 points AC-19 at that assertion. |
| Regression 1 | **REPAIRED** (not re-opened) | Same spot check as B-2. A1b is on the graph and ordered before C4 on the five sites. |
| Regression 2 | **REPAIRED** (not re-opened) | E1 depends on C2 and C3. The edge list has `C3 → E1`. §5.2 still sequences `agent-prompts.ts` as A3 → C3 → E1/E2. |
| Regression 3 | **NOT FIXED** | `A5 → C2` and `A5 → C4` were added, and C2 depends on A5. §5.1 still gives Lane C `scheduler-store.ts` and `build-runtime.ts` at B2, while A5 still writes both. |
| Regression 4 | **REPAIRED** | Same as N-9. `A0 → C1` is a real edge and a real Depends-on. |

---

## N-1 trace

The question was whether recording the existing `paused` outcome from the scheduler catch leaves a task the next tick will not dispatch, whether `awaitIdle` resolves, what status the task holds for `retry`, `proceed_without_manifest`, and `abort`, whether a suspended registry short-circuits all five `recordContextPack` calls and survives a restart, and whether that mechanism is on a file B2 is allowed to write.

`recordOutcome` for `outcome.type === "paused"` (`task-scheduler.ts:278-288`) appends `run.paused` and returns. It does not transition the task. The reducer sets the run to `paused` (`scheduler-store.ts:2688-2689`). `tick` returns immediately when the run is not `running` (`task-scheduler.ts:119`). `awaitIdle` waits on `active` (`:104-108`). The `finally` in `dispatch` deletes `active` (`:235-237`).

A Node reproduction against `TaskScheduler` and `SqliteSchedulerStore`, with the driver returning `{ type: "paused", reason: "context_manifest_recording_failed" }` — the call `recordOutcome` already makes, which is the call B2's catch would make — printed:

```
awaitIdle=resolved active=0 runStatus=paused taskStatus=running attempt=1 failureReason=null assignments=1
tick while paused: newAssignments=0 taskStatus=running
after run.resumed: newAssignments=1 taskStatus=running attempt=1 runStatus=paused assignments=2
```

A second process opened on that same database while the run was paused, then resumed:

```
restart while paused: recoveredAssignments=0 storedTaskStatus=running
after resume on the recovered scheduler: assignments=1 attempt=1 taskStatus=running
```

The same harness with a driver that throws printed `taskStatus=failed`, `runStatus=running`, and `newAssignments=0` on the later ticks. Today's catch (`task-scheduler.ts:227-234`) is that path. It is not the path B2 now specifies.

So:

- While the run stays paused, the next tick does not dispatch, and `awaitIdle` resolves.
- The task status across that pause is `running`. Attempt stays 1. Nothing clears it.
- `run.resumed` makes the run `running` again (`scheduler-store.ts:2701-2704`). The next tick dispatches every task that is `assigned` or `running` and not in `active` (`task-scheduler.ts:130-132`). The paused task matches. The plan's sentence "neither failed nor redispatched" is true only for the pause window.

`retry` can use that redispatch. The same attempt runs again, and a later success can `submitted`-transition it. That one resolution is safe on the status the paused outcome leaves.

`proceed_without_manifest` is not. The redispatch calls `driver.run` again, and `recordContextPack` is before `runWorkerTask` (`native-worker-driver.ts:161`, then `:198`). The throw becomes the typed error again unless `recordContextPack` returns first. The plan puts that return in a run-scoped registry inside `context-manifest-store.ts`. The function that exists (`context-manifest-store.ts:131-142`) has no such check. All five call sites are bare `await recordContextPack` (`native-architect-runtime.ts:175`, `native-plan-critic-runtime.ts:181`, `native-verifier-runtime.ts:378` and `:651`, `native-worker-driver.ts:161`), so an early return inside that function would cover them and would not edit the sites. B2 cannot add it. B2's writable list is `build-runtime.ts`, `task-scheduler.ts`, `architect-tools.ts`, `user-steering-contracts.ts`, `scheduler-store.ts`, the client mirror, the panel, and tests. `context-manifest-store.ts` is absent. §3.0 forbids anything not listed. B1 owns that file and its contract is retry-then-throw (`B1`, acceptance at the permanently-failing stub). B1's steps and acceptance do not mention a registry, a waiver, or an early return. The sentence that assigns the registry to B1 is in B2. After B1 is accepted on AC-1, the export B2 would call does not exist, and B2 is not allowed to create it.

The plan also does not say the registry is set before `run.resumed`. `tick` dispatches as soon as the run is `running`. A waiver recorded in the projection and applied after that tick is already too late.

Restart does not restore it. The registry is described as in-memory. The reproduction above is the restart: a new scheduler, the task still `running`, resume, one dispatch. "Re-sets it on restart by reading the durable waiver" is not a step on B2 and not a step on B1. The dispatch on recovery is `tick`, which B2 could edit, but the check it would consult is the missing export.

`abort` is not safe on this status either. The source says abort stops the run. The paused outcome does not. It leaves a `running` task on a `paused` run. `TaskScheduler.resume` and the `run.resumed` reducer both exist and do not look at why the run was paused. One resume dispatches the task into `recordContextPack` again. The plan's resolution step is "mirroring the four existing pause-and-decide flows." It never says abort writes a terminal run status, refuses a later resume, or moves the task off `running`.

§5.2 still tells the B2 worker the opposite of B2's contract: `task-scheduler.ts` "its catch must re-raise the typed recording error." That is the revision 3 behavior. Re-raising skips `recordOutcome`, leaves the run `running`, rejects `awaitIdle`, and the next tick dispatches the `running` task immediately. B2 says "Do not re-raise." Both sentences are in the plan a worker executes.

The pause window itself works. The three resolutions do not, and the waiver that was supposed to make `proceed_without_manifest` work is not executable on the files B2 may write. N-1 is not sound. This was the third cycle. No other mechanism is proposed here.

---

## N-3 trace

`createChangeSet` (`change-set.ts:63-100`) still requires `taskCommit` and throws when `evidenceArtifactHashes` is empty even if acceptance criteria are omitted (`:97-100`). `ChangeSet` (`:21-39`) still has no actor field. Both are things A5 is allowed to add, and the table names them.

`commitTask` (`workspace-manager.ts:129-134`) commits whatever `ensureWorkspace` already created. On a workspace whose HEAD is still the baseline and whose status is empty, `commitWorkspaceUnlocked` throws `NoTaskChangesError` (`:298-302`). `createTaskWorkspace("architect:plan")` can create a worktree — `safeName` will turn the colon into a legal segment (`:463-470`) — and that worktree starts at the baseline. The plan never says the allow-listed plan write happens in that worktree. The write path A4 owns is `filesystem-tools.ts`, which is not on A5's list. Naming `commitTask` does not produce a `TaskCommit` until something has changed in that workspace.

`acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) keeps a session only when `actor.role === "worker"` and `projection.tasks[changeSet.taskId]` is an integrated task whose `changeSetId` matches. A5 is allowed to relax both, and the table says to. The function never sees a change set that was not stored on a session. `session.changeSet` is set only from `session.submitted` (`sqlite-agent-session-store.ts:259-270`), which `submit` writes (`:198-216`). The only caller is `worker-runtime.ts:407`. The architect runtime already holds `sessions` (`native-architect-runtime.ts:93`) and creates `architect:${runId}` with role `architect` (`:174`, `:212-218`). It does not call `submit`. The plan never says to. Relaxing the two gates on an empty candidate list does not put an architect change in the audit.

A5's steps still say "Define how an Architect write obtains a commit without a worker task."

Separately, the ordering half added the edges and C2's Depends-on. §5.1 line 740 still says Lane C inherits `scheduler-store.ts` after B2, and A5 still writes that file. That release is N-4.

---

## Findings still open

### BLOCKING

**N-1. The paused outcome holds the task only while the run stays paused. Resume dispatches it again, and the waiver that was supposed to make that safe is not on a file B2 can write.**
Location: plan B2 (`:466-484`); §5.2 (`:754`); B1 (`:423-448`); `task-scheduler.ts:119`, `:130-132`, `:227-234`, `:278-288`; `context-manifest-store.ts:131-142`; `native-worker-driver.ts:161`.
Why: stated in the N-1 trace. `retry` is the only resolution the leftover `running` status can serve. `proceed_without_manifest` needs an early return B2 is forbidden to add and B1 is not required to add. `abort` leaves a `running` task that any `run.resumed` starts again. §5.2 still requires the re-raise.
No further repair is proposed. Escalate to the owner under §8.

**N-2. Phase C still has more than one open rule.**
Location: plan §2 (`:125-128`); §5.1 (`:740-743`); Lane C header (`:878`) and body (`:880`); STATE lane row and C1 row.
Why: four texts name three different starts. C1's own contract and the edge list require A0, I1, and I3. The lane header, §5.1, and STATE's lane row wait for B2 as well, and they omit A0. The Lane C body waits for I1 and I3 only. §2 says §5.1, both card lines, and STATE state the C1 rule and no other.
Fix: pick A0, I1, and I3 as C1's only predecessors and write that in §5.1, both Lane C lines, and STATE's lane row. Leave later packets on their own Depends-on. Delete the sentence that says those texts already match.

**N-3. The named architect commit still does not appear in `acceptedChangeSessions`.**
Location: A5 (`:394-416`); `workspace-manager.ts:129-134` and `:298-302`; `native-build-factory.ts:2725-2743`; `worker-runtime.ts:407`; `sqlite-agent-session-store.ts:198-216` and `:259-270`.
Why: stated in the N-3 trace. The edges `A5 → C2` and `A5 → C4` are present. The audit entry is not reachable from the named calls.
Fix: say the allow-listed write is made in the worktree `createTaskWorkspace` returns, and that the architect session that already exists calls `sessions.submit` with that ChangeSet before the audit filter runs. Delete "Define how." Keep both gates in the filter change: role and integrated-task lookup.

**N-4. §5.1 still releases `build-runtime.ts` and `scheduler-store.ts` at B2.**
Location: §5.1 Lane B and Lane C owner cells (`:739-740`); §5.2 (`:751-752`); controller card (`:854-856`); B2 (`:504-508`); Lane B card (`:873-875`).
Why: B2, the Lane B card, §5.2, and the controller card hold both files through A1b and A5. The roster, which the controller also assigns from, gives them to Lane C at B2. A1b and A5 still write `build-runtime.ts`. A5 still writes `scheduler-store.ts`.
Fix: change the Lane B and Lane C owner cells so those two files move at the controller's announcement after B2, A1b, and A5. The client surface can still move at B2; A1b and A5 do not write it.

### IMPORTANT

**N-6. Two OQ-4 predicates are recorded.**
Location: E2 (`:647-657`); STATE PD-11.
Why: E2's acceptance is a low-plan-risk run that still records coverage obligations, including when plan critique itself is skipped. PD-11 says stage-1 coverage runs when plan critique runs, plus at medium change risk, and calls medium one tier lower than defect-hunting. Defect-hunting already starts at medium. The resume procedure tells the worker to read STATE first.
Fix: replace PD-11 with E2's predicate: stage-1 coverage is not skipped. Leave D5's low skip on change-critique defect-hunting.

**N-7. The edge list still does not match every Depends-on, and it says it does.**
Location: §4 (`:681` and `:705-719`); the drawing's `all → D1g` (`:702`); D1g (`:674`); C4 Depends-on (`:571`).
Why: the three edges N-7 named are in the list. D1g is not a copy of them. A controller who trusts "matches exactly" can start D1g with A2 unaccepted, because A2 has no outgoing edge. The drawing's `all → D1g` is a third graph, and it omits `A0 → C1`, which the list contains.
Fix: either add the missing predecessors, including a path from A2 to D1g, or change D1g's Depends-on and the drawing to the four edges the list actually has. One list, copied into the drawing, D1g, and STATE.

### MINOR

**N-10. The longest path is 10, not 9.**
Location: §4 (`:727-728`); STATE planning-progress row "longest path 9."
Why: `A0 → A1 → A4 → A5 → C2 → C3 → E1 → E2 → E3 → D1g` is ten packets. `A0 → B1 → B2 → A5 → C2 → C3 → E1 → E2 → E3 → D1g` is the same length. The path the plan prints is a real shorter path that stops being the longest once `A5 → C2` exists.
Fix: put 10 in §4 and STATE.

---

## New findings

No new blocking, important, or minor finding outside N-1 through N-10.

Revision 4's rewrites were checked for a new cycle, a dropped `C3 → E1`, an A1b contract that disappeared, and an E2 acceptance that lost the fresh-session assertion. None of those happened. The open items above are repairs that do not hold, not a new class of defect.

---

## Checked, and not found

- No cycle in the §4 edge list.
- N-5 is repaired. A1b does not write `role-capabilities.ts`.
- N-8 is repaired. E1's graded acceptance is no longer the section-id helper.
- N-9 is repaired on the edge list and on C1's Depends-on. The card's omission of A0 is N-2.
- The five sites that order A1b before C4 still agree with each other. B-2 and regression 1 were not re-opened.
- E1 still depends on C3, and `C3 → E1` is in the list. Regression 2 was not re-opened.
- E2 still requires an empty event list and still grades messages, tool results, and loaded session. D7-1 was not re-opened.
- B1's fail-closed sentence for a scheduler append that throws is still in B2. I-1 was not re-audited.
- The five `recordContextPack` awaits are still uncaught. An early return inside `recordContextPack` would cover them. That return is not in the file, and B2 cannot add it. That is N-1, not a sixth call site.
- No unowned ledger row was introduced by the lines revision 4 changed. This was not a fresh reverse trace of AC-1..AC-23.

---

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking conditions:

1. N-1 / B-1: recording the existing `paused` outcome resolves `awaitIdle` and holds the task only while the run stays paused. The task remains `running`. Resume and a recovered scheduler both dispatch it again. `proceed_without_manifest` depends on a registry in `context-manifest-store.ts` that B1 is not contracted to build and B2 is not allowed to edit. `abort` is unspecified against that `running` status. §5.2 still says the catch must re-raise. This is the third cycle. Escalate to the owner. Do not revise it again.
2. N-2 / B-5: Phase C entry is still three rules across §2, §5.1, the Lane C card, and STATE.
3. N-3 / B-4: `commitTask` on a baseline workspace throws, and `acceptedChangeSessions` still has no architect session to keep. The named table does not produce the audit entry.
4. N-4 / regression 3: §5.1 still gives Lane C `scheduler-store.ts` and `build-runtime.ts` at B2, while A5 still writes both and A1b still writes `build-runtime.ts`.

N-6 and N-7 remain important. N-10 remains minor. None of those three is a blocking condition.

Execution is not authorized.
