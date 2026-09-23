# Independent re-review — plan revision 12 (A5 steps 5 and 8)

Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `docs/agent-capability-and-change-critique` at `edbb8ef6`, tree clean. Previous review `plan-review-r10.md` reused as clean outside A5 step 5, step 8, and the acceptance lines that mention them. Code cited is current `runner-v2/src`, not the plan's prose.

Revision 12 changes only the AGENTS.md fact (step 8), its acceptance line, the budget sentence, and the verdict banner. Step 5 is unchanged from revision 11 and was re-checked against the source.

The plan's budget line puts N3 on cycle 3 of 3. This review finds it sound, so it does not escalate.

## Pre-read obligations (SOURCE, before the plan)

Written from `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` D6 items 2 and 8 only.

**D6.2.** The same tool writes the Architect's marked section of `AGENTS.md` (created if absent) and a one-line marked pointer in `CLAUDE.md` to `AGENTS.md`. The runner splices only between its markers. Text outside the markers never changes. The section says what the folder holds, how to read it first, and how to update it.

**D6.8.** A document commit changes only `docs/project/**` and the marked sections, so it does not change what the verifier checked. The verified revision stays verified. Handoff delivers that revision plus the document commits on top.

What the two repairs must achieve:

- **N1.** An `integrate` return that adds no task commit beyond the document tip must not clear the tip and must not move the canonical revision, so a current final verification stays current. That includes the empty change set, which returns the tip itself (`integration-manager.ts:479-486`, from `NoTaskChangesError` at `worker-runtime.ts:331-338`). An older applied ref stays kept. A new task commit on top of the tip still clears the tip and advances as today. Handoff still delivers the verified revision plus the document commits. Recording the no-commit task at the canonical revision must stay safe for a later real integration, for handoff, and for final verification.
- **N3.** The exported `AGENTS.md` section body contains the three marker lines, each followed by D6.2's statement (what the folder holds, how to read it first, how to update it). Writing that body verbatim makes the commit-time entry-point fact true. A placeholder that does not say those three things leaves the fact false. The fact reads each statement only inside its own marker span. The runner still does not write documentation prose.

## N1 / N3

| ID | Status | Severity if open | Trace |
|---|---|---|---|
| N1 | FIXED | — | The three git relationships partition every integrated return. See the trace below. |
| N3 | FIXED | — | The fact is verbatim statement containment inside each marker's span. The r10 placeholders fail. |

### N1 trace

Classification runs only when a document tip exists. It compares the revision `integrate` returned, inside `serialized` (`integration-manager.ts:1676-1688`), with `git merge-base --is-ancestor`. `merge-base --is-ancestor` is true for a commit against itself, so the named `equal_to_tip` class is the equality case; `ancestor` and `strict_descendant` are the two proper directions. The parentheticals in step 5 name the usual source of each class. They are not a switch on which `return` ran. `alreadyApplied` and `findIntegratedRevision` are not always ancestors.

Integrated return paths:

1. **Empty change set** (`:479-486`) returns `this.revision`, which is `currentRevision` (`:188-192`). Step 1 updates `currentRevision` from `head()` when the document commit is made, and the tip is set only when that commit's parent is the canonical revision or the current tip. The returned hash is the tip. Class: `equal_to_tip`. Record at the canonical revision, keep the tip, do not advance.
2. **`alreadyApplied`** (`:489-508`) returns the stored ref after `merge-base --is-ancestor` against `HEAD`, or throws. **`findIntegratedRevision`** (`:1606-1633`) returns a commit on `baseline..HEAD`. The tip is on that same history: it is `HEAD`, or an ancestor of `HEAD`. Either hash is therefore `equal_to_tip`, a proper ancestor, or a strict descendant. The older applied ref, with later document commits at `HEAD`, is `ancestor`. A crash after a successful cherry-pick and `recordAppliedRef` (`:566-572`) but before `task.transitioned` (`build-runtime.ts:711-730`) comes back through `alreadyApplied` or `findIntegratedRevision` with the new commit, which is a strict descendant of the still-recorded tip. That class clears the tip and advances. It is not `ancestor` merely because of the function that found it.
3. **Cherry-pick success** (`:566-572`) returns the new `HEAD`, a child of the previous `HEAD`. With the tip at that previous `HEAD` or behind it, the class is `strict_descendant`.
4. **Conflict** (`:557-563`) returns `before` with `status: "conflict"`. `build-runtime.ts:719-722` records `integration_resolution`. `advanceIntegrationRevision` runs only for `status === "integrated"` (`scheduler-store.ts:2186-2190`). The tip is not cleared. No fourth integrated class is required.

An incomparable pair is not among these returns. Both hashes sit on the integration branch, and the tip is defined as document commits on that branch. Throws leave no transition and leave the tip in place.

`equal_to_tip` and `ancestor` put the **current canonical** hash in the `task.transitioned` payload. `advanceIntegrationRevision` (`:2971-3035`) returns at `:2994` when that hash is already the canonical, before it invalidates final verification (`:2996-3008`), build risk (`:3009-3021`), or the verifier (`:3022-3034`). The empty-change-set return can no longer move the verified revision onto the document commit.

