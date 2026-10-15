# T2 independent re-review, round 4 (after repair cycle 3, the final cycle)

Reviewer: the same independent reviewer as rounds 1–3 (Claude Opus 5.5). Read-only: no repository file was edited, staged or committed.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `21c44efb`, T2 uncommitted.

Probes live outside the repo, in `...\scratchpad\t2probe\`:
- `probe6.mts`, `probe_r2.mts`, `probe2_r2.mts`, `probe5.mts`: earlier probes, rerun unchanged.
- `probe7.mts`: `probe6.mts` plus new round-4 scenarios (F+, F3, K1–K3).
- `probe7_mut.mts`: the same scenarios run against a mutated copy under `t2probe\mut\`.

**Verdict: ACCEPT.**

## Re-validation (my runs)

| Check | Result |
|---|---|
| Targeted matrix (planning-projection, planning-state, scheduler-store, build-spec-store, replay-compatibility, planning-contracts, source-manifest) | 131 tests, 131 pass, 0 fail, 0 skipped |
| `tsc -p runner-v2/tsconfig.json --noEmit` | no diagnostics |
| eslint on the 6 changed or new files | clean |
| `replay-compatibility.test.ts` | unchanged (`git diff --quiet`) and passes |
| SHA-256 | `planning-projection.ts` `c1c78f18…c582` and `planning-state.test.ts` `9f54eda6…6c74` match the "Repair cycle 3" table; the other four files are unchanged from round 3 |
| Scope | same 6 files; no forbidden file touched |

## Per-finding status

| Finding | Status | Evidence |
|---|---|---|
| **R3-B1**: "latest" followed intent-creation order | **FIXED** | Each observation now gets a monotonic `observationOrderByObservationId`, assigned when it is appended in `validation_observed` / `validation_reconciled`. Acceptance sorts current-revision observations by that order (planning-projection.ts ~444-452). Probe C (intents A and B; B passes, then A fails) is **refused**: "Current failed validation for check …". New probe K2 (A interrupted; B passes; A later reconciled as failed) is **refused**. Its mirror K1 (A later reconciled as passed) is **accepted**. Sequential GREEN then RED (B) is still refused. A duplicate observation id is refused (K3), so the order key is unique. |
| **R3-I1**: uncited current failure did not block | **FIXED** | Every current-revision check identity is scanned, and acceptance is refused when that identity's latest appended result is failed (~456-466). Probe D (an uncited failing check on another identity) is **refused**. Failures from older revisions stay as history: probe E (old-revision RED, current GREEN) is **accepted**. RED then GREEN on the same identity (A) is **accepted**. |
| **R3-M1**: re-acceptance after reopen could reuse old evidence | **FIXED** | A reopen stamps `reopenedAtObservationOrder`, and re-acceptance must cite at least one observation ordered after it (~492-497). Probe F (same old evidence) is **refused**. F+ (fresh evidence after the reopen) is **accepted**. F3 (a second reopen, then citing evidence gathered after the *first* reopen) is **refused**. Plan-revision reopens (M4 path, ~382) set the same boundary. |
| **R3-M2**: `reference_recorded` accepted before a plan or with an empty payload | **FIXED** | G4 (before any plan) is refused with "Planning references require a drafted plan". G5 (empty payload) is refused with "requires at least one reference". The table row now matches the reducer. |

## Prove-red verification (R3-B1, R3-I1)

I rebuilt each mutation on an external copy of `src` and ran my own scenarios against it.

| Guard | My mutation | Mutated SHA-256 (mine) | Result |
|---|---|---|---|
| R3-B1 append order | `).sort((left, right) => left.order - right.order)` changed to `).sort(() => 0)`, which falls back to intent-creation order | `433065f4…af23` | Probe C and probe K2 flip to **accepted**, so the forbidden acceptance past a newer RED goes through. The worker's mutation (a zero comparator) is the same edit; its hash differs only by exact text. **Genuine.** |
| R3-I1 uncited-failure scan | skipped the `for (const identity of identities)` loop | `d16e94bf…250e` | Probe D flips to **accepted**. **Genuine.** With this scan disabled, C and K2 are still refused by the separate check that each cited observation is the latest for its identity, so the two guards do not depend on each other. |

The repo file is still `c1c78f18…c582`, untouched.

## Regression check: everything that held in round 3 still holds

| Area | Result |
|---|---|
| B1 | P1 refused |
| I1 | Q1 gives the correct next action |
| I2 | amended s7 drops out of coverage (P9) |
| I3/N3 | P3/P4/P8 refused; acceptance cannot write references |
| I4/N4 | only runner `reference_recorded`; G1/G2/G3 refused |
| I5/N7 | foreign or released worker refused |
| I6/N6 | no stamp means no planning events (P16); a mid-run stamp is refused; a stamp during run creation is accepted (H/H2) |
| I7 | P13 refused |
| N2 | re-recording over an accepted record is refused (F2); a reopened record can be accepted again with fresh evidence (F+) |
| N5 | evidence write-once |
| M4 | a checkpoint after `plan_ready` is refused (P12) |
| G-2 actor tables | every P10 forged role refused, on append and replay |
| Other | stale revision (P15) and interrupted-validation-observed (P14) refused; R-2 (Q2) and R-4 hold; the reducer stays pure; observation order is stored in the projection, so replay is deterministic and WAL-reopen parity passes in the suite |

## New findings

None at BLOCKING, IMPORTANT or MINOR level.

One non-blocking note for the evidence file: the round-1 limit still applies. Recovery identity is supplied by runner observations, not read from Git or the filesystem inside the pure reducer. It is correctly disclosed as a limit.

## Verdict

**ACCEPT.**
- R3-B1, R3-I1, R3-M1 and R3-M2 are fixed.
- The R3-B1 and R3-I1 prove-reds are genuine: removing either guard lets the forbidden acceptance through.
- Nothing regressed.

Every finding from rounds 1–3 (B1, I1–I7, M1–M4, N1–N6, R3-*) is now closed. Only the importer-matrix result, which the controller runs outside the sandbox, is not part of this review.
