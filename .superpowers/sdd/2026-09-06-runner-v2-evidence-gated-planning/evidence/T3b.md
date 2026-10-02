# T3b evidence — independent source-coverage review gate (implementation worker)

Task: RUNNER V2 P6.6 T3b (controller split EX-2). T3 checkboxes 3, 4 and the
OA-1/OA-2/OA-10 #2/OA-10 #5 parts, plus the T3a carry-forwards N2 and N6.
Base revision: `630dba59` (`feat(runner-v2): P6.6 T3a planning tools, planning state and plan-only admission`),
branch `codex/runner-v2-p6-6`, worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`.
All changes left uncommitted, as briefed. Nothing was staged, stashed, committed, or pushed.

Requirement ids: EP05, EP06 (coverage side — reviewer checks against observable
outcomes), EP07 (coverage side — review of task deliverables sizing), EP33, EP34,
EP42 (T3 contribution — re-review blindness), EP44, T3 checkboxes 3, 4, N2, N6.

## Files changed (sha256 of working copy at evidence time)

| File | sha256 | Change |
|---|---|---|
| `runner-v2/src/planning-review.ts` (new, 1818 lines) | `56ece0e431fc29555a3fb087aa7cdbfda7b08f58d56eee31b81006c3b61e8851` | Coverage authority, 3 lifecycle tools, broker, reviewer runtime |
| `runner-v2/src/planning-projection.ts` | `d5b5cd1067fe805051ea8a761d7b2823b538f3e15623d8eb2c01bb0ca7ef254b` | N6 rule, N2 read index, coverage reducer cases |
| `runner-v2/src/build-runtime.ts` | `5d200dd3b86c863f8946ec36745d10c58adf72486b7276c2931bf8e2f4ee6a70` | `advanceCoverageReview`, driver + capabilities options |
| `runner-v2/src/planning-tools.ts` | `5280ddfb360a521dd4d088df6c1f51c81d10b04ce37721dffa4d7ef430b3a93e` | N2 durable reads, `request_coverage_review` registration |
| `runner-v2/src/agent-prompts.ts` | `5550931b5987f4a59d6d3320cdf0f5697bd984a60bb74f8ba7149a130beb18d4` | Reviewer prompts + Architect coverage instructions |
| `runner-v2/src/native-build-factory.ts` | `f6ceeaf47bd5453b90dc63dead54560dd4f31903a40eaef7a137c77d7b0c087d` | Coverage runtime wiring, driver adapter |
| `runner-v2/src/role-capabilities.ts` | `2303d29ab96ecb93f935fcb20f4ad05fb6fa95b11a16013ea553f0ac6bf4be59` | `verifier:coverage` read-only surface |
| `runner-v2/src/scheduler-store.ts` | `896a993c4b75b51d7923c0c9ddf8edda598e0fbfafbda94296d352cece0c7630` | Verifier authority for obligations event (1 line) |
| `runner-v2/test/planning-review.test.ts` (new, 2939 lines) | `5af1ed5ad7e269074ea818f25e5644b441106994c5261555deda16a2b284fd92` | 32 T3b tests |
| `runner-v2/test/support/planning-seed.ts` (new, 199 lines) | `e318e95c53cdca02b99812f336cd29a0f16e185022178a7d097e90f2781687ef` | Coverage seed helpers |
| `runner-v2/test/planning-tools.test.ts` | `e121c03210b6ae15b2fe95661ccaf2c492e0687eb70e6156940fe2044384f749` | Reseeded for durable reads + ordered coverage chain |
| `runner-v2/test/planning-state.test.ts` | `ac8318249c5c698f4734ce44437d9507430a135a0595d6be53f957b84947e75f` | Reseeded reads + request/obligations before verdict |
| `runner-v2/test/planning-projection.test.ts` | `517153c660691d7ab7a24852c6e20625819f39e9c8545eac11cb081943041555` | Reads precede checkpoint coverage claims |
| `runner-v2/test/role-capabilities.test.ts` | `9eb6e1ab8931a7d845b947c3e126278e0e69513313141738f46296ddb26357fc` | Coverage surface in the derived matrix |

Untouched as designed: `planning-contracts.ts` and `source-manifest.ts` (read-only
per brief — all validation goes through their T1 exports), `architect-tools.ts`,
`native-architect-runtime.ts`, `task-scheduler.ts`, UI/client, package files.

Line-ending note: all 14 T3b files are CRLF in the working copy, matching the
checkout convention (`core.autocrlf=true`; untouched files are CRLF, HEAD blobs
are LF). `git diff` shows only the intended hunks (11 files, +1152/−174).
Prove-red hashes below are LF-byte hashes (mutations ran before the
LF→CRLF conversion); the table hashes are the final CRLF-byte hashes.

## What was built

1. **N6 rule** (`planning-projection.ts:719-735`): `assertMonotonicCheckpoint`
   now takes the still-existing section set; a checkpoint is monotonic over
   sections that STILL EXIST in the current manifest, while sections retired
   by an amendment are dropped from coverage. Histories without a retiring
   amendment behave exactly as before (the filter is a no-op when nothing
   retired), so old logs replay identically (`replay-compatibility` 3/3).
2. **N2 durable reads** (the review's option 1): `planning-tools.ts` appends a
   `planning.source_section_read` event (manifest revision + digest, section +
   digest, idempotent per manifest+section) on every full verified read; the
   in-memory receipt set is gone. The reducer keeps a `sourceReadIndex` per
   manifest revision (`planning-projection.ts:742-766`); checkpoints must cite
   durable reads at the current revision (`:1103`), stale-revision and
   drifted-digest reads are refused, and `plan_ready` requires every current
   section read (`:1379-1384`). Reads survive restart with no re-read.
3. **Coverage reducer cases** (`planning-projection.ts:1153-1417`):
   request (stale plan/source refused, idempotent), obligations (must match
   the request; re-review must carry its own correction view, OA-10 #2;
   false `recordedBeforePlanOrDiffProvided` stamps refused), prior-findings
   release (refused before the recorded own view), verdict (must be
   requested, bound to current plan+source, must have recorded obligations —
   record-before-verdict — with matching obligation sets; re-review verdicts
   need the release plus one check per prior finding), unavailable (explicit
   outstanding gate), and `plan_ready` (needs plan + bound review + host
   capabilities; refused while a gate is outstanding, while any section is
   unread, or while a blocking prior finding is unresolved; then T1
   `computePlanReadiness` decides).
4. **Coverage authority + tools** (`planning-review.ts:129-965`):
   `SchedulerCoverageReviewAuthority` appends through the store (the reducer
   re-validates — no second authority); `record_coverage_obligations`,
   `submit_coverage_verdict`, and `request_coverage_review` (the Architect's
   step, registered in `PLANNING_TOOL_NAMES`). The submit tool re-checks
   recorded obligations before appending (defense in depth; the reducer owns
   the refusal).
5. **Reviewer runtime** (`planning-review.ts:1008-1818`): `createCoverageReviewBroker`
   composes read-only inspection with exactly one lifecycle tool per pass;
   `NativeCoverageReviewRuntime` runs deriving (source/amendments/objective/
   durable guidance only, fresh session, empty event list) then verdict
   (plan judged against recorded obligations) passes. Selection reuses
   `RuntimeRouter.selectVerifier` unchanged with the Architect excluded
   (`:1180-1186`); no distinct model yields the recorded `fresh_context`
   fallback; no candidate at all yields an explicit outstanding gate, never
   controller self-review. Source/plan pack overflow and a model that never
   records suspend with an explicit gate and no verdict. A same-pass
   plan-critic hook runs for high-risk plans (`:1211-1233`) and records its
   skip otherwise; it emits no `plan_critique` events (OA-10 #1: P6.6
   forbids a second critic).
6. **Runner driving** (`build-runtime.ts`): `advanceCoverageReview` runs a
   requested review, appends `plan_ready` when a bound review is
   non-blocking and fully read, and otherwise returns control to the
   Architect (blocking findings and unread sections are visible in
   planning status). New options `coverageReview` and
   `planningHostCapabilities`; absent driver + requested review records the
   explicit outstanding gate. Legacy runs never reach this path.
7. **Surface, prompts, factory**: `verifier:coverage` is exactly the
   read-only allow-list plus the two lifecycle tools (`role-capabilities.ts:151-162`);
   reviewer prompts (`COVERAGE_REVIEWER_INVARIANTS`, derive/verdict and
   re-review variants) orient the two record-then-verdict tools and declare
   source text untrusted; `native-build-factory.ts` wires the runtime over
   the verifier candidate pool, shared sessions/artifacts/evidence/
   manifests, and the project root for read-only inspection.
8. **Scheduler 1-liner** (`scheduler-store.ts:1960`): the verifier actor may
   append `planning.coverage_obligations_recorded` (the verdict line already
   existed at HEAD for the T3b stand-in seeds).

## Design choices

- **N6 rule (monotonic over still-existing sections):** the review offered two
  fixes — monotonicity over the current manifest, or exempting the
  amendment's `retiresSectionIds`. Monotonic-over-current was chosen because
  it needs no trust in the amendment's recorded impact: whatever the
  amendment claims, a section absent from the current manifest cannot be
  covered, and every surviving previously-covered section must be retained.
  The retiring test (`:584`) drops the retired section and appends; the
  non-retiring test (`:644`) refuses to drop a survivor.
- **Durable receipt event (N2 option 1):** `planning.source_section_read`
  bound to manifest revision + artifact digest and section + digest, kept in
  `sourceReadIndex[manifestId][sectionId]`. Old reads never satisfy a new
  revision and a digest mismatch forces a re-read, so checkpoint coverage
  and readiness are pure functions of durable state; T3b never treats
  checkpoint coverage as read evidence.
- **RG-6 reused, not reinvented (OA-1):** the obligations→verdict shape
  mirrors `record_verification_expectations` + the reducer gate that refuses
  a two-pass verdict without recorded expectations — including the reused
  lifecycle signals `verifier_expectations_recorded` (obligations recorded
  ends the deriving pass) and `verifier_verdict_submitted` (the verdict ends
  the verdict pass). The re-review extends the same device: own correction
  view recorded first, then the runtime records the findings release (which
  the reducer refuses before the recorded own view), then the verdict checks
  each prior finding (OA-10 #2).
- **OA-3 selection reused:** `RuntimeRouter.selectVerifier` is called
  unchanged with the Architect's runtime id excluded and
  `acceptedChangeAuthorRuntimeIds: []` (a plan has no change authors);
  `distinct_model` vs `fresh_context` is recorded on the review. The
  reviewer never sees Architect-session content: fresh session, empty event
  list, asserted on actual messages/session in tests.

## Commands and results (exact counts)

Node: `C:\Program Files\nodejs\node.exe`. Tests:
`node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`, per file:

| Suite | tests | pass | fail |
|---|---|---|---|
| planning-contracts | 39 | 39 | 0 |
| planning-projection | 4 | 4 | 0 |
| planning-review (new) | 32 | 32 | 0 |
| planning-state | 37 | 37 | 0 |
| planning-tools | 36 | 36 | 0 |
| runtime-router | 10 | 10 | 0 |
| role-capabilities | 14 | 14 | 0 |
| architect-lifecycle-surface | 6 | 6 | 0 |
| context-assembler | 7 | 7 | 0 |
| context-manifest-store | 12 | 12 | 0 |
| task-scheduler | 8 | 8 | 0 |
| scheduler-store | 31 | 31 | 0 |
| project-docs | 16 | 16 | 0 |
| project-doc-commit | 16 | 16 | 0 |
| replay-compatibility | 3 | 3 | 0 |
| build-runtime (extra, runtime impact) | 28 | 28 | 0 |
| native-build-manager (extra, factory impact) | 58 | 58 | 0 |
| **Total** | **357** | **357** | **0** |

- Typecheck `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. (First run
  exposed 4 import errors in the new test — `WorkerRuntimeDriver`,
  `WorkerAssignment`, `WorkerOutcome` imported from the wrong modules and a
  nonexistent fixture import; fixed to the `task-scheduler.js` exports used
  by `build-runtime.test.ts`, nonexistent import removed.)
