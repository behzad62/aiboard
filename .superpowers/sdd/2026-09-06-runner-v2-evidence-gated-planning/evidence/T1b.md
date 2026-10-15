# T1b — Source identities and complete planning contracts (build pass)

**Scope of this pass.** Implements T1 checkboxes 3–6 (build) in
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6` (branch
`codex/runner-v2-p6-6`, base `de56fcd6`). T1a's inspection (checkboxes 1–2)
and grounding corrections G-1..G-11 are read and followed. No scheduler,
runtime, UI, process control, dependency, or lockfile changes. Nothing in
this pass was committed, staged, or stashed — the working tree is left
uncommitted for the controller.

## Requirement / acceptance IDs

EP01, EP02, EP03, EP04, EP06, EP09 (contract-layer parts only — the
persistence/checkpoint half is T2's), EP23 (contract layer only — kernel
enforcement is T2/T3/T6). Plan section 5, task T1, "Acceptance/negative
proof" and "Validation/review/integration" paragraphs.

## Revision / diff identity

- Base: worktree HEAD `de56fcd6` (branch `codex/runner-v2-p6-6`), unchanged
  by this pass — no commits were made.
- Working-tree diff identity (git status, this pass's mutations only):

```
 M runner-v2/src/acceptance-contracts.ts
 M runner-v2/src/build-spec.ts
 M runner-v2/test/acceptance-contracts.test.ts
 M runner-v2/test/build-spec-store.test.ts
?? docs/runner-v2/evidence-gated-planning.md
?? runner-v2/src/planning-contracts.ts
?? runner-v2/src/source-manifest.ts
?? runner-v2/test/fixtures/planning-source-fixture.ts
?? runner-v2/test/planning-contracts.test.ts
?? runner-v2/test/source-manifest.test.ts
```

## Files changed / created (line counts are `wc -l` on the file as left)

New:
- `runner-v2/src/source-manifest.ts` — 320 lines
- `runner-v2/src/planning-contracts.ts` — 1483 lines
- `runner-v2/test/source-manifest.test.ts` — 157 lines
- `runner-v2/test/planning-contracts.test.ts` — 646 lines
- `runner-v2/test/fixtures/planning-source-fixture.ts` — 326 lines
- `docs/runner-v2/evidence-gated-planning.md` — 163 lines

Extended (git diff --stat insertions, no deletions in any of the four):
- `runner-v2/src/acceptance-contracts.ts` — +12 lines (optional
  `AcceptanceCriterion.requirementId`, validated when present)
- `runner-v2/src/build-spec.ts` — +32 lines (`PLANNING_POLICY_VERSIONS`,
  `NativeBuildPlanningPolicy`, `NativeBuildSpec.planningPolicy?`, its
  validation and clone support)
- `runner-v2/test/acceptance-contracts.test.ts` — +18 lines (one new test)
- `runner-v2/test/build-spec-store.test.ts` — +45 lines (one new test)

Not touched: `runner-v2/src/task-contracts.ts`. `AcceptanceCriterion` (in
`acceptance-contracts.ts`, already imported by `task-contracts.ts`) was the
minimal, correct extension point for "task-local criteria map explicitly to
run-level requirement ids" — `BuildTask` needed no change.

## Exported API (public surface, both new modules)

`source-manifest.ts`: `computeArtifactDigest`, `SourceManifestSection`,
`SourceManifestAmendment`, `ApprovedSourceManifest`, `SourceManifestIssueCode`,
`SourceManifestIssue`, `SourceManifestValidation`,
`validateApprovedSourceManifest`, `assertApprovedSourceManifest`,
`assertManifestMatchesBytes`, `SourceManifestSectionInput`,
`buildSourceManifest`, `verifyAmendmentReferencesPredecessor`,
`sourceManifestDigestMatches`, `sourceManifestSectionIds`.

`planning-contracts.ts`: `computeDigest`, `PlanningIssue`,
`PlanningValidation`; `RequirementObligationKind`,
`REQUIREMENT_OBLIGATION_KINDS`, `SourceRequirementReference`,
`RequirementApplicabilityStatus`, `RequirementApplicabilityDisposition`,
`RequirementApplicability`, `RequirementAcceptanceCondition`,
`SourceRequirement`, `validateRequirementLedger`, `assertRequirementLedger`,
`validateRequirementTaskCoverage`; `ExecutionTaskOutcome`,
`ExecutionTaskScope`, `ExecutionTaskValidationRationale`,
`ExecutionTaskNegativeProofApplicability`, `ExecutionTaskCleanup`,
`ExecutionTaskInvestigation`, `RequirementCriterionMapping`,
`ExecutionTaskContract`, `validateExecutionTaskContract`,
`assertExecutionTaskContract`, `TaskGraphCycleIssue`,
`validateTaskContractGraph`; `ExecutionPlanPhase`, `ExecutionPlanRevision`,
`ExecutionPlanRevisionWithoutDigest`, `computeExecutionPlanRevisionDigest`,
`buildExecutionPlanRevision`, `validateExecutionPlanRevision`,
`assertExecutionPlanRevision`; `ValidationScope`, `ValidationIntent`,
`validateValidationIntent`, `ValidationOutcome`,
`ValidationObservationCounts`, `ValidationObservation`,
`validateValidationObservation`, `assertValidationObservation`;
`EvidenceApplicabilityImpact`, `EvidenceApplicabilityOutcome`,
`EvidenceApplicabilityDecision`, `validateEvidenceApplicabilityDecision`,
`assertEvidenceApplicabilityDecision`; `COVERAGE_VERDICT_VALUES`,
`CoverageVerdictValue`, `PLANNING_ADDITIVE_FINDING_CATEGORIES`,
`PlanningAdditiveFindingCategory`, `PlanningFindingCategory`,
`PLANNING_FINDING_CATEGORIES`, `DerivedObligation`,
`CoverageObligationVerdict`, `PlanningFinding`, `CoverageReview`,
`validateCoverageReview`, `assertCoverageReview`,
`coverageReviewHoldsReadiness`, `DeliverableReviewClaimVerdict`,
`DeliverableReviewTier`, `DeliverableReview`, `validateDeliverableReview`,
`assertDeliverableReview`; `RepairApproachDecisionValue`,
`RepairApproachDecision`, `validateRepairApproachDecision`,
`assertRepairApproachDecision`; `RequiredCheckRef`, `AcceptanceStatus`,
`TaskAcceptance`, `validateTaskAcceptance`, `assertTaskAcceptance`,
`PhaseAcceptance`, `validatePhaseAcceptance`, `assertPhaseAcceptance`;
`PlanningCheckpoint`, `validatePlanningCheckpoint`,
`assertPlanningCheckpoint`, `AssignmentClaimState`, `AssignmentClaim`,
`validateAssignmentClaim`, `assertAssignmentClaim`,
`assertClaimReassignable`; `HostCapabilityStatus`,
`HostCapabilityObservation`, `HostPlanningCapabilities`,
`validateHostPlanningCapabilities`, `assertHostPlanningCapabilities`,
`T1A_SEEDED_HOST_PLANNING_CAPABILITIES`; `PlanReadinessInput`,
`PlanReadinessResult`, `computePlanReadiness`.

`build-spec.ts` additions: `PLANNING_POLICY_VERSIONS`,
`PlanningPolicyVersion`, `NativeBuildPlanningPolicy`,
`NativeBuildSpec.planningPolicy?`.

`acceptance-contracts.ts` addition: `AcceptanceCriterion.requirementId?`.

## Commands run and results (exact counts)

All commands run from the worktree root
`D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6` with
`C:\Program Files\nodejs\node.exe`.

1. `./node_modules/typescript/bin/tsc -p runner-v2/tsconfig.json --noEmit`
   — **0 errors** (clean; ran repeatedly through the build, final run
   after restoring all PROVE-RED edits also clean).
2. `./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (root)
   — **0 errors** (clean).
