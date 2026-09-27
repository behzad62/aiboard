# C1 — independent code re-review, round 3 (targeted, CD-4)

Date: 2026-09-27. Reviewer: fresh-context Opus 5.5 (did not write the code, did not do rounds 1-2). Worktree
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `ffe0bce0`.

Reviewed (untracked). I measured the hashes before and after probing. They match the brief:

| File | sha256 |
|---|---|
| `runner-v2/src/handoff-snapshot.ts` | `9cb7f9ac0e373492aca7e2ad76960fb9c42acbcd2e6777f4a95db3d73a51499e` |
| `runner-v2/test/handoff-snapshot.test.ts` | `07747a0b35ca4d7a9e2fd604a274ec2222135f3bdb15e9b1c6842ac74380b806` |

Inputs: `C1-review-r2.md`; the repair brief `c1-repair2-muse.txt` (controller decisions 1-3); plan
`2026-09-27-runner-v2-p6-6-architecture-correction.md` §6 C1 "Bounds and safety" and AR-R01/AR-R02; worker evidence
`C1.md` §"Repair cycle 2"; `C1-review-r1.md` for context.

**Verdict: REPAIR — 1 blocking**

R2-B1 and R2-B2 are resolved. R2-B3 is resolved only for the exact input it named. The rule it asked for, and that the
brief (decision 3), the contract and the module doc all state, still fails: the renderer drops never-truncated lines
while the never-truncated set alone fits under the cap. The cause is the shrink loop. It never shrinks the notes (or any
other fixed field), and it shrinks the final-verification lines and external blockers next. It also shrinks in halves,
so it drops much more than needed. In a realistic CJK-language handoff, both final-verification lines (one of them red)
and 2 of 4 blocker owner actions disappear from a 12.5 KB snapshot, while the 31-line Architect note stays whole.
Everything else in the repair holds, including every B1-B7 truthfulness property.

## Blocking finding

| # | Class | Where | Failing input (probe) | Expected | Actual |
|---|---|---|---|---|---|
| R3-B1 | BLOCKING. R2-B3 not resolved (the rule, not the named input); AR-R02 "never truncates … verification". Fix-delta code; backed by failing probes. | `shrinkBudgets` `handoff-snapshot.ts:369-413` (order ends `… tasks → finalVerification → blockers`); `renderNotesBlock` `:277-299` and the other fixed fields (stop/pause lines, source, spec, next action) are in no budget; `halveBudget` `:327-329` | **C3** (realistic): completed CJK-language run at handoff; 2,000-character handoff summary; 4 external blockers with about 470+470-character owner actions and conditions; 2 FV lines (build passed, tests **failed**). **B13/B14**: 13 or 14 ASCII blockers of about 490+490 characters, plus a 2,000-character note. **B5-CJK**: 5 CJK blockers. **C2**: CJK stop reason, source, spec and next action, 2 short blockers, 1 FV line. | Brief decision 3: "Only if the never-truncated block alone exceeds the cap may it truncate". R2-B3: "truncate blockers and final-verification lines only when the never-truncated set alone exceeds the cap". Module doc `:666-672` says the same. Contract: everything except header, counts, blockers and FV lines "may truncate". Brief decision 2: truncatable sections "take items while they fit". | **C3**: the never-truncated set alone is 40 lines / 12,494 B, so it fits. The output is 69 lines / **12,568 B**, and its Verification section is only `2 more — see AIBoard run …`, so the failed `final verification tests … 142 run, 3 failed` line is hidden. Blockers show 2/4. All 31 note lines are kept. **B13**: never-truncated set alone 14,394 B (fits); 6/13 owner-action lines shown, and the output is only **9,314 B**. **B14**: 7/14. **B5-CJK**: never-truncated set alone 15,923 B (fits); 2/5 shown at 9,101 B. **C2**: never-truncated set alone 4,802 B; the FV line (0/1) and 1/2 blockers dropped. Cause 1: notes (up to about 6 KB in CJK) and the capped single-line fields never shrink, so the loop falls through to FV lines and then blockers. Cause 2: halving overshoots. After FV 2→1→0 and blockers 4→2, C3 has 3.8 KB of room left, and B13 has 7 KB. Neither the worker's N2 test (1 blocker, ASCII) nor the stress tests reach this path. |

