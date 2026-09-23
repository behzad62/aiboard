# P6.6 owner-amendment coverage review — 2026-09-22

Reviewer: fresh-context, read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `docs/agent-capability-and-change-critique`.

Source read before the plan: `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md` only.

The plan, progress ledger, pre-split design, and code citations were not opened when this section was written.

## STEP 2 — obligations derived from the amendment source

Governing constraints (Authority; themselves obligations, not numbered OA rows):

- G-ROBUST. Every item is governed by robustness: a defect is caught by structure, not by hoping a model notices.
- G-TOKEN. Every item is governed by token economy: no model pass without a stated purpose, and no pass over unchanged input.
- G-ADD. The amendment adds obligations. It removes and weakens none of existing P6.6.
- G-NO-SECOND. P6.6 forbids a second competing critic or coverage authority. Distinctive ideas from agent-capability D4, D5, D7 land inside T3 and T6 rather than as a parallel critic.

### OA-1 — Coverage review derives obligations before it may read the plan

- OA1-1. The coverage reviewer runs in a fresh session whose event list is empty at derivation.
- OA1-2. It reads the approved source and amendments and, for an ordinary Build request, the objective and durable user guidance, and nothing produced by the Architect.
- OA1-3. It durably records the obligations it derives before the plan is provided.
- OA1-4. Only then does it receive the plan.
- OA1-5. It returns one verdict per derived obligation: `covered`, `weakened`, or `missing`.
- OA1-6. The kernel refuses a coverage verdict when no obligations were recorded first.
- OA1-7. This reuses the RG-6 device already proved in P6.5: `record_verification_expectations` and the reducer gate that refuses a two-pass verdict without recorded expectations.
- OA1-8. Proof is assertions on the deriving turn's actual messages, tool results, and loaded session — covering context pack, prompt, tool result, session replay, and an earlier-turn checkpoint — that the source is present and no plan or criteria text is.
- OA1-9. A section-id check is a helper, not the proof. Planning review showed a section-id check can pass while the turn has already seen the plan.

### OA-2 — Finding vocabulary for what the criteria missed

Additive to the existing eight plan-critique categories:

- OA2-1. `missing_coverage`: the source requires it and nothing delivers it.
- OA2-2. `weakened_obligation`: something covers it, for less than was asked.
- OA2-3. `scope_creep`: work that serves no part of the source.
- OA2-4. `unverified_claim`: a cited evidence record does not support the claim citing it.
- OA2-5. A criterion that existed but was never exercised must be expressible as `weakened`, not collapsed into `covered`.
- OA2-6. `scope_creep` and `unverified_claim` are reportable even though they are not per-obligation verdict values.
- OA2-7. `unverified_claim` is decided mechanically wherever it can be: the cited evidence record exists, and its command, exit status, revision, and artifacts match what the claim asserts. Only the residue is reviewer judgement, and that residue is recorded as judgement.

### OA-3 — Deliverable review forms its view before reading the worker's claims

- OA3-1. The one combined independent deliverable review (existing T6) forms its findings from the source criteria and the exact diff before it is shown the worker's report or self-assessment.
- OA3-2. It then marks each worker claim `verified` or `unverified`.
- OA3-3. Selection excludes both the Architect's model identity and every model that authored the change.
- OA3-4. Reuse `RuntimeRouter.selectVerifier`, which already accepts `acceptedChangeAuthorRuntimeIds` (cited `runtime-router.ts:189`).

### OA-4 — Review depth follows deterministic change risk