The substitution can happen without editing the forbidden worker `integrationDriver` (`native-build-factory.ts:1075-1093`). That driver only forwards `result.integrationRevision` (`:1094-1098`). `build-runtime.ts` is the writer of the payload (`:711-728`) and holds `projection.integrationRevision`, the canonical. The ancestry check itself is on two immutable hashes, so it stays inside `serialized` as the plan requires. After a document commit, `IntegrationManager.revision` is `HEAD` (the tip), not the canonical; the canonical used in the payload is the projection field, which document commits do not advance.

That recording is safe:

- The only reader of the task's `integrationRevision` is the advance at `scheduler-store.ts:2187-2189`. No prompt, handoff, observability, or verifier path reads the task field. Storing the canonical hash there does not change a later decision.
- A later real task commit is a strict descendant of the tip. The payload is the new `HEAD`, the tip clears, and the canonical advances, which invalidates verification because the tree under test changed. `assertCompatible` (`integration-manager.ts:1552-1566`) compares the change set's baseline with `this.revision` (integration `HEAD`), not with the task's stored hash, so a worker based on the tip or on the canonical still applies.
- Handoff delivers the tip. `applyToProject` diffs `baseline..this.revision` (`:612-618`) and `descriptor` reports `this.revision` (`:199-208`), which is `HEAD`. After a document commit that is the tip. `project.handoff_selected` (`scheduler-store.ts:2777-2783`) is widened to accept that tip as well as the canonical. Readiness currency (`:876-878`) is widened the same way and stays true because the verification target is still the canonical (`build-runtime.ts:817-820`). The risk and verifier arms (`scheduler-store.ts:1019`, `:1028`) compare against the canonical too; they stay current without being widened, because this repair does not move the canonical.
- A duplicate transition cannot disagree with an earlier hash. `stepOnce` integrates only a task still in `integrating` (`build-runtime.ts:704-705`). The first successful append leaves `integrated`, and the idempotency key `integration:${changeSetId}:integrated` rejects a different payload (`sqlite-scheduler-store.ts:113-126`). A crash before that append has no prior key.

The acceptance lines cover the empty return, the older applied ref, an unchanged final verification, a successful handoff, and a real task commit that clears the tip.

### N3 trace

Step 8 keeps the three marker lines in the exported body, each followed by its statement: `<!-- aiboard:docs:holds -->` then the six layout lines, `<!-- aiboard:docs:read-first -->` then "Before any work on this project, read `docs/project/README.md` and `docs/project/STATE.md`.", `<!-- aiboard:docs:update -->` then "Keep specs, plans and decisions current as they change; update `STATE.md` last, with where things stand and the next action." A4 (`:229-235`) puts that body in the Architect prompt verbatim. Writing the body verbatim therefore puts each statement in its own span, and the fact is true.

The fact is true only when the marked Architect section (between `<!-- aiboard:architect:start -->` and `<!-- aiboard:architect:end -->`, step 1) contains all three docs markers, and the span after each marker — ending at the next marker or at the end of that Architect section — contains that marker's statement verbatim after whitespace normalization. Holds must contain every `DOCS_LAYOUT_LINES` entry. Read-first must contain `DOCS_READ_FIRST_SENTENCE`. Update must contain `DOCS_UPDATE_SENTENCE`. Extra prose may surround a statement inside its span. A statement under the wrong marker is outside that span and does not count.

That closes both r10 holes. The token-only section (the six names, the two `docs/project` paths, `STATE.md`, and `last`) does not contain either quoted sentence, so the fact is false even before the layout-line check. `x` / `y` / `z` contains neither the sentences nor the layout lines. Moving the update sentence under `read-first` leaves the update span without it. Dropping one layout line leaves the holds span without that `DOCS_LAYOUT_LINES` entry. A suffix after `<!-- aiboard:docs:update -->` is outside the holds and read-first spans, so it cannot satisfy them.

`commitProjectDocuments` runs inside `serialized` on the integration worktree and step 1 already returns entry-point facts of the committed tree. The check is a read of the spliced `AGENTS.md` plus the span test against the constants exported from `project-docs.ts`. Both files are writable in this packet. The check is implementable at commit time in `integration-manager.ts`. The runner still does not write the prose.

The acceptance line matches the mechanism: verbatim text passes, including with extra prose around each statement; a missing marker, `x` / `y` / `z`, the token-only section, the update sentence under the wrong marker, and one missing layout line each leave the run not ready.

## New findings

### BLOCKING

None.

### IMPORTANT

None.

### MINOR

None.

## Verdict

**PLAN COVERAGE VERIFIED**

N1 remains fixed. Every integrated return is `strict_descendant`, `equal_to_tip`, or `ancestor` of the tip; conflict does not advance. The empty change set and an older applied ref are recorded at the canonical revision, the tip stays, and `advanceIntegrationRevision` does not invalidate a current final verification. A cherry-pick on top of the tip, including one rediscovered by `alreadyApplied` or `findIntegratedRevision`, still advances. Handoff reports and applies integration `HEAD`, which is the tip, and the handoff check accepts it. Nothing else reads the task's stored integration revision.

N3 is fixed. The exported template carries the three statements in marker spans, and the fact is true only when each span contains its statement verbatim. The placeholders that passed the revision 11 token check fail. The check can run in `commitProjectDocuments` on the committed tree.

No blocking conditions.