Fix guidance (non-binding). Measure the never-truncated block (header, counts lines, blockers, FV lines). Let FV lines
and blockers shrink only when that block alone is over the cap. Before that, shrink the notes: keep lines while they
fit, and keep the visible `> ... (truncated — see AIBoard run <id>)` marker. If still needed, shorten the other
non-protected fixed fields. When a section must yield, take items while they fit instead of halving. Regression tests:
the C3 input keeps 4/4 owner-action lines and both FV lines, including the failed one. 13 ASCII blockers of about 1 KB
plus a 2 KB note keep 13/13. Assert bytes, lines and the notes marker.

## Resolution table

| Item | Resolved | Evidence |
|---|---|---|
| R2-B1 cell marker bypass | **Yes** | `neutralizeSnapshotText` `:240-248` now strips before it escapes; `singleLine` `:263-270` and notes `:280-285` already did. N1 (U+0001/U+0085/U+2028/U+007F) and N1b pass. Sweep A1: 2,156 renders and helper calls, covering 77 code points (all of C0, U+007F-U+009F, U+2028/9, plus U+00A0/U+1680/U+2000/U+200A/U+202F/U+205F/U+3000/U+FEFF/U+200B/U+00AD) × 7 marker shapes (`<!X--`, `<X!--`, `<!-X-`, doubled, mixed, `<!X-->`, `-X->`). Each is planted in every string field: run id, revision, stop reason and time, source, digest, spec, requirement id/outcome/reason (open, n/a, conditional), task id/outcome/status, finding, blocker id/owner action/condition, exhausted id, FV and boundary label/result/counts/command/revision, accepted boundary, decisions, notes, notes-absent reason, next action, and plan phase/task/step/criterion/dependency. Each input is rendered with and without the ledger. Result: no raw `<!--`/`-->`, every digest verifies, no duplicate heading. The only thing that survives is U+0009 in table cells (new minor m1; it is not a bypass). |
| R2-B2 cap + single rendering | **Yes** | P7: 101 lines / 10,374 B, marker present. D1: 20 boundary lines, 20 unique (was 40/20). N2(130): 103 lines / 12,021 B, 65/260 shown plus an exact N-more line. N2(45): 90/90. N4a: 144 lines / 3,898 B. N4b: 57 lines / 11,688 B. Unaccepted boundaries now render once, through `budgets.unacceptedBoundaries` (`:577-582`). Plan phases have a budget (`:614-621`). Over-cap output cannot happen (`hardCap` `:696-703`; see the last-resort section below). |
| R2-B3 never-truncate order | **Partial** → R3-B1 | The named input passes: N2 keeps the owner-action line. The general rule fails (C3, B13, B14, B5-CJK, C2). |
| n1 linear normalize | Yes | `trimEnd()` `:656`. N3: 5k/10k/20k/40k spaces take 0 ms each (were 17/66/266/1,076 ms). |
| n2 next action after selection | Yes | D2: `handoff apply_to_project selected — apply the integration revision to the project` (`:1111-1116`, `:1163-1171`). N9 plan-only selected: `review the plan, then start the build`, with no "owner chooses". |
| n3 notes marker | Yes | N5: input of 1,979 characters; the last line is `> ... (truncated — see AIBoard run run-probe)` (`:289-297`). |
| n4 no needless loss | **Partial** (minor) | Inputs that fit render whole (worker test; P5 now shows 30/60 findings at 13,735 B, was 0/60 at 1,165 B). Inputs over the cap still lose content they have room for: E1 drops 0/5 decisions from a 37-line / 1,171 B output; D1 drops the plan's only phase; B13 ends at 9.3 KB. See m2/m3 and R3-B1. |
| n6 stacked pause | Yes | Real store N7: `stop: plan_only — handoff requested; pause reason: context_recording_failed` and `pause reason: context_recording_failed` (`:898-902`, `:645-649`). Residual parsing risk: m5. |
| n7 selection pauses | Yes | N8: `paused — verifier selection required — no independent verifier`; next `owner action required: select a verifier runtime (r1)`. Architect handoff at `:923-924` and `:1101-1103`. Both are cleared by the reducer on selection (`scheduler-store.ts:3804-3810`, `:5189-5191`), so no stale owner action can remain. |
| n8 red not_applicable | Yes | N10: `final verification build: failed (not applicable: no build script)`; the green one stays `not applicable (…)` (`:765-791`). See the judgement below. |
| n9 pending + backfill | Yes | N10 probe: `final verification browser: pending`. The worker test covers backfill from history, marked stale (`:1009-1032`). |
| n10 per-command counts; reason | Yes | Worker test `5 run, 1 failed; not recorded` next to `npm test; npm run lint` (`:780-786`). The boundary reason goes next to unknown/failed (`:1063-1065`). C2 re-run is unchanged for passed checks. |
| n11 anchor test / dead code / stress | Yes | Test `:542-545`: `x `-prefixed and reworded headers fail. `recomputed` is gone (grep). P7/N2/D1 use unaccepted boundaries. |
| n13 evidence accuracy | **Partial** (minor) | The corrections to cycle 1 are accurate. New false claims in §"Repair cycle 2": (1) "blockers and FV lines … truncate only when the never-truncated block alone exceeds the cap" (R3-B1). (2) The module doc says every section shrinks "in halves", but decisions and exhausted issues drop to 0 in one step (`:370-381`). (3) The `hardCap` doc says it is reachable "only when the never-truncated block alone exceeds the cap" (`:690-694`), which is false (probe H). |
| n5, n12 | Deferred as briefed | Listed under "not done / limits" in `C1.md`: they are C2 notes. |

