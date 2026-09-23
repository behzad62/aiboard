# Scoped independent coverage re-review — F1–F3

## Identity and scope

- Preserved the complete original-source review in `coverage-review.md`; this re-review examined only F1–F3, their affected source obligations, the supplied correction diff, and the corrected state.
- Verified corrected plan identity: base blob `4d03f77c2de5e3eb51ee08d74b49782404aef5b1` → current blob `7dc424dcab5bd79410e5d49b7e8e0aa3d2311a8f`; current raw SHA-256 `7ef572d4c8eaf796d4a05fbbe8fa59bc7af95b08397049e57d65e14b047457b7`.
- Corrected companion-state raw SHA-256 read for this review: `8cfa1448646cdd9f81595d09df2318400908ca2c65310e666fd96c494fe2f9a0`.
- No implementation, tests, migrations, execution agents, broad code audit, Git operation, staging, or P6 cleanup was performed.

## Finding dispositions

### F1 — Addressed

The source prohibits repeating an unsuccessful approach without new evidence and requires durable finite budgets (source lines 302–305). The corrected plan now:

- defines durable failed/proposed-approach, prior-failure, evidence, lineage, and decision identities in `RepairApproachDecision` (plan line 76);
- requires a decision before **every** repair dispatch, denies same/relabelled approaches without evidence new to that failed approach, and does not treat remaining budget as authorization (plan lines 190–191);
- makes the Architect responsible for semantic sameness/evidence relevance while the kernel checks actors, lineage, prior failure, immutable references, and mechanical novelty (plan lines 76, 191);
- adds the required within-budget negative and relevant-new-evidence positive cases (plan line 194), corrects EP25 (plan line 259), and makes the three-round reassessment an additional ceiling rather than a grace period (plan line 303).

This closes the original reversal and preserves the source's semantic-versus-mechanical authority boundary. No affected weakening remains.

### F2 — Addressed

The source requires exact task scope/writable surfaces and bounded handling of genuine unknowns (source lines 67–78, 90–92). The corrected plan now:

- explicitly creates the new `docs/runner-v2/evidence-gated-planning.md` and gives T7 a later serialized extension of that same document (plan lines 106, 200);
- names `sqlite-build-spec-store.ts` for T2 and `sqlite-evidence-store.ts` for T5 (plan lines 121, 167);
- names `lib/client/native-build-policy.ts` and `components/BuildRunPolicyControl.tsx` for T7 (plan line 200);
- requires T1's bounded post-P6.5 compatibility output to update affected downstream task contracts with exact symbols, writable paths, and ownership before assignment, followed by affected-only review (plan line 110).

These changes do not create a parallel ownership collision: T1 precedes T7, T2 precedes the parallel lanes, and T5 retains its disjoint evidence-store lane. The genuinely unavailable post-P6.5 symbol details remain an explicit bounded pre-execution refinement, not fabricated repository facts.

### F3 — Addressed

The source distinguishes planning readiness from later execution (source lines 10–14, 355–358). The corrected plan and state now:

- retain D1 only as authorization to insert P6.6 into the approved queue and begin implementation, not as a source-coverage blocker (plan lines 87, 328, 334; state lines 41, 54–57);
- mark D2 resolved by the supplied new-plan workflow policy while preserving existing runs, stronger explicit mandates, and future concrete conflict escalation (plan line 330; state line 42);
- block the current state only on this scoped re-review (state lines 5, 39–40), while specifying the correct post-review ready verdict and keeping execution unstarted (plan line 334).

This is the correct authority split: the plan can be ready without silently amending the master queue or authorizing execution.

## Affected-coverage and new-breakage check

- EP25 now exactly covers the missing source condition and points to concrete denial/decision evidence (plan line 259).
- The added repair contract is consumed within the already serialized T1/T6 contract-and-acceptance path; it does not add a second state, budget, reviewer, or orchestration authority (plan lines 76, 79–81, 183–196).
- Exact-path corrections preserve the existing dependency graph and sole T4/T5 parallel lane. The D1/D2 correction changes readiness classification only, not task dependencies or implementation permission.
- No adjacent corrected text drops an original requirement, weakens compatibility, expands P6 cleanup, or changes the eight required planning outputs. All unaffected conclusions from the complete original-source review remain accepted.

## Final verdicts

**Per-finding:** F1 addressed; F2 addressed; F3 addressed. No mandatory scoped finding remains.

**Source coverage:** VERIFIED against the complete original source, combining the preserved full review with this passing affected-only re-review.

**Plan executability:** READY as a complete implementation plan. P6/P6.5 completion, the T1 bounded interface refresh, and D1 queue/start authorization remain explicit future execution prerequisites, not planning defects.

**Planning verdict:** `PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED`.
