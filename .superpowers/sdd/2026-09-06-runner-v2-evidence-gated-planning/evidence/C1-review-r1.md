# C1 — independent code review, round 1

Date: 2026-09-27. Reviewer: fresh-context Opus 5.5 (did not write the code). Worktree
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `ad6028d2`.

Reviewed (uncommitted, hashes re-measured and matching the brief):

| File | sha256 |
|---|---|
| `runner-v2/src/handoff-snapshot.ts` | `beeedb728dd330c58394a11dcc75b1cd9c1c39a5f60ec78d6668d4135e2b7a12` |
| `runner-v2/test/handoff-snapshot.test.ts` | `a8cf93a16f66408cf0d055c343ae7270bfe4a57f4a863d855af482ec60aa43ef` |

Authority: plan `docs/superpowers/plans/2026-09-27-runner-v2-p6-6-architecture-correction.md` §2 (AR-1, CD-7),
§3 AR-R01/AR-R02, §6 preamble and C1; background S2 §3.4. "Not wired" is expected (C2) and is not a finding.

**Verdict: REPAIR — 9 blocking**

The renderer shell is in good shape: pure, deterministic, bounded for normal input, marker and table
escaping work, the golden/plan-only/no-ledger/determinism/size/injection tests exist and the SQLite
adapter test uses a real store, real events and `rebuildSchedulerProjection`. The problems are in
truthfulness: the adapter misreads several real projection facts, so the snapshot can state a false
stop outcome, a false requirement status, a false pass and the wrong command. Untrusted notes and
ids can also forge kernel sections and break the 200-line cap.

## Findings

