# FX-2 - independent code review r1

Reviewer: fresh-context independent reviewer. I did not write this code. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `2658c8b5`. The FX-2 changes are uncommitted.
Inputs: brief `fx2-brief-muse.txt`, the FX-2 section of the plan (CD-16 follow-up), `FX-1-review-r1.md` (CR-1, N1, probes D and F), and `evidence/FX-2.md`.

The sha256 of all five changed files matches `evidence/FX-2.md`, both before and after my probes:
- `architect-tools.ts 90db7f43…c163`
- `build-runtime.ts 121c8862…00aa`
- `handoff-rerequest.test.ts 683921bc…97bc`
- `build-risk-reassessment.test.ts 049a1fd5…c419`
- `docs-policy-v2-handoff.test.ts d4ef2abd…c5e`

My probes ran from temporary test files that I have since deleted. Copies are in my scratchpad as `zz-fx2-review-probe.test.ts` (P1-P9) and `zz-fx2-review-probe2.test.ts` (P10-P11). I also re-ran the FX-1 review's own probe file (`zz-fx1-review-probe.test.ts`) against the FX-2 code. `git status` is back to the worker's set.

**Verdict: REPAIR — 1 blocking**

**CR-1 is fixed in general.** I tested the v1 flow and the docs-v2 flow (factory-built port). Both handle:
- two withdrawals in a row, and two guidances back to back;
- a restart before the re-request, and a restart after it;
- a crash before or after the append;
- an exact replay of the call (deduped), and a changed replay (conflict).

The key comes only from durable state, and every C2a/C2b invariant still holds.

**N1 is fixed on the kernel side:** the re-requirement is recorded and the owner is prompted again through the manager. **It is not fixed end to end in the product.** The owner answers the new prompt through the UI's per-runtime idempotency key. That answer dedupes into the first selection, so a run whose policy offers one verifier runtime stays paused forever, and the prompt cannot be answered (B1).

## 1. Is CR-1 gone in general?

- **Mechanism.** `complete_run` (`architect-tools.ts:2394-2409`) is the only writer of `project.handoff_requested`. The only code that clears `projectHandoff` is the guidance withdrawal (`scheduler-store.ts:4515-4529`), and that always appends the handoff to `projectHandoffHistory`. The reducer refuses a request while one is current (`:5058`). So the history length strictly increases between two requests. Stop n gets the key `project-handoff-requested` (bare, n=1) or `project-handoff-requested:<k>` with a strictly increasing k. No two stops can share a key.
- **FX-1 review probes, re-run through the production manager.** These are the exact probe bodies from the FX-1 review:
  - **C-v1:** the run now **completes in cycle 0** with 2 Architect calls, both `newRequest:true`, and no pump error after stop 1. Under FX-1 it looped on `autonomous_pump_error`.
  - **C-v2** (factory-built port): **completed**, with 2 snapshots and 2 Architect calls.
  - **RA-v1, RA-v2 and RA-v1-diff** (runtime direct, including a different summary): all record 2 requests, `newRequest:true`, with no throw.
  - **D-v1 and D-v2:** `completed`/`apply_to_project`, 1 Architect call.
- **New probes.** P1-P6 and P9 go through the manager. P7 calls the real `complete_run` tool.
  - P1: two withdrawals, three stops, a different summary at stop 3, and the owner's final selection with the UI key.
  - P2: two guidances back to back.
  - P3: restarts before and after the re-assessment.
  - P5 and P6: a crash after the append and a crash before it.
  - P9: docs-v2 through the factory port, with two withdrawals and a restart before stop 3.

  All of them complete, with no duplicate request and no extra Architect turn. The keys are exactly `[bare, :1, :2]` (details below).
- **In-flight upgrade.** A run stuck under the old key already has `history=1`, so its next `complete_run` records `:1` and recovers. P10 simulates the old key and reproduces the pre-fix symptom exactly.

## 2. Are the keys deterministic? Can a stale or duplicate request be recorded?

