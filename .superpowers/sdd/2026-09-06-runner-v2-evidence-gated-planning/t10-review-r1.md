# P6.6 OA-18 / EP52 / T10 — independent scoped coverage review

**Reviewer:** fresh context, read-only. No file in the repository was edited.
**Workspace:** `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`
**Commit:** `0c53de895a6dad87beec756b10a6d89d1dff0c3f` (`docs(runner-v2): P6.6 OA-18 / EP52 / T10 deferred prompt-hygiene pass`)
**Scope:** that commit's changes under `docs/` and `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/progress.md`. Uncommitted worktree edits were ignored. Amendment reviews r3 and r4 were not re-audited.

## Obligations (from OA-18, before the plan)

Source: `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`, section OA-18. Owner, 2026-09-23: fix what must be fixed now; add later work only to the end of P6.6, and only if needed. The urgent findings (H1–H5, M2, M4–M6) are out of this obligation; they were fixed in the agent-capability program.

After P6.6's own prompt changes, and before P6.6's final gate:

1. **Re-check, then fix or drop.** Re-read each deferred finding against the prompts as they then stand. Drop a finding that no longer applies, and record why. Fix every finding that still applies.
2. **Measure tokens.** Record per-role prompt token counts before and after. The place for those numbers is T8's per-gate token report (OA-6). Measurement, not an assumption.
3. **Checked statements stay paired.** Any change to a checked statement — the example given is the `AGENTS.md` section sentences in `project-docs.ts` — keeps the check and the template in step. The live check is `agentsMarkedSectionSatisfies` (`runner-v2/src/project-docs.ts`).

The deferred set, from `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/prompt-review-2026-09-23.md`, is exactly M1, M3, M7, M8, M9, M10, M11, M12, L1, L2, L3, L4, L5, L6, L7, L8. OA-18 does not make each proposed patch mandatory. It makes the disposition mandatory.

| ID | What a still-valid finding requires |
|---|---|
| M1 | Architect reason rules move off the every-turn system prompt onto per-reason text, and the reasons that have no rule gain one. |
| M3 | Docs instructions state the completion gate, verbatim markers, and body-only AGENTS/CLAUDE content; templates are not resent once the entry point exists. |
| M7 | Architect (and worker) evidence summaries show label, command, and args, and distinguish timeout from exit. |
| M8 | `run_evidence_command` says there is no shell, what `command` / `args` / `cwd` are, and that the returned evidence ID is what later citations use. |
| M9 | `fs.search` / `fs.list` skip build output on non-JS trees (proposal: git-ignored paths), and the description says so. |
| M10 | Worker lifecycle tools no longer require an `evidenceSequence` the worker cannot know, and the worker prompt names `request_replan`. |
| M11 | `requiredCapabilities` is chosen from the configured worker capability set, and that set is visible. |
| M12 | Repository, tool, web, and MCP content is labelled untrusted for every role; section framing is not spoofable by repo text. |
| L1 | Non-editing roles are not given the kernel editing rule. |
| L2 | `write_project_doc` says it commits on the integration branch and does not end the action. |
| L3 | Code-intelligence descriptions say the unconfigured provider is TypeScript-only and to use `fs.search` otherwise. |
| L4 | Final-verification planning allows `not_applicable` with rationale and inspected paths. |
| L5 | The Architect is told when to promote memory proposals. |
| L6 | Worker context shows a compact task with dependency objectives, not the raw internal task JSON. |
| L7 | Large required JSON sections are compact, not pretty-printed. |
| L8 | `submit_task` says the worker does not need to call `git.commit` first. |

## Ledger and task

**One owning row.** EP52 is the only ledger row for OA-18. No second row claims it.

| Piece | Where | Holds obligations |
|---|---|---|
| EP52 | Plan section 6 | Names the same sixteen findings. Re-check, fix the still-valid ones, drop the obsolete ones with a recorded reason, record before/after per-role prompt tokens. Route: `BP5; T10 (T8 reports tokens)`. Acceptance: finding-by-finding disposition table; prompt diffs; token counts before/after; checked-statement tests still green. |
| T10 | Plan section 5, "after T7, before T8" | Executable task. Scope keeps `agentsMarkedSectionSatisfies` in step with `project-docs.ts` templates. Checklist: one disposition per listed finding; measure with the P6.5.4 context manifests and hand the numbers to T8's per-gate report; M9 and M12 proved on a C#/C++ tree and a Python tree. Acceptance: disposition covers every listed finding; each applied fix has a test or snapshot; token counts recorded; no checked statement drifts from its check. |

Obligations 1–3 each have that one row and that one task. The acceptance route is executable (disposition table, diffs, token counts, existing checked-statement tests). T8 is a named reporter for obligation 2, the same shape as other "contributes" notes. It is not a second owner of OA-18.

## Placement

Required order: T10 after T7 and before T8.

