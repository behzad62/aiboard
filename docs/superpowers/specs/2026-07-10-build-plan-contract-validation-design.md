# Build Plan Contract Validation Design

## Goal

Prevent Build mode from spending worker calls on structurally invalid Architect plans or accepting task approvals that contradict objective verification evidence, while preserving the Architect as the sole semantic decision-maker.

## Scope

This design covers Architect plan-contract validation, safe scheduling, and approval-evidence validation. Cross-tab storage ownership and durable Activity-log persistence are separate follow-up work.

## Principles

- The engine validates contracts; it does not judge architecture or implementation quality.
- Only machine-verifiable contradictions block execution.
- Semantic concerns remain warnings for the Architect and independent plan critic.
- The engine never silently adds/removes dependencies, test paths, or verification policy to repair an Architect plan.
- Validation failures are returned to the Architect as exact structured errors before workers run or before an approval is accepted.
- Revision loops are bounded so malformed plans cannot consume tokens indefinitely.

## Approaches Considered

### Deterministic contract compiler (selected)

Parse the Architect plan into a typed graph, validate objective invariants, and require the Architect to revise invalid contracts. This is predictable, testable, and leaves design ownership with the Architect.

### Model critic only

Continue relying on a second model to identify plan defects. This is useful for semantic warnings but cannot guarantee structural correctness; observed blocking dependency defects survived the current critique/revision pass.

### Engine auto-repair

Automatically insert dependencies, test paths, or verification requirements. This is convenient but changes Architect intent, can make valid unusual plans incorrect, and obscures responsibility. Existing auto-repair behavior will be removed from the blocking path.

## Contract Validation

Introduce a pure plan validator that returns ordered issues without mutating tasks:

```ts
type BuildPlanContractIssueSeverity = "error" | "warning";

interface BuildPlanContractIssue {
  code:
    | "duplicate_task_id"
    | "unknown_dependency"
    | "self_dependency"
    | "dependency_cycle"
    | "unordered_output_overlap"
    | "missing_strict_tdd_contract"
    | "missing_tool_verification_contract"
    | "repo_task_not_terminal";
  severity: BuildPlanContractIssueSeverity;
  taskIds: string[];
  message: string;
}

interface BuildPlanContractValidation {
  valid: boolean;
  errors: BuildPlanContractIssue[];
  warnings: BuildPlanContractIssue[];
}
```

Hard errors are limited to objective contradictions:

1. Task IDs must be unique and every dependency must reference a declared task.
2. A task cannot depend on itself and the dependency graph must be acyclic.
3. Tasks owning any identical `outputPaths` or `testOutputPaths` must be ordered by a transitive dependency path. Merely placing them in separate batches is insufficient because the earlier owner has not necessarily been Architect-approved.
4. In strict-skill mode, a behavior-changing executable-source task must explicitly declare a persisted test path and RED/GREEN evidence requirement. The engine must not invent a test filename.
5. A `verificationPolicy: "tool"` task must declare objective evidence through `requiredEvidence`, phase verification, or the accepted project verifier.
6. A `kind: "repo"` task is terminal by default and cannot be runnable while any non-repo task is unfinished. This prevents commit/push work from racing implementation or verification. A future explicit incremental-repo contract may relax this, but it is not part of this change.

Warnings cover non-provable concerns such as task size, questionable decomposition, a possibly incomplete final-verification dependency set, or architecture choices. Warnings are included in Architect context but do not block workers.

## Architect Revision Flow

Plan parsing is followed by deterministic validation before task IDs are consumed by the scheduler.

1. Parse and normalize only representational details (whitespace, bounded arrays, canonical paths). Do not alter task meaning.
2. Validate the complete graph.
3. If errors exist, send the Architect the original plan plus structured errors and request a complete revised plan.
4. Validate the revision again.
5. Allow at most two contract-revision responses after the original plan.
6. If errors remain, persist a blocked checkpoint and stop before any worker call.
7. Run the independent model critic only after deterministic validation succeeds; critic findings remain semantic input. Any critic-driven Architect revision must pass deterministic validation again.

This ordering prevents a model critic or revision from reintroducing structural defects.

## Scheduler Safety

The scheduler retains its overlap batching optimization, but it must never treat batch separation as approval ordering. A task with overlapping declared outputs is runnable only when its ordering dependency is `done` (Architect-approved). Unknown dependencies are no longer treated as satisfied because the validator guarantees they cannot reach dispatch.

Repo tasks receive an engine-level terminal barrier: they remain unrunnable until every non-repo task is `done`. The engine reports the barrier in diagnostics without modifying `dependsOn`.

## Approval Evidence Gate

The Architect remains responsible for `approve` versus `fix`. The engine checks only whether an approval contradicts objective evidence.

For every task with `verificationPolicy: "tool"`, maintain a task-scoped verification record containing:

- command/tool identity;
- exit or success status;
- timestamp and wave;
- paths or task IDs covered;
- required-evidence items satisfied or missing.

Before accepting an Architect `approve` result:

1. Confirm required tool evidence exists for that task and is current for the landed change.
2. Reject approval if the relevant verifier failed or required objective evidence is missing.
3. Return the exact contradiction to the Architect and request a corrected review action.
4. Permit `fix`, `failed`, or an explicit verifier replacement when the current verifier is demonstrably invalid for the stack.
5. Bound review-contract correction to two responses; then stop blocked rather than auto-requeueing workers or overriding the Architect verdict.

Architect-verified, external, and evidence-only tasks are not forced through a tool gate unless their explicit contract requires it.

## Diagnostics and Persistence

Every validation attempt records a compact structured problem with issue code, affected tasks, phase, and revision number. The durable checkpoint stores the last validation result so refresh/resume cannot bypass a failed contract. UI Activity entries explain that workers were not started because the Architect plan contract needs revision.

## Error Handling

- Parser failure follows the existing bounded parse-retry path.
- Contract failure uses the new bounded contract-revision path.
- Critic failure does not invalidate a structurally valid plan; it records a warning.
- Resume revalidates any non-completed checkpoint graph before dispatch.
- Legacy checkpoints with invalid graphs stop for Architect revision rather than being silently normalized into a different plan.

## Testing

Pure tests will cover:

- duplicate, unknown, self, and cyclic dependencies;
- transitive ordering of overlapping source and test paths;
- unordered overlap rejection without task mutation;
- explicit strict-TDD contract acceptance and missing-contract rejection;
- tool-verification contract acceptance/rejection;
- repo terminal barrier behavior;
- valid unusual plans using Architect/evidence/external policies;
- original plan, Architect revision, and critic revision all passing through the same validator;
- bounded revision exhaustion stopping before worker dispatch;
- resume revalidation;
- approval rejection for missing/stale/failing task-scoped evidence;
- approval acceptance for current passing evidence;
- warnings never blocking dispatch.

Integration tests will assert that an invalid plan produces zero worker calls and that a corrected Architect revision proceeds normally.

## Non-Goals

- Judging whether an architecture, algorithm, or product choice is good.
- Editing project code or correcting worker output automatically.
- Inferring undeclared file ownership from natural-language task descriptions.
- Replacing the independent semantic plan critic.
- Solving cross-browser storage ownership or Activity-log persistence in this change.

## Success Criteria

- No worker starts from a structurally invalid task graph.
- The engine never silently repairs Architect dependencies or test contracts.
- Overlapping file owners cannot run before the earlier owner is Architect-approved.
- A failing or missing required verifier cannot be contradicted by an accepted approval.
- Structurally valid unusual plans remain dispatchable.
- Repeated invalid revisions stop blocked before worker-token spend.
