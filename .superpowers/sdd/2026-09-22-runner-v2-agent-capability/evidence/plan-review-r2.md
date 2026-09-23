# Re-review — plan revision 2

Reviewer context: fresh. Read-only. No edits to the workspace.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`
Branch: `docs/agent-capability-and-change-critique` at `03e85149` (tree clean; confirmed with `git rev-parse HEAD`).
Prior review: `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/evidence/plan-review-r1.md`
Plan: `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md`
Source: `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`
State: `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/STATE.md`

Scope was the five blocking repairs, the nine important repairs, new decision D7, and regressions those edits introduced. Unchanged material that revision 1 already cleared was not re-audited.

---

## PART 1 — Blocking conditions from revision 1

| ID | Verdict | How it was verified |
|---|---|---|
| B-1 | **NOT FIXED** | The parallel-write is gone: B1’s writable surface is only `context-manifest-store.ts` and its test, and §5.2 assigns the five call sites to nobody. The five `await recordContextPack` sites themselves have no try/catch (`native-architect-runtime.ts:175`, `native-verifier-runtime.ts:378` and `:651`, `native-plan-critic-runtime.ts:181`, `native-worker-driver.ts:161`). The verifier’s only try (`native-verifier-runtime.ts:229-242`) wraps session load, not recording. Architect, both verifier sites, and the critic throw through to `build-runtime.ts` (`runArchitect` at `:1448`, `driver.verify` at `:1218` via `native-build-factory.ts:1013`, `driver.critique` at `:1705` via `native-build-factory.ts:977`). The worker does not. `task-scheduler.ts:221-234` catches every `driver.run` rejection and `recordOutcome`s `type: "failed"` (`:290-292`). `build-runtime.ts:837-838` only `tick`s and `awaitIdle`s; that promise already resolved inside the scheduler catch. B2’s writable list does not include `task-scheduler.ts`. A catch added only in `build-runtime.ts` never sees the worker’s `ContextManifestRecordingError`, and the run continues with a failed task instead of the typed pause. |
| B-2 | **NOT FIXED** | AC-9 is split. AC-9b keeps `review_task`, `request_integration`, and `complete_run`, and A1 states that A1 is not accepted until A1b is (also `STATE.md` §4). That sentence exists. A1b is not a packet the controller can assign. There is no `### A1b` contract, so no writable list, steps, or prove-red. §1.1 does not list A1b. Phase A’s packet list omits it. §4, which says it is the authoritative graph and that every Depends-on field matches it, has no A1b node. `STATE.md` says A1b depends on A1 and B2. The controller launch card’s B2-release sentence unblocks A5, C2, and C4, and does not mention A1b. §5.2 writes `build-runtime.ts` as `B2 → C4 → E3; A1b after B2`, which does not place A1b before C4. Lane C opens at B2 and C4 writes that file. A1b and C4 can both edit it. |
| B-3 | **REPAIRED** | `createMcpTools` sets `readOnly` only when `readOnlyHint === true && destructiveHint === false`, and sets `effect: "external"` (`mcp-tools.ts:156-159`). A2 states that predicate, admits dynamic names as a checked class rather than static list entries, and keeps verifier and critic at zero MCP. Current source D3 records that zero-MCP scope as deliberate and states the mapper predicate. A2’s acceptance distinguishes the three stub shapes, and its prove-red is the `destructiveHint` half. A2 may edit the Architect runtime and `role-capabilities.ts`, which is where Architect MCP is registered (`native-architect-runtime.ts:305`), and it does not need `mcp-tools.ts`. |
| B-4 | **NOT FIXED** | A5 names `change-set.ts` and requires the stored ChangeSet to carry no acceptance criteria. That closes the dropped assertion. The surface is still not sufficient to build “present in the audit,” and the commit mechanism is still not stated. `createChangeSet` (`change-set.ts:63-100`) still requires `taskCommit` and at least one evidence hash; `ChangeSet` has no actor field. The audit list is `acceptedChangeSessions` (`native-build-factory.ts:2725-2743`), which keeps a session only when `actor.role === "worker"` and the id is an integrated task’s `changeSetId`. That file is not in A5’s writable list. A5 says “the integration and audit path” and “Define how an Architect write obtains a commit,” which leaves both the files and the mechanism to the worker. §3.0 forbids anything not listed. A5’s Depends-on says B2 releases `build-runtime.ts` and `scheduler-store.ts`, but the writable list does not name them and §5.2 gives those files to C4 and C2. C4 also writes `native-build-factory.ts`, the file the audit filter actually lives in, with no §5.2 turn for A5. |
| B-5 | **NOT FIXED** | I1 and I3 have one owner: Lane B, in §5.1, the Lane B card, and `STATE.md`. C3 depends on A3 in the packet, the graph, §5.2, and `STATE.md`. B2 → C2 and B2 → A5 are real edges, and C4 depends on B2. Those three pieces of the old finding are closed. The entry conditions still disagree. §2 starts Phase C only after I1, I3, A1, A3, and B2. C1’s Depends-on, and the §4 edges into C1, are only I1 and I3. The Lane C card, §5.1, and `STATE.md` open the lane after B2 plus I1 and I3, and do not mention A1 or A3. Three different start rules remain. |

