# T1b independent review — Runner V2 P6.6 T1 (source identities and complete planning contracts)

Reviewer: fresh-context independent reviewer (read-only). Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `de56fcd6`. The T1b changes are uncommitted in the working tree.
Order followed: (1) source and plan requirements first, (2) diff and new files, (3) worker evidence `T1b.md` last.

## 1. What T1 must deliver (derived before reading the implementation)

From source §1–§2, plan §2, §3, §5.0 (G-1..G-11), T1's contract and acceptance, ledger EP01–EP04, EP06 and EP23, and OA-1..OA-3:

1. **ApprovedSourceManifest**: run-scoped source id; artifact digest over the original bytes; media type and encoding; an ordered, *complete* section inventory; source and amendment authority; revision→prior-manifest chain with owner-authorized amendment; no destructive replacement; unsupported or unreadable sources as explicit blockers.
2. **SourceRequirement ledger**: stable ids; source digest plus section/span refs; purpose and outcome; obligation kind (mandatory, conditional, compatibility, operational, security, non-functional); a conditional expression and an *evidenced* applicability disposition; exactly one accountable phase; contributing tasks and dependencies; acceptance ids with gate and evidence. Removing or weakening an obligation needs an owner-authorized amendment, not a model's `not_applicable` (plan §2.4, source §1). Applicable obligations cannot vanish when a task is cancelled.
3. **Bidirectional traceability** (EP04): every obligation has an owner and an acceptance route. Every packet supports an obligation. Conditional requirements stay in the denominator.
4. **ExecutionTaskContract**: every field in §3 and source §2, including the required base, cleanup/recovery/rollback, and a task-local criterion→requirement map. Investigation tasks carry question, deliverable, decision criterion and dependent unlock, and **cannot substitute for behavior delivery**. Acyclic dependencies.
5. **Phase contract** (EP06, source §2): id, purpose, requirement ids, scope/exclusions, entry conditions, contributing packets, exit criteria, required combined validation, and what the exit unlocks.
6. **ExecutionPlanRevision**: one digest binds the full snapshot. **A mutation invalidates the affected readiness and review decisions.**
7. Validation, evidence-applicability, review, repair, acceptance, checkpoint/claim and HostPlanningCapabilities contracts with the §3 fields. ValidationObservation includes the actual exit code. The evidence decision has the kernel "check all declared identities", because a blanket "unaffected" is insufficient.
8. **OA-1..OA-3 fields**: obligations recorded before the plan is provided; one covered/weakened/missing verdict per obligation; the four additive finding categories disjoint from verdict words (rejected in both directions); a deliverable review that records `independence` and claim verified/unverified status; findings formed before the report.
9. **Acceptance and negative proof**: removing a requirement, dropping a source section, two owners, a changed source digest, cancelling a requirement's only task without disposition, or a silent N/A **cannot produce a valid ready contract**. Missing task steps, scope, validation, review or cleanup are rejected.
10. **Versioned opt-in** in build-spec: legacy specs unchanged; **old readers reject unsupported new-policy active data**; completed legacy history readable; no retrofitting of active runs.
11. G-1: HostPlanningCapabilities in `planning-contracts.ts`. Scope: no scheduler, runtime or UI changes.

## 2. Verification performed

- `tsc -p runner-v2/tsconfig.json --noEmit` → exit 0.
- `tsx --test` on planning-contracts, source-manifest, acceptance-contracts, build-spec-store and task-graph → **51/51 pass**.
- Importer suites (control-server, final-verification-completion, native-build-manager, process-recovery-control, provider-transport, change-set, scheduler-store) → **143/143 pass**. This matches the claimed 109 + 34.
- **Probe script**: a temporary test file, deleted afterwards; `git status` is unchanged. It drove the real exported functions against the worker's own fixture. The results below are observed outputs, not inferences.

## 3. Findings

### BLOCKING

**B1 — "Removing a requirement" still produces a ready plan.** `planning-contracts.ts:163-274` and `:582-638`, and `computePlanReadiness` at `:1464`.
Probe: I removed `REQ-SECURITY` **and** its only task `T4`, then rebound the digest. `computePlanReadiness` returned `ready: true, blockers: []`.
The named test (`planning-contracts.test.ts:48`) only removes the requirement while T4 still references it, so it catches a dangling ref, not a removed obligation. Nothing ties the ledger back to the source. There is no check that every manifest section is covered by at least one requirement or by an explicit, authorized "no obligation" disposition. There is also no check against a prior revision's requirement ids, so a removal would need an amendment.
**Fix:** In `validateExecutionPlanRevision`, require every manifest section id to be referenced by at least one requirement, or by an explicit non-normative/section disposition with an amendment or owner authority. Also add a revision-to-revision guard: a requirement id present in the prior revision and absent now needs an authorized amendment ref. Add a test that removes requirement **and** task together and asserts `ready:false`.

