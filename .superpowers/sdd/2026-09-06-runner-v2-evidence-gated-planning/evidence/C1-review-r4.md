# C1 — independent code re-review, round 4 (targeted, CD-4)

Date: 2026-09-27. Reviewer: fresh-context Opus 5.5. I did not write this code and did not do rounds 1-3. Worktree
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `ffe0bce0`.

Reviewed (untracked). I measured the hashes before and after probing. They match the brief:

| File | sha256 |
|---|---|
| `runner-v2/src/handoff-snapshot.ts` | `7a247b7eb52d6aefb6697a3d538d94de63d65fc8daea55ae70532e3fe6ed639b` |
| `runner-v2/test/handoff-snapshot.test.ts` | `c8905a7251151d4b0fc02258de038f1564ace87251b2c6bb843bfd5e0e9e99c7` |

Inputs: `C1-review-r3.md` (R3-B1, m1-m5); `C1.md` §"Repair cycle 3 (controller)"; plan
`2026-09-27-runner-v2-p6-6-architecture-correction.md` §6 C1 "Bounds and safety" and AR-R01/AR-R02; kernel sources
for pause reasons (`scheduler-store.ts:4051-4063`, `build-runtime.ts:3130-3225`).

**Verdict: REPAIR — 1 blocking**

The cycle-3 rewrite fixes every named round-3 input. m1-m5 are resolved. The cap, determinism, B1-B7 truthfulness and
marker safety all still hold. One gap is left in the R3-B1 rule, and a failing probe on adapter-derived input shows it.
The Open-work `pause reason:` line is not protected, yet no stage ever shortens it. It keeps its full 500-character
cap. On a paused stop, it is a copy of the header's stop reason. On an external-blocker pause, the kernel builds that
text from the blocker's whole acceptance condition and owner action. So the line is long in exactly the inputs that
R3-B1 was about. The fix is one line.

## Blocking finding

