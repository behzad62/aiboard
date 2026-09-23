# Independent re-review — plan revision 10 (A5 steps 5, 6, 8)

Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `docs/agent-capability-and-change-critique` at `6ba7d7ac`, tree clean. Previous review `plan-review-r8.md` reused as clean outside A5 steps 5, 6 and 8 and the acceptance and prove-red lines that mention them. Code cited is current `runner-v2/src` and `runner-v2/test`, not the plan's prose.

A5-3 is on repair cycle 2 of 3. N1, N2 and N3 are on cycle 1.

## Pre-read obligations (SOURCE, before the plan)

Written from `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` D6 items 2, 7 and 8, and AC-25 only.

**D6.2.** The same tool writes the Architect's marked section of `AGENTS.md` (created if absent) and a one-line marked pointer in `CLAUDE.md` to `AGENTS.md`. The runner splices only between its markers. Text outside the markers never changes. The section says what the folder holds, how to read it first, and how to update it.

**D6.7 / AC-25.** A new run, including `plan_only`, cannot complete or hand off until `docs/project/STATE.md` was written after the run's latest integrated change (for `plan_only`, at any point in the run) and the tree at that write holds `docs/project/README.md`, the marked `AGENTS.md` section, and the marked `CLAUDE.md` pointer. Runs created before this change are exempt.

**D6.8.** A document commit changes only `docs/project/**` and the marked sections, so it does not change what the verifier checked. The verified revision stays verified. Handoff delivers that revision plus the document commits on top.

What the four repairs must achieve:

- **A5-3.** A brand-new run, including `plan_only`, receives the policy stamp before any other scheduler event, so AC-25 binds. A log that already had events at construction stays unstamped and exempt. A crash cannot turn a new run into a legacy run.
- **N1.** A task integration clears the document tip only when the recorded revision is the new HEAD (or otherwise descends from the tip). `alreadyApplied` and `findIntegratedRevision` return an older applied ref; that return keeps the tip, so handoff still sees the document HEAD and final verification is not moved onto that ancestor.
- **N2.** The stamp lands on every empty-store `BuildRuntime`, so the fixtures that assert an exact event list or that complete and hand off a fresh `plan_only` run have to change with it. Pre-seeded logs stay legacy. No test-only opt-out.
- **N3.** The exported `AGENTS.md` section body contains D6.2's three statements, and the commit-time entry-point fact rejects a marked section that does not carry them.

## A5-3 / N1 / N2 / N3

| ID | Status | Severity if open | Trace |
|---|---|---|---|
| A5-3 | FIXED | — | The constructor calls `initializeRun()` then `configureRunPolicy()` (`build-runtime.ts:301-302`). `initializeRun` appends `run.initialized` only when `readRun` is empty (`:1376-1402`). `configureRunPolicy` (`:1560-1577`) always appends `run.policy_configured` and relies on the idempotency key. Reading once before `initializeRun` and appending `project_docs.policy_configured` only when that read is empty is reachable: nothing in the constructor appends before line 301. Crash after the stamp: the log is non-empty and already stamped, so the next construction does not stamp again and does not look legacy; `initializeRun` returns early and `configureRunPolicy` still writes policy. Crash before the stamp: the log is still empty and the next construction stamps. No other writer appends to a brand-new run's scheduler log before this constructor. `native-build-factory.ts` opens `SqliteSchedulerStore` at `:563` and does not append before `new BuildRuntime` at `:1151` (`ProcessRecoveryController`'s constructor does not append; `NativeArchitectRuntime.ensureInitialized` at `:420-441` runs only from `run()` at `:144`, after construction). `native-build-manager.ts` does not append scheduler events. `control-server.ts` `createRun` (`:362`) writes `run.created` on the run-supervisor store, a different log. `createHistorical` does not construct `BuildRuntime`. The reducer opening gate (`scheduler-store.ts:1560-1582`) currently rejects any first event other than `run.initialized`, `run.policy_configured`, or `plan.created`. Step 6 assigns that reducer to record the stamp as the first event, so the opening branch has to admit `project_docs.policy_configured` and return a projection. That is the same edit as "the reducer records the stamp." |
| N1 | NEW DEFECT | IMPORTANT | The ancestor rule is right and implementable, and it misfires on a third `integrate` return. `alreadyApplied` (`integration-manager.ts:489-508`) returns the stored applied ref after `merge-base --is-ancestor` against `HEAD`. `findIntegratedRevision` (`:1606-1633`) returns the matching cherry-pick commit, not `HEAD`, when later commits exist. Both are inside `serialized` (`:1676-1688`). `merge-base --is-ancestor` is already used there, so `isDescendantOfDocumentTip` can be computed before the lock releases. For those two returns the revision is an ancestor of a document tip that sits at `HEAD`, the fact is false, the tip stays, and `advanceIntegrationRevision` (`scheduler-store.ts:2186-2190`, `:2994`) no-ops when the hash equals the current canonical revision. That is the r8 case. The empty-commit return is not. `integrate` returns `this.revision` immediately when `changeSet.commits.length === 0` (`integration-manager.ts:479-486`). Workers produce that change set on `NoTaskChangesError` (`worker-runtime.ts:331-338`). After a document commit, `this.revision` is the document tip, so the plan's "HEAD / descendant of the tip" test is true (`merge-base --is-ancestor` treats a commit as its own ancestor) and the tip is cleared. `task.transitioned` to `integrated` still calls `advanceIntegrationRevision` with that hash. The canonical revision moves off the verified commit onto the document commit and, when a final-verification generation is current, invalidates it (`scheduler-store.ts:2996-3008`). D6.8 says the verified revision stays verified and document commits sit on top. The acceptance case only keeps the tip for an older applied ref. |
| N2 | FIXED | — | The named fixture edits match the tests. `runner-v2/test/build-runtime.test.ts:521-523` and `:555-557` are the only exact type lists that start from an empty store; both begin at `run.initialized` and gain `project_docs.policy_configured` at the front. `:371-462` appends `plan.created` before `new BuildRuntime`, and its exact list at `:455-462` starts with `plan.created`; leaving it unstamped is correct. `:204-363` is the only empty-store `BuildRuntime` that calls `complete_run` (`:312`) and `selectProjectHandoff` (`:354`) and expects completion. Requiring `STATE.md` plus the entry point there is the right fixture change. No test-only opt-out is stated. Other `new BuildRuntime` and `NativeBuildFactory` constructions were checked for an empty store followed by completion or handoff. `plan-critique-runtime.test.ts` builds empty runtimes and stops at critique or worker dispatch; its `complete_run` branch is not reached. `final-verification-completion.test.ts` pre-seeds `run.policy_configured` before the runtime. `native-build-manager.test.ts` and the control-server handoff route use fake runtimes or a pre-seeded scheduler. `control-server.test.ts` `:1275` constructs an empty `BuildRuntime` and looks up `run.initialized` by type (`:1324`); it does not complete or hand off, and a leading stamp does not fail that assertion. `native-architect-runtime.test.ts:447` asserts `run.initialized` as the first event of `NativeArchitectRuntime.run` on its own empty store, not of `BuildRuntime`. None of those need a fixture line in A5. |
| N3 | NOT FIXED | BLOCKING | The commit-time fact is implementable. `commitProjectDocuments` already runs inside `serialized` on the integration worktree and step 1 already returns entry-point facts of the committed tree, so it can read the spliced `AGENTS.md` section and test three lines. The rule does not satisfy D6.2, and it contradicts the template. Step 8 says the exported section body must contain the three statements (layout, the read-first sentence, the update sentence). The fact is true only when the marked section contains `<!-- aiboard:docs:holds -->`, `<!-- aiboard:docs:read-first -->`, and `<!-- aiboard:docs:update -->`, each followed by non-empty text. The body specification does not contain those marker lines. The same step says the runner never writes documentation content, so it will not insert the markers around the template. A4 copies the templates into the prompt verbatim. An Architect that writes that body leaves the fact false, and AC-25 never passes. An Architect that adds the three markers with any non-empty text (`x` / `y` / `z`) makes the fact true without the section saying what the folder holds, how to read it first, or how to update it. D6.2 requires those three statements. Non-empty text after a marker does not. |

