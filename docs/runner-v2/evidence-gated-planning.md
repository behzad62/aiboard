# Evidence-gated planning in Runner V2

Build discussions can opt into evidence-gated planning when creating a fresh run. It is off by default. Existing runs keep their recorded policy; attaching a document or reconnecting never enables planning or approves a source automatically.

## Start a planning run

In the Build run options, enable **Evidence-gated planning**. Choose whether to request optional independent answer review, save the approved specification, and save handoff files to the project or export them only. Specification copy defaults on and handoff files default to saving in the project. **Export only** writes neither handoff files nor a specification copy; implementation files are still written during execution. Answer review defaults off and may add model calls.

The Architect first classifies the request as an answer, a build, or a clarification. An answered request shows its answer and addressed question parts. It needs no build specification or worker execution. A clarification requires your response before proceeding. Optional answer review can be requested or withdrawn on a nonterminal run; if the reviewer is unavailable, the run pauses with the reason and withdrawing that optional review clears that specific gate.

For a build, open **Approve a specification**. Select a nonempty UTF-8 plain-text or Markdown file up to 512 KiB, inspect its preview, then check the explicit approval box and submit. The runner preserves original bytes, including line endings and any UTF-8 BOM, and records source/section digests. An optional JSON section layout uses byte offsets over the original file, not character positions. Approval and upload are separate actions.

## Inspect and start the current plan

The planning panel shows source revisions, requirement references and acceptance conditions, owning phases, task dependencies and scopes, review independence and recorded selection/probe rungs. Conditional requirements stay in the total and unresolved count. A ready plan is still **delivery incomplete**. A phase is verified only through its recorded acceptance at the current revision; an intermediate accepted task does not complete the whole program.

Inspect unread source sections and recorded blockers. Worker candidates are advisory: capacity, claim conflicts, current owner approval, source verification, worktree allocation and the runtime's other gates still apply. A displayed dependency graph or copy-ready card grants no assignment authority.

For an executable build, **Start current plan** approves exactly the displayed plan revision/digest, source manifest/artifact digest and policy versions. A stale choice is refused. Refresh and make a new explicit choice when these change. Plan-only runs never expose an execution start. If you amend the source, supply the replacement original file, reason and added/retired section/requirement IDs, then approve the exact displayed predecessor. Source changes require fresh consent and planning reconciliation.

Model-pass records distinguish reported/estimated usage from estimated context-pack sizes. Missing or ambiguous per-pass attribution is shown as unavailable; account-backed calls do not imply a metered API cost. Historical reviews remain labelled separately from current records. A notice identifies a STATE snapshot edited outside the runner; durable runner records continue to determine readiness and completion.

Fresh planning runs retain every model assigned to a task attempt, including contributors replaced during failover. Independent delivery review excludes all of those models and their aliases. Every delivery review requires at least one real repository inspection, including low-risk changes. Historical runs retain their recorded review policy.

The runner inspects the committed candidate for new product source files without a product reference and for changes containing only tests or test configuration. Either signal raises review to at least medium and appears in the reviewer's protected context. These are conservative facts for review: JavaScript and TypeScript imports use the parser; simple C-family includes are recognized, while raw literals, line splices and unsupported reference syntax retain an unreferenced signal. A signal does not decide whether the work is complete.

## Export, copy and resume

**Inspect export** reads a snapshot without starting workers or changing project files. The STATE text comes from the same bounded renderer used for docs-v2 handoff snapshots. **Copy STATE snapshot** copies that text; **Download planning export** downloads a JSON envelope with source/requirement/task/evidence traceability, phase/contracts/dependencies/ownership, resume index, report template, recorded policies, reviews, decisions and copy-ready reference cards. Choose a project location yourself if you want to save the downloaded file there.

Exports contain redacted, bounded records and artifact references rather than original source bodies, transcripts, credentials or raw environment. Counts disclose omitted records and text identifies truncation. Sanitized export IDs are display references, so use the live runner controls for approval. For a large or truncated contract, inspect the canonical run's current contract and evidence; an export is not a complete substitute for durable state.

