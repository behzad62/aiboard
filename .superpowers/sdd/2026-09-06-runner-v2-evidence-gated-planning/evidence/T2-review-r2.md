# T2 independent re-review: repair cycle 1

Reviewer: the same independent reviewer as round 1 (Claude Opus 5.5). This was read-only: no repository file was edited, staged or committed.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `21c44efb`, T2 still uncommitted.
Probes are outside the repo in `...\scratchpad\t2probe\`:
- `probe_r2.mts` and `probe2_r2.mts` are the round-1 probes. The only change is the new required `planning.policy_configured` stamp, added after `run.policy_configured`.
- `probe5.mts` holds the round-2 probes.
- `probe_mut.mts` runs against a mutated copy of `src` under `t2probe\mut\`, which is outside the repo.

**Verdict: REPAIR REQUIRED.** The cycle fixed most round-1 findings. It also introduced a new BLOCKING dead end in the acceptance lifecycle, and three fixes are only partial.

## Re-validation (my runs)

| Check | Result |
|---|---|
| Targeted matrix (planning-projection, planning-state, scheduler-store, build-spec-store, replay-compatibility, planning-contracts, source-manifest) | 122 tests, 122 pass, 0 fail, 0 skipped |
| `tsc -p runner-v2/tsconfig.json --noEmit` | no diagnostics |
| eslint on the 6 changed/new files | clean |
| `replay-compatibility.test.ts` | unchanged (`git diff --quiet` passes) and passes |
| SHA-256 of the 6 files | all match the "Repair cycle 1" table |
| Scope | modified: `planning-contracts.ts`, `scheduler-store.ts`, `source-manifest.ts`; new: `planning-projection.ts` and the two tests. No forbidden file touched |

**About `probe3.mts`:** its `ReferenceError: probe is not defined` came from how I wrote that file in round 1. It was a broken intermediate: I cut the file off before the `probe` helper was defined. `probe4.mts` is the corrected version. So this is not a pre-existing product defect, and the worker handled it correctly by running `probe4`.

## Per-finding status

| Finding | Status | Evidence |
|---|---|---|
| **B1**: ledger does not bind the plan | **FIXED** | P1 now throws "Plan revision drops ledger requirement REQ-COMPAT without retirement history" (`assertLedgerBaselineRetained`, planning-projection.ts:340). Ownership now derives from the current revision, or from the ledger before any draft (:475-491). |
| **I1**: wrong next action after ledger | **FIXED** | Q1 now gives nextAction "Cover source section s1." and outstandingWork lists the sections. The new tests cover both interruption points and assert `not_ready`. |
| **I2**: checkpoint not bound to manifest | **FIXED** | Each checkpoint stores the manifest id, digest and per-section digests (:713-724). `resumeIndex` counts a section as covered only when its digest is unchanged. P9: after the amendment, s7 (changed bytes) drops out of coverage and resume points at s7. |
| **I3**: acceptance not bound to facts | **PARTIALLY FIXED; see N3** | P3 (failed), P4 (zero validations) and P8 (task not in plan; refused at claim) are now refused. Fabricated check and review refs are refused. Phase acceptance is reachable (named test). But the integration-ref check can be satisfied by the acceptance event itself (N3). |
| **I4**: references not validated or write-once | **PARTIALLY FIXED; see N4, N5** | P6 now throws "malformed". Acceptance events cannot write evidence refs, and payload refs are write-once. But the observation path still overwrites evidence digests (N5), and a worker can write integration refs (N4). |
| **I5**: observation not bound to claim owner | **FIXED** | P5 throws "Only the claim owner or runner…". N7: a worker observation after its claim is released is refused. |
| **I6**: planning events on legacy runs | **PARTIALLY FIXED; see N6** | A run without the stamp refuses planning events (P16, named test). But the stamp can be appended mid-run to an in-flight legacy run (N6). |
| **I7**: R-1 skipped on the ledger path | **FIXED** | P13 now throws "Amendment amend-1 does not retire requirement REQ-SECURITY… does not cover source section s5". The T1 validators enforce scope whenever an amendment history or an impact is supplied. |
| **M1**: mixed `assertClaimReassignable` contract | **FIXED** | It now returns `void` and throws on every invalid input, null included (planning-contracts.ts:2122). |
| **M2**: prove-reds red by message only | **FIXED (verified)** | See the prove-red section below. |
| **M3**: weak crash and unrelated-resume tests | **FIXED (adequate)** | Crash-before now reduces a real event and then aborts before insert; crash-after persists and reopens. Unrelated resume now tries a second acceptance. The test enshrines the N2 dead end, though. |
| **M4**: acceptance staleness across revisions | **PARTIALLY FIXED** | `plan_revised` reopens acceptances whose task contract digest changed (named test). Still open: `checkpoint_recorded` after `plan_ready` silently resets readiness (P12). A reopened task can never be re-accepted (N2, below). |

**Nothing that held up in round 1 regressed:**
- G-2 actor tables on append and replay: all P10 forged roles are refused.
- The reducer is still pure (structuredClone plus context).
- Idempotent duplicates and WAL-reopen parity pass.
- R-2 via the event path (Q2) and R-4 still hold.
- Stale revision (P15) and interrupted-validation-observed (P14) are still refused.

## Prove-red verification

I rebuilt both mutations on a copy of `src` outside the repo. The mutated hashes match the worker's recorded mutated hashes **byte for byte**.

| Guard | Mutation | Mutated SHA-256 (worker = mine) | Result on a fully valid scenario |
|---|---|---|---|
| Worker self-accept | `PLANNING_EVENT_ACTOR_ROLES["planning.acceptance_recorded"]` gains `"worker"` | `08d1af20…62a2` | Worker acceptance **succeeds** (`"accepted"`). The forbidden action goes through. Genuine. |
| Interrupted-not-passed | `if (false && taskValidations.some(...planned/interrupted/unknown))` | `d1bcb12b…b2a1` | Acceptance with a live interrupted validation **succeeds**. Genuine. |
| Stale revision (unchanged from round 1) | — | — | Already verified in round 1. |

The repo file is unmodified. `planning-projection.ts` is `1ad294c6…b6f1`, equal to the original in the evidence.

## New findings

### BLOCKING

**N1/N2: the acceptance lifecycle has permanent dead ends.**

- **N1: one failed validation blocks acceptance forever.** `assertTaskAcceptanceBindings` (planning-projection.ts:397) refuses if **any** validation of the task, from any intent or revision, has status `failed`. Probe N1 records a RED observation (failed), then a separate GREEN intent that passes, cites the GREEN observation, and has a verified recovery. The result is "Failed validation prevents planning acceptance."
  - This makes every TDD task, and every task that ever failed a check and was then fixed, unacceptable for good.
  - A plan revision does not clear it either, because the check ignores the revision.
  - It contradicts plan §1 (RG-2 row): "Keep both red and green evidence; accepted RED evidence can prove defect detection". The required-GREEN obligation should be satisfied by current passed checks, not blocked by historical REDs.
- **N2: a reopened acceptance can never be accepted again.** `acceptance_recorded` throws "already recorded" whenever any record exists (`:979`), including `status: "reopened"`. Probe N2: accept, reopen, record a new passing validation, re-accept, and it throws.
  - Every task reopened by the new M4 path, or by the Architect, is stuck for good.
  - The test `T2 unrelated resume preserves accepted work…` asserts this dead end (`/already recorded/` after a reopen), so it enshrines the defect.
  - "Do not repeat accepted work" should refuse re-accepting an **accepted** record, not a reopened one.

**Fix:**
- Refuse acceptance only while a *required-check-relevant* validation is failed, planned, interrupted or unknown for the **current** revision. Better still, require every cited required check to be a current passed observation, and treat superseded REDs as history.
- Allow `acceptance_recorded` when the existing record is `reopened`, and keep the prior record as history.
- Change the unrelated-resume test to assert that re-accepting an *accepted* task is refused and that a *reopened* one is accepted again with new evidence.
- Add named tests for RED-then-GREEN and for accept → reopen → re-accept.

### IMPORTANT

**N3: the integration-reference check can be satisfied by the acceptance event itself.** References from `payload.references` are merged into `next.references` before the switch (:656-660). `assertTaskAcceptanceBindings` then resolves `integrationCheckIds` against that merged set (:422-426), so the acceptance event can cite an integration check and create it in the same append. Probe N3: an Architect acceptance citing `never-ran`, with `references: {"never-ran": {kind:"integration"}}`, is accepted. Every acceptance test in `planning-state.test.ts` does exactly this, so the test suite never exercises a real prior integration record. The I3 claim of "resolved integration refs" is therefore hollow.

**Fix:** resolve integration checks against `current.references`, the state before the event. Integration refs should come only from a runner-authored integration-recording event.

**N4: any role, including a worker, can write non-evidence references on any planning event.** `validateEventReferences` runs for every event type and only bars *evidence* refs on acceptance events. Probe N4: a worker's `validation_observed` payload carrying `references: {"integration-worker": {kind:"integration"}}` is stored. A worker could therefore pre-seed the integration refs that acceptance later "resolves". This goes against §2.6 and §7: workers submit observations and reports, while the runner and controller validate integration.

**Fix:** an explicit per-event, per-kind writer table, for example integration/gate refs runner-only and evidence refs only from validation events.

**N5: evidence references are not write-once on the observation path.** `validation_observed` and `validation_reconciled` set `references[observation.evidenceId]` unconditionally (:937-944), overwriting an existing digest. Probe N5: a second observation that reuses `evidence-1` with a different digest replaces `1…1` with `9…9`. That silently rewrites the identity that recovery drift detection compares against, which is the I4 concern reached through a different path.

**Fix:** refuse an observation whose `evidenceId` already exists with a different digest, or key evidence by (id, digest).

**N6: the planning-policy stamp can be appended mid-run to an in-flight legacy run.** `planning.policy_configured` (scheduler-store.ts ~1925-1939) only rejects terminal runs, duplicate stamps and non-runner actors. Probe N6: a legacy `plan_only` run with `plan.created` already applied accepts the stamp and then `planning.source_registered`. Plan §1 says the policy is "selected and persisted at run creation; absence never upgrades a historical/in-flight run". The named I6 test only covers the case with no stamp.

**Fix:** accept the stamp only before any `plan.created` or task lifecycle event (for example, only while `lastSequence` is at most the run-initialization events), or carry it on `run.initialized`/`run.policy_configured`. Add a test that stamps a legacy run mid-flight.

### MINOR

- **N7 (M4 residual):** `checkpoint_recorded` after `plan_ready` still resets readiness to `not_ready` with no reason recorded (P12). Either refuse checkpoints once the plan is ready, or document that a new `plan_ready` is required.
- **Test fixtures:** every acceptance test self-supplies its integration reference in the same event (see N3), so none of them would catch N3 or N4 regressing.

## Verdict

**REPAIR REQUIRED.** Fixed: B1, I1, I2, I5, I7, M1, M2 and M3, and both redone prove-reds really go red because the forbidden action succeeds. Still to fix before ACCEPT:
1. The new BLOCKING N1/N2 acceptance dead ends.
2. The partial fixes: N3/N4 for I3/I4 integration-ref authority, N5 for I4 evidence write-once, and N6 for the I6 mid-run stamp.

Each needs a named negative test.
