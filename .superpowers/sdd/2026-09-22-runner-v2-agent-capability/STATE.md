# STATE — Runner V2 agent capability model and change critique

**Controller-owned. Single writer. This is the entry point for any resume.**

| | |
|---|---|
| SOURCE | `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` |
| PLAN | `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md` |
| Base revision | `6c166f97` on `main` |
| Planning branch | `docs/agent-capability-and-change-critique` |
| Program state | **PLANNING — PLAN BLOCKED on independent planning coverage review** |
| Execution | **NOT STARTED.** No implementation worker has been launched. |
| Last updated | 2026-09-22 |

---

## 1. Planning progress

| Step | State |
|---|---|
| SOURCE written and owner-approved | DONE |
| Requirement ledger (AC-1..AC-18), both directions traced | DONE |
| Phase specifications (I, A, B, C, D) | DONE |
| Packet contracts (I1-I3, A1-A4, B1-B2, C1-C5, D1g) | DONE |
| Dependency graph, acyclic, longest path 7 | DONE |
| Lane roster, ownership map, serialized surfaces | DONE |
| Validation / evidence / review / repair / closure policies | DONE |
| Launch cards (controller + 3 lanes) | DONE |
| **Independent planning coverage review** | **OUTSTANDING — blocks PLAN READY** |

---

## 2. Next eligible action

**One action only:** dispatch the independent planning coverage review.

> Reviewer must be fresh-context and must read the **SOURCE**, not this plan's ledger.
> It checks coverage, acceptance routes, dependencies, ownership and whether each packet
> contract is executable as written. Repair gaps, re-review only corrections and affected
> coverage, then re-issue the §11 verdict.

Nothing else is eligible. Planning readiness does not authorize execution, and no lane may
start before the verdict is PLAN READY.

---

## 3. Assignment registry

| Lane | Worker / session | Base | Worktree | Ownership state |
|---|---|---|---|---|
| Lane A | — | — | — | unassigned |
| Lane B | — | — | — | unassigned |
| Lane C | — | — | — | blocked: opens after B2 integrates and I1, I3 accepted |

There is **no atomic claim primitive** on this host. The controller serializes every
assignment and records it here before a worker starts. Checking a worktree or a PR is not a
lock. Before reassigning a stale claim, verify the previous writer has stopped.

---

## 4. Packet status

All packets `PLANNED`. None assigned, none started.

| Packet | Lane | State | Depends on |
|---|---|---|---|
| I1 | B | PLANNED | — |
| I2 | A | PLANNED | — |
| I3 | B | PLANNED | — |
| A1 | A | PLANNED | — |
| A2 | A | PLANNED | A1 |
| A3 | A | PLANNED | A1 |
| A4 | A | PLANNED | A1, I2 |
| B1 | B | PLANNED | — |
| B2 | B | PLANNED | B1 |
| C1 | C | PLANNED | I1, I3 |
| C2 | C | PLANNED | C1, B2 integrated |
| C3 | C | PLANNED | C2, A1 integrated |
| C4 | C | PLANNED | C3, A3 integrated, B2 integrated |
| C5 | C | PLANNED | C4 |
| D1g | — | PLANNED | A, B, C accepted |

---

## 5. Integration queue

Empty.

---

## 6. Blockers

| ID | Blocks | Condition | Owner | Unblock action |
|---|---|---|---|---|
| BL-1 | PLAN READY | Independent planning coverage review not performed | controller | dispatch a fresh-context reviewer against the SOURCE |

Open questions OQ-1, OQ-2 and OQ-3 are **not** blockers — they are scheduled investigation
packets I1, I2 and I3 with decision criteria in the plan.

---

## 7. Resume procedure

1. Read this file, then the plan's §1 ledger and §5 ownership map, then the contract for the
   packet you are resuming. Load context through this index — do not reread every log.
2. Inspect actual reality: `git branch -a`, `git status`, the worktree list, the merged state
   of `main`, and any open PR. Do not trust a recorded state you have not checked.
3. Reconcile recorded state against actual code and evidence. Correct discrepancies here
   before doing anything else. A checkpoint does **not** prove an interrupted command
   succeeded; re-verify the last recorded action's outcome.
4. Confirm exclusive ownership for the lane per §5.2 of the plan, and that the previous writer
   has stopped.
5. Continue the next eligible unfinished action. A new session does not justify repeating
   completed work.

---

## 8. Decisions recorded during planning

| ID | Decision | Rationale |
|---|---|---|
| PD-1 | 2 lanes, opening to 3 — not the permitted 4 | The dependency graph does not support four. `scheduler-store.ts` and `build-runtime.ts` are contended between Phases B and C, and Phase C depends on Phase A. Inventing a fourth lane would create false parallelism and a real conflict. |
| PD-2 | Thresholds for change risk are measured, not chosen | The P6.5 ledger records which packets carried review-found defects, so ground truth exists. I1 replays the proposed thresholds against those commits with a stated pass criterion. |
| PD-3 | Full suite runs exactly twice | Carried from the P6.5 owner amendment, with the accepted trade-off recorded in plan §6.2. The P6.5 exit gate caught exactly one escape, which validates the trade rather than refuting it. |
| PD-4 | Stage 2 is blind-first | Handing an agent its own prior conclusions recreates the anchoring bias RG-6 removed. Without this, stage 2 degrades to a checklist covering only the smaller P6.5 defect class. |
| PD-5 | Extend the critic rather than add a reviewer role | The finding contracts, blocking gate, resolution flow, selection rule and UI already exist and are already review-shaped. A separate role would duplicate all of it. |

---

## 9. Evidence index

`evidence/` — one file per packet, created when the packet starts. Template in
`evidence/TEMPLATE.md`. No evidence files exist yet.
