# C1 — independent code re-review, round 6 (targeted, CD-4)

Date: 2026-09-27. Reviewer: fresh-context Opus 5.5. I did not write this code and did not do rounds 1-5. Worktree
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `ffe0bce0`.

Reviewed (untracked). I measured the hashes before and after probing. They match the brief:

| File | sha256 |
|---|---|
| `runner-v2/src/handoff-snapshot.ts` | `1247f60936c4227cd5413afb476192c07c6329c0f64ec9965eadb5aef486be11` |
| `runner-v2/test/handoff-snapshot.test.ts` | `1e1d1b5d978d141f38628ded5a8952f770a547e8c1e7a45d700143fb0fe2a7ac` |

Inputs: `C1-review-r5.md` (R5-B1, m10-m13), `C1.md` §"Repair cycle 5 (controller)", and the r5 probes. The fix delta
against the r5-reviewed copy (`r5\hs5.ts`) is limited to `renderHandoffSnapshot`, `raiseBudget` (was
`largestFittingBudget`), the new `capLoad`, `PROTECTED_STAGES`, `TRUNCATABLE_STAGES` and `FILL_STAGES`, plus doc text.
`buildBody` and the adapter are byte-identical. So B1-B7 truthfulness cannot move, and the r5 oracles, which render
through the copy's `buildBody`, remain valid.

**Verdict: REPAIR — 2 blocking**

R5-B1 is resolved. Every r5 scan that failed now passes on the real module: X1 shows FV 2/2 at 16,342 B, the X7 and
Y scans show 0 violations, and the Z fuzz shows 0. Step 3 is sound: the fill never lowers a protected budget and never
leaves the output over the cap. The cap, determinism, input-order invariance, the digest, marker safety and
truthfulness all hold. Fill maximality (r5 G2) is now clean, and m11 is fixed.

The construction is still not "by construction", though. Step 1's "smallest rendering" of a part is not the smallest
in two cases:
- **R6-B1.** Step 1 compares `capLoad`, the larger of the line share and the byte share. While lines dominate, a
  one-line part ties with its one-line marker. The part is then kept whole even when it is hundreds of bytes larger.
- **R6-B2.** Without a requirement ledger, the `tasks` budget drives two lists, so that part's minimum lies strictly
  between 0 and whole.

Later steps cut the many short lines, which leaves the output byte-bound. Because the fill only raises budgets, step 2
then drops final-verification lines that fit. Both holes are backed by failing probes on the real module, including
adapter-derived inputs with the production run-id shape. N1 hides both FV lines, including `tests: failed`, while it
shows a 494-character decision.

## Question 1: does the construction make the rule hold in general?

Step by step, from the code (`handoff-snapshot.ts:697-733`):

- **Step 1** (`:704-709`). It is correct only in one dimension and only when each budget drives one monotone list.
  - For a single list, size grows with the budget on `[0, full-1]`, because the N-more line is present throughout. At
    `full` the marker disappears. So the minimum is either 0 or `full`, and comparing those two values is right, in
    one dimension.
  - Two things break it. (a) The comparison uses `capLoad` = max(line share, byte share) of the whole output, at a
    point where every later stage is still at full size. When lines dominate at that moment, a part whose whole
    rendering and marker are each one line (a 1-item list, a single accepted boundary, one decision or one finding)
    gets equal loads, and `whole <= zero` keeps the whole part. That holds even when it is 400-1,300 B larger. The
    later truncatable stages then remove the short lines, and the final output is bound by bytes. Nothing ever lowers
    that part again. This is **R6-B1**.
  - (b) With no ledger, `budgets.tasks` slices both the no-ledger task list and the open-work list (`:487`, `:506`).
    At k = (number of unaccepted tasks), the open-work list is whole, so its marker is gone, while the task list still
    shows k items and its marker. Size then has an interior minimum that neither 0 nor `full` reaches. This is
    **R6-B2**.
  - `planSteps` also has interior minima. They cannot matter, though: whenever one would, the plan-task section holds
    a marker line and is larger than the `planTasks` marker, so `planTasks` goes to 0. No probe found a case.