---

## PART 2 — Important findings from revision 1

| ID | Verdict | One line |
|---|---|---|
| I-1 | **REPAIRED** | B2 specifies a finite Architect `retry` budget that re-pauses on the existing note, and a tested fail-closed path when the scheduler append throws; the worker hole is B-1, not a missing sentence in B2. |
| I-2 | **REPAIRED** | A3 names the execution root per role, confines the Architect to a disposable copy so a shell cannot write the project, and proves confinement with a fixture double because `containedDirectory` already exists and `evidence-tools.ts` is forbidden. |
| I-3 | **REPAIRED** | AC-7 and A4 require success only on an I2 path and refusal of a path outside the allow-list and outside `runner-v2/src`, with a denylist prove-red. |
| I-4 | **REPAIRED** | A3’s writable list includes `agent-prompts.ts` and limits the edit to the read-only-tools sentence, leaving the authorship prohibitions in place. |
| I-5 | **REPAIRED** | A1 names `PlanOnlyInspectionRuntime` and routes that predicate through the same allow-list. |
| I-6 | **REPAIRED** | C2 extends `resolve_plan_critique` for `stage: "change"`, keeps the zero-blocking auto-resolve, and adds the durable field; C3 requires the remains-open mark on turn 2. |
| I-7 | **REPAIRED** | C1 requires `collectChangeRiskSignals` plus named kernel-set and affected-test constants; I1 clause (c) forces an execution-only defect into `high`; AC-16 binds the recorded command to that rule. |
| I-8 | **REPAIRED** | A0 writes `runner-v2/test/support/pre-capability-run.fixture.json` before any source packet, and D1g replays that fixture. |
| I-9 | **REPAIRED** | §3.0 puts each packet’s tests on its writable list and keeps `filesystem-mutation-routing.test.ts` controller-owned; several packets say “the affected tests” rather than filenames, which is enough to lift the ban. |

None of I-1 through I-9 was answered with prose alone. Each has a packet acceptance or a ledger evidence cell that names the new behavior.

---

## PART 3 — D7, derived before the plan’s AC-19..AC-23 rows

Derived from source D7 (the decision at lines 334-404: the six-step order, the reuse of the record-before-seeing device, the four categories, the two rejections, and OQ-4). This list was fixed from that section before the plan was opened. The source’s own §4 table, which restates AC-19..AC-23, was read with the rest of the source immediately after D7; it was not used to shrink this list.

### Obligations

