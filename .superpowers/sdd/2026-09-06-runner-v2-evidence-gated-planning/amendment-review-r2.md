# P6.6 owner amendment — independent scoped re-review, revision 2

Reviewer: fresh context. Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`.
Amendment source read first: `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md` (Revision 2).
This STEP 2 list was written before the plan or progress file was opened.

## STEP 2 — obligations for (b)–(e), before the plan

Expected ledger names come from the review order (EP37, EP42–EP44, EP45–EP51). Which row owns which obligation is not yet checked.

### (b) OA-10 — five narrowings, expected rows EP42–EP44

The amendment adds these decisions. Items 1 and 3 have **no new obligation**. Items 2, 4 and 5 must be implemented, each with one owning row, a real acceptance route, and a task.

1. **AC-11 accepted narrowing.** No separate change-critique stage before the verifier. T6's one deliverable review is the change review. A second critic is forbidden. Obligation: none.
2. **AC-13 restored, generalized.** Every reviewer records its own findings **before** it may see any other reviewer's findings on the same artifact. Fix re-review: record its view of the fix first, then receive the prior findings and check each is resolved.
3. **AC-15 accepted narrowing.** No recorded skip at low risk. Low tier remains the one mandatory review, reading only. Obligation: none.
4. **AC-20 restored at high risk only.** At high tier, the deliverable reviewer records obligations derived from the source criteria **before** it receives the diff. At low and medium, OA-3's order (criteria and diff first, worker report later) is enough.
5. **AC-21 restored.** A coverage verdict of `missing` or `weakened` at blocking severity holds plan readiness until resolved, the same way an omitted obligation does.

### (c) OA-3 loosened reviewer rule, expected row EP37

Same rule everywhere (coverage reviewer OA-1, deliverable review, opt-in answer review OA-5):

1. Prefer a candidate whose model identity differs from the Architect and from every model that authored the change. Reuse `RuntimeRouter.selectVerifier` exclusions from `acceptedChangeAuthorRuntimeIds` (`runtime-router.ts:189`).
2. If no distinct candidate exists, an eligible same-identity candidate may run, only in a **new session whose event list is empty** at start (no messages, tool results, or context from any other session).
3. Record `independence: "distinct_model"` or `"fresh_context"` durably and show it.
4. Pause for a user selection only when no eligible candidate exists at all.
5. The fallback is delivered by the agent-capability program's packet R1; P6.6 reuses it and must not reimplement a competing selector.

This is a loosening of a hard distinct-model requirement. It must not drop the empty-session proof, the durable independence record, or the pause-when-none rule.

### (d) OA-9 confirmed — D3 must not block

- Owner: Node **24.x** is accepted ("yes, 24.x is fine").
- Matches `package.json` engines `>=24.0.0 <25`.
- 24.18.0 is the verified local version, not a pin.
- Decision D3 is resolved and **must no longer block** P6.6 (plan, progress, open blockers, or entry gates).

### (e) OA-11..OA-17, expected rows EP45–EP51

Each needs exactly one owning EP row, a real acceptance route, and a task. Ladders (OA-11, OA-12, OA-13) must record the rung, degrade through recorded steps, and never report passed or a narrowed set without justification. The runner, not a model, performs the mechanical checks. Language neutrality is an obligation: C, C++, C#, Java, JavaScript, TypeScript, Go, Rust, Kotlin, Swift, Python, and any other language the runner builds.

**OA-11 — break-it probe at high risk.** Runner mutates small pieces of the task's changed lines, one at a time, runs the OA-12 affected tests against each, and records survivors (changes the tests did not catch). Survivors are evidence for the reviewer, not automatic blockers. Zero model tokens.

Ladder:

1. Project's own mutation tool when already configured (examples: Stryker, Stryker.NET, PIT, mutmut, cargo-mutants, Mull), scoped to changed files.
2. Built-in token-level mutator by syntax family: C-family (C, C++, C#, Java, JavaScript, TypeScript, Go, Rust, Kotlin, Swift) and Python-family. Swap comparison operators, boolean literals, `+`/`-`, `&&`/`||` on changed lines only, with a lexer that skips comments and strings.
3. Recorded **"not available"** for any other language, or when no affected-test command exists.

Every rung: a change that does not build is discarded, not counted as caught. Work runs in a disposable copy, never the task workspace or the project. Caps on change count and time; early stop records partial coverage. Rung used is recorded. Safe floor is "not available", never a pass and never a silently narrowed survivor set.

**OA-12 — affected-test ladder.** "The affected tests" is computed and the rung recorded:

1. Project impact tool when configured (examples: `nx affected`, `jest --findRelatedTests`, `bazel query rdeps`, `dotnet-affected`, pytest-testmon).
2. Compiler or language-server references through the existing generic LSP client (`lsp-client.ts`, `language-provider-router.ts`): tests that reference changed symbols.
3. Build-system module graph, the floor when a build system exists: every test in the module that contains a changed file and in modules that depend on it (npm workspace, `.csproj` / solution, CMake target, Cargo crate, Go package, Maven/Gradle module).
4. The full suite.

Widening: a change to build configuration, a lockfile, a shared header, generated code, or a file type the ladder does not understand steps down to at least rung 3, and to rung 4 when no module graph exists. The ladder never narrows below what it can justify. Safe floor is the full suite.

**OA-13 — read reports, do not assume.** Read machine-readable reports where the tool emits them: JUnit XML (Java, gtest `--gtest_output=xml`, `ctest --output-junit`, pytest `--junitxml`, jest-junit, cargo-nextest, go-junit-report) and TRX (`dotnet test --logger trx`). Record selected, passed, failed, and skipped counts. A missing or unreadable report is **"unknown", never "passed"**. Exit status alone is exit status, not proof a test ran. Zero selected tests is not green (existing T5 rule). Safe floor is unknown, never passed.

**OA-14 — isolate a flake before charging a repair cycle.** Before a failing check charges a repair cycle, re-run **only the failing tests once**, same revision and environment. If they then pass: record **flaky**, charge no cycle, keep the flake visible as a finding. If they fail again: charge the cycle as usual. A flaky required check still blocks acceptance until it passes on its own run. This never turns a failure into a pass.

**OA-15 — remember defect classes.** Each review-found defect is recorded with a short class, per project. Worker and reviewer briefs include the most frequent classes for that project, capped (default: five classes, 300 tokens). The cap and the inclusion are recorded under OA-6.

**OA-16 — track record feeds change risk.** Per model identity, keep how often review found a defect in its accepted work. OA-4's author-tier signal reads a **snapshot** of that record taken at risk computation, so identical inputs stay deterministic. With no record yet, the default tier is used and that fact is recorded.

**OA-17 — no leftovers.** After each task attempt and each verification, check for processes the runner started that are still alive and for temporary files it created outside the workspace. Use existing process ownership (same on every language and OS the runner supports). A leftover is cleaned up where ownership is proven, and recorded as a finding either way. Uncertain ownership is retained and reported, never killed on a guess.

### Cross-checks these obligations create (applied after the plan is read)

- OA-10 #2 versus a fix-delta re-review that needs prior findings (order: own view first, prior findings second).
- OA-10 #1 and #3 must stay "no extra critic" and "no skip at low risk".
- OA-15's brief injection needs the stated cap and OA-6 accounting.
- OA-3's fallback must be findable as a dependency on agent-capability packet R1.
- OA-11..OA-14 and OA-17 placement must keep T5 off scheduler, factory, and integration files, and keep T4 parallel with T5.
- D3 / Node pin must be gone as a blocker.

## r1 fix table

Plan read after the list above: `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md`. Progress current revision: `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/progress.md` lines 1–39. r1 findings: `amendment-review-r1.md`.

| ID | Status | Where the revision stands |
|---|---|---|
| B1 | FIXED | BP1 entry (section 4) requires the agent-capability program accepted and inspected. Relationship says P6.5 is merged at `6c166f97` and P6.6 sits after that program. D1's queue is P6 → P6.5 → agent-capability program → P6.6 → P7. T1 inspects the post-agent-capability tree, including `architect_document` and the reviewer-independence fallback. Two older sentences still omit the program; that residual is MINOR below, not an unfixed B1. |
| B2 | FIXED | Section 1 ownership is EP01–EP51. The campaign gate is BP1–BP6, tasks T1–T9, and EP01–EP51. |
| B3 | FIXED | Section 3 `ExecutionTaskContract` names `architect_document` (no criteria, no worker, zero model calls, terminal `integrated` only) and says it is not an escape for a worker task. T1 accepts that variant and rejects a worker task wearing the label. T4 excludes it from worker admission, worktree claims, and the worker cap. |
| I1 | FIXED | T3 defines a reducer predicate: planning state while there is no durable triage decision, or triage is `build` and there is no ready plan. Before triage is covered. The positive admission test is on T9. EP41 names T3 and T9. EP32 scopes the zero-execution assertion to that predicate and keeps an answered run at zero implementation dispatch, migration, and project mutation, which matches T9's disposable-copy commands. A new hole in the predicate's complement is finding N1. |
| I2 | FIXED | T3 and EP34 name `missing_coverage`, `weakened_obligation`, `scope_creep`, and `unverified_claim`, and the round-trip rejects a verdict word used as a category and the reverse. |
| I3 | NOT FIXED | The pieces r1 asked for are present, and they contradict each other. See finding B-R2. |
| M1 | FIXED | EP33 and T3's amendment acceptance name context pack, prompt, messages, tool results, loaded session, session replay, and an earlier-turn checkpoint, and say a section-id check is not the proof. |
| M2 | FIXED | EP40 and the T7 step name the P6.5.4 context manifests and the existing usage projection, and forbid a new counter. |
| M3 | FIXED | EP39's task column is T9 and T7. |
| M4 | FIXED | T5's OA-4 step lists the six signals, says a lower author tier raises risk, and takes defect-carrying commits from the P6.5 ledger. EP38 repeats that. |

I1 answers to the three questions in the review order: the predicate is concrete for "in planning state?" (a missing triage decision, or triage `build` without a ready plan). It covers the time before triage. EP32 and T9 agree.

I3 agreement check: they do not agree. Section 4's BP2 exit requires both the reviewed-plan path and the answer path, and BP4's entry dependency is BP2, so T5 waits for T9. The next paragraph says T5 does not wait for T9. T3's validation sentence still says BP2 unlocks only a reviewed executable plan. The T4 card and Lane A card wait for T9; the T5 card's base is accepted T3. `progress.md`'s registry makes Lane B eligible after T3; its queue arrow places T9 before `(T4 || T5)` while the parenthetical says T5 is on T3.

## Coverage table

| Obligation | Ledger row | Result |
|---|---|---|
| OA-3 loosened (distinct model preferred, else empty-session fresh context; record `distinct_model` / `fresh_context`; pause only when no eligible candidate) | EP37, implemented in T6. Order-before-report stays EP36. Relationship applies the rule to plan critic, verifier, coverage reviewer, deliverable reviewer, and opt-in answer reviewer. | weakened. T6's route is real: `RuntimeRouter.selectVerifier` with `acceptedChangeAuthorRuntimeIds`, single-model fixture yields `fresh_context`, sentinel absent from the first request. T3 states the rule and EP33 already forces the coverage reviewer's empty event list; EP37's independence-value fixture does not include T3. T9 tells the opt-in answer reviewer to use the rule and does not require an empty event list or the sentinel. |
| OA-9 Node 24.x; D3 must not block | No new row. Section 2, T1, section 10 heading and addendum, progress current revision. `package.json` engines are `>=24.0.0 <25`. | covered. The superseded progress section and the historical paragraph under D3 still describe the old pin; both are labelled historical. The current block is this re-review, not D3. |
| OA-10 #1 separate change-critique stage | none, by the owner's "obligation: none" | covered. No second critic was added. EP21 remains one combined review. |
| OA-10 #2 own findings before any other reviewer's findings; fix re-review checks resolution after that | EP42. T6 owns it; T3 and T9 contribute. | covered. Evidence: the second reviewer's first turn has no prior finding text; prior findings arrive only after a recorded finding set; deleting the gate reddens. |
| OA-10 #3 no low-risk skip | none, by the owner's "obligation: none" | covered. EP38/T6: every task still gets the one mandatory review; low tier reads only. |
| OA-10 #4 high tier records source-derived obligations before the diff | EP43, T6 | covered. High-tier first turn has criteria and no diff; low and medium stay on OA-3's order. |
| OA-10 #5 blocking `missing` or `weakened` holds plan readiness | EP44, T3 | covered. Holding fixture and release after scoped re-review; a non-blocking `weakened` does not hold, matching "at blocking severity". |
| OA-11 break-it probe | EP45, T5 (T6 consumes the result) | covered. Ladder, disposable copy, discard non-building mutants, caps with partial coverage, survivors as evidence, rung recorded, zero model calls. Proof gap is MINOR (N5): the no-affected-test-command trigger is not in the evidence cell. |
| OA-12 affected-test ladder | EP46, T5 | weakened. See N3. |
| OA-13 report readers | EP47, T5 | covered. JUnit XML and TRX; selected/passed/failed/skipped; missing, empty, or unreadable → `unknown`, never `passed`; zero-selected is in the evidence. Exit status alone stays non-proof through that rule plus T5's existing zero-selected rejection. |
| OA-14 flake isolation | EP48, T6 (T5 records the observation) | covered. One re-run of only the failing tests, same revision and environment; pass → `flaky`, no cycle, visible finding, still blocks until its own run passes; second failure charges a cycle. |
| OA-15 defect classes | EP49, T6 | covered. Per finding, per project; top five within 300 tokens; cap recorded under EP40. Store choice is a bounded investigation of an existing runner SQLite store outside the project. |
| OA-16 track record | EP50, T6 records, T5's change-risk reads the snapshot | covered. Snapshot determinism, a worse record raises the tier, no-history default is recorded. |
| OA-17 leftovers | EP51, T6 | weakened. See N4. |

No obligation in this set is missing or double-owned. OA-10 #2, #4, and #5 are one row each (EP42–EP44). Items 1 and 3 correctly have no row.

## Language neutrality

Checked against `runner-v2/src/lsp-client.ts`, `language-provider-router.ts`, `durable-process-store.ts`, and the `managed-process-*` files (contracts, record, tools, transport, history, supervisor, job host). `runtime-router.ts:189` is the author-exclusion loop inside `selectVerifier`; the Architect identity is excluded at lines 186–188. Today's `selectVerifier` returns `unavailable` when no distinct model matches. It does not yet return `fresh_context`. That matches the plan: packet R1 of `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md` is what adds the fallback.

**OA-11.** The safe floor is recorded `not_available`, not a pass. A mutant that does not build is discarded, not counted as caught. Early stop records partial coverage. Survivors are reviewer evidence, not blockers. The built-in rung names the C family (C, C++, C#, Java, JavaScript, TypeScript, Go, Rust, Kotlin, Swift) and the Python family, with a comment- and string-aware lexer, on changed lines only. Nothing in the rung is a JavaScript-only silent success. T5's evidence requires a non-JavaScript C-family fixture and a Python fixture. T8 names a C# TRX project, a C/C++ CMake project reporting JUnit through `ctest`, and an unknown-language fixture that must land on the safe floor. A missing host toolchain is a recorded host-gated skip, never a pass. T8's two named projects are both C-family; the Python-family proof is the T5/EP45 fixture, not the T8 sentence (N5).

**OA-12.** The safe floor in the text is the full suite, and the row says the result is never narrower than what the rung justifies. Widening (build configuration, lockfile, shared header, generated code, unknown file type) steps down to the module graph, or the full suite when no module graph exists. The ladder text is not JavaScript-only: npm workspace, `.csproj`/solution, CMake, Cargo, Go module, Maven/Gradle. Rung 2 points at the real generic LSP client. `LspClient` speaks to a configured language-server command. `LanguageProviderRouter.references` exists. When no provider matches, `unsupported()` returns `{ status: "unsupported_language", results: [] }` (`language-provider-router.ts` around lines 191–196 and 633–635). An empty `results` array is not, by itself, "no tests reference this symbol." EP46's fixtures never feed that status. That is N3.

**OA-13.** The safe floor is `unknown`, never `passed`. The readers are format readers: JUnit XML (the amendment's Java, gtest, ctest, pytest, jest-junit, cargo-nextest, go-junit-report set) and TRX (`dotnet test`). A C# or C++ run is not parsed as Jest. T8 requires one TRX fixture and one `ctest` JUnit fixture. Missing toolchain: host-gated skip, never a pass.

**OA-17.** Process identity is language-neutral and OS-neutral: `ManagedProcessRecord` is pid, command, cwd, and status; `DurableSubprocessRecord` is owner, fencing token, state, and cleanup. `outcome_unknown` / uncertain process identity already exists in the durable store. That supports "do not kill what you cannot prove." It does not support finding arbitrary temporary files. See N4.

## Conflicts, placement, cross-program

**EP21 / EP22 / duplicate critics.** No conflict. OA-10 #1 and #3 stay narrowed: one combined review, no low-tier skip. High-tier depth is the stored risk reason EP21 already required. OA-10 #2 does not fight EP22. EP42's order is: record this reviewer's view of the fix first, then receive the prior findings and check each is resolved. That is a fix-delta re-review with a blind first turn, not a second critic and not a re-read of unchanged input. Section 8 still says a fix review "examines changed code/findings" in one phrase; EP42 is the operative order.

**EP32.** Consistent with T9 for the answer path, as in the I1 row. N1 is the remaining complement.

**Token economy (OA-6).** OA-15's injection is capped at five classes and 300 tokens and is recorded under EP40. T7 surfaces purpose and token cost through the existing manifests and usage projection. T8 reports tokens per gate. The break-it probe is specified as zero model calls. No new unaccounted pass was added.

**Placement.** T5's file rule still forbids scheduler, factory, and integration edits. OA-11, OA-12, OA-13, and the OA-14 observation live in T5 modules (`change-risk.ts`, `affected-tests.ts`, report readers, the probe). OA-10, the OA-14 charge, OA-15, OA-16, and OA-17 live in T6, which runs after T4 and T5. T4's base is accepted T9; T5's stated base is accepted T3; Lane B's card forbids scheduler, shared contracts, factory, and lockfile. File ownership still separates the lanes. The contradiction is when T5 may start (B-R2), not which files it may write.

**Cross-program.** A controller can find the R1 dependency. BP1's entry waits for the agent-capability program. T1 inspects the reviewer-independence fallback. T6 names `RuntimeRouter.selectVerifier` and "agent-capability R1" for the fresh-context fallback. R1 in the agent-capability plan (AC-24) is the router change plus empty sessions for the verifier and plan-critic runtimes. T6 still has to open the deliverable reviewer's own empty session; the plan says that. T9 does not (N2).

## Findings

### BLOCKING

**B-R2. I3 is not fixed: BP4's entry, T5's start rule, and the progress registry disagree.**

Location: plan section 4, BP2 exit and the BP3/BP4 entry cells; the paragraph that begins "Only parallel delivery lane"; T3 validation sentence "BP2 unlocks only a reviewed executable plan"; section 9 cards for T4, T5, T9, and Lane A; `progress.md` current-revision registry and queue.

Why: r1 required one schedule. Revision 2 wrote both. The phase table unlocks BP4 only when BP2 exits, and BP2's exit requires the answer path as well as the reviewed plan, so T5 waits for accepted T9. The lane paragraph says T5 does not wait, because T5 and T9 share no file, and Lane B's base is accepted T3. The T5 card and the progress registry follow that second rule ("None before T3"). The progress queue's arrow (`T3 → T9 → (T4 || T5)`) follows the first rule, with a parenthetical that follows the second. T3's own exit sentence still mentions only the reviewed plan. A controller can hold Lane B for T9 or start it at T3 and be obeying a current sentence either way.

Fix: Choose one start rule and make the phase-table entry, the lane paragraph, T3's exit sentence, the T5 card, and both progress lines say it. The file split already supports T5 starting at accepted T3 while BP2's completion (both paths) stays the definition of BP2 being done. If the chosen rule is instead "T5 waits for T9," delete "T5 does not wait."

### IMPORTANT

**N1. Triage `clarify` is outside planning state, so T3's command refusal does not cover it.**

Location: T3 OA-7 step and EP41. T9 records `clarify` as a durable triage decision and routes it through `ask_user`.

Why: The predicate is planning state only when triage is absent, or triage is `build` and no plan is ready. A recorded `clarify` makes the predicate false, before any plan exists and before the user has answered. T3 refuses Architect command execution only inside planning state. T9 admits it for `answer`. `clarify` is in neither bucket. The agent-capability program grants the Architect command execution. A denylist written exactly as T3 states it admits those commands during the pause. That is still pre-plan work, which is the situation OA-7 keeps read-only. The answer path remains correctly outside the predicate, and the before-triage case is covered. This is a hole in the complement, not a failure of those two cases.

Fix: Treat every durable triage value other than `answer` as planning state until a ready plan exists, or add an explicit refusal while triage is `clarify`. Add the admission negative next to the before-triage and `build` negatives.

**N2. The loosened OA-3 rule is proved for the deliverable reviewer and not for the opt-in answer reviewer.**

Location: EP37 (tasks: T6 only). T9's last step. Relationship bullet that lists the opt-in answer reviewer.

Why: The owner required the same rule everywhere. T6 calls `selectVerifier`, records `distinct_model` or `fresh_context`, and proves the fresh session with a sentinel. T9 says only "select the opt-in answer reviewer by the OA-3 rule." It does not require a new session, an empty event list, or the sentinel. A same-model answer review can record the label and still see another session. Coverage review is in better shape: T3 states the rule and EP33 already requires an empty event list for every coverage derivation. EP37's independence-value fixture still does not include T3. R1 covers the verifier and the plan critic, not the answer reviewer.

Fix: Add T9 to EP37. Require the answer reviewer's fresh-context path to be a new session whose event list is empty, with the same sentinel test. Point T9 at `selectVerifier` rather than a second selector.

**N3. An unavailable language server can be recorded as a narrowed affected-test set.**

Location: EP46 and the T5 OA-12 step. `language-provider-router.ts` `references` / `unsupported()`.

Why: The ladder's second rung is this client. When no provider matches a file, the router returns status `unsupported_language` and an empty result list. EP46 says the outcome is never narrower than justified, and it steps down to the full suite when no module graph exists. It does not say that `unsupported_language`, a failed language server, or an impact tool that is not configured is a failed rung rather than a successful empty selection. The named fixtures are per rung when the rung works (npm, `.csproj`, CMake), plus widening triggers. A C#, C++, Java, Python, Go, or Rust tree with no language server configured can take the empty list as "no affected tests." T5's zero-selected rule would then refuse to call that run green; it would not restore the full-suite floor. The amendment's rule is the floor, not a false red.

Fix: State that a missing, failed, or `unsupported_language` higher rung steps down and records the lower rung. Add a fixture whose `references` result is `unsupported_language` with an empty list, and assert the recorded rung is the module graph or the full suite, not an empty selection.

**N4. OA-17's temp-file half is assigned to process stores that do not inventory temp files.**

Location: T6 OA-17 step and EP51. `managed-process-contracts.ts` `ManagedProcessRecord`. `durable-process-store.ts` `DurableSubprocessRecord`. `execution-safety-contracts.ts` `ProcessCleanupStatus` and `ProcessOutputDisposition`.

Why: Those records can show a process the runner started that is still alive, and they track that process's output streams and cleanup status. Ownership is pid, owner id, and fencing token. That is the right mechanism for the process half, and it is the same for every language. They do not list temporary directories the runner created. `mkdtemp` call sites (factory, execution host, git preflight, capability snapshots, Windows probes) are not fields on these records. EP51's "temp-file fixtures" can be satisfied by cleaning stdout/stderr paths while a disposable mutation copy or other runner temp directory outside the workspace is never seen. Unseen files are not "uncertain ownership"; they are omitted. The safe rule (retain and report what you cannot prove; never delete on a guess) has nothing to attach to if discovery only walks the process store.

Fix: Separate the two searches in T6 and EP51. Processes: the existing ownership records. Temp files: a creation record written when the runner creates a directory outside the workspace, including the OA-11 disposable copy. Clean only paths on that record. Anything found another way with unproven ownership is retained and reported.

### MINOR

**N5. Two proof details and two stale eligibility sentences.**

1. EP45's evidence sends an unknown language to `not_available` and does not mention the amendment's other trigger, "no affected-test command." T8's language sentence names C# and C/C++, both C-family, and does not name the Python-family fixture EP45 already requires. Add the no-command case to EP45, and name a Python fixture in T8 or state that EP45's Python fixture is the integrated proof for that family.
2. Plan section 7 ("no execution task is eligible before verified P6/P6.5") and section 10 ("Implementation still requires verified P6/P6.5 prerequisites") omit the agent-capability program. BP1, D1, T1, the Lane A card, and the progress current revision include it. Label or update those two sentences so a controller using section 7 or section 10 does not start T1 early.

### Categories with no finding

- B1, B2, B3, I2, and M1–M4 are fixed at the sites r1 named.
- I1's three asked properties hold (evaluable predicate, before triage, EP32 consistent with T9).
- OA-9: D3 does not block.
- OA-10 #1 and #3 have no row, matching the owner. #2, #4, and #5 each have one row and a real route.
- OA-11, OA-13, OA-14, OA-15, and OA-16 are covered. OA-15's cap is accounted under EP40.
- EP21, EP22, the section 1 duplicate-critic rule, and OA-6 do not conflict with the new rows. OA-10 #2 sequences the fix-delta re-review; it does not add a critic.
- T5 still does not take scheduler, factory, or integration files. T4 and T5 remain different file sets. The R1 dependency is stated at BP1, T1, and T6.
- Code citations checked: `runtime-router.ts:189` is the author loop; the LSP client and language-provider router exist and are generic; the process stores exist and plausibly support the process half of OA-17.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking condition:

1. **B-R2 (I3).** Section 4, T3's BP2 exit sentence, the section 9 cards, and `progress.md`'s registry and queue do not describe one start rule for T5. Revision 2's claim that I3 is fixed is not true until those sentences agree.

N1–N4 are required before the new gates behave as the amendment states. They are not the blocking condition above. N5 should be corrected in the same edit.