**B2 — "Dropping a source section" still produces a ready plan, and the manifest cannot prove completeness.**
- `computePlanReadiness` and `validateExecutionPlanRevision` never call `validateApprovedSourceManifest`. Probe: a manifest with section s5 dropped (`validateApprovedSourceManifest` → `valid:false`, gap) together with its requirement and task gave `ready: true`.
- `source-manifest.ts:117-183` checks the start at byte 0 and the absence of gaps, but the manifest records no total byte length. Dropping the **trailing** section validates cleanly (probe B2: `valid: true`).
- `assertManifestMatchesBytes` (`:212-231`) never checks that the last `endByte === bytes.length` or that `endByte <= bytes.length`. Probe N and N2: a section with `endByte` 99 over a 3-byte artifact is accepted, and so are uncovered trailing bytes. `buildSourceManifest` has the same gap.
- The doc (`evidence-gated-planning.md`) and the test title at `planning-contracts.test.ts:60` claim "byte 0 through the end" and "rejected at the manifest level". Neither is true of the readiness path.
- The named test passes only because a surviving requirement references the dropped section.
**Fix:** Add `byteLength` to `ApprovedSourceManifest`. Require the last `endByte === byteLength` and `endByte <= bytes.length`, and check `byteLength` in `assertManifestMatchesBytes`. Call `validateApprovedSourceManifest` inside `validateExecutionPlanRevision` / `computePlanReadiness`. Combine with the B1 section-coverage rule.

**B3 — A plan mutation does not invalidate the coverage review.** `computePlanReadiness:1475`.
Readiness compares only `coverageReview.planRevisionId === revision.revisionId`. Probe D: I changed task T1's steps, recomputed the digest and kept the same `revisionId`. The old coverage review still made the plan `ready: true`.
Section 3 requires "one digest binds the complete snapshot; a mutation invalidates the affected readiness/review decisions". The digest is only self-consistency. Nothing binds the review to it.
Related gaps in the same function:
- `sourceReadManifestId` is never compared to `manifest.manifestId` (probe C: a review of `manifest_other` → ready).
- The review's `runId` is unchecked (probe M → ready).
- `revision.coverageReviewId` is never compared to `review.id`.
**Fix:** Add `planRevisionDigest` to `CoverageReview` and require equality with `revision.digest`. Require `sourceReadManifestId === manifest.manifestId`. Cross-check `coverageReviewId` / `review.id`. Add a negative test for each.

**B4 — Phase contract is missing almost every field source §2 and EP06 require.** `planning-contracts.ts:548-551`.
`ExecutionPlanPhase` is `{id, purpose}` only. Source §2 requires requirement ids, scope/exclusions, entry conditions, contributing packets, exit criteria, required combined validation and exit unlock. T1 says "exact API signatures are fixed here for all subsequent tasks", so leaving this out freezes an incomplete contract for T2 onward.
**Fix:** Add the fields. Validate them strictly, and validate that contributing packets and requirement ids resolve.

### IMPORTANT

**I1 — The old-reader requirement is not actually met.** `build-spec.ts:160-170`.
The implementation only makes *this and future* readers reject `planningPolicy.version` values outside `[1]`. A pre-T1 reader (HEAD `validateBuildSpecCore` has no unknown-key check, and `cloneBuildSpec` spreads `...spec`) silently accepts a spec that carries `planningPolicy`. It then runs an active new-policy run under legacy rules, which is exactly what T1 says must not happen ("old readers must reject unsupported new-policy active data"). The doc's claim that "an old reader rejects unsupported new-policy active data" describes a forward-compatibility guard, not the required backward guard.
**Fix:** Gate new-policy data on something old readers already reject. One option: specs that carry `planningPolicy` use `version: 3`, which HEAD rejects with "Unsupported Build spec version". Otherwise, document an explicit owner-approved limitation. Also add a SQLite `save`/`get` round-trip test for `planningPolicy`; the current test exercises only `validateBuildSpec` and `cloneBuildSpec`, not the store.

**I2 — Mandatory obligations can be retired by evidence alone and any authorizer.** `:230-245`.
Probe F: `REQ-MANDATORY` marked `not_applicable` with `authorizedBy: "architect"`, `evidenceRef: "ev1"` and `decidedAt: "x"` → valid. Source §1 and plan §2.4 allow evidence-based N/A only for a *conditional* requirement whose condition resolved. Removing a non-conditional obligation needs an owner amendment.
**Fix:** When `obligationKind !== "conditional"`, `not_applicable` requires `amendmentRef`. Validate `decidedAt` as a timestamp. Conditional requirements should keep their `conditionExpression` after they resolve to applicable or N/A.

