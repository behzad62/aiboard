# P6.6 cross-program update — independent scoped re-review (r4)

**Reviewer:** fresh context, read-only.
**Workspace:** `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`
**HEAD:** `57281324105bc18470e4f525e2a26e0e085f7697` (tree clean at review start).
**Scope:** `git diff 63737709 57281324` for
`docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md` and
`docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`.
**Capability source:** `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` section D6, revision 4 (2026-09-23), plus AC-17 and AC-25.

## Verdict

**PLAN COVERAGE VERIFIED**

No blocking condition. One minor formatting defect is recorded below and does not change an obligation.

## Check 1 — `architect_document` mentions

Grep of both scoped files for `architect_document`: **no matches.**

The diff replaces every prior use:

- Plan preamble (OA-8 sentence): the kind is replaced by the documentation folder, integration-branch commit outside the task graph, and the `docs/project/STATE.md` completion check, citing D6 revision 4.
- Section 3 `ExecutionTaskContract`: the runner-applied variant is replaced by "no runner-applied task kind exists" and "every task carries the full contract."
- T1 inspect step and the recognise-kind step: replaced by inspection of the folder and its completion check, and by keeping that check intact.
- T1 acceptance: the exemption and the "worker task labelled with that kind" rejection are removed. Missing steps/scope/validation/review/cleanup applicability is rejected for every task.
- T4: the admission exclusion and the acceptance sentence that the kind is never dispatched are removed.
- Amendment OA-8: rewritten. It states the program adds **no** task kind.

`documentApplier` does not appear in either file. No stale exemption remains.

## Check 2 — Section 3, T1, and T4 still hold together

They hold. Removing the exemption did not drop a still-live rule.

| Piece | After the edit | Fits D6 revision 4 |
|---|---|---|
| Section 3 | No runner-applied kind. Architect documents are committed outside the task graph. Every task carries the full contract. Investigation tasks still have their own bounded-question rule. | D6 rejects `architect_document`. Writes are not tasks (D6.4: no task, change set, or worker session). |
| T1 | Strict complete-task-field validation. Acceptance rejects a task missing steps/scope/validation/review/cleanup applicability, with no exception. | There is no exempt kind left to carve out. |
| T4 | Eligibility, claims, the four-worker cap, and restart reconciliation apply with no kind exclusion. | Documents are outside the graph, so they are not admitted, claimed, capped, or ordered as tasks. |

What the deleted T4 step also said, and why dropping it is not an accidental loss:

- Exclusion from worker admission, worktree claims, and the worker cap — nothing remains to exclude.
- "`documentApplier` applies it" — that applier belonged to the rejected kind. D6.4's integration-branch commit is stated in section 3, the plan preamble, and OA-8.
- "It still participates in dependency order" — D6 puts documents outside the task graph, so they must not participate. Section 3 says that.

The full-contract field list in section 3 is unchanged aside from the closing sentence. T1's other steps (fixtures, normalization, versioned opt-in) are unchanged.

## Check 3 — T7 documentation-folder boundary vs export rules

T7's new step is consistent with section 2 item 6 and section 7. It does not conflict with D6.

Section 2 item 6: generated Markdown/JSON exports are read-only projections and never replay inputs merely because a worker edited them.

Section 7: PLAN.md, STATE.json, and per-task cards are generated views when requested; each explains it is not the event store; plan authority is the scheduler, not an editable PLAN.md.

The new step's first sentence restates that: exports are views served on request. The existing T7 bullet still says workers cannot make edits to exported files authoritative. Nothing in the new step makes a written copy a replay input or a second authority.

The conditional placement rule matches D6 rather than fighting it:

- Never overwrite Architect-written files under `docs/project/`. That is the same non-overwrite rule as OA-8, and it respects D6.5 (one owner).
- If a copy is written into the project, it goes under `docs/project/generated/`, not onto `README.md`, `STATE.md`, `specs/`, `plans/`, `decisions.md`, or `evidence/` (D6.3's layout). Names also do not collide: exports are PLAN.md / STATE.json; the Architect file is STATE.md.
- The integration-branch commit path is D6.4's path (outside the task graph). "Same path" here is that mechanism. The step does not give generated files Architect attribution, a task, or a model call.
- D6.6 still keeps the database as the truth for gates. D6's rejection of "runner-generated exports as the only documentation" still stands: the completion check remains, and exports are an extra labeled view.

`docs/project/README.md` saying the subtree is generated is a disclosure on the Architect-owned entry point, not a second authority and not a replay input. It sits beside the never-overwrite sentence; it does not instruct the export writer to replace Architect prose.

## Check 4 — STATE.md completion check: ownership and EP rows

Ownership is clear. The capability program owns the check. P6.6 must not break it.

- D6.7 and AC-25: a new run cannot complete until `docs/project/STATE.md` was written after the run's latest integrated change; legacy runs are exempt.
- T1 names it "the agent-capability program's" check and says to keep it intact when P6.6 readiness conditions are added. Both must hold for a new-policy run. That is a non-regression on the completion check, not a move of AC-25 into plan-ready (the check cannot be satisfied before integration).
- OA-8: "P6.6's readiness conditions must keep that check."

No EP row needs to reference it. An EP row would give P6.6 a second owner for AC-25. The plan's ledger rule is one accountable phase per requirement, and D6 stayed in the capability program because P6.6 does not cover it. The non-regression lives in T1 and OA-8, which is the right layer. No existing EP row contradicts the check. EP23, EP29, and EP31 govern P6.6's own acceptance and false-completion cases; they do not claim a run can complete without the capability program's check.

## Check 5 — OA-8 vs D6 revision 4

OA-8 matches D6 revision 4 on every claim it makes:

- Documentation folder `docs/project/**`, committed by the runner outside the task graph. D6.1 and D6.4 (integration branch, no task).
- Completion check on `docs/project/STATE.md`. D6.7 / AC-25.
- Adds no task kind. D6's explicit rejection of `architect_document`.
- P6.6 readiness must keep that check, and generated exports must not overwrite the Architect's files. Matches T1 and T7.
- Campaign order unchanged: P6.5 → agent-capability program → P6.6 → P7. The P6.5 and reader-execution dependencies in the rest of the paragraph are untouched.

The plan preamble also names the marked `AGENTS.md` / `CLAUDE.md` sections (D6.2). OA-8 does not. That is a shorter summary, not a contradictory one: OA-8 does not say the folder is the only Architect write surface.

## Check 6 — EP ledger vs the documentation folder

No EP row is inconsistent with the folder.

Grep of the ledger and the surrounding plan shows no `architect_document`, no runner-applied exemption, and no row that says project documents exist only as exports. Relevant rows still describe exports as projections:

- EP09 — one authority per fact; canonical index/projection/export parity.
- EP14 — launch cards are a non-dispatching export.
- EP30 — section-10 outputs available; "no duplicate authoritative facts."
- EP31 / EP32 — verdicts and plan-only behavior.

Those rows stay true because D6.6 keeps gate truth in the database and T7 keeps exports as views. The impact-audit line that forbids worker-written PLAN/STATE files as competing authority is about worker exports, not the Architect's `docs/project/STATE.md`.

EP33–EP51 are unchanged by this diff and do not assume the removed task kind.

## Findings

### MINOR — T7 OA-5/OA-6 bullet lost its closing bold marker

`docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md`, T7 checklist. The replacement of the following line dropped the `**` that closed the label:

- Before: `**Amendment OA-5/OA-6 (EP39, EP40).** Show an answered run's...`
- After: `**Amendment OA-5/OA-6 (EP39, EP40). Show an answered run's...`

The obligation text is complete (answer display, opt-in review, purpose and token cost, independence, ladder rungs). The unclosed `**` runs until `**Acceptance/negative proof:**` and will mis-render that heading. It does not drop or weaken EP39 or EP40.

## Blocking conditions

None.