Worker cards name the run/source/plan, phase/task contract, required base, current claim where recorded, validation/report references and standing orders. Workers continue only eligible assigned packets, submit for independent review/integration, never self-accept, and persist a precise handoff when blocked or ending. Controller cards require current ownership, dependencies, serialized surfaces and full gate evidence. A resume-planning card forbids implementation, implementation tests, migrations and workloads until execution is authorized.

Native launch chips are not applicable on the current Runner control plane because it exposes no API for non-executing chip preparation. Copying a card creates no task and dispatches no worker. Legacy runs retain their existing documentation policy and do not gain new coverage or cards on replay. Final project handoff always waits for your choice.

## Contract reference and implementation history

The following describes the original T1 contract foundation. The user-facing runtime and controls above supersede the original contract-only shipment status; validator details remain useful for implementers.

Evidence-gated planning turns an approved application specification into a
source-traceable implementation plan, using the existing Build kernel rather
than a second orchestrator. This document describes the contracts T1 landed:
`runner-v2/src/source-manifest.ts` and `runner-v2/src/planning-contracts.ts`,
plus the small versioned extensions to `build-spec.ts` and
`acceptance-contracts.ts`. It is contract-only — no scheduler, runtime, or UI
wiring ships in this task; those are later tasks (T2–T10) in
`docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md`.

This revision incorporates repair cycle 1 (independent review
`T1b-review-r1.md`): four blocking fixes (source-section coverage, provable
manifest byte coverage, coverage-review-to-revision binding, complete phase
contracts) and a set of important/minor fixes described below.

It also incorporates repair cycle 2 (independent re-review
`T1b-review-r2.md`), which found the section-coverage bypass still
reachable through an unauthorized `nonNormativeSections` disposition
(NEW-1, blocking) and eight remaining throw paths (NEW-2, important). Fixes:
amendments now carry a stable `id` and every `amendmentRef` citation
(section disposition, requirement disposition, retired-requirement record)
must resolve against the manifest's actual amendment
(`manifestResolvesAmendmentRef`), not merely be non-empty; a phase's
`requirementIds`/`contributingTaskIds` must exactly equal — not just
resolve to a subset of — the requirements/tasks whose `accountablePhaseId`
actually names that phase (NEW-3); `validatePhaseAcceptance` reuses the
ledger's full not_applicable authorization rule instead of a weaker
truthy-object check (NEW-6); clearing a blocking finding requires a
`resolvedByReviewId`/`resolvedInRevisionDigest` reference, not a self-set
flag (NEW-5); every remaining throw path in `validateCoverageReview`,
`validateTaskAcceptance`, `validatePhaseAcceptance`,
`validateRequirementTaskCoverage`, and `computePlanReadiness` is guarded,
proven by a fuzz test that exercises every exported validator with
null/undefined/`[null]`/`{}` at each argument position (which itself caught
two further real throw paths — a `{}` manifest and a `null` `amendment`
field — fixed the same pass); `ValidationObservation.configFingerprint`/
`dependencyFingerprint` are now required, not optional; and `recordedAt` is
validated as an ISO timestamp everywhere it appears (`DerivedObligation`,
`CoverageReview`, `DeliverableReview`, `PlanningCheckpoint`,
`HostPlanningCapabilities`).

## Source identity: `source-manifest.ts`

`ApprovedSourceManifest` gives a run-scoped, immutable identity to an approved
source document or amendment:

- `artifactDigest` — a sha256 digest of the **original bytes**, never
  rewritten. Sections are recorded by byte span plus their own digest, so the
  original text is preserved by reference rather than copied and reformatted.
