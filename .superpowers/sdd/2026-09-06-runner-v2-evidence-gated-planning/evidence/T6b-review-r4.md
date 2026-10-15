# T6b independent review — round 4 (narrow)

Reviewer: independent (not the worker). Date: 2026-09-26.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6` (T6b uncommitted).
Nothing edited in the worktree except this file. Nothing committed, staged or stashed.

## Scope

Narrow, per brief: verify R3-B1 (delivery-boundary issue identity per task)
and R3-B2 (one decision authorizes one dispatch), and that the cycle-3
changes (incl. N-1/N-2/N-3/N-6) broke nothing nearby. Earlier rounds not
re-audited. Worker green suites not re-run (owner rule); the two r3 probes
were re-run inverted, one prove-red reproduced per blocker, plus one new
probe for a regression found by reading the cycle-3 change.

## Hash check (cycle-3 file list)

START and END sha256 of all 11 cycle-3 files are identical to the
"repair cycle 3 final state" list in `evidence/T6b.md` (e.g.
architect-tools.ts `efc70e69…`, build-runtime.ts `8f0c42b0…`,
repair-budget-contracts.ts `7ff48bf3…`, scheduler-store.ts `b4611fc2…`).
Worktree unchanged by the review.

Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6b-r4\repo`
(node_modules junctioned; runner-v2/src + test copied, 0 hash mismatches
vs. worktree before probes were added). Probe files:
`runner-v2/test/probe-r4-boundary.test.ts` (r3 J3 harness + `repairPlanLimit: 12`
+ `evidenceStore` exposed; PROBE-J3-INV, PROBE-R4-PARTIAL) and
`runner-v2/test/probe-r4-live.test.ts` (r3 PROBE-LIVE inverted: PROBE-LIVE-INV).
Mutation scripts: `prove-red.ps1`, `attrib.ps1` (restore in `finally`).

## Verification

### R3-B1 — FIXED (verified)

- One helper `deliveryBoundaryRootCause` (repair-budget-contracts.ts:83-96)
  is used by both the kernel dispatch gate (build-runtime.ts:2426-2428) and
  the resolve tool (architect-tools.ts:1359); same inputs (taskId, checkId,
  `report.failingTestIds`, boundaryId fallback) on both sides.
- PROBE-J3-INV (r3 J3 inverted): four tasks fail their first boundary once
  and are repaired. Result: pass 1/1; every issue is
  `delivery-boundary:T<n>:(build|tests)` with used=1; T1-T4 all accepted;
  no pause. (A longer run reaches final verification with 6 tasks each
  used=1; the harness Architect stub cannot plan final verification, which
  is the harness end, not a defect.)
- With the DEFAULT run-level cap (G-5 `DEFAULT_REPAIR_PLAN_LIMIT = 3`) the
  same probe pauses on T4 with "Run-level repair-plan budget is exhausted"
  while T4's own issues show used=0 — a different, pre-existing,
  owner-raisable budget with an accurate message, not a per-issue false
  exhaustion. See NOTE-1.
- "One task still exhausted after its own 3": covered by the worker's
  committed boundary test and consistent with the per-key reducer; the
  prove-red below shows exhaustion is keyed per issue.

### R3-B2 — FIXED for its stated scenario (verified), but see B-1

- Reducer marks `dispatched` on the `repair.cycle_recorded` dispatch
  (scheduler-store.ts ~3898-3903); `liveRepairApproach` excludes consumed
  approaches (architect-tools.ts:908-911); `repair.approach_failed`
  (scheduler-store.ts:3915-3931) is runner-only, charges nothing, requires
  the latest approach be dispatched, is a no-op if already failed.
  Deterministic on replay (payload carries issueId/approachId; pure reducer).
- PROBE-LIVE-INV (r3 PROBE-LIVE inverted, real stores/kernel/tools/pump):
  round 1 dispatches (used 1); round 2 with no new decision →
  `No live repair approach … Call record_repair_approach_decision`,
  repairTasks [], used stays 1, approach `three-round-a1:f=true:d=true`,
  exactly one `repair.approach_failed` event. pass 1/1.
