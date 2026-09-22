# STATE — Runner V2 agent capability model and change critique

**Controller-owned. Single writer. This is the entry point for any resume.**

| | |
|---|---|
| SOURCE | `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` |
| PLAN | `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md` |
| Base revision | `6c166f97` on `main` |
| Planning branch | `docs/agent-capability-and-change-critique` |
| Program state | **PLANNING — revision 3. PLAN BLOCKED on re-review of corrections.** |
| Execution | **NOT STARTED.** No implementation worker has been launched. |
| Last updated | 2026-09-22 |

---

## 1. Planning progress

| Step | State |
|---|---|
| SOURCE written and owner-approved | DONE |
| Requirement ledger (AC-1..AC-23, AC-9 split into 9a/9b), both directions traced | DONE |
| Phase specifications (I, A, B, C, **E**, D) | DONE |
| Packet contracts (I1-I3, **A0**, A1, **A1b**, A2-A4, **A5**, B1-B2, C1-C5, **E1-E3**, D1g) | DONE |
| Dependency graph, acyclic, longest path 8 | DONE |
| Lane roster, ownership map, serialized surfaces | DONE |
| Validation / evidence / review / repair / closure policies | DONE |
| Launch cards (controller + 3 lanes) | DONE |
| Independent planning coverage review, revision 1 | DONE — **PLAN COVERAGE INSUFFICIENT**, 5 BLOCKING + 9 IMPORTANT, `evidence/plan-review-r1.md` |
| Revision 2: 14 findings addressed, D7 added (AC-19..AC-23) | DONE |
| Re-review of revision 2 | DONE — **PLAN COVERAGE INSUFFICIENT**: 4 of 5 NOT FIXED, 1 new BLOCKING, 4 regressions, `evidence/plan-review-r2.md` |
| Revision 3: all r2 conditions and regressions repaired | DONE |
| **Re-review of revision 3 corrections** | **OUTSTANDING — blocks PLAN READY** |

---

## 2. Next eligible action

**One action only:** dispatch the re-review of revision 3.

> Scope is the revision 3 corrections and the coverage they affect. The reviewer must confirm
> the four r2 blocking conditions (B-1, B-2, B-4, B-5), the new D7-1, and the four regressions
> are genuinely repaired — verified against the repository, not the plan's prose. Both prior
> reviews are at `evidence/plan-review-r1.md` and `evidence/plan-review-r2.md`.

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
| A0 | B | PLANNED | — · **gates every other source packet** |
| I1 | B | PLANNED | — |
| I2 | A | PLANNED | — |
| I3 | B | PLANNED | — |
| A1 | A | PLANNED | A0 integrated |
| A1b | B | PLANNED | A1, B2 integrated · **must integrate before C4** |
| A2 | A | PLANNED | A1 |
| A3 | A | PLANNED | A1 |
| A4 | A | PLANNED | A1, I2 accepted |
| A5 | B | PLANNED | A4, B2 integrated · **must integrate before C2 and C4** |
| B1 | B | PLANNED | A0 integrated |
| B2 | B | PLANNED | B1 |
| C1 | C | PLANNED | I1, I3 accepted — **this alone is the Phase C entry rule** |
| C2 | C | PLANNED | C1, B2 integrated |
| C3 | C | PLANNED | C2, A1 integrated, **A3 integrated** |
| C4 | C | PLANNED | C3, A3 integrated, **B2 + A1b + A5 integrated** (the `build-runtime.ts` release) |
| C5 | C | PLANNED | C4 |
| E1 | C | PLANNED | C2 integrated, **C3 integrated** (one owner for `agent-prompts.ts`) |
| E2 | C | PLANNED | E1, C3 integrated |
| E3 | C | PLANNED | E2, C4 integrated |
| D1g | — | PLANNED | A, B, C, E accepted |

**A1 and A1b are one acceptance unit.** A1 asserts the brokers Lane A owns; A1b adds the
Architect lifecycle assertion on `build-runtime.ts` once Lane B releases it. A1 is not
accepted until A1b is.

---

## 5. Integration queue

Empty.

---

## 6. Blockers

| ID | Blocks | Condition | Owner | Unblock action |
|---|---|---|---|---|
| BL-1 | — | **CLOSED.** r1 review performed; verdict PLAN COVERAGE INSUFFICIENT | controller | superseded by BL-2 |
| BL-2 | — | **CLOSED.** r2 re-review performed; 4 of 5 NOT FIXED plus 1 new BLOCKING and 4 regressions | controller | superseded by BL-3 |
| BL-3 | PLAN READY | Revision 3 corrections not independently re-reviewed | controller | dispatch a re-review scoped to the revision 3 corrections |

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
| PD-6 | B1 retries internally and throws a typed error; no call site is edited | r1 finding B-1. There are five `recordContextPack` call sites in four files, three owned by Lane A and one on no roster. Editing them from Lane B was a parallel-write collision. Throwing a typed error that the dispatcher catches removes the collision entirely. |
| PD-7 | AC-9 split into 9a and 9b, asserted across two brokers | r1 finding B-2. Revision 1 said the Architect list must contain no integrate or complete tool, contradicting D2, and the assertion targeted a broker where those tools are not registered — so it would have passed while proving nothing. |
| PD-8 | A0 captures the compatibility fixture before any source packet | r1 finding I-8. After the work lands, "before" cannot be recorded from the integrated tree. |
| PD-10 | `task-scheduler.ts` joins B2's surface | r2 finding B-1. Its catch converts every `driver.run` rejection into a failed task, so the worker's typed recording error never reaches the dispatcher. A dispatcher-only catch would have left AC-3 false for one role in four while every written test passed. |
| PD-11 | OQ-4 answered with a working default, not left open | r2 D7 obligation 12: silence is not a decision. Stage-1 coverage runs whenever the plan critique runs, plus at medium change risk — one tier lower than defect-hunting. The owner may override before Phase E. |
| PD-9 | D7 adopts the review pattern used on this plan | Owner-identified. A coverage reviewer reads the original request, derives obligations before seeing the artifact, returns a verdict per obligation, and verifies cited claims rather than trusting them. Nothing in Runner V2 reads the user's objective and asks whether all of it arrived. |

---

## 9. Evidence index

| File | Contents |
|---|---|
| `evidence/TEMPLATE.md` | the evidence record shape every packet fills |
| `evidence/plan-review-r1.md` | review of revision 1 — INSUFFICIENT, 5 BLOCKING + 9 IMPORTANT |
| `evidence/plan-review-r2.md` | re-review of revision 2 — INSUFFICIENT, 4 of 5 NOT FIXED, 1 new BLOCKING, 4 regressions |

One file per packet is created when that packet starts. No packet evidence exists yet.