- `byteLength` — the total byte length of the original artifact, recorded
  alongside the digest. This is what makes "complete coverage" provable
  rather than merely gap-free: `sections` must be an ordered, contiguous
  inventory covering byte 0 through exactly `byteLength`, with no gap,
  overlap, out-of-order entry, or `endByte` past `byteLength`.
  `validateApprovedSourceManifest` rejects a dropped section anywhere in the
  inventory — including the **last** section (`trailing_bytes_uncovered`),
  which a gap-only check (with no known total) would previously have missed
  — and rejects a section whose `endByte` exceeds `byteLength`
  (`section_exceeds_byte_length`). `assertManifestMatchesBytes` additionally
  checks the recorded `byteLength` against the actual supplied bytes' length.
- `amendment` — present only on a manifest that supersedes a prior one. It
  must name the prior manifest's id and its actual digest;
  `verifyAmendmentReferencesPredecessor` rejects an amendment that points at
  the wrong predecessor or whose predecessor has since drifted.

Build a manifest with `buildSourceManifest(bytes, sections, meta)`; digests
and `byteLength` are always derived from the bytes you pass in, never chosen
by the caller. `validateApprovedSourceManifest` never throws — a
malformed/`null`/`undefined` manifest, or a `null` entry inside `sections`,
yields an issue.

## Planning contracts: `planning-contracts.ts`

This is the section-3 contract set from the P6.6 plan. Every exported
`validate*` function returns `{ valid, issues }` with typed issue codes
carrying `requirementId`/`taskId`/`phaseId` refs and **never throws** on
malformed, `null`, or `undefined` input — every primary parameter is guarded
at the top of the function (a dedicated test,
`I5: validators never throw on malformed/null/undefined input`, exercises
every one of them, including the specific inputs that used to throw:
`validateExecutionTaskContract(null)`, a task with a non-array
`dependencies`, a requirement with a `null` `applicability`, and an
`EvidenceApplicabilityDecision` with an `undefined inspectedImpact`). Every
`assert*` wraps the matching validator and throws with the joined issue
messages. Nothing here judges semantic correctness — that is the Architect's
and independent reviewers' job. These functions only check identities,
completeness, ownership, ordering, and cross-references.

- **`SourceRequirement`** — a stable, run-level requirement: source/section
  refs, purpose, observable outcome, obligation kind (mandatory / conditional
  / compatibility / operational / security / non_functional), exactly one
  `accountablePhaseId`, contributing task ids, and acceptance conditions.
  `applicability.status` is `applicable`, `conditional_pending` (keeps a
  `conditionExpression`, stays visible), or `not_applicable` (requires an
  authorized `disposition`). **A non-conditional obligation (mandatory,
  compatibility, operational, security, non_functional) can only be retired
  by an owner `amendmentRef`** — citing `evidenceRef` alone is accepted only
  for a `conditional` requirement whose condition resolved to not-applicable
  (source §1 / plan §2.4; `unauthorized_mandatory_retirement`).
  `validateRequirementLedger` rejects a duplicate id, two different owning
  phases for the same id, an unknown section/phase ref, a missing acceptance
  condition, and — critically — **any manifest section referenced by no
  requirement and with no authorized non-normative disposition**
  (`uncovered_source_section`): this is what actually catches "a requirement
  was removed", including together with its only task, not just a dangling
  ref left behind by a half-edit. `validateRequirementRemovalAgainstPrior`
  is a second, revision-to-revision guard: a requirement id present in a
  prior `ExecutionPlanRevision` but absent from the current one needs an
  authorized entry in `retiredRequirementIds`, even in the (narrower) case
  where its section happens to still be covered by a different surviving
  requirement. `validateRequirementTaskCoverage` separately rejects a
  requirement whose only contributing task(s) were cancelled without a
  disposition, and rejects an `applicable` requirement whose only live
  contributing tasks are investigation tasks
  (`investigation_only_delivery`) — investigation cannot substitute for
  behavior delivery; a still-`conditional_pending` requirement is exempt,
  since an investigation genuinely is its current, legitimate delivery.