1. **Fresh session.** The coverage review has no history of the work being reviewed. A new prompt section inside an existing critic or architect session does not satisfy this.
2. **Derivation inputs.** The deriving turn receives the original objective and the durable user guidance. It does not receive the Architect’s criteria, the plan, or the diff.
3. **Record before seeing.** Those obligations are durably recorded before stage 1 is given the plan and before stage 2 is given the diff and the criteria.
4. **Then the artifact.** Stage 1 may see the plan only after that record. Stage 2 may see the diff and the criteria only after that record.
5. **Per-obligation verdict.** Each derived obligation gets exactly one of `covered`, `weakened`, `missing`.
6. **Check the repository.** A cited claim is verified against the repository. Trusting the citation is rejected.
7. **Kernel gate, different subject.** Reuse the RG-6 device (refuse a verdict when the prior record is absent). The record is coverage obligations derived from the request, not verification expectations derived from the criteria. Today that gate is the reducer throw at `scheduler-store.ts:3706-3708` (“Two-pass verifier verdict requires recorded expectations.”).
8. **Four categories, additive.** `missing_coverage`, `weakened_obligation`, `scope_creep`, and `unverified_claim` join the existing eight. A malformed category is rejected. The existing eight stay valid.
9. **Category meanings.** `missing_coverage`: the objective requires it and nothing delivers it. `weakened_obligation`: a task covers it for less than was asked. `scope_creep`: a task serves no part of the objective (a statement about a task, not an obligation verdict). `unverified_claim`: a cited evidence record does not say what the citing task claims.
10. **Not advisory.** A missed obligation that cannot hold the build ships. The hold is real. D7 does not specify the resolution vocabulary; a hold until an existing Architect resolution is compatible, a finding that cannot hold is not.
11. **Rejected input.** The Architect’s criteria are not the derivation input.
12. **OQ-4.** Stage-1 coverage is either risk-gated or mandatory, and that choice is the plan’s to record. If it is gated, it is harder to skip than D5 defect-hunting. The source marks the question non-blocking and assigns it to an investigation packet. Silence is not a decision.
13. **`weakened` is the under-exercise class.** A criterion that existed and was not exercised must be expressible as `weakened`, not collapsed into `covered`.
14. **Leak channels.** “Before it is allowed to see” includes every channel into the deriving turn: the context pack, the system prompt, tool results, session replay, and a checkpoint of an earlier turn. A structured section list that omits a criteria id does not prove the turn is blind.
15. **Both directions.** `scope_creep` and `unverified_claim` stay reportable even though they are not values of the three-way obligation verdict.

### Comparison

| Obligation | Where the plan puts it | Result |
|---|---|---|
| 1 Fresh session | Not stated in E1, E2, E3, the ledger, or the launch cards | **Missing.** E2 edits `native-plan-critic-runtime.ts`, whose session id is `planCriticSessionId` over the plan revision. Nothing requires a new session with an empty event list. |
| 2 Derivation inputs | AC-19, E1 context builder “objective and durable user guidance only” | **Weakened.** The phrase is present. The evidence cell is “an exact section-id assertion, not a negative check.” Durable user guidance is not bound to a store field. |
| 3–4 Record, then plan / diff+criteria | AC-20, E2 “stage 1 before the plan; stage 2 before the diff” | **Weakened.** Stage 2’s sentence omits criteria. “Ordering asserted” does not say the assertion inspects the deriving turn’s messages. An event-log order satisfies the words while the prompt already contains the plan. |
| 5 Verdict enum | AC-21, E2, E3 | **Covered** as a contract: one test per value, blocking `missing` and `weakened` hold integration until the extended resolution path. |
| 6 Verify citations | AC-23, E2 “seeded mismatch” | **Weakened.** See the AC-23 finding below. |
| 7 Kernel gate | E1: event `coverage_obligations_recorded`, gate refuses a coverage verdict with none recorded, reddens when deleted, modelled on the RG-6 gate | **Concrete enough to build.** The event name, the refuse condition, and the deletion prove-red are specified, and the live pattern is the reducer throw at `scheduler-store.ts:3706-3708`. Residual: that prove-red also passes if the worker deletes the expectations gate and never checks coverage obligations. The verdict event name is not given. |
| 8–9 Categories | E1 “add the four categories”; AC-22 round-trip and unknown rejected | **Weakened for behavior.** The schema test is real. Nothing maps `missing` / `weakened` onto `missing_coverage` / `weakened_obligation`, and nothing requires a task with no supporting obligation to be filed as `scope_creep`. |
| 10 Not advisory | E3 holds the build until resolution | **Covered**, for a verdict that is actually produced. |
| 11 Criteria are not the derivation input | AC-19 forbids criteria in the derivation context | **Not proved** by the stated evidence. See finding D7-1. |
| 12 OQ-4 | No investigation packet, no decision, no “every run” or “harder to skip than D5” sentence | **Missing.** |
| 13 `weakened` catches under-exercise | The verdict value exists; no acceptance says under-exercise is `weakened` rather than `covered` | **Weakened.** |
| 14 Leak channels | E1 acceptance explicitly stops at section ids. The Lane C card tells E2 to prove “any channel, including the tool surface.” C3’s own review focus names context pack, prompt, tool result, and session replay; E1/E2 do not. Checkpoint is unnamed. | **Contradiction, and the packet acceptance is the weaker one.** |
| 15 `scope_creep` and `unverified_claim` remain findings | AC-22 accepts the categories; AC-23 seeds `unverified_claim` | **Partial.** `unverified_claim` has a test shape. `scope_creep` has a parser round-trip only. |