3. `./node_modules/eslint/bin/eslint.js` on every changed/created file
   listed above — **0 errors, 0 warnings** (two initial unused-var
   warnings in `planning-contracts.ts` and `planning-contracts.test.ts`
   were fixed by removing the unused `ok()` helper and two unused fixture
   imports; re-run after the fix is clean).
4. `./node_modules/tsx/dist/cli.mjs --test --test-concurrency=1` on the new
   tests plus the three named existing suites:
   `runner-v2/test/source-manifest.test.ts` (new, **5/5 pass**),
   `runner-v2/test/planning-contracts.test.ts` (new, **23/23 pass**),
   `runner-v2/test/acceptance-contracts.test.ts` (**7/7 pass**, including
   the 1 new `requirementId` test),
   `runner-v2/test/task-graph.test.ts` (**5/5 pass**, unchanged),
   `runner-v2/test/build-spec-store.test.ts` (**11/11 pass**, including the
   1 new `planningPolicy` test).
   Combined single run: **51/51 pass, 0 fail**.
5. Grepped importers of the three extended modules and ran every test file
   that imports `build-spec.js`, `acceptance-contracts.js`, or
   `task-contracts.js` (excluding the ones already covered above):
   - `build-spec.js` importers: `control-server.test.ts`,
     `final-verification-completion.test.ts`, `native-build-manager.test.ts`,
     `process-recovery-control.test.ts`, `provider-transport.test.ts` —
     **109/109 pass**.
   - `acceptance-contracts.js` importers: `change-set.test.ts`,
     `scheduler-store.test.ts` — **34/34 pass**.
   - `task-contracts.js` importers: `native-plan-critic-runtime.test.ts`,
     `plan-critique-authority.test.ts`, `plan-critique-contracts.test.ts`,
     `plan-critique-runtime.test.ts`, `plan-critique.test.ts`,
     `project-doc-commit.test.ts`, `task-scheduler.test.ts`,
     `user-steering-runtime.test.ts` — **123/123 pass**.
   Grand total across all suites touched or importing a changed module:
   **51 + 109 + 34 + 123 = 317/317 pass, 0 fail, 0 skipped**.

No test was skipped. No live provider/model call was made anywhere in this
pass (all fixtures are synthetic, in-process, deterministic).

## PROVE-RED (three guards; file sha256 before/after each edit and after restore)

All three guards live in `runner-v2/src/planning-contracts.ts`. Baseline
digest of that file before any PROVE-RED edit, and after every edit was
restored:

```
sha256: 0d49826b0c37162d72c9200ce91a59b655e4ce8ac869cf418e7418fbed50ec99
```

### Guard 1 — one-owner rule (`conflicting_owner`)

- Edit: changed `if (existing.accountablePhaseId !== requirement.accountablePhaseId)`
  to `if (false && existing.accountablePhaseId !== requirement.accountablePhaseId)`
  in `validateRequirementLedger` (the duplicate-id-with-two-owners check).
- File sha256 **after edit** (proves the file actually changed):
  `49ef80c32dab6d78b40f796aaaf70379ec957337ccf6265cb3323c7dec213c41`
- Command: `tsx --test --test-concurrency=1 --test-name-pattern="assigning a requirement two different accountable phases" runner-v2/test/planning-contracts.test.ts`
- Exact failing assertion:
  ```
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
    assert.ok(result.issues.some((issue) => issue.code === "conflicting_owner"))
  ```
- Restored byte-exact; file sha256 **after restore**:
  `0d49826b0c37162d72c9200ce91a59b655e4ce8ac869cf418e7418fbed50ec99` (matches baseline).

### Guard 2 — source-digest invalidation (`source_digest_changed`)

- Edit: changed `if (revision.sourceManifestDigest !== manifest.artifactDigest)`
  to `if (false && revision.sourceManifestDigest !== manifest.artifactDigest)`
  in `validateExecutionPlanRevision`.
- File sha256 **after edit**:
  `6ec76ddea190f0c8dde3a4c76b44295ba05d621fd355d4eb74aa6a7a06ec3b51`
