# D1g scoped re-check — corrections since c81f632a

Reviewer: fresh context. Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `codex/runner-v2-agent-capability`, HEAD `e3bf2d28`.

Reviewed range: `git diff c81f632a..e3bf2d28 -- runner-v2 lib components scripts`. Product files changed are only under `runner-v2/` (19 files). No `lib/`, `components/`, or `scripts/` hunks. Docs commits in the same range are outside this scope.

Prior reconciliation at `c81f632a` is reused as delivered, including the accepted symlink-at-append minor. This re-check scores only the three product commits:

- `dadc4c4c` — refuse completion and handoff while a context-recording decision is open
- `11ea357c` — prompt-review fixes part 1 (H1, H2, H4, H5)
- `e3bf2d28` — prompt-review fixes part 2 (H3, M2, M4, M5, M6)

Source: `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` revision 4 (D1, D2, D3, D6, D8, AC-1..AC-10, AC-17, AC-18, AC-24, AC-25).

## 1. Blocking hole

Closed at the reducer, before any mutation.

`rejectCompletionWhileContextRecordingUnresolved` (`scheduler-store.ts`) throws `Context recording failure must be resolved before completion or handoff.` when `latestUnresolvedContextRecordingNote` is set. It is the first statement of:

- `run.completed`
- `project.handoff_requested`
- `project.handoff_selected`

A thrown append does not land. `scheduler-store.test.ts` ("completion and handoff are refused while a context recording note is unresolved") asserts all three events leave the log length, `paused` / `context_recording_failed`, the unresolved note, and `projectHandoff === undefined` unchanged.

No new way off that decision was added.

- `project_doc.abandoned` only moves a pending document request to `projectDocs.abandoned`. It does not change `status` or `pauseReason`.
- The recording decision turn now registers only `resolve_context_recording` and `ask_user` (`createArchitectTools`). `ask_user` appends `architect.question_requested`, which sets a blocking question and does not clear the recording pause or resolve the note.
- `run.resumed` is still rejected while `pauseReason` is `context_recording_failed` and the note is unresolved. Handoff can no longer delete `pauseReason` first.
- The only assignments of `status = "completed"` in the reducer remain those two guarded cases.
- After an unresolved decision turn, the pump keeps reporting `context_recording_failed` unless the projection is no longer that pause (`native-build-manager.ts`). `buildStepResultForProjection` reports the projection; it does not append a completion or a resume. Resume still requires `decision === "resumed"` and `status === "running"`, which `finishContextRecordingResolution` returns only after a `retry` or `proceed_without_manifest` resolution (or abort → failed).

Legacy logs are unaffected. The new check is a no-op when there is no unresolved note, which is every log from before context-recording notes. `project_doc.abandoned` is a new event type; old logs never contain it, and `carriedProjectDocs` omits `abandoned` when the field is absent, so replay of pending/committed/documentTip matches the previous clone. `retriesRemaining` is an optional allowed key: `assertExactKeys` rejects unknown keys only, and a missing value stays `undefined`, so old `context_recording_decision_required` checkpoints still parse.

## 2. Source obligations vs the three commits

No source obligation in the scored set is broken.

| Check | Result |
|---|---|
| D1 / AC-3 / AC-4 | The open note still has exactly `retry`, `proceed_without_manifest` (non-empty rationale), or `abort`. Completion and project handoff cannot substitute. The retry budget helper is the same set-of-resolution-sequences count the reducer already used. |
| AC-9b | On every turn whose reason is not `context_recording_decision_required`, a non-`plan_only` run still registers `review_task`, `request_integration`, and `complete_run`, and `assertArchitectLifecycleRegistration` still requires those three. The required-three flag is `runPolicy !== "plan_only" && reason.type !== "context_recording_decision_required"`. The `plan_only` exemption is the one the reconciliation already accepted. The new exemption is that one reason only. |
| H2 / AC-6 / AC-8 | `review_required` checks out `submission.taskRevision` in the existing independent-verifier disposable copy. `architectCommandWorkspacePath` still ignores `projectRoot`. A missing review revision throws `Review command copy requires the submission task revision.` before the agent loop. A checkout failure is returned as `command_workspace_unavailable` for that revision only; the test asserts the create list is exactly the submission revision. Other reasons still use `integrationRevision`. |
| H5 / AC-25 / AC-7 / AC-17 | `project_doc.abandoned` cannot satisfy readiness. `projectDocumentationReadiness` reads committed `docs/project/STATE.md` only. Abandon removes a pending request and copies `committed` and `documentTip` through. It cannot delete a commit that already satisfied the gate, and it cannot invent one. The only append site is runner recovery, and only when the summary is blank, contains `\n` or `\0`, or the commit throws exactly `Project document summary is invalid.` New writes are refused by `projectDocSummaryAccepted` before `project_doc.requested`. A valid one-line summary is committed. The abandon event is durable, runner-attributed, and listed in the Architect `project-docs` section. |
| M4 / AC-9a | The verifier prohibition is unchanged, word for word: `You have no authority to edit files, create commits, integrate changes, alter the plan, review worker tasks, or complete the run.` It is still sent once, inside `verifierSystemPrompt`, for expectations, verdict, and inspection. Pass-specific lines were split out of that shared block. The plan-critic sentence `You have no authority to edit files, change the plan, assign work, or complete the run.` is unchanged. |
| AC-18 | No new required field on old events. Optional `retriesRemaining`. Optional `abandoned`. Completion guard does not fire without an unresolved note. |

D2 allow-lists, D3 MCP admission, D6 worker refusal and integration-branch document commits, and D8 independence selection are not modified by this range.

## 3. Other changes

The hunks match the stated fixes: recording-decision refusal and pump reporting; H1 tool list, guidance, and `retriesRemaining`; H2 review checkout; H4 committed-doc context; H5 summary validation and abandon recovery; H3 worker sentence; M2 decision-tool wording; M4/M5 verifier prompt split; M6 critic question wording. No product hunk sits outside that list.

`loadCommittedStateText` returns undefined on a hash mismatch or artifact read error. The context then says `(committed text unavailable)`. That does not commit, abandon, or satisfy AC-25.

The previously accepted minor remains: symlink refusal is still at commit (`refuseProjectDocLink`), not in `validateProjectDocPath` or the append. This range does not touch that path. It is not a new finding and it is not a blocking condition.

## Findings

### BLOCKING

None.

### IMPORTANT

None.

### MINOR

None new. The accepted symlink-at-append gap is unchanged.

## Verdict

**RECONCILED — READY FOR FINAL GATE**

The completion-ready handoff bypass is closed in the reducer for `run.completed`, `project.handoff_requested`, and `project.handoff_selected`. These commits do not add another way off an unresolved context-recording note, and they do not break the scored source obligations.