**Is “derive from the objective, never the criteria” proved by the stated evidence?** No. AC-19 and E1 say the proof is an exact section-id assertion, and they say it is not a negative check. That shows a context object contains an objective section and lacks a criteria, plan, or diff section. It does not show the deriving turn’s messages, tool results, replayed session, or checkpoint lack that material. Criteria can sit in the objective text, in the system prompt, or in history under a section id the assertion does not name.

**Can obligations leak through a channel the plan did not name?** Yes. Session replay and checkpoint are not named on E1 or E2. The critic runtime already persists a session keyed by plan revision (`native-plan-critic-runtime.ts:175-180`) and then continues in that session. A derivation turn appended there has the plan in history even when the new context pack’s section ids are clean. The Lane C card’s “any channel” sentence is not the E1 acceptance a worker is graded on.

**Is the AC-20 kernel gate concrete enough to build?** Yes, with the residual above. A worker can add `coverage_obligations_recorded` and refuse the coverage verdict in the scheduler reducer the same way `scheduler-store.ts:3706-3708` refuses a two-pass verdict with no expectations, and can prove it by deleting that throw.

**AC-23 `unverified_claim`.** There is no stated way to decide that a cited evidence record does not support a claim. E2 says a seeded mismatch produces the finding and a matching citation does not. It does not say what is compared (record text, hash, cited lines, model judgement after a repo read) or who decides. A stub that emits the category when a fixture flag is set satisfies the sentence. The source’s own picture is a reviewer checking the repository, which is model judgement; the plan neither adopts that as the contract nor replaces it with a mechanical predicate.

---

## PART 4 — Regressions introduced by revision 2

Revision 2 added A0, A1b, A5, and Phase E, and it rewrote the graph, the phase entries, and the ledger. The following conflicts were not in revision 1.

1. **A1b is an orphan and races C4.** Present in the Lane B roster, A1’s prose, §5.3, both launch cards, and `STATE.md`. Absent from §3, §1.1, the phase list, and the §4 graph. §5.2 does not order it ahead of C4 on `build-runtime.ts`. This is the B-2 repair, and it is also a new ownership conflict.
2. **E1 races C3 on `agent-prompts.ts`.** §5.2’s sequence is A3 → C3 → E1/E2. E1’s Depends-on is only C2. The graph draws C2 → E1 and C3 → E2, not C3 → E1. After C2 integrates, E1 and C3 can both edit `agent-prompts.ts`. E1 also edits `plan-critique-contracts.ts` and `scheduler-store.ts`, which are safe relative to C2 because E1 waits for C2. The prompt file is the collision.
3. **A5’s release claim collides with Lane C’s inheritance.** A5 says it needs `build-runtime.ts` and `scheduler-store.ts` once B2 releases them. §5.2’s next owners of those files are C4 and C2. A5 is on Lane B after B2, in parallel with Lane C.
4. **“A0 → everything” is not the graph.** The caption and the launch cards say A0 gates every source packet. The drawing gives A0 edges only to A1 and B1. I1, I2, and I3, and `STATE.md`, depend on nothing. A0’s own contract says “no source packet,” and the investigations write evidence files only, so I2 may start beside A0. The caption overclaims. That does not drop an obligation if the controller treats investigations as non-source. It does contradict “A0 → everything.”

No cycle was introduced. The longest path stated as 8 (`A0 → B1 → B2 → C2 → C3 → C4 → C5 → D1g`) is still acyclic. The problem is disagreement among the graphs, not a loop.

---

## New findings

### BLOCKING

**D7-1. AC-19 can pass while the deriving turn has already seen the plan and the criteria.**
Location: ledger AC-19 evidence cell; E1 acceptance (“exact section-id assertion, not a negative check”); E2 has no fresh-session step.
Why: D7 step 1 is a fresh session and step 3 is derive-and-record before the plan or the diff is provided. The graded proof checks section ids on a context object. The live critic session is created before the critique and already carries the plan (`native-plan-critic-runtime.ts:175-194`). Session replay and checkpoint are unnamed. A green AC-19 does not prove the obligation.
Fix: Require a new session whose event list is empty at derivation. Assert on the deriving turn’s actual messages, tool results, and loaded session that the objective and durable user guidance are present and that no criteria, plan, or diff text is present. Put that assertion on E2, and make E1’s section-id check a helper rather than the acceptance. Make E1 depend on C3 so `agent-prompts.ts` has one owner (PART 4 item 2).