- ESLint on all 14 changed files: exit 0, zero warnings. (First run was exit
  0 with 3 unused-import warnings in the new test; removed, re-run silent.)
- Full suite / importer sets not run (controller owns them). No paid/live
  provider calls: all reviewer behavior runs through scripted models.

Named-brief-test mapping (all in `planning-review.test.ts` unless noted):
N6 retiring `:584` + non-retiring `:644`; N2 tool read `:703`, forged
checkpoint `:742`, restart `:812`; request tool `:863`; record-before-verdict
`:949`; vocabulary round-trip `:1039`; record tool `:1127`; source-first
deriving turn `:1179`; omitted obligation `:1251`; weakened `:1308`; blocking
weakened hold + scoped release `:1382`; re-review blindness `:1488`; re-review
order `:1585`; stale verdict `:1718`; missing reviewer `:1857`; fresh-context
fallback `:1956`; unread tail `:1989`; overflow `:2040`; incomplete review
`:2069`; malicious source `:2110`; superficial task / unknown `:2167`; no
phase-order dependency `:2255`; reviewer surface `:2290` (+
`role-capabilities.test.ts` matrix); critic hook `:2391` + low-risk skip
`:2451`; ready path `:2570`; blocking loop `:2626`; no-driver gate `:2711`;
finish E2E `:2762`; plan_only E2E `:2834` (paused handoff then
`selectProjectHandoff`, mirroring the legacy plan_only flow; zero worker
calls including after restart).

## Prove-red records (all restored byte-exact, hashes match)

Method per guard: record file sha256 BEFORE, back up bytes to `/tmp`, mutate
only that guard (needle asserted unique — count 1 — or the run aborts;
injection verified by changed sha256), run the named test only via
`--test-name-pattern` (must go red because the forbidden action SUCCEEDS),
record the exact assertion, restore bytes, verify sha256 matches BEFORE.
Helper: `/tmp/p6-6-mutate-t3b.mjs` (kept for re-run; outside the repo).
Hashes here are LF-byte hashes (mutations ran pre-conversion); the table
hashes are the final CRLF-byte hashes.

1. **N2 durable-read checkpoint gate** — `runner-v2/src/planning-projection.ts`
   BEFORE `bb08d3aab71c95303c862d6fd8232b62d94b50b70ea2c85b72d84747a9474dd5`.
   Mutation: `assertDurableSectionReads(next, checkpoint.coveredSourceSectionIds, "Planning checkpoint");`
   → `if (false) assertDurableSectionReads(...);` (INJECTED `2e5dd7d7…8a52dff`).
   Named test `T3b N2: a direct checkpoint event claiming coverage with zero
   reads is refused by the reducer` (`:742`) went red at `:749`:
   `Missing expected exception` — the forged zero-read checkpoint was
   ACCEPTED. AFTER `bb08d3aa…47dd5` — match.
2. **Record-before-verdict false-stamp refusal** — `planning-projection.ts`
   BEFORE `bb08d3aa…47dd5`. Mutation:
   `if (candidate.recordedBeforePlanOrDiffProvided !== true) {` → `if (false) {`
   (INJECTED `041c1b0f…3ac243c7`). Named test `T3b record-before-verdict...`
   (`:949`) went red at `:1007`: `Missing expected exception` — obligations
   with a forged `recordedBeforePlanOrDiffProvided: false` stamp were
   ACCEPTED. AFTER `bb08d3aa…47dd5` — match.
3. **Re-review early-release refusal** — `planning-projection.ts` BEFORE
   `bb08d3aa…47dd5`. Mutation:
   `if (!recorded || recorded.priorReviewId !== priorReviewId) {` → `if (false) {`
   (INJECTED `c299ca82…7c8a5c2`). Named test `T3b re-review order is
   kernel-enforced...` (`:1585`) went red at `:1642`: `Missing expected
   exception` — the early findings release was ACCEPTED. AFTER
   `bb08d3aa…47dd5` — match.
4. **Unread-tail plan_ready block** — `planning-projection.ts` BEFORE
   `bb08d3aa…47dd5`. Mutation: `if (unreadSections.length > 0) {` →
   `if (false) {` (INJECTED `688c91fe…47fbdec01`). Named test `T3b unread
   source tail blocks ready even with a clean bound review` (`:1989`) went
   red at `:2022`: `Missing expected exception` — `plan_ready` SUCCEEDED
   with `s3` unread. AFTER `bb08d3aa…47dd5` — match.
