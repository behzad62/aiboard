# T6b independent review — round 5 (narrow)

Reviewer: independent (Claude), 2026-09-27. Scope: the two sections added
since r4: "Repair cycle 4 (worker)" and "Owner decision: run repair limit
scales with tasks (worker)". No source or test file in the worktree was
edited; nothing committed. All probes and mutations ran in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6b-r5\repo` (a copy of
the worktree `runner-v2/` with a node_modules junction). Outputs are in that
folder's `*.out.txt` files.

## Verification

Scratch source hashes match the worker's final list:
`architect-tools.ts` 73dbe31c…bc56fe69, `build-runtime.ts` 56907376…c76c5,
`scheduler-store.ts` 2192a30b…17442e.

### Change 1: repair cycle 4 (r4 B-1 partial multi-member dispatch)

- Code read: `architect-tools.ts:1369-1416`. The boundary loop now
  pre-checks the resolution (`stale_delivery_boundary_resolution`), then
  validates every member (external blocker, per-issue budget, live
  decision, evidence), and only then charges. The charge key at `:963`
  includes the approach id. `cycle_recorded` charges only per-issue
  budgets; the run cap is consumed on repair-plan events, so a later
  member cannot throw on the run cap after an earlier member was charged.
- PROBE-R4-PARTIAL (the r4 probe; the scratch copy is byte-identical,
  sha256 DC90B9AE…DB816B70) on current code: **1/1 pass**.
  - resolve-1 is refused and charges nothing (build 0, tests 0).
  - resolve-2, after the tests decision, dispatches (build 1, tests 1,
    `T1-fix` created).
  - resolve-3 on the already-resolved boundary is refused with
    `stale_delivery_boundary_resolution` and charges nothing. This
    confirms NB-1 is fixed.
  - r4's deadlock is gone.
- **Prove-red (my own mutation):** I changed the boundary loop to charge each
  member as it is validated (architect-tools.ts 73dbe31c → b78c484d).
  - Worker test `R4-B1` went red: `refused dispatch charges build nothing: 1 !== 0`.
  - The file was restored byte-exact (73dbe31c).
  - Under the same mutation the r4 probe still reached `T1-fix`, but its
    observations show the partial charge (build `1` after the refused
    resolve-1, and `2` at the end). The probe checks only the end state,
    so R4-B1 is the test that separates the two versions.

### Change 2: the run limit scales with tasks

- Code read: `scheduler-store.ts:949-990, 1569-1578, 3838-3862, 4126-4175`;
  `build-runtime.ts:2657-2670`.
- **Prove-red (my own mutation):** I changed `consumeRepairCycle` to
  enforce the flat stored `cycles.limit` (2192a30b → 24a295b4).
  - Worker test `allows a 4th unrelated repair plan` went red (0/1).
  - The file was restored byte-exact (2192a30b).
- Scaled-limit edge probe (`probe-r5-scaled.test.ts`, real SQLite store,
  real ready plan with 6 tasks, real reducer via `reduceSchedulerEvent`):
  **1 pass, 2 fail**.
  - Pass, PROBE-R5-EXPLICIT3: a new-policy run with explicit
    `repairPlanLimit=3` stores `explicitLimit: true` and has an effective
    limit of 3. A legacy log configured with limit 5 does not scale
    (effective 5). Legacy runs never scale.
  - Fail, PROBE-R5-OLDROW and PROBE-R5-EXTEND: see B-1 and B-2 below.

## Findings

### BLOCKING

**B-1: replaying a HEAD-era new-policy log crashes (non-deterministic replay).**
`scheduler-store.ts:960-966` (`repairPlanLimitScales`) and `:4137`.
- Scenario: a new-policy run whose policy row was written by the committed
  HEAD runtime has payload `{repairPlanLimit: 3}` and no `explicit`
  field. The inference "absent + limit == 3 means not explicit" makes that
  run scale, so its effective limit is 9 with a 6-task plan.
- HEAD had already paused that run with
  `repair.cycle_limit_reached {used: 3, limit: 3}`. Replaying it now fails
  `limit !== effective` and throws "Repair-cycle limit event does not
  match the kernel repair-cycle count."
- Even with no pause row, an in-flight run silently changes budget on
  upgrade: HEAD would stop at 3, the new code allows 9.
- The inference cannot be made safe in general. HEAD could not tell
  "defaulted 3" apart from "explicitly configured 3", so the stored bytes
  do not say which one it was. A flag-absent row therefore has to keep
  exactly the semantics HEAD enforced: the flat stored limit.
- Probe output: `{"explicitLimit":"absent","scales":true,"effective":9,"replayError":"Repair-cycle limit event does not match the kernel repair-cycle count."}`.

**B-2: an owner extension shrinks the limit below `used` on a flag-absent row.**
`scheduler-store.ts:4164-4175` together with the same inference.
- Scenario: flag-absent new-policy row, limit 3, 6 tasks, effective 9.
  All 9 are used and the run pauses at 9/9.
- The owner extends by +1. The stored limit becomes 4, which is not 3,
  so the row is now inferred explicit and scaling stops. The effective
  limit drops from 9 to 4 while `used` = 9.
- The run is immediately exhausted again. The extension removed 5 repair
  plans instead of adding 1, and the limit fell below `used`.
- Probe output: `{"before":9,"after":4,"used":9,"cycles":{"limit":4,"used":9,"extensions":1},"exhaustedAfterExtend":true}`.

**Minimal fix for both:** only scale when the flag was durably recorded as
non-explicit. In `repairPlanLimitScales`, replace the two
`explicitLimit` lines and `return true` with
`return cycles.explicitLimit === false;`.
- The runtime already writes `explicit: false` for defaulted new-policy
  runs (`build-runtime.ts:2668`). Flag-absent rows keep HEAD's flat
  behavior.
- I checked this in scratch:
  - PROBE-R5-OLDROW is green: no scaling, effective 3, replay accepted.
  - The worker's `t6b-repair-scaled-limit` suite stays 7/7.
  - Under this fix PROBE-R5-EXTEND no longer applies: consuming 9 on a
    flat-3 row throws at 4 as designed, and an extension then gives
    4 > 3.
- Also update the `explicitLimit` doc comment (`:644-650`) and the
  evidence note that says "stored limit other than 3 counts as explicit".
- Add a regression test: a replay of a HEAD-format policy row plus a
  `cycle_limit_reached {3,3}`.

### NON-BLOCKING

None.

### NOTE

- N-1 (`scheduler-store.ts:986`): a plan revision that removes tasks
  lowers the effective limit. `Math.max(used, …)` stops it from going
  below `used`, which is within the brief. An already-recorded pause
  keeps its own stored `limit`.
- N-2: PROBE-R4-PARTIAL only checks the end state, so it does not catch a
  charge-before-validate regression by itself. The committed `R4-B1`
  test does catch it (see the prove-red above).

## r4 regression check

- r4 B-1 is fixed, and NB-1 is fixed (stale resolve is refused and
  charges nothing).
- A per-issue 4th fix is still refused (the `issue.used >= issue.limit`
  validation comes before any charge).
- Legacy flat 3 is unchanged. No regression found in the r4-verified
  paths I exercised.

## Counts

- Probes: PROBE-R4-PARTIAL 1/1 pass. probe-r5-scaled 3 tests: 1 pass,
  2 fail (B-1, B-2).
- Prove-reds: 2/2 went red under mutation and were restored byte-exact.
- Fix check (scratch only): probe OLDROW green; worker scaled suite 7/7.
- Findings: BLOCKING 2, NON-BLOCKING 0, NOTE 2.

T6b REVIEW r5 — REPAIR REQUIRED — 2 blocking