**B-1 remains blocking** (worker path). Fix: catch `ContextManifestRecordingError` in `task-scheduler.ts` `dispatch`, or stop catching it there and let it surface as the typed pause. Add `task-scheduler.ts` to B2’s writable list and to §5.2. A catch that lives only in `build-runtime.ts` does not cover `native-worker-driver.ts:161`.

**B-2 remains blocking** (A1b). Fix: Give A1b a §3 contract whose writable file is `build-runtime.ts` and whose Depends-on is A1 plus B2. Put `B2 → A1b → C4` on the §4 graph and in §5.2 so C4 cannot start while A1b holds the file. Add A1b to §1.1, the phase list, and the controller’s B2-unblock sentence.

**B-4 remains blocking** (A5 surface). Fix: Name the files. The audit filter is `acceptedChangeSessions` in `native-build-factory.ts`. State the commit path (which workspace, which commit API, which task id if the integrator still requires one). Serialize that file against C4. Assert the stored change is attributed to the architect and appears in the accepted-change audit without acceptance criteria. “Define how” is not a mechanism.

**B-5 remains blocking** (three Phase C entry rules). Fix: Pick one. C1 touches only a new `change-risk.ts`, so the graph’s rule (I1 and I3) can be the phase entry, and the launch card should say the lane’s later packets wait on A3 and B2 where their own Depends-on fields already say so. Alternatively add A1, A3, and B2 to C1’s Depends-on and draw them. §2, §4, §5.1, the Lane C card, and `STATE.md` have to match.

### IMPORTANT

**D7-2. OQ-4 is unanswered.** No investigation packet and no sentence says stage-1 coverage runs on every plan or is harder to skip than D5. E2 only describes order when the stage runs. A low-risk skip copied from `planCritiqueRequired` satisfies the written packet.
Fix: Record the decision. If the recommendation is adopted, state that stage 1 is not risk-skipped and add a test that a low-risk plan still records coverage obligations.

**D7-3. `unverified_claim` has no decision procedure.** E2’s seeded mismatch does not say how “does not support” is judged. Left as model judgement, the contract should say the reviewer reads the cited evidence record and the kernel only checks that the category is well-formed and that the cited id exists. Left as a kernel check, the contract should name the comparison.
Fix: Choose one and make the test fail when that rule is removed.

**D7-4. `scope_creep` is schema-only.** AC-22 round-trips the category. No test files a finding for a task that serves none of the derived obligations.
Fix: Add that case to E2, next to the seeded `unverified_claim` pair.

**D7-5. The AC-20 prove-red does not show the gate is about coverage obligations.** Deleting the expectations throw at `scheduler-store.ts:3706` also reddens a test that only checks “a missing prior record refuses a verdict.”
Fix: Assert the refusal fires when verifier expectations exist and coverage obligations do not, and that it does not fire when coverage obligations exist and expectations do not.

### MINOR

None worth recording. A2’s sentence that briefly says `effect !== "external"` corrects itself to `effect !== "none"` in the same paragraph, matching `assertReadOnlyInspectionDefinition`.

---

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking conditions:

1. B-1: a `ContextManifestRecordingError` from the worker is swallowed by `task-scheduler.ts:227-234` and never reaches the dispatcher catch B2 is allowed to write.
2. B-2: A1b is not on the authoritative graph and is not ordered before C4 on `build-runtime.ts`, so AC-9b still cannot be assigned without a file collision.
3. B-4: A5 still does not name the audit path or the commit mechanism, and `acceptedChangeSessions` drops every non-worker session.
4. B-5: Phase C’s entry, C1’s Depends-on, and the Lane C launch card still state three different start rules.
5. D7-1: AC-19’s evidence is a section-id assertion, and no packet requires a fresh session or closes session replay and checkpoint, so “derive from the objective, never the criteria” can pass while false.

Execution is not authorized until those five are repaired and reviewed again.
