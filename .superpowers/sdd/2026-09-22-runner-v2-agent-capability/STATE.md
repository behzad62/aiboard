# STATE — Runner V2 agent capability model

**Controller-owned. Single writer. Entry point for any resume.**

| | |
|---|---|
| SOURCE | `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`, revision 4 |
| PLAN | `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md`, revision 11 |
| Moved scope | D4, D5, D7 → P6.6 owner amendment `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md` |
| Base revision | `6c166f97` on `main` |
| Planning branch | `docs/agent-capability-and-change-critique` |
| Program state | **PLANNING — revision 11. PLAN BLOCKED on independent re-review of revision 11.** |
| Execution | **NOT STARTED.** No implementation worker has been launched. |
| Last updated | 2026-09-22 |

---

## 1. Planning history

| Step | Outcome |
|---|---|
| Revision 1 | reviewed — INSUFFICIENT, 5 BLOCKING + 9 IMPORTANT (`evidence/plan-review-r1.md`) |
| Revision 2 | reviewed — INSUFFICIENT, 4 of 5 repairs NOT FIXED, 1 new BLOCKING, 4 regressions (`-r2.md`) |
| Revision 3 | reviewed — INSUFFICIENT, B-1 became a NEW DEFECT (`-r3.md`) |
| Revision 4 | reviewed — INSUFFICIENT; B-1 and B-4 exhausted their budget (`-r4.md`) |
| Revision 5 | five repairs; ESC-1 and ESC-2 escalated to the owner |
| Owner decisions 2026-09-22 | ESC-1 → A (one more cycle); ESC-2 → A (git attribution, not the audit list); **split: D4, D5, D7 moved to P6.6** |
| Revision 6 | scope reduced to D1, D2, D3, D6; both ESC decisions applied |
| Review of revision 6 | INSUFFICIENT (`evidence/plan-review-r5.md`): pause, retry, waiver, D2, D3, graph and moved scope all clean; **B-1 `abort` NOT FIXED** (supervisor unreachable) and **A5 UNSOUND** (integration driver needs a worker session) |
| Owner decisions 2026-09-22 (2) | **ESC-3 → A, both:** one final cycle each for B-1 `abort` and A5. **D8:** reviewer independence — distinct model preferred, fresh context fallback, same rule everywhere |
| Revision 7 | SOURCE revision 3 (D1 constraint 4, D6 reachable wiring, D8/AC-24); plan: B2 abort via scheduler `failed` + `cli.ts` hook; A5 via its own `documentApplier` port in `native-build-factory.ts`; new packet R1 |
| Re-review of revision 7 | INSUFFICIENT (`evidence/plan-review-r6.md`): **B-1 `abort` REPAIRED**; graph, lanes and §5.2 clean; **A5 NOT FIXED** (new defect: `commitTask(taskId)` looks up workspace id `taskId`, not the `<taskId>:document` workspace the applier created — ESC-3's final cycle is spent); **R1-1** (`parseVerifierReviewRequest` in `verifier-contracts.ts` rejects the same-model fallback; cycle 1 of 3) |
| R1-1 repair | `verifier-contracts.ts` added to R1; both identity rejections accept the selected runtime only for `fresh_context` |
| ESC-4 | owner discussion 2026-09-23: A5's task kind replaced — the Architect maintains `docs/project/**` plus marked `AGENTS.md`/`CLAUDE.md` sections, committed on the integration branch; completion check on `STATE.md` (owner: "A ofcourse") |
| Revision 8 | SOURCE revision 4 (D6 rewritten, AC-7/AC-17 rewritten, AC-25 added, OQ-2 closed); I2 removed; A4 `write_project_doc`; A5 `commitProjectDocuments` + worker refusal + completion check |
| Re-review of revision 8 | INSUFFICIENT (`evidence/plan-review-r7.md`): R1-1 REPAIRED; graph, §5.2, cards clean; new A5 BLOCKING A5-1 (commit never runs on the completion path), A5-2 (document commit breaks handoff equality), A5-3 (legacy bit unreachable); IMPORTANT A5-4..A5-7; MINOR A5-8 |
| Revision 9 | all eight fixed — cycle 1 of 3 on the new A5 |
| Re-review of revision 9 | INSUFFICIENT (`evidence/plan-review-r8.md`): A5-1, A5-2, A5-4..A5-8 FIXED; **A5-3 NOT FIXED** (stamp unreachable: `initializeRun` appends first); IMPORTANT N1 (tip clearing on an ancestor return), N2 (fixtures), N3 (section body unnamed) |
| Revision 10 | A5-3 cycle 2 of 3; N1–N3 cycle 1 |
| Re-review of revision 10 | INSUFFICIENT (`evidence/plan-review-r9.md`): A5-3 FIXED, N2 FIXED; N3 NOT FIXED (template lacked the markers the fact checked); N1 NEW DEFECT (empty change set cleared the tip) |
| Revision 11 | N1 and N3, cycle 2 of 3 |
| **Independent re-review of revision 11** | **OUTSTANDING — blocks PLAN READY** |

---

## 2. Next eligible action

**One action:** an independent re-review of revision 11, scoped to A5 steps 5 and 8 and their
acceptance lines, verified against the repository. Everything found clean in `plan-review-r6.md`
to `-r9.md` is reused. After a sufficient verdict the next action is **A0** (execution still needs the
owner's instruction to start).

Nothing else is eligible. Planning readiness does not authorize execution.

---

## 3. Assignment registry

| Lane | Worker / session | Base | Worktree | Ownership |
|---|---|---|---|---|
| Lane A | — | — | — | unassigned |
| Lane B | — | — | — | unassigned |

No atomic claim primitive exists on this host. The controller serializes every assignment and
records it here before a worker starts. Before reassigning a stale claim, verify the previous
writer has stopped.

---

## 4. Packet status

All `PLANNED`. Each `Depends on` copies the plan's §4 edge list.

| Packet | Lane | Depends on |
|---|---|---|
| A0 | B | — (gates every source packet) |
| A1 | A | A0 |
| A2 | A | A1 |
| A3 | A | A2 |
| B1 | B | A0 |
| B2 | B | B1 |
| A1b | B | A1, B2 |
| A4 | B | A3, A1b |
| A5 | B | A4 |
| R1 | B | A3, A5 |
| D1g | controller | R1 |

A1 and A1b are one acceptance unit sharing one evidence file.

---

## 5. Integration queue

Empty.

---

## 6. Blockers

| ID | Blocks | Condition | Owner | Unblock |
|---|---|---|---|---|
| BL-1 … BL-4 | — | CLOSED — planning reviews r1–r4 performed | controller | superseded |
| ESC-1 | — | **DECIDED:** option A, one owner-granted extra repair cycle for B-1 | owner | applied in revision 6 |
| ESC-2 | — | **DECIDED:** option A, Architect ChangeSet attributed in git, absent from the audit's accepted-change list | owner | applied in revision 6 |
| BL-5 | — | CLOSED — superseded by the scope change | controller | — |
| BL-6 | — | CLOSED — review of revision 6 performed (`plan-review-r5.md`) | controller | — |
| ESC-3 | — | **DECIDED:** option A for both — one final cycle each for B-1 `abort` and A5 | owner | applied in revision 7 |
| BL-7 | — | CLOSED — revision 7 re-reviewed (`plan-review-r6.md`) | controller | — |
| ESC-4 | — | A5's commit step addresses the wrong workspace; the reviewer's own fix is to commit the `TaskWorkspace` object via `commitWorkspace` (`workspace-manager.ts:136`); ESC-3's last cycle is spent | owner | **DECIDED:** mechanism replaced (SOURCE D6 revision 4) |
| **BL-8** | PLAN READY | revision 11 (A5 steps 5, 8) not re-reviewed | controller | dispatch one scoped re-review |

---

## 7. Resume procedure

1. Read this file, then the plan's §1 ledger and §5 ownership, then the packet contract.
2. Inspect reality: branches, `git status`, worktrees, the state of `main`, open PRs.
3. Reconcile recorded state with actual code and evidence before anything else. A checkpoint
   does not prove an interrupted command succeeded.
4. Confirm exclusive ownership per the plan's §5.2 and that the previous writer has stopped.
5. Continue the next eligible action. Do not repeat accepted work.

---

## 8. Decisions

| ID | Decision | Rationale |
|---|---|---|
| PD-1 | Two lanes, not four | After A3 and B2 both lanes converge on the same files; a third or fourth lane would be false parallelism. |
| PD-3 | Full suite runs exactly twice | P6.5 owner amendment. The P6.5 exit gate caught exactly one escape, which validates the trade. |
| PD-6 | No `recordContextPack` call site is edited | five call sites in four files, one on no roster; B1 throws a typed error instead. |
| PD-7 | AC-9 split into 9a and 9b across two brokers | revision 1 contradicted D2 and asserted on a broker where the lifecycle tools are not registered. |
| PD-8 | A0 captures the compatibility fixture first | after the work lands, "before" cannot be recorded. |
| PD-12 | B-1 uses the existing `paused` outcome, never a re-raise | round 3: a re-raise skips `recordOutcome`, so the next tick redispatches the task into the same error. |
| PD-14 | The suspension registry belongs to B1 and is re-derived before the first dispatch | round 4: it was described in B2 but contracted to no packet, and a restart could redispatch before a waiver took effect. |
| PD-15 | `abort` uses `RunSupervisor.fail` | round 4: `abort` was unspecified against a `running` task. **Refined by PD-20.** |
| PD-16 | Architect document writes are a kernel-applied `architect_document` task | round 4: every commit API needs a task workspace, `createChangeSet` needs a task id, commit and evidence, and nothing on the Architect path built them. A real task supplies all three at zero model cost and stays out of `acceptedChangeSessions`, matching ESC-2. **SUPERSEDED by PD-23.** |
| PD-17 | The Architect gets no filesystem mutation tool | writing into `projectRoot` bypasses isolation and the P6 handoff. |
| PD-18 | The plan critic stays execution-free | P6.6 forbids execution during planning; the change-review stage needing it moved to P6.6. |
| PD-19 | D4, D5, D7 moved to P6.6 | owner decision. P6.6 already owns coverage review (T3) and deliverable review (T6), and forbids a second competing authority. |
| PD-20 | `abort` sets the scheduler run `failed` first, then reaches `RunSupervisor.fail` through an `onBuildFailed` hook that `cli.ts` installs | round 5: the live supervisor exists only in `cli.ts`. Scheduler-first makes the crash window safe. |
| PD-21 | `architect_document` integrates through its own `documentApplier` port, never the worker `integrationDriver` | round 5: that driver requires a worker session, and a worker session would put the document on `acceptedChangeSessions`. **SUPERSEDED by PD-23.** |
| PD-22 | Reviewer independence: distinct model preferred, fresh context fallback, recorded | owner decision D8, "same rule everywhere". P6.6 applies the same rule to its deliverable and coverage reviewers. |
| PD-23 | The Architect maintains `docs/project/**` plus marked `AGENTS.md`/`CLAUDE.md` sections; the runner commits them on the integration branch outside the task graph; a new run cannot complete without a fresh `STATE.md` | owner redesign 2026-09-22/23 (ESC-4): any AI tool can pick the project up; handoff's clean-worktree rule keeps writes off the user's folder until handoff; PD-17 still holds — no general filesystem mutation tool |

---

## 9. Evidence index

| File | Contents |
|---|---|
| `evidence/TEMPLATE.md` | evidence record shape |
| `evidence/plan-review-r1.md` … `-r5.md` | the five planning reviews of revisions 1–6 |

No packet evidence exists yet.