- **CR-1.** The history length is read from `rebuildSchedulerProjection(store.readRun(runId))` at call time. It has no counter, no timestamp and no process state, and it only grows. A replay of the same step sees the same history, so it gets the same key: P4 shows the same sequence for the same summary and `Scheduler idempotency conflict for project-handoff-requested:1` for a changed summary. A direct re-append returns the same sequence and adds no row.
  - A second `complete_run` in the same stop without a withdrawal dedupes (same summary) or conflicts (different summary). Nothing new is recorded (P7 `sameStopSame` and `sameStopDiff`).
  - After a withdrawal, a request is refused until final verification (FV) has re-run and the risk has been re-assessed. P7 shows `whilePending`, `ackedNotReady` and `fvNoRisk` all as `completion_not_ready` with 0 new events. The pending-guidance gate in `appendEvent` and the reducer's `assertBuildCompletionReady` also refuse it.
  - Stale tool-call replay. The agent loop re-executes calls that have no result from the persisted Architect session (`agent-loop.ts:198-240`; the session is loaded at `native-architect-runtime.ts:260`). Suppose the process crashes after the append but before the tool result is saved. The first later Architect turn on that session is the guidance-acknowledgement turn, and it runs while guidance is pending and FV is invalidated. So the pending call is refused and used up. It cannot land as the new stop's request. I checked this by inspection; P7 covers the refusal states.
- **N1.** The count is the number of `verifier.selection_selected` events in the durable log (`build-runtime.ts:1890-1894`). A selection is accepted only while the selection is `required` (`scheduler-store.ts:3868-3887`). `required` is set only by `selection_required` and cleared only by a selection, and `resume` is refused while it is required (`build-runtime.ts:782-786`). So the count cannot change while `verify` is in flight, and two requirements at the same revision and reason always differ in count. After a restart nothing new is recorded: P8's `s2r` still has 2 requirements and verify stays at 2.
- **Old logs.** No source or test parses either prefix. The only consumer of the first-request key is `planning-tools.test.ts:1233/1266`, which asserts the bare key, and that is still correct. The reducer ignores keys. The worker's old-key test and `replay-compatibility` (worker run, hash-identical) are green.

## 3. C2a/C2b invariants

P9 used the docs-v2 flow through the factory-built port, with two withdrawals and a restart:
- Snapshots are recorded for stops 17, 33 and 50, keyed `handoff-snapshot:<stop>`.
- The chain holds: the parent of 33 is the commit of 17, and the parent of 50 is the commit of 33.
- `documentTip` is the stop-50 commit, and `requestedSequence` is 50, the latest request.
- History is `[[17,"guidance-1"],[33,"guidance-2"]]`.
- Stop 1 was refused by the manager pre-check ("The kernel handoff snapshot is required for the handed-off revision.") before any project mutation.
- Project order is `apply#1@snapshots=2` (failed), then `apply#2@snapshots=3` and `applied`.

P1 shows `requestedSequence` bound to the stop-3 request, with 2 withdrawn history records. None of these read the idempotency key, so the key change cannot affect them.

## 4. Other fixed or revision-only keys (brief item 3)

I spot-checked every key in `architect-tools.ts` and `build-runtime.ts`, plus the owner-action keys the client supplies:
- The worker's SAFE list holds for the runtime keys.
- Guidance invalidates only FV, risk and the verifier review (`scheduler-store.ts:9810`). Plan-critique keys and `acceptance-contract-upgrade:<rev>` are not reset by guidance.
- The fixed `automatic-project-handoff` key (`native-build-manager.ts:877`) and the UI key `project-handoff:<run>:<choice>` are safe. A selection is recorded only on success, and a success completes the run. P1: the owner's UI key was refused at stop 1 (apply failed, nothing recorded), then succeeded at stop 3 with the same key.
- **Missed:** the owner's verifier-selection key (B1). The Architect-handoff key has the same shape (M2).

## Findings

