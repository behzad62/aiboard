# C1 — independent code re-review, round 5 (targeted, CD-4)

Date: 2026-09-27. Reviewer: fresh-context Opus 5.5. I did not write this code and did not do rounds 1-4. Worktree
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `ffe0bce0`.

Reviewed (untracked). I measured the hashes before and after probing. They match the brief:

| File | sha256 |
|---|---|
| `runner-v2/src/handoff-snapshot.ts` | `2955b77e4c35a8499248b0c672f78574e2141a7a30fff95ed87bf4581fb1fc6d` |
| `runner-v2/test/handoff-snapshot.test.ts` | `f57d5f8bf34793777fa0835b8fe31f1f820d67600185a4b8728b8d3c4bede985` |

Inputs: `C1-review-r4.md` (R4-B1, m6-m10); `C1.md` §"Repair cycle 4 (controller)"; the plan's C1 contract rows
AR-R01/AR-R02. The fix delta is the diff between the r4 byte copy (`r4\hs-copy.ts`) and the reviewed file. It is the
same set of edits as the controller's `c1r4_edit.py`: the pause line under `fixedCap`; the FV keep-rank sort; the
refill plus `largestFittingBudget` (with a linear scan for `planSteps`); the m9 adapter rule; and doc text.

**Verdict: REPAIR — 1 blocking**

R4-B1 is resolved, and so are m6-m9. The pause line is now staged, and a `buildBody` audit finds no other
non-protected line without a stage. The rule still fails in general, though, through a different gap. The stage search
treats budget 0 as each part's minimum. For a short list, 0 is not the minimum: the `N more — see AIBoard run <id>`
marker that replaces the list is longer than the one or two short items it hides. The cycle-4 refill does put those
lists back to full afterwards. But it never tries the stopping stage again, and never tries a protected stage again.
So the output hides a final-verification line, or an owner action, that fits in the output as rendered. This is fix-delta
behaviour (the refill loop), and it is backed by failing probes on adapter-derived input with the production run-id
shape. Everything else holds: the cap, determinism, the digest, B1-B7 truthfulness and marker safety.

## Blocking finding

| # | Class | Where | Failing input (probe) | Expected | Actual |
|---|---|---|---|---|---|
| R5-B1 | BLOCKING. The AR-R02 "never truncates … verification" rule and the module's own stated rule are still false in general. Fix-delta: the refill never goes back to the stopping stage or to a protected stage. The same gap exists in the cycle-3 stage-minimum assumption. Backed by failing probes. | `renderHandoffSnapshot` `handoff-snapshot.ts:694-710`: a stage is zeroed and its "minimum" is taken as 0; the refill `:705-708` walks only `index-1 … 0`. `largestFittingBudget` `:735-743` bisects `[start, max]` and assumes size grows with the budget. List stages are not monotone at the top end: at `full`, the N-more line disappears. | **Y/X1** (real adapter, real renderer; run id `native-<uuid>`, 43 characters, the shape `nativeBuildProvisioningRunId` makes at `lib/client/native-build-engine.ts:103`): paused on external blocker `issue-00`, which is also exhausted (3/3; `repair.issue_paused` allows `budget_exhausted`, `scheduler-store.ts:4056`). 14 ASCII blockers with 490-character owner actions and acceptance conditions (the last owner action is 472 characters). FV: build passed, tests failed (142 run, 3 failed). **Scan**: 10 of 3,444 such inputs fail with 1 exhausted issue, and 8 of 3,444 with 2. **Longer run ids** (the renderer allows 120 characters): 60 of 3,444 show **FV 0/2 with the failed tests line hidden**. **F2 fuzz**, hand-built short lists with 36-100-character run ids: 6 of 600 fail. Seed 1600 (100-character id) hides an owner action (6/7) at 14,642 B, with 1.7 KB free. Seed 1635 (63-character id) hides both FV lines, including the failed tests line. | The protected lines (every FV category and every blocker's owner action) shrink only when the never-truncated block alone, with every other part at its minimum, exceeds the cap (module doc `:69-72`, `SHRINK_STAGES` doc `:353-355`, `C1.md` cycles 3-4). Here the full block, with the exhausted list at its smallest rendering (the one 27-byte item, not the 70-byte marker), is 16,342 B and fits, with owner actions 14/14 and FV 2/2. | **X1**: 48 lines / 16,277 B. The Verification section is `- final verification tests: failed; …` then `1 more — see AIBoard run native-…`, so **the passed build line is hidden**, while `- issue-00: 3/3 cycles used` is shown (the refill put it back). With every other stage at 0 and FV 2/2, the output is 16,385 B, one byte over the cap. So the search drops FV to 1, then the refill restores the exhausted list to its smaller full form, which frees 43 B, but FV is never retried. The final output is not even locally maximal: FV+1, with every other budget as rendered, fits (**F1**: 14 of 1,200 fuzz inputs). |