5. **N6 monotonic filter** — `planning-projection.ts` BEFORE `bb08d3aa…47dd5`.
   Mutation: `.filter((id) => stillExists.has(id))` → `.filter((id) => false)`
   (INJECTED `eeebd1ba…508df7b5`). Named test `T3b N6: a non-retiring
   amendment keeps the old monotonic rule...` (`:644`) went red at `:688`:
   `Missing expected exception` — dropping surviving `s3` was ACCEPTED.
   AFTER `bb08d3aa…47dd5` — match.
6. **Reviewer surface allow-list** — `runner-v2/src/role-capabilities.ts`
   BEFORE `ddba6f9be5589f06158a0b8d64e336e8f42928e02dd0902911e34b0057b2866a`.
   Mutation: added `"fs.write",` to the `verifier:coverage` required list
   (INJECTED `f9941521…7a223c5`). Named test `T3b coverage reviewer surface
   is exactly the read-only allow-list...` (`:2290`) went red at `:2304`:
   `deepStrictEqual` diff `+ 'fs.write'` — the forbidden write tool was
   PRESENT in the surface. AFTER `ddba6f9b…2866a` — match.

Supplementary (honestly recorded, not success-side): removing the reducer's
`if (!recorded) {` branch (`:1300`, INJECTED `19c8fc10…987da46c`) reddens the
`:949` direct-path assertion at `:988` via `TypeError: Cannot read properties
of undefined (reading 'sourceManifestId')` at `:1306`, not via acceptance —
the branch is load-bearing for the clean refusal (restored, hash matches).
The submit tool's own pre-check (`planning-review.ts:576-581`) is therefore
defense in depth behind the reducer: same message, kernel-owned refusal.

Not prove-reddened (no such guard built): the runtime no-driver gate
(`:2711`) asserts the outstanding gate EXISTS — removing the runtime append
fails on a missing event, not on a success, so it has no success-side red.

## Not done / limits

- Full suite and importer sets not run (controller owns them); validation is
  the 17 impact-selected suites above.
