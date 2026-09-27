# C1 — independent code re-review, round 2 (targeted, CD-4)

Date: 2026-09-27. Reviewer: fresh-context Opus 5.5 (did not write the code, did not do round 1). Worktree
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `ffe0bce0`.

Reviewed (untracked). Hashes were measured before and after probing and match the brief:

| File | sha256 |
|---|---|
| `runner-v2/src/handoff-snapshot.ts` | `3272db15c2a026e199adaa04ada83117fb399547d5c253d1d762fd459b3e0f7b` |
| `runner-v2/test/handoff-snapshot.test.ts` | `2a864671c5d97d54d62d00b0fda03a442c6e22b4ddf97c5d69d91ec0caeffdca` |

Inputs: `C1-review-r1.md`; repair brief `c1-repair1-muse.txt` (D1-D8); plan
`2026-09-27-runner-v2-p6-6-architecture-correction.md` §6 C1, AR-R01/AR-R02 and CD-4; worker evidence `C1.md` §"Repair cycle 1".

**Verdict: REPAIR — 3 blocking**

Most of the repair is sound. The stop-kind derivation, current-revision requirements, current-key phase acceptance,
kernel task list, per-check verification lines, and single-line/notes neutralization all behave as D1-D5 require. My
re-runs of the round-1 probes against the new code confirm this. Three defects remain, all where D5 and D6 are
enforced:

1. Table cells still escape comment markers before removing control characters. A raw
   `<!-- aiboard:architect:end -->` survives, and the repair's wider removal set added new bypass characters.
2. The 200-line / 16 KiB cap still breaks on the round-1 P7 input, and unaccepted boundary lines are rendered twice
   once the shrinker collapses boundaries.
3. The fallback truncates external blockers, which must never truncate, before the truncatable unaccepted boundaries.

## Blocking findings

| # | Class | Where | Failing input (probe) | Expected (contract / decision) | Actual |
|---|---|---|---|---|---|
| R2-B1 | BLOCKING. B8 not resolved per D5; also a fix-delta regression. | `neutralizeSnapshotText` `handoff-snapshot.ts:228-234`, used by `neutralizeSnapshotCell` for the requirement id, outcome and status cells (`:419`) | Requirement outcome `ok <!\u0085-- aiboard:architect:end --\u0085> tail`. The same happens with U+0001, U+007F or U+2028 in place of U+0085, and with the requirement id `R<!\u0085--` (N1, N1b). | D5: for single-line fields (ids, outcomes, …), remove C0/C1/U+2028/U+2029 **then** apply the existing escapes. Contract: "`<!--`/`-->` … are escaped". The contract test names the AGENTS marker. | Row `\| REQ-X \| ok <!-- aiboard:architect:end --> tail \| open \|`: a raw AGENTS marker and a live inline HTML comment in STATE.md. The marker escapes (`:231-232`) run before the control strip (`:233`), so a control character placed inside `<!-`+`-` is stripped after the escape pass. The round-1 code had the same order with a C0-only set. The repair widened the set to `\u007F-\u009F\u2028\u2029`, so NEL, C1 and U+2028 are now bypass characters too (before the repair they stayed in place and kept the marker broken). `singleLine` (`:249-256`) and `renderNotesBlock` (`:264-268`) use the correct order. The injection test only puts markers in notes, which go through `renderNotesBlock`, so it cannot catch this. Fix: remove the controls first in `neutralizeSnapshotText`, and add cell cases to the injection test. |
| R2-B2 | BLOCKING. m2 not resolved; D6 "the cap always holds"; untruthful duplicate verification lines. | `buildBody` verification block `:521-536`; `renderHandoffSnapshot` `:621` returns over-cap output; plan phases `:567-572` never shrink | (a) The round-1 P7 input: 130 boundary lines, none `taskAccepted`. (b) 20 unaccepted boundaries plus 40 long findings (D1). (c) A plan view with 70 phases (N4a), or 12 phases × 6 long exit criteria (N4b). | D6/contract: other lists truncate with "N more" so the cap always holds. Verification lines are exact, one per check. | (a) **166 lines / 19,779 bytes**, returned silently. N2 with 130 two-check boundaries: 298 lines / 38,498 bytes. (b) Every boundary line appears **twice** in the final output (40 lines, 20 unique). Cause: once `collapseAcceptedBoundaries` is set and there are no accepted-task boundaries, the `else` branch (`:523-528`) renders **all** unaccepted boundaries and ignores the budget. The second block (`:529-536`) then renders the budgeted list again. `unacceptedBoundaries = 0` therefore never removes anything. This hits an ordinary paused run with one in-flight boundary and a large requirement table. (c) 248 lines, and 22,118 bytes; phases, their task lists and their exit criteria are in no budget. The worker's D6 stress test used only `taskAccepted: true` boundaries, the one path that collapses correctly. The module doc (`:604-611`) and the evidence claim the cap always holds. Fix: render unaccepted boundaries only through their budget; before the collapse, render each list exactly once; give the plan phases a budget; make the renderer never return over-cap output silently. Add tests for P7, one unaccepted boundary with a large requirement table (assert no duplicates), and 70 phases. |
| R2-B3 | BLOCKING. D6: never-truncated items are truncated early (new code). | `shrinkBudgets` `:354-365` (fallback order `blockers` → `unacceptedBoundaries` → `finalVerification`); unaccepted boundaries are in no normal shrink step | 130 unaccepted-task boundaries (build + tests) plus 1 external blocker (N2) | D6/contract: every external blocker with its owner action is never truncated unless the never-truncated set **alone** exceeds the cap. Unaccepted-task boundaries are not in that set ("everything else may list-truncate"). | The owner-action line of the blocker is gone. Only `external blockers: 1 total` plus `1 more — see AIBoard run` remain, although the never-truncated set alone is 37 lines / 3,084 bytes. Unaccepted boundaries are shown in full until the fallback, and the fallback drops blockers **first**. Budgets are never restored, so the blocker stays dropped after the boundaries are cut. With the R2-B2 rendering fixed, the order still drops the blocker first. Fix: move unaccepted-task boundaries into the normal shrink order, before the fallback; truncate blockers and final-verification lines only when the never-truncated set alone exceeds the cap. Add a test: 130 unaccepted boundaries plus 1 blocker keep the owner-action line. |

