# T1b independent re-review r3 (repair cycle 2): Runner V2 P6.6 T1

I am the same independent reviewer as in the earlier rounds. I worked read-only: no edits, no commits, no stashes. My only file activity was one temporary probe script in `runner-v2/test/`, which I deleted; `git status` is back to the same list as before.

Worktree: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `de56fcd6`, changes still uncommitted.

I formed my view from the code and my re-run probes first, and only then read the "Repair cycle 2" section of `T1b.md`.

## Verification I ran

- `tsc -p runner-v2/tsconfig.json --noEmit` exits 0.
- The five targeted suites (planning-contracts, source-manifest, acceptance-contracts, build-spec-store, task-graph) pass **68/68**.
- A probe script drove the real exports against the restructured fixture. The fixture's active manifest is now `manifest_amend_1`, with `amendment.id = "amend-1"` and 8 sections. When I rebuilt a revision, I re-bound the review to it, so each probe isolates the guard it targets.
- Scope and G-1: the file list is unchanged from earlier rounds, and `runner-capability-contract.ts` and `scheduler-store.ts` show no diff.

## Per-finding table (r2 findings)

| # | Status | Probe evidence |
|---|---|---|
| NEW-1: B1 bypass through a non-normative section | **FIXED** | With s5's requirement and task removed, an evidence-only disposition gives `ready:false` (`uncovered_source_section`). A fabricated `amendmentRef: "amend-99"` gives `ready:false` (`unresolved_amendment_ref`). A mandatory not-applicable with a fabricated amendment gives `unresolved_amendment_ref`. A retired-requirement record with a fabricated ref gives `ready:false`. Residual limits R-1 and R-2 below. |
| NEW-2: remaining throw paths | **FIXED** for every `validate*` function and for `computePlanReadiness` | All eight r2 cases now return issues instead of throwing: a `null` derived obligation, a `null` required check, a missing map argument in phase acceptance and in task coverage, and `computePlanReadiness` with a `null` review, a `null` finding, `null` input or `null` host. So do the new ones I tried: `null` verdicts, `null` phases, requirements and tasks, `null` sections, a `null` amendment, and a `null` retired record. Residual throws exist only outside `validate*`; see R-4. |
| NEW-3: phase ownership | **FIXED** | A phase listing every requirement and task is rejected: the requirement and task lists must match the phase's own `accountablePhaseId` ownership exactly. |
| NEW-4: I1 wording | **FIXED** | `build-spec.ts:34-38` and the doc (around lines 276-280) now say that every pre-T1 build, including `main`, is such a reader, and that a downgrade is the realistic risk. |
| NEW-5: self-set finding resolution | **FIXED as specified** | A `plan_reconciled` disposition with no reference now still holds readiness. Residual limit R-3. |
| NEW-6: phase not-applicable disposition | **FIXED** | An empty disposition in phase acceptance now gives `missing_disposition`, because phase acceptance now uses the same rule as the ledger. |
| Leftover: config and dependency fingerprints | **FIXED** | Both are now required strings. |
| Leftover: `recordedAt` validation | **FIXED** | An invalid `recordedAt` on a derived obligation gives `invalid_derived_obligation`. |
| Leftover: `amendmentRef` checked against the amendment chain | **FIXED**, with limit R-2 | |

## Regression check

Every check below still holds on the new fixture:

- **B1:** removing a requirement together with its task gives `ready:false`. The comparison against the prior revision is still enforced.
- **B2:** dropping the last section gives `trailing_bytes_uncovered`, and dropping a middle section gives `ready:false`.
- **B3:** a stale digest, another source and another run each give `ready:false`.
- **B4:** a phase with no `exitCriteria` gives `incomplete_phase_contract`.
- **I-items:**
  - An asymmetric requirement-task trace is rejected (I3).
  - `[""]` is rejected (I4).
  - A blocking finding holds readiness (I6).
  - Phase acceptance requires every contributing task accepted and rejects one invalid task (I7).
  - A mandatory requirement retired on evidence alone gives `unauthorized_mandatory_retirement` (I2).
