# T2 independent re-review, round 3 (after repair cycle 2)

Reviewer: the same independent reviewer (Claude Opus 5.5). This review was read-only; no repository file was edited, staged or committed.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `21c44efb`, T2 uncommitted.

Probes live outside the repo in `...\scratchpad\t2probe\`:
- `probe_r2.mts`, `probe2_r2.mts`, `probe5.mts`: rerun unchanged.
- `probe6.mts`: new round-3 scenarios. They record integration refs through the new runner-only `planning.reference_recorded` before acceptance, as the new rules require.
- `probe6_mut.mts`: runs against mutated copies under `t2probe\mut\`.

**Verdict: REPAIR REQUIRED.** Most of the round-2 issues are fixed. But N1's "GREEN then RED is not acceptable" rule is only enforced when the two validation intents are created in the same order as their results. A task can still be accepted when a later result for the same check failed. There is also one related IMPORTANT gap.

## Re-validation (my runs)

| Check | Result |
|---|---|
| Targeted matrix: planning-projection, planning-state, scheduler-store, build-spec-store, replay-compatibility, planning-contracts, source-manifest | 127 tests, 127 pass, 0 fail, 0 skipped |
| `tsc -p runner-v2/tsconfig.json --noEmit` | no diagnostics |
| eslint on the 6 changed/new files | clean |
| `replay-compatibility.test.ts` | unchanged (`git diff --quiet`), passes |
| SHA-256 | `planning-projection.ts` `6266823c…1beb`, `scheduler-store.ts` `f556db06…fdcd7`, `planning-state.test.ts` `153ee519…4d96`; all match the "Repair cycle 2" table, and the other three are unchanged |
| Scope | same 6 files; no forbidden file touched |

## Per-finding status

| Finding | Status | Evidence |
|---|---|---|
| **N1**: acceptance dead end after a failed validation | **PARTIALLY FIXED; see R3-B1 and R3-I1** | RED then GREEN is accepted (probe A). Old-revision RED plus current GREEN is accepted (probe E). Sequential GREEN then RED is refused (probe B: "not the latest passed observation"). **But** GREEN then RED is still accepted when the RED observation lands on an intent created earlier (probe C, R3-B1). A current, unsuperseded RED on a different check identity is also ignored (probe D, R3-I1). |
| **N2**: reopened acceptance can never be recorded again | **FIXED** | Accept, reopen, then re-accept succeeds, and the prior records are kept in `history` (probe F: `historyLen: 2`). Recording again over an **accepted** record is refused (probe F2: "already recorded"). The worker's claim that re-acceptance needs "new evidence" is not enforced (R3-M1). |
| **N3**: acceptance can create the integration ref it cites | **FIXED** | Acceptance resolves integration checks against `current.references` (the state before the event). Any non-`reference_recorded` event that carries `references` is refused: "Only planning.reference_recorded may write planning references" (probe5 N3). |
| **N4**: workers can write integration refs | **FIXED** | `planning.reference_recorded` is runner-only. Architect and worker are refused (G1, G2). Evidence kind is refused on that path (G3). A worker observation carrying references is refused (probe5 N4). |
| **N5**: evidence ids not write-once on the observation path | **FIXED** | Reusing an evidence id with a different digest is refused: "already exists with a different identity" (probe5 N5). The same digest is an idempotent no-op (from the code, and the named test). |
| **N6**: policy stamp can be added mid-run | **FIXED** | A legacy run that already has `plan.created` is refused: "Planning policy can only be configured during run creation" (probe5 N6). Stamping after the run-policy and project-docs prologue still works (H, H2). The guard checks `lastSequence ≤ 3`, `planRevision 0` and empty task, guidance, review and runtime state (scheduler-store.ts ~1932-1950). |
| **M4 remainder**: checkpoint after `plan_ready` silently resets readiness | **FIXED** | P12 now throws "Planning checkpoints cannot be recorded after plan_ready without a new readiness transition". |

**No regressions:**
- **B1:** a draft that drops a ledger requirement is still refused (P1).
- **I1:** the resume index is still correct after the ledger (Q1).
- **I2:** amended s7 still drops out of coverage (P9).
- **I5:** a worker still cannot write on another worker's claim (P5, N7).
- **I7:** an out-of-scope retirement is still refused (P13).
- **G-2 actor tables:** every forged role in P10 is still refused on append and replay.
- **Pure reducer:** still pure.
- **R-2** still works (Q2).
- **R-4** still holds.
- **Stale revision** (P15) and **interrupted validation** (P14, R3) are still refused.
- **Scope** unchanged.

## Prove-red verification (N1, N2)

I rebuilt both mutations on an external copy of `src` and ran my own scenarios against it.

| Guard | My mutation | Mutated SHA-256 | Result |
|---|---|---|---|
| N1: historical RED must not block later GREEN | reinserted the blanket `if (taskValidations.some(failed)) throw …` before the observation scan | mine `bac723f2…6f03`; the worker's `b9ac7d43…` differs only in placement | RED then GREEN (probe A) and old-RED/current-GREEN (probe E) both go red with "Failed validation prevents planning acceptance". **Genuine.** |
| N2: reopened acceptance recordable again | `existing?.status === "accepted"` → `existing` | `db7d4446…1232b`, which **matches the worker's byte for byte** | Reopen then re-accept goes red with "already recorded". **Genuine.** |

The repo file is still `6266823c…1beb` (restored and untouched).

## New findings

### BLOCKING

**R3-B1: GREEN then RED is still accepted when the RED arrives on an earlier-created intent. "Latest" is ordered by when the intent was created, not by when the result arrived.**

`assertTaskAcceptanceBindings` (planning-projection.ts ~432-462) builds `observations` by `flatMap` over `Object.values(projection.validations)`. That is insertion order of the validation keys, which is the order the **intents were created**, with each intent's observations nested under it. It then treats `relevant.at(-1)` as the latest result for the check.

Probe C:
1. Record intents `v-a`, then `v-b`, both for check `REQ-MANDATORY-ac1`.
2. `v-b` is observed **passed**.
3. Later, `v-a` is observed **failed**.
4. Acceptance citing the green observation is **accepted**, although the newest result for that check is a failure.

Recording several intents up front and running them in any order (in parallel, or after an interrupt-and-reconcile via `validation_reconciled`) is normal. So this is a false acceptance past a newer failing check. It fails the controller's stated N1 criterion ("GREEN then RED not acceptable"). The named N1 test covers only the sequential case (intent → observe → intent → observe), so it cannot catch this.

**Fix:** order observations by the order they were appended. For example, store each observation's append position (event sequence or a monotonic counter in the projection) and choose the latest by that. Add a named test for "intents A and B; B passed, then A failed; refuse".

### IMPORTANT

**R3-I1: a current, unsuperseded failed validation on a different check identity no longer blocks acceptance.**

A check's identity is `kind` plus the sorted `acceptanceConditionIds` of its intent. Only the identities of *cited* checks are examined. Probe D:
1. Intent `v-x` covers [ac1] and is observed passed.
2. Intent `v-y` covers [ac1, REQ-OTHER] and is observed **failed** at the current revision.
3. An acceptance that cites only the `v-x` observation is accepted.

The accepter can make a failing current check disappear simply by not citing it. Round 1's blanket refusal overcorrected (N1), but the fix swung to the other extreme.

**Fix:** refuse acceptance while any current-revision validation of the task has a latest outcome of `failed` that no later passed observation of the same identity has superseded. REDs from older revisions stay history. Add a named test.

### MINOR

- **R3-M1: re-acceptance after a manual reopen does not require new evidence.** Probe F re-accepts citing the same old observation right after an Architect reopen at the same revision. The evidence table and the N2 test name say "with new evidence", but the code does not enforce it. Plan-revision reopens (M4) do force new evidence in practice, because old-revision observations are excluded. **Fix:** either require the re-acceptance to cite an observation recorded after the reopen, or record why the reopen happened. At minimum, correct the evidence wording.
- **R3-M2: `planning.reference_recorded` breaks its own transition row.** The table says `plan_drafted -> immutable reference+`, but the reducer accepts it before any plan exists (probe G4: registered right after the source). It also accepts an empty payload as a no-op event (G5). **Fix:** require a drafted plan and at least one reference, or correct the table.

## Verdict

**REPAIR REQUIRED.** Fixed: N2, N3, N4, N5, N6 and the M4 remainder. The N1 and N2 prove-reds are genuine. Nothing that held before has regressed. Repair cycle 3, the last for these issues, must fix R3-B1 (order by when results arrived) and R3-I1 (unsuperseded current failures block), each with a named negative test. R3-M1 and R3-M2 can be fixed in the same pass or recorded as limits.
