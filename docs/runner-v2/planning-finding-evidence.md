# Evidence for blocking planning findings

A planning Reviewer must establish an actual acceptance failure, rather than
turning feature relatedness or an optional improvement into a blocker. The
friends evaluation exposed the difference: an invitation UI does not need a
presence API merely because sorting online friends first might be useful.

New plan-critique and coverage-review requests record
`findingEvidencePolicyVersion: 1`. Both the submission tools and durable
scheduler/planning reducers enforce that request's evidence contract. The
Reviewer cannot clear the policy through its verdict payload. Historical
unversioned requests/reviews retain their recorded format and replay meaning;
resuming one does not silently rewrite its contract.

## Required evidence

Each blocking planning finding includes `blockingEvidence`:

- `taskIds`: existing affected tasks. The basic critic's outer task IDs must
  match these IDs. Unowned source work may legitimately have no task yet.
- `criteria`: real task or requirement acceptance criteria, identified by
  their IDs and exact text. Coverage gaps can cite an existing blind source
  obligation by ID and exact description. The basic critic can also cite an
  exact excerpt of the recorded run objective for an otherwise unowned gap.
- `requiredContract`: the API, data contract, file, behavior or acceptance
  boundary actually required.
- `failureWithoutChange`: a concrete execution order/setup and observable
  acceptance failure that would occur without the proposed correction.
- `proposedFix`: a specific, actionable correction.

For `missing_dependency`, `dependency` names the consumer and producer. The
proof must cite the **consumer's own** existing task criterion; citing only
the producer's criterion or a broad objective is insufficient. Both tasks
must exist, differ, and appear among the affected tasks. The kernel refuses
an edge already supplied directly or transitively, and an edge that would
create a cycle.

For example, this proof is admissible only when T7 really has the cited
criterion, T3 exists, and T3 is not already a prerequisite:

```json
{
  "category": "missing_dependency",
  "severity": "blocking",
  "blockingEvidence": {
    "taskIds": ["T7", "T3"],
    "criteria": [{
      "kind": "task",
      "taskId": "T7",
      "criterionId": "online-picker",
      "text": "The invitation picker displays only online friends."
    }],
    "requiredContract": "GET /api/friends/presence",
    "failureWithoutChange": "Run the picker before T3 provides presence: the endpoint is unavailable and the picker cannot select only online friends.",
    "proposedFix": "Add T3 to T7.dependencies.",
    "dependency": { "taskId": "T7", "missingDependency": "T3" }
  }
}
```

If T7's actual criterion only requires inviting, viewing, accepting and
declining invitations, the online-only citation is rejected. It cannot be
silently added to the requirements through a review finding.

Blocking `overlapping_scope` and `scope_creep` findings also name each
affected task's surfaces. Full-contract surfaces must match the declared
writable surfaces; overlapping scope names at least two tasks. The basic
planner has no explicit writable-surface contract, so its path claims still
need repository inspection and semantic review.

Blocking `undersized_task`, `incoherent_task` and `oversized_task` findings
cite actual acceptance criteria for every affected task. Fragmentation
findings name at least two tasks, rather than declaring a small task invalid
in isolation. Their failure explanation and proposed merge/split must
demonstrate an acceptance problem, not a preferred grouping or task count.

## Judgment and review flow

The kernel verifies identities, exact citations, required evidence fields,
published surfaces and graph facts. It does not decide whether the named
contract is technically necessary or whether the predicted failure is true.
Those remain review judgments; the Architect can reject an unfounded finding
with a rationale through the existing resolution flow. Structured evidence
is retained in durable records and shown with open blockers in the
Architect's planning context so the judgment is inspectable.

An invalid blocking submission is refused with a validation error. The
Reviewer can supply grounded evidence or explicitly submit an advisory
suggestion. The runner neither turns an unsupported suggestion into a
blocking record nor silently approves an incomplete review. Source-coverage
missing/weakened verdicts retain their separate blind-obligation gate;
deliverable-review evidence policies are unchanged.

Regression coverage includes the invented online-sorting criterion, a valid
consumer/producer contract, unknown references, producer-only citations,
redundant/transitive dependencies, cycles, scope/cohesion evidence, advisory
resubmission, direct durable-event bypass attempts and historical replay.

Follow-up validation on 2026-10-26: 291 targeted tests passed, including native
planning/delivery export and the frozen legacy prompt checks. App and Runner
TypeScript checks and scoped ESLint passed. These checks establish mechanical
grounding and review flow, not the correctness of every future model judgment.