**I3 — Task→requirement mapping and bidirectional trace are not enforced.** `:481-493`, `:616-631`.
- `requirementCriteriaMap: []` is valid (probe E3).
- A mapping to a nonexistent `taskLocalCriterionId` or `requirementId` is valid (probe E4).
- `acceptance.criteria` are bare strings with no ids, so `taskLocalCriterionId` cannot be resolved at all.
- Requirement↔task links are one-directional. Probe K: `REQ-COMPAT.contributingTaskIds` was changed to `["T1"]` while T2 still claims `REQ-COMPAT` → ready.
T1 requires that "task criteria remain task-local and explicitly map to run-level requirements".
**Fix:** Give criteria ids. Require every criterion to map to a requirement in `task.requirementIds`. Require `requirement.contributingTaskIds` and `task.requirementIds` to be mutually consistent.

**I4 — The "complete task fields" check accepts empty content and misses required fields.** `:52-54`, `:384`, `:355-358`.
- `isStringArray` accepts `[""]` and `[" "]`, so steps, review criteria and integration checks can be emptied out (probe E).
- `requiredBase` is optional and its absence is accepted (probe E2), yet source §2 lists "Dependencies, required base".
- `cleanup` has recovery and rollback but no cleanup disposition.
- Investigation `dependentUnlockTaskIds` are not resolved against the revision.
- **Investigation tasks can be a mandatory requirement's only delivery** (probe L → ready). Section 3 says they "cannot substitute for behavior delivery".
- There is no strict normalization: ids are not required to be trimmed (unlike `acceptance-contracts.ts`), and unknown keys pass.
**Fix:** Require non-blank entries. Make `requiredBase` required, or require an explicit rationale when absent. Resolve unlock ids. Require each applicable requirement to have at least one non-investigation contributing task. Require trimmed ids.

**I5 — Validators throw on malformed input, contradicting the documented contract.**
- `validateTaskContractGraph` throws `task.dependencies is not iterable` (probe G).
- `validateExecutionTaskContract(null)` throws (probe G2).
- `validateRequirementTaskCoverage` and `validatePhaseAcceptance` dereference `requirement.applicability.status` without guards.
- `validateEvidenceApplicabilityDecision` reads `impact.dependency` on a possibly undefined object.
The doc says every `validate*` "never throws". This also undercuts the `isObj` rationale: guards were added in some places and not in others.
**Fix:** Guard these paths (return an issue instead of throwing) and add a malformed-input test for each.

**I6 — Readiness ignores blocking findings; only verdicts hold it.** `:987-993`.
Probe I: a coverage review with a `blocking` `missing_coverage` finding → `ready: true`. The plan requires that "unresolved mandatory findings block". Findings also carry no disposition or resolution field, so a corrected review cannot reference and resolve prior findings, which §3 requires.
**Fix:** Readiness should also hold on unresolved blocking findings. Add per-finding disposition and resolution references.

**I7 — PhaseAcceptance accepts partial or invalid task acceptances.** `:1186-1214`.
It accepts when *any* contributing task is `accepted`, and it never validates those TaskAcceptance records. Probe H: an `accepted` T2 with no review, no checks and no `acceptedAt` counted toward phase acceptance. `PhaseAcceptance.requirementIds` and `taskAcceptanceRefs` are declared but unused (dead fields). The N/A branch checks only that a disposition exists, not the ledger's authorization rule. EP23 needs the full conjunction.
**Fix:** Require all contributing tasks accepted, or explicitly dispositioned. Run `validateTaskAcceptance` on each. Use or remove the dead fields.

**I8 — ValidationObservation and EvidenceApplicabilityDecision lack the §3 identity fields.**
- The observation has no exit code field ("actual exit/outcome/counts"). Config and dependency fingerprints are optional.
- The applicability decision uses bare booleans, so "not inspected" and "not impacted" look the same. All `false` plus any rationale → `reusable`, which is the blanket-unaffected shape §3 says is insufficient. The kernel is meant to "check all declared identities", but no old/new fingerprints are recorded.
- The `missing_reuse_rationale` branch (`:794-801`) is dead code, because `missing_rationale` (`:803`) always fires first.
**Fix:** Add `exitCode`. Record old/new fingerprint identities per dimension and derive impact mechanically where possible. Delete the dead branch.

### MINOR

