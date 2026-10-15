# T3b independent review r2 (source-coverage review gate, after repair cycle 1)

Reviewer: Opus (independent; did not write T3b or the repair; no memory of r1 beyond the r1 file).
Worker: Muse. Date 2026-09-24. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`,
branch `codex/runner-v2-p6-6`, base `630dba59`, T3b + repair 1 uncommitted (11 modified + 3 untracked).
No source or test file was edited. Probes are in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t3b-r2\` (`probe.test.ts` = the current
`planning-review.test.ts` with absolute imports + 4 `PROBE r2-*` tests in `probes.part.ts`;
`mutate.mjs` = the byte-exact mutate/restore helper; run logs `probe-run2.txt`, `provered-b2.txt`).

## Scope

Requirements first: `t3b-brief.txt`, `t3b-repair1.txt` (including the controller decision:
obligations are source-derived and plan-independent), `T3b-review-r1.md`; plan T3 and §5.0; ledger
EP05, EP33, EP34, EP42, EP44; owner amendment OA-1, OA-2, OA-3, OA-10.
Code: full T3b diff, focusing on `build-runtime.ts advanceCoverageReview`, `planning-review.ts`
(authority, `review()`, derive/own-view/verdict passes, tools), `planning-projection.ts` coverage
reducer cases and the B3 helpers, `agent-prompts.ts renderPlanningStatus`, `native-build-factory.ts`
wiring. Cross-read: `native-build-manager.ts` pump loop, `cli-lifecycle.ts`, `control-server.ts`
resume path, `sqlite-scheduler-store.ts` idempotency rule, `planning-contracts.ts computePlanReadiness`,
`source-manifest.ts manifestResolvesAmendmentRef`, `provider-health.ts`.
Claims last: `evidence/T3b.md` "Repair cycle 1".

## Verification of round-1 findings

| r1 finding | Status | Evidence |
|---|---|---|
| B1 unavailable gate never clears | **partly fixed** | Retry on each step and clearing via obligations/delivery/view/verdict/suspension are real; restart with a working reviewer reaches ready (worker test `T3b-R1 B1`). But (a) steps only happen when something wakes the pump, and a `blocked` result is invisible to the owner (new BLOCKING R2-1); (b) the N6 terminal gate has no owner resolution at all (R2-1); (c) the second recording of the same gate throws on the real store (new BLOCKING R2-3). |
| B2 re-review derives with the plan | **fixed** | Re-review reuses `latestBlindObligationsForManifest` bound by manifest id+digest (reducer re-checks at correction view and verdict, `planning-projection.ts` correction-view case and `coverage_review_recorded` effective-obligations gate); a source change forces a fresh blind derive in a fresh runtime-scoped session; plan delivery is durably recorded before the model sees the plan in both the own-view and verdict passes; the reducer refuses a `true`-stamped obligations event after delivery for that review. Prove-red reproduced (below). Stale/other-run reuse is refused (run-scoped store, manifest id+digest check). A forged direct obligations event for a review with no delivery record cannot be distinguished by the kernel (NOTE-1, same trust class as r1 NOTE-2). |
| B3 outstanding findings dropped | **partly fixed** | Cumulative lineage, delivery of all open findings after the own view, `requiredPriorFindingIds`, and the `plan_ready` cumulative block are real and tested. But open/resolved is keyed on the model-chosen finding id, so a reused id launders an explicitly outstanding blocking finding to ready (new BLOCKING R2-2, probed). |
| B4 failover throws | **fixed** | `coverageSessionId` includes runtime + independence for derive, own-view, verdict; `T3b-R1 B4` shows B completing after A suspends; A's suspended session is never loaded by B. |
| N1 status text | fixed | `renderPlanningStatus` shows obligation text, verdict, rationale, open findings with claim and outstanding rationale. |
| N2 no throw out of step | **not met on the real store** | The in-process handoff works, but `recordUnavailable` itself throws on the second identical gate (R2-3). Also the runtime pre-check diverges from the reducer (N-R2-1). |
| N3 prove-reds | fixed (evidence) | All required prove-reds recorded; I reproduced the B2 true-stamp one. |
| N4 section accounting | fixed | `parseSectionCoverage` refuses unknown/duplicate/unaccounted sections and orphan obligations; verdict set must equal the recorded set. |
| N5 RG-6 rationale | fixed (evidence) | Rationale recorded; acceptable. |
| N6 bounded suspends | bound fixed; **terminal gate is a dead end** | Counted durably, exhausts at the limit, never retried. But nothing the owner can do clears it (R2-1). |

## New findings

### BLOCKING

**R2-1: A coverage gate stalls the run without any sign the owner can see. The N6 terminal gate
cannot be cleared by the owner at all.**
`build-runtime.ts:2181, 2284, 2315, 2333, 2335` return `{status:"blocked"}` for every coverage gate
and suspension. The manager's pump loop continues only on `progressed`
(`native-build-manager.ts:740-748`). `syncAutonomousBuildLifecycle` ignores `blocked`
(`cli-lifecycle.ts:27-47`). So the supervisor and the UI keep showing the run as `running`, and no
pump runs again. The "retry on each step" in the repair only happens when something unrelated wakes
the run, for example a restart, user guidance, an answer to an Architect question, or a pause
followed by a resume. There is no wake at `cooldownUntil`.
- **Scenario:** a single reviewer gets a 429 on its first attempt. The run sits "running" and never
  retries until the runner restarts or the owner happens to pause and resume. Nothing tells the owner
  to do that; the gate is only in the projection and in the Architect's planning status.
- **Terminal case:** `coverage_review_suspended_exhausted` returns blocked before the reviewer or the
  Architect is consulted. Nothing clears it except a new request (which needs the Architect, who never
  runs) or a source amendment. Pause/resume and restart just re-hit it.
- **Probe:** `PROBE r2-N6 terminal`, 1/1 pass. Three steps with a working reviewer after the terminal
  gate gave `blocked:coverage_reviewer_unavailable`, 0 Architect turns, 0 reviewer calls, and run status `running`.
- **Why this is blocking:** the repair brief item 1 explicitly required "not a silent `blocked` forever" and a
  status visible to the owner. N6 required a gate "for the owner", and an owner gate with no owner
  action is a permanent deadlock.
- **Minimal fix:** follow the verifier pattern (`build-runtime.ts` `verifier.selection_required` →
  `paused`). Unavailable, suspended and exhausted coverage gates should return `paused` with a durable reason, so the
  supervisor surfaces them and an owner resume re-drives the retry. Give the terminal gate an owner
  action that clears it, for example resume or a verifier-runtime selection appending a request-scoped retry
  event. Optionally also schedule a wake at the provider's `cooldownUntil`.

**R2-2: Open/resolved status is keyed on the reviewer-chosen finding id, so a reused id launders an
explicitly outstanding blocking finding to ready (B3/EP44).**
`openBlockingCoverageFindings` (`planning-projection.ts:989-1011`), the `plan_ready` cumulative
block (`:1720-1735`), the runtime bound-path mirror (`build-runtime.ts:2195-2207`) and
`requiredPriorFindingsForVerdict` (`planning-review.ts:2290-2316`) all build one global
`resolved` set of `priorFindingId`s from every check ever recorded. A finding id is unique only
within one verdict (`planning-review.ts:1014`); nothing refuses an id already used by an earlier
review. Models routinely number findings per review ("F1").
- **Scenario (probe `PROBE r2-B3 collision`, 1/1 pass, through the real reviewer runtime):**
  1. Review 1 raises blocking `F1` (purge missing).
  2. Review 2 checks `F1` resolved and raises a new blocking `F1` (retry weakened).
  3. Review 3 checks `F1` **outstanding** ("RETRY still lacks backoff"), with no own blocking items.
- **Result:** planning status `openBlockingFindings` is `[]` and `planning.plan_ready` is **accepted**
  (readiness `ready`). The resolution of the old F1 closes the new one.
- **Related:** "resolved once, resolved forever" also ignores a later `outstanding` check of the same id.
- **Minimal fix:** give findings a lineage-unique identity. Either refuse (tool plus reducer) a finding id
  already present in any recorded review, or key open/resolved by `reviewId:findingId`, with the
  latest check of that key deciding. Apply the same rule in the reducer, the runtime mirror,
  `requiredPriorFindingsForVerdict` and `renderPlanningStatus`. Add the probe as a regression test.

**R2-3: The second recording of the same coverage gate throws out of `step()` on the real SQLite
store. This affects the B1 retry path and the N2 hand-off path.**
`SchedulerCoverageReviewAuthority.recordUnavailable` uses the key
`coverage:unavailable:${reviewId}:${reason}` (`planning-review.ts:366`), and the payload carries
`recordedAt`. `SqliteSchedulerStore` throws `Scheduler idempotency conflict` when a key is reused
with a different payload (`sqlite-scheduler-store.ts:113-125`). The in-memory test store silently
returns the old event, and every T3b test uses a fixed `CLOCK`. That is why no test sees this.
- **Path (a), reviewer flap:** `NativeCoverageReviewRuntime.recordUnavailable` de-duplicates only
  against the *current* gate (`planning-review.ts:1608`). Any clearing event in between (obligations,
  delivery or suspension) makes the next identical gate throw.
  - **Probe** `PROBE r2-idem flap`, 1/1 pass, real `NativeCoverageReviewRuntime` + `BuildRuntime` + SQLite:
    1. The provider is in cooldown, so the gate is recorded.
    2. After the cooldown, the attempt suspends and the gate clears.
    3. The provider is in cooldown again.
  - **Result:** `step()` threw `Scheduler idempotency conflict for coverage:unavailable:coverage_1:no_independent_healthy_capability_match.`
  - **Impact:** the manager pauses the run with `autonomous_pump_error`, and every resume throws again while the provider is cooling.
- **Path (b), `plan_ready_blocked`:** `build-runtime.ts:2217/2239/2256` record the gate on every step
  with no de-duplication.
  - **Probe** `PROBE r2-idem plan_ready_blocked`, 1/1 pass: step 1 is `progressed:plan_required` (the
    Architect runs once without revising); step 2 threw `Scheduler idempotency conflict for coverage:unavailable:coverage_1:plan_ready_blocked.`
  - **Impact:** this throw happens before the Architect is invoked again, so every resume throws. The run is
    permanently stuck unless the Architect revised in that single turn.
- **Minimal fix:** de-duplicate against the durable history, not only the current gate. Alternatively, make the key
  attempt-scoped (for example `…:${reason}:${attemptOrSequence}`) or drop timestamps from the keyed payload. Add a
  SQLite + ticking-clock regression test for both paths.

### NON-BLOCKING

- **N-R2-1: the runtime's readiness pre-check diverges from the reducer.** `build-runtime.ts:2231`
  calls `computePlanReadiness` without `amendmentHistory`, while the reducer passes
  `amendmentHistory(next)` (`planning-projection.ts` `plan_ready`). After two or more amendments, a
  revision that validly cites an earlier amendment gets the runtime blocker "does not resolve against the manifest's amendment chain".
  - **Cited as:** a not-applicable disposition, a non-normative section, or the first removal record after a
    second amendment (`source-manifest.ts:426-433`).
  - **Result:** `plan_ready_blocked` → an Architect loop the Architect cannot fix by revising, and with R2-3 a
    pump-error pause on the next step.
  - **Other places:** `renderPlanningStatus` has the same omission.
  - **Fix:** pass `amendmentHistory` in both places. Not probed; the mechanism is from code.
- **N-R2-2: the retired-obligation rule is unstated.** After a source amendment, prior blocking findings stay open and must be
  checked by the fresh-derivation re-review even when the obligation they cite was retired (the
  reviewer has to mark them `resolved` with a rationale). That rule is coherent but not stated in the
  evidence or the reviewer prompt; state it.

### NOTES

- NOTE-1: the kernel refuses a `true` stamp only when a delivery record exists for that review. A
  direct runner/verifier-actor obligations event for a review with no delivery record is accepted as blind. This is trusted code;
  the tool path is sound (same class as r1 NOTE-2).
- NOTE-2: the B1 regression test proves only restart recovery. No test drives an in-process retry
  through the manager (this is the gap behind R2-1).
- NOTE-3: the B3 tests are genuine (the lineage test runs the real reviewer runtime; the drop test seeds
  events but asserts the reducer, which is the code under test). No test uses a colliding id.

## Commands and results

- **Tree identity:** `sha256sum -c` over the 14 files in "Repair cycle 1": **14/14 OK**, both before
  and after my mutation. The worker suites were not re-run (owner rule). Their counts (133 + 142 = 275 pass, tsc 0,
  eslint 0) are tied to this tree by those hashes.
- **Probes:** `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 --test-name-pattern "^PROBE" <scratch>\probe.test.ts`
  gave tests 4, pass 4, fail 0. Each probe asserts that the defect exists:
  - `PROBE r2-B3 collision`: review-3 check `F1 outstanding`; `openBlockingFindings []`; plan_ready accepted, readiness `ready`.
  - `PROBE r2-idem plan_ready_blocked`: step1 `progressed:plan_required`, step2 threw the idempotency conflict.
  - `PROBE r2-idem flap`: step1 blocked (gate), step2 `blocked:coverage_review_suspended` (gate cleared, 1 model call), step3 threw the idempotency conflict.
  - `PROBE r2-N6 terminal`: 3× `blocked:coverage_reviewer_unavailable`, 0 Architect turns, 0 reviewer calls, run status `running`.
- **Prove-red reproduction (B2 true-stamp refusal), `planning-projection.ts`:**
  - BEFORE: `384e9dddeedc4a19dfdf4545c065dc960f4effb3aca193d4bfc267bb0834fa97` (CRLF; needle count 1).
  - Injection: `if (next.coveragePlanDelivered[reviewId]) {` → `if (false && next.coveragePlanDelivered[reviewId]) {`.
  - INJECTED: `0ce7e4d0716a2aa0c90886556a6956ecea3294ffb32c4606fb069c60f9168ed8` (changed: true; grep shows line 1396 mutated).
  - Result: test `T3b-R1 B2: a forged true stamp recorded after plan delivery is refused` gave pass 0 / fail 1,
    `AssertionError: Missing expected exception.` at `planning-review.test.ts:3312` (the forged true stamp was accepted).
  - Restored by byte copy. AFTER: `384e9dddeedc4a19dfdf4545c065dc960f4effb3aca193d4bfc267bb0834fa97`, which matches.
  - Re-run unmutated: tests 1, pass 1, fail 0.
- `git status --short` after the review: the same 11 modified + 3 untracked files; only this review file was added.

## Verdict

Repair cycle 1 fixed B2 (blind obligations, true-stamp refusal, source-change re-derivation) and B4
(runtime-scoped sessions), and delivered N1, N4 and N6-bound. The coverage gate is still not live in a
running process. A blocked gate is invisible to the owner, and the terminal gate has no exit (R2-1). Re-recording a
gate crashes the step on the real store (R2-3). Cumulative finding tracking can be defeated by an ordinary
finding-id reuse (R2-2).

T3b REVIEW r2 — REPAIR REQUIRED — 3 blocking
