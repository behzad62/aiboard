# T3b independent review r1 (source-coverage review gate)

Reviewer: Opus (independent; did not write T3b). Worker: Muse. Date 2026-09-24.
Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`,
base `630dba59`, T3b uncommitted (11 modified + 3 untracked files). No source or test file was
edited. Scratch probes live outside the repo in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t3b\` (`probe.test.ts` is a copy of
`planning-review.test.ts` with absolute imports plus 4 `PROBE` tests; `mutate.mjs` is the byte-exact
mutate/restore helper).

## Scope read

Requirements first: worker brief `t3b-brief.txt`; plan §2, §3, §5.0 (G-4, G-6, G-7, G-9), T3 in full,
ledger rows EP05, EP06, EP07, EP33, EP34, EP42, EP44; owner amendment OA-1, OA-2, OA-3, OA-10;
progress.md T3a carry-forwards (N2, N6, N-A).

Code: the full `git diff` (agent-prompts, build-runtime, native-build-factory, planning-projection,
planning-tools, role-capabilities, scheduler-store, 4 test files) and the new files
`planning-review.ts`, `planning-review.test.ts`, `test/support/planning-seed.ts`. Cross-read:
`planning-contracts.ts` (CoverageReview, vocabularies, `computePlanReadiness`,
`coverageReviewHoldsReadiness`), `runtime-router.ts selectVerifier`, `provider-health.ts`,
`native-verifier-runtime.ts createInspectionTools`, `evidence-tools.ts inspect_evidence`,
`artifact-tools.ts`, `git-tools.ts`, `integration-manager.ts` (project-doc branch),
`native-build-manager.ts` (blocked/throw handling), `build-runtime.ts dispatchStep`.

Claims last: `evidence/T3b.md`.

## What T3b must / must not do (written before reading code)

Must: N6 fix (one stated rule, retiring and non-retiring cases, old logs replay); N2 durable reads
bound to manifest revision + section digest, reducer refuses a direct checkpoint without reads;
coverage reviewer chosen by unchanged `selectVerifier`, independence recorded durably; fresh session,
empty event list; deriving pass sees ONLY source + amendments (+ objective, durable guidance) and
records obligations durably BEFORE any plan is delivered, on every channel (pack, prompt, messages,
tool results, session, replay, checkpoint, tool surface); kernel refuses a verdict without recorded
obligations (tool + direct event); one verdict per obligation, separate verdict/category
vocabularies, existing eight valid, never-exercised → `weakened`; all sections accounted for;
overflow/incomplete → blocked; readiness only when bound to exact plan digest + manifest revision
with no blocking missing/weakened (non-blocking weakened does not hold); stale on amendment and on
revision; unavailable reviewer = explicit outstanding gate, never self-review, never relabelled;
re-review records its own view before receiving prior findings (kernel-enforced); Architect tool to
request review; exact read-only reviewer surface; legacy unchanged; G-9 intact.
Must not: edit planning-contracts/source-manifest; change verifier behavior for existing purposes;
add a selector; add a second authority; touch T4+ files.

## Requirement checklist

| Requirement | Status | Evidence |
|---|---|---|
| N6 rule (monotonic over still-existing sections) | met | `planning-projection.ts` `assertMonotonicCheckpoint(prev,next,stillExists)`; tests :584 retiring, :644 non-retiring; prove-red #5 |
| N2 durable read events + reducer refusal of direct zero-read checkpoint | met (see NOTE-2) | `planning.source_section_read`, `sourceReadIndex`, `assertDurableSectionReads`; test :742; prove-red #1 reproduced by me |
| Reviewer via unchanged `selectVerifier`; independence recorded | met | `planning-review.ts` `review()` → `selectVerifier(...)`; review.independence; test :1956 |
| Fresh session, empty event list (initial review) | met | `assertFreshContextRequest` / `assertFreshContextSessionStarted` on create; session id per pack digest |
| EP33 deriving turn source-only, obligations recorded before plan | **met for the initial review, NOT met for every re-review** | B2 |
| Tool surface blind in deriving turn | met (NOTE-5) | `verifier:coverage` = artifact.read, fs.*, git.diff/log/show/status, inspect_evidence + the two lifecycle tools; no channel found that yields plan text before obligations |
| Record-before-verdict, tool + direct event | met | reducer `planning.coverage_review_recorded` requires request + `coverageObligations[review.id]` + matching sets; test :949 |
| RG-6 device reused (G-7) | partial | shape and lifecycle signals reused; new `planning.coverage_*` events and a second gate in `planning-projection.ts` rather than `record_verification_expectations` (N5) |
| EP34 vocabulary, eight still valid, never-exercised → weakened, scope_creep/unverified_claim outside verdicts | met | tool validators on `COVERAGE_VERDICT_VALUES` / `PLANNING_FINDING_CATEGORIES`; tests :1039, :1308 |
| All source sections accounted for; overflow/incomplete → blocked | partial | overflow → gate (:2040), never-records → suspended (:2069), unread tail → plan_ready refused (:1989); reviewer is never required to account for each section (N4) |
| EP44 blocking missing/weakened holds; non-blocking weakened does not | met for one review; **lineage broken across re-reviews** | tests :1382, :1308; B3 |
| Stale verdict on source amendment and plan revision | met | request/obligation/verdict staleness checks + T1 binding; test :1718 |
| Unavailable reviewer = explicit outstanding gate, never self-review | met as a record; **not live** — the gate can never clear | B1 |
| EP42 re-review own view before prior findings, kernel-enforced | met for ordering | release refused before own view, verdict refused before release; tests :1488, :1585; prove-red #3 |
| Architect lifecycle tool + surface/universe | met | `request_coverage_review` in `PLANNING_TOOL_NAMES`, `ARCHITECT_LIFECYCLE_SURFACE` |
| Reviewer surface exact, read-only | met | `role-capabilities.ts` `verifier:coverage`; test :2290; prove-red #6 |
| END-TO-END source reads → ready → admission; plan_only zero worker calls incl. restart | partial (NOTE-3) | runs through real planning tools and `BuildRuntime.step`; admission dispatches seeded scheduler tasks `a`/`b`, not plan tasks (T4 bridge, N-A); restart only after the completion pause |
| Legacy runs unchanged; G-9 intact | met | only `planningPolicyVersion === 1` path; `applyPlanCritiqueRequested` untouched; scheduler-store +1 line |
| Forbidden files untouched | met | planning-contracts.ts, source-manifest.ts, verifier family, runtime-router unchanged |

## Findings

### BLOCKING

**B1 — An unavailable-reviewer gate for the current revision can never clear; the run deadlocks,
including after restart with a working reviewer.**
`build-runtime.ts` `advanceCoverageReview` (the `unavailable.planRevisionId === revisionId` branch)
returns `blocked: coverage_reviewer_unavailable` before the reviewer driver or the Architect is
consulted. The projection clears the gate only on a new `coverage_review_requested` or a recorded
review. A new request needs the Architect (never invoked from this branch; `dispatchStep` returns the
blocked result before `runArchitect`), and the default `request_coverage_review` id for the same
revision is refused anyway (`coverage_review_already_requested`). Nothing re-runs the review.
Realistic triggers, all transient: a reviewer provider in cooldown after one failure
(`selectVerifier` filters on `health.isAvailable` → `no_independent_healthy_capability_match`), a
source-byte read error (`source_bytes_unavailable`; the factory reads from the artifact store until
T7), or a first start without a driver. Probe `PROBE deadlock` (scratch): first runtime records
`source_bytes_unavailable` for `revision_1`; a restarted `BuildRuntime` with a working reviewer then
returns `blocked:coverage_reviewer_unavailable` on 5/5 steps, with 0 Architect calls and 0 reviewer
model calls; readiness stays `not_ready` forever. The worker's tests clear the gate only with
directly seeded events (:1857) or assert the block persists (:2711).
Minimal fix: treat the gate as outstanding but retryable. On each step, re-attempt the review of the
still-current request when the recorded reason can have changed (health, bytes, driver present), and
append a request-scoped retry event or let a later successful review clear it; and/or hand control to
the Architect with the gate visible so it can re-request. Add a restart test with a now-working
reviewer.

**B2 — Every re-review derives its obligations with the corrected plan in view, yet records them as
`recordedBeforePlanOrDiffProvided: true`; the ready verdict after any revision rests on
plan-contaminated obligations (EP33 / OA-1).**
`planning-review.ts` `runDerivePass` passes `planUnderCorrectionJson` (the full plan revision) into
the deriving pack when `isReReview`, and `record_coverage_obligations` stamps every obligation
`recordedBeforePlanOrDiffProvided: true` unconditionally; the reducer accepts the stamp as given.
Because readiness binds the latest review, every plan that needed one revision reaches ready on
obligations derived by a reviewer that had already read the plan — the exact bias OA-1 removes
("a coverage reviewer handed the plan first becomes a plan reader") — and the durable record claims
the opposite. The worker's own test :1488 asserts the re-review deriving turn contains
`revisionTwo.digest`. Probe `PROBE re-review ...` (scratch): through `BuildRuntime` the ready review
`coverage_revision_2` was derived in a turn containing the plan digest and a task criterion text,
and all three obligations carry `recordedBeforePlanOrDiffProvided: true`.
Minimal fix: split the re-review into (1) a source-only deriving pass in a fresh session that records
obligations (identical to the initial review), (2) a correction-view step that receives the corrected
plan and records the own view (a separate durable event), (3) release of prior findings, (4) verdict.
The reducer then requires obligations → correction view → release → verdict. (Alternative: carry the
prior review's blind obligations forward when the manifest is unchanged, and record only the
correction view with the plan.)

**B3 — A blocking prior finding that the re-review marks `outstanding` is silently dropped by the next
revision; readiness is reached with the finding still unresolved on record (EP44, EP05, OA-10 #5).**
The kernel checks prior findings only one generation back: `plan_ready` requires resolution of the
blocking findings of `coverageReview.priorReviewId`, and the next re-review receives only the
immediate prior review's own `findings`. A finding carried as `outstanding` in a check (and not
re-emitted as a new finding) is not in the next prior set. Probe `PROBE lineage` (scratch): review 1
raises blocking `finding-f1`; review 2 checks it `outstanding` with no own findings (plan_ready
correctly refused: `outstanding: finding-f1`); the Architect revises once more; review 3 is never
shown F1 (verdict context has no F1 text) and `plan_ready` is accepted — readiness `ready`.
Aggravating: `renderPlanningStatus` never shows outstanding prior checks, so the Architect is not
even told why review 2 held readiness.
Minimal fix: derive the prior-finding set for a re-review as every blocking finding in the lineage
not yet checked `resolved` (the previous review's findings plus its `outstanding` checks), deliver
that set after the own view, require a check for each, and apply the same rule in `plan_ready` and
`advanceCoverageReview`; show outstanding checks in planning status.

**B4 — OA-3 failover to a fallback reviewer throws on retry.**
`coverageSessionId(runId, reviewId, packDigest, mode)` does not include the selected runtime. If a
pass on reviewer A suspends (provider error, or model ends without the lifecycle tool) and A is then
in cooldown, the retry selects fallback B, finds A's session under the same id, and throws
`Recovered coverage session identity does not match the request` (or the fresh-context variant).
The throw escapes `step()`; the manager pauses the run with `autonomous_pump_error`, and every resume
throws again until A is healthy (24 h for an authentication failure, 1 h for a usage limit) — the
fallback path OA-3 requires never runs. Probe `PROBE failover` (scratch): first attempt `suspended
model_ended_without_lifecycle` on `google:reviewer`; after `recordFailure("google", rate_limit)` the
retry threw that exact message.
Minimal fix: include the selected runtime id (and independence) in the session id, or on an identity
mismatch start a new fresh session for the new runtime (recording the abandoned one); add a failover
test.

### NON-BLOCKING

- **N1 — Architect cannot see what to fix.** `renderPlanningStatus` (`agent-prompts.ts`) lists
  blocking verdicts as `{obligationId, verdict}` only — no obligation description, no rationale —
  and omits prior-finding checks. A blocking verdict without a matching finding gives the Architect
  an opaque id; plausible repeated revise/re-request loops that burn budget. Fix: include obligation
  description + rationale and outstanding checks.
- **N2 — `appendPlanReady` failures escape the step.** `advanceCoverageReview` mirrors only part of
  the reducer's `plan_ready` gate; any other `computePlanReadiness` blocker (revision validation,
  requirement-removal vs prior revision, host capabilities) makes `store.append` throw out of
  `step()` (pump error pause) instead of returning control to the Architect with the blocker. Fix:
  pre-compute `computePlanReadiness` and return `undefined` (Architect) with blockers in status.
- **N3 — Prove-red coverage incomplete against the brief.** Of the six required prove-reds, missing:
  blocking-verdict readiness hold, stale-verdict invalidation, reviewer-context-has-no-plan-text; the
  main record-before-verdict branch went red only via a `TypeError` (the verdict was still refused),
  i.e. no success-side red for that gate. I ran the reviewer-context one myself (below): it goes red
  properly, so this is an evidence gap, not a broken guard. Add the remaining two.
- **N4 — "All source sections accounted for" is delivery-only.** Every section is a required pack
  entry and digest-verified (good), but obligations carry no section reference and the reducer does
  not require each section to be cited by an obligation or declared non-normative by the reviewer; a
  reviewer recording one obligation for a many-section source passes. T3 checkbox 3 ("all source
  sections accounted for; incomplete review blocks readiness") is only partly enforced.
- **N5 — RG-6 reused by shape, not by device.** The plan says reuse `record_verification_expectations`
  and its reducer gate "rather than inventing a second mechanism"; T3b adds `planning.coverage_*`
  events with a parallel gate. Existing verifier behavior is untouched (good), but the evidence
  does not say why direct reuse was infeasible. Record the rationale or align.
- **N6 — Suspended reviews retry unbounded.** Each wake re-runs the suspended session with a fresh
  `maxTurns`; only the budget ledger stops it; no escalation to an outstanding gate.

### NOTES

- NOTE-1: N2 makes T2/T3a-era planning logs with `checkpoint_recorded`/`plan_ready` but no read
  events non-replayable (the worker re-seeded those fixtures). Unshipped branch, so acceptable, but
  the evidence's "old logs replay identically" applies only to N6.
- NOTE-2: `planning.source_section_read` is accepted on public digests alone; the reducer cannot
  verify a read happened. Direct append is trusted runner code, so this only moves the N2 forgery one
  event earlier; the tool path is sound.
- NOTE-3: The finish E2E proves readiness unblocks admission, but dispatches seeded scheduler tasks
  `a`/`b`, not tasks of the ready plan (T4 bridge / N-A). The plan_only restart is after the
  completion pause; no runtime-level restart mid-review is tested.
- NOTE-4: Re-review deriving/own-view turns receive Architect free text (`planningDecisions`) that
  may paraphrase prior findings; inherent to showing the correction, not kernel-enforceable.
- NOTE-5: Reviewer `git.show`/`git.diff` accept any valid revision; project docs (possibly plan text)
  are committed to `aiboard/<safeName(runId)>/integration`, whose name includes a sha256 fragment of
  the run id, so it is not discoverable from the reviewer's context. No working channel found.
- NOTE-6: Test :1179 — the `PLAN_ONLY_MARKER` assertions are vacuous (the marker is not in the plan,
  per the test's own comment) and the checkpoint assertion is conditional; the revision id/digest and
  criterion-text assertions are real and do fail under mutation.
- NOTE-7: Production reviewer reads source bytes from the artifact store until T7; with B1 unfixed,
  any run whose source bytes are not in that store deadlocks at its first review.

## Commands and results

Tree identity: `sha256sum` of all 14 files listed in `evidence/T3b.md` — **14/14 match** the recorded
values (e.g. planning-review.ts `56ece0e4…8851`, planning-projection.ts `d5b5cd10…254b`,
build-runtime.ts `5d200dd3…6a70`, planning-review.test.ts `5af1ed5a…fd92`). Worker suites not
re-run (owner rule); their counts (357/357 over 17 files, tsc exit 0, eslint exit 0) are tied to this
tree by those hashes.

Scratch probes (`node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1
--test-name-pattern "^PROBE…" <scratch>\probe.test.ts`):
- `PROBE deadlock` — 1/1 pass (confirms B1): after restart 5/5 steps `blocked:coverage_reviewer_unavailable`, architect calls 0, reviewer model calls 0.
- `PROBE re-review obligations …` — 1/1 pass (confirms B2): deriving turn has plan digest `true`, criterion text `true`, stamps `[true,true,true]`.
- `PROBE lineage` — 1/1 pass (confirms B3): third re-review saw F1 `false`, readiness `ready`.
- `PROBE failover` — 1/1 pass (confirms B4): retry threw `Recovered coverage session identity does not match the request.`

Prove-red reproductions (helper `mutate.mjs`: backup bytes, needle count must be 1, CRLF preserved,
restore by byte copy):
1. Worker #1 (N2 durable-read checkpoint gate), `planning-projection.ts`: BEFORE `d5b5cd10…254b`,
   INJECTED `3833732a…b667` (changed), test `T3b N2: a direct checkpoint event…` → pass 0 / fail 1,
   `AssertionError: Missing expected exception` at `planning-review.test.ts:749` (forged zero-read
   checkpoint accepted). AFTER `d5b5cd1067fe805051ea8a761d7b2823b538f3e15623d8eb2c01bb0ca7ef254b` — match.
2. Reviewer's own (missing from the worker set): deriving-turn blindness, `planning-review.ts`
   `...(isReReview ? { planUnderCorrectionJson …` → `...(true ? …`: BEFORE `56ece0e4…8851`, INJECTED
   `a68262ed…3991` (changed), test `T3b reviewer sees only the source first…` → pass 0 / fail 1,
   `AssertionError: deriving turn leaks: revision_1` at `:1213`. AFTER
   `56ece0e431fc29555a3fb087aa7cdbfda7b08f58d56eee31b81006c3b61e8851` — match.

`git status --short` after review: same 11 modified + 3 untracked files; only this review file added.

## Verdict

Solid kernel ordering for the initial review, clean vocabulary, exact read-only surface, and a real
N2/N6 repair. But the coverage gate is not live under realistic unavailability (B1) or failover (B4),
the re-review — which is what binds readiness after any correction — breaks OA-1's
obligations-before-plan guarantee while recording that it held (B2), and outstanding blocking findings
can be laundered by one more revision (B3).

T3b REVIEW r1 — REPAIR REQUIRED — 4 blocking
