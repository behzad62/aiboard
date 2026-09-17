# Task 8.0B2 Fix Round 1

## Scope and authority

Repair exactly the six Important findings in `task-8.0b2-review-1.md` against
the original `task-8.0b2-brief.md`. Preserve all green B1, 8.0A, Task 5/7,
managed facade, Node 22/24, portability, cleanup, and no-family-routing gates.
Do not add OCI or begin B3.

## Required repair packets

1. **Concrete actor-free Job host:** test the transitive implementation first,
   then move the low-level record/authenticated supervisor, native argv/batch,
   control, output, reconciliation, and release mechanics out of
   `ManagedProcessService`. The concrete host must not import agent/model/tool
   contracts or construct an actor. The public managed facade keeps its own
   authorization/actor projection and delegates mechanics to the host with no
   public behavior change.
2. **Job bounded duplex:** add real current-host RED tests, then implement Job
   write/close, bounded retained stdout/stderr, sink-before-provider ack,
   detach/reattach/replay, terminal wait, stop, and fence checks through only the
   concrete low-level host. It must satisfy the same B1 v2 channel semantics as
   the portable backend.
3. **Independent selection and batch fallback:** actively derive the four facts
   from trusted concrete hosts. Correct the existing Windows construction seam
   so active Job failure retains the portable baseline. Do not route a new child
   family. Prove real `.cmd`/`.bat` argv-only launch with Job containment
   unavailable and typed prelaunch refusal when the separate batch fact is not
   verified.
4. **Monotonic fence handoff:** separate immutable birth from mutable writer
   authority. Add an authenticated, atomic current-fence claim to ProcessBackend
   effects and v2 acquire/reattach. A strictly newer legitimate fence may take
   over; equal current fence is idempotent; stale/divergent fences fail before
   effects. Persist the claim in the exact owned host directory/host record and
   prove two contenders cannot both control. Update B1 adapter types minimally
   and pass the durable current fence from the runtime; no guessed authority.
5. **Immediate re-attestation:** add recycled/missing/unknown identity tests for
   acquire, reattach, terminal acceptance, verify-empty, and release. Validate
   supervisor/Job birth, current writer, and membership immediately before the
   operation and again before evidence deletion when an intervening check can
   race. Never delete evidence on mismatch/unknown.
6. **Fail-closed retained output:** strict-parse filename, nonce, stream,
   sequence, offsets, length, digest, and bytes. Validate each per-stream
   retained suffix is contiguous. Corruption/deletion uncertainty becomes a
   private channel failure plus durable `outcome_unknown`/cleanup blocker; it is
   never skipped. Free retained capacity only after the acknowledged chunk is
   verifiably deleted. Release refuses unsettled/corrupt retained output.

## Mandatory RED/revert/GREEN proofs

- concrete host imports/calls managed facade or constructs any actor;
- Job backend lacks/loses any duplex operation;
- active Job false prevents portable or verified batch execution;
- token-1 writer remains active after valid token-2 takeover;
- token-2 takeover is rejected or two contenders both write/control;
- recycled supervisor/Job birth can attach, accept terminal, verify empty, or
  release/delete evidence;
- wrong nonce, filename, sequence, offset, digest, payload, or missing retained
  deletion is silently accepted or capacity freed;
- release succeeds with unsettled retained output.

Every guard must be introduced RED, fixed GREEN, mutation-proven RED, reverted,
and GREEN. Run exact failures first, then the focused B2 group, managed and
backend contracts, complete B1/8.0A, Task 7/3 compatibility, typecheck, targeted
lint, diff/static dependency/raw-launch/product-branch/Node-pin audits, and exact
owned process/filesystem residue audit. Append the round to
`task-8.0b2-report.md`, commit the focused repair, and leave the worktree clean.

This implementation is not approval. B3 remains locked until fresh scoped
re-review and controller verification report zero Critical/Important findings.
