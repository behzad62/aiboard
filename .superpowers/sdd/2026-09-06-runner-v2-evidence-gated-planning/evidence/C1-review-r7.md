# C1 — independent code re-review, round 7 (targeted, CD-4)

Date: 2026-09-27. Reviewer: fresh-context Opus 5.5. I did not write this code and did not do rounds 1-6. Worktree
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `ffe0bce0`.

Reviewed (untracked). Hashes measured before and after probing; both match the brief:

| File | sha256 |
|---|---|
| `runner-v2/src/handoff-snapshot.ts` | `af2bcd78261731282e6391ec0af00c601c9bfd5ed50abf4fe563646a50d1ffc5` |
| `runner-v2/test/handoff-snapshot.test.ts` | `c693a6b34b8032aba6d445b52837f655f52582599ed402bc293857f1d01a9a52` |

Fix delta against the r6-reviewed copy (`r6\hs6.ts`), by diff: the new `taskList` budget (interface, `SHRINK_STAGES`,
`initialBudgets`, the no-ledger `## Tasks` slice), `renderHandoffSnapshot` steps 1-3, the new `minimumConfiguration`,
and doc text. The adapter and every other part of `buildBody` are byte-identical, so B1-B7 truthfulness can only move
through the no-ledger task list.

**Verdict: ACCEPT**

(0 blocking. Two follow-ups should be fixed before merge but do not meet the blocking bar: m16, a doc overclaim with a
constructed but unrealistic probe, and m17, an R6-B2 regression test that is green on the buggy code.)

R6-B1 and R6-B2 are resolved. Every r6 family re-run on the real module shows 0 violations under both the literal and
the true-minimum oracles: A1-A4, C1-C3, the I family, and the E fuzz, including 2,000 new lines-heavy and no-ledger
seeds. N1, N2 and N3 each render FV 2/2 with every owner action. The real module's output is byte-identical to the r6
validated mutant M3 on all 18,575 family and fuzz inputs. There are no regressions in the cap, determinism, input-order
invariance, the digest, marker safety, B1-B7 truthfulness or run time.

## Resolution table

| Item | Resolved | Evidence (REAL module) |
|---|---|---|
| R6-B1: `capLoad` tie kept a part whole even when it had hundreds more bytes | **Yes** | **N1**: cycle 5 gave 61 L / 16,375 B, FV 0/2. Cycle 6 gives 74 L / 16,384 B, FV 2/2, owner 20/20, `tests: failed` shown. byBytes and byLines are both 56 L / 16,024 B and fit; the fill then raises `requirements` 0→18. **N2** (adapter, production id): cycle 5 FV 1/2; cycle 6 51 L / 16,366 B, FV 2/2, owner 14/14. **A1-A4** (2,772 / 1,485 / 1,485 / 891 inputs): 0 literal and 0 true-min violations (r6: 18 / 201 / 237 / 32). **E lines-heavy**: 600 r6 seeds plus 1,000 new, 0 violations (r6: 8). Test `test:659` is red on the cycle-5 copy (`actual: 1, expected: 2`) and green on cycle 6. |
| R6-B2: one `tasks` budget drove the no-ledger task list and the open-work list | **Yes** (the regression test does not guard it; see m17) | **N3**: cycle 5 FV 1/2; cycle 6 50 L / 16,371 B, FV 2/2, owner 15/15, fill `taskList` 0→1. **C1-C3** (2,214 each): 0 violations (r6: 22 / 26 / 30). **E no-ledger**: 600 r6 seeds plus 1,000 new, 0 violations. |
| m14: docs claimed the rule before it held | **Partial** (see m16 and m14 residual) | The step 1-3 description (`:688-705`) matches the code. The "holds by construction" claim is still overstated (m16). Two stale comments remain. |
| m15: wall-clock assertion | **Open** (unchanged) | `test:710-722` (`elapsed < 2000`) and `test:819-822` (`< 200`). |
| m12 residual: no test for the m9 answered-run pause line | **Open** (unchanged) | No test found. |
| m13 | **Deferred** (C2, unchanged) | The adapter is byte-identical. |