- Successful repair: `markDispatchedApproachesFailed` runs only on the
  `final_verification.failure_reported` path (build-runtime.ts:1405), and
  only for member issues of the new failure's categories + failing ids —
  a repaired category is not a member, so its approach is not failed.
- Repeats still need new evidence: the R2-B3 gates in the
  `repair.approach_decided` reducer are unchanged (the new-decision path
  supersedes and fails the prior approach, then applies the NEW-evidence
  checks).

### Non-blocking changes — no regression found (code read)

- N-2 (sqlite-project-memory.ts:189-212): rebuild under `BEGIN IMMEDIATE`
  / `COMMIT`, best-effort `ROLLBACK`, rethrow; new/absent-table and
  already-migrated DBs take the early returns unchanged.
- N-3 (cleanup-ownership.ts:172-191): identical/retained records are
  no-ops; only a non-retained→retained upgrade appends, on its own
  `:retained` key; retained records remain non-candidates, so cleanup
  safety is unchanged.
- N-6 (native-build-factory.ts:736-745): the six roots from
  `nativeBuildCleanupRoots` are recorded retained at creation, wrapped in
  try/catch; re-creation (resume) hits the N-3 no-op. Retained → never
  deleted by the search.
- N-1 (build-runtime.ts:3276-3284): defensive pause instead of a silent
  uncharged round; reducer accepts `approach_failed` as a pause cause.
- r3-verified areas (cleanup safety, flaky real counts, pause keys,
  boundary tool path) — no cycle-3 edits touch flaky/pause-key code; the
  boundary tool path is exercised by PROBE-J3-INV and PROBE-R4-PARTIAL.

## Prove-red records (scratch copy only; restored = before)

- PR-R4-B1 (R3-B1): `deliveryBoundaryRootCause` forced to
  `delivery-boundary:${checkId}`. repair-budget-contracts.ts
  before `7ff48bf3e6d880e41d138870401d4beaee0cfb9004932f564380d073523f125b`
  / mutated `fa5a81dd0eccc21e925eca4ba04bc514ef0a4c101ece19b6a046da86ce15b8db`
  / restored `7ff48bf3…125b`. PROBE-J3-INV: fail 1/1 — paused
  `Issue delivery-boundary:build used 3/3 repair cycles`
  (`delivery-boundary:build:used=3`, `delivery-boundary:tests:used=3`).
  Green on restore: pass 1/1.