- OA4-1. The stored risk reason that EP21 already permits for additional specialist review is computed, not asserted.
- OA4-2. Change risk is deterministic: no clock, randomness, environment lookup, or model call.
- OA4-3. Signals, all of them: author model tier (fast, cheap workers earn more scrutiny); shared kernel surface touched (an explicit named set, not prose); source changed with no test changed; task needed more than one attempt; an `acceptedFailures` waiver was used; size (files and lines).
- OA4-4. Depth by tier, and every task still gets its one mandatory independent review (EP21): low = standard review, reading only; medium = standard review with repository inspection; high = specialist depth where the reviewer runs the affected tests itself, recorded as evidence.
- OA4-5. The high-tier command is the affected-test command derived mechanically from a named rule. An arbitrary command (`echo ok`) must not satisfy it.
- OA4-6. Thresholds are measured, not chosen. Replayed over the fourteen P6.5 packet commits, whose review-found defects are recorded in the P6.5 ledger. Accepted only if: no defect-carrying commit lands in `low`; at least one trivially safe commit lands in `low`; and at least one commit whose defect was only provable by execution lands in `high`.
- OA4-7. Requires the agent-capability program's reader execution (its D2), because the high tier has the reviewer execute.

### OA-5 — Questions are supported in Build mode

Problem, cited as verified at `6c166f97`: questions route to `panel` / `debate` / `specialist` (`lib/db/schema.ts:481`), which never plan; a question typed into Build is forced into building (Architect first reason always `plan_required`; no Architect tool answers and stops; `buildCompletionReadiness` at `scheduler-store.ts:848-873` requires terminal tasks, an integration revision, and a current final verification, except under `plan_only`, which still requires a plan).

- OA5-1. Triage is the Architect's first action, not an extra model call. It chooses `answer`, `build`, or `clarify`, and the choice is durable.
- OA5-2. `answer` completes a run with no plan, no workers, no integration, and no final verification. The answer is durable and shown in the UI.
- OA5-3. The kernel enforces that an answered run changed nothing: no task, no worker dispatch, no integration, no project mutation. Structural guarantee, not a prompt instruction.
- OA5-4. An answer that discovers a needed change converts explicitly to `build`, with a durable conversion event. It never quietly edits the project.
- OA5-5. A mixed request ("explain X, then fix Y") routes to `build`.
- OA5-6. `clarify` pauses through the existing `ask_user` flow and returns to triage.
- OA5-7. Answering may run commands in a disposable copy, per the agent-capability program's D2, and never mutates the project.
- OA5-8. Token economy on the answer path: no critic, coverage review, or verifier runs by default. The answer lists, in the same turn, the parts of the question it addresses. An independent answer review runs only when the user opts in for that run.
- OA5-9. Runs created before this policy keep today's behaviour.

### OA-6 — Every model pass is accounted for

- OA6-1. Every model pass beyond the one that does the work — coverage review, plan critique, deliverable review at each depth, verifier passes — records its purpose and token cost against the run.
- OA6-2. Accounting uses the P6.5.4 context manifests and the existing usage projection.
- OA6-3. A gate may be skipped only by a recorded rule, never silently.
- OA6-4. No reviewer re-reads input that has not changed since its last accepted review.
- OA6-5. The T8 synthetic qualification reports tokens per gate, so P7 can tune the thresholds against real cost.

### OA-7 — Planning stays read-only

- OA7-1. The agent-capability program grants the Architect command execution.
- OA7-2. Under a new-policy run in planning state, T3 must not admit that execution.
- OA7-3. P6.6 forbids implementation tests and application execution during planning.
- OA7-4. The OA-5 answer path is not planning state. (Must be a kernel-checkable distinction, not only a sentence.)

### OA-8 — Ordering (not a ledger row by design)

- OA8-1. P6.6 now depends on the agent-capability program as well as P6.5.
- OA8-2. Campaign order: P6.5 → agent-capability program → P6.6 → P7.
- OA8-3. OA-4's high tier and OA-5's command use depend on that program's reader execution.
- OA8-4. OA-3's model exclusion and OA-6's accounting depend on P6.5 APIs now merged at `6c166f97`.
- Recorded where a controller would find entry order, not as an EP ledger row.

### OA-9 — Runtime policy, for the owner to confirm (not a ledger row by design)

- OA9-1. P6.6 remains PLAN BLOCKED on its own decision D3 (exact Node 24.18.0 versus a range) until the owner confirms.
- OA9-2. Recorded evidence: owner said Node 22 support is stale and was dropped; `package.json` engines is `>=24.0.0 <25`.
- OA9-3. Proposed resolution, not assumed: Node 24.x, with 24.18.0 as the verified local version.
- A controller must be able to find that this is proposed and unconfirmed, and that D3 is not treated as decided.