- **Step 2** (`:711-721`). It is correct given its base, but its base is step 1's configuration. So the protected
  budgets are decided against a configuration that can be larger than the true minimum.
- **Step 3** (`:723-731`). It is sound for the cap. `raiseBudget` only ever keeps a value that was rendered and fit
  (the start value fits; bisection keeps `low` fitting; the `planSteps` extra tries return only on a fit). Protected
  budgets only go up in step 3. So the fill can never lower a protected budget or leave the output over the cap. It
  cannot repair a step-1 part that was kept too large, because it never lowers a budget. When the room is freed by a
  raise, lower-value stages later in the same pass can take it before protected stages retry.

## Blocking findings

| # | Class | Where | Failing input (probe, REAL module) | Expected | Actual |
|---|---|---|---|---|---|
| R6-B1 | BLOCKING. Violates the AR-R02 rule, under both the literal oracle and the true-minimum oracle. This is fix-delta code (the `capLoad` comparison is new in cycle 5). | `renderHandoffSnapshot` `:704-709`: `whole <= capLoad(zero)`, where `capLoad` (`:736-738`) is the max of the two shares. The fill `:723-731` never lowers a budget. | **N1** (hand-built, production run id `native-<uuid>`, paused): 200 requirement rows (`R000`…, outcome `x`, open); `decisions: ["D1: " + 490×d]`; 20 blockers (`act<i> ` + 490×o, the last 225×o; `cond<i> ` + 200×o); FV build passed, tests failed (142 run, 3 failed). **N2** (real adapter, production run id): no planning (no ledger); 160 tasks with objective `Fix item <i>`; `T000` integrated and accepted, with one boundary check (`tests` passed, 12/12/0, `npm test -- --run src/feature.test.ts`); 14 external blockers (490-character owner actions and conditions, the last owner action 245); the paused external-blocker pause. **Families**: A1 (one accepted boundary) 18 of 2,772; A2 (one decision) 201 of 1,485, 78 of which hide the failed tests line; A3 (one finding) 237 of 1,485, 81 hiding it; A4 (adapter, as N2) 32 of 891, 6 hiding it. **E lines-heavy fuzz**: 8 of 600, 5 hiding it. | FV 2/2 and owner 20/20 (N1) or 14/14 (N2). Every other part at its smallest rendering (the literal all-0 configuration) fits: N1 is 56 L / 16,024 B and N2 is 49 L / 16,308 B. | **N1**: 61 L / 16,375 B, **FV 0/2**. The Verification section is only `2 more — see AIBoard run …`, so **`tests: failed` is hidden**, while `- D1: ddd…` (496 B, the lowest-value part) is shown. Trace: step 1 `decisions` compares whole 255 L / 20,377 B with zero 255 L / 19,951 B; both loads are 1.2750 (line share), so it keeps the whole part. Then `requirements` goes to 0, giving 56 L / 16,450 B, 66 B over. The 426 B the decision marker would save never come back. **N2**: 49 L / 16,324 B, FV 1/2 (the passed build line is hidden) while the accepted-task boundary line (171 B) is shown. The step-1 `acceptedBoundaries` tie is at load 1.8300 (366 lines). |
| R6-B2 | BLOCKING. Violates the rule under the true-minimum oracle (the r5 oracle that R5-B1 was accepted on). The literal all-0 configuration does not fit. | One budget drives two lists: `buildBody` `:487` (no-ledger task list) and `:506` (open-work list), both `slice(0, budgets.tasks)`. Step 1 compares only 0 against `full`; `raiseBudget` assumes one monotone list below the top (`:740-748`). | **N3** (hand-built, production run id): no ledger; tasks `T00`-`T03` (`x`, integrated, accepted) and `T04` (`x`, planned); 15 blockers (490/490, the last owner action 66); FV build passed, tests failed. **Families**: C1 22 of 2,214; **C2** (120-character id, CJK) 26 of 2,214, **FV 0/2 with the failed tests line hidden in all 26**; **C3** (real adapter, production id, terse objectives `Fix` / `Add x` / `Wire UI`) 30 of 2,214. | FV 2/2. At `tasks` budget 1, the task list is `T00` plus `4 more — …` and the open-work list is whole. The output is then smaller than both 0 (16,401 B) and whole (16,385 B), and fits with FV 2/2 (true-min oracle). | **N3**: 53 L / 16,323 B, FV 1/2 (the passed build line is hidden). Step 1 keeps `tasks` at 5 (16,385 B beats 16,401 B), 1 B over, so step 2 drops an FV line. |

