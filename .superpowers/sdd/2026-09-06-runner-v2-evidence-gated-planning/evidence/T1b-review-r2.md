# T1b independent re-review (repair cycle 1): Runner V2 P6.6 T1

Reviewer: the same independent reviewer as round 1, working read-only. I made no edits, commits or stashes. The only files I created were two temporary probe scripts under `runner-v2/test/`, and I deleted both; `git status` is unchanged.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `de56fcd6`. The repair is uncommitted.

Order followed: I formed my view from the code and my own re-run probes first, then read the "Repair cycle 1" section of `T1b.md`.

## Verification I ran myself

- `tsc -p runner-v2/tsconfig.json --noEmit` exits 0.
- The targeted suites (planning-contracts, source-manifest, acceptance-contracts, build-spec-store, task-graph) pass **65/65**, matching the worker's claim.
- A probe script drove the real exported functions against the worker's updated fixture. When I rebuilt a revision, I also re-bound the coverage review to the new digest. That way each probe tests its own guard, not the digest-binding rule.

## Per-finding table

| # | Status | Evidence (probe result or code location) |
|---|---|---|
| B1 removing a requirement | **FIXED, but bypassable (see NEW-1)** | Removing REQ-SECURITY together with its task T4 now gives `ready:false` (`uncovered_source_section`). With `priorRevision` supplied, `unauthorized_requirement_removal` is also raised. |
| B2 dropped section / EOF / trailing bytes | **FIXED** | Dropping a middle section gives `ready:false` (manifest gap now reaches readiness). Dropping the last section gives `trailing_bytes_uncovered`. A section running past EOF and uncovered trailing bytes both make `buildSourceManifest` throw. A byte-length mismatch makes `assertManifestMatchesBytes` throw. |
| B3 review binding | **FIXED** | `validateCoverageReviewBinding` rejects each case with `ready:false`: a changed plan with the old review (digest), a review of another source, a review from another run, and a `coverageReviewId` mismatch. |
| B4 phase fields | **FIXED** | `ExecutionPlanPhase` now carries every source §2 field. A phase without `exitCriteria` gives `incomplete_phase_contract`. Requirement and task refs are resolved. See the minor finding NEW-3 about ownership consistency. |
| I1 old reader | **ACCEPTED as forward-only** | The honest statement is in `build-spec.ts` and the doc. A SQLite save → close → reopen → get → list round-trip test exists and passes. One factual slip remains; see NEW-4. |
| I2 mandatory not_applicable | **FIXED** | An evidence-only retirement of REQ-MANDATORY gives `unauthorized_mandatory_retirement`. `decidedAt` must now be a valid timestamp. |
| I3 two-way trace and criteria map | **FIXED** | An asymmetric link gives `asymmetric_requirement_task_link` in both directions. An empty map, a map to an unknown criterion, and a map to a requirement outside the task's `requirementIds` are all rejected. Criteria now carry ids. |
| I4 blank lists, requiredBase, cleanup, investigation-only delivery | **FIXED** | `[""]`/`[" "]` entries are rejected. A missing `requiredBase` is rejected. `cleanup.cleanup` is added. A requirement delivered only by an investigation task gives `investigation_only_delivery`. Investigation unlock ids are resolved against the revision. |
| I5 never throws | **PARTIALLY FIXED; the claim is still false** | Eight inputs still throw (listed under NEW-2). The inputs covered by the review's own list no longer throw. |
| I6 blocking finding holds readiness | **FIXED** (see minor NEW-5) | An unresolved `blocking` finding gives `ready:false`. |
| I7 phase acceptance needs every task | **FIXED** (small residue in NEW-6) | One invalid or unaccepted contributing task gives `unaccepted_contributing_task`. `validateTaskAcceptance` is run on each record. The `requirementIds` and `taskAcceptanceRefs` fields are now cross-checked. |
| I8 exit code and applicability identities | **FIXED** (small residue) | `exitCode` is added, and `passed` with a non-zero exit is rejected. Each impact dimension is now `{inspected, oldIdentity, newIdentity}` and fails closed. The dead branch is removed. Residue: `configFingerprint` and `dependencyFingerprint` are still optional on the observation (MINOR). |
| M1 repeat_rejected | **FIXED** | A rejection record is now valid. A `new_approach` repeat without new evidence is still rejected. |
| M2 comment | **FIXED** | The comment now matches the code. |
| M3 planningPolicy extra keys | **FIXED** | Extra keys are rejected. The legacy-recovery pass-through of a v1 spec's `planningPolicy` is unchanged; this is harmless because the field is now validated. |
| M4 undeclared verdict | **FIXED** | `verdict_for_undeclared_obligation` is raised. `DerivedObligation.recordedAt` is still not validated (MINOR residue). |
| M5 isObj typing | **Acknowledged, not changed** | Acceptable. The review said it was not incorrect. |
| M6 seed constant | **FIXED (documented)** | Now marked NOT AUTHORITATIVE, with the reason it lives in product code. |
| M7 capability evidence | **Acknowledged, not changed** | Acceptable. |