| # | Class | Where | Failing input (probe) | Expected | Actual |
|---|---|---|---|---|---|
| R4-B1 | BLOCKING. R3-B1 is not resolved in general; AR-R02 says "never truncates … verification". Fix-delta code (the new `pauseReason` plumbing and the stage design); backed by failing probes. | `buildBody` `handoff-snapshot.ts:537` `singleLine(pauseReasonText(input))` uses the default 500-character cap, and no stage shortens it. `fullFixedFields` (`:340`, `:434`, `:598`) shortens only the source, spec, notes-absent and next-action fields. Adapter `:1142-1143` passes the paused stop reason as `pauseReason`. | **P3** (real adapter, with a projection shaped like the reducer's `repair.issue_paused` at `scheduler-store.ts:4062` and the external-blocker detail at `build-runtime.ts:3200-3201`): a run paused on external blocker `issue-00`; 14 external blockers, each with a 490-character owner action and a 490-character acceptance condition (the last owner action is 205 characters); final verification build passed, tests **failed** (142 run, 3 failed). **P1 scan**: 59 of 1,584 such inputs fail (ASCII and CJK, 3-15 blockers). **F1 fuzz**: 3 of 600 random paused inputs fail (all CJK). Example: seed 1177 hides FV 0/2. The never-truncated set with every other part at its minimum is 16,577 B with the 500-character pause line and 15,794 B with a 120-character one. | Module doc `:68-70` and `:664-668`, `SHRINK_STAGES` doc `:351-353`, `C1.md` cycle 3: FV lines and blockers shrink "only when the never-truncated block alone, with every other part at its minimum, exceeds the cap". The contract does not list the pause reason as never truncated. On a paused stop it copies the header's stop reason, which is never truncated, so shortening it loses nothing. | **P3**: 47 lines / 16,290 B. The Verification section is `- final verification build: passed …` then `1 more — see AIBoard run run-ext`. The **failed tests line is hidden.** The never-truncated block alone is 15,887 B, so it fits. The pause line is 516 B and holds the same text as the stop line. With only the pause line cut to 120 characters, the output is 16,286 B with FV **2/2** and owner actions 14/14. |

Fix guidance (non-binding). Render the pause line with the fixed-field cap:
`singleLine(pauseReasonText(input), fixedCap)`. Another option: on a paused stop, whose pause reason equals the stop
reason, print a short reference to the stop line. Regression test: the P3 input (build it by hand or through the
adapter). Assert both FV lines, including `- final verification tests: failed; counts: 142 run, 3 failed`, 14/14
owner-action lines, and the cap. Prove red by restoring the 500-character pause line. The refill pass suggested under
m7 would also fix the related minors m6-m7 in the same area.

## Resolution table

| Item | Resolved | Evidence |
|---|---|---|
| R3-B1 never-truncated lines dropped while they alone fit | **Partial** → R4-B1 | Every named input passes now. C3: 60 lines / 16,278 B, 4/4 blockers, 2/2 FV, 20 note lines plus the marker. B10/B12/B13/B14: all shown (13/13 and 14/14 at 14,607 B and 15,642 B). B4/B5-CJK: 4/4 and 5/5. C2: 2/2 blockers and FV 1/1, or 2/2 in the r3b detail. I rebuilt the controller's prove-red on a scratch mutant (notes and fixed fields moved after FV and blockers). C3 falls to 3/4 blockers and FV 0, and B13 falls to 12/13. This matches `C1.md`. The general rule still fails through the pause line (R4-B1). |
| m1 TAB in cells | **Yes** | `neutralizeSnapshotCell` `:263`. Row `\| REQ TAB \| a b \| open \|`; the helper gives `a b`. The A1 sweep also flags any TAB in the output, and it found none. |
| m2 plan steps cut silently | **Yes** (new minor m6) | Probe D1: 3/3 tasks, the phase kept, `steps: 24 more …` and `criteria: 4 more …` on each task, 149 lines / 16,374 B. Phases, tasks and steps are separate stages. |
| m3 decisions early / not in halves | **Yes** | Probe E1: 5/5 decisions plus the `150 accepted-task boundaries` line, 41 lines / 1,224 B. Probe E2: 120/120 requirements. |
| m4 silent last-resort cut | **Yes** | I called `hardCap` directly through the scratch copy on a 300-line over-cap body. It returns 127 lines / 16,303 B; the digest verifies; the last line is `snapshot cut at the size cap — see AIBoard run run-h`. The cut is unreachable through the public API. Probe H2 fills every field at its cap with 3-byte characters and sets every stage to 0; the output is 45 lines / 11,202 B. Probe H (r3) no longer reaches the cut: 50 lines / 16,201 B. |
| m5 forged pause line | **Yes** (new minor m9) | G1: `pause reason: none`. The pause line comes only from `pauseReason` (`:638-646`). Sweep PR1 plants markers, controls and forged headings in `pauseReason` for 3 stop kinds: 1,065 renders, 0 failures. |

## Fix-delta check (both directions)

- **The cap always holds.** The staged search keeps a budget only after rendering it and seeing that it fits
  (`low` starts at the verified 0 and moves only to a `mid` that fit, `:683-691`). So a stage that is not monotone can
  make the result too small but never over the cap. `hardCap` is the backstop. No probe went over 200 lines or
  16,384 B: M2 fuzz 400, F1 fuzz 600, P1 scan 1,584, A1 sweep 2,156, the r2 and r3 re-runs, and PERF.
- **Monotonicity, stage by stage.** Over the search range `[0, full-1]`, the list stages (decisions, exhausted,
  requirements, tasks, findings, boundaries, plan tasks and phases, FV, blockers) always print their N-more line, so size
  grows with the budget. `notesLines` always prints its marker in range. `acceptedBoundaries` and `fullFixedFields`
  are 0/1 stages, where only 0 is searched. **`planSteps` is not monotone in bytes.** When the budget reaches a task's
  step count, that task's `steps: N more …` line goes away, and it can be longer than the step it is traded for. Probe
  M1b finds fit results T F T F for k = 0..3. The search tries k = 1, sees it fail, and keeps 0, but k = 2 fits: 0 of
  62 step lines are shown (m6). In M2, brute force agreed with the search on every other stage for all 400 fuzz inputs.
- **No refill.** Once a later stage fits, the earlier (lower-value) stages stay at 0, even when room is left (m7).
  Probe B2: 5 CJK blockers. The protected set alone is over the cap, so truncation is allowed. FV goes to 0, then the
  blockers search keeps 4/5 at 14,573 B. Both FV lines, including the failed tests line, would fit (14,798 B), but
  they stay hidden. Notes: 14 ASCII blockers give 15,248 B with 0/30 note lines, while about 1.1 KB (about 16 note
  lines) is free.
- **Determinism.** The same input gives the same bytes (M2, P8). When FV lines or unaccepted boundaries must truncate,
  the renderer takes the first k in input order and sorts after slicing (`:548-549`). So which FV line survives
  depends on input order, not on its outcome (m8).
- **B1-B7 truthfulness still holds.** I re-ran `c1-probe-r2.mts` and `c1-probe-r2b.mts` unchanged on a real SQLite
  store. Results: the handoff stop is `plan_only — handoff requested`; the stacked pause is kept (N7); a selected
  handoff sets the next action (N9, D2); `answered_export` appears only after `request.answered` (N6a); revision_2
  requirements with REQ-CONDITIONAL `not_applicable (… (authorized by owner))` (B); a superseded acceptance leaves
  `open` (C3); cancelled tasks are gone and `repair-1 … [planned]` is listed (C4); boundary tests counts sit only next
  to `npm test` (C2); failed, running and stopped runs are reported truthfully (C5a-d); verifier-selection pause (N8);
  red and green not_applicable plus pending FV lines (C1/N10). More items are kept than before: N2 now shows 96/260
  boundary lines (was 65/260), and P5 shows 36/60 findings.
- **Marker safety still holds.** A1: 2,156 renders and helper calls, 0 failures, including the control-character
  check. PR1 covers the new `pauseReason` field (see m5).
- **Performance.** 5,000 items in every list, plus 300 blockers and 2,000 plan tasks: 373 ms, 108 lines / 16,205 B.

## `pauseReason` field and adapter, per stop kind (question 4)

| Stop (real SQLite store unless marked) | Pause line | Correct? |
|---|---|---|
| Plan-only handoff requested (R1) | `none` | Yes |
| Plus `run.paused(context_recording_failed)` (R2 / n6) | `context_recording_failed`; the stop line also carries it | Yes |
| Build run, `run.paused(reason, taskId)` (R3) | the reason, the same as the stop line; next action `resume the run (…)` | Yes (but see R4-B1: it is an unshrinkable copy) |
| `run.paused` with no reason (R5) | `not recorded` | Yes |
| Resumed / running (R4, R3a) | `none`; `in_progress` | Yes |
| Failed / stopped with a stale `pauseReason` (hand-built, R8) | `none` | Yes (the stop is terminal) |
| Paused on an external blocker (hand-built through the adapter, P3) | the full `repair_issue_paused:… — repair:external_blocker:…` text at 500 characters | Content correct; size is R4-B1 |
| Answered run, then `run.paused(context_recording_failed)` (R7) | **`none`**, with stop `answered_export` and next `nothing to do`, while the projection is paused with that reason | No: m9 (minor) |

## New findings (minor)

| # | Where | Finding |
|---|---|---|
| m6 | `planSteps` stage; `buildBody` `:617-624` | Not monotone in bytes (see the fix-delta check). M1b: 30 plan tasks with 2 one-character steps, plus 1 task with 3 steps of 500 characters. The output is 133 lines / 15,748 B with 0 step lines, where 62 would fit. The module doc (`:66-67`, "Each stage keeps as many items as still fit") is false here. Fix: for this stage, scan down from the top instead of binary searching (there are at most as many values as the longest step list), or refill (m7). |
| m7 | `renderHandoffSnapshot` `:675-693` | No refill: once a stage fits, lower stages stay at 0 even with room left. B2 hides a failed FV line with about 1.8 KB free, and the notes lose about 16 lines. Fix: after the stopping stage, walk back through the earlier stages from highest value to lowest and take items while they fit (FV first). |
| m8 | `:548-549`, `:567` | When FV lines must truncate, the first k in input order are kept. Probe D1: the order [build passed, tests failed] keeps the passed line and hides the failed one; the reverse order keeps the failed one. Prefer failed or unknown lines when truncating, and slice after sorting. |
| m9 | adapter `:1142-1144`; stop-kind order `:914-924` | An answered run with a recorded pause shows `pause reason: none` and `nothing to do` (R7). It is low impact: CD-9 and AR-R08 skip snapshots for answered runs, so only exports and views see it. It belongs with n5 (C2 note). The cheap fix is to set `pauseReason` from `recordedPause` for any stop that is not failed or cancelled. |
| m10 | module doc `:68-70`, `:351-353`, `:664-668`; `C1.md` cycle 3, row R3-B1 | The rule is stated as met in all of these places, but it is false because of R4-B1. The rest of the cycle-3 evidence is accurate: the probe numbers match my re-runs, the prove-red replicates, there are 46 `test(` blocks, and the hashes match. |

## Probes run

Scripts are in the reviewer scratchpad (outside the repo):
`C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\`.
They are the r2/r3 scripts re-run unchanged, plus `r4\c1-probe-r4.mts`, `r4b`, `r4c`, `r4d`, `r4e` and `r4f`.
`r4\hs-copy.ts` is a byte copy of the module in which only `export` was added to its internals; probe S0 checks that it
renders identically. `r4\hs-mut.ts` is the prove-red mutant. Run each with `node .\node_modules\tsx\dist\cli.mjs <script>`
from the worktree root, with NODE_TEST_CONTEXT cleared. The real-store probes use a temporary SQLite store that is
removed in `finally`. I did not re-run the worker suite: none of my conclusions depends on its green claim, and the
probes import the module at the reviewed hash.

| Probe | Input | Result |
|---|---|---|
| r3 re-run A1 | marker sweep: 77 code points × 7 shapes × every field | 2,156 checks, 0 failures: OK |
| r3 re-run B10-B14, B4/B5-CJK | long blockers plus a 2k note | all owner-action lines shown: OK |
| r3 re-run C3 / C2 / D1 / E1 / E2 / F1 / G1 / H / TAB | round-3 named inputs | all fixed (see the resolution table); F1: 200 lines, 163/260 blockers, FV 0/2, exact counts |
| r2 re-run (real store) | B1-B7, N1-N10, P1-P8, D1-D2 | all OK (see the fix-delta check) |
| S0 | scratch copy vs the real module | identical |
| **P1** | 1,584 adapter-derived external-blocker pauses | **DEFECT**: 59 drop an FV line or owner action that fits once the pause line is cut to 120 characters (R4-B1) |
| **P3** | 14 ASCII blockers, 490+490 characters (last 205) | **DEFECT**: FV 1/2 with the failed tests line hidden, 16,290 B; with a 120-character pause line, FV 2/2 at 16,286 B (R4-B1) |
| P3 CJK | 5 CJK blockers | the protected set alone is over the cap: 4/5 and FV 0/2 even with a short pause line (allowed; see m7) |
| **F1** | 600 random paused inputs with long fields | **FINDING**: 147 protected drops; 3 are caused only by the pause line (R4-B1) |
| M1b | planSteps T F T F case | search keeps 0 steps; 2 fit (m6) |
| M2 | 400 random inputs; brute-force the stopping stage | 0 failures in pick, cap, digest, determinism and counts; stages seen: all except `fullFixedFields`/FV/blockers (those are covered by P1/F1/B2) |
| B2 | 5 CJK blockers, FV not refilled | FV 0/2 at 14,573 B; 2/2 fit at 14,798 B (m7) |
| r4e | 14 ASCII blockers + long fixed fields + 30-line note | 0/30 note lines at 15,248 B; about 1.1 KB free (m7) |
| D1 | FV order permutation under truncation | keeps the passed line or the failed line depending on input order (m8) |
| R1-R8 | pause line per stop kind (real store and hand-built) | see the table above; R7 is m9 |
| PR (prove-red) | C3 and B13 test inputs on the stage-order mutant | 3/4 and 12/13 (matches `C1.md`) |
| PR1 | markers, controls and forged headings in `pauseReason` | 1,065 renders, 0 failures |
| H1 / H2 | `hardCap` direct; floor with every stage at 0 | marker line, fits, digest OK; floor 11,202 B, so the cut is unreachable |
| PERF | 5,000 of every list | 373 ms |