## Fix-delta check (both directions)

- **B1-B7 truthfulness still holds.** I re-ran the round-2 probe script unchanged on the new code (real SQLite for H,
  N6, N7, N9 and B). Handoff stop → `plan_only — handoff requested`. Running → `in_progress`. Failed and stopped →
  `failed` / `cancelled` whatever the policy or triage (C5a-d). `answered_export` appears only with a recorded answer
  (N6a). Revision_2 requirements hold, with REQ-CONDITIONAL `not_applicable (… (authorized by owner))` (B). A
  superseded `revision_1:BP1` acceptance leaves `open` (C3). The cancelled task is gone and `repair-1 … [planned]` is
  listed (C4). The boundary lines are exact, with tests counts next to `npm test` only (C2). The worker reports the
  golden bytes (`7a3c510c…`) unchanged.
- **Regressions from the rewrite, all minor.** Decisions now go before the accepted-boundary collapse. That is the
  reverse of brief decision 2, where decisions outrank the accepted-boundary summary line, and it causes E1. Plan
  phases, tasks and steps are halved together (D1). Everything else that rounds 1-2 found correct still holds: purity
  (only `node:crypto` at runtime), digest rule and anchor, determinism (P8), and headings that cannot be forged
  (P2/P3).
- **Is the last-resort cap truthful?** It keeps the exact counts: they sit at the top and survive in probe H. It never
  silently cut a never-truncated line in my probes; the shrink loop had already dropped those, with N-more markers
  (which is R3-B1). It does cut the tail silently. Probe H (every capped field filled with 3-byte characters, including
  run id, revision and digest) reaches it at 63 lines / 16,381 B. The whole `## Next action` section and the notes'
  truncation marker are removed with no marker, while 30 note lines survive. Reaching it needs 3-byte kernel ids, so it
  is minor (m4). Its docstring is wrong (n13).