- PR-R4-B2 (R3-B2): consumed gate removed from `liveRepairApproach` AND
  the `markDispatchedApproachesFailed` call disabled.
  architect-tools.ts `efc70e69…a69f` / `d503b6e7…5f9c` (identical to the
  worker's recorded mutation hash) / restored `efc70e69…a69f`;
  build-runtime.ts `8f0c42b0…cd15` / `884ae6fd983d87d2d72022bdaef6b9c08c04e4a13f8ef16ff762c233de7272a3`
  / restored `8f0c42b0…cd15`. PROBE-LIVE-INV: fail 1/1 — round 2
  dispatched `three-round-fix-2`, used 2, `three-round-a1:f=false:d=true`,
  zero `repair.approach_failed` events. Green on restore: pass 1/1.
- PR-R4-ATTRIB (B-1 attribution): consumed gate alone reverted
  (architect-tools.ts `efc70e69…` → `d503b6e7…` → `efc70e69…`).
  PROBE-R4-PARTIAL: pass 1/1 (resolve-2 succeeds, `T1-fix` created). With
  the cycle-3 code: fail 1/1 (below). The deadlock is introduced by
  cycle 3.

## Findings

### BLOCKING

**B-1 — Partial per-member charge + one-shot decisions = permanent
deadlock of a multi-member repair dispatch (new in cycle 3).**

- Where: the three tool dispatch loops check-and-charge member by member
  before validating the rest and before the resolution/plan event is
  appended: architect-tools.ts:1362-1381 (resolve_delivery_boundary_failure),
  :726-745 (plan_verification_repairs), :1226-1245 (verifier repairs); the
  charge key is `repair-cycle:<issue>:<boundaryId|generationId|reviewId>`
  (:954), independent of the approach.
- Scenario (PROBE-R4-PARTIAL, real stores/kernel/tools/pump): T1's boundary
  fails with two failed checks (build, tests) → two member issues. The
  Architect records a decision for `build` only and calls resolve →
  `build` is charged (used 1) and its decision CONSUMED
  (`a-build/f=false/d=true`), then `tests` has no decision → tool error, no
  resolution recorded. The Architect records the `tests` decision and
  retries → refused: `No live repair approach for … delivery-boundary:T1:build`.
  It records a new `build` decision with genuinely fresh evidence
  (`a-build-2`) and retries → `Scheduler idempotency conflict for
  repair-cycle:repair:21b7…:boundary:T1:1:1` (same key, different
  approachId). Re-invoked turns hit the same conflict forever; the run
  cannot resolve this boundary generation (harness: "Architect returned
  from delivery_boundary_failed without a typed action", status running,
  no `T1-fix`). A charge was also spent on a dispatch that never happened.
  Before cycle 3 the retry was an idempotent re-charge and succeeded.
- Reachability: normal — the integrated boundary runs several checks, and a
  failing change commonly fails more than one; a model deciding one member
  and then fixing the error is an expected tool-use pattern. Same shape for
  multi-category final-verification repairs and multi-criterion verifier
  repairs.
- Minimal fix: in each loop, validate ALL members first (external blocker,
  budget, live decision, evidence) and return the error before ANY charge;
  only then charge every member (ideally in the same store transaction as
  the resolution/plan event). Also make the retry safe: if this member is
  already charged for this dispatch key, treat it as authorized/no-op
  rather than requiring a live decision (or include the approachId in the
  charge key). Add PROBE-R4-PARTIAL as a committed test (decide one of two
  members → error with used 0 for both; decide the second → dispatch
  succeeds; each member used 1).

### NON-BLOCKING

- NB-1 — The resolve tool still charges before its own resolution
  validation (seen pre-cycle-3 in PR-R4-ATTRIB: a resolve after the
  boundary was already resolved charged build/tests to used 2 before
  refusing "Only the current failed boundary … can be resolved"). Fixed by
  the same ordering change as B-1 (validate the resolution first, charge
  last). architect-tools.ts:1349-1383.

### NOTE

- NOTE-1 — With the default run-level repair-plan cap (3, G-5), a 4th
  unrelated boundary repair in a run pauses with an accurate "Run-level
  repair-plan budget is exhausted" message (issue used=0). This is the
  separate, pre-existing run budget, not the R3-B1 defect; the worker's
  committed test raises it to 12. Owner may want to confirm 3 is the
  intended run-level default for delivery-boundary repairs.
- NOTE-2 — Failing test ids are part of the issue key (per brief). A task
  whose failing set changes each round gets a fresh 3-cycle budget per
  distinct set; the run-level cap still bounds the total. Same design as
  the existing final-verification identity.
- NOTE-3 — `repair.approach_failed` is recorded only on the final-verification
  failure path; boundary and verifier approaches stay `failed=false,
  dispatched=true` until superseded. Gating is still correct (consumed ≠
  live; a new decision supersedes), but context shows them "pending".

## Commands and counts (NODE_TEST_CONTEXT cleared, scratch repo root, concurrency 1)

- `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 --test-name-pattern=J3-INV runner-v2/test/probe-r4-boundary.test.ts`
  — tests 1, pass 1, fail 0 (current code); mutated PR-R4-B1: tests 1, pass 0, fail 1.
- `… --test-name-pattern=PROBE-LIVE-INV runner-v2/test/probe-r4-live.test.ts`
  — tests 1, pass 1, fail 0; mutated PR-R4-B2: tests 1, pass 0, fail 1.
- `… --test-name-pattern=R4-PARTIAL runner-v2/test/probe-r4-boundary.test.ts`
  — current code: tests 1, pass 0, fail 1 (B-1); consumed gate reverted:
  tests 1, pass 1, fail 0.
- Default-cap J3-INV (before `repairPlanLimit: 12`): tests 1, pass 0,
  fail 1 on the run-level cap (NOTE-1).

T6b REVIEW r4 — REPAIR REQUIRED — 1 blocking
