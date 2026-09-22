# Re-review — plan revision 3

Reviewer context: fresh. Read-only. No edits to the workspace.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`
Branch: `docs/agent-capability-and-change-critique` at `016cb6e1` (tree clean; `git rev-parse HEAD`).
Node: `C:\Program Files\nodejs\node.exe` v24.18.0, used to execute the scheduler re-raise shape.
Prior reviews: `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/evidence/plan-review-r1.md`, `plan-review-r2.md`.
Plan: `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md`
State: `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/STATE.md`

Scope was the nine revision-3 repair claims and new regressions from those edits. B-3, I-1 through I-9, and material neither prior review flagged were not re-audited.

---

## Repair claims

| ID | Verdict | How it was verified |
|---|---|---|
| B-1 | **NEW DEFECT** | AC-3 names all four paths and makes the worker test separate (ledger row; B2 text). Owning `task-scheduler.ts` is real. Re-raising does reach `build-runtime.ts:838`, and the scheduler `finally` does run. The task is left `running` and is redispatched into the same throw. Detail below. |
| B-2 | **REPAIRED** | `### A1b` exists. §1.1 has the row. Phase A lists A1b. The §4 edge list has `B2 → A1b` and `A1b → C4`. §5.2, the edge list, the controller card, the Lane C card, and STATE all put A1b before C4 on `build-runtime.ts`. Those five agree with each other. |
| B-4 | **NOT FIXED** | A5 now lists `native-build-factory.ts`, an actor field, a role-filter relaxation, and a commit sentence. Checked against `change-set.ts:63-100` and `native-build-factory.ts:2725-2743`, that sentence still cannot produce an audit entry. §5.2 orders A5 before C2 and C4; the controller card and C2's Depends-on do not. |
| B-5 | **NOT FIXED** | C1's Depends-on and the §4 edges into C1 are only I1 and I3. §5.1, the Lane C card header, and STATE §3 still open the lane only after B2 as well. §2 says those texts state the same rule. They do not. |
| D7-1 | **REPAIRED** | E2 requires a new session with an empty event list, and it grades the deriving turn's messages, tool results, and loaded session. A test can observe all three on the live critic path. E1's acceptance paragraph still grades the section-id helper; that is a separate finding, and it does not make E2's assertion unwritable. |
| Regression 1 | **REPAIRED** | A1b is no longer absent from §3, §1.1, the phase list, or the graph, and the five ordering sites put it before C4. |
| Regression 2 | **REPAIRED** | E1 Depends-on is C2 and C3. The edge list has `C3 → E1`. §5.2 sequences `agent-prompts.ts` as A3 → C3 → E1/E2 and says E1 depends on C3. STATE matches. |
| Regression 3 | **NOT FIXED** | §5.2 sequences `scheduler-store.ts` as B2 → A5 → C2 and `build-runtime.ts` / `native-build-factory.ts` as A5 before C4. The edge list has `B2 → C2` and `B2 → C4` and no `A5 → C2` or `A5 → C4`. The controller card says "B2 alone unblocks C2." C2's Depends-on is C1 and B2. C2 and A5 both write `scheduler-store.ts`. |
| Regression 4 | **NOT FIXED** | The caption no longer says "A0 → everything." The replacement rule, A0's contract, and §5.1 say no source packet starts before A0. C1 writes `change-risk.ts` and its Depends-on is only I1 and I3. The edge list does not connect A0 to C1. |

---

## B-1 trace

`task-scheduler.ts` transitions the task to `running` before `dispatch` (`:141-144` and `:173-178`). `dispatch` (`:221-237`) stores one promise: `driver.run`, then `recordOutcome`, then a `catch` that today records `type: "failed"`, then `finally` which deletes `active`.

`tick` (`:110-183`) returns before that promise settles. `build-runtime.ts:837` therefore does not observe the worker error. `awaitIdle` (`task-scheduler.ts:104-108`) does: it `await`s `Promise.all` of `active`.

A Node reproduction of the plan's re-raise (throw `ContextManifestRecordingError` inside the `catch`, leave status `running`, delete `active` in `finally`) printed:

```
FINALLY activeSize=0 taskStatus=running
AWAIT_IDLE_REJECTED ContextManifestRecordingError active=0 taskStatus=running
```

So:

- The rejection reaches `build-runtime.ts:838`, which B2 is allowed to wrap. `tick` itself does not reject.
- The scheduler `finally` runs. The active map is not left holding the task. `awaitIdle` throws; it does not spin. `tick`'s own `finally` (`:181-183`) has already released the tick queue.
- No outcome is recorded, so the task stays `running`.

`tick` redispatches any task whose status is `assigned` or `running` and which is not in `active` (`:130-132`). After the re-raise, that predicate is true whenever the run status is `running`. A catch added around `:838` can append the note and pause, and `stepOnce` then returns at `:585` while the run is paused, so the loop is not immediate. The task is still `running`. The next tick after resume dispatches it again.

`recordContextPack` in the worker is before `runWorkerTask` (`native-worker-driver.ts:161`, then `:198`). The throw aborts `driver.run`. B2 may not edit that call site (B1 forbids every call site; §5.2 assigns them to nobody). B2's writable list does not include `context-manifest-store.ts`. A waiver recorded in the scheduler cannot be consulted by the throw. `proceed_without_manifest` resumes the run, `tick` redispatches, and the same typed error fires again. The worker task cannot leave `running` through the stated repair.

If the new catch is missing and the rejection leaves `step`, `runUntilBlocked` does not catch it. `native-build-manager.ts:729-736` pauses with `autonomous_pump_error` and does not write `context_manifest.recording_failed`.

The swallow is gone. The specified re-raise parks a `running` task that the scheduler treats as crashed work and starts again. That is a wedged task, so the claim is not repaired.

---

## B-4 trace

`createChangeSet` (`change-set.ts:63-100`) requires `taskCommit`. With no acceptance criteria it still throws when `evidenceArtifactHashes` is empty (`:97-100`). The returned object has no actor field (`ChangeSet` at `:21-39`). `commitTask` / `commitWorkspace` (`workspace-manager.ts:129-146`) both commit a task workspace, and `taskCommit` copies `workspace.taskId` (`:418`). `workspace-manager.ts` is not on A5's writable list.

`acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) keeps a session only when `actor.role === "worker"` **and** the change-set id is an integrated task's `changeSetId` **and** `projection.tasks[changeSet.taskId].changeSetId` matches. Relaxing the role clause leaves the task lookup. The plan's mechanism says the task binding is replaced by the architect actor. It does not say what is passed as `taskId`, which commit function is called, or how a session with no integrated task enters `acceptedIds`. The steps still say "Define how an Architect write obtains a commit without a worker task."

§5.2's owner sequence does not overlap A5 with C2 or C4 on the three shared files. That sequence is not what assignment uses. See regression 3.

---

## New findings

### BLOCKING

**N-1. The worker re-raise leaves the task `running` and the next tick runs it again.**
Location: plan B2 ("its catch must re-raise … rather than converting it to a failed outcome"); `task-scheduler.ts:130-132`, `:141-144`, `:173-178`, `:227-237`; `native-worker-driver.ts:161`.
Why: the error does reach `awaitIdle`, and `finally` does clear `active`. Skipping `recordOutcome` leaves the status `tick` uses to recover a crashed task. The recording throw is inside `driver.run`, before the task body, and B2 cannot change that await or `recordContextPack`. Pause is reachable. `proceed_without_manifest` is not: resume redispatches into the same error. An uncaught rejection becomes `autonomous_pump_error` (`native-build-manager.ts:729-736`) and never writes the note.
Fix: in the scheduler catch, record the existing `paused` outcome (`task-scheduler.ts:278-288`) plus the manifest note, and do not transition the task to `failed`. `awaitIdle` then resolves and `build-runtime.ts:840` sees the pause. Allow B2 one edit at `native-worker-driver.ts:161`, or inside `recordContextPack`, so a recorded waiver continues into `runWorkerTask` instead of throwing. Do not leave status `running` across that pause unless the resolution is `retry`.

**N-2. Phase C still has two open rules.**
Location: plan §2 (`:125-129`); C1 Depends-on (`:480`); §4 edges `I1/I3 → C1`; §5.1 (`:684-685`); Lane C card header (`:818`) versus its body (`:820-821`); STATE §3 lane row and §4 C1 row.
Why: §2, C1, the edge list, the Lane C body, and STATE's C1 row open Phase C on I1 and I3 alone. §5.1, the Lane C header, and STATE §3 open the lane only after B2 as well. §2 says the card, §5.1, and STATE state the C1 rule. The header and §5.1 state the other one. A controller still cannot tell whether C1 starts at I1/I3 or at B2.
Fix: pick the C1 rule everywhere, including the Lane C header, §5.1, and STATE §3. Later packets keep their own Depends-on. Delete the sentence that claims the texts already match.

**N-3. A5 still cannot make an architect change appear in the audit, and C2 can write `scheduler-store.ts` while A5 holds it.**
Location: A5 contract (`:372-402`); `change-set.ts:63-100`; `native-build-factory.ts:2725-2743`; `workspace-manager.ts:129-146` and `:418`; controller card "B2 alone unblocks C2" (`:798`); C2 Depends-on (`:500`); §5.2 (`:693-695`); edge list (`:661-662`, no `A5 → C2`).
Why: the named relaxation is the worker role check. The audit function also requires an integrated task id, and every commit API in the tree requires a task workspace. "Define how" is still the step. Separately, §5.2's A5-before-C2 order is not an edge and is contradicted by the controller card, so Lane C can edit `scheduler-store.ts` in parallel with A5.
Fix: name the commit function, the workspace, and the id that replaces `taskId` in `createChangeSet`, `taskCommit`, and `acceptedChangeSessions`. Change the task lookup, not only `actor.role === "worker"`. Add `A5 → C2` and `A5 → C4` to the edge list and to C2 and C4 Depends-on, and delete "B2 alone unblocks C2" or limit it to files A5 does not write.

**N-4. Lane B is told to release `build-runtime.ts` and `scheduler-store.ts` at B2, which reopens the A1b/A5 race.**
Location: B2 "On release" (`:468-470`); Lane B card (`:814-815`); controller card (`:796-798`); §5.2 (`:693-694`).
Why: the five sites checked for B-2 do put A1b before C4. The packet the Lane B worker executes, and that worker's launch card, say the opposite: release both files when B2 is accepted. A1b and A5 still write `build-runtime.ts` after that. A5 still writes `scheduler-store.ts` after that. Following the worker card hands both files to Lane C at B2.
Fix: delete the B2 release sentence and the Lane B card's "release them at B2." One announcement, from the controller, after A1b and A5 have integrated, matching §5.2.

**N-5. A1b and Lane A both write `role-capabilities.ts`, and §5.2 does not serialize it.**
Location: A1b writable list (`:265`); A2, A3, and A4 writable lists (`:291`, `:319`, `:358`); Lane A roster (`:680`), which gives that file to Lane A through A4.
Why: A1b depends on A1 and B2, not on A2/A3/A4. Lane B can reach A1b while Lane A is still in A2, A3, or A4. Revision 2 had no A1b writable list, so this collision is new.
Fix: drop `role-capabilities.ts` from A1b if A1 already owns the allow-list entries, and limit A1b to the `createArchitectTools` assert in `build-runtime.ts`. If A1b must edit the list, add the file to §5.2 as A4 → A1b and depend on A4.

### IMPORTANT

**N-6. The OQ-4 default contradicts D5.**
Location: E2 (`:607-612`); STATE PD-11; source D5 table (low skip, medium defect-hunting, high tests) and OQ-4 (`docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md:400-403`).
Why: the recorded default runs stage-1 coverage whenever plan critique runs, and "additionally at medium change risk — one tier lower than D5 defect-hunting." Defect-hunting already starts at medium. One tier lower is low. Medium is the same floor, not a harder skip. Stage 1 also runs before a change exists, so change risk is not a stage-1 input. The plan-critique low-risk skip remains a way to skip coverage.
Fix: record one predicate. If the source recommendation is the decision, stage-1 coverage is not skipped at low plan risk or low change risk, and a test shows a low-risk plan still records obligations. Do not call medium "one tier lower."

**N-7. The authoritative edge list omits dependencies the packets and STATE require, and it claims not to.**
Location: §4 (`:636` and `:660-663`); A1b Depends-on includes A1 (`:267`); STATE A1b row; C4 Depends-on (`:533`) omits A1b and A5 while STATE's C4 row and the edge `A1b → C4` include A1b and the controller also waits for A5.
Why: §4 says every Depends-on matches the edge list and nothing else. A1 → A1b is in the contract and STATE and not in the list. A5 → C4 is in STATE and the controller card and not in the list. C4's own Depends-on omits A1b, which the list contains. A controller reconciling toward the sentence "matches exactly" drops or adds a predecessor depending on which paragraph it reads.
Fix: make one list. Include `A1 → A1b`, `A5 → C2`, and `A5 → C4`. Copy that list into every Depends-on field and into STATE. Remove edges that are not predecessors.

**N-8. E1 still accepts AC-19 with the section-id check E2 says is not the proof.**
Location: E1 acceptance (`:573-574`); ledger AC-19; E2 (`:591-601`).
Why: E2's real assertion is provable, so D7-1 is not failed by this. E1's contract still says the section-id assertion is the AC-19 acceptance. A worker graded on E1 can satisfy that paragraph while the deriving session already holds the plan. The ledger says that helper is not the acceptance.
Fix: change E1's acceptance to the helper only. AC-19 is accepted on E2's message, tool-result, and session assertions.

**N-9. "No source packet before A0" is not true of C1.**
Location: A0 contract (`:200`); §5.1 (`:687`); §4 edges (A0 goes to A1 and B1 only); C1 Depends-on (`:480`).
Why: the corrected caption is still false. C1 writes source (`change-risk.ts`) with no path to A0. A0's steps pin the capture to revision `6c166f97`, so a C1 file on the branch does not by itself change that revision's projection. The assignment rule and the graph still disagree.
Fix: add `A0 → C1`, or state that a new unimported module is not a source packet for this gate and remove C1 from the rule.

### MINOR

**N-10. The longest path is no longer 8.**
Location: §4 (`:670`); STATE planning-progress row "longest path 8."
Why: `A0 → B1 → B2 → C2 → C3 → E1 → E2 → E3 → D1g` is nine packets. The stated path stops at C5 and ignores the E chain the new edges added. The graph is acyclic. The count is wrong.
Fix: recompute the longest path from the repaired edge list and put that number in §4 and STATE.

---

## Checked, and not found

- No cycle in the §4 edge list.
- No packet in §1.1 is missing from the graph as a node. A1b, A5, and E1–E3 are present. The missing items are edges, not orphans.
- D7-1's assertion can be written against live machinery. `ScriptedModel.complete` stores `request.messages` (`runner-v2/test/native-plan-critic-runtime.test.ts:948-962`). The critic test already reads `sessions.load` (`:151`). `runAgentLoop` appends `role: "tool"` results into that message list and checkpoints them (`runner-v2/src/agent-loop.ts:461-472`). The critic copies `sessions.events` and `sessions.load(...).checkpoint.messages` into the turn (`native-plan-critic-runtime.ts:236-254`) before `runAgentLoop` (`:317-327`). `SqliteAgentSessionStore.events` returns the event list (`sqlite-agent-session-store.ts:280`). `load` throws when the list is empty (`:230`), so a fresh session is observable as an empty event list and as no checkpoint. A seeded checkpoint is observable both from `load` and from the messages the model receives.
- Regression 2 is repaired. `agent-prompts.ts` is not a parallel write between C3 and E1 under the revised Depends-on.
- The five sites named for A1b-before-C4 agree with each other. The contradicting release order is N-4, not a split inside that set.
- No unowned AC row was introduced in the ledger lines revision 3 changed. This was not a fresh reverse trace of AC-1..AC-23.

---

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking conditions:

1. N-1 / B-1: re-raising `ContextManifestRecordingError` from `task-scheduler.ts:227-234` reaches `awaitIdle` and runs `finally`, and it leaves the task `running` so `tick` dispatches it again. The worker cannot proceed past the throw on the files B2 is allowed to edit.
2. N-2 / B-5: Phase C entry is still two rules.
3. N-3 / B-4 and regression 3: the architect ChangeSet still has no executable commit path into `acceptedChangeSessions`, and C2 is unblocked at B2 while A5 still owns `scheduler-store.ts`.
4. N-4: B2's release sentence and the Lane B card release `build-runtime.ts` and `scheduler-store.ts` at B2, against §5.2's hold through A1b and A5.
5. N-5: `role-capabilities.ts` has two lane owners and no §5.2 sequence.

Execution is not authorized until those five are repaired and reviewed again.
