# Architect Plan Reconciliation Design

## Problem

Runner V2 can use an early task to inspect the repository and gather evidence, but the Architect currently has no atomic way to update the remaining plan while approving that task. After the inspection integrates, the scheduler immediately dispatches the next mechanically ready task. If the inspection proved that task is already satisfied, the worker is forced to invent a change or waste a full attempt proving that no change is needed.

The live AIPaintball follow-up demonstrated the failure: T1 gathered current-repository evidence, but T2 still demanded a TDZ fix even though the declaration order was already correct and `node --test tests/game.test.mjs` passed. Two workers then tried to delete an unrelated regression test while manufacturing a change. The Architect rejected both attempts, but could only revise the stale task because no batch reconciliation action existed.

## Authority Boundary

The Architect remains the sole semantic authority. Runner V2 must never infer that a passing command makes a task obsolete, reinterpret the task objective, or choose which work to cancel.

The kernel validates only mechanical facts:

- plan revisions advance exactly by one;
- updated task IDs exist and are unique;
- only pending, failed, or rejected tasks are changed;
- cancelled tasks use a legal transition;
- the resulting graph has no missing dependency or cycle; and
- no active task depends on a cancelled task.

## Chosen Design

Add an Architect-owned `plan.reconciled` scheduler event and a `reconcile_plan` lifecycle tool. A reconciliation contains a new plan revision, a semantic summary, and a batch of task updates. Each update either cancels a task or revises its objective, dependencies, and/or required capabilities.

`review_task` accepts the same reconciliation as an optional field. The review decision and plan changes are reduced from one durable event, so a discovery task can be approved while stale successors are cancelled or rewired without another model call or a crash window between events.

`reconcile_plan` is also available independently during task-failure resolution. This lets the Architect recover an existing run whose stale task has already exhausted attempts.

## Data Flow

1. A worker submits evidence and a change set.
2. Runner V2 requests the Architect's semantic review.
3. The Architect either records an ordinary review or includes `planReconciliation`.
4. The scheduler reducer applies the review and reconciliation to an in-memory candidate projection.
5. Mechanical validation runs against the complete candidate graph.
6. Only a valid event becomes durable; replay reconstructs the same task states and revision.
7. The scheduler dispatches only tasks ready in the reconciled graph.

For an already exhausted stale task, the Architect uses `reconcile_plan` during the existing failure-resolution turn; no worker retry is dispatched first.

## Prompting

Architect system guidance explicitly says to reconcile the plan when new evidence invalidates an assumption. It must not demand a code change merely because a task exists when the task's required behavior already passes on the current integration baseline.

## Testing

- A scheduler replay test proves one reconciliation atomically cancels a stale task and rewires its dependents.
- An invalid reconciliation test proves active tasks cannot retain cancelled dependencies.
- An Architect-tool test proves `reconcile_plan` emits a typed action and advances the plan revision.
- A review-tool test proves review plus reconciliation is one durable event.
- Build-runtime tests prove an exhausted planned task can be reconciled without another worker attempt.
- The full Runner V2 suite remains green.

## Non-goals

- The kernel does not inspect command output to decide task completeness.
- Verifiers do not cancel, approve, or complete tasks.
- The scheduler does not automatically replan after every integration.
- Integrated tasks are immutable and cannot be cancelled by reconciliation.
