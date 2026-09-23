# Scoped planning correction package — F1–F3

Original complete-source review: coverage-review.md. Compare only corrected plan paragraphs and affected coverage. The state index also now marks D2 resolved and D1 as pre-execution authorization; it remains blocked only pending this scoped review. No implementation or tests.

Base plan blob: 4d03f77c2de5e3eb51ee08d74b49782404aef5b1
After plan blob: 7dc424dcab5bd79410e5d49b7e8e0aa3d2311a8f

```diff
diff --git a/4d03f77c2de5e3eb51ee08d74b49782404aef5b1 b/7dc424dcab5bd79410e5d49b7e8e0aa3d2311a8f
index 4d03f77c..7dc424dc 100644
--- a/4d03f77c2de5e3eb51ee08d74b49782404aef5b1
+++ b/7dc424dcab5bd79410e5d49b7e8e0aa3d2311a8f
@@ -71,21 +71,22 @@ These are interface contracts for implementation planning. Detailed TypeScript i
 | `ExecutionTaskContract` | Stable ID and lineage, phase and requirement IDs, purpose, scope/exclusions, writable surfaces and shared-resource claims, dependencies, input/output contracts, steps, acceptance/DoD, validation intent, negative-proof requirements, review criteria, integration checks and cleanup/recovery obligations. Investigation tasks have a bounded question/output and cannot substitute for behavior delivery. |
 | `ExecutionPlanRevision` | Source manifest identity, requirement/task/phase graph, workflow-policy version, planning decisions, validation obligations, current coverage review and budget lineage. One digest binds the complete snapshot; a mutation invalidates the affected readiness/review decisions. |
 | `ValidationIntent` / `ValidationObservation` | Source acceptance IDs, intended behavior/assertions, targeted/affected/final scope with reason; immutable evidence IDs, actual exit/outcome/counts, selected/skipped assertions, command/method, exact clean or dirty snapshot identity and relevant config/dependency/environment fingerprints. Unknown selection results are not inferred as passing. |
 | `EvidenceApplicabilityDecision` | Referenced accepted observation, old/new snapshots, inspected dependency/contract/config/environment impact, reusable or invalidated outcome and rationale. Reviewer verifies semantic scope; kernel checks all declared identities and required fields. A model's blanket “unaffected” is insufficient. |
 | `CoverageReview` / `DeliverableReview` | Independent reviewer/session identity, original source-read manifest, exact plan or change/evidence snapshot, findings with requirement/acceptance/location refs and dispositions. Corrected review references prior findings and the fix delta; unresolved mandatory findings block. |
+| `RepairApproachDecision` | Stable repair-case/task-lineage and failed-approach IDs, prior failure/evidence refs, proposed approach ID, Architect decision and rationale about semantic repetition, and linked new diagnostic evidence. IDs/counts survive renaming, restart and replacement agents. The kernel rejects a repeated failed approach without a new inspectable evidence reference; the Architect judges semantic sameness and evidence relevance. A new label alone cannot establish a new approach or replenish a budget. |
 | `TaskAcceptance` / `PhaseAcceptance` | References to every required current/reused check, review and integration outcome. Derived readiness separate from existing transport/lifecycle status. Reopening uses dependency/requirement edges; it does not rewrite prior evidence. |
 
 Expected **new** modules: `planning-contracts.ts`, `planning-projection.ts`, `source-manifest.ts`, `planning-tools.ts`, `planning-review.ts`, `task-resource-claims.ts`, `validation-policy.ts`, `validation-observation.ts`, `evidence-applicability.ts`, `delivery-acceptance.ts`, `planning-export.ts` under `runner-v2/src/`, with corresponding named tests. Reuse P6.5 contracts rather than introduce duplicate review/budget/context stores. Split responsibilities as above; do not move unrelated scheduler code merely to reduce file length.
 
 The canonical scheduler projection owns source registration, requirement/phase/task revision, review status, acceptance, repair-case lineage and next action. Existing evidence/artifact/session stores retain their own immutable fact bodies. Scheduler entries reference them. Material events include source registration/amendment, plan drafted/revised, coverage reviewed, plan ready, validation observed/reused/invalidated, review decided, integrated validation, acceptance/reopen and repair-budget exhaustion. Exact event names are new T1 output, not existing API claims.
 
 ## 4. Master phase/task dependency table
 
 | Phase | Purpose / priority | Tasks | Entry dependencies | Exit / next unlock |
 |---|---|---|---|---|
-| BP1 | Source preservation, complete contracts and durable authority / Critical | T1, T2 | Owner approves placement/policy; P6/P6.5 interfaces verified and inspected | Complete schema/replay/compatibility proof and accepted contracts unlock BP2 |
+| BP1 | Source preservation, complete contracts and durable authority / Critical | T1, T2 | Owner authorizes queue insertion/execution; P6/P6.5 interfaces verified and inspected | Complete schema/replay/compatibility proof and accepted contracts unlock BP2 |
 | BP2 | Independently coverage-reviewed planning with no execution / Critical | T3 | BP1 | Source-complete reviewed plan can reach ready; planning cannot execute. Unlock BP3 and BP4 independently |
 | BP3 | Safe dependency/resource-based parallel scheduling / High | T4 | BP2 | Admission, isolation and crash recovery checks pass; contributes to BP5 |
 | BP4 | Meaningful delta validation and reusable evidence / High | T5 | BP2 | Evidence identity/reuse/invalidation checks pass; contributes to BP5 |
 | BP5 | Reviewed integration, bounded repair, acceptance and usable exports / Critical | T6, T7 | T4 and T5; T7 follows T6 | Complete task/phase/run gates and client/API projections unlock BP6 |
 | BP6 | Integrated source reconciliation and final candidate certification / Final gate | T8 | BP5 | Required current final suite plus acceptance evidence; proposed P7 dependency then eligible |
@@ -100,26 +101,26 @@ Common task DoD: all task-owned mandatory acceptance conditions below have curre
 
 For each task, PREPARE inspects the accepted dependency snapshots, actual checkout, its contract and relevant source sections. Then establish the relevant negative case, implement the coherent behavior, validate exact/affected scope, review, repair within budget, integrate and validate boundaries. Do not run any of the commands in this document during planning.
 
 ### T1 — Source identities and complete planning contracts (BP1)
 
-**Scope/files:** Create `source-manifest.ts`, `planning-contracts.ts` and their tests. Extend `build-spec.ts`, `task-contracts.ts`, `acceptance-contracts.ts` and `runner-capability-contract.ts` only for the new versioned interfaces. Document the feature in `runner-v2/README.md` with the behavior. No scheduler execution, UI, process control, dependency or lockfile changes.
+**Scope/files:** Create `source-manifest.ts`, `planning-contracts.ts` and their tests. Extend `build-spec.ts`, `task-contracts.ts`, `acceptance-contracts.ts` and `runner-capability-contract.ts` only for the new versioned interfaces. Create the explicitly new feature document `docs/runner-v2/evidence-gated-planning.md` with the behavior. No scheduler execution, UI, process control, dependency or lockfile changes.
 
 **Consumes/produces:** Approved immutable source artifacts and existing Build spec/capability versioning → strict source/requirement/phase/task/validation/review contracts from section 3. Export parsers/validators that return typed issues with source/requirement refs; exact API signatures are fixed here for all subsequent tasks.
 
-- [ ] Inspect post-P6.5 types and record a symbol-level compatibility map; resolve materially missing APIs before downstream work, not through guessed imports.
+- [ ] Inspect post-P6.5 types and record a symbol-level compatibility map; resolve materially missing APIs before downstream work, not through guessed imports. Its accepted output must update the affected downstream task contracts with exact symbols, writable paths and ownership before assignment. Review only those corrections and affected coverage; do not restart unrelated accepted planning work.
 - [ ] Add fixtures for a complete spec with mandatory/conditional/compatibility/operational/non-functional requirements and an approved amendment. Preserve every obligation and source section.
 - [ ] Implement strict normalization, duplicate/unknown-ref rejection, exact one-phase ownership, complete task fields, conditional-pending state, acyclic dependencies and linked supporting tasks.
 - [ ] Add a versioned opt-in contract for newly provisioned builds; old readers must reject unsupported new-policy active data, while completed legacy history remains readable. Do not mutate active old runs into compliant-looking new plans.
 
 **Acceptance/negative proof:** Removing a requirement, dropping a source section, assigning two owners, changing a source digest, cancelling its only implementation task without disposition, or silently marking an obligation inapplicable cannot produce a valid ready contract. Task criteria remain task-local and explicitly map to run-level requirements. Missing task steps/scope/validation/review/cleanup applicability is rejected. No behavioral claim rests on parser tests alone; semantic omissions are T3's independent review duty.
 
 **Validation/review/integration:** New contract tests, existing `acceptance-contracts.test.ts`, `task-graph.test.ts`, `build-spec-store.test.ts`; inspect affected decoder/capability consumers and typecheck. Review source preservation and compatibility, not just fields. T2 consumes the accepted API snapshot. Rollback leaves original source artifacts and old versioned histories intact; no event rewrite.
 
 ### T2 — Authoritative state, resume and requirement reconciliation (BP1)
 
-**Scope/files:** Create `planning-projection.ts`/test; extend `scheduler-store.ts`, spec-store persistence and targeted `scheduler-store.test.ts`/`build-spec-store.test.ts`/recovery tests. Use existing SQLite/event mechanisms. No parallel dispatch or worker-written state exports.
+**Scope/files:** Create `planning-projection.ts`/test; extend `scheduler-store.ts`, `sqlite-build-spec-store.ts` and targeted `scheduler-store.test.ts`/`build-spec-store.test.ts`/recovery tests. Use existing SQLite/event mechanisms. No parallel dispatch or worker-written state exports.
 
 **Consumes/produces:** T1 contracts → role-checked append-only events, source/plan digest projections, state/resume index, stable acceptance and repair-case references.
 
 - [ ] Define exact transition/actor tables and make direct append/replay validators apply the same rules as lifecycle tools.
 - [ ] Persist drafts, current plan revision, requirement/phase ownership, assignments/reviews/integration/evidence refs and next action at meaningful transitions.
@@ -161,11 +162,11 @@ For each task, PREPARE inspects the accepted dependency snapshots, actual checko
 
 **Validation/review/integration:** Deterministic concurrent admission/restart tests; existing graph/scheduler/workspace suites selected by impact; portable path normalization fixtures. Real worktree fixture only during later execution with audited cleanup. Review effect ordering and semantic-resource declarations. Integrate before T5, run graph→workspace→assignment boundary checks, release only proven-owned resources and retain uncertainty. No new mandatory Windows primitive.
 
 ### T5 — Delta validation, meaningful observations and evidence reuse (BP4)
 
-**Scope/files:** Create `validation-policy.ts`, `validation-observation.ts`, `evidence-applicability.ts` and tests; extend `evidence-store.ts`, its SQLite implementation, `evidence-tools.ts` and contract tests only as frozen in T1. No scheduler/factory/integration edits in this parallel lane.
+**Scope/files:** Create `validation-policy.ts`, `validation-observation.ts`, `evidence-applicability.ts` and tests; extend `evidence-store.ts`, `sqlite-evidence-store.ts`, `evidence-tools.ts` and contract tests only as frozen in T1. No scheduler/factory/integration edits in this parallel lane.
 
 **Consumes/produces:** Source acceptance and validation contracts, evidence/artifact records, actual repository snapshots → typed validation observations and explicit reusable/invalidated/unknown applicability decisions.
 
 - [ ] Derive validation intent from acceptance behavior and include consumers/contracts/config/schema/security/isolation impact with a concise reason. Select exact failures first, then affected scope; inspect uncertain dependencies before broadening.
 - [ ] Capture command/method, revision plus relevant uncommitted content, environment/capability/config/dependency fingerprints, actual outcomes/counts and inspectable artifacts. Use machine-readable test adapters where available; unsupported output remains unknown pending explicit assertion evidence, not guessed green.
@@ -185,19 +186,20 @@ For each task, PREPARE inspects the accepted dependency snapshots, actual checko
 
 - [ ] Worker submits change/evidence as ready for review, not accepted. Bind one review to source criteria, submitted revision/diff, surrounding behavior and evidence. Verify reviewer session is independent of the submitting worker; use stronger existing model exclusions when applicable.
 - [ ] Route genuine findings to the owning task; retain accepted unrelated findings/evidence, request fix-delta re-review and rerun failed/newly affected checks. Additional specialist review requires a stored risk/disagreement/source reason.
 - [ ] Keep one integration owner and deterministic integration order. After merge, validate required affected boundaries on the integrated snapshot; task acceptance is distinct from `integrated` and cannot occur before those checks.
 - [ ] Reuse P6.5 budget events. Defaults remain two execution attempts per task and three run-level repair plans where those policies apply. Add a stable repair-case/task-lineage reference so revision, restart, replacement worker or renamed task cannot reset a count; review retries consume the applicable existing attempt/repair authorization rather than an unlimited hidden loop. If post-P6.5 policy lacks this accounting, extend that policy here, not in a separate ledger. Owner-only extension; no model-generated ceiling increase for the new policy.
+- [ ] Before every repair dispatch, persist a `RepairApproachDecision` against prior failed approaches. The Architect decides whether the remedy repeats an unsuccessful approach and whether cited diagnostic evidence is relevant; the kernel validates actor, lineage, prior failure and immutable evidence references. The same failed approach ID, or an Architect-declared repeat, is refused without evidence new to that failed approach's recorded diagnostic set. Merely relabelling the approach or resubmitting the same evidence cannot pass. A within-budget attempt is not automatically authorized; seek new evidence through bounded investigation before repeating the approach.
 - [ ] Compute phase acceptance from its accountable obligations and exit checks. Preserve conditionally inapplicable obligations with authorized disposition/evidence; missing or cancelled coverage remains open. Final-ready requires all applicable requirements and cross-task reconciliation, not just all tasks terminal.
 
-**Acceptance/negative proof:** Self-review, missing mandatory finding resolution, stale fix review, unverified merge, forged acceptance event, exhausted budget, renamed repair and cancelled-only coverage cannot authorize acceptance or completion. Independent task evidence survives an unrelated fix. Source-required specialist/full gates are retained. Routine repair proceeds autonomously; unrelated non-critical findings stay separately assigned; unsafe/authority/conflict/external-owner/control-weakening/budget cases produce genuine blockers.
+**Acceptance/negative proof:** Self-review, missing mandatory finding resolution, stale fix review, unverified merge, forged acceptance event, exhausted budget, renamed repair and cancelled-only coverage cannot authorize acceptance or completion. A repeated failed remedy without new diagnostic evidence is refused even within budget; replay/renaming and reused evidence IDs cannot bypass it. A bound repeat with genuinely new evidence and an Architect relevance decision is eligible only if its budget and other gates also permit it. Independent task evidence survives an unrelated fix. Source-required specialist/full gates are retained. Routine repair proceeds autonomously; unrelated non-critical findings stay separately assigned; unsafe/authority/conflict/external-owner/control-weakening/budget cases produce genuine blockers.
 
 **Validation/review/integration:** Scripted worker→review→fix→integration→acceptance flows; scheduler direct-event/replay and completion tests; P6.5 repair budget/replan, final verification and verifier tests. Fault a previously correct bypass only when no meaningful original RED exercises it. Review cross-boundary admission/acceptance identity, not repeated unchanged task reviews. Rollback retains immutable events/artifacts and uses version compatibility refusal; cancelled/failed integrations leave recoverable exact workspaces.
 
 ### T7 — Planning UI, authenticated APIs, audit and launch cards (BP5)
 
-**Scope/files:** New `planning-export.ts`/test; extend `control-server.ts`, `native-build-manager.ts`, `build-observability.ts`, `lib/client/runner-v2.ts`, `lib/client/native-build-engine.ts`, `components/BuildTaskBoard.tsx`, `components/RunnerV2ObservabilityPanel.tsx` and the existing plan-policy UI as located at PREPARE. Add focused client/UI/e2e tests and user-facing documentation with the feature. No legacy Build adapter or external Codex thread creation.
+**Scope/files:** New `planning-export.ts`/test; extend `control-server.ts`, `native-build-manager.ts`, `build-observability.ts`, `lib/client/runner-v2.ts`, `lib/client/native-build-engine.ts`, `lib/client/native-build-policy.ts`, `components/BuildTaskBoard.tsx`, `components/RunnerV2ObservabilityPanel.tsx` and `components/BuildRunPolicyControl.tsx`. Add focused client/UI/e2e tests and extend T1's `docs/runner-v2/evidence-gated-planning.md` with user-facing planning/start/export behavior. No legacy Build adapter or external Codex thread creation.
 
 **Consumes/produces:** T6 canonical projections and T1 source ingestion contract → source/plan approval interface, readable phase/task/evidence views, state/resume export and copy-ready task cards.
 
 - [ ] Let users identify the approved spec and amendments without flattening away their provenance. Clearly distinguish planning-ready from executable delivery-complete and show remaining requirements/blockers.
 - [ ] Add authenticated/idempotent source, plan-readiness and explicit start controls. Planning-only export or preview never starts a worker. A later start binds the approved plan/source/policy identities; drift requires reconciliation.
@@ -252,11 +254,11 @@ All obligations below are mandatory unless an explicit conditional is described.
 | EP20 | 243–247 | Invalidate affected requirements/tasks only; concise inspectable evidence without transcript duplication | BP4; T5,T6,T7 | Dependency invalidation matrix, unaffected acceptance retained, bounded exports |
 | EP21 | 253–266 | Worker cannot self-accept; one combined independent deliverable review; extra specialist review justified | BP5; T6 | Reviewer authority and exact deliverable binding, review-count/reason assertions |
 | EP22 | 268–278 | Rerun/re-review only concrete concerns, corrections and affected behavior; phase reconciliation reuses valid task reviews | BP5; T6 | Fix-delta review history and unchanged-review/evidence reuse cases |
 | EP23 | 284–292 | Task accepted only with all criteria, current/reused evidence, independent review, integration checks and durable state; mechanical claims honest | BP5; T6 | Direct-event/tool/replay bypass negatives and full conjunction positive |
 | EP24 | 294–298 | Phase accepts only all owned requirements/exit checks; intermediate states never completion verdicts | BP5; T6,T7 | Phase/conditional/cancelled coverage matrix and UI state parity |
-| EP25 | 300–309 | Finite numerical repair budgets survive sessions/replacements/renaming; new evidence required for changed approach; only genuine escalation categories | BP5; T6 | Stable-case budget exhaustion/replay/owner-extension and blocker fixtures |
+| EP25 | 300–309 | Finite numerical repair budgets survive sessions/replacements/renaming; an unsuccessful approach cannot be repeated without new evidence; only genuine escalation categories | BP5; T6 | Stable-case/failed-approach identity, within-budget repeat denial, new diagnostic evidence and Architect decision, exhaustion/replay/owner-extension and blocker fixtures |
 | EP26 | 311–312 | Unrelated non-critical findings remain separately assigned, not silent scope expansion | BP5; T6 | Scoped-finding dispatch and distinct future-owner records |
 | EP27 | 318–324 | Before expensive suite, reconcile original source, valid evidence and combined behavior; targeted omissions repaired without restarting unchanged work | BP6; T8 | Original-source final reconciliation plus negative omitted/integration cases |
 | EP28 | 326–333 | Required full suite on final candidate; batch corrections and revalidate affected scope before fresh final gate | BP6; T8 | Frozen candidate digest, real command results and post-fix invalidation record |
 | EP29 | 335–343 | Final acceptance has no omitted obligation/open mandatory failure, accepted integration, current final validation and durable index; no universal defect-free claim | BP6; T8 | Complete final acceptance conjunction and evidence index |
 | EP30 | 345–353 | All eight requested planning outputs available without duplicated authoritative facts | BP5; T7 | Export snapshot checks against the canonical projection |
@@ -296,11 +298,11 @@ The exact assertion and file selections are named in each task's cases and recor
 
 Impact record: changed behavior → direct assertions → callers/consumers/shared contracts → config/schema/runtime/security/isolation → selected checks and why. Reuse record: original accepted observation + new snapshot + relevant unchanged inputs + inspected dependencies + reviewer-visible rationale. Unknown effect scope triggers bounded investigation and relevant expansion. Material global dependency/configuration changes may invalidate the full final suite; this does not justify repeating it after every local repair.
 
 One independent combined review per coherent deliverable; reviewer reads source requirements, actual diff/surrounding code and relevant evidence. Reruns are for concrete doubts, not duplicate command execution by habit. Fix review examines changed code/findings/affected coverage. Phase exit reconciles requirements and combined behavior using accepted evidence. The final integrated source audit has a distinct cross-task purpose, not another full review of every unchanged task.
 
-For delivery of this feature, use a proposed default **5 governed repair rounds per task**, durable across sessions/replacement agents, with root-cause reassessment after 3 unsuccessful rounds on the same defect. Each round is a fix dispatch plus scoped review. No reset by renaming; exhausted mandatory failures require owner decision. This development budget is distinct from the Builder product's existing task-attempt and P6.5 run-repair budgets described in T6. This proposal does not extend C4's or any older task's budget.
+For delivery of this feature, use a proposed default **5 governed repair rounds per task**, durable across sessions/replacement agents. Before every round, record the failed approach and diagnostic evidence; do not repeat an unsuccessful approach without new evidence, even while budget remains. Root-cause reassessment after 3 unsuccessful rounds on the same defect is an additional ceiling, not permission for three unsupported repeats. Each round is a fix dispatch plus scoped review. No reset by renaming; exhausted mandatory failures require owner decision. This development budget is distinct from the Builder product's existing task-attempt and P6.5 run-repair budgets described in T6. This proposal does not extend C4's or any older task's budget.
 
 No extra synthetic mutation is required when the original relevant failure and repaired success already prove that same guard. Distinct safeguards or already-correct behavior need meaningful negative proof as applicable. Negative-proof artifacts identify expected failure, real observation, restored source identity and the passing result. Setup/import/harness failures are not behavior proof. Explicit stronger source-required fault tests remain obligations until an authorized amendment changes them.
 
 Final candidate gate: current source reconciliation → accepted integrated outputs → required full Runner/client/static/UI/package/platform validation → no mandatory gaps → durable final index and cleanup disposition. A subsequent invalidating fix requires fresh final-candidate evidence; unrelated unchanged evidence may still be reused with proof.
 
@@ -321,12 +323,12 @@ All cards inherit sections 2 and 8 and the task's full contract. Branch/worktree
 
 Host-specific native chips are not prepared: no supported non-executing Builder chip-preparation API was established in this audit. Copy-ready reference cards satisfy the source's fallback. None of these cards launches an execution agent now.
 
 ## 10. Genuine decisions, technical unknowns and planning verdict
 
-**D1 — Placement/scope approval:** Approve the recommended new P6.6 after P6.5 and before P7, or explicitly choose a different insertion. Until approved, the old master dependency chain is unchanged and this feature has no implementation start authority.
+**D1 — Pre-execution change control, not a planning blocker:** The plan concretely recommends a new P6.6 after P6.5 and before P7. Owner authorization is needed before changing that approved master queue or starting implementation. Until then, the old dependency chain is unchanged. This does not prevent a source-coverage-verified planning artifact from being ready.
 
-**D2 — Versioned workflow policy approval:** Approve applying the attachment's efficient review/negative-proof/final-suite defaults to newly created Builder plans while preserving explicit project/source mandates and existing pinned runs. This is not permission to erase prior required tests, reviews or repair budgets. Conflicting mandated source rules are surfaced during plan creation.
+**D2 — Resolved by the supplied source:** Newly created plans under this feature use the attachment's efficient review/negative-proof/final-suite defaults while preserving explicit project/source mandates and existing pinned runs. No blanket policy re-approval is needed. A concrete future unresolved mandate conflict or proposed weakening requires owner authority; none is invented as a present planning blocker. This policy does not erase earlier required tests, reviews or repair budgets.
 
 Material technical unknowns are bounded, not owner questions: exact post-P6.5 critic/budget/context APIs (T1 inspection); available machine-readable test observation formats for arbitrary target projects (T5 adapters with explicit unknown fallback); semantic write/resource dependencies (T3 review plus T4 admission, no claim of automatic proof from filenames); large-source review capacity (T3 complete-section accounting/pause); UI/API source and start compatibility (T7). Unsupported external dependencies become genuine blockers only when safely available alternatives have been exhausted.
 
-Independent planning coverage review reads this file and the original attachment, not only section 6. Its verdict and scoped correction results live in the companion state/review record. This draft does not declare itself coverage-verified. The current planning verdict is owned by the state index; implementation remains unstarted regardless of review completion.
+Independent planning coverage review reads this file and the original attachment, not only section 6. Its verdict and scoped correction results live in the companion state/review record. After correction and passing independent coverage review, the planning verdict is `PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED`. The current verdict is owned by the state index; implementation still requires D1 authorization and verified P6/P6.5 prerequisites regardless of planning readiness.

```

