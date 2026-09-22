# P6.6 owner amendment — independent scoped re-review, revision 3

Reviewer: fresh context. Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`.
HEAD `702e06cd01a42b2c435150541de604c81f40f21f`, tree clean.
Amendment source read first: `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md` (OA-5, OA-7, OA-11, OA-12, OA-17).
This obligations list was written before the plan or progress file was opened.
Prior review reused as clean: `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/amendment-review-r2.md`.
This pass checks only B-R2 and N1–N5, and whether those edits contradict the text next to them.

## Pre-read obligations

### B-R2 (I3) — one start rule

The schedule for T5, T9 and T4 must be one rule, repeated without a second reading, in the section 4 phase table (BP3 and BP4 entry), the "One start rule" paragraph, T3's validation sentence, the section 9 cards for T4, T5, T9, Lane A and Lane B, and `progress.md` "Current revision" registry and queue.

r2 left two rules in force: BP2 exit required both the reviewed plan and the answer path and BP4's entry was BP2, so T5 waited for T9; the lane paragraph, T5 card and registry started T5 at accepted T3. Either rule is acceptable. They may not both be current. BP2 being done (both paths) may stay the definition of BP2 completion while T5 still starts at accepted T3, because T5 and T9 share no file. If the chosen rule is instead "T5 waits for T9", every "T5 does not wait" sentence has to go.

### N1 — planning state includes `clarify` (OA-7, OA-5)

OA-7: on a new-policy run in planning state, T3 must not admit Architect command execution. Planning forbids implementation tests and application execution. The OA-5 answer path is not planning state.

OA-5: triage is `answer`, `build` or `clarify`. `clarify` pauses through `ask_user` and returns to triage. That pause is before a plan exists. Command execution during it is the pre-plan work OA-7 keeps read-only.

Obligation for this fix: T3's planning-state predicate covers a durable triage value of `clarify` (no ready plan yet), and refuses Architect commands there. EP41's evidence includes that negative, beside the before-triage and `build` negatives. `answer` stays outside the predicate.

### N2 — same independence rule on the opt-in answer reviewer (OA-5 item 8, OA-3 as applied)

OA-5: no critic, coverage review or verifier on the answer path by default. An independent answer review runs only when the user opts in.

The owner required the same independence rule on that opt-in review as on the other reviewers: `RuntimeRouter.selectVerifier` (no second selector); distinct model preferred; otherwise a new session whose event list is empty; record `distinct_model` or `fresh_context`; prove the empty session with the sentinel.

Obligation for this fix: EP37 names T3 and T9, not only T6. T9's opt-in answer reviewer calls `selectVerifier`, and on `fresh_context` uses a new empty session. The sentinel proof covers that reviewer.

### N3 — a failed higher rung is not an empty affected-test set (OA-12)

OA-12: the affected-test ladder records the rung it used. It never narrows below what it can justify. The floor is the module graph when a build system exists, otherwise the full suite.

`language-provider-router.ts` is the rung-2 client. When no provider matches, `references` must be treated as a failed rung, not as "no tests reference this symbol."

Obligation for this fix: a rung that is not configured, fails, or returns `unsupported_language` steps down, and the lower rung is what is recorded. The outcome is never an empty selection. That rule is in the T5 OA-12 step and in EP46. The code status to check is `unsupported_language` with an empty `results` list.

### N4 — leftovers are two searches (OA-17)

OA-17: after each task attempt and each verification, find processes the runner started that are still alive, and temporary files it created outside the workspace. Clean up where ownership is proven, and record the leftover either way. Uncertain ownership is retained and reported, never killed or deleted on a guess. Process identity uses the runner's existing process ownership.

Obligation for this fix: T6 and EP51 split the searches. Processes come from the existing ownership records. Temp paths come from a creation record written when the runner creates a path outside the workspace, including the OA-11 disposable copy. Cleanup of temp paths is limited to that record. A path found another way, with unproven ownership, is retained and reported.

### N5 — proof details and eligibility sentences (OA-11, OA-8)

OA-11: the break-it probe records `not_available` for any other language, or when no affected-test command exists. The built-in rung has a Python family as well as the C family.

OA-8: campaign order is P6.5, then the agent-capability program, then P6.6.

Obligation for this fix: EP45's evidence includes the no-affected-test-command trigger. T8 names a Python fixture for the Python-family mutator. The section 7 eligibility sentence and the section 10 implementation-prerequisites sentence both name the agent-capability program.

## Fix table

Plan read after the list above: `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md`. Progress current revision: `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/progress.md` lines 1–41.

| ID | Status | Where it stands |
|---|---|---|
| B-R2 | FIXED | One rule: T5 and T9 start at accepted T3; T4 starts at accepted T9; T5 does not wait for T9; BP2 is done only when T3 and T9 are both accepted, and that completion gates BP3 (T4), not BP4 (T5). Phase table BP3 entry is "T3 and T9 accepted (all of BP2)"; BP4 entry is "T3 accepted" and says T5 does not wait for BP2's answer path (lines 116–117). The "One start rule" paragraph (line 121) states the same four clauses. T3 validation (line 187) says T3's acceptance unlocks T9 and T5, and BP2 is complete only when both are accepted. Section 9: T4 card is accepted T9 (line 421); T5 card starts at T3 acceptance, beside T9 (line 422); T9 card is accepted T3 (line 426); Lane A runs T3, T9, T4 in that order (line 438); Lane B starts T5 at accepted T3 and does not wait for T9 (line 439). Progress registry: lane A "T4 on accepted T9"; lane B "Starts at T3 acceptance, beside T9; does not wait for T9" (lines 34–35). Queue: `T3 → { lane A: T9 → T4 } ‖ { lane B: T5 }` with "T5 starts at T3 acceptance" (lines 40–41). |
| N1 | FIXED | T3 OA-7 step (line 182): planning state while there is no ready plan and triage is anything other than `answer` — no decision yet, `build`, or `clarify`. Amendment acceptance (line 185) refuses a planning-state command before triage, under `build` without a ready plan, and under `clarify`. EP41 (line 355) repeats that predicate and its evidence cell names the `clarify` negative on T3. The answer path stays outside. |
| N2 | FIXED | EP37 (line 351) is T6 with T3 and T9 contributing. Its evidence requires the sentinel to be absent from the first request of the deliverable reviewer (T6), the coverage reviewer (T3) and the opt-in answer reviewer (T9). T9's step (line 303) selects that reviewer with `RuntimeRouter.selectVerifier`, no second selector, and on `fresh_context` runs a new session whose event list is empty and records the independence value. |
| N3 | FIXED | T5 OA-12 step (line 221): a rung that is not configured, fails, or answers `unsupported_language` is a failed rung, not an empty selection; step down and record the lower rung. EP46 (line 360): an `unsupported_language` empty result and a failed impact tool each record a lower rung, never an empty selection. Code check: `references` calls `positionQuery`; when `select` returns nothing, line 315 returns `unsupported()`, which is `{ status: "unsupported_language", results: [], truncated: false }` (`language-provider-router.ts` lines 191–196, 308–315, 633–635). An empty `results` array is that status, so the plan's "failed rung" rule matches the router. |
| N4 | FIXED | T6 OA-17 step (line 249): two searches. Processes use `managed-process-*` and `durable-process-store.ts`. Temporary paths use a creation record written when the runner creates a directory or file outside the workspace, including the OA-11 disposable copy and other `mkdtemp` sites. Cleanup is only what a record proves; unproven ownership is retained and reported. EP51 (line 365): leftover-process fixture; leftover recorded-temp-path fixture including an OA-11 disposable copy; an unrecorded path with unproven ownership is retained and reported, not deleted; an uncertain process is retained, not killed. |
| N5 | FIXED | EP45 evidence (line 359): `no affected-test command → not_available`, beside unknown language. T8 language bullet (line 283): a Python project for the Python-family mutator. Section 7 (line 383): no execution task is eligible before verified P6/P6.5, the accepted agent-capability program (OA-8), and an instruction to resume. Section 10 (line 453): implementation still requires verified P6/P6.5 prerequisites and the accepted agent-capability program (OA-8). |

## Findings

### BLOCKING

None. B-R2 is fixed. The sentences r2 quoted no longer disagree. Repair cycle 3 is not needed for I3.

### IMPORTANT

None. N1–N4 match the obligations above.

### MINOR

None. N5's four proof and eligibility sentences are present.

### Adjacent text

The edits do not put a second start rule back, and they do not pull the answer path into planning state. EP32 still limits the zero-execution assertion to T3's predicate and keeps an answered run outside it, with zero implementation dispatch, migration and project mutation. T9 still admits Architect commands only once triage is `answer`, in a disposable copy. T5's file rule is unchanged (no scheduler, factory or integration edits), so starting T5 beside T9 does not share T9's files. Integration order stays T4 then T5; that is merge order, not a start dependency. The superseded 2026-09-08 block in `progress.md` still describes the old queue and the old D3 pin; it is labelled superseded and is not the current registry.

## Verdict

**PLAN COVERAGE VERIFIED**

B-R2 and N1–N5 are fixed at the sites this pass was told to check. No blocking condition remains from this correction set.