## Resolution table (round-1 findings)

| r1 | Resolved | Evidence |
|---|---|---|
| B1 handoff stop | Yes | `:748`, `:758-760`, `:931-933`. Real store, probe H: projection `paused`, no `pauseReason`, handoff `requested` → `stop: plan_only — handoff requested`, next = owner choice. The worker test does the same on a real store. Residual minors n5, n6. |
| B2 real outcomes | Yes | Precedence `:752-782`. Re-run C5a-d: plan-only failed → `failed — provider credit exhausted`; running → `in_progress`; answer-triaged failed with no answer → `failed`; stopped → `cancelled — run stopped`. N6a on a real store: `answered_export` only after `request.answered`. The plan view is headed with real readiness (`:959`, `readyPlanIdentity` parity with `scheduler-store.ts:1225-1236`). Residual minor n5. |
| B3 current revision | Yes | `:786`. Probe B re-run on a real SQLite `planning.plan_revised` → revision_2: REQ-CONDITIONAL `not_applicable (Condition resolved false. (authorized by owner))`; REQ-MANDATORY has the revised outcome. |
| B4 current-revision key | Yes | `:657` filters on `planRevisionId === currentRevisionId`, equal to the kernel key (`deliveryPhaseAccepted` writes `planRevisionId` = current and keys it `phaseAcceptanceKey(planRevisionId, phaseId)`, `scheduler-store.ts:7120-7147`). C3 re-run on the real revision_2 projection: `open`. The worker's prove-red is recorded. |
| B5 kernel task list | Yes | `:813-820` + `:440-442`, the same exclusions as `deliveryCompletionIssues` `scheduler-store.ts:1964-1969`. C4 re-run: cancelled T1 is gone, `repair-1 … [planned]` is listed, real statuses are shown. |
| B6 not_applicable | Yes, for the green case | `:861-869`. C1 re-run: `not applicable (no test runner detected)`. Residual minor n8 (not_applicable with `green: false`). |
| B7 per-check commands | Yes | `:891-910`. C2 re-run: `boundary T1 build: passed; counts: not recorded; command: npm run build` and `boundary T1 tests: passed; counts: 142 selected, 142 passed, 0 failed; command: npm test`. |
| B8 untrusted text | **No** (R2-B1) | Single-line fields, notes and digest: P1 (66 lines), P1b (no CR), P2 (2 headings), P3 (no duplicated heading across ids, reasons, blockers, decisions and title), P4 (no C0/C1/U+2028/U+2029 survive): all OK. Table cells: raw marker, see R2-B1. The D5 prove-red is recorded. Newlines in cells become `<br>` instead of a space; they cannot open a line, so this is acceptable. |
| B9 never-truncate statement | Yes, for the statement | The module doc (`:50-58`), the evidence and the contract agree on what never truncates, and the counts lines exist (`:410`, `:446`, `:460`, `:473`, `:488`). P5 re-run: the exact counts are kept. Enforcement of that statement is broken (R2-B2, R2-B3). |
| m1 real-store coverage | Yes, with a gap | Real SQLite for handoff, running, answered, revised plan, cancelled task, delivery-seed findings, FV not_applicable. The clone fixtures are faithful (see "Fixture fidelity"). Gap: the D6 stress test uses only accepted boundaries, which let R2-B2 and R2-B3 through. |
| m2 cap vs never-truncate | **No** (R2-B2) | The round-1 P7 input still gives 166 lines / 19,779 bytes. |
| m3 digest | Yes | P6: CRLF true, trailing LF true, `junk`-prefixed first line with the correct digest false, `x`-prefixed header false, body edit false. The keyless recompute still forges a match, as documented (`:60-70`). New minors n1, n11, n12. |
| m4 tie-breaks | Yes | P8: duplicate `F1` across tasks in swapped order gives identical bytes; lines read `- F1 (task TA): …`. |
| m5 missing count | Yes | `:877-881`: `not recorded`, never 0. |
| m6 every command | Yes | `:871-873` joins every command fact. Residual minor n10. |
| m7 stale generation | Yes, for the literal case | `:850-855`, faithful to invalidation at `scheduler-store.ts:5305-5315`. Residual minor n9. |
| m8 external-blocker next action | Yes | `:923-933`, `:983`; base adapter test `owner action required: …`. |
| m9 pause reason in Open work | Yes | `:496`, `:590-595`. Residual minor n6. |
| m10 stopped / unknown wording | Yes | C5d: `cancelled — run stopped`; an unknown boundary stays `unknown` (worker test). |
| m11 evidence accuracy | **No** (minor) | `C1.md` §"Repair cycle 1" still states false things. (1) "the ordered shrink plus the never-truncate fallback, proven by the 60/120/130 stress test": false for unaccepted boundaries and plan phases (R2-B2). (2) The neutralizer correction implies markers are always escaped: false for cells (R2-B1). (3) "`failed`/`stopped` … are projected by the RunSupervisor, not by scheduler events": failed is written by the reducer at `scheduler-store.ts:9183-9186` (context-recording abort). The clone's shape (status + `failureReason`, no `pauseReason`) matches that path, so the test is still faithful. |