| Site | Text | After T7, before T8 |
|---|---|---|
| Phase table BP5 | Tasks `T6, T7, T10`. Entry: T7 follows T6; T10 follows T7. | Yes |
| Phase table BP6 | Task T8. Entry: BP5 (the phase that contains T10). | Yes |
| Lane sentence | Lane A: T6, T7, T10, T8. | Yes |
| T10 card | Required base: accepted T7 snapshot. | Yes for T10's start |
| T8 card | Required base: integrated accepted T7 and all predecessor evidence. | No. Names T7, not T10. |
| Lane A card | T7/T8 follow their contracts. Does not name T10. | No |
| T8 contract | Consumes integrated T1–T7. Token bullet is EP38–EP51. | No |
| Progress registry | Lane A: T6, T7, T10, T8. | Yes |
| Progress queue | `T6 → T7 → T10 → T8`. | Yes |

The superseded 2026-09-08 registry and queue in `progress.md` still end at T8 with no T10. That block is labelled superseded by the current registry and queue. It is not a second current order. The revision-2 history row that says the campaign gate was EP01–EP51 and T1–T9 describes what revision 2 fixed. It is not the live gate. The live ownership sentence is EP01–EP52. The live campaign gate is T1–T10 and EP01–EP52.

## Conflict checks

**EP21 / EP22.** No conflict. EP21 stays one combined independent deliverable review owned by T6; a worker still cannot self-accept. EP22 stays fix-delta re-review of concrete changes, with reuse of valid reviews. T10 asks for one combined independent review of its own prompt diff. It does not add a second critic over unchanged input, and it does not let a worker accept its own work. M10's allowed lifecycle-input change is serialized after T6, which owns `worker-lifecycle-tools.ts`.

**OA-6 token economy.** No conflict. EP40 still records each extra model pass's purpose and token cost through the P6.5.4 context manifests and the existing usage projection. T10 measures per-role prompt size with those same manifests and hands the before/after numbers to the report OA-6 already assigned to T8. It does not add a model pass or a new counter. T7 still only surfaces that existing projection; T10 does not take T7's files.

**T7 scope.** No conflict. T7 remains UI, authenticated APIs, export, and launch cards. It does not edit prompt text. T10 does not edit T7's files. T10 after T7 is the right order: T7 is done, and the prompts T10 re-reads already include T3, T6, and T9.

**T8 scope.** The final-suite role does not conflict with a prompt pass that is supposed to land first. The base T8 is told to consume does. That is finding B1, not a second product-scope clash.

**Checked statements.** Carried. T10's scope names `project-docs.ts` templates and `agentsMarkedSectionSatisfies`. T10's acceptance says no checked statement drifts from its check. EP52's acceptance says the checked-statement tests stay green. That is OA-18 item 3.

## Findings

### BLOCKING

**B1. T8 can start from accepted T7, or only after T10, and a current sentence supports either.**

Location:

- Agrees on T7 → T10 → T8: phase table BP5/BP6 (plan lines 118–119); lane sentence (line 125); T10 contract "Runs before T8 so the final suite covers it" (line 303); `progress.md` registry (lane A) and queue (`T6 → T7 → T10 → T8`).
- Starts T8 at T7: T8 consumes "Integrated T1–T7 snapshots/reviews" (line 278); T8 card required base "integrated accepted T7 and all predecessor evidence" (line 440); Lane A card "T7/T8 follow their contracts" (line 454), and those contracts do not insert T10.

Why: The placement check for this delta is one order, including the cards. The phase table and the progress queue give that order. The T8 card and the Lane A card do not. Section 9 tells a card to follow the task contract, and T8's contract still consumes T1–T7. A controller can open T8 on the accepted T7 snapshot, run the final suite, and only then run T10 — or wait for T10 — and be obeying a current sentence either way. T10 exists so the final suite covers the prompt fixes, and so T8's per-gate report receives the before/after counts (OA-18 item 2; T10's handoff; EP52 "T8 reports tokens"). T8's own token bullet still stops at EP38–EP51, so that handoff is not in the contract the card says to follow.

Fix: Make T8's required base the accepted T10 snapshot in the section 5 consume line, the T8 card, and the Lane A card (`T7, then T10, then T8`). Add EP52's before/after prompt counts to T8's per-gate token bullet so the report OA-18 names is required to include them.

### IMPORTANT

None.

### MINOR

None.

## Categories with no finding

- Obligations 1–3 have exactly one ledger row (EP52), a real acceptance route, and one executable task (T10).
- The sixteen findings are the same set in OA-18, EP52, and T10's checklist. None is missing and none was added.
- Header, ownership sentence (EP01–EP52), and campaign gate (T1–T10 and EP01–EP52) match the new row.
- EP21, EP22, OA-6, and T7's file scope do not conflict with T10.
- The checked-statement rule for `project-docs.ts` is in T10's scope and acceptance and in EP52's acceptance.
- Phase table, lane sentence, progress registry, and progress queue agree with each other. The disagreement is the T8 contract and the two cards in B1.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking condition:

1. **B1.** T10 is after T7 and before T8 in the phase table, the lane sentence, and the progress registry and queue. The T8 contract, the T8 card, and the Lane A card still start T8 from accepted T7 and do not require T10's token counts in T8's report.
