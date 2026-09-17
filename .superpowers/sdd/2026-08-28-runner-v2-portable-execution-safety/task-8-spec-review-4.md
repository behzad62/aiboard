# Task 8 Final Specification Gate

## Verdict

**APPROVED — zero Critical/Important ambiguity remains in the exact final-gate scope.**

This review checked only the fixture placement and managed-cancellation evidence requested after `task-8-spec-review-3.md`. Previously verified architecture was not reopened.

## Gate results

| Check | Result | Evidence |
|---|---|---|
| 8.0A remains contract/fake-only | **Verified** | Lines 149–155 assign strict state/version, transfer, fencing, acknowledgement, and compatibility tests to 8.0A. Fake claims/backends prove pre-transfer, ambiguous-transfer, adopted-session, and cleanup transitions without starting a production child. |
| Real host-crash fixture belongs to 8.0B | **Verified** | Lines 216–220 place the real Runner termination/restart fixture after the streaming kernel/adapters exist. It requires exactly one cleanup transition and no residual lease, process, input endpoint, or fabricated adopted session. |
| Persistent-child draining fixture belongs to 8.0B | **Verified** | Lines 220–223 place the real persistent-child fixture in 8.0B. It requires output beyond the in-memory tail, bounded kernel draining and terminal observation between ToolBroker calls, while family delivery and every write remain unauthorized. |
| Three distinct managed cancellation tests | **Verified** | Lines 382–387 explicitly require three prove-RED/revert/GREEN tests: start cancellation stops and verifies empty; stop cancellation after durable intent cannot interrupt cleanup; output-poll/observation cancellation cancels only the read and leaves the exact child running and owned. |

## Contradiction check

The edits introduce no Critical/Important contradiction:

- 8.0A can close without implementing 8.0B runtime behavior.
- 8.0B owns both fixtures that require a real streaming kernel, owned child, input endpoint, and background output draining.
- The three managed cancellation dispositions are mutually consistent and preserve durable background-process semantics.
- The amended tests remain in the canonical packet order and do not move a production family migration ahead of Git.

## Approval

The Task 8 brief is executable in the reviewed scope. Implementation may begin under its stated 8.0A → 8.0B → Git → MCP → LSP → managed → audit sequence and evidence gates.