- `parseRecordedObligations` normalizes the stored stamp to
  `recordedBeforePlanOrDiffProvided: true as const`: the false-stamp guard
  (prove-red #2) is the only thing preventing a forged stamp from being
  laundered at rest. The normalization matches the T1 derived-obligation
  validator, which rejects any non-true stamp with
  `obligation_not_recorded_before_plan` (`planning-contracts.ts:1516`);
  noted for the reviewer.
- T4 owns the plan→task bridge: the finish E2E (`:2762`) stands scheduler
  tasks in for that bridge at the documented T3a seam (admission dispatches
  against the T3b-produced ready identity).
- Source bytes for the factory-wired reviewer still come from the artifact
  store by digest until T7 provisions the planning source reader (noted at
  the wiring site).
- N-A (true task↔plan membership) stays open as the T3a-recorded T4
  carry-forward; unchanged by T3b.

## Repair cycle 1

Scope: the four blocking findings (B1–B4) plus N1–N6 from
`evidence/T3b-review-r1.md`, under the controller decisions in the repair
brief (obligations are source-derived and plan-independent; blind derivation
only on first review or source change; re-review reuses the blind set;
cumulative open findings; runtime-scoped sessions; bounded suspends).
Reviewer probes inverted into `runner-v2/test/planning-review.test.ts`
(`T3b-R1 …`); all T3b work still uncommitted. Files were normalized LF for
editing and restored byte-identical CRLF before hashing (prove-red
BEFORE/AFTER hashes below are the LF working bytes; the file table holds the
final CRLF bytes).

### B1 — unavailable gate is retryable, never permanent

Finding → design: the gate stalled the run forever (no retry, no Architect,
duplicate request refused). Fix: each step re-attempts the still-current
review; selection re-checks provider cooldown timing (one attempt per step,
no busy loop); any proof of availability (blind derivation, plan delivery,
own view, verdict, suspension count) clears the gate durably; while
unavailable the run stays explicitly `blocked:coverage_reviewer_unavailable`
with the recorded reason in planning-status. Only the N6 exhaustion gate is
terminal (never retried). Transient source-bytes read errors retry the same
way (re-read each attempt).
Change: `runner-v2/src/build-runtime.ts` (`advanceCoverageReview`, gate
retry + terminal check); `runner-v2/src/planning-projection.ts`
(clearing on obligations/plan-delivered/correction-view/suspended/recorded;
new `planning.coverage_plan_delivered`,
`planning.coverage_correction_view_recorded`,
`planning.coverage_review_suspended` events).
Test: `T3b-R1 B1` (restart probe inverted) — broken first runtime records
`source_bytes_unavailable` (0 model calls, gate visible in status);
restarted runtime with a working reviewer records the review, clears the
gate, and reaches `plan_ready`.
Prove-red (gate clearing at all availability sites): BEFORE
`6ad19d62…57c2`, MUTATED `2d1321a3…981c9` (changed: yes) →
`T3b-R1 B1` red: `coverageUnavailable` actual gate object
(reason `source_bytes_unavailable`) vs expected `undefined`
(`strictEqual`); AFTER `6ad19d62…57c2` (restored: yes).

### B2 — re-reviews reuse the blind obligation set; true stamps refused after delivery

Finding → design (controller): blind derivation (source + amendments +
objective/guidance only, fresh session, empty event list) runs for the first
review and again only when the source manifest revision changes. A
plan-only re-review reuses the current blind set bound by id/digest to its
manifest (`reusedFromReviewId`); it never re-derives with the plan. Order:
fresh own-view session (reused obligations + corrected plan, no prior
findings) → durable `record_coverage_correction_view` → release → verdict.
The kernel refuses a `true` stamp recorded after the durable plan-delivery
record for that review.
Change: `runner-v2/src/planning-review.ts` (reuse decision in `review()`,
`runOwnViewPass`, `reusedFromReviewId` through the submit tool,
`latestBlindObligationsForManifest`, `recordCorrectionView`,
`recordPlanDelivered`; derive pass always blind);
`runner-v2/src/planning-projection.ts` (blind-only obligations +
`parseSectionCoverage` call site, plan-delivered refusal, correction-view
record with manifest binding, verdict effective-obligations gate);
`runner-v2/src/agent-prompts.ts` (derive builder takes no plan;
`COVERAGE_REREVIEW_OWNVIEW_INSTRUCTIONS`);
`runner-v2/src/role-capabilities.ts` (third read-only optional tool
`record_coverage_correction_view`); `runner-v2/src/scheduler-store.ts`
(verifier may append the correction-view event).
Tests: `T3b-R1 B2` reuse (ready review's obligations equal the blind set;
deriving turn's actual messages contain source, no plan digest, no
`obligationVerdicts`; exactly own-view + verdict turns; no obligations
event for `coverage_2`; view reuses `coverage_1`; revised plan reaches
ready); `T3b-R1 B2` amendment (new manifest forces a 3-turn derive +
own-view + verdict run; fresh deriving turn has no plan digest; new blind
record bound to `manifest_cov_2`); `T3b-R1 B2` forged stamp (delivery then
true-stamped obligations refused).
Prove-reds: (a) true-stamp refusal — BEFORE `6ad19d62…57c2`, MUTATED
`1955323f…1b2df` → forged-stamp test red: `Missing expected exception`
(forbidden accepted); AFTER restored. (b) reuse — BEFORE `9c07d0cc…2199`
(`planning-review.ts`), MUTATED `28ee0e1b…0303` (`if (blindCurrent)` →
`if (false)`) → reuse test red: `second.status` actual `suspended` vs
expected `reviewed` (`:3153`); AFTER restored.

### B3 — open blocking findings accumulate across all reviews (N1 included)

Finding → design: readiness and re-reviews looked one review back, so an
outstanding F1 vanished. Fix: `openBlockingCoverageFindings` (shared
helper, `planning-projection.ts:989`) collects every blocking finding in
any recorded review not explicitly checked `resolved`; every later
re-review receives the immediate prior's every finding plus all cumulative
open blocking findings (after its own view); verdicts must check each
required id exactly once (`requiredPriorFindingIds`,
`planning-projection.ts:1017`); `plan_ready` requires zero cumulative open
from history (current review's own blocking stays covered by
`computePlanReadiness`). Planning-status lists open findings with
claim/category/review plus the latest outstanding rationale, and blocking
verdicts with obligation text, verdict, and rationale (fixes N1).
Change: `runner-v2/src/planning-projection.ts` (helper, verdict gate,
`plan_ready` cumulative block); `runner-v2/src/planning-review.ts`
(`requiredPriorFindingsForVerdict`, verdict pack + submit ids);
`runner-v2/src/build-runtime.ts` (bound-path cumulative pre-check);
`runner-v2/src/agent-prompts.ts` (`openBlockingFindings`,
`readinessBlockers` in `renderPlanningStatus`).
Tests: `T3b-R1 B3` lineage (F1 probe inverted — review 2 checks F1
outstanding; status shows F1 with claim + rationale and verdict text;
`plan_ready` after review 2 refused `/outstanding: finding-f1/`; review 3
own-view blind to F1, verdict turn sees F1; resolve → ready; open list
empties); `T3b-R1 B3` drop (verdict without F1 refused at review 2 and at
review 3 where F1 is not in the immediate prior's findings).
Prove-red (verdict gate one-back): BEFORE `6ad19d62…57c2`, MUTATED
`85706429…3cc33` → drop test red: `Missing expected exception` (review 3
dropping F1 accepted); AFTER restored.

### B4 — failover opens a new session instead of throwing

Finding → design: the session id ignored the selected runtime, so a cooled
fallback collided with the suspended reviewer's session and threw. Fix: the
session identity includes the reviewer runtime id and independence mode
(`planning-review.ts:1452`); failover opens a fresh session; derive,
own-view, and verdict each scope by runtime.
Change: `runner-v2/src/planning-review.ts` (`coverageSessionId` + all three
pass call sites).
Test: `T3b-R1 B4` (failover probe inverted) — A suspends (1-turn model),
cools down, B completes the same review (`reviewerRuntimeId` B, fresh
derive session distinct from A's suspended session).
Prove-red (runtime-blind identity): BEFORE `9c07d0cc…2199`, MUTATED
`98f3186e…5f75a` → B4 test red: `Error: Recovered coverage session identity
does not match the request.` (the original throw); AFTER restored.

### N2 — readiness blockers hand control to the Architect with the text

Finding → design: the runtime threw out of the step for blockers it never
pre-checked (host record, removal, revision) and for an unknown prior. Fix:
the bound path pre-computes `computePlanReadiness` with the observed host
record; any unreadiness (or a missing provider, an unknown prior, or a
`plan_ready` append failure) records an explicit `plan_ready_blocked`
outstanding gate whose detail is the blocker text (visible in
planning-status `unavailable`) and returns `undefined` so the Architect
runs `plan_required` — never throws. A later revision/request clears the
gate.
Change: `runner-v2/src/build-runtime.ts` (bound path + unknown-prior
handoff).
Test: `T3b-R1 N2` — clean bound review with full reads but an invalid host
record (empty evidence): step returns `progressed:plan_required` (no
throw), Architect runs once, gate `plan_ready_blocked` carries
`independentReviewerSelection` in projection and status.
Prove-red: covered by the N3 blocking/stale reds below (same composite call
site) plus the N2 test asserting the handoff and gate text; no separate
mutation (the guard is the absence of `throw`).

### N4 — every source section is accounted for

Finding → design: the reviewer could silently drop a section. Fix: blind
obligations carry `sectionCoverage` — each manifest section maps to ≥1
recorded obligation id or an explicit `noObligationReason`; the kernel
refuses unknown/duplicate/unaccounted sections and orphan obligations
(`parseSectionCoverage`, `planning-projection.ts:929`); verdicts bind to
the accounted set. Reuse copies the blind set's coverage (no re-entry).
Change: `runner-v2/src/planning-projection.ts` (record shape + gate);
`runner-v2/src/planning-review.ts` (record tool input + validation);
`runner-v2/test/support/planning-seed.ts` + state/tools seeds updated.
Test: `T3b-R1 N4` — obligations missing `s3` refused `/unaccounted/`; the
same set with explicit no-obligation reasons for `s2`/`s3` records and
verdicts.
Prove-red (skip validation): BEFORE `6ad19d62…57c2`, MUTATED
`ecbe4e57…3ac4` → N4 test red: `Missing expected exception`
(`/unaccounted/`, forbidden accepted); AFTER restored.

### N6 — suspended-review retries are bounded (G-5 independent budget)

Finding → design: suspended reviews retried forever. Fix: new
`DEFAULT_COVERAGE_SUSPENDED_RETRY_LIMIT = 3`
(`planning-review.ts:1440`, same constant pattern as the repair limit but
an independent budget per G-5) plumbed as `BuildRuntime`
`coverageSuspendedRetryLimit` (non-negative integer); each suspension is
counted durably (`planning.coverage_review_suspended`); on exhaustion the
runtime records terminal gate `coverage_review_suspended_exhausted`
(`TERMINAL_COVERAGE_GATE_REASONS`) for the owner and never calls the review
again (B1 retry explicitly skips terminal gates).
Change: `runner-v2/src/planning-review.ts` (constant, terminal set,
`recordSuspended`); `runner-v2/src/planning-projection.ts` (suspended
event, attempts); `runner-v2/src/build-runtime.ts` (option, count,
exhaust, no-retry).
Test: `T3b-R1 N6` (limit 2) — first suspend returns
`coverage_review_suspended`; second exhausts to
`coverage_reviewer_unavailable` with the exhaustion gate and attempts 2; a
third step never calls the review again.
Prove-red (never exhaust): BEFORE `00e80ff9…3db3b`
(`build-runtime.ts`), MUTATED `3a00034c…310c2` (`if (false)`) → N6 test
red: actual `coverage_review_suspended` vs expected
`coverage_reviewer_unavailable`; AFTER restored.

### N3 — missing prove-reds (blocking hold, stale, deriving-context, RBV success side)

- Blocking-verdict hold: disabled the composite readiness gate at its
  `plan_ready` call site (the verdict check lives in read-only
  `planning-contracts.ts`). BEFORE `6ad19d62…57c2`, MUTATED
  `e7371cac…2294` → `T3b blocking weakened holds…` red: `Missing expected
  exception` (`/blocking/`, ready wrongly succeeds); AFTER restored.
- Stale verdict: same call site (binding also lives in read-only
  contracts). BEFORE `6ad19d62…57c2`, MUTATED `e7371cac…2294` (same bytes)
  → `T3b stale verdict…` red: `Missing expected exception`
  (`/not the current/`); AFTER restored.
- Reviewer deriving-context: injected the forbidden plan marker into
  `buildCoverageDeriveContext`. BEFORE `49a0556a…fa956`
  (`agent-prompts.ts`), MUTATED `b4b78dff…cba0d` → `T3b reviewer sees only
  the source first…` red: `deriving turn leaks:
  PLAN-TEXT-7f3a9c-plan-only-marker` (actual `true` vs expected `false`);
  AFTER restored.
- Record-before-verdict, success side (no TypeError): the initial-review
  no-record branch falls back to the verdict's own obligations instead of
  throwing. BEFORE `6ad19d62…57c2`, MUTATED `c870eb84…81d8` →
  `T3b record-before-verdict…` red: `Missing expected exception`
  (`/no durably recorded obligations/`, forbidden verdict accepted, no
  `TypeError`); AFTER restored.

### N5 — how RG-6 is reused (shared vs new) and why

Reused (shared, not copied): the `verifier_expectations_recorded` /
`verifier_verdict_submitted` lifecycle signals (obligations, correction
view, and verdict all ride them); `assertFreshContextRequest` /
`assertFreshContextSessionStarted` / `parseReviewerIndependence`
(fresh-context device); `RuntimeRouter.selectVerifier` unchanged (B4 only
adds the selected runtime to the coverage session id); the read-only
inspection tool subset via `createInspectionTools`; and — new in this
cycle — `computePlanReadiness` as the final ready gate in both the reducer
and `BuildRuntime` (the runtime's verdict/finding/read pre-checks remain
only as early Architect handoffs that need no host record), plus the new
shared `openBlockingCoverageFindings` used by the verdict gate, `plan_ready`
(via `requiredPriorFindingIds`), and `renderPlanningStatus`.
New events (`planning.coverage_obligations_recorded` with section
coverage, `planning.coverage_plan_delivered`,
`planning.coverage_correction_view_recorded`, release, verdict,
suspended) instead of reusing `verifier.expectations_recorded`: the
coverage domain needs source binding + section accounting + plan-delivery
ordering + blind-set reuse + cumulative prior lineage, while the verifier
family must not change behavior for existing purposes — extending the
verifier event would risk those flows, so coverage keeps its own
`planning.*` namespace. `planning-contracts.ts` stayed read-only;
coverage-specific payloads live in `planning-projection.ts`.

### Kept intact

Legacy runs unchanged (replay-compatibility green); verifier family and
`selectVerifier` behavior unchanged (no edits to `runtime-router.ts` or
`verifier-*`); G-9 intact (same-pass critic test still asserts zero
`plan_critique` events); coverage reviewer surface stays exactly read-only
(inspection + three lifecycle tools, all `readOnly: true`, `effect: none`).

### Validation (exact commands and counts)

- `& "C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 runner-v2/test/planning-review.test.ts runner-v2/test/planning-tools.test.ts runner-v2/test/planning-state.test.ts runner-v2/test/planning-projection.test.ts runner-v2/test/role-capabilities.test.ts`
  → 133 tests, 133 pass, 0 fail (42 planning-review incl. 10 new `T3b-R1`
  tests; 91 across tools/state/projection/role).
- `& "C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 runner-v2/test/build-runtime.test.ts runner-v2/test/native-build-manager.test.ts runner-v2/test/replay-compatibility.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/architect-lifecycle-surface.test.ts runner-v2/test/project-docs.test.ts`
  → 142 tests, 142 pass, 0 fail (89 runtime/manager/replay; 53
  scheduler/lifecycle/docs). Combined total: 275 pass, 0 fail.
- `& "C:\Program Files\nodejs\node.exe" .\node_modules\typescript\bin\tsc -p runner-v2/tsconfig.json --noEmit`
  → exit 0.
- `& "C:\Program Files\nodejs\node.exe" .\node_modules\eslint\bin\eslint.js` on the 10 repair-touched files
  (6 src + 4 test) → exit 0, no warnings.
- Full suite NOT run per the repair brief (importer suites only).

### File table (final CRLF working bytes; reviewer can tie counts to the tree)

- `c6679ec78d116133ec8b656bfa04f228058fd9236788298865f4761ad34a2973  runner-v2/src/agent-prompts.ts`
- `281d4bb76c2d9e8c25cc3e421152835ea791ff25bbbd0144dbaf1799da2a3fe2  runner-v2/src/build-runtime.ts`
- `f6ceeaf47bd5453b90dc63dead54560dd4f31903a40eaef7a137c77d7b0c087d  runner-v2/src/native-build-factory.ts`
- `384e9dddeedc4a19dfdf4545c065dc960f4effb3aca193d4bfc267bb0834fa97  runner-v2/src/planning-projection.ts`
- `5281b7d076ba332a2d8f80a1c05a844a89d1d8cc1bf861956886804d7f1d871f  runner-v2/src/planning-review.ts`
- `5280ddfb360a521dd4d088df6c1f51c81d10b04ce37721dffa4d7ef430b3a93e  runner-v2/src/planning-tools.ts`
- `c68e26cb59fa2f5aedb90a7de845d929431cacb24ee8da921b6526e8674ea6df  runner-v2/src/role-capabilities.ts`
- `acd0e681f2c214d97aab4a3e697d1f792c67456987ed2e682b41d0e39f14cfc4  runner-v2/src/scheduler-store.ts`
- `517153c660691d7ab7a24852c6e20625819f39e9c8545eac11cb081943041555  runner-v2/test/planning-projection.test.ts`
- `b19eee9f3574b632890e99083a3ba6e44d7d0e428e9fa20430fac41ed72bc346  runner-v2/test/planning-review.test.ts`
- `bc995c627a2c95ad4f94f9fb138ad73163add1818102dfa4ca152729edba3b42  runner-v2/test/planning-state.test.ts`
- `e121c03210b6ae15b2fe95661ccaf2c492e0687eb70e6156940fe2044384f749  runner-v2/test/planning-tools.test.ts`
- `190bb458c5744f711f062223928d2d3346cd58501ca9a92b42ef126f42d84a38  runner-v2/test/role-capabilities.test.ts`
- `0194754cb51a25a0b5c257b8b40b07f6147bd3d558e3bbac712d49f217b4f5ca  runner-v2/test/support/planning-seed.ts`

### Not done

- Full test suite (explicitly out of scope for this cycle; importer suites
  only, 275/275 green).
- `planning-contracts.ts` / `source-manifest.ts` untouched (read-only);
  composite-gate prove-reds therefore mutate the `plan_ready` call site,
  noted above.
- T4 plan→task bridge, T7 source-reader provisioning, and the N-A
  carry-forward remain as recorded before; unchanged by this cycle.
- No commit, stage, stash, push, or PR (all changes left uncommitted).

## Repair cycle 2

Scope: the 3 blocking findings (R2-1, R2-2, R2-3) plus N-R2-1 and N-R2-2
from `evidence/T3b-review-r2.md`. The reviewer's four probes (in
`review-scratch-t3b-r2/probes.part.ts`) are inverted into real regression
tests in `runner-v2/test/planning-review.test.ts` (`T3b-R2 ...`), run the
way production runs where it matters (real SQLite scheduler store with an
advancing clock for R2-1 and R2-3). All T3b work still uncommitted. Five
files changed in this cycle; `native-build-manager.ts` and
`scheduler-store.ts` needed no change (below).

### R2-1 — coverage gates pause with a durable owner-visible reason

Finding → design: every coverage gate returned silent `blocked` while the
run showed `running`, and nothing woke the pump; the N6 terminal gate had
no exit at all. Fix mirrors the verifier's `selection_required` path
exactly, reusing its mechanism (no second mechanism invented): a durable
event flips the run to `paused`, and the step returns `paused`. The
verifier/manager path was checked for a timed wake or retry-after and HAS
NONE — `selectVerifier` only filters by `health.isAvailable`
(`runtime-router.ts`), the manager pumps only on `progressed` and wakes
only on owner actions (`activate`, `selectVerifierRuntime`,
`native-build-manager.ts`), and owner resume flows through
`control-server.ts` → `builds.resume` + `builds.activate`. STATED: no
timed wake; the pause is resumable by the owner's normal resume, and
resume retries the review. Concretely: unavailable / source-bytes /
no-driver / N6-exhaustion gates append runner-actor `run.paused`
(`coverage_reviewer_unavailable`, same shape as
`context_recording_failed`) and return `paused`; a non-terminal
suspension is transient progress (`progressed/coverage_review_suspended`,
mirroring `verifier_provider_failed`) so the pump retries immediately
until the N6 bound, which pauses; the owner's resume appends the new
owner-actor `planning.coverage_review_retry_authorized` event when a
terminal gate is present, clearing it durably and resetting the
suspended-retry count so the next step runs the review again.
Change: `runner-v2/src/build-runtime.ts` (`pauseForCoverageGate`
`:2361`, terminal pause `:2200`, no-driver `:2295`, unavailable `:2326`,
suspend-progress/exhaustion `:2327-2352`, resume clearing `:505-520`);
`runner-v2/src/planning-review.ts` (`authorizeCoverageRetry` `:418-447`);
`runner-v2/src/planning-projection.ts` (retry event `:55`/`:101`/`:131`,
reducer case `:1830-1850`, `TERMINAL_COVERAGE_GATE_REASONS` moved to
`:298` and re-exported from `planning-review.ts:1535`).
Test: `T3b-R2 R2-1` cooldown (`:4110`, SQLite + ticking clock — 429 →
paused with reason, early resume re-pauses with 0 model calls, post
cooldown resume → reviewed → ready); `T3b-R2 R2-1` N6
(`:4203`, SQLite + ticking clock — exhaust → paused → resume clears
gate + attempts (1 user-actor retry event) → fallback review runs →
ready). Every step asserts its status, so the run is never `running`
with zero progress. Updated for the mandated behavior change: no-driver
(`:2779`, now pauses; resume re-pauses without re-recording), B1
(`:3027`, now pauses; resume retries), N6 (`:3884`, suspend is
progressed, exhaustion pauses; bound/never-retry kept).
Prove-red: (a) pause return `paused` → `blocked` — BEFORE
`404c3c14…02a4`, MUTATED `badad9db…722` → cooldown test red: actual
`blocked` vs expected `paused`; AFTER `404c3c14…02a4` (restored).
(b) owner-clear condition → `false && …` — MUTATED `10bd89e8…2ed7` →
N6 test red: actual exhaustion gate object vs expected `undefined`
after resume; AFTER restored.

### R2-2 — a reused finding id is refused (tool path and kernel)

Finding → design (controller decision): the kernel REFUSES a finding id
already used by any earlier review of the same run. With run-unique ids,
the existing id-keyed open/resolved tracking names exactly one finding,
so resolution applies only to the finding it names; no re-keying was
needed. Same rule enforced in the reducer, the submit tool, the runtime
mirror (now the shared helper), `requiredPriorFindingsForVerdict`, and
status (all via `openBlockingCoverageFindings`).
Change: `runner-v2/src/planning-projection.ts`
(`assertFindingIdsUnused` `:1134-1152`, verdict call site `:1722`);
`runner-v2/src/planning-review.ts` (tool-path refusal in
`createSubmitCoverageVerdictTool.execute`); `runner-v2/src/build-runtime.ts`
(mirror via shared helper `:2216-2223`); reviewer prompt
(`agent-prompts.ts:353`, ids unique across reviews).
Test: `T3b-R2 R2-2` (`:4307`, the F1 reuse probe inverted) — review 1
raises blocking F1; review 2 raising a new F1 is refused on the tool
path AND as a direct event (`/reuses finding id F1 from earlier review
coverage_1/`); review 2 raises F2 instead with F1 outstanding; review 3
marks the original F1 `outstanding` (+ F2 resolved); status shows open
`[F1]` and `plan_ready` is refused `/outstanding: F1/`.
Prove-red: verdict call site → `if (false)` — BEFORE `233b7351…70d`,
MUTATED `facf561d…42f4` → R2-2 test red: the reuse sails past the
disabled gate and is refused later for the missing own view (expected
`/reuses finding id F1/`, actual `no durably recorded own view`);
AFTER `233b7351…70d` (restored).

### R2-3 — every coverage gate append is idempotent on SQLite

Finding → design: `recordUnavailable` reused one key with a timestamped
payload (SQLite throws on same-key/different-payload), and de-duped
only against the current gate. Fix, on EVERY gate path (all flow
through `SchedulerCoverageReviewAuthority.recordUnavailable`):
de-duplicate against the durable log (same review + reason + detail +
current revision → skip), a cleared gate re-recorded under a new
deterministic occurrence key (`…:${reason}:${occurrence}`, counted from
the durable log), and a stable payload with NO timestamp (the reducer
falls back to `occurredAt`; old events with `recordedAt`/`updatedAt`
replay identically). `recordSuspended` payload likewise stabilized.
Change: `runner-v2/src/planning-review.ts` (`recordUnavailable`
de-dup `:378-387` + occurrence key `:392-403`, suspended payload);
`runner-v2/src/planning-projection.ts` (timestamp fallbacks `:1804`,
`:1853`).
Test (REAL `SqliteSchedulerStore` + ADVANCING clock): flap (`:4493` —
cooldown → suspended attempt → cooldown again: 2 unavailable events
with keys `:0`/`:1`, payloads without `recordedAt`, gate current;
restart step adds no events; resume-retry de-dupes, still 2 events, no
throw); `plan_ready_blocked` across two steps (`:4598` — records once,
second step de-dupes, no throw, gate detail kept).
Prove-red: (a) de-dup `if (sameGate)` → `if (false)` — BEFORE
`c2fb678f…f1b`, MUTATED `ee2241eb…e42` → plan_ready_blocked test red:
actual 2 events vs expected 1; AFTER restored. (b) occurrence suffix
dropped from the key — MUTATED `4c82f604…253` → flap test red: actual
1 event vs expected 2 (the re-record is swallowed, gate never
re-established); AFTER `c2fb678f…f1b` (restored).

### N-R2-1 — ONE shared readiness input (reducer, pre-check, status)

Finding → design: the runtime pre-check and `renderPlanningStatus`
called `computePlanReadiness` without `amendmentHistory`, diverging
from the reducer after 2+ amendments (`plan_ready_blocked` loop). New
`coveragePlanReadinessInput(planning, priorRevisionId)` builds the full
input — manifest, revision, bound review, prior revision, amendment
history — and all three call sites use it (prior revision stays
call-site-specific: event payload in the reducer, history-derived in
the runtime/status, as before).
Change: `runner-v2/src/planning-projection.ts` (`:806-844`, reducer use
`:1918`); `runner-v2/src/build-runtime.ts` (`:2247-2250`);
`runner-v2/src/agent-prompts.ts` (`:634-645`).
Test: `T3b-R2 N-R2-1` (`:4697`) — two amendments, R-PURGE
`not_applicable` citing amend-1: the step appends `plan_ready`
(pre-check and reducer agree, 0 Architect turns, no gate) and status
carries no amendment blocker.
Prove-red: helper `amendmentHistory: amendmentHistory(planning)` →
`[]` — BEFORE `233b7351…70d`, MUTATED `fc88c076…3f8` → N-R2-1 test
red: actual `plan_required` (gate + Architect loop) vs expected
`plan_ready`; AFTER restored.

### N-R2-2 — findings on retired obligations close as `retired`

THE RULE (stated): an open finding that cites a `requirementId` whose
ledger requirement's EVERY section is structurally absent from the new
manifest closes as `retired` when the owner-authorized
`planning.source_amended` event is reduced — recorded durably in
`planning.coverageRetiredFindings`, shown in status `retiredFindings`,
excluded from open/required/cumulative sets, and refused if cited by a
later verdict. Findings without a requirement id, on unknown
requirements, on requirements with a surviving section, or already
resolved stay open (the reviewer resolves them with a rationale, as
before). Retirement happens ONLY in the `source_amended` reducer case
— the structural N6 rule (no trust in recorded impact) — never
silently, never anywhere else. Reviewer prompt states it
(`agent-prompts.ts:366`).
Change: `runner-v2/src/planning-projection.ts`
(`CoverageRetiredFinding` `:308`, projection field `:381` + init
`:1325`, `retireFindingsForAmendment` `:847-891`, amendment case
`:1363-1373`, open/required exclusions `:1114`/`:1163`, `plan_ready`
cumulative via shared helper `:1903-1912` with the identical message);
`runner-v2/src/planning-review.ts` (`retiredFindingIds` `:153`/`:248`,
verdict-delivery exclusion `:2396`); `runner-v2/src/agent-prompts.ts`
(status `:651`, output `:679`).
Test: `T3b-R2 N-R2-2` (`:4872`) — F1 (req R-PURGE) + F2 (req R-RETRY)
open; s3-retiring amendment → `coverageRetiredFindings` exactly
`{F1 → amend-retire}`, status retired `[F1]`, open `[F2]`; the
amended-source re-review checks only F2 (outstanding) and F2 stays
open; a verdict citing retired F1 is refused `/unknown prior finding/`.
Prove-red: amendment case drops `...retiredFindings` — BEFORE
`233b7351…70d`, MUTATED `5350deef…20a5` → N-R2-2 test red: actual `{}`
vs expected `{F1: …amend-retire…}`; AFTER restored.

### Kept intact (everything round 2 verified)

B2 blind obligations + true-stamp refusal, B4 failover, N1, N4, N6
bound (attempts counted durably, exhaustion terminal and never
auto-retried — only the step statuses changed per R2-1), read-only
reviewer surface (no `role-capabilities.ts` change), legacy runs,
`selectVerifier` (no `runtime-router.ts` change), verifier family (no
`verifier-*` change), G-9 (same-pass critic emits no `plan_critique`
events), replay-compatibility (3/3; old planning events project
identically — timestamp fallbacks preserve values, the shared
cumulative helper is equivalent, the id rule only refuses what old
tests never seeded). `native-build-manager.ts` unchanged: the existing
paused/resume/activate path already surfaces and re-drives coverage
pauses, so no wake was needed. `scheduler-store.ts` unchanged: the new
event is planning-namespaced and the core `run.resumed` case is
untouched.

### Validation (exact commands and counts)

- `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1`
  per suite file (18 files):

| Suite file | tests | pass | fail |
|---|---|---|---|
| runner-v2/test/planning-review.test.ts | 49 | 49 | 0 |
| runner-v2/test/planning-tools.test.ts | 36 | 36 | 0 |
| runner-v2/test/planning-state.test.ts | 37 | 37 | 0 |
| runner-v2/test/planning-projection.test.ts | 4 | 4 | 0 |
| runner-v2/test/role-capabilities.test.ts | 14 | 14 | 0 |
| runner-v2/test/build-runtime.test.ts | 28 | 28 | 0 |
| runner-v2/test/native-build-manager.test.ts | 58 | 58 | 0 |
| runner-v2/test/replay-compatibility.test.ts | 3 | 3 | 0 |
| runner-v2/test/scheduler-store.test.ts | 31 | 31 | 0 |
| runner-v2/test/architect-lifecycle-surface.test.ts | 6 | 6 | 0 |
| runner-v2/test/project-docs.test.ts | 16 | 16 | 0 |
| runner-v2/test/native-verifier-runtime.test.ts | 20 | 20 | 0 |
| runner-v2/test/final-verification-completion.test.ts | 9 | 9 | 0 |
| runner-v2/test/final-verification-execution.test.ts | 8 | 8 | 0 |
| runner-v2/test/final-verification-integrity.test.ts | 11 | 11 | 0 |
| runner-v2/test/final-verification-orchestration.test.ts | 9 | 9 | 0 |
| runner-v2/test/final-verification-repair.test.ts | 13 | 13 | 0 |
| runner-v2/test/final-verification-review.test.ts | 9 | 9 | 0 |
| **Total** | **361** | **361** | **0** |

- `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- `eslint` on the 5 cycle-2 files (4 src + 1 test): exit 0, no warnings.
- Full suite NOT run per the brief (impact-selected suites only: every
  suite importing a file changed this cycle, plus the shared
  pause/resume verifier/final-verification suites).

### File table (final working bytes; 9 files unchanged since cycle 1)

- `485590f43737081dd748685349a3099f2673cfeaebfcdd33cfe382751802f88a  runner-v2/src/agent-prompts.ts`
- `404c3c140631e8d8d6a20290ffb38ec2559fd25e95237b4351aa7833fe5802a4  runner-v2/src/build-runtime.ts`
- `f6ceeaf47bd5453b90dc63dead54560dd4f31903a40eaef7a137c77d7b0c087d  runner-v2/src/native-build-factory.ts`
- `233b7351fc928732c45803f157003c698348edfe262b687942ce82a39ce9d70d  runner-v2/src/planning-projection.ts`
- `c2fb678f07ca9fa939856f623e3cf0020cb211cb49413491b47a1bc50224cf1b  runner-v2/src/planning-review.ts`
- `5280ddfb360a521dd4d088df6c1f51c81d10b04ce37721dffa4d7ef430b3a93e  runner-v2/src/planning-tools.ts`
- `c68e26cb59fa2f5aedb90a7de845d929431cacb24ee8da921b6526e8674ea6df  runner-v2/src/role-capabilities.ts`
- `acd0e681f2c214d97aab4a3e697d1f792c67456987ed2e682b41d0e39f14cfc4  runner-v2/src/scheduler-store.ts`
- `517153c660691d7ab7a24852c6e20625819f39e9c8545eac11cb081943041555  runner-v2/test/planning-projection.test.ts`
- `13283ff1f44a5776fb38900e3b66ceae12d2425a201ffe4312608bd449ad743a  runner-v2/test/planning-review.test.ts`
- `bc995c627a2c95ad4f94f9fb138ad73163add1818102dfa4ca152729edba3b42  runner-v2/test/planning-state.test.ts`
- `e121c03210b6ae15b2fe95661ccaf2c492e0687eb70e6156940fe2044384f749  runner-v2/test/planning-tools.test.ts`
- `190bb458c5744f711f062223928d2d3346cd58501ca9a92b42ef126f42d84a38  runner-v2/test/role-capabilities.test.ts`
- `0194754cb51a25a0b5c257b8b40b07f6147bd3d558e3bbac712d49f217b4f5ca  runner-v2/test/support/planning-seed.ts`

### Not done

- Full test suite (explicitly out of scope; impact-selected suites only,
  361/361 green).
- `planning-contracts.ts` / `source-manifest.ts` untouched (read-only);
  the retired rule routes through the T1 `requirementId` bridge rather
  than a new finding↔obligation link.
- No timed wake at provider `cooldownUntil` (none exists in the
  verifier/manager path; stated above — owner resume retries).
- Findings recorded AFTER an amendment on an already-retired
  requirement stay open (retirement is computed at the amendment event
  only); the reviewer resolves them with a rationale.
- T4 plan→task bridge, T7 source-reader provisioning, and the N-A
  carry-forward remain as recorded before; unchanged by this cycle.
- No commit, stage, stash, push, or PR (all changes left uncommitted).

## Repair cycle 3

Scope: the 1 blocking finding (R3-1) plus N-R3-1 from
`evidence/T3b-review-r3.md`. The reviewer's probes r3-A (same-reviewer
post-retry suspension) and r3-D (stale `plan_ready_blocked` gate) are
inverted into real regression tests in
`runner-v2/test/planning-review.test.ts` (`T3b-R3 ...`), plus the
failover-reviewer variant of r3-A the brief requires. Starting tree
verified BEFORE any edit: all 14 cycle-2 file-table sha256 match
(14/14). Three files changed in this cycle
(`planning-review.ts`, `planning-projection.ts`,
`planning-review.test.ts`); the other 11 T3b files are byte-identical
to cycle 2 (hashes below). All T3b work still uncommitted. CRLF note:
the edit tool cannot match CRLF bytes, so the two source edits and the
test append were applied by byte-exact needle replacement / append via
a scratch node script (needles asserted unique, `/tmp` only, not part
of the deliverable); both files verify 0 lone-LF after the change.
`build-runtime.ts`, `agent-prompts.ts`, `native-build-factory.ts`,
`planning-tools.ts`, `role-capabilities.ts`, `scheduler-store.ts`
needed no change (below).

### R3-1 (BLOCKING) — post-retry suspension keyed into a new retry epoch

Finding → design: `recordSuspended` keyed idempotency on the
projected attempt count
(`coverage:suspended:${reviewId}:${attempts}:${reason}`), but the
owner's retry authorization resets that count, so the first
post-retry suspension reused attempt 1's key: same reviewer → the
store silently returned the old event and the step threw `Coverage
suspension was not durably projected.`; failover reviewer → the store
threw `Scheduler idempotency conflict`. The N6 bound never
re-engaged. Fix (reviewer's option b): the key is now scoped by the
durable count of `coverage_review_suspended` events for that review —
monotonic, never reset, deterministic and replay-safe (a pure
function of the durable log, like `recordUnavailable`'s occurrence).
The projected `attempts` stays in the key for readability and still
drives the N6 bound. Audit of EVERY other coverage idempotency key
for counters the retry resets (it resets exactly
`coverageSuspended[reviewId]` and `coverageUnavailable`): only
`recordSuspended` used one. Safe without change:
`recordUnavailable` and `authorizeCoverageRetry` (occurrence counted
from the durable log, which the retry never resets),
`pauseForCoverageGate` (global monotonic `lastSequence`),
`submitReview` / obligations / correction-view / plan-delivered /
release / `appendPlanReady` (identity-scoped, no counters), and the
`planning-tools.ts` keys (identity-scoped, non-coverage).
Change: `runner-v2/src/planning-review.ts` (`recordSuspended`
`:447-484`; sequence `:464-468`, key `:474`).
Test (REAL `SqliteSchedulerStore` + ADVANCING clock, limit 2):
`T3b-R3 R3-1` (`:5111`, probe r3-A inverted — exhaust → paused with
the exhaustion gate → owner resume (gate + count cleared, `running`)
→ suspend again `progressed`, no throw → exhaust again →
`paused/coverage_reviewer_unavailable` with
`coverage_review_suspended_exhausted`, attempts back to 2, 4 events
with 4 distinct keys → second resume → fifth suspension under a
fifth distinct key); `T3b-R3 R3-1 (failover)` (`:5223` — same shape,
primary cooled after resume so the post-retry suspension comes from
`fallback:reviewer`, i.e. a different payload: `progressed`, no
`Scheduler idempotency conflict`, then exhaustion re-pauses with the
coverage gate).
Prove-red: sequence dropped from the key — BEFORE
`badf89c82759d939d1f20e4445c260cc65e6baecb2e54f8bc8e2acfd5d69e81e`,
MUTATED `ae63da51e025f567ab10ccb1828e026e6dc640f532395608c23f14e7f7775499`
(changed) → both tests red: `Error: Coverage suspension was not
durably projected.` at `recordSuspended` (`planning-review.ts:482`),
and `Error: Scheduler idempotency conflict for
coverage:suspended:coverage_1:1:model_ended_without_lifecycle.`;
AFTER `badf89c8…e81e` (byte-copy restore, matches), re-run green.

### N-R3-1 — a recorded `plan_ready_blocked` gate clears when its blocker is gone

Finding → design: the `plan_ready` reducer refused whenever ANY
`coverageUnavailable` gate was set, so a `plan_ready_blocked` gate
refused its own resolution for the same review, and the runtime's
catch overwrote the original detail with the self-referential
refusal text (probe r3-D). Fix (reviewer's reducer-side option): a
`plan_ready_blocked` gate stamped for the current revision (and the
bound review, when the gate names one) is exempt from the refusal;
readiness re-evaluates the actual blockers below it, and on success
the gate clears durably (`coverageUnavailable: undefined`). Every
other outstanding gate still refuses, and a refusal for real
blockers still records their actual text. No `build-runtime.ts`
change: with the exemption the pre-check path reaches `plan_ready`
directly and the self-referential catch is unreachable in this
scenario. Replay note: previously-accepted logs are unaffected (any
`plan_ready` recorded beside a gate previously threw, so no valid
old log contains that sequence); `replay-compatibility` stays 3/3.
Change: `runner-v2/src/planning-projection.ts` (exemption
`:1886-1902`, durable clear `:1934-1937`).
Test: `T3b-R3 N-R3-1` (`:5320`, probe r3-D inverted — no-caps run
records the gate with the original detail `No host capabilities
provider is configured.`; restart with caps → first step
`progressed/plan_ready`, readiness `ready`, gate `undefined`, still
exactly 1 unavailable event carrying the ORIGINAL detail, 0 further
Architect turns).
Prove-red: `coverageUnavailable: undefined` dropped from the
`plan_ready` success line — BEFORE
`9498fd3307ce8e694d24e8a480fffd2e0db3aa7bfadbdb0ff1ddcb8dc1fe8735`,
MUTATED `148973763c7b0fcc5076451b5280213ac4291797075c4b715f4a306694cbd018`
(changed) → test red: `strictEqual` actual stale-gate object vs
expected `undefined` (`planning-review.test.ts:5388`); AFTER
`9498fd33…8735` (byte-copy restore, matches), re-run green.

### Kept intact (everything rounds 1–3 verified)

R2-1 owner-retry clearing + terminal-gate semantics, R2-2
finding-id uniqueness, R2-3 gate idempotency, N-R2-1 shared
readiness input, N-R2-2 retirement rule (NOTE-1 limit as stated),
B2 blind obligations + true-stamp refusal, B4 failover, N1, N4, N6
bound shape (attempts still counted durably per epoch; only the
suspended-event key gained a durable sequence segment — keys are
opaque to the store and the reducer never reads them),
read-only reviewer surface (no `role-capabilities.ts` change),
legacy / verifier / `selectVerifier` / G-9 (no `runtime-router.ts`,
`native-build-manager.ts`, `planning-contracts.ts`,
`source-manifest.ts` change), NOTE-2 (non-atomic resume appends,
harmless) and NOTE-3 (resolved-once semantics) acknowledged
unchanged.

### Validation (exact commands and counts)

- `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1`
  per suite file (18 files — the cycle-2 impact-selected set, which
  covers every suite importing a file changed this cycle for this
  subset change, including all 8 mandated suites):

| Suite file | tests | pass | fail |
|---|---|---|---|
| runner-v2/test/planning-review.test.ts | 52 | 52 | 0 |
| runner-v2/test/planning-tools.test.ts | 36 | 36 | 0 |
| runner-v2/test/planning-state.test.ts | 37 | 37 | 0 |
| runner-v2/test/planning-projection.test.ts | 4 | 4 | 0 |
| runner-v2/test/role-capabilities.test.ts | 14 | 14 | 0 |
| runner-v2/test/build-runtime.test.ts | 28 | 28 | 0 |
| runner-v2/test/native-build-manager.test.ts | 58 | 58 | 0 |
| runner-v2/test/replay-compatibility.test.ts | 3 | 3 | 0 |
| runner-v2/test/scheduler-store.test.ts | 31 | 31 | 0 |
| runner-v2/test/architect-lifecycle-surface.test.ts | 6 | 6 | 0 |
| runner-v2/test/project-docs.test.ts | 16 | 16 | 0 |
| runner-v2/test/native-verifier-runtime.test.ts | 20 | 20 | 0 |
| runner-v2/test/final-verification-completion.test.ts | 9 | 9 | 0 |
| runner-v2/test/final-verification-execution.test.ts | 8 | 8 | 0 |
| runner-v2/test/final-verification-integrity.test.ts | 11 | 11 | 0 |
| runner-v2/test/final-verification-orchestration.test.ts | 9 | 9 | 0 |
| runner-v2/test/final-verification-repair.test.ts | 13 | 13 | 0 |
| runner-v2/test/final-verification-review.test.ts | 9 | 9 | 0 |
| **Total** | **364** | **364** | **0** |

- `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- `eslint` on the 3 cycle-3 files (2 src + 1 test): exit 0, no output.
- Full suite NOT run per the brief (impact-selected suites only,
  364/364 green; +3 vs cycle 2's 361 are the new `T3b-R3` tests).

### File table (final working bytes; 11 files unchanged since cycle 2)

- `485590f43737081dd748685349a3099f2673cfeaebfcdd33cfe382751802f88a  runner-v2/src/agent-prompts.ts`
- `404c3c140631e8d8d6a20290ffb38ec2559fd25e95237b4351aa7833fe5802a4  runner-v2/src/build-runtime.ts`
- `f6ceeaf47bd5453b90dc63dead54560dd4f31903a40eaef7a137c77d7b0c087d  runner-v2/src/native-build-factory.ts`
- `9498fd3307ce8e694d24e8a480fffd2e0db3aa7bfadbdb0ff1ddcb8dc1fe8735  runner-v2/src/planning-projection.ts`
- `badf89c82759d939d1f20e4445c260cc65e6baecb2e54f8bc8e2acfd5d69e81e  runner-v2/src/planning-review.ts`
- `5280ddfb360a521dd4d088df6c1f51c81d10b04ce37721dffa4d7ef430b3a93e  runner-v2/src/planning-tools.ts`
- `c68e26cb59fa2f5aedb90a7de845d929431cacb24ee8da921b6526e8674ea6df  runner-v2/src/role-capabilities.ts`
- `acd0e681f2c214d97aab4a3e697d1f792c67456987ed2e682b41d0e39f14cfc4  runner-v2/src/scheduler-store.ts`
- `517153c660691d7ab7a24852c6e20625819f39e9c8545eac11cb081943041555  runner-v2/test/planning-projection.test.ts`
- `36f8a6932bfce2dccad87407c3cf631fa06b2ddfcbe8da211edb90f074742db6  runner-v2/test/planning-review.test.ts`
- `bc995c627a2c95ad4f94f9fb138ad73163add1818102dfa4ca152729edba3b42  runner-v2/test/planning-state.test.ts`
- `e121c03210b6ae15b2fe95661ccaf2c492e0687eb70e6156940fe2044384f749  runner-v2/test/planning-tools.test.ts`
- `190bb458c5744f711f062223928d2d3346cd58501ca9a92b42ef126f42d84a38  runner-v2/test/role-capabilities.test.ts`
- `0194754cb51a25a0b5c257b8b40b07f6147bd3d558e3bbac712d49f217b4f5ca  runner-v2/test/support/planning-seed.ts`

### Not done

- Full test suite (explicitly out of scope; impact-selected suites only,
  364/364 green).
- `planning-contracts.ts` / `source-manifest.ts` untouched (read-only);
  no new finding↔obligation link.
- No timed wake at provider `cooldownUntil` (none exists in the
  verifier/manager path — owner resume retries); unchanged by this cycle.
- Findings recorded AFTER an amendment on an already-retired
  requirement stay open (retirement is computed at the amendment event
  only); unchanged by this cycle.
- T4 plan→task bridge, T7 source-reader provisioning, and the N-A
  carry-forward remain as recorded before; unchanged by this cycle.
- Review NOTES 1–3 (retirement-via-ledger-sections, non-atomic resume
  appends, resolved-once semantics) acknowledged; unchanged by this cycle.
- No commit, stage, stash, push, or PR (all changes left uncommitted).