- **M1** — `validateRepairApproachDecision` (`:1104`) treats `decision: "repeat_rejected"` as a repeat that needs new evidence. A legitimate record of the Architect *rejecting* a repeat is therefore itself invalid (probe J). The test at `:505-511` asserts exactly this, which is a questionable semantic. Clarify whether `repeat_rejected` records a rejection or a proposal.
- **M2** — `validateRequirementTaskCoverage`'s doc comment (`:284-288`) says a "conditional disposition" exempts orphaning. The code only exempts `not_applicable`.
- **M3** — `planningPolicy` validation accepts extra keys, which `cloneBuildSpec` then strips silently. `recoverLegacyBuildSpec` passes a v1 spec's `planningPolicy` through untouched (the spread) — the only case where a legacy spec could acquire the field.
- **M4** — `validateCoverageReview` does not flag verdicts for obligation ids that were never derived. `DerivedObligation.recordedAt` is not ordered against anything.
- **M5** — `isObj` vs `isRecord`: the workaround is runtime-correct, and the comment explains the narrowing concern. However, because `isObj` returns `boolean`, TypeScript keeps the declared domain type after the check. Property reads such as `task.outcome.user` compile against a non-optional type even though the runtime value is `unknown`. This hides type holes rather than exposing them. Validators taking `unknown` input with real parsers would be cleaner, and the plan asks for "parsers/validators". It is not incorrect as written.
- **M6** — `T1A_SEEDED_HOST_PLANNING_CAPABILITIES` is exported from product code with a hard-coded 2026-09-23 timestamp and file:line citations that will go stale. Consider moving it to a test fixture, or clearly marking it non-authoritative.
- **M7** — A `HostCapabilityObservation.evidence` of any non-empty string passes. That is acceptable at the contract layer, but the truthfulness check is procedural only.

### Things done correctly

- G-1 is respected: `runner-capability-contract.ts` is untouched, and HostPlanningCapabilities is in `planning-contracts.ts`.
- No scheduler, runtime or UI files changed. All touched files are within T1's writable list.
- OA-2's vocabulary is disjoint, with a module-load assertion. The test rejects both directions, and the guards are real.
- Two-owner detection, source-digest drift, the cancelled-only-task orphan check, and silent N/A without a disposition have real guards. The PROVE-RED results for three of them are credible.
- Legacy specs parse unchanged. Legacy recovery does not add `planningPolicy`.
- The OA-1/OA-3 order flags exist and are rejected when false. The worker correctly notes that truthful stamping is T3/T6 work.

## 4. Claim verification (worker evidence `T1b.md`)

| Claim | Status | Note |
|---|---|---|
| tsc runner-v2 0 errors | **Verified** | Re-ran, exit 0 |
| Root tsc / eslint clean | Unverified | Not re-run by reviewer |
| 51/51 targeted tests pass | **Verified** | Re-ran |
| 109 + 34 importer tests pass | **Verified** | Re-ran, 143/143 |
| 123 task-contracts importer tests pass | Unverified | Not re-run; task-contracts.ts is untouched, so low risk |
| PROVE-RED guards 1–3 fail when removed | Plausible / partially verified | The guards exist and the tests assert on them; the edits were not re-executed |
| Six negative cases "each fail to produce a ready plan" (doc and evidence) | **Unverified / false** | Only digest drift goes through `computePlanReadiness`. Removing a requirement and dropping a section yield `ready:true` when done fully (B1, B2). The cancel case is not reachable through readiness at all. |
| Manifest inventory "byte 0 through the end" | **False** | Trailing-section drop and `endByte` overrun are accepted (B2) |
| "Every validate* never throws" (doc) | **False** | I5 |
| Old readers reject unsupported new-policy data | **Unverified / misleading** | True only for future readers (I1) |
| Complete task-field rejection (18 fields) | **Partially verified** | Deleting a field is rejected; blank content, `requiredBase` and mapping validity are not (I3, I4) |
| No scope creep / only listed files touched | **Verified** | git status |
| HostPlanningCapabilities seeded honestly from T1a | Verified as copied | Not re-verified against the source line numbers |
| Conditional pending visible and blocks phase acceptance | **Verified** | |
| Verdict/category disjoint both directions | **Verified** | |

## 5. Verdict

**REPAIR REQUIRED.** Four blocking issues:
- **B1:** removing a requirement still yields a ready plan.
- **B2:** dropping a source section still yields a ready plan, and the manifest cannot prove it covers the whole artifact.
- **B3:** changing the plan does not invalidate the coverage review.
- **B4:** the phase contract is missing most of its required fields.

The first three break two of T1's named negative proofs and §3's rule that one digest binds the whole snapshot.

There are eight important issues. The largest are I1 (a pre-T1 runner silently accepts new-policy specs), I2 (the architect can retire a mandatory obligation with evidence alone) and I3 (task↔requirement mapping is not enforced). The rest are listed in section 3. Each fix is contained within T1's writable files.