Mechanism (confirmed on scratch mutants). There are two defects, and each one alone produces failing inputs:
1. A stage at 0 can render larger than the same stage at `full`. The search moves on to the protected stages while
   size is still left to recover.
2. The top-end jump from `full - 1` to `full` removes a marker line, so it can shrink the output. Bisection over
   `[start, max]` can then settle below `max` even though `max` fits. This also causes the non-protected
   under-fills in G2: 66 stage under-fills across 500 generic inputs, each a stage left below a value that fits
   (exhausted 41, requirements 7, unaccepted boundaries 7, findings 5, tasks 3, notes 2, decisions 1). With a 120-character run id, one FV line
   plus its marker is larger than two FV lines, so bisection keeps FV at 0.

Fix guidance (non-binding; validated only on scratch mutants, not in the module):
- (a) In `largestFittingBudget`, try `max` first, then bisect `[start, max - 1]`. Inside that range the size really
  is monotone, because the N-more line is present throughout.
- (b) Make the refill a fixpoint that includes the stopping stage. Repeat the walk from `index` down to 0 (highest
  value first, so a protected stage retried by the walk comes first) until no budget changes. Budgets only grow and
  are bounded by `full`, so the loop terminates.

Scratch mutant D (`r5\hs5-mutD.ts` = (a) + (b)) has 0 violations in every scan above: 43-character ids with 1 or 2
exhausted issues, and 120-character ids. It also has 0 violations in a 1,700-input fuzz (Z), where the real module
has 6. Cap 0 and digest 0 failures. It keeps X1 at FV 2/2 and 16,342 B. The partial mutants each leave failures. C ((b) only) and B (retry only the
stopping stage) still fail 6 of the 120-character inputs. A (restore any stage whose 0 grows the output) misses the
2-exhausted cases. So both (a) and (b) are needed.

Regression test: the X1 input built by hand. A `paused` stop; `runId` `native-0f8c2d4e-6b1a-4c3e-9d7f-2a5b8c1e4f60`;
14 blockers (`act<i> ` + 490 `o`, the last with 472 `o`; `cond<i> ` + 490 `o`); `exhaustedRepairIssues`
`[{issueId: "issue-00", used: 3, limit: 3}]`; FV build passed / tests failed; the adapter's pause text. Assert FV
2/2, owner 14/14, and the cap. Add a second case with a 120-character run id that asserts the failed tests line.
Prove red against the current file. The docs listed under m10 below must change with the fix.

## Resolution table

| Item | Resolved | Evidence |
|---|---|---|
| R4-B1 pause line had no stage | **Yes** (the general rule still fails through R5-B1) | P3 named input: 47 lines / 16,008 B, owner 14/14, FV 2/2, failed tests line shown, pause line 136 B (was 516 B). P1 re-scan: 1,584 inputs, 693 protected drops, **0** violations against both oracles (every other stage at 0; every other stage at its true minimum). `buildBody` audit (below): the pause line was the only unstaged non-protected line. |
| m6 `planSteps` not monotone | **Yes** (new minor m11 on cost) | M1b re-run through the real module and brute force: 1,953 inputs, 0 needlessly small picks. `r4b` M1b: 587 planSteps stops, 426 non-monotone patterns, no small pick. |
| m7 no refill | **Yes** for the named inputs (but see R5-B1: the refill skips the stopping stage) | `r4e` re-run: 14 ASCII blockers, 30-line note; the notes now keep 9-16 lines (were 0/30). CJK 5 blockers: FV **2/2** at 15,119 B (was 0/2). |
| m8 FV kept by input order | **Yes** | G1: 500 generic inputs, every list shuffled, 0 output mismatches. Test "truncated FV lines keep red lines first …" (250 FV lines, reversed order, red line kept). In every R5-B1 case with a 43-character id, the hidden line is the passed one. |
| m9 answered run hides a recorded pause | **Yes** | `r4b` R7 on a real SQLite store: `pause reason: context_recording_failed`. R8: failed or stopped with a stale pause still shows `none`. R1-R6 unchanged. The reducer clears `pauseReason` on resume, completion and selection (`scheduler-store.ts:3789/3810/4950/4971/5001/5063/5177/5191`), so the wider rule does not bring back stale pauses. Residual: R7's next action is still `nothing to do`. This is low impact and belongs with n5 (C2 note). |
| m10 docs claimed the rule before it held | **Partial** → R5-B1 | The pause-reason field and the refill are now named. But the rule statements at `:69-72`, `:353-355` and `:682-686` are still false through R5-B1. The `largestFittingBudget` doc at `:715-719` ("rendered size grows with each budget except `planSteps`") is false at the top end of every list stage. Cycle-4 evidence claims check out on re-run: P1 0 violations, F1 0 (literal oracle), M2, D1, R1-R8, 48 `test(` blocks, hashes. |