## Question 1: does the cycle-6 construction hold?

- **Step 1** (`minimumConfiguration`, `:754-774`). This is exact per dimension:
  - With `taskList` split out, every budget except `planSteps` drives one list. Each list's size is increasing on
    `[0, full-1]` (the N-more line is present throughout), so its minimum in either dimension is 0 or `full`.
  - Parts contribute additively, so the sequential choice gives the exact per-dimension minimum over those
    configurations. The one non-additive pair is `planSteps` × `planTasks`, and it cannot matter: an interior
    `planSteps` minimum needs a `steps:`/`criteria:` marker, and that marker is longer than the `planTasks` marker, so
    `planTasks` goes to 0 in both dimensions (as r6 found).
  - Interior values of a single list render k items plus the marker, which is at least the marker alone, so they
    never help.
- **Step 2** (`:717-732`). Protected budgets stay full whenever either minimum fits. When neither fits, FV lines shrink
  first and blockers last, from the configuration with the lower `capLoad`.
- **Step 3.** This is sound for the cap and never lowers a budget. The restart after each growth removes the r6 M2
  fill-order hole: the I family gives 0 violations over 15,712 inputs.
- **Residual hole (m16).** "Smallest rendering" is two-dimensional. A part whose whole rendering has fewer bytes but
  more lines than its marker has no single smallest rendering. If both dimensions bind, a mixed choice can fit when
  neither pure minimum does. This is the "residual caveat" r6 raised, now shown by a probe. It does not violate the
  rule as the r5/r6 oracles formalize it (fewest-bytes or fewest-lines minimum), and it needs at least 69 simultaneous
  external blockers, so I class it as minor. Details are under m16.

## New findings

**Blocking: none.**

I considered m16 against the bar. It is backed by a failing probe on the real module, but:
- it does not violate the rule as formalized by the accepted literal and true-minimum oracles, nor as stated in the
  module doc;
- r6 listed it as a residual caveat and accepted "document it" as a resolution;
- it is out of reach for realistic inputs. It needs at least 69 simultaneous external blockers with a 120-character
  run id, or 125 with the production `native-<uuid>` id. Real runs have at most 4 FV categories
  (`FINAL_VERIFICATION_CATEGORIES`), and the accepted r6 blockers needed 14-22 blockers. It also needs engineered
  content: 36 one-character decisions and 30 empty note lines.

If the owner reads the rule as "never-truncated lines drop only when no rendering of the other parts lets them fit",
m16 is a violation and should be promoted to blocking. The cheap exact fix is below.

Minor follow-up list (non-blocking; m16 and m17 should be fixed before merge):