| # | Severity | Where | Finding | Suggested action |
|---|---|---|---|---|
| B1 | **BLOCKING** (N1 not gone end to end; brief item 3) | `app/discussion/discussion-client.tsx:1354` builds `verifier-handoff:${runId}:${runtimeId}`. It is passed through unchanged by `lib/client/runner-v2.ts:1725`, `control-server.ts:623-638`, `native-build-manager.ts:482-492` and `build-runtime.ts:857-870` | The owner's selection key identifies the runtime, not the requirement it answers. After FX-2 records the new requirement (`…:sel-1`), the owner answers the new prompt the way the product does, with the same runtime and the same key. The store dedupes that answer into the first `verifier.selection_selected` event. The API returns success with the projection unchanged, the selection stays `required`, the run stays paused, and verify is never called again. **Probe P8**, through the manager: `s3` shows selected keys unchanged at 1 and verify stuck at 2; only a distinct key gets through (`s4`, `:sel-2`). The spec usually offers one verifier runtime (`verifierRuntimeIds`), so the owner has no other choice: the run is permanently stuck behind a prompt that cannot be answered. This is the stuck-run class N1 was meant to remove, now on the owner side. The evidence's item-3 audit does not list this key. The probe-F regression never makes the second owner selection. | Scope the recorded selection by the requirement it answers. Either: (a) inside FX-2's writable set, have `BuildRuntime.selectVerifierRuntime` record `${idempotencyKey}:sel-<recorded selection count>` when the count is above 0. This is the same pattern, and a retried click for the same prompt still dedupes. Trade-off: a stale retry of an earlier prompt's click would answer the new prompt. Or (b) put the requirement occurrence in the client key. That is a UI change, outside FX-2's writable set, so it is the controller's call. In both cases, add a manager-level regression: re-prompt, the owner answers with the product key shape, a selection is recorded, and verify runs again. |
| M1 | MINOR (test rule, CD-7) | `handoff-rerequest.test.ts` "FX-2 N1 probe F", and the file header | The N1 regression drives `BuildRuntime` directly, not `NativeBuildManager`. The header says "Every test drives the production NativeBuildManager", which is not true for the probe-F test or the old-key test. P8 confirms the behavior through the manager: paused/`required`, the pump stops, and a restart records nothing. | Move probe F onto the manager and add the owner's second answer; that would also cover B1. Correct the header. |
| M2 | MINOR (pre-existing, not specific to guidance; route to controller) | `discussion-client.tsx:1330` `architect-handoff:${runId}:${runtimeId}`; `native-architect-runtime.ts:569` re-requires with `architect-handoff:<log length+1>` | Same class as B1, for Architect handoff. A second handoff offer answered with the same runtime dedupes, and the run stays paused. Found by inspection; not probed. | A follow-up with the same occurrence scoping. |
| N1 | NIT | `runner-v2/test/handoff-rerequest.test.ts` (new) | The file ends with an extra blank line. `git diff --no-index --check /dev/null <file>` reports "new blank line at EOF". The evidence's "git diff --check clean" does not cover untracked files. | Trim the last line. |
| N2 | NIT | evidence, Encodings | "architect-tools.ts fully CRLF (as committed in HEAD)": the HEAD blob is LF (`git ls-files --eol`: `i/lf w/crlf`). The working copy is CRLF from the `core.autocrlf=true` checkout, like 204 of the 217 src files. Keeping CRLF in the working tree is correct (3188 CRLF, 0 bare LF, 0 lone CR, non-ASCII 24 = HEAD). Only the wording is wrong. | Fix the wording. |
| N3 | NIT (validation gap, closed here) | evidence, Suites | Six test files drive `complete_run` through the Architect runtime and were not in the worker's run set. | I ran them (see Suites): 112 pass, 0 fail, 1 skipped (macOS only). Note it in the evidence. |

**The tests fail for the right reason.** I checked without editing source: a store subclass rewrites the new keys back to the old shapes on append (probes P10 and P11).
- P10 is the worker's v1 CR-1 flow through the manager. `runUntilBlocked` throws `Architect returned from completion_decision_required without a typed action.`, the run stays `running` with no handoff, and there is 1 request. That is exactly the worker's prove-red (1) message.
- P11 is the worker's probe-F flow. The run shows 3 × `paused/verifier_selection_required`, status `running`, selection `selected`, 1 requirement and 4 verify calls. That matches the worker's prove-red (2) (1 requirement instead of 2).

**Seed removal.** Both files now complete through a real second `complete_run` (`architect.calls() === 2`), and every C2b assertion is kept:
- `build-risk-reassessment.test.ts`: v1, docs-v2 and restart.
- `docs-policy-v2-handoff.test.ts`: G2-prod and G3.

The seeds for the reducer-level gates are left in place, which is correct.

**Encoding.** `build-runtime.ts` and the three test files have no BOM, are LF only, have 0 trailing whitespace, and keep the same non-ASCII count as HEAD (69/0/0). `architect-tools.ts` is CRLF throughout with 0 mixed endings. `git diff --check -- runner-v2` is clean. The new file has the EOF blank line (N1).

## Probes

All probes use real SQLite, real git, an advancing clock, the production-shaped verifier with the real `deriveNativeVerifierRiskInput`, and the production `NativeBuildManager` unless the probe says otherwise.