Citations the amendment asserts, to be checked against the tree (not obligations themselves): `lib/db/schema.ts:481`, `scheduler-store.ts:848-873`, `runtime-router.ts:189`, and the RG-6 `record_verification_expectations` gate.

---

The comparison below was written after the obligation list above. Confirmed HEAD `c2c179fde43f41694fd05b258e23515c167834f2`, tree clean. Citations inspected with `C:\Program Files\nodejs\node.exe` v24.18.0. Pre-split text taken from `git show 03e85149:docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`.

## Coverage table

Decomposition: OA-1, OA-2, and OA-3 are each split across two ledger rows with disjoint outcomes. No outcome is owned by two rows. OA-8 and OA-9 are not ledger rows.

| Obligation | Ledger row / controller site | Result |
|---|---|---|
| OA1-1 fresh session, empty event list | EP33; T3 OA-1 step | covered |
| OA1-2 source, amendments, objective, durable guidance; nothing produced by the Architect | EP33; T3 step ("reads only…") | covered |
| OA1-3 durable record before the plan is provided | EP33; T3 step | covered |
| OA1-4 plan received only after that record | EP33; T3 step | covered |
| OA1-5 one verdict per obligation: covered / weakened / missing | EP34 | covered |
| OA1-6 kernel refuses a coverage verdict with no recorded obligations | EP33; T3 gate-deletion RED | covered |
| OA1-7 reuse RG-6 `record_verification_expectations` and its reducer gate; no second mechanism | T3 OA-1 step (EP33 owns the refusal) | covered |
| OA1-8 proof on the deriving turn's messages, tool results, loaded session, replay, and earlier-turn checkpoint; source present and no plan or criteria text | EP33 evidence; T3 amendment acceptance | covered |
| OA1-9 a section-id check is not the proof | EP33 evidence | covered |
| OA1 proof names context pack and prompt as channels inside that assertion | EP33 / T3 name messages, tool results, and loaded session, and do not name context pack or prompt | weakened (MINOR) |
| OA2-1..OA2-4 the four category identifiers | EP34 says "four additive categories" and names only `scope_creep` and `unverified_claim`. `missing_coverage` and `weakened_obligation` appear nowhere in the plan | weakened (IMPORTANT) |
| OA2-5 a never-exercised criterion is `weakened`, not `covered` | EP34; T3 amendment acceptance | covered |
| OA2-6 `scope_creep` and `unverified_claim` reportable outside per-obligation verdicts | EP34 | covered |
| OA2-7 mechanical `unverified_claim` (record exists; command, exit, revision, artifacts match); residue labelled judgement | EP35; T5 OA-2 step | covered |
| OA3-1 findings from source criteria and the exact diff before the worker report or self-assessment | EP36; T6 OA-3 step | covered |
| OA3-2 each worker claim marked verified or unverified | EP36 | covered |
| OA3-3 / OA3-4 exclude Architect model identity and every change author via `selectVerifier` + real `acceptedChangeAuthorRuntimeIds` | EP37; T6 step; emptying either exclusion reddens a distinct test | covered |
| OA4-1 risk reason computed, not asserted | EP38; T6: computed tier is the stored reason EP21 requires | covered |
| OA4-2 deterministic: no clock, randomness, environment lookup, or model call | EP38 determinism test; T5 "pure, deterministic" | covered |
| OA4-3 all six signals, named kernel-surface set, named affected-test rule | T5 "six signals", named set, named rule, exported constants. The six names are not restated in the plan | covered (MINOR: names live only in the amendment) |
| OA4-4 low / medium / high depth inside the one mandatory review | EP38; T6 OA-4 step | covered |
| OA4-5 high-tier command is the mechanically derived affected-test command; an arbitrary command does not satisfy it | EP38 | covered |
| OA4-6 thresholds measured on the fourteen P6.5 packet commits; three-part acceptance | EP38; T5 step. The plan does not say the defect labels come from the P6.5 ledger | covered (MINOR) |
| OA4-7 depends on agent-capability reader execution (D2) | T9 consumes it; T6 high tier executes. Not stated on T5/T6 as an entry dependency. See OA-8 | weakened via OA-8 (BLOCKING at the entry sites) |
| OA5-1 triage is the Architect's first action, not an extra model call; choice durable | EP39; T9 | covered |
| OA5-2 answer completes with no plan, workers, integration, or final verification; answer durable and shown in the UI | Completion: EP39 / T9. UI: T7 OA-5 step. EP39's task column lists T9 only | covered (MINOR: EP39 omits T7) |
| OA5-3 kernel enforces zero mutation (no task, dispatch, integration, or project mutation), including direct-event and replay | EP39; T9 acceptance and validation | covered |
| OA5-4 explicit conversion to build with a durable event | EP39; T9 | covered |
| OA5-5 mixed request routes to build | EP39; T9 | covered |
| OA5-6 clarify uses `ask_user` and returns to triage | EP39; T9 | covered |
| OA5-7 commands only in a disposable copy; project not mutated | T9 scope and tool-surface tests; consumes reader execution | covered |
| OA5-8 no critic, coverage review, or verifier by default; same-turn question-part list; opt-in review only | EP39; T9; T7 opt-in | covered |
| OA5-9 legacy runs unchanged | EP39; T9 | covered |
| OA6-1 purpose and token cost on every pass beyond the working pass | EP40 | covered |
| OA6-2 use P6.5.4 context manifests and the existing usage projection | EP40 and the T7 step do not name those stores | weakened (MINOR) |
| OA6-3 a gate is skipped only by a recorded rule | EP40 silent-skip negative | covered |
| OA6-4 no reviewer re-reads unchanged input | EP40 unchanged-input reuse; section 1 duplicate-critic rule | covered |
| OA6-5 T8 reports tokens per gate | EP40; T8 amendment step | covered |
| OA7-1..OA7-3 no Architect command execution in planning state on a new-policy run | EP41; T3 OA-7 step and "planning-state command attempt is refused" | covered |
| OA7-4 the answer path is not planning state, as a kernel-checkable distinction | EP41 states it and asks for an answer-path admission positive. The predicate is not defined. The positive test is assigned to T3, which precedes T9 and whose acceptance states only the negative | weakened (IMPORTANT) |
| OA-8 campaign order P6.5 → agent-capability program → P6.6 → P7 | Header paragraph; `progress.md` current revision. Section 4 BP1 entry, the Relationship section, and D1 still state the old order | weakened (BLOCKING) |
| OA-9 D3 proposed, not assumed: Node 24.x, 24.18.0 verified locally | Section 10 addendum; `progress.md` condition 2. `package.json` engines confirmed `>=24.0.0 <25` | covered |

