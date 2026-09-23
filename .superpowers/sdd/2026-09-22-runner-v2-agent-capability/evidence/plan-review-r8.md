# Independent re-review — plan revision 9 (A4, A5, AC-7, AC-25, D6.7–D6.8)

Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `docs/agent-capability-and-change-critique`. Previous review `plan-review-r7.md` reused as clean outside this scope. Code cited is current `runner-v2/src`, not the plan's prose.

## STEP 2 — obligations (from SOURCE, before the plan)

Written from `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` D6 items 1–8, AC-7, AC-17, and AC-25 only.

**D6.1 / AC-7.** One tool, `write_project_doc(path, content, summary)`. Admitted targets are `docs/project/**` plus the marked `AGENTS.md` section and the marked `CLAUDE.md` pointer. `..`, absolute paths, links, and any other location are refused in the tool and again at the durable append boundary.

**D6.2.** The same tool writes the Architect's marked section of `AGENTS.md` (created if absent) and a one-line marked pointer in `CLAUDE.md` to `AGENTS.md`. The runner splices only between its markers. Text outside the markers never changes. The section says what the folder holds, how to read it first, and how to update it.

**D6.3.** A template the Architect fills and keeps current: `docs/project/README.md`, `STATE.md`, `specs/`, `plans/`, `decisions.md`, `evidence/`.

**D6.4 / AC-17.** The runner commits the file on the integration branch with an Architect author and trailer. It does not write the user's working folder. No task, change set, worker session, or model call. The project receives the documents at handoff, with the code. The next build reads them from the project.

**D6.5 / AC-17.** Workers do not write `docs/project/**`. A worker change set that touches it is refused at integration on the existing conflict path, and the paths are named.

**D6.6.** Documents do not satisfy gates. Acceptance still needs recorded evidence.

**D6.7 / AC-25.** A new run, including `plan_only`, cannot complete or hand off until `docs/project/STATE.md` was written after the run's latest integrated change (for `plan_only`, at any point in the run) and the tree at that write holds `docs/project/README.md`, the marked `AGENTS.md` section, and the marked `CLAUDE.md` pointer. Runs created before this change are exempt.

**D6.8.** A document commit changes only `docs/project/**` and the marked sections, so it does not change what the verifier checked. The verified revision stays verified. Handoff delivers that revision plus the document commits on top.

## A5-1 .. A5-8

