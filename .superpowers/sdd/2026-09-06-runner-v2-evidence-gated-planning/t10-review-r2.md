# P6.6 OA-18 / EP52 / T10 — independent scoped coverage review (r2)

**Reviewer:** fresh context, read-only. No file in the repository was edited.
**Workspace:** `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`
**Commits:** `0c53de895a6dad87beec756b10a6d89d1dff0c3f` (OA-18 / EP52 / T10) and HEAD `aac428ec68a2f8f692cb692bd2b7637d8eb14a9c` (T8 starts from accepted T10). Worktree was clean.
**Prior review:** `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/t10-review-r1.md` (PLAN COVERAGE INSUFFICIENT, B1 only).
**Scope:** `0c53de89` under `docs/` and `progress.md`, plus the B1 correction in `aac428ec`. Amendment reviews r3 and r4 were not re-audited.

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

**One owning row.** EP52 is the only ledger row for OA-18. No second row claims it. T8's amendment bullet names EP52 only as the token counts it must include in the per-gate report. Section 6 says a contributing task does not acquire duplicate ownership. That matches the route cell `BP5; T10 (T8 reports tokens)`.

| Piece | Where | Holds obligations |
|---|---|---|
| EP52 | Plan section 6 | Names the same sixteen findings. Re-check, fix the still-valid ones, drop the obsolete ones with a recorded reason, record before/after per-role prompt tokens. Route: `BP5; T10 (T8 reports tokens)`. Acceptance: finding-by-finding disposition table; prompt diffs; token counts before/after; checked-statement tests still green. |
| T10 | Plan section 5, "after T7, before T8" | Executable task. Scope keeps `agentsMarkedSectionSatisfies` in step with `project-docs.ts` templates. Checklist: one disposition per listed finding; measure with the P6.5.4 context manifests and hand the numbers to T8's per-gate report; M9 and M12 proved on a C#/C++ tree and a Python tree. Acceptance: disposition covers every listed finding; each applied fix has a test or snapshot; token counts recorded; no checked statement drifts from its check. |
| T8 | Plan section 5 consume line and token bullet (`aac428ec`) | Starts only from accepted T10. The per-gate token bullet is `EP38–EP52` and requires T10's before/after per-role prompt token counts. Reporter for obligation 2, not a second owner. |

Obligations 1–3 each have that one row and that one task. The acceptance route is executable (disposition table, diffs, token counts, existing checked-statement tests).

## B1 from t10-review-r1

**Fixed.** The r1 fix was: T8's required base is the accepted T10 snapshot in the section 5 consume line, the T8 card, and the Lane A card (`T7, then T10, then T8`), and T8's per-gate token bullet includes EP52's before/after prompt counts.

HEAD text:

- Consume line (plan line 278): `Integrated T1–T7, T9 and T10 snapshots/reviews (T8 starts only from accepted T10)`.
- Token bullet (plan line 282): `Amendment (EP38–EP52)` and `report tokens per gate (including T10's before/after per-role prompt token counts, EP52)`.
- T8 card (plan line 440): `integrated accepted T10 (after T7) and all predecessor evidence`.
- Lane A card (plan line 454): `T7, then T10, then T8 follow their contracts (T8 starts only from accepted T10)`.

Adding T9 to the consume list names a predecessor that already sits before T4. It does not open a second start rule. T8's file scope is still final fixture, evidence, and package exposure. The bullet does not move the prompt fixes onto T8.

## Placement

Required order: T10 after T7 and before T8.

| Site | Text | After T7, before T8 |
|---|---|---|
| Phase table BP5 | Tasks `T6, T7, T10`. Entry: T7 follows T6; T10 follows T7. | Yes |
| Phase table BP6 | Task T8. Entry: BP5 (the phase that contains T10). | Yes |
| Lane sentence | Lane A: T6, T7, T10, T8. | Yes |
| T10 contract | Title "after T7, before T8"; "Runs before T8 so the final suite covers it." | Yes |
| T8 contract | Starts only from accepted T10. Token bullet includes EP52 counts. | Yes |
| T10 card | Required base: accepted T7 snapshot. | Yes |
| T8 card | Required base: integrated accepted T10 (after T7) and all predecessor evidence. | Yes |
| Lane A card | T7, then T10, then T8; T8 starts only from accepted T10. | Yes |
| Progress registry | Lane A: T6, T7, T10, T8. | Yes |
| Progress queue | `T6 → T7 → T10 → T8`. | Yes |

The superseded 2026-09-08 registry and queue in `progress.md` still end at T8 with no T10. That block is labelled superseded by the current registry and queue. It is not a second current order. The revision-2 history row that says the campaign gate was EP01–EP51 and T1–T9 describes what revision 2 fixed. It is not the live gate. The live ownership sentence is EP01–EP52. The live campaign gate is T1–T10 and EP01–EP52. The header states OA-18 adds EP52 and T10 after T7 and before T8.

`progress.md` still says PLAN BLOCKED until this delta is independently reviewed. That is the state index waiting on this report. It is not a second placement.

## Conflict checks

**EP21 / EP22.** No conflict. EP21 stays one combined independent deliverable review owned by T6; a worker still cannot self-accept. EP22 stays fix-delta re-review of concrete changes, with reuse of valid reviews. T10 asks for one combined independent review of its own prompt diff. It does not add a second critic over unchanged input, and it does not let a worker accept its own work. M10's allowed lifecycle-input change is serialized after T6, which owns `worker-lifecycle-tools.ts`.

**OA-6 token economy.** No conflict. EP40 still records each extra model pass's purpose and token cost through the P6.5.4 context manifests and the existing usage projection, and T8 still reports tokens per gate. T10 measures per-role prompt size with those same manifests and hands the before/after numbers to that report. T8's bullet now requires those counts. It does not add a model pass or a new counter. T7 still only surfaces that existing projection; T10 does not take T7's files.

**T7 scope.** No conflict. T7 remains UI, authenticated APIs, export, and launch cards. It does not edit prompt text. T10 does not edit T7's files. T10 after T7 is the right order: T7 is done, and the prompts T10 re-reads already include T3, T6, and T9.

**T8 scope.** No conflict. T8 remains the final suite and source reconciliation. It starts only after accepted T10, so the suite covers the prompt fixes, and its per-gate report is required to include T10's counts. It does not take T10's prompt files.

**Checked statements.** Carried. T10's scope names `project-docs.ts` templates and `agentsMarkedSectionSatisfies`. T10's acceptance says no checked statement drifts from its check. EP52's acceptance says the checked-statement tests stay green. That is OA-18 item 3. `aac428ec` did not change those sentences.

## Findings

### BLOCKING

None. r1 B1 is fixed, and no current sentence still starts T8 from accepted T7 alone.

### IMPORTANT

None.

### MINOR

None.

## Categories with no finding

- Obligations 1–3 have exactly one ledger row (EP52), a real acceptance route, and one executable task (T10). T8 reports tokens and does not own the row.
- The sixteen findings are the same set in OA-18, EP52, and T10's checklist. None is missing and none was added.
- Header, ownership sentence (EP01–EP52), and campaign gate (T1–T10 and EP01–EP52) match the new row.
- EP21, EP22, OA-6, and T7's and T8's file scopes do not conflict with T10.
- The checked-statement rule for `project-docs.ts` is in T10's scope and acceptance and in EP52's acceptance.
- Phase table, lane sentence, T8 contract, T8 card, T10 card, Lane A card, progress registry, and progress queue all place T10 after T7 and before T8.

## Verdict

**PLAN COVERAGE VERIFIED**