## Fix-delta check (both directions)

- **The cap always holds.** Every value `largestFittingBudget` keeps was rendered and fit with the other budgets
  fixed. The start value is the current fitting configuration, and a scan with no fitting value restores it. So each
  refill step keeps a fitting configuration, and `render()` returns the last one. I found no cap failure: F1 1,200,
  G1 500, P1 1,584, the T1/X7/Y scans (tens of thousands of renders), M1b 1,953, and PERF.
- **Determinism.** The code is pure with no hidden state. G1 renders twice and also under shuffled input order: 0
  mismatches. F1: 0.
- **Refill quality.** The refill can leave a protected line hidden that fits (R5-B1). On the non-protected side, it
  can leave a list below a value that fits (G2, the same top-end cause). Hidden items always keep an exact N-more
  line.
- **Run time.** The binary-search stages stay logarithmic. PERF-L (5,000 of every list, 300 blockers, 2,000 plan
  tasks) takes 116 renders and 331 ms. The new `planSteps` scan is linear in renders and quadratic in time in the
  longest step or criteria list. One plan task with 1,000 / 2,000 / 4,000 / 8,000 steps takes 851 / 1,851 / 3,851 /
  7,851 renders and 110 / 412 / 1,525 / 6,106 ms. The refill path is the same: 4,000 steps take 4,015 renders and
  1.6 s. `validateExecutionTaskContract` (`planning-contracts.ts:668-693`) does not bound the step count. Real plans
  (tens of steps) are unaffected, so this is minor m11.
- **Rounds 1-4 properties still hold.**
  - B1-B7 truthfulness: `c1-probe-r2.mts`/`r2b` re-run unchanged on a real SQLite store. Handoff and stacked-pause
    stops, the selected-handoff next action, `answered_export` only after an answer, revision_2 requirements, a
    superseded acceptance kept `open`, cancelled and repair tasks, boundary counts per command, the
    failed/running/stopped runs, the verifier-selection pause, and red/green `not_applicable` all OK.
  - Marker safety: A1 sweep 2,156 checks, 0 failures; PR1 1,065 renders, 0 failures.
  - Earlier named inputs: B10-B14, C1-C3, D1, E1/E2 and F1/G1/H/TAB all hold.
  - Digest: verifies on every fuzz output.
  - `hardCap`: unchanged (the diff does not touch it).

## `buildBody` audit (question 1)

Protected (never truncated):
- The header lines (run and revision ids are capped at 120 characters; the stop reason at 500).
- The exact-count lines.
- One FV line per category (label 200, result 200, counts 500, command 500, revision 120).
- Blocker lines (id 120, owner action 500, acceptance condition 500).

Staged (a budget controls the line, so it can shrink):
- Source and spec, the pause line, the notes-absent line and the next action: `fullFixedFields`.
- Requirement rows: `requirements`.
- The no-ledger task list and the open-work task list: `tasks`.
- Findings: `findings`.
- Exhausted-issue lines: `exhausted`.
- Accepted-boundary lines: `acceptedBoundaries` (collapse to one line).
- Unaccepted-boundary lines: `unacceptedBoundaries`.
- Decisions: `decisions`.
- The notes block: `notesLines`, at most 2,000 characters.
- Plan phase lines, including the unbounded `tasks:` and `exit:` joins: `planPhases`.
- Plan task lines, including the unbounded `depends on:` join: `planTasks`.
- Step and criterion lines: `planSteps`.

Result: no non-protected line is left without a stage. The remaining gap is not an unstaged line. It is that "stage
at 0" is not "part at its minimum" (R5-B1).

## New findings

Blocking: R5-B1 (above).

Minor follow-up list (non-blocking):