## New findings

### BLOCKING

**N3, restated as the open defect.** The exported `AGENTS.md` body and the entry-point fact do not describe the same section.

- Location: plan A5 step 8. Acceptance line "an `AGENTS.md` section missing any of the three marker lines leaves the run not ready."
- Why: D6.2's three statements are required in the template and are not what the fact checks. The markers the fact checks are not in the template, and the runner is forbidden to write them. The happy path (write the template) fails AC-25. The path that passes the fact does not satisfy D6.2.
- Fix: Put the three marker lines in the exported section body, each followed by the statement step 8 already quotes (layout, one line per entry; the read-first sentence; the update sentence). Make the entry-point fact true only when each marker is followed by that statement. Keep the runner from writing any other prose.

### IMPORTANT

**N1, restated as the open defect.** Clearing the tip whenever the recorded revision is HEAD or a descendant of the tip treats a no-commit integration as a new canonical revision.

- Location: plan A5 step 5. Code: `integration-manager.ts:479-486` versus `:489-518` and `:1606-1633`; `scheduler-store.ts:2186-2190`.
- Why: The ancestor returns keep the tip, and that part is correct. The empty change set returns current HEAD. When HEAD is the document tip, the descendant fact is true, the tip is cleared, and `advanceIntegrationRevision` moves the canonical revision onto the document commit, invalidating a current final verification. D6.8 forbids that. The new acceptance case does not cover this return.
- Fix: Keep the tip, and do not advance the canonical revision, when the recorded revision is the current document tip or otherwise adds no task commit beyond it. The empty-commit return is that case. Ancestor returns stay as step 5 specifies.

### MINOR

None.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

A5-3 is fixed. The empty-log read sits before `initializeRun`, nothing else appends to a new run's scheduler log before the constructor, and the crash windows do not classify a stamped run as legacy. The reducer opening allow-list has to admit the stamp; step 6 already assigns that reducer the first event. N2 names the only empty-store completion fixture and the only exact lists that must gain the stamp. Pre-seeded logs, including the plan-only recovery at `build-runtime.test.ts:371-462`, stay legacy. No other empty-store `BuildRuntime` or native-factory test completes or hands off.

Blocking condition:

1. N3's entry-point fact and the exported `AGENTS.md` body do not match. The template step 8 requires does not contain the three marker lines the fact requires, the runner does not insert them, and non-empty text under those markers does not require D6.2's three statements. A template-faithful section never becomes ready.

Required with that repair, not a second blocking gate:

1. N1 must not clear the tip or advance the canonical revision when `integrate` returns the document tip through the empty-commit path (`integration-manager.ts:479-486`). Ancestor returns stay kept.