## Moved-scope check

Compared with `03e85149` decisions D4, D5, D7 and requirements AC-11..AC-16, AC-19..AC-23.

Landed in the amendment, and the plan has a row:

- AC-12 selection excludes the Architect and every accepted change author, reusing `selectVerifier` / `acceptedChangeAuthorRuntimeIds` → OA-3 / EP37.
- AC-14 deterministic change risk and all six signals → OA-4 / EP38.
- AC-16 high tier runs the affected tests and records evidence → OA-4, strengthened with a named mechanical command rule and the three-part threshold replay.
- AC-19 derive from the original request, not from Architect output, for the plan-stage coverage review → OA-1 / EP33 (source, amendments, objective, durable guidance, nothing the Architect produced).
- AC-20 record obligations before the plan; kernel refuses a verdict with none → OA-1 / EP33.
- AC-21 per-obligation `covered` / `weakened` / `missing` → OA-1 / EP34. The "holds the build" half is only the pre-existing T3 omission block, not a new `weakened` hold.
- AC-22 four additive categories beside the existing eight, malformed values rejected → OA-2 / EP34, weakened in the plan because two identifiers are unnamed (finding I2).
- AC-23 `unverified_claim` → OA-2 / EP35, strengthened with mechanical command/exit/revision/artifact matching.