- Command: `tsx --test --test-concurrency=1 --test-name-pattern="changing the source digest invalidates" runner-v2/test/planning-contracts.test.ts`
- Exact failing assertion:
  ```
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  true !== false
  (assert.equal(result.valid, false) — result.valid was true)
  ```
- Restored byte-exact; file sha256 **after restore**:
  `0d49826b0c37162d72c9200ce91a59b655e4ce8ac869cf418e7418fbed50ec99` (matches baseline).

### Guard 3 — missing-task-field rejection (`incomplete_task_contract` for `outcome`)

- Edit: changed
  `if (!isObj(task.outcome) || !nonEmpty(task.outcome.user) || !nonEmpty(task.outcome.system)) missing("outcome");`
  to wrap the whole condition in `if (false && (...)) missing("outcome");`
  in `validateExecutionTaskContract`.
- File sha256 **after edit**:
  `46f510323d14d13250f6c898f18dfaf5f7f0ca2f41b434341bcbe2f48cc71354`
- Command: `tsx --test --test-concurrency=1 --test-name-pattern="a complete task contract validates" runner-v2/test/planning-contracts.test.ts`
- Exact failing assertion:
  ```
  AssertionError [ERR_ASSERTION]: expected task missing outcome to be rejected
  true !== false
  ```
  (from the parametrized loop's `assert.equal(result.valid, false, ...)` for `field === "outcome"`.)
- Restored byte-exact; file sha256 **after restore**:
  `0d49826b0c37162d72c9200ce91a59b655e4ce8ac869cf418e7418fbed50ec99` (matches baseline).

After all three PROVE-RED cycles, the full 51-test combined run (source-manifest
+ planning-contracts + acceptance-contracts + task-graph + build-spec-store)
was re-run and passed 51/51, confirming the restored file behaves identically
to before the exercise.

## Negative-proof coverage (T1's six named cases, all as named tests)

1. Removing a requirement while a referencing task remains →
   `unknown_requirement_ref` — test "negative proof: removing a requirement
   while a task still references it is rejected".
2. Dropping a source section →
   `unknown_section_ref` (ledger) plus a direct manifest-level gap/overlap/
   order test in `source-manifest.test.ts` — test "negative proof: dropping
   a source section is rejected...".
3. Assigning a requirement two different accountable phases (duplicate id
   with conflicting owner) → `duplicate_requirement_id` + `conflicting_owner`
   — test "negative proof: assigning a requirement two different
   accountable phases is rejected" (also the PROVE-RED guard-1 target).
4. Changing a source digest → `source_digest_changed`, and
   `computePlanReadiness` returns `ready:false` — test "negative proof:
   changing the source digest invalidates the plan revision" (also the
   PROVE-RED guard-2 target).
5. Cancelling a requirement's only implementation task without disposition →
   `orphaned_requirement` — test "negative proof: cancelling a
   requirement's only implementation task without disposition orphans it".
6. Silently marking an obligation `not_applicable` without an authorized
   disposition → `missing_disposition` (absent disposition) and
   `unauthorized_disposition` (disposition present but citing neither an
   amendment nor evidence); the fully authorized case is also asserted to
   pass — test "negative proof: silently marking an obligation
   not_applicable without an authorized disposition is rejected".

Additional required acceptance proof: missing task fields are rejected field
by field (18 fields, parametrized test, also the PROVE-RED guard-3 target);
investigation tasks require question/deliverable/decision-criterion/
dependent-unlock; the task-contract dependency graph is acyclic and rejects
duplicate ids; a conditional requirement keeps a visible `conditional_pending`
state with its condition and blocks phase acceptance until resolved; the
verdict/category round-trip test proves the two vocabularies are disjoint in
both directions; `planningPolicy` is opt-in-only, unsupported versions are
rejected, and legacy recovery never retrofits it (build-spec-store.test.ts);
legacy spec parsing is unchanged — every existing `build-spec-store.test.ts`,
`acceptance-contracts.test.ts`, and `task-graph.test.ts` test still passes.

## What was not done / known gaps