| ID | Status | Severity if open | Trace |
|---|---|---|---|
| A5-1 | FIXED | — | The tool `execute` path is already `async` and awaited. Non-readonly tools run one at a time (`agent-loop.ts:444-459`). `complete_run` rebuilds the projection from the store when it runs (`architect-tools.ts:1542-1552`). A handler in the `build-runtime.ts` wiring (A5 owns that file) can `await` `projectDocs.commit` and append `project_doc.committed` before it returns, so a later `complete_run` in the same `runArchitect` invocation sees the commit. Same model message is impossible if both calls are lifecycle tools (`agent-loop.ts:949-955`, loop exit at `:481`); the packet's same-turn acceptance test is what forces `write_project_doc` to stay inside the loop. Recovery placed immediately after the `completed` / `paused` returns (`build-runtime.ts:584-585`) runs before every later Architect call in `stepOnce`, including completion (`:827-833`) and the final-verification completion call (`:865-875`, reached from `:800`). The empty-log Architect call at `:578-580` is before that site and cannot be holding a pending document request. `:837` is correctly rejected as the apply site: both completion returns happen above it. |
| A5-2 | FIXED | — | Not calling `advanceIntegrationRevision` (`scheduler-store.ts:2971-3035`) leaves `projection.integrationRevision` on the verified commit, so final verification stays `current`. `integrate`'s cherry-pick success path commits onto worktree HEAD and returns that new HEAD (`integration-manager.ts:532-572`). A following task integration therefore already contains the document commits; clearing the tip at that transition is right for this path, and `advanceIntegrationRevision` then makes the new HEAD the canonical revision. `project.handoff_selected` is the comparison that sees live HEAD: `descriptor` / `applyToProject` return `this.revision` (`integration-manager.ts:188-208`, `:578+`), and the reducer rejects anything other than `projection.integrationRevision` (`scheduler-store.ts:2777-2783`). Accepting the document tip there, and only there plus the readiness currency test (`:876-878`), lets handoff after `STATE.md` succeed while `current.targetRevision === integrationRevision` stays true. Other `integrationRevision` comparisons were checked and do not need the tip. Verifier request binding (`scheduler-store.ts:3555-3573`), risk binding (`:3084`), generation creation (`:3232`), verdict staleness (`:3682`), `buildNativeVerifierInspectionRequest` (`native-build-factory.ts:2591-2599`), and `isCurrentGeneration` (`build-runtime.ts:1371`) all compare records to the projection revision, which this rule does not move. `native-build-manager.ts:555` re-enters readiness and does not compare HEAD. Observability marks a generation current when its target equals `projection.integrationRevision` (`build-observability.ts:449`), which remains true. Widening those sites to accept the tip would verify the document commit; D6.8 forbids that. |
| A5-3 | NOT FIXED | BLOCKING | The stamp is specified inside `configureRunPolicy` (`build-runtime.ts:1560-1577`) and only when the event log is empty. The constructor calls `initializeRun()` and then `configureRunPolicy()` (`:301-302`). On a brand-new run `initializeRun` appends `run.initialized` before returning (`:1376-1402`). `configureRunPolicy` therefore always observes a non-empty log. The same paragraph says a non-empty log without the stamp is legacy and is never stamped later. Every new run takes that branch. AC-25 never binds. The crash-safety claim (stamp, then `run.policy_configured`, so a crash between them cannot look legacy) assumes the stamp is the first event. `run.initialized` is already first, so a crash after initialization and before a stamp is exactly a non-empty unstamped log, which the rule freezes as legacy. |
| A5-4 | FIXED | — | `buildCompletionReadiness` returns at `scheduler-store.ts:852-855` for `plan_only` after a plan-revision check and before any document check. `project.handoff_requested` skips `assertBuildCompletionReady` for that policy (`:2733-2738`). `project.handoff_selected` does call it (`:2764`) and would succeed with no `STATE.md`. The packet runs the AC-25 check on that early return, with "any `STATE.md` commit" for `plan_only`, and makes `handoff_requested` call the same check. `complete_run` already goes through `buildCompletionReadiness` (`architect-tools.ts:1552`). `run.completed` (`scheduler-store.ts:2719`) and `handoff_selected` share that function, so they pick up the same check. "For `plan_only`, any such commit" matches AC-25. The existing `planRevision <= 0` rejection stays, because the packet says the document check runs first on that return, not instead of it. |
| A5-5 | FIXED | — | Lexical refusal stays in the tool and the reducer. Link refusal is `lstat` inside `commitProjectDocuments` on the integration worktree, which is the tree that can contain the link. On Node v24.18.0, `lstat` of a Windows junction reports `isSymbolicLink() === true` (checked: junction under `%TEMP%`, `isSymbolicLink true`, `isDirectory false`). The repository already rejects containment roots that way (`verification-workspace.ts:333-336`). Refusing `isSymbolicLink()` at each existing path component under `docs/project/` covers both symbolic links and junctions. The pure reducer still cannot see them; the packet no longer asks it to. |
| A5-6 | FIXED | — | A4's prompt requires the entry point at the start of a new run, carried from A5's templates, and requires `STATE.md` last. A5 exports the layout, the `AGENTS.md` section body, and the one-line `CLAUDE.md` pointer `See AGENTS.md for this project's documentation rules.` The runner does not invent later document content; it splices markers and commits. Entry-point facts are returned from `commitProjectDocuments` for the committed tree and stored on `project_doc.committed`. AC-25 requires those facts on the latest `STATE.md` commit, which is "the tree at that write." |
| A5-7 | FIXED | — | `STATE.md` section 2 is one action: this revision-9 re-review, scoped to A4, A5, AC-7, AC-25, and D6.7–D6.8. After a sufficient verdict the next action is A0. It no longer dispatches the revision-7 review. |
| A5-8 | FIXED | — | Lane B's note lists the Architect documentation folder. It does not say "the new task kind." The launch card says A5 creates no task kind. |

