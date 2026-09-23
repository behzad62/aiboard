# Independent source-coverage and executability review

## Review identity and method

- Reviewed the immutable original source in full: 364 lines, SHA-256 `8d10a10a9d8c4df4eced181e95acd05b7f956c42ca7bb9dca151ed20ec959022`.
- Reviewed the full proposed plan at blob `4d03f77c2de5e3eb51ee08d74b49782404aef5b1`, raw SHA-256 `8ee940b4a5bb7e92994006ae6b94af4c756e251d84ee415cbab4aceacab97861`, and the complete initial companion state (raw SHA-256 `dc420348c287dd561a3ce7b72e5e90998c18ed73a03b878b25b27047f3e9a7de`). During review, the controller changed only the review status/snapshot lines; the resulting state hash was `16c572a6dac71f0e6eb7f0531ecbee0372e13d0920802fad3e2036293a7a63df` and its blocking verdict/D1/D2 content was unchanged.
- Compared every source section directly with the task contracts and policies, not only with the generated ledger. Repository inspection was limited to concrete path/policy claims. No implementation, test, migration, execution-agent, Git, staging, or P6-cleanup action was performed.

## Verdicts

**Source coverage: NOT YET VERIFIED — scoped repair required.** The draft covers all nine source sections and all eight required output categories, but finding F1 weakens one mandatory repair-loop rule and therefore prevents a passing coverage verdict.

**Executability: NOT YET READY — scoped repair required.** The dependency graph and task sequencing are practical, but F2 leaves known writable surfaces imprecise and F3 misclassifies normal future approval as a planning blocker. After F1–F3 are corrected, re-review only those findings and affected coverage; do not restart this full audit (source lines 48–56, 271–275).

## Mandatory findings

### F1 — The plan reverses and delays the source's no-repeat-without-new-evidence rule

The source requires finite repair budgets **and** prohibits repeating an unsuccessful approach without new evidence (source lines 302–305). The ledger instead says “new evidence required for changed approach” (plan line 257), which is the opposite condition. T6 persists counts and prevents renaming resets but does not gate reuse of a failed approach on new diagnostic evidence (plan lines 186–194). The delivery policy further waits until three unsuccessful rounds for root-cause reassessment (plan line 301), allowing unsupported repetition before then.

**Required repair:** Correct EP25; add to T6 and the repair-state contract a stable failed-approach identity, linked new diagnostic evidence, and an Architect semantic decision on whether the proposed remedy repeats the failed approach. The kernel should mechanically reject the same approach when no new evidence reference is present, while the Architect—not the kernel—decides semantic sameness and evidence relevance. Add a negative acceptance case for a within-budget repeated remedy with no new evidence. Keep the “reassess after 3” rule only as an additional ceiling, not permission for the first three repeats. Re-review EP25, T6, and the repair-policy section.

### F2 — Several currently knowable writable surfaces are placeholders or inaccurate

Every task must define exact scope, exclusions, writable surfaces, dependencies, and contracts (source lines 67–78); unresolved technical facts must be bounded rather than presented as established facts (source lines 90–92). The plan promises grounded/exact paths (plan lines 19, 65) but:

- T1 says to extend `runner-v2/README.md`, which does not exist in the audited checkout and is not marked new (plan line 105).
- T2 says only “spec-store persistence” instead of naming the existing `runner-v2/src/sqlite-build-spec-store.ts` owner (plan line 120).
- T5 says “its SQLite implementation” instead of `runner-v2/src/sqlite-evidence-store.ts` (plan line 166).
- T7 defers an already-locatable policy UI to PREPARE; the current owners are `components/BuildRunPolicyControl.tsx` and `lib/client/native-build-policy.ts` (plan line 198).

**Required repair:** Replace these placeholders with exact existing paths, or explicitly mark an intended file as new. For post-P6.5-only symbols that cannot yet be named, retain the bounded T1 compatibility inspection (plan lines 107–109, 330) but require its accepted output to revise the affected downstream task contracts/write ownership before assignment. That post-P6.5 uncertainty is intentional and is not itself missing source coverage.

### F3 — D1/D2 are not both genuine unresolved planning decisions

The source deliberately separates a ready plan from later execution (source lines 10–14, 355–358). It already supplies the workflow policy, and the plan correctly interprets it as a versioned policy for newly created Builder plans while preserving explicit stronger mandates and existing runs (plan lines 11, 42, 51–60). Therefore:

- D1 is a real change-control/implementation-start approval before modifying the approved master queue, but the recommended `P6.6` placement and dependency are already concrete (plan lines 41, 86, 326). It need not block the planning artifact from becoming ready.
- D2 merely asks the owner to re-approve the policy choice already supplied by the source and narrowed by the plan (plan lines 57, 328). A future concrete conflict or proposed weakening can require owner authority; blanket policy re-approval does not.