Did not survive the move:

1. **AC-11 / D4's separate change-critique stage.** The pre-split text required a second critic stage at integration, before the verifier, reusing `PlanCritiqueFinding`, the blocking gate, and `resolve_plan_critique`. The amendment does not restate that stage, that contract reuse, or the "do not spend the verifier on a change that is about to change" ordering. What survived is the anti-anchoring and author-exclusion behavior, retargeted onto T6's one deliverable review. That retarget is consistent with the amendment's rule against a second critic. It is still a dropped requirement relative to AC-11.
2. **AC-13 blindness to the critic's own stage-1 findings.** D4 withheld stage-1 findings until stage 2 had filed its own. OA-3 withholds the worker's report and self-assessment instead. The worker-report rule is in the plan (EP36). The stage-1-findings rule is not in the amendment.
3. **AC-15 durable skip at low risk.** D5 low meant a recorded skip and no model pass. OA-4 low is still the mandatory review, reading only, because EP21 requires one review per task. The skip did not survive. The three tiers and the "not a second review" constraint did.
4. **AC-20's diff stage.** D7 step 4 recorded obligations before the plan or the diff. OA-1 withholds the plan. OA-3 gives the deliverable reviewer the source criteria and the diff on the first turn. Derive-before-diff did not survive.
5. **AC-21 hold.** A `missing` or `weakened` verdict at blocking severity held the build, and D7 rejected an advisory coverage check. The amendment does not say `weakened` blocks. Existing T3 text still blocks a deliberately omitted obligation. A never-exercised criterion becoming `weakened` is tested; it is not stated to block readiness.

OQ-4 (risk-gated versus mandatory coverage) was left open in the pre-split design. The amendment does not leave it open: coverage stays mandatory on the build path, and the answer path skips it by the recorded OA-5 rule. That is a resolution, not a silent drop.

## Conflicts with existing P6.6 obligations

**EP21 / EP22 and OA-4.** Clean. T6 keeps one combined review per task. Low, medium, and high are depth inside that review. The computed tier is the stored risk reason EP21 already required for specialist depth. High adds execution of the derived affected-test command to the same review. The plan does not add a second reviewer, a second session, or a rerun EP22 would forbid.

**EP32 and T9.** Not clean. See finding I1. EP32 still says planning performs inspection and documents only, with plan-only tests that assert zero implementation driver, test, and migration calls. T9 answers a `plan_only` pure question and may run commands on that path. EP41 says the answer path is not planning state, and that sentence is the only reconciliation. The predicate a kernel would evaluate is not defined.

**Section 1 duplicate-critic rule.** Clean. T3 still puts coverage and the high-risk critique in one pass and tells the implementer to reuse the RG-6 record-before-verdict device rather than add a mechanism. OA-3 extends the existing deliverable review. No amendment step adds a second critic over unchanged input.

## T9

The task contract is executable on its own: files, events (`triage`, answered, converted), completion-readiness change, triage before `plan_required`, tool surface (read, disposable-copy commands, no mutation), mixed / clarify / legacy / `plan_only` cases, and acceptance that a mutation attempt is refused or converted with a durable event. Zero mutation is specified as kernel enforcement: direct-event and replay bypass negatives, not a prompt instruction. That is concrete enough to build and test.

Placement is not consistent:

- Section 4 lane sentence: Lane A is T1–T3, then T9, then T4. T9 follows T3 because both write `architect-tools.ts`, `scheduler-store.ts`, `build-runtime.ts`, and `agent-prompts.ts`.
- The same section, two paragraphs earlier: the only parallel lane is T4 || T5 after T1/T2/T3, and T4/T5 integrate onto the accepted T3 base. T9 is absent.
- BP2's task cell includes T9 and its purpose mentions the answer path. BP2's exit cell does not. Exit is still "a source-complete reviewed plan can reach ready; planning cannot execute." An answered run has no such plan, and BP3's entry is "BP2".
- Section 9 has launch cards for T1–T8 only. The Lane A card still describes T2–T4 on accepted predecessor snapshots.
- `progress.md` current revision names T9. The assignment registry and the execution queue, still titled as current inside the superseded 2026-09-08 section, are T1–T4 then T6–T8, and T1 → T2 → T3 → (T4 || T5), with no T9.