| # | Class | Where | Failing input | Expected | Actual |
|---|---|---|---|---|---|
| B1 | BLOCKING (untruthful, main C2 path) | `handoff-snapshot.ts:482-486` vs reducer `scheduler-store.ts:4995-5001` | The handoff stop as the reducer leaves it: `project.handoff_requested` sets `status = "paused"` and **deletes** `pauseReason` | `completed` (handoff requested), next action = owner choice | `stop: paused — not recorded`, next action `resume the run (not recorded)`. The `status === "paused"` branch runs before any handoff check. This is the stop C2 renders at. Probe H. |
| B2 | BLOCKING (untruthful) | `handoff-snapshot.ts:470-495` | (a) plan-only run with `status: failed` (`failureReason` set), or stopped/running; (b) `status: running` with no `projectHandoff` (the T7d on-demand export in AR-R18 renders any run state); (c) triage `answer` run that failed and has no recorded answer | The real outcome (failed/paused/…) | (a) `plan_only — plan completed — the plan is the product`, next `review the plan, then start the build`, plus the plan view of a possibly unready revision; (b) `completed — run completed`; (c) `answered_export — answered run …`. Probes C5a-c. |
| B3 | BLOCKING (untruthful) | `handoff-snapshot.ts:498-499` (`ledger.requirements ?? revision.requirements`) | Real SQLite: ledger persisted, plan drafted, then `planning.plan_revised` (accepted by the real reducer) whose `REQ-CONDITIONAL` resolves to `not_applicable` with an owner disposition and whose `REQ-MANDATORY` outcome changes | Rows from the **current plan revision**, which is what the kernel gates on (`deliveryCompletionIssues` `scheduler-store.ts:1941-1971`, `finalReadyRequirementIssues`; `derivePlanningOwnershipView` `planning-projection.ts:789` prefers the revision) | `REQ-CONDITIONAL conditional_pending (host launch-chip API exists)` and the stale outcome. The ledger is the initial skeleton, persisted once (`planning-projection.ts:1431`) and never updated; revisions can retire, re-scope or add requirements. Because completion is refused while any current-revision requirement is `conditional_pending`, every completed run that had a conditional requirement would show it as still pending. Probe B. |
| B4 | BLOCKING (false acceptance) | `acceptedRequirementIds`, `handoff-snapshot.ts:411-420` | Phase acceptance recorded under `revision_1:BP1`, current plan revision `revision_2` | Only the current-revision key counts (`phaseAcceptanceKey(currentRevisionId, phaseId)`, as `scheduler-store.ts:1947-1949` does) | `REQ-MANDATORY accepted`. Acceptances are keyed by plan revision and never removed, so a superseded revision's acceptance still marks the requirement accepted. The underlying rule "a requirement is accepted only through a phase acceptance" is correct: only `DeliveryPhaseAcceptanceRecord` carries `requirementIds`, and `evaluatePhaseAcceptance` requires every contributing task to be accepted. Only the revision binding is missing. Probe C3. |
| B5 | BLOCKING (untruthful / gap) | `handoff-snapshot.ts:527-533` (open tasks from plan contracts) | (a) a plan task that is `cancelled` in `projection.tasks`; (b) an unaccepted kernel repair task (`verification_repair`, created at `scheduler-store.ts:7024-7059`) | The kernel's own list: every scheduler task except `final_verification`/`cancelled` without a task acceptance (`scheduler-store.ts:1964-1969`), with its real status | (a) `- T1: … [open]`; (b) the repair task is missing from "unaccepted tasks"; running, integrated and failed are all shown as `open`. Task acceptance by `taskAcceptances[id]` is correct: plan contract id = scheduler task id (`scheduler-store.ts:1465-1483`). Probe C4. |
| B6 | BLOCKING (false pass) | `handoff-snapshot.ts:579` (`check.green ? "passed" : "failed"`) | A `not_applicable` final-verification category: `green: true`, no facts (`final-verification-runtime.ts:602-609`) | `not applicable (<rationale>)` | `- final verification tests: passed; counts: not recorded; command: not recorded`, a pass the records do not hold. This is the S2 §12 risk 5 case (non-Node project, tests marked not applicable). Probe C1. |
| B7 | BLOCKING (contract: exact build/test commands) | `handoff-snapshot.ts:595` (first check with a command) | A boundary on a project with a build script: checks are `["build","tests"]` in that order (`delivery-execution.ts:902`) | Both commands, each with its own outcome; the tests counts belong to the tests command | `counts: 142 selected, 142 passed, 0 failed; command: npm run build`. The test command is never shown and the counts look like they came from the build. Probe C2. |
| B8 | BLOCKING (safety + bound) | Notes `:343`; id fields `:257, 275, 287, 299, 309, 356-364` use `neutralizeSnapshotText`, which keeps `\n`/`\r`; control regex `:157` | (a) notes `"x\n"×900`; (b) notes containing `\n## Verification\n- final verification tests: passed; counts: 999 run, 0 failed…\n## Open work\nexternal blockers: none`; (c) finding id / task id containing `\n## Verification…` / `\n## Next action…` (finding ids are reviewer-model text, `validateDeliveryFindings` only needs non-blank; task ids only need `nonEmpty`); (d) `U+0085`, `U+009B`, `U+0080` | ≤200 lines. Untrusted text cannot open a line or heading of its own (the kernel snapshot "cannot state a false status", S2 §3.4). Control characters are removed (contract; evidence claims C0 **and C1**). | (a) 934 lines: notes are in no shrink budget, so shrinking cannot fix it and the over-cap output is returned; lone `\r` also survives (900 CRs, a CommonMark line ending) and the line counter does not count it; (b) 4 `## Verification`/`## Open work` heading lines instead of 2; (c) forged `## Verification` and `## Next action` inside "Open work"; (d) all three survive. Probes P1, P1b, P2, P3, P4. |
| B9 | BLOCKING (contract + false doc claim) | `handoff-snapshot.ts:281` (`budgets.findings` 40→5→0) vs module doc `:379-381` and evidence `C1.md:103-105` | 60 open blocking findings + 120 long requirements | Contract: "header, open blockers and verification never truncate". The module doc and the evidence both say open blocking findings never truncate. | 5 of 60 shown plus `55 more — see AIBoard run …`. If the controller reads "open blockers" as external blockers only, the doc and evidence still state a guarantee the code does not give and must be corrected. Probe P5. |
| m1 | MINOR (required with the repair) | test `:265-398` | — | Real-record adapter coverage of the paths where B1-B7 live | The adapter test covers only a repair-issue pause. It has no handoff stop, plan revision, phase or task acceptance, final verification, boundary, findings or decisions from real events (`test/support/delivery-seed.ts` exists). Each blocking fix needs a real-store regression test. |
| m2 | MINOR (disclosed) | `:392` | 130 boundary entries (verification never truncates; boundaries grow with task count) | ≤200 lines / 16 KiB, or an explicit signal | 163 lines, 19,448 bytes, returned silently. Contract tension (cap vs never-truncate). Decide before C2 commits: for example compact passed boundaries of accepted tasks into one line, or return an over-cap flag. Probe P7. |
| m3 | MINOR (C2 note) | `verifyHandoffSnapshotDigest :401-409` | CRLF checkout, editor-appended trailing newline, first line `junk body_sha256: <hex>` | — | CRLF → false, trailing newline → false (both would be false "hand-edited" notices on a Windows autocrlf checkout, so C2 should verify the committed blob bytes). The unanchored regex accepts any first line containing the digest. The digest is keyless, so recomputing it forges a match; that is fine for hand-edit detection but is not tamper evidence. A body byte edit is detected (probe P6). |
| m4 | MINOR | `byId`/sorts | Two findings with the same id (ids are per review, for example `F1` on two tasks), inserted in either order | Byte-identical output | Output differs (stable sort keeps insertion order on ties). Finding lines also do not name their task. Probe P8. |
| m5 | MINOR | `:580` `report.failed ?? 0` | A command report with `executed` but no `failed` | `not recorded` | Would print `0 failed`. Unreachable today (`readJUnitTestReport` sets both), but it fabricates a count. |
| m6 | MINOR | `:574` | A final-verification category that ran several commands (`final-verification-runtime.ts:652`) | Every command | Only the first command fact and its counts are shown. |
| m7 | MINOR | `:571` | The current generation was invalidated and moved to `history` | Contract: "last final verification per category" (marked stale, with its revision) | `no verification recorded` |
| m8 | MINOR | `deriveNextAction :666-669` | Pause on an external blocker | The owner action (only the owner's `repair.external_blocker_cleared` resumes the run) | `resume the run (repair_issue_paused:… — repair:external_blocker:…)`. The paused branch comes before the owner-action branch. |
| m9 | MINOR | `buildBody` | — | Contract lists "pause reason" under Open work | Shown only in the header `stop:` line. |
| m10 | MINOR | `:487-489`, `:598` | `status: stopped`; a boundary whose tests outcome is `unknown` | Distinct wording | `failed — not recorded`; the unknown boundary shows as `failed`. |
| m11 | MINOR (evidence accuracy) | `C1.md:99-105` | — | — | Claims C1 controls are removed and blocking findings never truncate (both false, see B8/B9). It also mentions "non-blocker findings", which the input never carries. |

## Contract coverage summary (AR-R01, AR-R02, C1)

| Item | Status |
|---|---|
| Header: generated-by, run, revision, stop kind + reason, stop time, body digest | Present. Stop kind/reason wrong at handoff and in other states (B1, B2). |
| What was asked (title, digest, spec path) | Present. `sourceId` stands in for the missing title field (verified: `ApprovedSourceManifest` has no title). Spec path comes from facts. |
| Requirement table, four statuses with the authorized reason | The renderer is correct. The adapter uses the wrong source and a stale acceptance (B3, B4). |
| Task list when there is no ledger | Present and tested. |
| Open work: unaccepted tasks / blocking findings / external blockers + owner action / exhausted issues / pause reason | Tasks wrong (B5). Findings are truncated (B9). Blockers and exhausted issues are OK (cleared blockers are deleted by `repair.external_blocker_cleared`). Pause reason is only in the header (m9). |
| Verification with real counts and exact commands | False pass (B6), wrong command (B7), plus m5-m7. |
| Decisions (`planningDecisions` + acknowledged guidance) | Correct fields, current revision. |
| Notes slot / "No Architect notes for this stop: <reason>" | Present. Notes can forge sections and break the cap (B8). |
| Next action derived from state | Present. Wrong at handoff (B1) and for external-blocker pauses (m8). |
| Plan-only plan view | The renderer is correct. The adapter can mislabel a failed plan-only run (B2). |
| ≤200 lines / 16 KiB | Holds for normal input. Broken by notes (B8) and, when disclosed pathological, by verification size (m2). |
| Never truncate header / open blockers / verification | Header and verification never truncate; blocking findings do (B9). |
| Neutralize markers, table breaks, control characters; field caps | Markers, cells and caps OK. Newlines kept outside cells; C1 controls kept (B8). |
| Purity / determinism / imports | OK: only `node:crypto` at runtime, no clock, randomness or I/O (grep clean). Ties are the exception (m4). |
| Encoding | OK: both files UTF-8 without BOM, LF only, the only non-ASCII is U+2014, no mojibake. `C1.md` is also clean. |

## Tests

- Real test quality: the golden test is byte-exact and its sections are also asserted independently. Determinism
  includes shuffled order. Size-cap, injection (row column count) and neutralizer unit tests fail for the right reason;
  the worker's prove-red on the neutralizer is recorded with a byte-exact restore (not repeated). The pure-import test
  is sound for this file.
- The SQLite adapter test is real (a `SqliteSchedulerStore` with real events and a projection rebuilt with
  `rebuildSchedulerProjection`). It is narrow, though: its ledger and revision requirements are identical and it seeds
  no acceptance, verification or handoff record, so B1-B7 pass it unseen (m1).
- I did not re-run the worker suite. I had no doubt about the green claim, and my probes import and run the same
  module at the reviewed hashes.

## Probes run

Scripts (reviewer scratch, outside the repo):
`C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\c1-probe.mts`
and `c1-probe-handoff.mts`, run with
`& "C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs <script>` (NODE_TEST_CONTEXT cleared).
The part B probe used a temp SQLite store under `%TEMP%`, removed in `finally`. The C probes mutate a
`structuredClone` of the real projection rebuilt in part B; each mutation mirrors a record shape the kernel writes
(cited in the table).

| Probe | Input | Result |
|---|---|---|
| P1 | notes `"x\n"×900` | 934 lines, 2,761 bytes (cap 200 lines) |
| P1b | notes `"x\r"×900` | 900 CRs survive; line counter reports 34 |
| P2 | notes with forged `## Verification` / `## Open work` | 4 such heading lines (kernel renders 2) |
| P3 | finding id and task id with `\n## …` | Forged `## Verification` and `## Next action` inside Open work |
| P4 | `U+0085 U+009B U+0080` in notes and source title | All survive |
| P5 | 60 blocking findings + 120 long requirements | 5/60 findings shown, `55 more` marker; 45 lines / 5,113 bytes |
| P6 | Digest checks | original true; one body byte edited false; header recomputed true (keyless); CRLF false; trailing `\n` false; loose first line true |
| P7 | 130 verification entries | 163 lines, 19,448 bytes |
| P8 | Duplicate finding ids in swapped order | Outputs differ |
| B | Real SQLite: ledger → draft → `plan_revised` (revision_2 accepted by the reducer) | Kernel current revision `revision_2` has `REQ-CONDITIONAL not_applicable`; snapshot shows `conditional_pending (host launch-chip API exists)` and the stale `REQ-MANDATORY` outcome |
| C1 | `not_applicable` tests category, `green: true`, no facts | `- final verification tests: passed; counts: not recorded; command: not recorded` |
| C2 | Boundary checks `build` (`npm run build`) then `tests` (`npm test`, 142/142/0) | `counts: 142 selected, 142 passed, 0 failed; command: npm run build` |
| C3 | Phase acceptance `revision_1:BP1`, current `revision_2` | `REQ-MANDATORY accepted` |
| C4 | `T1` cancelled; unaccepted `verification_repair` task `repair-1` | `- T1: … [open]`; `repair-1` absent |
| C5a | plan-only, `status: failed` | `plan_only`, `plan completed — the plan is the product`, next `review the plan, then start the build` |
| C5b | `status: running`, no handoff | `completed`, `run completed` |
| C5c | triage `answer`, `status: failed`, no answer | `answered_export`, `answered run — …` |
| C5d | `status: stopped` | `failed`, `not recorded` (m10) |
| H | Reducer handoff state: `status: paused`, no `pauseReason`, `projectHandoff.status: requested` | `stop: paused — not recorded`; next `resume the run (not recorded)` |
| D | Encoding (BOM, UTF-8 round trip, CR, non-ASCII, mojibake) | Clean for both code files and `C1.md` |

## Repair guidance (non-binding)

Derive the stop from status plus handoff first (`projectHandoff.status === "requested"` → completed/handoff), then
plan-only and answered as qualifiers of a real completion. Take requirements from the current plan revision (the ledger
only when no revision exists). Count only `phaseAcceptanceKey(currentRevisionId, phaseId)`. Build open work from
`projection.tasks` using the kernel's own exclusions, with the real status. Render `not_applicable` categories as such.
Show every boundary check's command with its own outcome and counts. Put notes in a structure-safe form (for example
prefix every line with `> ` and count them in the budget, or cap notes lines). Collapse newlines in every id and remove
`\r` and `U+0080-U+009F`. Make blocking findings non-truncating, or correct the doc and evidence after a controller
ruling. Add a real-store adapter regression test for each blocking fix.