| # | Where | Finding |
|---|---|---|
| m11 | `largestFittingBudget` `:727-733` | The `planSteps` scan costs one render per step value from `max` down, which is quadratic in time: 8,000 steps take 7,851 renders and 6.1 s. The fix is exact and cheap: start the scan at `min(max, HANDOFF_SNAPSHOT_MAX_LINES)`. A shown task with 200 or more steps can never fit at a budget of 200 or more (the line cap). If every shown task has fewer steps, all budgets of 200 or more render the same. |
| m12 | test file | The m6, m7 and m9 changes have no unit tests; the evidence cites reviewer probes only. Suggested tests: the M1b shape (the pick equals the brute-force maximum); the refill (a note truncated at the FV stage gets its lines back); m9 (an answered run with `run.paused` shows the pause line). |
| m13 | adapter `:1179-1183` | m9 residual: an answered run with a recorded pause still says `nothing to do`. Low impact (CD-9 and AR-R08 skip answered runs). It belongs with n5. |

## Probes run

Scripts are in `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\r5\`
(outputs in `r5\out\`). `hs5.ts` is a byte copy of the reviewed module. The only changes are `export` on internals and
a `fitsCap` call counter. S0 checks that it renders identically to the real module (150/150). `hs5-mutA/B/C/D.ts` are
scratch fix mutants. Run each probe with `node .\node_modules\tsx\dist\cli.mjs <script>` from the worktree root, with
NODE_TEST_CONTEXT cleared. The real-store probes use a temporary SQLite store that is removed in `finally`. I did not
re-run the worker suite: none of my conclusions depends on its green claim, and every probe imports the module at the
reviewed hash.

| Probe | Input | Result |
|---|---|---|
| r2/r2b/r3/r3b/r3c/r4f re-run (unchanged; real module; r2 on a real store) | B1-B7, N1-N10, P1-P8, A1 sweep, B/C/D/E/F/G, PR1 | all OK; A1 2,156 checks 0 failures; PR1 1,065 renders 0 failures |
| `r4b`/`r4d`/`r4e` re-run on `hs5` | M1b, P3, R1-R8 (real store), notes refill | m6, m7, m9 resolved (see the resolution table) |
| S0 | copy and replica trace vs the real module | 150/150 identical |
| P3 / P1 (`c1-probe-r5.mts` P) | R4-B1 named input; 1,584 adapter-derived pauses | FV 2/2, 14/14, 16,008 B; 0 violations under both oracles |
| **T1 / X7 / Y** (`r5`, `r5b`, `r5c`) | adapter-derived external-blocker pauses with 1-2 exhausted issues; run ids of 7/36/40/43/120 characters | **DEFECT R5-B1**. 43 characters (production shape): 10/3,444 and 8/3,444 fail (a passed FV line hidden). 36-40 characters: 3-7. 7 characters: 0. 120 characters: 60/3,444 with **FV 0/2, the failed line hidden**. Mutant D: 0 in every scan. |
| **X1** (`r5f`) | the named production-shaped input | **DEFECT**: FV 1/2 at 16,277 B; FV 2/2 fits at 16,342 B; the exhausted item is 27 B, its marker 70 B |
| F1 / **F2** (`r5` F) | 1,200 inputs (600 paused long-field, 600 short-list/long-id) | the literal oracle (every other stage at 0): 0 violations; cap, digest and determinism OK; FV could take one more after the refill: 14. **The true-minimum oracle: 6 violations** (seed 1600 owner 6/7 with 1.7 KB free; seed 1635 FV 0/2) |
| G1 / G2 (`r5` G) | 500 generic inputs; 13 of 14 stages seen as the stop stage (all except `exhausted`) | cap, digest, determinism and permutation invariance: 0 failures; refill maximality: 66 stage under-fills (minor side of R5-B1) |
| M1b (`r5` M) | the planSteps T/F/T/F family | 1,953 inputs, 0 needlessly small picks |
| PERF-S / PERF-R / PERF-L (`r5` M) | 200-8,000 steps in one task; refill path; 5,000 of every list | the linear scan: 7,851 renders and 6.1 s at 8,000 steps (m11); large lists: 116 renders, 331 ms |
| Mutants A/B/C/D (`r5b`, `r5c`, `r5e`) | the same scans | A (restore a stage whose 0 grows the output) and B (retry the stopping stage only) are partial. C (fixpoint refill) leaves 6 failures with 120-character ids. D (C plus try `max` first) has 0 violations, 0 cap failures and 0 digest failures in every scan. |
| Z (`r5g`) | the mutant D fuzz: 1,700 inputs (generic 500, paused 600, short-list/long-id 600), true-minimum oracle | the real module has 6 violations; mutant D has 0; mutant D cap, digest, nondeterminism and hardCap all 0; 11 s. (The fuzz leg at the end of `r5e` had a looping bug in my own oracle for stages with more than 41 items. I stopped it and replaced it with `r5g`. The `r5e` Y scans stand, because no stage there has more than 30 items.) |