| # | Where | Finding |
|---|---|---|
| m16 | `renderHandoffSnapshot` step 2 (`:717-732`); docs `:688-705`, `:69-72` | **Mixed-choice hole (r6 residual caveat, now probed).**<br>Probe X (`x-mixed.mts`, `x-show.mts`), hand-built input:<ul><li>run id `run-` + 116×`r`;</li><li>100 blockers `i000`…`i099`, owner action 123×`o` (the last one 306×`o`), no condition;</li><li>36 decisions `a`;</li><li>notes of 30 empty lines;</li><li>2 exhausted issues;</li><li>FV: build passed, tests failed.</li></ul>byBytes is 202 L / 16,372 B (over on lines) and byLines is 137 L / 16,550 B (over on bytes). **The real module outputs 200 L / 15,927 B with FV 0/2: the Verification section is only `2 more — see AIBoard run …`, `tests: failed` is hidden, and owner actions are 98/100.** It still shows all 36 `- a` decisions and 30 empty `> ` note lines.<br>The mixed configuration fits with every never-truncated line at 167 L / 16,377 B, FV 2/2 and 100/100. In it, decisions are at 0 (fewest lines), and notes and exhausted issues are whole (fewest bytes).<br>Sweep: 6 of 6,888 inputs. X2 (`x-min.mts`) found the fewest blockers that trigger it: 69 with the 120-character id, 125 with the production id.<br>The doc claims "holds by construction" and "one choice per part is not enough", which implies two configurations suffice. That is overstated.<br>**Fix, either one:**<ul><li>(a) State the precise guarantee in the doc: two per-dimension minima; a mixed choice can fit when both dimensions bind.</li><li>(b) Exact and cheap: step 2 runs only when neither minimum fits. There, take the parts whose 0 and whole renderings trade lines for bytes and compute each one's (Δlines, Δbytes) against byLines. That costs one render per part, because sizes are additive apart from `planSteps` × `planTasks`. Then search the subsets arithmetically (at most 2^13 sums, or a DP over lines), confirm the pick with one render, and shrink protected lines only if no subset fits.</li></ul> |
| m17 | test `:672-688` ("R6-B2, probe N3"); `C1.md` cycle-6 table | **The R6-B2 regression test is green on the buggy code, and the evidence claim is false.**<ul><li>I ran the whole test file against a byte copy of the cycle-5 module (`r6\hs6.ts`): 52/53. Only the R6-B1 test is red; the R6-B2 test passes.</li><li>In the test's own input shape, cycle 5 is red only at `lastOwnerLength` 147-182, and cycle 6 drops correctly from 183 up (all oracles agree). The test uses **145**, so it is not red on cycle 5. `C1.md` says "cycle-5 code FV 1/2" for this test; that is false for the test as written.</li><li>The prove-red note calls the `taskList` budget "defense in depth, the two minimum configurations already cover that input". That holds for this input but not in general. The fault-B2 mutant (`mutB2.ts`: cycle 6 with only the no-ledger slice back on `budgets.tasks`) gives **76 literal/true-min violations** over 5,428 C-family and no-ledger fuzz inputs, for example 53 L / 16,323 B, FV 1/2. So the budget is load-bearing, and reverting it would pass the suite.</li></ul>**Fix:** set `lastOwnerLength` to 160, which is red on both cycle 5 and the fault-B2 mutant and green on cycle 6. Correct the `C1.md` row and the prove-red note. |
| m14 residual | docs | Two comments are still stale:<ul><li>`:345`: "they shrink only after every earlier stage is at 0". Step 2 starts from a minimum configuration in which some parts can be whole.</li><li>`:562-565`: "accepted-task boundaries collapse into one summary line once shrinking starts". byBytes keeps them whole when that is smaller.</li></ul>The header list of truncatable parts (`:63-67`) does not name the no-ledger task rows (`taskList`). The `raiseBudget` doc is now accurate: every budget except `planSteps` drives one list. |
| m15 | test `:710-722`, `:819-822` | Carried from r6: wall-clock assertions (`< 2000` ms, `< 200` ms). The margins are large but can flake on a loaded runner. |
| m12 residual | test file | Carried from r6: no unit test for m9 (an answered run with a recorded pause shows the pause line). |

## Question 2: regressions

- **Cap: 0 failures** in every probe that counted it on the real module (families 13,275, E 5,300, I 15,712, X 6,888,
  PERF 11). `hardCap` never triggered in the fuzz.
- **Determinism and input-order invariance.** E renders each input twice, and once with every list shuffled: 0
  nondeterministic and 0 permutation mismatches over 5,300 inputs. My independent replica (`trace.mts`, written from
  the doc and code) matches the real output on all 5,300.
- **Digest.** `verifyHandoffSnapshotDigest` holds on every output in D and E, and on the m16 output (`x-show.mts`).
- **Fill maximality.** E: 0 stages that could take more with the others fixed, and 0 protected budgets that could take
  one more.
