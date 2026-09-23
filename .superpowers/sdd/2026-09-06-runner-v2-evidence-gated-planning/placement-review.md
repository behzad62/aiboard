# Independent P6.5/P6.6 compatibility and placement review

## Scope and reviewed identities

This is a bounded planning-only review of the placement/compatibility amendment. It preserves the prior complete original-source review and its F1–F3 re-review; only the five saved document deltas and the affected source obligations were reconsidered. Each pair was read with `git diff OLD NEW`:

| Document | Before blob | Reviewed after blob |
|---|---|---|
| Master robust-build plan | `567049f4b8768baa7b54ccf8663c49f2d2b1be13` | `6d1a131f52246f79e7611f21f802b907949a55a6` |
| P6.5 plan | `d097ce7c1d02d489dd5a33706072024333303f01` | `b589dda53d3ae8601a606852f4bd8020085ba6c4` |
| P6.6 feature plan | `7dc424dcab5bd79410e5d49b7e8e0aa3d2311a8f` | `6515b8e9ed29dc0d62e6a1ef0578e69a54890935` |
| Master progress | `7c7025a309daa685cdc309c0df8966261ceb8e66` | `d99d245547497b15e4bea68acaba932ac8de5581` |
| P6.6 progress | `ecf595e9fc674dcf772008e96b1c814a57a49bb5` | `c68f2bba9e67ad5909f723e0b2c1eb7b535f1715` |

Relevant P6.5 contracts, acceptance cases, and instructions were checked directly in blob `b589dda5`, not inferred from the new compatibility table. No implementation, test, migration, workload, execution agent, broad source audit, index/HEAD/branch operation, or P6/C4 action was performed.

## Placement verdict

**PASS — keep P6.5 and P6.6 separate and sequential.** There is substantial shared implementation surface, but no requirement requires incompatible behavior in the same versioned run. P6.5 should establish and verify RG-1–RG-6 first; P6.6 should then extend those frozen contracts under a persisted new-policy discriminator. A merge would enlarge P6.5, mix two delivery doctrines, and make old-run compatibility harder without resolving a real conflict.

The approved chain `P6 → P6.5 → P6.6 → P7` is sound. P6.6 planning readiness is not a P6.6 phase exit and does not unlock P7 (master plan `6d1a131f` lines 27, 96–98; P6.6 plan `6515b8e9` lines 61–63, 348–354).

## Compatibility findings

### 1. Initial critic, mandatory coverage, and correction re-review — compatible

P6.5 deliberately permits `policy_off`, low-risk, non-strict failure, and `plan_only` skips and runs its risk critique only once (P6.5 `b589dda5` lines 1983–1986, 2408–2418, 2632–2638). P6.6 does not reinterpret those events: new-policy coverage is independently mandatory, a risk skip is not coverage approval, worker admission also checks the coverage-ready plan identity, and correction review continues the revision-bound coverage deliverable without emitting a second `plan_critique.requested` (P6.6 `6515b8e9` lines 47, 51–52). This satisfies original-source lines 48–56 while preserving RG-1 history and old-policy behavior.

### 2. `acceptedFailures` versus required GREEN — compatible

P6.5 allows an intentionally failing command to be cited only through a typed, rationalized `acceptedFailures` entry and rejects green, uncited, or non-command entries in that field (P6.5 `b589dda5` lines 18, 522–524). P6.6 leaves that RED evidence valid for defect detection but adds a separate required-check acceptance obligation, so RED-only, zero-selection, or stale evidence cannot satisfy a required passing check (P6.6 `6515b8e9` line 53). This is additive and preserves original-source lines 201–225 and 284–289.

### 3. Repair counts and approach lineage — compatible

P6.5 owns the single durable per-run `repairPlanLimit`, counts both repair sources, survives replay, and permits only user extension (P6.5 `b589dda5` lines 19, 98, 1404–1413). P6.6 explicitly reuses those events/counts, retains the task-attempt cap, and adds stable repair-case/approach lineage plus the no-repeat-without-new-evidence gate; its five-round delivery budget is not product credit (P6.6 `6515b8e9` line 54). No parallel counter or reset path is introduced, satisfying original-source lines 300–309.

### 4. Replan cancellation and source obligations — compatible

P6.5's `request_replan` is one blocking guidance path resolved by answer or plan reconciliation, including cancellation/revision (P6.5 `b589dda5` lines 970–975). P6.6 extends that same reconciliation so run-level source obligations, resource claims, and repair lineage survive task replacement; answered guidance alone cannot satisfy coverage or acceptance (P6.6 `6515b8e9` line 55). This closes the cancellation gap without a second queue and preserves original-source lines 25–46 and 122–130.