## Regression check: things that were correct in round 1

| Item | Still correct? |
|---|---|
| OA-2: a verdict word used as a category and a category used as a verdict | Yes. Both are rejected (`invalid_finding_category` / `invalid_verdict_value`). |
| Two owners | Yes (`duplicate_requirement_id` plus `conflicting_owner`). |
| Source digest drift | Yes (`ready:false`, `source_digest_changed`). |
| Cancelled-only task | Yes (`orphaned_requirement`). |
| Silent not_applicable | Yes (`missing_disposition`). |
| Legacy spec parsing and recovery | Yes. The build-spec-store suite (12/12) and the legacy-recovery assertion pass. |
| Scope / G-1 | Yes. The file list is the same as round 1; `runner-capability-contract.ts` and the scheduler, runtime and UI files are untouched. |

## New findings

### BLOCKING

**NEW-1: the B1 fix can be bypassed with an architect-authored, evidence-only "non-normative section" disposition.** `planning-contracts.ts`, in the `validateRequirementLedger` section-coverage loop (the `nonNormativeSections` check) and in `SourceSectionDisposition`.

Probe A2 did the following:
1. Removed REQ-SECURITY and its task T4.
2. Added `nonNormativeSections: [{ sectionId: "s5", rationale: "heading only", authorizedBy: "architect", evidenceRef: "ev-x" }]`.
3. Re-bound the digest and the review.

The result was **`ready: true, blockers: []`**.

This is the same removal-by-label pattern that I2 closed for requirements, now reachable through the section route. Section s5 held a security obligation. An evidence-only label from any authorizer declared it non-normative, and the obligation disappeared with no amendment. The revision-to-revision guard does not help:
- it runs only when the caller supplies `priorRevision`;
- a first revision has no prior revision;
- a plan drafted without the requirement never had it in a prior revision.

**Fix:** use the same rule as I2. A non-normative section disposition should require `amendmentRef` (owner amendment) rather than accepting `evidenceRef` alone. Otherwise it should require a positively typed owner authority. Also add a `decidedAt` timestamp. Add a negative test that drops the requirement plus its task, adds an architect evidence-only disposition, and expects `ready:false`.

### IMPORTANT

**NEW-2: validators still throw on malformed input, and the evidence's "Now true" correction is false** (I5 is not fully fixed). Probe results:
- `validateCoverageReview({...review, derivedObligations: [null]})` → throws "Cannot read properties of null (reading 'id')". The line is `(review.derivedObligations ?? []).map((o) => o.id)` in `validateCoverageReview`.
- `validateTaskAcceptance({... requiredChecks: [null], status: "accepted"})` → throws while reading `outcome` (the `requiredChecks.some(check => check.outcome …)` call).
- `validatePhaseAcceptance(..., undefined)` and `validateRequirementTaskCoverage(..., undefined)` → throw on `.get`. These are map arguments, which is lower risk, but they still contradict "never throws".
- `computePlanReadiness` with `coverageReview: null`, with `findings: [null]`, or with `null` input → throws. It reads `input.coverageReview.findings` and calls `findingIsUnresolvedBlocking(null)` outside any guard. This is the composite gate, which is exactly where a malformed durable record would arrive.