- **`ExecutionTaskContract`** — the full packet contract: scope/exclusions,
  writable/forbidden surfaces, dependencies, a required `requiredBase`,
  inputs/outputs, steps, acceptance/DoD, validation rationale,
  negative-proof applicability, review criteria, integration checks, and a
  three-part `cleanup` (`cleanup`/`recovery`/`rollback`).
  `validateExecutionTaskContract` rejects any missing required field by
  name, rejects blank/whitespace-only entries in every content-bearing list
  (steps, scope, surfaces, etc. — not just an absent field), and requires
  trimmed ids. Acceptance criteria carry stable `{id, text}` pairs (not bare
  strings), and `requirementCriteriaMap` must give **full, resolvable,
  bidirectional** task-local-criterion-to-run-level-requirement traceability:
  every criterion id must appear in the map exactly mapped to a requirement
  in the task's own `requirementIds` (`unknown_criterion_ref` /
  `unmapped_requirement_ref` / `unmapped_criterion`), and
  `validateRequirementTaskLinkSymmetry` (called from
  `validateExecutionPlanRevision`) requires `requirement.contributingTaskIds`
  and `task.requirementIds` to agree in both directions
  (`asymmetric_requirement_task_link`). A bounded investigation task
  additionally carries `investigation` (question, deliverable, decision
  criterion, dependent unlock task ids, resolved against the actual
  revision) — missing or unresolved is rejected too.
  `validateTaskContractGraph` checks the dependency graph is acyclic and
  free of duplicate task ids.