- **Two owners:** `conflicting_owner`.
- **Source digest drift:** `ready:false`.
- **A requirement whose only task is cancelled:** `orphaned_requirement`.
- **A silent not-applicable:** `missing_disposition`.
- **OA-2:** a verdict word used as a category, and a category used as a verdict, are both rejected.
- **Legacy parsing:** the build-spec-store suite passes 12/12.
- **Scope and G-1:** unchanged.

## Residual limits (MINOR; none blocks acceptance, record them for T2/T3)

- **R-1: an amendment's scope is not bound to what it retires.** Retiring security section s5 by citing the real `amend-1`, authorized by `"architect"`, gives `ready:true`, even though amend-1 is about section 7. The kernel only checks that the amendment exists. Semantic scope is the independent coverage reviewer's job (T3), since kernel facts are not semantic satisfaction (plan §2.4). A prior revision still catches it through `unauthorized_requirement_removal`.
  - Suggested follow-up: have `SourceManifestAmendment` list `retiresSectionIds` and `retiresRequirementIds` (its "recorded impact"), and require cited retirements to fall inside that list.
- **R-2: only the current manifest's single `amendment.id` resolves.**
  - After a second amendment, retirements that cite `amend-1` stop resolving. The check fails closed, so this is safe, but T2 will need a full amendment-history resolver.
  - A base source with no amendment can never mark a section non-normative, so every section of an unamended source must be covered by some requirement. The section layout has to account for this.
  - Both behaviours are documented in `manifestResolvesAmendmentRef`.
- **R-3: `resolvedByReviewId` is required but never resolved.** A fabricated `"review_fake"` releases a blocking finding (`ready:true`). The fix T3 should make: require `resolvedByReviewId` to equal the current bound coverage review's id, or a known prior review's id, or require `resolvedInRevisionDigest` to equal the current revision digest.
- **R-4: small robustness gaps.**
  - `coverageReviewHoldsReadiness(null)` throws. It is an exported predicate, not a `validate*` function, and `computePlanReadiness` guards the call.
  - `assertClaimReassignable(null, …)` throws a `TypeError` rather than a descriptive error. It is an assert, so throwing is its contract.
  - `validateRepairApproachDecision` accepts `priorFailedApproachIds`, `priorEvidenceIds` and `newDiagnosticEvidenceIds` set to `null`, returning `valid:true`. A validator is accepting malformed input there. The fix is to require these to be arrays.

## Worker claims (Repair cycle 2)

| Claim | Status |
|---|---|
| NEW-1 closed, covering both evidence-only and fabricated refs, with a proof that the guard fails when disabled | **Verified** by probes. R-1 is a limit, not a bypass of NEW-1 as I specified it. |
| NEW-2: validators never throw, backed by a fuzz test | **Verified for `validate*` and `computePlanReadiness`.** The two exported non-validator functions in R-4 still throw. |
| NEW-3, NEW-4, NEW-6 and the three leftovers fixed | **Verified.** |
| NEW-5 fixed | **Verified as specified.** The references are required but not resolved (R-3). |
| Fixture restructuring: the active manifest is the amendment | **Verified.** It is consistent with the resolution rule. |
| 68/68 targeted tests pass, tsc 0 | **Verified.** |
| 143+123 importer suites, root tsc, eslint | Not re-run in this round. The importer surface is unchanged, and the 143 were verified in round 1. |

## Verdict

**ACCEPT.** Every BLOCKING and IMPORTANT finding from r1 and r2 is fixed. I found no regressions, and the scope and G-1 constraints hold. The remaining items (R-1 to R-4) are minor. They should go into the T2 and T3 handoff (amendment-scope binding, a history-aware amendment resolver, resolving `resolvedByReviewId`) or be done as a cheap follow-up (R-4). They do not block T1.