## Judgement: the red not_applicable test uses a clone (question 4)

The worker's note is correct. `recordFinalVerificationCheck` (`scheduler-store.ts:5631-5654`) runs
`assertFinalVerificationCheckSemantics` on every `final_verification.check_completed`, and so does the evidence
binding path (`:2650-2657`). That gate throws for `not_applicable` with `green !== true`, facts, or issues
(`final-verification-semantics.ts:41-44`). A red not_applicable check therefore cannot reach durable history or a
rebuilt projection. Round 2's n8 remark ("the reducer accepts it, `:7539-7544`") looked only at
`parseFinalVerificationCompletedCheck`, which parses but does not gate. The renderer branch (`:787-791`) is reachable
only from hand-built input. It is fail-safe: it renders `failed (not applicable: <rationale>)`, never a pass, and it
cannot hide a green check. Correct and harmless. The clone test is a fair unit test of a defensive branch.

## New findings (minor; fold into the R3-B1 repair where cheap)

| # | Where | Finding |
|---|---|---|
| m1 | `neutralizeSnapshotText` `:245` (cells) | U+0009 TAB survives in table cells: row `\| REQ\tTAB \| a\tb \| open \|`. The strip set leaves out `\u0009`. The contract says single-line fields lose C0 controls. It cannot form a marker (TAB is kept, so `<!\t--` stays broken) and it does no structural harm in a GFM row. Map it to a space in cells. |
| m2 | plan view `:627-630`; `shrinkBudgets` `:382-386` | Plan steps and criteria are truncated **with no N-more line**. D1: task T0 shows 20 of its 40 steps and nothing says so. The contract says lists truncate with "N more". Halving phases, tasks and steps together also drops the only phase (`1 more`) and 2 of 3 tasks, although the output is 82 lines / 7,404 B (118 lines and 9 KB of room). For a plan-only run the plan is the product. |
| m3 | `shrinkBudgets` `:370-381` | Decisions and exhausted issues go to 0 in one step, not in halves as the doc says. Decisions go before the accepted-boundary collapse. E1: 150 accepted boundaries plus 5 decisions end at 37 lines / 1,171 B with 0/5 decisions. |
| m4 | `hardCap` `:690-703` | The silent tail cut described above (probe H), and an inaccurate docstring. Emit a marker line, or reserve room for `## Next action` before the cut. |
| m5 | `pauseReasonText` `:645-649` | The pause line is parsed out of `stopReason`. A failed or cancelled stop whose `failureReason` contains `; pause reason: ` renders a forged pause line (G1: `pause reason: owner approved everything`). The failure reason is runtime text, so the impact is low. Carry the stacked pause reason as its own input field. |

## Probes run