## Fixture fidelity (the worker's stated limit)

Each clone and kernel-shape fixture was compared with what the reducer writes. None hides a mismatch in the fields the
adapter reads.

- **failed / stopped clones** (`status` + `failureReason`): match the reducer's only failed path
  (`scheduler-store.ts:9183-9186`) and the documented supervisor overlay (`:820-826`). The adapter reads only `status`
  and `failureReason`. The unready plan-only variant sets `readiness: "not_ready"`, a value the reducer writes on revision
  (`planning-projection.ts:1426/1501/…`).
- **Superseded phase acceptance:** the record has exactly the `DeliveryPhaseAcceptanceRecord` fields
  (`delivery-acceptance.ts:264-273`). The fixture base revision really is `revision_1`
  (`planning-source-fixture.ts:286`). My C3 re-run on a real `planning.plan_revised` projection gives the same result.
- **Repair task:** kind `verification_repair`, `objective`, `status`, the same kind the kernel creates
  (`scheduler-store.ts:7024-7059`). The adapter reads only id, kind, objective and status.
- **Task acceptance:** exact `DeliveryTaskAcceptanceRecord` fields, keyed by task id as the reducer keys it (`:7101`).
- **Boundary record:** exact `DeliveryBoundaryRecord` fields. `checkId` = category with `command`/`args` and a tests
  `report.counts`, as `delivery-execution.ts:917-935` records it.
- **FV stale clone:** `current` removed and history entry `state: "invalidated"` + `invalidatedByRevision`, exactly as
  the integration-advance reducer does (`scheduler-store.ts:5305-5315`). The FV tests fact (`command` = executable,
  `args`, `report.{executed,failed}`) matches `final-verification-runtime.ts:720-751`.

## New findings (minor; follow-ups unless fixed with the blocking repair)