## Cross-program

P6.6 does not account for `architect_document`. The agent-capability plan's packet A5 adds `BuildTaskKind` `architect_document`: runner-applied, no acceptance criteria, exempt from the acceptance-contract upgrade, zero model calls, absent from `acceptedChangeSessions`, and counted by completion readiness only once `integrated`. It writes `task-contracts.ts`, `acceptance-contracts.ts`, `task-graph.ts`, `scheduler-store.ts`, `task-scheduler.ts`, `build-runtime.ts`, and `workspace-manager.ts`.

P6.6 T1 rejects a task missing steps, scope, validation, review, or cleanup applicability, and its inspection target was updated to post-P6.5 symbols at `6c166f97`, which is before that kind exists. T4 admits tasks by worker dispatch, worktree claim, and the four-worker cap. Neither task, nor section 3's `ExecutionTaskContract`, mentions the kind or an exemption. Under OA-8 the kind is already in the tree when T1 starts. See finding B3.

OA-8's new order is in the plan header and in `progress.md`'s current revision. It is not in section 4 BP1 entry ("P6/P6.5 interfaces verified") or in the Relationship section, which still says P6.5 is planned, not implemented, and that placement is P6.6 after P6.5 and before P7. D1 still says the master queue is P6 → P6.5 → P6.6 → P7. See finding B1.

## Token economy

No amendment step adds a model pass without a stated purpose, and none instructs a reviewer to re-read unchanged input.

- OA-1 reuses the existing coverage pass and the RG-6 device.
- OA-3 is an ordering change inside the one deliverable review. The second turn exists to receive the worker report after findings are recorded.
- OA-4 changes depth inside that one review. High-tier test execution is compute, and the amendment states why.
- OA-5 makes triage the Architect's first action and runs no critic, coverage review, or verifier on the answer path unless the user opts in for that run.
- OA-6 is the accounting obligation, including skip-only-by-recorded-rule and no re-read of unchanged input.
- T8's new journeys are on the existing synthetic qualification, which already requires no model service.

EP40 is the ledger row for this obligation. The only gap is that it does not name the P6.5.4 manifests and usage projection (finding M2).

## Repository citations

Inspected at this worktree with Node v24.18.0. None of the four citations is wrong.

- `lib/db/schema.ts:481` is `export type DiscussionMode = "panel" | "debate" | "specialist" | "build"`. The three question modes are on that line. The line is the mode union, and it also includes `"build"`. It is not a routing function.
- `runner-v2/src/scheduler-store.ts:848-873` is `buildCompletionReadiness`. Inside that span: `plan_only` still requires `planRevision > 0`; a non-terminal ordinary task blocks; a missing integration revision blocks; a missing current final verification blocks and returns. The function continues after line 873.
- `runner-v2/src/runtime-router.ts:189` is the loop inside `selectVerifier` over `input.acceptedChangeAuthorRuntimeIds`, adding each author's canonical model identity to the exclusion set. The Architect identity is excluded just above, at lines 186–188. The input field is declared at line 49.
- RG-6: `record_verification_expectations` is the tool at `runner-v2/src/verifier-tools.ts:189`. The reducer gate is `recordVerifierVerdict` in `scheduler-store.ts:3706-3707`: when `twoPass === true` and no expectations are recorded, it throws `Two-pass verifier verdict requires recorded expectations.`

## Findings

### BLOCKING