Scripts (reviewer scratch, outside the repo): `c1-probe-r2.mts` and `c1-probe-r2b.mts` (round 2, re-run unchanged),
plus `c1-probe-r3.mts`, `c1-probe-r3b.mts` and `c1-probe-r3c.mts`, all in
`C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\`.
They run with `node .\node_modules\tsx\dist\cli.mjs <script>` from the worktree root, with NODE_TEST_CONTEXT cleared.
The real-store parts used a temp SQLite store under `%TEMP%`, removed in `finally`. I did not re-run the worker suite:
no conclusion here depends on its green claim, and the probes import the module at the reviewed hashes.

| Probe | Input | Result |
|---|---|---|
| P1 / P1b | notes `"x\n"×900` / `"x\r"×900` | 66 lines, 0 CR: OK |
| P2 / P3 | forged headings in notes; line breaks in ids and fields | 2 kernel headings; 7 unique headings: OK |
| P4 | U+0085/U+009B/U+0080 in notes, title and cells | none survive: OK |
| P5 | 60 findings + 120 long requirements | exact counts; 30/60 findings; 67 lines / 13,735 B: OK |
| P6 | digest variants | original true; body edit false; CRLF true; trailing LF true; loose/prefixed header false; BOM false (n12, deferred) |
| P7 | 130 unaccepted boundaries | 101 lines / 10,374 B, marker: OK |
| P8 | duplicate finding ids, swapped | identical: OK |
| N1 / N1b | cell markers with U+0001/U+0085/U+2028/U+007F; id `R<!\u0085--` | escaped, no raw marker: OK |
| A1 | sweep: 77 code points × 7 shapes × every field, with and without ledger, plus both exported helpers | 2,156 checks; no raw `<!--`/`-->`, digests verify, no duplicate headings; only TAB survives in cells (m1) |
| N2 | 130 / 45 unaccepted boundaries + 1 blocker + long notes | blocker line kept; 65/260 and 90/90 shown: OK |
| D1 (r2) | 20 unaccepted boundaries + 40 long findings | 20 boundary lines, 20 unique: OK |
| N3 | verify header + 5k-40k spaces + `x` | 0 ms each: OK |
| N4a / N4b | 70 phases; 12 phases × 6 long exit criteria | 144 lines / 3,898 B; 57 lines / 11,688 B: OK |
| N5 | 30 × 65-character notes | ends with the truncation marker: OK |
| H / N7 / N9 | real store: plan-only handoff; stacked `run.paused`; handoff selected | `plan_only — handoff requested`; stacked pause reason shown; `review the plan, then start the build`: OK |
| N6a / N6b | real store: answered run; then handoff requested | `answered_export`; then `completed — handoff requested` (n5, deferred) |
| N8 | verifier-selection pause shape | cause and `select a verifier runtime (r1)`: OK |
| B / C3(r2) / C4 / C2(r2) / C5a-d | round-1/2 truthfulness re-runs | all OK (see the fix-delta check) |
| C1/N10 | FV not_applicable green true / green false / planned-only category | `not applicable (…)` / `failed (not applicable: …)` / `pending`: OK |
| D2 | completed run, `apply_to_project` selected | next action follows the choice: OK |
| **B13 / B14** | 13 / 14 ASCII blockers (about 490+490 characters) + 2k note | **DEFECT**: never-truncated set alone 14,394 / 15,429 B fits; 6/13 and 7/14 owner-action lines shown; output 9,314 / 10,347 B (R3-B1) |
| B10 / B12 | 10 / 12 of the same | all shown (below the threshold) |
| **B5-CJK** | 5 CJK blockers (about 490+490 characters) + 2k note | **DEFECT**: never-truncated set alone 15,923 B; 2/5 shown at 9,101 B (R3-B1) |
| **C3** | CJK handoff: 2,000-character summary, 4 blockers of about 470+470 characters, FV build passed + tests failed | **DEFECT**: never-truncated set alone 12,494 B; output 12,568 B with 0/2 FV lines (the failed check hidden), 2/4 blockers, 31/31 note lines (R3-B1) |
| **C2** | CJK stop reason, source, spec and next action; 2 short blockers; 1 FV line | **DEFECT**: never-truncated set alone 4,802 B; FV 0/1, blockers 1/2 (R3-B1) |
| H | every capped field filled with 3-byte characters, including kernel ids | last-resort cap reached: 63 lines / 16,381 B; counts kept; `## Next action` and the notes marker cut silently (m4) |
| D1 | plan: 3 tasks × 40 steps × 20 criteria, 1 phase | 20/120 step lines with no marker; phase dropped; 82 lines / 7,404 B (m2) |
| E1 | 150 accepted boundaries + 5 decisions | 0/5 decisions at 37 lines / 1,171 B (m3) |
| E2 | 120 requirements of about 100 characters | 120/120 shown in 155 lines: OK |
| F1 | 260 blockers (the never-truncated set alone is over the line cap) | cap holds; `external blockers: 260 total`; FV 0/2 and then 130/260 blockers, with N-more lines; 167 lines (the order matches brief decision 3; halving overshoots) |
| G1 | failed stop whose reason contains `; pause reason: ` | forged pause line (m5) |