- **Marker safety.** A1 sweep (`c1-probe-r3`): 2,156 checks, 0 failures. PR1 (`r4f`): 1,065 renders, 0 failures.
- **B1-B7 truthfulness.** `c1-probe-r2`, `r2b`, `r3`, `r3b`, `r3c` and `r4f` produce output byte-identical (CR
  stripped) to the r6 run. No FINDING lines.
- **Run time: nothing to flag at realistic sizes.**

  | Input | Time | Renders |
  |---|---|---|
  | Realistic large run | 26 ms | 74 |
  | 500 of every list | 99 ms | 146 |
  | 5,000 of every list | 845 ms | 174 |
  | No ledger, 5,000 of every list | 518 ms | 144 |
  | 20,000 of every list + 10,000 plan tasks (unrealistic; linear) | 3.4 s | 188 |
  | 50,000 plan steps | 221 ms | 77 |

  The worst fuzz render was 20 ms.
- **Tests.** The file ran against a byte copy of the cycle-6 module: 53/53 (the hashes equal the reported ones, so I did
  not rerun the in-repo command). Against the cycle-5 copy: 52/53 (only R6-B1 red; see m17).

## Probes run

Scripts are in `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\r7\`,
with outputs in `r7\out\`. Run each with `node .\node_modules\tsx\dist\cli.mjs <script>` from the worktree root, with
NODE_TEST_CONTEXT cleared.

`hs7.ts` is a byte copy of the cycle-6 module. The only changes are `export` on internals, the absolute type-import
path and a render counter; its test-file run is 53/53. The oracles in `lib.mts` render through `hs7`, so they include
the `taskList` stage. Every verdict is on the REAL module, imported by file URL.

| Probe | Input | Result |
|---|---|---|
| D (`d-families.mts`, `out\d.txt`) | r6 A1-A4 and C1-C3, 13,275 inputs | 0 literal and 0 true-min violations; cap and digest 0; output identical to r6 M3 in all |
| G (`g-named.mts`, `out\g.txt`) | N1, N2, N3 exact, with traces | Each FV 2/2 and every owner action shown (cycle 5: FV 0/2, 1/2, 1/2) |
| E (`e-fuzz.mts`, `out\e.txt`) | r5 generic/paused/tiny plus r6 lines-heavy/no-ledger (2,900) plus 2,000 new seeds | Cap, digest, determinism, permutation, `hardCap`, replica, M3-diff, fill waste all 0; 0 literal and 0 true-min violations |
| I (`i-fillorder.mts`, `out\i.txt`) | r6 I family, 15,712 inputs | 0 violations; cap 0 |
| r2/r2b/r3/r3b/r3c/r4f (`out\c1-probe-*.txt`) | B1-B7, marker sweep, PR1 | Identical to r6; A1 2,156 checks and PR1 1,065 renders, 0 failures |
| F (`f-perf.mts`, `out\f.txt`) | Large inputs | See the run-time table |
| X (`x-mixed.mts`, `x-show.mts`, `out\x.txt`) | Mixed-choice sweep with the exact 0/whole subset oracle (`x-lib.mts`) | **m16**: 6 of 6,888 mixed-only fits; the first hides `tests: failed` (FV 0/2) |
| X2 (`x-min.mts`, `out\x2.txt`) | Fewest never-truncated lines for m16 | 69 blockers (120-character id), 125 (production id) |
| B2M (`b2-mutant.mts`, `mutB2.ts`, `out\b2m.txt`) | Fault-B2 mutant over C families and no-ledger fuzz | 76 violations: `taskList` is load-bearing (m17) |
| T (`t-on-copy7.test.ts`, `t-on-cycle5.test.ts`, `t-b2scan.test.ts`) | The test file against the cycle-6 and cycle-5 copies; scans of the R6-B2 test shape | 53/53 and 52/53; R6-B2 test red window 147-182 on cycle 5 and on the fault-B2 mutant; 145 is outside it; cycle-6 drops in that shape confirmed legitimate by every oracle (0 of 308) |