| Probe | Setup | Result |
|---|---|---|
| FX-1 C-v1 (re-run) | Withdrawn handoff, then resume cycles, then an owner selection | Completed in cycle 0. Architect calls 2 (was 2→5 with pump errors). Resume afterwards gives "A completed Build cannot be resumed." |
| FX-1 C-v2 (re-run, factory port) | Stop-1 snapshot read failure, guidance, FV re-run | Completed in cycle 0, 2 snapshots, 2 Architect calls (114 s). |
| FX-1 RA-v1 / RA-v2 / RA-v1-diff (re-run, runtime direct) | Guidance on the handoff, FV re-run on the same revision | 2 request events, second call `newRequest:true`, handoff `requested`, no throw (with a different summary too). |
| FX-1 D-v1 / D-v2 (re-run) | Guidance before any handoff | `completed`/`apply_to_project`, 1 Architect call, no pump errors; v2 has 1 snapshot. |
| FX-1 F (re-run, runtime direct) | Owner selects, then the verifier is unavailable again | 2 requirements, `paused`/`required`, verify stops at 2. |
| P1 | v1: stop 1 fails; the owner's UI-key attempt fails; withdrawal 1; stop 2 fails; withdrawal 2; stop 3 fails; the owner selects with the same UI key | Keys `[bare@19, :1@34, :2@49]`. Owner at stop 1: apply error, nothing recorded. Owner at stop 3: `ok` → `completed`. `requestedSequence` 49. History `[withdrawn 19 g-1, withdrawn 34 g-2]`. 1 selection (UI key, user). 3 Architect calls. 3 risk keys (one per generation). |
| P2 | Two guidances back to back (the second withdraws nothing), then the re-request | History 1, keys `[bare, :1]`, `completed`, 2 Architect calls. |
| P3 | Restart A before the re-assessment, restart B after it, before the second turn | No new events on recover. Keys `[bare, :1]`, `completed`, 2 Architect calls, 2 risk keys. |
| P4 | In the second turn: the same `callId` twice, a new `callId` with the same summary, then a different summary; then a direct re-append | Same sequence 34 for all three identical calls. The changed summary gives `Scheduler idempotency conflict for project-handoff-requested:1.` The re-append has the same sequence, with the row count unchanged (35→35). `completed`. |
| P5 | Crash after the append (the Architect throws after `complete_run`), then restart | After the crash: `paused`, handoff `requested`, keys `[bare, :1]`. After the restart: `completed`, no third turn, no duplicate request. |
| P6 | Crash before the append, then restart | After the crash: `running`, keys `[bare]`. After recover: Architect turn 3 records `:1`, then `completed`. |
| P7 (tool level, real `complete_run`) | First; same stop same/different; guidance pending; acknowledged not ready; FV without risk; re-request; replay; changed replay; second withdrawal; third | Keys `[bare, :1, :2]`. Every stale or duplicate call records 0 events (dedupe, conflict or `completion_not_ready`). |
| P8 (N1 through the manager) | High-risk unavailable verifier; the owner selects with the product key `verifier-handoff:<run>:rev:reviewer`; restart; the owner answers again with the same key; then with a distinct key | Re-requirement `…:sel-1` recorded and the run paused/`required` (FX-2 fixed). Restart: nothing new. **Second answer with the UI key: no new selection, still `required`, verify 2 (B1).** Distinct key: selected, then `…:sel-2`. |
| P9 (docs-v2, factory-built port) | Stop-1 read failure; withdrawal 1; stop 2 snapshot committed but apply fails; withdrawal 2; restart; stop 3 | Keys `[bare@17, :1@33, :2@50]`. Snapshots for stops 17/33/50 with the chain unbroken. Tip = stop-50 commit. `completed`/`apply_to_project` (136 s). |
| P10 (old key simulated) | The worker's v1 CR-1 regression shape | `threw: Architect returned from completion_decision_required without a typed action.`, `running`, 1 request. |
| P11 (old key simulated) | The worker's probe-F shape | 1 requirement, `running`/`selected`, verify 4. |

## Suites (NODE_TEST_CONTEXT cleared, `--test-concurrency=1`)

- Run by me:
  - My probes P1-P11: 11 pass.
  - The FX-1 review probes RA, C, D and F, re-run on the FX-2 code: 8 pass.
  - architect-lifecycle-surface, extension-runtime, native-verifier-runtime, plugin-loader, project-doc-commit and planning-review (none run by the worker): **113 tests, 112 pass, 0 fail, 1 skipped** (the macOS-only plugin alias; 50 s).
- Not re-run, because the worker ran them green on byte-identical files (hashes verified):
  - handoff-rerequest (6), build-risk-reassessment (4), docs-policy-v2-handoff (44);
  - build-runtime, scheduler-store, verifier-contracts and native-build-manager (158);
  - the importer set (136 + 26);
  - replay-compatibility with the audits (42);
  - native-delivery-factory (17);
  - runner `tsc` and eslint.