| # | Where | Finding |
|---|---|---|
| n1 | `normalizeBody` `:598-600`, used by `verifyHandoffSnapshotDigest` | `/\s+$/` is quadratic on a whitespace run that does not end the input. N3: 10k spaces then `x` = 66 ms, 20k = 266 ms, 40k = 1,076 ms, so about 11 minutes for 1 MB. C2 runs the verifier on the committed `STATE.md` at the tip, which models can write, and it blocks the runner's event loop synchronously. Use `trimEnd()`, which removes the same character set in linear time. This is fix-delta code; recommended in this repair. |
| n2 | `deriveNextAction` `:985` | A completed build run after `project.handoff_selected` (probe D2, `apply_to_project` already chosen) still says `owner chooses apply_to_project or keep_integration_branch`. This is the usual state for a T7d export after completion. Base the next action on `projectHandoff.status`. |
| n3 | `renderNotesBlock` `:262-274` | Silent notes truncation. 30 lines of 65 characters (1,979 characters, under both caps) become 2,039 characters with the `> ` prefixes, so the last line is cut to `> 29 nnn…` with no truncation marker (N5). Base the flag on the rendered length. |
| n4 | `shrinkBudgets` `:325-353` | Budgets go straight to 0 and are never restored. P5: 0/60 findings and 0 requirement rows are shown although the final output is only 37 lines / 1,165 bytes. The contract allows this, but the snapshot drops most of its content without need. Shrink in steps, or re-expand after the cap fits. |
| n5 | stop kind `:758` vs `:761` | An answered run at the handoff pause (real store, N6b) renders `completed — handoff requested` with the apply/keep choice; `answered_export` appears only after selection. This is literal D1, but it contradicts the answered wording. Low impact: C2 and C3 skip answered runs. |
| n6 | `:758`, `pauseReasonText :591` | A pause stacked on the handoff stop (real store, N7: `run.paused {reason: "context_recording_failed"}` after `project.handoff_requested`) renders `pause reason: none` while the projection holds a `pauseReason`. The next action remains the handoff choice. |
| n7 | paused branch `:772-776`, `:984` | Pauses the reducer records without a `pauseReason` (`verifier.selection_required` `scheduler-store.ts:3787-3789`, `architect.handoff_required` `:5176-5177`) render `paused — not recorded` / `resume the run (not recorded)`. The owner's real action is to select a verifier or Architect runtime (N8). This branch was unchanged since round 1. |
| n8 | `:861` | A `not_applicable` category with `green: false` (the runtime writes it when commands were supplied, `final-verification-runtime.ts:604-607`; the reducer accepts it, `scheduler-store.ts:7539-7544`) renders `not applicable (…)` and hides a red check (N10). |
| n9 | `:852-857` | Categories in the FV plan that have not completed are omitted with no pending line. A new `current` generation with partial checks hides the last history result for the other categories (m7 residual). |
| n10 | `:871-881`, `:896-907` | When only some of a category's commands have reports, the joined counts no longer line up with the joined commands (m6 residual). The boundary check `reason` (for example "Tests exited 0 but did not prove a run") is not rendered next to `unknown`/`failed`. |
| n11 | test `:339-343`, `:223-276` | The "loose header" assertion replaces the whole first line and uses an all-zero digest, so it passes without anchoring; the code does anchor (P6). `recomputed` is dead code. The D6 stress test uses only accepted boundaries (see R2-B2/B3). |
| n12 | `verifyHandoffSnapshotDigest` | A UTF-8 BOM added by an editor makes the check fail (P6 `BOM=false`). This is a C2 note: verify the committed blob bytes. |
| n13 | `C1.md` | The m11 residuals above. |

## Fix-delta check (both directions)

- Did anything that was right before break? Yes, in one place. Widening the control-strip set in
  `neutralizeSnapshotText` (a D5 change) made C1, DEL and U+2028 characters new marker-bypass characters in cells
  (R2-B1). Everything else that round 1 found correct still holds: purity, where decisions come from, source/digest,
  requirement rendering, determinism.
- Did anything change beyond the findings? The next action for a requested handoff now always takes precedence
  (`:931`), which D1 requires. `acceptedRequirementIds` now returns an empty set when there is no current revision. That
  is correct: there is no ledger acceptance key. The plan-view shrink covers only plan tasks and steps (R2-B2c). No
  unrequested behavior change otherwise.
- Purity and imports: still `node:crypto` only at runtime (`:72-73`), and the test at `:353-363` asserts it.

## Probes run

Scripts (reviewer scratch, outside the repo):
`C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\c1-probe-r2.mts`
and `c1-probe-r2b.mts`. Both were run with `& "C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs <script>`
from the repo root, with NODE_TEST_CONTEXT cleared. The real-store part used a temp SQLite store under `%TEMP%`, removed
in `finally`. I did not re-run the worker suite: nothing in this review depends on its green claim, and the probes import
the module at the reviewed hashes.