### 5. Context manifests and source-read accounting — compatible

P6.5 manifest identity includes run, session, purpose, task/attempt, repository revision, and pack digest; storage is idempotent by that full identity (P6.5 `b589dda5` lines 1534–1593, 1639–1652). P6.6 correctly treats the manifest as context identity/provenance, not proof of semantic reading or a model-call/read counter, and adds separate source-section receipts and coverage records referencing it (P6.6 `6515b8e9` line 56). Distinct review sessions with identical packs remain distinguishable. No second manifest authority is created.

### 6. Two-pass final verification and task-review efficiency — compatible

P6.5's expectations pass is isolated on the baseline before diffs/reviews/final facts, is restart-safe, and is required before a two-pass verdict; old durable policies retain single-pass replay (P6.5 `b589dda5` lines 2645–2666, 2933–2941). P6.6's single combined review replaces duplicate reviews only for one task deliverable; it explicitly preserves the distinct final integrated verifier, independent-model exclusions, exact final revision, and baseline cleanup (P6.6 `6515b8e9` line 57). This preserves original-source lines 253–278 and 318–340.

### 7. Scheduling claims are not a rigid filesystem whitelist — compatible

P6.5 retains the design non-goal of a rigid worker file whitelist (P6.5 `b589dda5` line 11). P6.6 uses claims only for scheduler concurrency/ownership, permits broad exclusive serialization when enumeration is unsafe, and requires RG-4 replanning for insufficient claims; a claim never grants filesystem authority or bypasses P6 confinement (P6.6 `6515b8e9` line 58). This implements original-source lines 136–155 without changing the security model.

### 8. Different delivery doctrines — compatible because scope is explicit

P6.5 keeps serial packets, the mandatory second injected fault, per-packet Runner suite, and its phase gate (P6.5 `b589dda5` lines 28–37, 2945–2958). The master amendment scopes the later source's efficient doctrine only to P6.6 and expressly leaves P1–P6.5, P7, existing runs, and C4 unchanged (master plan `6d1a131f` line 27). P6.6 repeats that boundary and retains any concrete stronger source/project mandate (P6.6 `6515b8e9` lines 59, 317). This is an authorized phase-specific policy, not retroactive evidence substitution.

### 9. Shared files and version compatibility — adequately owned

P6.6 starts only after verified P6.5, freezes the actual APIs in T1, updates affected downstream task contracts before assignment, forbids concurrent edits with P6.5, and requires old/new policy, replay, migration, package, and client compatibility cases (P6.6 `6515b8e9` lines 61, 107, 124–130). This is a bounded future API refresh, not an unresolved design conflict. Unsupported active new-policy state is refused rather than misread.

## Master queue, ownership, count, and verdict consistency

- Master rows now make P6.5 unlock P6.6 and P6.6 unlock P7 subject to OD-1; P7's entry condition exercises the combined product path (master plan `6d1a131f` lines 96–98, 983, 997).
- The master index has 56 existing requirements plus 32 EP requirements = 88. EP01–EP32 remain individually defined in the P6.6 ledger; their BP leaf phase is the sole accountable owner. P6.6 is only the campaign parent/reference, not a second acceptance owner (master plan `6d1a131f` lines 1167–1169). This preserves original-source lines 25–37.
- P6.5's Task 0 instructions now preserve the later P6.6 row, aggregate count, doctrine column, and P7 dependency rather than restoring the superseded direct P6.5→P7 edge (P6.5 `b589dda5` lines 41–44, 120–131).
- Master progress has distinct pending P6.5, P6.6, and P7 rows and records that the amendment closed no phase (master progress `d99d2455` lines 24–35). P6.6 progress preserves prior source-coverage evidence while marking only this new delta under review and keeps every execution task ineligible (P6.6 progress `c68f2bba` lines 5–8, 47–48, 61–64).

No duplicate source owner, stale direct P6.5→P7 dependency, count error, completion claim, or execution authorization remains in the reviewed amendment.

## Final verdict

**Mandatory findings:** none.

**Placement:** separate P6.6 is compatible and approved; no merge or further owner decision is required.

**Prior source-coverage readiness:** remains valid. The amendment adds necessary compatibility, ownership, and campaign-gate constraints linked to existing EP obligations; it neither changes the immutable source nor weakens any previously reviewed obligation. Combining the preserved full review, the F1–F3 re-review, and this affected-only amendment review, the correct planning verdict remains:

`PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED`

P6/P6.5 completion, T1's bounded post-P6.5 contract refresh, and an explicit instruction to resume execution remain future execution prerequisites—not planning blockers or evidence that the product is implemented.