**B1. OA-8 is contradicted at the entry-dependency sites.**
Location: plan section 4 BP1 entry (line 114); Relationship (lines 44–45); D1 (line 416). Also the binding boundary at line 51.
Why: The amendment's campaign order is P6.5 → agent-capability program → P6.6 → P7, because OA-4's high tier and OA-5's commands need that program's reader execution. The header and the top of `progress.md` say this. The places a controller uses to decide whether T1 may start do not. BP1 entry is still "P6/P6.5 interfaces verified". The Relationship section still says P6.5 is planned, not implemented, and that P6.6 sits after P6.5 and before P7. D1 still records the master queue as P6 → P6.5 → P6.6 → P7. Those sentences are operative, not marked historical.
Fix: Replace the queue in D1, the Relationship placement bullet, and BP1's entry cell with the OA-8 order. State that T1 inspects the post-agent-capability tree, not only `6c166f97`. Delete or historically label the "P6.5 is planned, not implemented" sentence.

**B2. The ownership sentence and the campaign completion gate still stop at EP32.**
Location: plan line 51 ("P6.6 owns only EP01–EP32"); line 67 (phase verified only after BP1–BP6 and EP01–EP32).
Why: EP33–EP41 are in section 6, and G-ADD says nothing was removed. The binding ownership sentence and the sentence that authorizes `PHASE VERIFIED 100% COMPLETE` were not extended. A controller following those two sentences can finish P6.6 without the amendment obligations.
Fix: Change both sentences to EP01–EP41, and include T9 in the phase set those sentences unlock.

**B3. T1 and T4 do not account for `architect_document`.**
Location: plan T1 acceptance (line 145) and T4 admission (lines 190–196); section 3 `ExecutionTaskContract`. Agent-capability plan A5 (`architect_document`, no criteria, runner-applied, zero model calls).
Why: OA-8 runs that program first. A5 then adds a task kind on the same contract and scheduler files T1 and T4 rewrite. T1 rejects a task that lacks steps, scope, validation, review, or cleanup applicability. T4 admits work by worker dispatch and claims. Neither records an exemption. The header points T1's inspection at post-P6.5 APIs at `6c166f97`, where the kind does not exist yet. New-policy strictness would reject or worker-dispatch a kind that is defined to have no criteria and no worker.
Fix: In T1 and T4, name `architect_document` and state the exemption: no acceptance-contract upgrade, no worker dispatch, no model call, completion only as a terminal integrated task, absent from accepted-change author exclusion. Point T1's inspection at the post-agent-capability tree.

### IMPORTANT

**I1. "The answer path is not planning state" is not a kernel predicate, and the positive test is on the wrong task.**
Location: EP41 (tasks column is T3 only; evidence asks for an answer-path admission positive). T3 acceptance (line 182) states only that a planning-state command attempt is refused. T9 follows T3. EP32 (line 328) and T3's plan-only zero-execution assertion (line 184) are unchanged.
Why: OA-7 requires the answer path to be distinguishable from planning so command execution can be refused in one and admitted in the other. The plan states the property and a pair of tests. It never names the state or event a reducer would read. T3 cannot honestly run the positive test, because T9 creates the answer path afterward, and T9 is not a contributor on EP41. Separately, T9 answers a `plan_only` question and may run disposable-copy commands, while EP32's plan-only tests still require zero implementation driver, test, and migration calls. Without a predicate, those tests and T9's commands disagree.
Fix: Define the predicate in T3's planning-state contract (for example: command execution is admitted only when the durable triage decision is `answer` and the run is outside the planning states T3 names). Move the positive admission test to T9 and add T9 to EP41's task column. Amend EP32's plan-only zero-execution evidence so an answered `plan_only` run is outside that assertion.

**I2. Two of the four OA-2 category identifiers are not in the plan.**
Location: EP34 (line 330); T3 OA-1/OA-2 step (line 178). The strings `missing_coverage` and `weakened_obligation` do not occur in the plan. `scope_creep` and `unverified_claim` do.
Why: OA-2 adds those four names to the existing eight plan-critique categories, and it keeps them distinct from the per-obligation verdicts `covered` / `weakened` / `missing`. "Four additive categories" plus a round-trip test can be satisfied by any four strings. An implementer can collapse `weakened_obligation` into the verdict `weakened`.
Fix: Write all four identifiers into EP34 and the T3 step, and make the round-trip fixture reject a verdict word used as a category and a category word used as a verdict.

