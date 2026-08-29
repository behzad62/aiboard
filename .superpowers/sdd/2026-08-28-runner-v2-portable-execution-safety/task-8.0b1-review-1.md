# Task 8.0B1 independent review — round 1

## Verdict

- Specification compliance: **NOT APPROVED**
- Task code quality: **NOT APPROVED**
- Findings: **1 Critical, 6 Important**
- Packet 8.0B2 remains locked.

## Critical

### Family output bypasses SessionAuthority

`StreamingOutputController` accepts only an `authorize(stream): boolean`
callback and never receives or validates a `SessionOperationAuthorization`.
The runtime starts output before handshake/adoption and routes chunks to family
delivery. Its later `authorizeFirstOperation` capability is not connected to
that path. The runtime test itself opens, emits protocol output, and observes a
family delivery without first authorizing an operation.

Consequences: output can become family/model-visible before adoption or between
ToolBroker calls; unavailable authorization marks the protocol unknown rather
than privately draining/backpressuring it. This violates the frozen current-
exact-authorization requirement.

Evidence: `streaming-output-controller.ts:17`,
`streaming-process-session-runtime.ts:115-138`, and
`streaming-process-session-runtime.test.ts:74` at reviewed commit `b947aaeb`.

## Important

### 1. Output checkpoint ordering and fail-closed state are incorrect

- Runtime inserts into the queue through the tee before durable accepted commit,
  reversing the required order.
- The durable reducer accepts new chunks after `outcome_unknown`. Direct
  reproduction yielded outcome unknown plus one accepted chunk at revision 2.
- Only the most recent consumed digest is retained, so older consumed replay
  cannot always be authenticated exactly.
- Runtime bypasses the additive v2 provider subscription contract with a
  separate fake `startOutput`/embedded acknowledger protocol.
- Global provider replay capacity is compared with per-stream durable capacity,
  allowing two streams collectively to exceed the attested window.

Evidence: `protocol-evidence-tee.ts:10`,
`streaming-process-session-runtime.ts:115-126`, and
`streaming-session-store.ts:1584-1615`.

### 2. Staged authority is not authority-bound, session-reserving, or exact-binding-safe

- Staged capabilities are stored in a module-global WeakMap. A capability from
  one SessionAuthority was accepted by another backed by a different kernel.
- Two distinct grants can stage different launch IDs for one session before
  durable preparation.
- `beginTransfer()` remains a separate consume/claim implementation rather than
  a wrapper over the staged state machine.
- Finalization and atomic adoption compare only lease ID plus backend opaque
  identity, not the complete lease/provider/invocation/backend registry/
  generation/attestation/PID/birth identity.

Evidence: `session-authority.ts:60,285,317` and
`streaming-session-store.ts:1920`.

### 3. Host journal parsing and ownership leases are not strict

- Parser checks only history length and final state, not initial state, legal
  transitions, normative effect IDs/uniqueness, or effect/state/status
  combinations. It accepted a cleanup-pending record starting at `bound`, with
  no lease/backend and a wrong isolate effect/fence.
- Normal transitions ignore expired `ownerExpiresAt`; an expired owner advanced
  prepared to isolated.
- In-memory atomic adoption bypasses configured session capacity.

Evidence: `streaming-session-store.ts:1519,1677,1831,1889`.

### 4. Startup recovery neither truly reattaches nor remains time-bounded

- Host reconcile and channel reattach awaits have no timeout/cancellation bound;
  a never-resolving provider blocks startup.
- Reported reattach success only compares metadata, drops the returned channel,
  does not replay retained bytes, restart draining, attach a private registry,
  or resume terminal observation, and can succeed without a durable checkpoint.
- Expired host owners are not taken over; cleanup-blocked rows are only reported.

Evidence: `streaming-process-session-runtime.ts:149-173`.

### 5. Evidence and runtime cleanup are incomplete

- Evidence is a write-only sink, not an injected Task 3 BoundedOutputSpool
  lifecycle; it cannot finalize artifacts or prove close/cleanup.
- Runtime ignores the tee's truthful loss result.
- Detach failures are swallowed; pre-adoption checkpoints are not terminally
  settled/removed after failure; asynchronous output/frame failure is not tied
  to journal cleanup; and no adopted cleanup/stop facade or private registry
  retains the channel.

Evidence: `protocol-evidence-tee.ts:4` and
`streaming-process-session-runtime.ts:108,124,142`.

### 6. Mandatory tests and RED evidence are materially incomplete

Missing or ineffective proof includes same-session reservation and cross-
authority rejection; beginTransfer staged compatibility; complete lease/backend
identity; strict host history/effects/read-only/expiry/all transaction faults;
pre-effect revocation and cancellation boundaries; framing/cross-stream/zero-
length/offset/digest matrix; stale authorization/fence; retained-byte replay;
hung-provider recovery bounds; true reattach draining; full spool failure
lifecycle; oversized-frame process cleanup; persistent unauthorized output; full
durable secret scan; and residue cleanup. The report does not contain RED/
revert/GREEN evidence for every added guard/regression.

## Reviewer verification

- Focused B1 tests: 34/34 green.
- Runner V2 typecheck: green.
- `git diff --check 6ade2e52..b947aaeb`: green.
- Scope audit: no adapter/CLI/family/raw-spawn/shell/ambient-environment/Node-pin
  change.
- Direct adversarial reproductions confirmed accepting output after unknown,
  impossible host history/effects, duplicate same-session staging, and cross-
  authority staged validation.

## Required disposition

Route every finding to the original implementer as governed fix round 1. Rerun
the exact new failing checks first, then affected contracts and broader gates.
Independent re-review is mandatory; no production adapter or family work may
start.