| Probe | Input | Result |
|---|---|---|
| P1 | notes `"x\n"×900` | 66 lines, 1,240 bytes: OK |
| P1b | notes `"x\r"×900` | 0 CR, 66 lines: OK |
| P2 | notes forging `## Verification` / `## Open work` | 2 heading lines (the kernel's own): OK |
| P3 | line breaks (LF, CR, CRLF, U+2028) in finding/task ids, statuses, blocker fields, decisions, stop reason, source title | 7 headings, none duplicated: OK |
| P4 | U+0085/U+009B/U+0080 in notes, title and requirement cells | none survive: OK |
| P5 | 60 findings + 120 long requirements | counts exact; 0/60 finding lines and 0 requirement rows at 37 lines / 1,165 bytes (n4) |
| P6 | digest variants | original true; body edit false; keyless recompute true; CRLF true; trailing LF true; loose first line with correct digest false; prefixed header false; BOM false |
| P7 | round-1 input: 130 unaccepted boundary lines | **166 lines / 19,779 bytes** (R2-B2) |
| P8 | duplicate `F1` across tasks, swapped | identical: OK |
| N1 | requirement outcome `<!X-- aiboard:architect:end --X>` with X = U+0001 / U+0085 / U+2028 / U+007F | raw `<!-- aiboard:architect:end -->` in the table row in every case (R2-B1) |
| N1b | requirement id `R<!\u0085--` | raw `<!--` in output (R2-B1) |
| N2 | 130 unaccepted two-check boundaries + 1 blocker + long notes | blocker owner-action line **dropped**; 260/260 boundary lines; 298 lines / 38,498 bytes; the never-truncated set alone is 37 lines / 3,084 bytes (R2-B2, R2-B3) |
| N2' | the same with 45 boundaries | fits (127 lines / 15,369 bytes), blocker shown |
| D1 | 20 unaccepted boundaries + 40 long findings | final output has 40 boundary lines, 20 unique: every line duplicated (R2-B2) |
| N3 | verify header + N spaces + `x` | 5k 17 ms, 10k 66 ms, 20k 266 ms, 40k 1,076 ms: quadratic (n1) |
| N4 | plan view 70 phases; 12 phases × 6 long exit criteria | 248 lines; 22,118 bytes (R2-B2c) |
| N5 | 30 notes lines of 65 characters | last quoted line cut, no marker (n3) |
| H | real store: plan-only `project.handoff_requested` | `plan_only — handoff requested`, next = owner choice: OK |
| N7 | H + `run.paused {context_recording_failed}` | still `pause reason: none` (n6) |
| N9 | real store: plan-only handoff selected | `plan_only — handoff selected`, next `review the plan, then start the build` |
| D2 | completed build run, handoff selected `apply_to_project` | next `owner chooses apply_to_project or keep_integration_branch` (n2) |
| N6 | real store: triage answer, `request.answered`, then `project.handoff_requested` | `answered_export` before the request; `completed — handoff requested` after it (n5) |
| N8 | verifier-selection pause shape | `paused — not recorded`, next `resume the run (not recorded)` (n7) |
| B | real store: ledger → draft → ready → `planning.plan_revised` (revision_2) | current-revision truth: OK |
| C1/N10 | FV `not_applicable` green true / green false | both `not applicable (…)`; the green-false one hides a red check (n8) |
| C2 | boundary build + tests | per-check command, outcome and counts: OK |
| C3 | `revision_1:BP1` acceptance on the real revision_2 projection | `open`: OK |
| C4 | T1 cancelled + unaccepted `repair-1` | T1 gone, `- repair-1: fix boundary [planned]`: OK |
| C5a-d | plan-only failed / running / answer-triaged failed / stopped | `failed` / `in_progress` / `failed` / `cancelled`: OK |

## Repair guidance (non-binding)

In `neutralizeSnapshotText`, strip controls before the escapes. In `buildBody`, render unaccepted-task boundaries only
through their budget and never twice. Put unaccepted boundaries into the normal shrink order ahead of the fallback, and
keep blockers and final-verification lines out of the fallback unless the never-truncated set alone is over the cap.
Give plan phases a budget, and make over-cap output impossible or explicit. Add regression tests: the P7 input, one
unaccepted boundary with a large requirement table (no duplicate lines), 130 unaccepted boundaries plus 1 blocker (the
owner-action line kept), 70 phases, and cell-marker bypasses with U+0001/U+0085/U+2028. Cheap to fold in: n1
(`trimEnd()`), n2 and n3. Correct the `C1.md` claims (m11/n13).