## New findings

### BLOCKING

None beyond A5-3.

### IMPORTANT

**N1. Clearing the document tip on every integrated transition is wrong for two `integrate` returns.**

- Location: plan A5 step 5 ("cleared when a task integrates, because `integrate` builds on HEAD"). Code: `integration-manager.ts:489-518` versus `:532-572`.
- Why: The cherry-pick success path does build on HEAD and returns `this.currentRevision`. `alreadyApplied` returns the stored applied ref when that ref is merely an ancestor of HEAD. `findIntegratedRevision` (`:1606-1633`) returns the matching cherry-pick commit, not HEAD. Recovery of `project_doc.requested` is specified at the top of `stepOnce`, before the integrating branch (`build-runtime.ts:704-731`). A pending document commit therefore lands on HEAD, and a retried `integrate` can then return the older applied ref. The reducer clears the tip and records that older hash. `descriptor()` still returns HEAD. `project.handoff_selected` rejects it, and final verification may be invalidated if `advanceIntegrationRevision` actually moves. The acceptance case "a document commit between two worker integrations" uses the cherry-pick path and still holds.
- Fix: Clear the tip only when the revision just recorded is HEAD, or is a descendant of the current tip. Do not clear it when `integrate` returns an ancestor.

**N2. A stamp that actually binds changes existing empty-store fixtures, and the plan does not say so.**

- Location: plan A5 step 6. Code: `runner-v2/test/build-runtime.test.ts:204-363`, `:521-523`, `:555-557`. The pre-seeded log at `:371-462` starts with `plan.created` and is genuinely legacy.
- Why: A5-3 as written never stamps, so these tests keep passing and AC-25 never runs. The crash-safe repair is to stamp when the constructor observes an empty log, before `initializeRun` appends `run.initialized`. That stamp is then on every `new BuildRuntime` with an empty store. The exact event lists at `:523` and `:557` omit `project_docs.policy_configured`. The plan-only test constructs that empty store, calls `complete_run` (`:312`) and `selectProjectHandoff` (`:354`), and expects completion with no documents. Pre-seeded logs stay exempt without an opt-out. An opt-out on the empty-store constructor would also exempt real new runs.
- Fix: Say in A5 that a fresh constructor log contains `project_docs.policy_configured` before `run.policy_configured`, that the exact-list assertions gain that event, and that the plan-only completion fixture must commit `STATE.md` and the entry point or it is no longer a new run. Do not add a test-only stamp opt-out.

**N3. The `AGENTS.md` template body is unnamed, so D6.2's three statements are not required.**

- Location: plan A5 step 8 and A4's prompt bullets. AC-25's fact check is existence of the marked section.
- Why: D6.2 says the marked section says what the folder holds, how to read it first, and how to update it. The packet quotes the `CLAUDE.md` pointer and names the layout files. It says `project-docs.ts` exports "the default `AGENTS.md` section body" and that A4 copies it into the prompt. Any marked body, including an empty one, makes the entry-point facts true. A new run can then complete without the section D6.2 requires.
- Fix: Put those three statements in the exported section body in the packet, and keep the runner from writing any other prose.

### MINOR

None.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

A5-1, A5-2, A5-4, A5-5, A5-6, A5-7, and A5-8 are fixed against the current runner. A5-2's handoff-after-`STATE.md` rule does not reopen final verification on the cherry-pick path, and the other `integrationRevision` comparisons correctly stay on the projection revision.

Blocking condition:

1. A5-3's empty-log stamp is unreachable. `initializeRun` appends `run.initialized` before `configureRunPolicy` reads the log, and a non-empty unstamped log is defined as legacy forever. New runs, including `plan_only`, are exempt, so AC-25 does not bind. The repair has to stamp a brand-new run before `run.initialized` is appended, leave any log that already had events unstamped, and name the empty-store fixture updates in N2. It must not treat "non-empty" as legacy when the only event is the `run.initialized` this constructor just wrote.