Realism, stated plainly:
- **R6-B1** needs about 200-300 short lines on screen when step 1 reaches the tied part (the average line must be
  under about 82 B, so that lines dominate), plus a protected block within a few hundred bytes of 16 KiB. N2 reaches
  this through the real adapter, but only with 160 terse task objectives in a no-ledger run. That is unusual. The
  consequence is severe, though: a red FV line is hidden while a lower-value line is shown.
- **R6-B2** needs a no-ledger run whose task lines are shorter than the roughly 70 B marker (terse objectives), plus a
  protected block within about 40-100 B of the cap.

Both meet the brief's bar: each is a failing probe on the real module that violates the rule.

### Fix guidance

This is non-binding. I validated it only on scratch mutants in `r6\`, not in the module.

- (a) Give the no-ledger task list its own budget (mutant `taskList`, placed next to `requirements`). Then every
  budget drives one list whose minimum is at 0 or at whole.
- (b) Decide the protected budgets against true minimum configurations, not against step 1's greedy `capLoad` pick:
  - Build the **byte-minimal** configuration: each truncatable part at 0 or whole, whichever has fewer bytes, ties
    broken by lines.
  - Build the **line-minimal** configuration the same way, with lines first.
  - If protected-full fits with either configuration, keep FV and blockers full and fill from that base.
  - Only otherwise, shrink FV and then blockers, against whichever configuration has the smaller load.
  - The fill can then never cost a protected line, because protected lines are already at their final value before
    any fill.
- Mutant **M3** = (a) + (b), plus restarting the fill from the top after each change. It has 0 violations in every
  family and fuzz above: A1-A4, C1-C3, the I family, and 2,900 fuzz inputs from the r5 and r6 generators. Cap, digest,
  determinism and permutation failures are 0. With 5,000 of every list it takes 948 ms and 123 renders.
- Two cheaper fixes are **not sufficient**:
  - **M1** keeps the whole part only if it is no larger in both lines and bytes, and restarts the fill. It fixes A1-A4
    but not C1-C3.
  - **M2** = M1 + (a). It fixes A and C but fails probe I: 53 true-min violations. Two exhausted items are 15 B
    smaller than their marker but one line longer, so they start at 0. The note lines, which have higher value, fill
    the slack before the list is raised, and the 15 B freed afterwards cannot hold the FV line. The real module passes
    I, because there bytes dominate and `capLoad` picks the smaller rendering.
- Residual caveat for M3 (not seen in any probe): if both dimensions are near the cap, a mixed choice could fit when
  neither pure minimum does. Either document that, or also try the mixed choices for the parts whose two renderings
  trade lines for bytes.

### Regression tests

Prove each red against the current file:
1. N1: exact fields as above, with the other fields as in `r6\lib.mts` `base()`. Assert FV 2/2 (the failed tests line
   present), owner 20/20, and the cap.
2. N2 through `handoffSnapshotInputFromProjection`: the `externalBlockerPauseProjection` shape plus 160 tasks and one
   accepted task with a one-check boundary. Assert FV 2/2 and 14/14.
3. N3: no ledger, 5 tasks, 15 blockers, last owner action 66. Assert FV 2/2.

The doc claims under m14 must change with the fix.

## Resolution table

| Item | Resolved | Evidence |
|---|---|---|
| R5-B1: short-list markers; the stopping stage never retried | **Yes** (the rule still fails in general through R6-B1 and R6-B2) | Real module, r5 probes re-run. **X1** (`r5f`): FV 2/2, owner 14/14, 16,342 B. **X7** (`r5b`), all 8 run-id and exhausted variants: 0 violations, 0 FV 0/2, 0 hidden failed lines. **Y** (`r5c`), 4 variants including `native-<uuid>` and 120 characters: 0. **Z** (`r5g`), 1,700 inputs under the true-minimum oracle: 0. r6 **E** on the r5 generators (1,700 inputs): 0 literal and 0 true-min violations. The new test "never-truncate (R5-B1)" (`test:629`) covers the X1 shape. |
| m10: docs claimed the rule before it held | **Partial** → m14 | Step 3 is described correctly. "Holds by construction" (`:684`) and "every truncatable part is set to its smallest rendering" (`:685-687`) are false (R6-B1, R6-B2). Stale comments are listed under m14. |
| m11: `planSteps` quadratic scan | **Yes** | F probe: 8,000 steps take 26 ms and 47 renders; 50,000 steps take 173 ms and 53 renders (r5: 8,000 steps took 6.1 s and 7,851 renders). Test `test:658`. |
| m12: missing tests | **Mostly** | R5-B1 (`:629`), fill (`:639`) and `planSteps` (`:658`) are now tested. The m9 answered-run pause line is still covered by reviewer probe R7 only (stated in `C1.md`). |
| m13: answered run next action | **Deferred** (unchanged; C2 note with n5) | Adapter unchanged (byte-identical to r5). |
| r5 G2: fill maximality (minor side of R5-B1) | **Yes** | E, 2,900 inputs: 0 stages that could take more with the others fixed (r5: 66 under-fills), and 0 protected budgets that could take one more. |

## Question 2: regressions (fix-delta check)

- **Cap: 0 failures on the real module.** Coverage: E 2,900 inputs; D about 13,300 inputs; A 9,000; C 11,808; I
  15,712; the r5 scans (X7 27,552; Y 13,776; Z 1,700); PERF. In every probe the output fits whenever the fill runs, as
  the step-3 argument predicts.
- **Determinism and input-order invariance.** E renders each input twice, and once more with every list shuffled:
  0 nondeterministic results and 0 permutation mismatches across 2,900 inputs. The replica trace matches the real
  output in all 2,900 (0 replica mismatches).
- **Digest.** `verifyHandoffSnapshotDigest` holds on every rendered output in D and E. `hardCap` did not trigger in any
  fuzz input.
- **Marker safety.** A1 sweep (`c1-probe-r3`): 2,156 checks, 0 failures. PR1 (`r4f`): 1,065 renders, 0 failures.
- **B1-B7 truthfulness.** I re-ran `c1-probe-r2`, `r2b`, `r3`, `r3b` and `r3c` on the real module. Every status line
  is identical to the r5 run except for better fills:
  - N2: 97 of 260 boundary lines (was 96).
  - H: 71 L / 16,357 B (was 55 / 13,141).
  - r3c: 62 L, with 10 more note lines.

  There are no FINDING lines. The adapter code is byte-identical to the r5-reviewed file.
- **Run time.** Nothing to flag for realistic sizes.

  | Input | Time | Renders |
  |---|---|---|
  | Realistic large run (150 requirements, 120 tasks, 368 verification lines, 40 findings, 6 blockers, 30-line note) | 25 ms | 61 |
  | 500 of every list | 90 ms | 176 |
  | 5,000 of every list | 711 ms | 232 |
  | 20,000 of every list + 10,000 plan tasks (worst case found; unrealistic, linear in input size) | 2,964 ms | 260 |
  | One plan task with 50,000 steps | 173 ms | 53 |

## Question 3: m10-m13 status

m10 partial (see m14); m11 resolved; m12 mostly resolved (m9 test still missing); m13 deferred to C2, unchanged.

## New findings

Blocking: R6-B1 and R6-B2 (above).

Minor follow-up list (non-blocking):

| # | Where | Finding |
|---|---|---|
| m14 | docs | Carries m10 forward. The following claims are false or stale. <ul><li>`:69-72`, `:684-695`: "holds by construction" and "every truncatable part is set to its smallest rendering". False: R6-B1, R6-B2.</li><li>`:343`: "they shrink only after every earlier stage is at 0". Stale: step 1 can keep parts whole.</li><li>`:558-561`: "accepted-task boundaries collapse into one summary line once shrinking starts". Stale: N2 shows them whole after shrinking.</li><li>`:740-748`: "below the top a list grows with its budget". False for `tasks` without a ledger (R6-B2).</li></ul> |
| m15 | test `:658-673` | The `planSteps` test asserts wall-clock time (`elapsed < 2000`). It is 26 ms here, so the margin is large, but a wall-clock assertion can flake on a loaded CI runner. Consider asserting a render count instead, or keep the generous bound. |
| m12 residual | test file | No unit test for m9 (an answered run with a recorded pause shows the pause line). |

## Probes run

Scripts are in `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\r6\`
(outputs in `r6\out\`). `hs6.ts` is a byte copy of the reviewed module. The only changes are `export` on internals, the
absolute type-import path, and a render counter. S0 shows it renders identically to the real module (40/40), and the
E replica matches all 2,900 outputs. `mutM1.ts`, `mutM2.ts` and `mutM3.ts` are scratch fix mutants. Every verdict
above is on the REAL module (`runner-v2/src/handoff-snapshot.ts`), imported by file URL. Run each probe with
`node .\node_modules\tsx\dist\cli.mjs <script>` from the worktree root, with NODE_TEST_CONTEXT cleared.

I did not re-run the worker suite (51/51), because the hashes equal the reported ones and none of my conclusions
depends on its green claim.

| Probe | Input | Result |
|---|---|---|
| r5 re-runs (`r5b`, `r5c`, `r5f`, `r5g`; `out\r5-rerun.txt`) | X1-X8, Y, Z (the R5-B1 scans) | All ok: X1 FV 2/2 16,342 B; X7 and Y 0 real violations; Z 0 |
| r2/r2b/r3/r3b/r3c/r4f re-run (`out\c1-probe-*.txt`) | B1-B7, N1-N10, A1 sweep, H, PR1 | All ok; A1 2,156 checks, 0 failures; PR1 1,065 renders, 0 failures; only better fills differ from r5 |
| A (`a-tie.mts`) | Tie family: 200-400 short requirement rows plus one one-line part | **DEFECT R6-B1**: one accepted boundary, 165 of 2,250 violations under both oracles; the first case is FV 1/2 at 16,365 B |
| B (`b-trace.mts`, `trace.mts`) | Step-by-step replica trace | Shows the `capLoad` tie (`KEEP FULL` at equal loads with 426-970 B more) |
| C (`c-shared-tasks.mts`) | No-ledger, 3-20 tasks, 1 open | **DEFECT R6-B2**: production id 37 of 5,904; 120-character id 26 of 5,904 (FV 0/2) |
| D (`d-families.mts`, `d-families-m3.mts`) | A1-A4 and C1-C3 on the real module, M1, M2 and M3 | Real: A 18/201/237/32 and C 22/26/30 violations. M1: A 0, C still fails. M2: 0. M3: 0. Cap and digest 0 everywhere |
| E (`e-fuzz.mts`) | 2,900 inputs: r5 generic, paused and tiny; r6 lines-heavy and no-ledger | Cap, digest, determinism, permutation, replica and `hardCap` all 0. Fill maximality: 0 wasted stages, 0 protected budgets that could take more. Protected-rule violations: r5 generators 0; **lines-heavy 7 literal / 8 true-min, 5 hiding the failed tests line** |
| F (`f-perf.mts`) | Large inputs | Realistic 25 ms; 5,000 lists 711 ms; 20,000 lists 2.96 s; 50,000 steps 173 ms |
| G (`g-named.mts`, `out\g.txt`) | N1, N2, N3 named inputs, with traces | As in the blocking table; M3 and M2 give FV 2/2 on all three; M1 fails N3 |
| H (`h-mutant.mts`, `MUT=./mutM3.ts`) | M2 and M3 on the E generators plus PERF | Both: 0 violations, cap/digest/determinism/permutation 0; M3 PERF 948 ms, 123 renders |
| I (`i-fillorder.mts`) | 2-3 exhausted items, 30 short note lines, 14-15 blockers | Real 0; **M2 53 true-min violations** (the fill takes the slack before the list is raised); M3 0. This is why M2 is not a sufficient fix. |