- T1's persistence/resume/checkpoint half (EP09, EP10) is explicitly T2's
  scope ("Persist the plan skeleton/requirement ledger... Checkpoint
  covered source sections..." — `scheduler-store.ts`/`planning-projection.ts`).
  This pass delivers the contracts and their validators only, not a
  durable store.
- The `HostPlanningCapabilities` seed
  (`T1A_SEEDED_HOST_PLANNING_CAPABILITIES`) is exactly T1a's 2026-09-23
  observation, copied verbatim with citations; it is a seed for downstream
  tasks to re-observe, not a live-observed value produced by this pass (no
  new inspection was performed beyond re-reading T1a's report).
  `readerDisposableCommandExecution` is recorded `procedural` because T1a
  itself flagged that as unconfirmed — this pass did not independently read
  `evidence-tools.ts:41-176` to resolve it, matching T1a's own stated
  caveat.
  `directEventReplayValidators` and `stateTransitionGates` are recorded
  `enforced` per T1a's citations of `scheduler-store.ts`'s
  `reduceSchedulerEvent`/`architectActionReasonIsApplicable` — this pass
  did not re-verify those line numbers since T1 explicitly scopes T1b away
  from `scheduler-store.ts` edits (T2/T3/T9 own that file).
- `CoverageReview`/`DeliverableReview`'s "recorded before plan/diff was
  provided" fields (`recordedBeforePlanOrDiffProvided`,
  `findingsRecordedBeforeReport`, `correctionOwnViewRecordedFirst`) are
  contract-level boolean flags the validator trusts; the actual kernel
  mechanism that stamps them truthfully (reusing RG-6's
  `record_verification_expectations` device per OA-1) is T3/T6/T9 work, not
  this pass's.
- No fixture or test exercises a genuinely malformed/non-object array
  element beyond the deliberate field-omission cases already covered;
  `isObj()` guards were added throughout for defensive robustness (so a
  malformed runtime payload produces an issue instead of throwing), but no
  additional test specifically targets a `null` array entry — this is a
  reasonable robustness margin, not a tested requirement.
- Did not run `npm run test:runner-v2` (the full aggregate suite) or the
  benchmark/certified suites — out of T1's stated validation scope
  (targeted + affected-scope tests plus root/runner-v2 typecheck and
  eslint on changed files, which were all run and are clean).

## Review

Independent review r1 (`T1b-review-r1.md`, fresh-context reviewer, probed
the actual exported functions against the worker's own fixture): verdict
**REPAIR REQUIRED** — 4 blocking, 8 important, 7 minor findings. Repair
cycle 1 (below) addresses all of them. Corrections to this file's own
original overclaims, which the review caught, are recorded in the
"Corrections to original claims" subsection at the end of repair cycle 1.

## Repair cycle 1

All fixes are in the same worktree, uncommitted. Nothing was committed,
staged, or stashed.

### Finding-by-finding table

| Finding | Fixed | How | Test |
|---|---|---|---|
| B1 — removing a requirement (esp. together with its only task) still yielded a ready plan | Yes | `validateRequirementLedger` now requires every manifest section to be referenced by ≥1 requirement or an authorized `nonNormativeSections` disposition (`uncovered_source_section`); added a second, revision-to-revision guard `validateRequirementRemovalAgainstPrior` (`retiredRequirementIds`) for the narrower case where the section stays covered by a different requirement | `B1: removing a requirement TOGETHER with its only task…`, `B1 (revision-to-revision): a requirement silently absent…` (both new); PROVE-RED #1 |
| B2 — dropping a source section (esp. the last one) or an `endByte` past EOF still validated; readiness never called the manifest validator | Yes | Added `ApprovedSourceManifest.byteLength`; the section loop now checks `endByte <= byteLength` (`section_exceeds_byte_length`) and that the inventory's actual coverage reaches exactly `byteLength` (`trailing_bytes_uncovered`); `assertManifestMatchesBytes` checks `byteLength` against real bytes; `validateExecutionPlanRevision` now calls `validateApprovedSourceManifest` | `B2: a dropped last section / uncovered trailing bytes…` (new); PROVE-RED #2 |
| B3 — a plan mutation did not invalidate the coverage review (id-only check; `sourceReadManifestId`/`runId`/`coverageReviewId` unchecked) | Yes | Added `CoverageReview.planRevisionDigest`; new `validateCoverageReviewBinding(review, revision, manifest)` checks revisionId + digest + sourceReadManifestId + runId + coverageReviewId, called from `computePlanReadiness` | `B3: a plan mutation invalidates a stale coverage review…` (new); PROVE-RED #3 |
| B4 — `ExecutionPlanPhase` was `{id, purpose}` only, missing almost every EP06/source §2 field | Yes | Added `requirementIds`, `scope`, `entryConditions`, `contributingTaskIds`, `exitCriteria`, `requiredCombinedValidation`, `exitUnlocks`; `validateExecutionPlanRevision` validates all of them strictly and resolves `requirementIds`/`contributingTaskIds` against the revision | `B4: a phase contract missing any EP06/source-§2 field…` (new); PROVE-RED #4 |
| I1 — the "old reader rejects unsupported new-policy data" claim was a forward guard only, not the required backward guard | Documented, not silently fixed (see rationale below) | Rewrote the doc-comment on `planningPolicy` in `build-spec.ts` and the corresponding section of `docs/runner-v2/evidence-gated-planning.md` to state the exact, honest scope (forward-compat only; no pre-T1 reader exists so the gap is currently theoretical). Also fixed M3 in the same pass (unknown `planningPolicy` keys now rejected, not silently stripped by clone) | `I1: planningPolicy round-trips through the SQLite store exactly…` (new, SQLite save/get round-trip); `M3` assertion appended to the existing `planningPolicy` test |
| I2 — a mandatory obligation could be retired by evidence alone with any `authorizedBy` | Yes | `not_applicable` disposition for a non-`conditional` `obligationKind` now requires `amendmentRef` specifically (`unauthorized_mandatory_retirement`); evidence-only stays valid for `conditional` | `I2: a mandatory (non-conditional) obligation cannot be retired by evidence alone…` (new) |
| I3 — task↔requirement mapping and bidirectional trace unenforced | Yes | `acceptance.criteria` now `{id, text}[]` (not bare strings); `requirementCriteriaMap` must be non-empty, every entry must resolve to a real criterion id and to a requirement in the task's own `requirementIds`, and every criterion must have ≥1 mapping; new `validateRequirementTaskLinkSymmetry` enforces `requirement.contributingTaskIds` ↔ `task.requirementIds` agreement | `I3: acceptance criteria have resolvable ids…` (new) |
| I4 — blank list entries accepted; `requiredBase` optional; no cleanup disposition; investigation-only delivery for a mandatory requirement accepted | Yes | New `isNonBlankStringArray` guard applied to every content-bearing list and id array; `requiredBase` is now required; `ExecutionTaskCleanup` gained a `cleanup` field (was recovery/rollback only); `validateRequirementTaskCoverage` rejects an `applicable` requirement whose only live contributing tasks are investigation tasks (`investigation_only_delivery`), exempting `conditional_pending` | `I4: blank list entries are rejected, requiredBase is mandatory…` (new) |
| I5 — several validators threw on malformed/`null` input, contradicting the documented "never throws" | Yes | Added a plain-`boolean` `isObj()` guard (distinct from the type-predicate `isRecord()`, to avoid the TS narrowing collapse noted in the original evidence) at the top of every exported `validate*` function and every internal loop over a possibly-malformed array element; `validateApprovedSourceManifest` got the same treatment in `source-manifest.ts` | `I5: validators never throw on malformed/null/undefined input…` (new, exercises every previously-throwing probe from the review plus the remaining validators) |
| I6 — readiness ignored blocking findings (only verdicts); findings had no disposition/resolution | Yes | Added `PlanningFinding.disposition` (`resolution`/`rationale`/`resolvedAt`); `computePlanReadiness` now also holds on any finding that is `severity: "blocking"` and not `resolution: "plan_reconciled"` | `I6: an unresolved blocking finding holds plan readiness…` (new) |
| I7 — `PhaseAcceptance` accepted on *any* contributing task accepted, never validated the `TaskAcceptance` records, and left `requirementIds`/`taskAcceptanceRefs` as dead fields | Yes | `validatePhaseAcceptance` now requires **every** contributing task to have a `TaskAcceptance` that is both `status: "accepted"` and structurally valid (`validateTaskAcceptance` run on each); `requirementIds`/`taskAcceptanceRefs` are cross-checked against the phase's actual owned requirements/contributing tasks | `I7: phase acceptance requires EVERY contributing task…` (new) |
| I8 — `ValidationObservation` had no exit code; `EvidenceApplicabilityDecision` used bare booleans (no old/new identities); one dead branch | Yes | Added `ValidationObservation.exitCode: number \| null` (a `passed` outcome cannot cite a non-zero exit code); replaced the four boolean impact flags with `EvidenceApplicabilityDimensionObservation {inspected, oldIdentity?, newIdentity?}`, mechanically deriving impact fail-closed (not-inspected or missing-identity counts as impacted); deleted the unreachable `missing_reuse_rationale` branch | `a passed validation observation…` (extended); `evidence applicability: any inspected impact dimension…` (rewritten) |
| M1 — `repeat_rejected` was treated as a repeat needing new evidence, making a legitimate rejection record itself invalid | Yes (clarified semantics) | `repeat_rejected` is now the Architect's own rejection record: exempted from the new-evidence rule, but must name a `proposedApproachId` already in `priorFailedApproachIds` (`repeat_rejected_not_a_known_repeat`) | `M1: repeat_rejected is the Architect's OWN rejection record…` (new); existing "relabelled" case updated to assert the new code |
| M2 — doc comment said "conditional disposition" exempts orphaning; code only exempted `not_applicable` | Yes | Rewrote the doc-comment on `validateRequirementTaskCoverage` to state the actual behavior (not_applicable exemption; conditional_pending still needs ≥1 live contributing task) | Doc-only; behavior unchanged, so no new test |
| M3 — `planningPolicy` accepted extra keys, silently stripped by `cloneBuildSpec` | Yes | `validateBuildSpecCore` now rejects any key on `planningPolicy` other than `version` | Appended to the existing `planningPolicy` test in `build-spec-store.test.ts` |
| M4 — a coverage verdict for a never-derived obligation id was not flagged | Yes | `validateCoverageReview` now checks every `obligationVerdicts[].obligationId` against the derived-obligation id set (`verdict_for_undeclared_obligation`) | `M4: a coverage verdict citing an obligation id that was never derived…` (new) |
| M5 — `isObj` vs `isRecord`: property reads compile against a non-optional type even though the runtime value is `unknown` | Acknowledged, not changed | The review itself states "It is not incorrect as written." Fixing this would mean rewriting every validator to take genuinely `unknown` input with real parsers, which is a larger refactor than a repair cycle; documented as a known design tradeoff in the `isObj` doc-comment (unchanged from the original pass) | None (no behavior change) |
| M6 — `T1A_SEEDED_HOST_PLANNING_CAPABILITIES` exported from product code with a timestamp/citations that will go stale | Yes | Strengthened the doc-comment to say NOT AUTHORITATIVE explicitly, and why it lives in product code anyway (fixture/test realism) rather than moving the file, since it is legitimately consumed by `buildFixtureHostCapabilities` today | Doc-only; no new test |
| M7 — `HostCapabilityObservation.evidence` accepts any non-empty string; truthfulness is procedural only | Acknowledged, not changed | The review itself states this is "acceptable at the contract layer." No code or doc change made | None |

### PROVE-RED (repair cycle 1; four blocking guards)

Baseline digests before any repair-cycle edit:
```
runner-v2/src/planning-contracts.ts: dd0d789816d0e76073eac4f5c94c51c01f96b2fc1074f6a4f8fa93952f169d30
runner-v2/src/source-manifest.ts:    ad95b223de429366c485a80326f6f050586a20360203187a5a5ac58c72e3bb83
```
(These are the post-repair, pre-PROVE-RED digests — i.e. after all four
blocking/important/minor fixes above were applied and all tests were
green, and stay the file's steady-state content across all four PROVE-RED
cycles below, since each is individually disabled then restored.)

**#1 — B1 (`uncovered_source_section` guard, `planning-contracts.ts`,
`validateRequirementLedger`).** Wrapped the disposition-check condition in
`false && (...)`. File sha256 after edit:
`4f12b4fe858ab72720dec2ec9e46064d5757e6a8f2ae54068b13ad2672c7f9d2`. Command:
`tsx --test --test-concurrency=1 --test-name-pattern="^B1: removing a requirement TOGETHER" runner-v2/test/planning-contracts.test.ts`.
Exact failing assertion:
```
AssertionError: removing a requirement and its only task must leave section s5 uncovered
actual: false, expected: true
```
Restored byte-exact; sha256 after restore:
`dd0d789816d0e76073eac4f5c94c51c01f96b2fc1074f6a4f8fa93952f169d30` (matches).

**#2 — B2 (`trailing_bytes_uncovered` guard, `source-manifest.ts`,
`validateApprovedSourceManifest`).** Prefixed the `if` condition with
`false &&`. File sha256 after edit:
`ee676dabb97db93f08b931f515ecd40846c9a08c84ea667e4b6570ca5b056043`. Command:
`tsx --test --test-concurrency=1 --test-name-pattern="^B2: a dropped last section" runner-v2/test/planning-contracts.test.ts`.
Exact failing assertion:
```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
true !== false
(assert.equal(droppedResult.valid, false) — droppedResult.valid was true)
```
Restored byte-exact; sha256 after restore:
`ad95b223de429366c485a80326f6f050586a20360203187a5a5ac58c72e3bb83` (matches).

**#3 — B3 (digest-binding check, `planning-contracts.ts`,
`validateCoverageReviewBinding`).** Prefixed
`review.planRevisionDigest !== revision.digest` with `false &&`. File
sha256 after edit:
`8fcf2fe07d85196eade307722731d82582742d6aa6d75c9d764e41f95735cc08`. Command:
`tsx --test --test-concurrency=1 --test-name-pattern="^B3: a plan mutation" runner-v2/test/planning-contracts.test.ts`.
Exact failing assertion:
```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
true !== false
(bindingResult.valid was true instead of false)
```
Restored byte-exact; sha256 after restore:
`dd0d789816d0e76073eac4f5c94c51c01f96b2fc1074f6a4f8fa93952f169d30` (matches).

**#4 — B4 (`incomplete_phase_contract` guard, `planning-contracts.ts`,
`validateExecutionPlanRevision`).** Wrapped the entire phase-completeness
condition in `false && (...)`. File sha256 after edit:
`9fcdd15f3f22249c1c1795129b22bc6ac7557cfa0b0f9aa981da37ed859e14f9`. Command:
`tsx --test --test-concurrency=1 --test-name-pattern="^B4: a phase contract" runner-v2/test/planning-contracts.test.ts`.
Exact failing assertion:
```
AssertionError: The expression evaluated to a falsy value:
  assert.ok(result.issues.some((issue) => issue.code === "incomplete_phase_contract"))
```
Restored byte-exact; sha256 after restore:
`dd0d789816d0e76073eac4f5c94c51c01f96b2fc1074f6a4f8fa93952f169d30` (matches).

After all four PROVE-RED cycles, the full targeted suite (below) was
re-run and passed, confirming byte-exact restoration behaves identically
to before the exercise.

### Commands re-run and results (exact counts, repair cycle 1)

1. `tsc -p runner-v2/tsconfig.json --noEmit` — **0 errors**.
2. Root `tsc --noEmit -p tsconfig.json` — **0 errors**.
3. `eslint` on every changed/created file (same list as the original pass)
   — **0 errors, 0 warnings**.
4. `tsx --test --test-concurrency=1` on the five targeted suites in one run:
   `source-manifest.test.ts` **5/5**, `planning-contracts.test.ts`
   **36/36** (was 23; +13 new named tests: B1×2, B2, B3, B4, I2, I3, I4,
   I5, I6, I7, M1, M4), `acceptance-contracts.test.ts` **7/7**,
   `task-graph.test.ts` **5/5**, `build-spec-store.test.ts` **12/12** (was
   11; +1 new I1 SQLite round-trip test, plus the M3 assertion appended to
   an existing test). Combined: **65/65 pass, 0 fail**.
5. Re-ran every importer suite from the original pass (unaffected by this
   repair cycle's changes, since `task-contracts.ts` was not touched):
   `control-server.test.ts` + `final-verification-completion.test.ts` +
   `native-build-manager.test.ts` + `process-recovery-control.test.ts` +
   `provider-transport.test.ts` + `change-set.test.ts` +
   `scheduler-store.test.ts` → **143/143 pass**;
   `native-plan-critic-runtime.test.ts` +
   `plan-critique-authority.test.ts` + `plan-critique-contracts.test.ts` +
   `plan-critique-runtime.test.ts` + `plan-critique.test.ts` +
   `project-doc-commit.test.ts` + `task-scheduler.test.ts` +
   `user-steering-runtime.test.ts` → **123/123 pass**.
   Grand total: **65 + 143 + 123 = 331/331 pass, 0 fail, 0 skipped**.

### Corrections to original claims (this file, and the doc)

The independent review found three claims in this file's original text and
in `docs/runner-v2/evidence-gated-planning.md` that were **false or
misleading as originally stated** (section 4, "Claim verification" table of
`T1b-review-r1.md`). Corrected:

- "Six negative cases each fail to produce a ready plan" was **false**
  for two of the six (removing a requirement, dropping a source section)
  when done as a genuine full removal rather than leaving a dangling ref —
  `computePlanReadiness` did not catch either case before repair cycle 1.
  Now genuinely true end-to-end via `computePlanReadiness`, proven by the
  B1/B2 tests above plus the original six negative-proof tests (unchanged).
- "Manifest inventory covers byte 0 through the end" was **false** — a
  dropped trailing section, or an `endByte` past the artifact length,
  validated cleanly before B2. Now true, proven by the B2 test and the
  `byteLength` mechanism.
- "Every `validate*` never throws" was **false** — several validators threw
  on `null`/malformed input (I5). Now true, proven by the dedicated I5 test
  exercising every named probe from the review plus the remaining
  validators.
- The doc's and this file's "old readers reject unsupported new-policy
  active data" claim conflated a forward-compatibility guard with the
  required backward guard (I1). Both the doc and the `planningPolicy`
  doc-comment in `build-spec.ts` now state the honest, narrower scope.

No other claim in the original file's counts/tables was found false by the
review (see its section 4); those stand as originally recorded.

### What was still not done (unchanged from the original pass, plus one addition)

All items from the original "What was not done / known gaps" section still
apply (T2's persistence/checkpoint scope, the runtime mechanism that
truthfully stamps the OA-1/OA-3 record-before-verdict booleans, etc.). One
addition: M5 (parsers taking genuinely `unknown` input, as a rewrite of the
`isObj` pattern) is a deliberate non-fix, acknowledged above and by the
review itself as "not incorrect as written" — it is a larger refactor than
this repair cycle's scope, and every previously-throwing path is now
covered by the isObj-guard workaround with a passing never-throw test.

## Repair cycle 2

Independent re-review r2 (`T1b-review-r2.md`, same reviewer, fresh probes
against the worker's own fixture, no edits/commits/stashes): confirmed
B1–B4 and nearly everything else fixed, but found **NEW-1 (BLOCKING)** — the
B1 section-coverage guard was bypassable via an architect-authored,
evidence-only `nonNormativeSections` disposition — and **NEW-2
(IMPORTANT)** — eight remaining throw paths, meaning the "validators never
throw — Now true" correction from repair cycle 1 was itself still false.
Plus four minor findings (NEW-3..NEW-6) and three "leftover" residues. All
addressed in this pass, in the same worktree, uncommitted.

### Finding-by-finding table

| Finding | Fixed | How | Test |
|---|---|---|---|
| NEW-1 (BLOCKING) — B1 bypassable via an architect-authored, evidence-only non-normative section disposition | Yes | `SourceManifestAmendment` gained a stable `id` (source-manifest.ts); `SourceSectionDisposition.amendmentRef` is now required (not one-of amendmentRef-or-evidenceRef) AND must resolve against the manifest's actual amendment via new `manifestResolvesAmendmentRef` — same rule extracted into a shared `validateNotApplicableDisposition` helper used everywhere a not_applicable/non-normative disposition is checked (requirement ledger, section coverage, phase acceptance). `RetiredRequirementRecord` and the requirement disposition path get the same resolution check | `NEW-1: an architect-authored, evidence-only non-normative section disposition cannot bypass the amendment requirement` (new; covers both the evidence-only case and a fabricated-but-non-empty amendmentRef); PROVE-RED |
| NEW-2 (IMPORTANT) — 8 remaining throw paths; "never throws" claim still false | Yes | Guarded: `validateCoverageReview`'s `obligationIds` computation (was unguarded `.map` over `derivedObligations`), `validateTaskAcceptance`'s `requiredChecks` iteration (now validates each entry's shape before reading `.outcome`), `validateRequirementTaskCoverage`/`validatePhaseAcceptance` now reject a non-Map `taskStatuses`/`taskAcceptances` argument instead of calling `.get` on it, `computePlanReadiness` guards `input` itself and `input.coverageReview.findings` before iterating. The accompanying fuzz test additionally caught and fixed two more real throws: `sourceManifestSectionIds`/`validateRequirementLedger` on a manifest that is `{}` (object but missing `.sections`), and `manifestResolvesAmendmentRef` on a manifest whose `amendment` field is explicitly `null` | `I5` test extended with the 4 exact NEW-2 probes; new `NEW-2 fuzz` test — a data-driven table of all 21 exported `validate*` functions (plus `computePlanReadiness`) fuzzed with null/undefined at every top-level argument position, `[null]`/`[{}]` for array positions, and `{}` plus per-key `null` (and one level of nested array/object fuzzing) for object positions; asserts it actually ran (>100 cases; observed 100+ in practice) |
| NEW-3 (minor) — a phase's requirementIds/contributingTaskIds only resolved, never checked for ownership | Yes | `validateExecutionPlanRevision` now requires `phase.requirementIds` to exactly equal the set of requirements whose `accountablePhaseId === phase.id` (`phase_requirement_ownership_mismatch`), and the same for `contributingTaskIds` vs. tasks (`phase_task_ownership_mismatch`) | `NEW-3: a phase's requirementIds/contributingTaskIds must exactly match...` (new; over-claiming and under-claiming both tested) |
| NEW-4 (minor) — I1 wording said "no pre-T1 reader exists... currently theoretical" | Yes | Rewrote the `build-spec.ts` doc-comment and the corresponding doc paragraph: every runner build before T1, including `main` as of this writing, IS such a reader; a downgrade to an older runner build against a `planningPolicy`-opted state directory is the realistic scenario, not a theoretical one | Doc/comment-only; no behavior changed, so no new test |
| NEW-5 (minor) — a blocking finding cleared on a self-set `disposition.resolution` flag alone | Yes | `PlanningFindingDisposition` gained `resolvedByReviewId?`/`resolvedInRevisionDigest?`; `validateFindings` and `findingIsUnresolvedBlocking` both require at least one of them to be present for a `plan_reconciled` disposition to count | `I6` test extended: a disposition with resolution+rationale+resolvedAt but no reference still holds readiness; one with `resolvedByReviewId` releases it |
| NEW-6 (minor) — I7 residue: `validatePhaseAcceptance` accepted a not_applicable disposition that was any truthy object | Yes | `validatePhaseAcceptance` now calls the same shared `validateNotApplicableDisposition` helper the requirement ledger uses (full authorizedBy/rationale/decidedAt/amendmentRef/resolution rule), not a bespoke truthy check; this required adding a `manifest` parameter to `validatePhaseAcceptance`/`assertPhaseAcceptance` | Covered structurally by reuse — the shared helper's own tests (I2, NEW-1) exercise the logic; existing I7 test re-verified passing with the new 4th `manifest` argument |
| Leftover — config/dependency fingerprints optional | Yes | `ValidationObservation.configFingerprint`/`dependencyFingerprint` are now required (non-optional) strings, validated non-empty | `NEW-2 fuzz` test's baseline `validObservation` and the existing "passed validation observation" test both updated; new fields validated by `validateValidationObservation` |
| Leftover — `DerivedObligation.recordedAt` unvalidated; other `recordedAt` fields inconsistently validated | Yes | `validateDerivedObligations` now requires a valid ISO timestamp; `validateCoverageReview`/`validateDeliverableReview` gained `recordedAt` checks they never had; `PlanningCheckpoint`/`HostPlanningCapabilities` upgraded from `nonEmpty` to full `isValidTimestamp` | Covered by the fuzz test's baseline objects (all carry valid timestamps) and by re-running every existing test that constructs these types |
| Leftover — `amendmentRef`s not resolved against the manifest's amendment chain; any string passed | Yes | Same fix as NEW-1: `manifestResolvesAmendmentRef` is now called everywhere an `amendmentRef` is cited (requirement disposition, section disposition, retired-requirement record) | Covered by `NEW-1`, `I2`, and `B1 (revision-to-revision)` tests (the latter extended with a fabricated-amendmentRef case) |

### PROVE-RED (repair cycle 2; NEW-1 blocking guard)

Baseline digest before this cycle's PROVE-RED edit (i.e. after all NEW-1..NEW-6 and leftover fixes above were applied and all tests were green):
```
runner-v2/src/planning-contracts.ts: a3af5c42e78c311ce1dcf3c15e36fd26d580ec7bed7e90e8ec71ae86c2035219
```

**NEW-1 — amendment-resolution guard (`manifestResolvesAmendmentRef` call in the section-coverage `else if`, `validateRequirementLedger`).**
Prefixed the condition with `false &&`, so a non-empty but fabricated `amendmentRef` (e.g. `"amend-does-not-exist"`) would no longer be checked against the manifest's actual amendment.
File sha256 after edit: `54ef1fa4458bb6e376ba511cd8b65490b393ba172411c4a74f9dce880dfcb914`.
Command: `tsx --test --test-concurrency=1 --test-name-pattern="^NEW-1:" runner-v2/test/planning-contracts.test.ts`.
Exact failing assertion:
```
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  assert.ok(fabricatedResult.issues.some((issue) => issue.code === "unresolved_amendment_ref"))
```
Restored byte-exact; sha256 after restore: `a3af5c42e78c311ce1dcf3c15e36fd26d580ec7bed7e90e8ec71ae86c2035219` (matches baseline).

(Note: the disposition's own "amendmentRef required" check — disabled and
tested separately during the edit process before settling on the resolution
check above as the more precise PROVE-RED target — independently guards
against an empty/absent `amendmentRef`; disabling it alone does not by
itself make the plan `ready:true`, because the resolution check below still
catches the resulting empty-string citation. The resolution check proven
above is the guard that specifically stops a non-empty but fabricated
citation, which is the deeper bypass NEW-1 described.)

### Commands re-run and results (exact counts, repair cycle 2)

1. `tsc -p runner-v2/tsconfig.json --noEmit` — **0 errors**.
2. Root `tsc --noEmit -p tsconfig.json` — **0 errors**.
3. `eslint` on every changed/created file (same list as prior cycles) — **0 errors, 0 warnings**.
4. `tsx --test --test-concurrency=1` on the five targeted suites in one run:
   `source-manifest.test.ts` **5/5**, `planning-contracts.test.ts`
   **39/39** (was 36 at end of cycle 1; +3 new named tests: `NEW-1`,
   `NEW-3`, `NEW-2 fuzz`; several existing tests extended in place with
   additional assertions rather than counted as new), `acceptance-contracts.test.ts`
   **7/7**, `task-graph.test.ts` **5/5**, `build-spec-store.test.ts`
   **12/12**. Combined: **68/68 pass, 0 fail**.
5. Re-ran every importer suite from prior cycles (unaffected by this cycle's
   changes, since `task-contracts.ts` was not touched):
   `control-server.test.ts` + `final-verification-completion.test.ts` +
   `native-build-manager.test.ts` + `process-recovery-control.test.ts` +
   `provider-transport.test.ts` + `change-set.test.ts` +
   `scheduler-store.test.ts` → **143/143 pass**;
   `native-plan-critic-runtime.test.ts` + `plan-critique-authority.test.ts`
   + `plan-critique-contracts.test.ts` + `plan-critique-runtime.test.ts` +
   `plan-critique.test.ts` + `project-doc-commit.test.ts` +
   `task-scheduler.test.ts` + `user-steering-runtime.test.ts` →
   **123/123 pass**.
   Grand total: **68 + 143 + 123 = 334/334 pass, 0 fail, 0 skipped**.

### Fixture restructuring note

NEW-1's amendment-resolution requirement meant `SourceSectionDisposition`/
`RequirementApplicabilityDisposition`/`RetiredRequirementRecord`
`amendmentRef` citations must resolve against the *actual* manifest being
validated. This required restructuring `planning-source-fixture.ts` so the
scenario's primary `manifest` (used throughout — revision, coverage review,
readiness) IS the approved amendment (`amendment.id: "amend-1"`, 8
sections, covering the new section 8 via `REQ-RETIRED`'s reference), with
the original 7-section, no-amendment manifest exposed separately as
`scenario.priorManifest`. `scenario.amendedManifest` is kept as a
backward-compatible alias equal to `scenario.manifest`. `REQ-RETIRED`'s
disposition now cites the real, resolvable `amendmentRef: "amend-1"`.

### Corrections to the repair-cycle-1 claims that r2 found still inaccurate

- "I5 — Now true" (validators never throw) was **false**: 8 throwing
  inputs remained, per NEW-2. Now genuinely true, proven by the extended
  I5 test plus the exhaustive fuzz test (which itself found and fixed two
  MORE throw paths beyond the review's own list, going further than what
  was asked).
- "The six negative cases are now genuinely true end-to-end via
  computePlanReadiness" was **still not fully true**: an architect-authored,
  evidence-only non-normative section disposition made the "removed
  requirement" case `ready:true` again (NEW-1). Now closed, with both the
  evidence-only and fabricated-amendmentRef variants tested.
- The I1 honest-scope wording's "currently theoretical" framing was
  **misleading** (NEW-4): corrected to state plainly that every pre-T1
  runner build, including current `main`, is such a reader.

No other claim from repair cycle 1's evidence was found inaccurate by r2
(see its "Regression check" and "Verification of the worker's claims"
tables — everything else held).

## Independent review — outcome (controller record)

| | |
|---|---|
| Reviewer | fresh-context Opus 5.5 sub-agent (owner rule); worker was Sonnet 5 |
| r1 | REPAIR REQUIRED — 4 BLOCKING, 8 IMPORTANT, 7 MINOR (`T1b-review-r1.md`) |
| r2 | REPAIR REQUIRED — NEW-1 BLOCKING (non-normative bypass), NEW-2 IMPORTANT (throws) + minors (`T1b-review-r2.md`) |
| r3 | **ACCEPT** (`T1b-review-r3.md`); controller re-ran targeted tests and tsc |
| Repair cycles | B1–B4/I-items: 1; NEW-1/NEW-2: 1 (2 total for T1b) |
| Residual MINOR, carried forward | R-1 amendment scope not checked, R-2 only the current amendment id resolves, R-4 two non-`validate*` helpers throw on null → **T2**; R-3 `resolvedByReviewId` not checked against a real review → **T3** |
| State | **T1 ACCEPTED** (T1a + T1b) |

