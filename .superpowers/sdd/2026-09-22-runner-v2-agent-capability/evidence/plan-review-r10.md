# Independent re-review — plan revision 11 (A5 steps 5 and 8)

Read-only. Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`, branch `docs/agent-capability-and-change-critique` at `15ecb5bd`, tree clean. Previous review `plan-review-r9.md` reused as clean outside A5 step 5, step 8, and the acceptance lines that mention them. Code cited is current `runner-v2/src`, not the plan's prose.

N1 and N3 are on repair cycle 2 of 3.

## Pre-read obligations (SOURCE, before the plan)

Written from `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` D6 items 2 and 8 only.

**D6.2.** The same tool writes the Architect's marked section of `AGENTS.md` (created if absent) and a one-line marked pointer in `CLAUDE.md` to `AGENTS.md`. The runner splices only between its markers. Text outside the markers never changes. The section says what the folder holds, how to read it first, and how to update it.

**D6.8.** A document commit changes only `docs/project/**` and the marked sections, so it does not change what the verifier checked. The verified revision stays verified. Handoff delivers that revision plus the document commits on top.

What the two repairs must achieve:

- **N1.** An `integrate` return that adds no task commit beyond the document tip must not clear the tip and must not move the canonical revision, so a current final verification stays current. That includes the empty change set, which returns the tip itself (`integration-manager.ts:479-486`, from `NoTaskChangesError` at `worker-runtime.ts:331-338`). An older applied ref stays kept. A new task commit on top of the tip still clears the tip and advances as today. Handoff still delivers the verified revision plus the document commits. Recording the no-commit task at the canonical revision must stay safe for a later real integration, for handoff, and for final verification.
- **N3.** The exported `AGENTS.md` section body contains the three marker lines, each followed by D6.2's statement (what the folder holds, how to read it first, how to update it). Writing that body verbatim makes the commit-time entry-point fact true. A placeholder that does not say those three things leaves the fact false. The runner still does not write documentation prose.

## N1 / N3

| ID | Status | Severity if open | Trace |
|---|---|---|---|
| N1 | FIXED | — | The three git relationships partition every integrated return. See the trace below. |
| N3 | NOT FIXED | BLOCKING | The template now contains the markers and the three sentences, so the verbatim body passes. The fact does not require those sentences. Token placeholders pass. |

### N1 trace

Classification runs only when a document tip exists. It compares the revision `integrate` returned, inside `serialized` (`integration-manager.ts:1676-1688`), with `git merge-base --is-ancestor`. `merge-base --is-ancestor` is true for a commit against itself, so equality has to be tested first. The parentheticals in step 5 are the r9 examples, not a switch on which `return` ran. `alreadyApplied` and `findIntegratedRevision` are not always ancestors.

Integrated return paths:

1. **Empty change set** (`:479-486`) returns `this.revision`, which is `currentRevision` (`:188-192`). Step 1 updates `currentRevision` from `head()` when the document commit is made, and the tip is set only when that commit's parent is the canonical revision or the current tip. The returned hash is the tip. Class: `equal_to_tip`. Record at the canonical revision, keep the tip, do not advance.
2. **`alreadyApplied`** (`:489-508`) returns the stored ref after `merge-base --is-ancestor` against `HEAD`, or throws. **`findIntegratedRevision`** (`:1606-1633`) returns a commit on `baseline..HEAD`. The tip is on that same history: it is `HEAD`, or an ancestor of `HEAD`. Either hash is therefore `equal_to_tip`, a proper ancestor, or a strict descendant. The r9 retry (an older applied ref, with later document commits at `HEAD`) is `ancestor`. A crash after a successful cherry-pick and `recordAppliedRef` (`:566-572`) but before `task.transitioned` (`build-runtime.ts:711-730`) comes back through `alreadyApplied` or `findIntegratedRevision` with the new commit, which is a strict descendant of the still-recorded tip. That class clears the tip and advances. It must not be forced into `ancestor` because of the function that found it.
3. **Cherry-pick success** (`:566-572`) returns the new `HEAD`, a child of the previous `HEAD`. With the tip at that previous `HEAD` or behind it, the class is `strict_descendant`.
4. **Conflict** (`:557-563`) returns `before` with `status: "conflict"`. `build-runtime.ts:719-722` records `integration_resolution`. `advanceIntegrationRevision` runs only for `status === "integrated"` (`scheduler-store.ts:2186-2190`). The tip is not cleared. No fourth integrated class is required.

An incomparable pair is not among these returns. Both hashes sit on the integration branch, and the tip is defined as document commits on that branch.

`equal_to_tip` and `ancestor` put the **current canonical** hash in the `task.transitioned` payload. `advanceIntegrationRevision` (`:2971-3035`) returns at `:2994` when that hash is already the canonical, before it invalidates final verification (`:2996-3008`), build risk (`:3009-3021`), or the verifier (`:3022-3034`). The empty-change-set return can no longer move the verified revision onto the document commit.

That recording is safe:

- The only reader of the task's `integrationRevision` is the advance at `scheduler-store.ts:2187-2189`. No prompt, handoff, observability, or verifier path reads the task field. Storing the canonical hash there does not change a later decision.
- A later real task commit is a strict descendant of the tip. The payload is the new `HEAD`, the tip clears, and the canonical advances, which invalidates verification because the tree under test changed. `assertCompatible` (`integration-manager.ts:1552-1566`) compares the change set's baseline with `this.revision` (integration `HEAD`), not with the task's stored hash, so a worker based on the tip still applies.
- Handoff delivers the tip. `applyToProject` diffs `baseline..this.revision` (`:612-618`) and `descriptor` reports `this.revision` (`:199-208`), which is `HEAD`. After a document commit that is the tip. `project.handoff_selected` (`scheduler-store.ts:2777-2783`) accepts that tip as well as the canonical. Readiness currency (`:876-878`) stays true because the verification target is still the canonical. The risk and verifier arms in the same function (`:1019`, `:1028`) compare against the canonical too; they stay current without being widened, because this repair does not move the canonical.
- A duplicate transition cannot disagree with an earlier hash. `stepOnce` integrates only a task still in `integrating` (`build-runtime.ts:704-705`). The first successful append leaves `integrated`, and the idempotency key `integration:${changeSetId}:integrated` would throw on a different payload (`sqlite-scheduler-store.ts:113-126`). A crash before that append has no prior key. The worker `integrationDriver` (`native-build-factory.ts:1075-1093`) only forwards `integrationRevision`; substituting the canonical hash inside `serialized` before return is enough, and that driver stays untouched.

The acceptance lines cover the empty return, the older applied ref, an unchanged final verification, a successful handoff, and a real task commit that clears the tip.

### N3 trace

Step 8 now puts the three marker lines in the exported body, each followed by the sentence step 8 already quotes. A4 (`:229-233`) puts that body in the Architect prompt verbatim. `commitProjectDocuments` runs inside `serialized` on the integration worktree and step 1 already returns entry-point facts of the committed tree, so the check can read the spliced `AGENTS.md` section between `<!-- aiboard:architect:start -->` and `<!-- aiboard:architect:end -->` and test the text after each docs marker. The content check is implementable at commit time in `integration-manager.ts`. The runner still does not write the prose.

Writing the template verbatim makes the fact true. The holds list contains `README.md`, `STATE.md`, `specs/`, `plans/`, `decisions.md`, and `evidence/`. The read-first sentence contains `docs/project/README.md` and `docs/project/STATE.md`. The update sentence contains `STATE.md` and the word `last`.

The named acceptance placeholder does not pass. A section whose text after the three markers is `x`, `y`, and `z` fails all three token lists.

A different placeholder passes. The fact is true when the span after each marker contains only:

- holds: the six layout names, with no statement of what the folder holds beyond the names;
- read-first: `docs/project/README.md` and `docs/project/STATE.md`, with no instruction to read them first;
- update: `STATE.md` and the word `last`, with no instruction to keep specs, plans, and decisions current or to record status and the next action.

That section does not say how to read the folder first or how to update it. D6.2 requires both. r9 required the fact to be true only when each marker is followed by the statement step 8 quotes. The token lists are not those statements. The plan's own claim that placeholders cannot pass is false for this text. The acceptance line does not catch it.

The plan also does not bind "the text after each" to the span that ends at the next marker. A suffix search lets tokens that appear only after `<!-- aiboard:docs:update -->` satisfy the holds and read-first checks, so `x` and `y` under the first two markers still pass.

## New findings

### BLOCKING

**N3, restated as the open defect.** The entry-point fact does not require D6.2's three statements.

- Location: plan A5 step 8. Acceptance line "a section missing a marker, or with `x` / `y` / `z` placeholder text after the markers, leaves the run not ready."
- Why: The exported body now contains the markers and the three sentences, and that body makes the fact true. The fact itself is a token check. `docs/project/README.md` plus `docs/project/STATE.md` is not "how to read it first." `STATE.md` plus the word `last` is not "how to update it." A section made of those tokens passes AC-25. An unbounded suffix search also lets one trailing line satisfy all three markers.
- Fix: Keep the three marker lines in the exported body, each followed by the statement step 8 already quotes. Make the fact true only when the span after each marker, ending at the next marker or the end of the architect section, contains that statement: the layout list with one line per entry; the read-first sentence; the update sentence. Extra prose may surround those statements. `x` / `y` / `z`, and the token-only placeholder above, stay not ready. The runner still writes no documentation prose.

### IMPORTANT

None.

### MINOR

None.

## Verdict

**PLAN COVERAGE INSUFFICIENT**

N1 is fixed. Every integrated return is `strict_descendant`, `equal_to_tip`, or `ancestor` of the tip; conflict does not advance. The empty change set and an older applied ref are recorded at the canonical revision, the tip stays, and `advanceIntegrationRevision` does not invalidate a current final verification. A cherry-pick on top of the tip still advances. Handoff reports and applies integration `HEAD`, which is the tip, and the handoff check accepts it. Nothing else reads the task's stored integration revision.

Blocking condition:

1. N3's fact is true for a marked section that lists the layout names, the two `docs/project` paths, and the tokens `STATE.md` and `last`, and that section does not say how to read the folder first or how to update it. The verbatim template passes, and `x` / `y` / `z` fails, but D6.2 is not what the fact checks. AC-25 can pass without the three statements.