- **`ExecutionPlanPhase`** — every field source §2 / EP06 require: `id`,
  `purpose`, `requirementIds`, `scope` (includes/excludes), `entryConditions`,
  `contributingTaskIds`, `exitCriteria`, `requiredCombinedValidation`, and
  `exitUnlocks` (what the phase's exit gate unlocks). Missing any field is
  `incomplete_phase_contract`; `requirementIds`/`contributingTaskIds` must
  resolve against the revision's actual requirements/tasks.
- **`ExecutionPlanRevision`** — one digest (`computeExecutionPlanRevisionDigest`)
  binds the complete requirement/task/phase snapshot; a revision whose
  content no longer matches its own digest is rejected (`digest_mismatch`),
  and a revision whose recorded source digest no longer matches the
  manifest's actual digest is rejected (`source_digest_changed`) — a changed
  source invalidates the plan revision. It also carries `runId` (binds
  `CoverageReview.runId`), and the optional `nonNormativeSections` /
  `retiredRequirementIds` authorization records described above.
  `validateExecutionPlanRevision` calls `validateApprovedSourceManifest` on
  the supplied manifest before trusting it — a manifest that cannot prove
  its own byte coverage cannot make a revision valid.
- **`ValidationIntent` / `ValidationObservation`** — an observation with a
  `passed` outcome requires at least one selected assertion, zero failures,
  and an `exitCode` that is `null` or `0` (a non-`null`, non-zero exit code
  cannot be cited as `passed`); a dirty snapshot requires a disclosed
  summary. Unknown selection results are never inferred as passing.
- **`EvidenceApplicabilityDecision`** — each of the four impact dimensions
  (dependency/contract/config/environment) is an
  `EvidenceApplicabilityDimensionObservation { inspected, oldIdentity?,
  newIdentity? }`, not a bare boolean — "not inspected" and "inspected and
  found unaffected" are structurally distinct. Impact is derived
  mechanically and fail-closed: a dimension not inspected, or inspected
  without both identities recorded, counts as impacted; only
  inspected-with-matching-identities counts as mechanically unaffected. Any
  impacted (or unproven) dimension forces `outcome: "invalidated"` — a
  blanket "unaffected" claim is rejected.
- **`CoverageReview` / `DeliverableReview`** (OA-1..OA-3) — the coverage
  reviewer must durably record its derived obligations before the plan was
  provided (`recordedBeforePlanOrDiffProvided`); each obligation gets a
  verdict (`covered` / `weakened` / `missing`) at `blocking` or `advisory`
  severity, and a verdict citing an obligation id that was never derived is
  rejected (`verdict_for_undeclared_obligation`). Findings use four
  additive categories (`missing_coverage`, `weakened_obligation`,
  `scope_creep`, `unverified_claim`) on top of the existing eight
  plan-critique categories — verdict words and category words are
  deliberately disjoint vocabularies, and the validator rejects either one
  used as the other. A finding may carry a `disposition` (`resolution`,
  `rationale`, `resolvedAt`) once a later review/revision resolves it.
  `coverageReviewHoldsReadiness` is true while any obligation has a
  `blocking` `missing`/`weakened` verdict (EP44); `computePlanReadiness`
  separately holds on any **unresolved blocking finding**, not only a
  blocking verdict. `CoverageReview` carries `planRevisionDigest` (not just
  `planRevisionId`) — **`validateCoverageReviewBinding`** requires the exact
  current plan revision id AND digest (a plan mutation that keeps the same
  `revisionId` still invalidates a stale review), the exact source manifest
  actually read (`sourceReadManifestId`), the current run (`runId`), and —
  when the revision names one — a matching `coverageReviewId`.
  `computePlanReadiness` calls this binding check. The deliverable reviewer
  must record its findings from the source criteria and diff before it is
  shown the worker's report (`findingsRecordedBeforeReport`, OA-3); at the
  `high` review tier it must additionally record obligations before the diff
  (OA-10 #4). A scoped re-review of either kind must record its own view
  before it receives the prior review's findings (OA-10 #2).
- **`RepairApproachDecision`** — a repeat of a prior failed approach
  *authorized to proceed* (`decision: "new_approach"`) is refused unless
  `newDiagnosticEvidenceIds` contains at least one evidence id not already
  in `priorEvidenceIds`. `decision: "repeat_rejected"` is the Architect's OWN
  record that a proposed repeat WAS rejected — it is the rejection itself,
  not a further proposal to dispatch, so it is not gated by the new-evidence
  rule; it must instead name a `proposedApproachId` already present in
  `priorFailedApproachIds` (`repeat_rejected_not_a_known_repeat`), since
  "rejecting a repeat" of something never attempted is incoherent.
- **`TaskAcceptance` / `PhaseAcceptance`** — a submission is not acceptance:
  `accepted` status requires a bound review id, integration checks, no
  pending required check, and an `acceptedAt`. Phase acceptance requires
  every owned, applicable requirement to have either an authorized
  `not_applicable` disposition, or **every** contributing task (not just
  any one of them) bound to a valid, structurally-checked, accepted
  `TaskAcceptance` (`validateTaskAcceptance` is run on each);
  `requirementIds`/`taskAcceptanceRefs` on the `PhaseAcceptance` are
  cross-checked against the phase's actual owned requirements/contributing
  tasks rather than left as unused declared fields; a still
  `conditional_pending` requirement blocks phase acceptance.
- **`PlanningCheckpoint` / `AssignmentClaim`** — a checkpoint records covered
  source sections, completed contracts, remaining work, and next action.
  `assertClaimReassignable` requires the prior claim's `state` to be
  `stopped_fenced` with recorded `writerStopEvidence`, and the next claim's
  `ownershipGeneration` to advance by exactly one — a check-only inventory
  (timestamps, an absent PR) is not proof of a stopped writer.
- **`HostPlanningCapabilities`** — lives here, not in
  `runner-capability-contract.ts` (that file is an unrelated digest-checked
  runner-extension/plugin-trust contract). Each of the thirteen tracked
  capabilities is marked `enforced` / `procedural` / `unavailable` with
  non-empty evidence. `T1A_SEEDED_HOST_PLANNING_CAPABILITIES` is **not
  authoritative** — it is a point-in-time seed copied from T1a's
  2026-09-23 inspection, kept here only so this task's own fixtures/tests
  have a realistic example value; its `evidence` file:line citations will go
  stale, and downstream tasks (T2 onward) must re-observe the live host
  rather than cite this constant as a present capability (for example, the
  `MAX_WORKERS` ceiling and the issue-level repair-cycle ceiling were
  honestly recorded `unavailable` as of that observation — new work for
  T4/T6, not an invented existing capability).
- **`computePlanReadiness`** — the single composite gate: calls
  `validateExecutionPlanRevision` (which itself calls the manifest
  validator), `validateCoverageReview`, checks for unresolved blocking
  findings, calls `validateCoverageReviewBinding` (id + digest + source +
  run), calls `validateHostPlanningCapabilities`, and — when a
  `priorRevision` is supplied — calls `validateRequirementRemovalAgainstPrior`.
  It returns `{ ready, blockers }`, never a bare boolean, so callers can show
  exactly why a plan is not ready.

## The versioned opt-in

`NativeBuildSpec.planningPolicy?: { version: PlanningPolicyVersion }`
(`build-spec.ts`) is how a **newly provisioned** build opts into evidence-gated
planning. It follows the same pattern as the existing `contextRecording` and
`planCritique` optional fields:

- Absent on every legacy spec — those stay valid and readable exactly as
  before. `recoverLegacyBuildSpec` never adds this field to an old spec.
- When present, `validateBuildSpec` rejects a version this build does not
  recognize (`PLANNING_POLICY_VERSIONS`, currently `[1]`), and rejects any
  unknown key inside `planningPolicy` (it does not silently strip one on
  clone).
- `cloneBuildSpec` copies the field by value, never aliasing the source
  object. `runner-v2/test/build-spec-store.test.ts` round-trips it through
  `SqliteBuildSpecStore` (save, close, reopen, get), not just
  `validateBuildSpec`/`cloneBuildSpec` in isolation.

**Honest scope of the "unsupported new-policy data is rejected" guarantee.**
`validateBuildSpecCore` — the one reader implementation, built from T1
onward — rejects a `planningPolicy.version` outside `PLANNING_POLICY_VERSIONS`.
That is a **forward-compatibility** guard: it stops a spec written by a
*later* `PLANNING_POLICY_VERSIONS` from being silently misread by *this*
build. It is **not** a backward guard: nothing in this module rejects
unknown top-level keys on `NativeBuildSpec` itself, so a reader built
*before* this field existed accepts and silently passes through a spec
carrying `planningPolicy`, running it under legacy rules. This is not a
theoretical/future case: every runner build before T1 — including `main` as
of this writing — is exactly such a reader. Running an older runner build
against a state directory that already contains a `planningPolicy`-opted
run (a downgrade) is the realistic scenario this describes. Opting a run
into `planningPolicy` is therefore not safe against a downgrade to a pre-T1
runner build.

`AcceptanceCriterion.requirementId?: string` (`acceptance-contracts.ts`) is
the minimal extension that lets a task-local criterion explicitly map to a
run-level `SourceRequirement.id`. It is optional — every existing criterion
without it stays valid — and, when present, must be a non-empty string.
`ExecutionTaskContract.requirementCriteriaMap` carries the same mapping at
the planning-contract level (`{ taskLocalCriterionId, requirementId }`
pairs), with the full resolvability/bidirectionality checks described above.

## Fixtures

`runner-v2/test/fixtures/planning-source-fixture.ts` builds a complete
synthetic scenario: a base manifest with mandatory, conditional,
compatibility, operational, security, and non-functional requirements, one
authorized `not_applicable` retirement, a matching task graph (including one
bounded investigation task) with full `EP06` phase contracts, a bound
`ExecutionPlanRevision`, a passing, fully-bound `CoverageReview`, and an
approved amendment manifest. It is exercised end-to-end by
`runner-v2/test/planning-contracts.test.ts`, which proves — through
`computePlanReadiness`, not just a lower-level structural validator in
isolation — that each of the following makes a plan `ready: false`:
removing a requirement together with its only task (leaving its source
section uncovered), removing a requirement across revisions without an
authorized removal record, dropping a source section (including the last
one, and an `endByte` past the recorded artifact length), assigning a
requirement two different accountable phases, changing the source digest,
mutating the plan while keeping a stale coverage review (even with the same
`revisionId`), cancelling a requirement's only implementation task without
disposition, an applicable requirement whose only delivery is an
investigation task, and silently marking a non-conditional obligation
`not_applicable` without an owner amendment.