The I5 test covers only the round-1 probe list plus a few more, so none of these are exercised.

**Fix:** filter `isObj` before the `.map`/`.some` calls. Guard `input` and `input.coverageReview` in `computePlanReadiness`, and filter findings with `isObj`. Guard the map arguments. Extend the I5 test with these exact cases. Correct the T1b.md sentence that says "Now true".

### MINOR

- **NEW-3: a phase's `requirementIds` and `contributingTaskIds` are only resolved, never checked for ownership.** Probe Q: every phase listed every requirement and every task, including those whose `accountablePhaseId` is another phase, and the plan was still `ready:true`. This reintroduces an ambiguous second ownership claim at the phase level (EP03). **Fix:** require `phase.requirementIds` to equal the set of requirements whose `accountablePhaseId === phase.id`, and do the same for tasks, or document the field as contribution-only.
- **NEW-4: I1 wording.** The doc and the `build-spec.ts` comment say "No such pre-T1 reader exists in this codebase today … currently theoretical". That is inaccurate. `main` at `de56fcd6` and every shipped runner build before T1 is exactly such a reader, and running an older runner against the same state directory is the realistic case. The forward-only scope is otherwise stated honestly. **Fix:** replace the sentence with "every runner build before T1 is such a reader; opting a run into planningPolicy is not safe against a downgrade."
- **NEW-5: a blocking finding clears on any self-set `disposition: { resolution: "plan_reconciled" }`** (probe I′ → `ready:true`). The disposition names no resolving review or revision and no fix delta, although §3 says a corrected review "references prior findings and the fix delta". It is acceptable at the contract layer if T3 enforces who may resolve. **Fix:** add a `resolvedByReviewId` or `resolvedInRevisionDigest` reference and require it.
- **NEW-6: the I7 residue.** `validatePhaseAcceptance` still accepts a `not_applicable` requirement whose disposition is any truthy object, for example `{authorizedBy: "", rationale: ""}` (probe H2 → valid). It should reuse the ledger's disposition authorization rule.
- **Remaining residues:** `ValidationObservation.configFingerprint`/`dependencyFingerprint` are optional (I8). `DerivedObligation.recordedAt` is unvalidated (M4). `RetiredRequirementRecord.amendmentRef` and requirement `amendmentRef`s are not resolved against the manifest's amendment chain; any string passes.

## Verification of the worker's claims (Repair cycle 1)

| Claim | Status |
|---|---|
| B1, B2, B3 and B4 fixed, with PROVE-RED for each | **Verified** by my probes; the guards are real. B1 has the NEW-1 bypass. The PROVE-RED edits were not re-executed but are consistent with the code. |
| I2, I3, I4, I6, I7, I8, M1–M4 and M6 fixed | **Verified**, apart from the minor residues listed above. |
| I1 documented honestly, plus a SQLite round-trip test | **Verified.** The one factual slip is NEW-4. |
| I5 "validators never throw — Now true" | **False**: 8 throwing inputs remain (NEW-2). |
| 65/65 targeted tests, tsc 0 | **Verified.** |
| 143 + 123 importer tests, root tsc, eslint | Not re-run in this round. The 143 were verified in round 1, and the importer surface did not change. |
| "The six negative cases are now genuinely true end-to-end via computePlanReadiness" | **Mostly verified.** A plain removal and a section drop now block, but an architect-authored non-normative disposition still makes a removal ready (NEW-1). |

## Verdict

**REPAIR REQUIRED.** This is a small, contained repair: cycle 2 of 3 for these issues.

1. **NEW-1 (BLOCKING):** a non-normative section disposition needs amendment or owner authority, not evidence alone, plus a negative test.
2. **NEW-2 (IMPORTANT):** close the remaining throw paths, extend the I5 test, and correct the evidence claim.

The minor findings NEW-3 to NEW-6 should be fixed in the same pass if cheap, or recorded as accepted residue. Every round-1 blocking issue is otherwise fixed, and nothing I found correct in round 1 has regressed.