**I3. T9's serialization and BP2's exit disagree with each other.**
Location: section 4 lines 115 (BP2 exit), 121 (T4 || T5 after T1/T2/T3), 123 (integrate onto the T3 base), 125 (lane sentence: T9 then T4). Section 9 cards (lines 389–397) and Lane A card (line 409). `progress.md` lines 75–81 and 152.
Why: One sentence places T9 after T3 and before T4. The parallel-lane sentence, the integration base, BP2's exit, the launch cards, and the progress registry do not. BP2 can be read as exited when a reviewed plan is ready, with T9 unrequired, and an answered run has no reviewed plan to satisfy that exit.
Fix: Make BP2's exit require both a reviewed plan on the build path and a completed answer on the answer path. State T4's predecessor as accepted T9, keep T5's base as accepted T3, add a T9 launch card, and replace the progress registry and execution queue so Lane A is T1–T3, then T9, then T4, then T6–T8.

### MINOR

**M1. OA-1's proof list drops two channel names.**
Location: EP33 evidence; T3 amendment acceptance (line 182).
Why: The amendment requires the deriving-turn assertion to cover context pack, prompt, tool result, session replay, and an earlier-turn checkpoint, because a section-id check can pass after the plan is already in a pack or prompt. The plan names messages, tool results, loaded session, replay, and an earlier-turn checkpoint, and it correctly says a section-id check is not the proof. It does not name context pack or prompt.
Fix: Add context pack and prompt to the EP33 evidence cell and the T3 acceptance sentence.

**M2. OA-6 does not name the stores it must reuse.**
Location: EP40; T7 OA-5/OA-6 step (line 253).
Why: The amendment says purpose and token cost are recorded using the P6.5.4 context manifests and the existing usage projection. The plan requires the records and the UI surface, and section 1 already says to reuse those manifests for other coverage data. EP40 itself does not pin the two stores, so a new counter would still satisfy the row.
Fix: Name both stores in EP40 and the T7 step.

**M3. EP39's task column omits T7, which owns the visible answer.**
Location: EP39 tasks "BP2; T9". T7 step cites EP39 for showing the answer, the question parts, and the opt-in. T9 says UI belongs to T7.
Why: The UI half of OA-5 item 2 is specified, and it is easy to miss from the ledger row alone.
Fix: Add T7 as a contributing task on EP39.

**M4. Signal names, tier direction, and the defect-label source are not restated.**
Location: T5 OA-4 step (line 214); EP38.
Why: The step says "six signals" and the three-part threshold rule. It does not list the signals, does not say fast/cheap authors increase risk, and does not say defect-carrying commits are those whose review-found defects are recorded in the P6.5 ledger. The amendment has all three. A threshold replay can pass on a privately labelled set.
Fix: Restate the six signals, the tier direction, and the P6.5 ledger as the defect source in the T5 step.

## Categories with no finding

- EP21/EP22 versus OA-4 depth tiering: clean, as written under Conflicts.
- Duplicate-critic rule versus the amendment steps: clean.
- Token economy of the amendment steps: clean, aside from M2's store names.
- The four code citations: none wrong.
- OA-9: recorded as a proposed, unconfirmed resolution in the section 10 addendum and as progress condition 2. D3 is not treated as decided.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking conditions:

1. **B1.** Section 4 BP1 entry, the Relationship section, and D1 still give the pre-amendment order. OA-8's order (P6.5 → agent-capability program → P6.6 → P7) has to replace those sentences, and T1's inspection target has to be the post-agent-capability tree.
2. **B2.** The binding "owns only EP01–EP32" sentence and the campaign completion gate have to include EP33–EP41 and T9.
3. **B3.** T1 and T4 have to name `architect_document` and exempt it from worker admission and from the complete-acceptance-contract rule.

I1, I2, and I3 are required before this delta can be executed as written. They are not, by themselves, the blocking conditions above. M1–M4 should be corrected in the same edit. The moved-scope items that did not survive (separate change-critique stage, stage-1-findings blindness, low-tier skip, derive-before-diff, and an explicit `weakened` hold) need an owner confirmation that the narrowing is intended; they are not plan rows that can be patched without that confirmation.