The companion state currently blocks plan readiness on both approvals (state lines 5, 41, 53–56). **Required repair:** Mark the new-build policy scope resolved by the source; keep explicit per-run mandate conflicts as conditional owner decisions. Reclassify P6.6 queue insertion and execution start as pre-execution change-control, not missing plan coverage. After F1/F2 correction and scoped independent re-review, use `PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED`; P6/P6.5 completion and explicit start still gate dispatch.

## Direct coverage audit

| Original-source obligation group | Plan coverage | Review result |
|---|---|---|
| Complete source, stable requirements, conditionals, one phase owner, independent coverage review (source 20–56) | Source manifest/contracts and T1–T3 (plan 67–80, 103–147); EP01–EP05 (plan 233–237) | Covered |
| Reviewable executable tasks, exact scope/contracts/acceptance/negative proof (source 62–92) | Common DoD and T1–T8 (plan 97–225); EP06–EP08 (plan 238–240) | Covered semantically; exact-path repair F2 required |
| Durable authority, checkpoints, truthful resume (source 98–130) | T2 and canonical projection/resume (plan 118–131, 268–282); EP09–EP10 | Covered |
| DAG, isolation, exclusive ownership, bounded parallelism, integration owner, cards (source 136–163) | T4, sole `T4 || T5` lane, integration order, cards (plan 82–95, 149–178, 307–322); EP11–EP14 | Covered |
| Delta validation, meaningful red/green, evidence content and reuse/invalidation (source 169–247) | T5 plus policy (plan 164–178, 284–305); EP15–EP20 | Covered |
| One independent deliverable review and delta re-review (source 253–278) | T3/T6 and combined-review policy (plan 133–147, 180–194, 299–303); EP21–EP22 | Covered without duplicate review gates |
| Acceptance conjunction, phase states, finite repair, narrow escalation (source 284–312) | T6 and EP23–EP26 (plan 180–194, 255–258, 301) | Partial: F1 required |
| Final reconciliation, current full-suite candidate, durable completion and eight outputs (source 318–364) | T7/T8, ledger, state/resume, policy, cards and decisions (plan 196–225, 227–332); EP27–EP32 | Covered; readiness classification repair F3 required |

All eight requested planning outputs are present: dependency/lanes (plan 82–95), task contracts/DoDs (97–225), traceability (227–266), durable state/resume (268–282), validation/evidence reuse (284–305), review/integration/final gates (180–225, 284–305), launch cards (307–322), and decisions/coverage location (324–332 plus this review).

## Executability and efficiency assessment

- The graph `T1 → T2 → T3 → (T4 || T5) → T6 → T7 → T8` is acyclic. T4/T5 are the only safe parallel lane, have disjoint named owners, and have a deterministic T4-then-T5 integration order (plan lines 82–95, 149–178). No extra serial phase barrier is imposed.
- T6 is broad but coherently owns the shared acceptance kernel after the two disjoint lanes. Splitting it would create overlapping writers/reviews; serialization is reasonable. T8 is a final integrated gate, not an oversized feature-implementation packet.
- Evidence is reused only with recorded applicability, and invalidation/re-review stays delta-based (plan lines 73–76, 170–178, 295–305). The plan does not duplicate full suites, reviews, evidence stores, or orchestration engines (plan lines 17–49, 58, 78, 99).
- Authority is correctly divided: the kernel enforces identities, actor/transition mechanics and complete references; the Architect decides semantic satisfaction/applicability; only the owner may weaken scope or resolve a real authority conflict (plan lines 7, 56, 74–76, 276). F1's repair must preserve this split.
- Compatibility is intentionally versioned and opt-in; completed legacy history remains readable and active legacy runs are not silently rewritten (plan lines 57, 112, 129–131, 208). No unrelated product engine or migration is introduced.

## Intentionally unresolved or unverified items

- P6.5 is planned, not implemented. Its critic, budget, replan, and context-manifest APIs cannot be verified now. The T1 compatibility map is an appropriate bounded precondition, provided F2's downstream contract-refresh requirement is made explicit (plan lines 40, 65, 107–109, 330).
- P6 cleanup remains outside this review and untouched. Completion of P6/P6.5 blocks execution, not completion of this planning review (plan lines 38–41; state lines 53–56).
- Native non-executing task chips were not established; the source expressly permits complete copy-ready cards as fallback (source lines 157–163; plan lines 307–322). This is not a blocker.
- No implementation behavior, test result, migration safety, platform execution, or final-suite success was verified. Those claims correctly remain future T1–T8 evidence (plan lines 218–225).

**Current review disposition:** `PLAN BLOCKED — F1–F3 require scoped planning correction and affected independent re-review; execution not started.`
