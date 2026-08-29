# Task 8.0B1 implementation report

## Scope and base

- Entry architecture commit: `6ade2e52`.
- Changed only the approved 8.0A contract/store/channel seams plus new fake-only
  launch/runtime/output modules and focused tests.
- No native/POSIX/Windows/Job/OCI adapter, CLI/factory, Git/MCP/LSP/managed/
  provider family, raw process launch, shell, ambient environment, or Node
  engine policy was changed.

## B1.1 RED/GREEN evidence

1. Added `staged-launch-kernel.test.ts` first. Exact RED:
   `npx tsx --test runner-v2/test/staged-launch-kernel.test.ts` failed because
   `HOST_LAUNCH_RECORD_VERSION` was absent.
2. Implemented strict v1 host-launch records in the existing streaming-session
   kernel, a hidden writer, in-memory and same-Database SQLite host tables,
   fenced prepared/isolation/launch/bind/handshake transitions, staged grant
   authority, and atomic adoption.
3. Added the atomic-finalization regression first; exact RED was
   `TypeError: authority.finalizeLaunch is not a function`. GREEN after the
   implementation: 4/4 tests.
4. Grant consumption was observed before any fake isolation effect; a reused
   call and a reused staged alias fail typed. The private staged object
   serializes as `{}` and its claims remain authenticated in the authority
   WeakMap.

## B1.2 RED/GREEN evidence

1. Added `streaming-output-v2.test.ts` first. Exact RED was
   `ERR_MODULE_NOT_FOUND` for `bounded-protocol-queue.js`.
2. Added owned-copy, byte/chunk-bounded queueing, producer backpressure,
   cancellation and oversized-frame cleanup; additive channel-v2 metadata;
   protocol/evidence tee; strict sequence/offset/length/digest checking; exact
   acknowledgement; and current delivery authorization.
3. Exact GREEN grew to 12/12 tests. The mutable caller buffer, saturation/release,
   cancellation, evidence-write failure, sequence gap, and authorization
   refusal cases are covered.

## B1.3 RED/GREEN evidence

1. Added `streaming-process-session-runtime.test.ts` first. Exact RED was
   `ERR_MODULE_NOT_FOUND` for `streaming-process-session-runtime.js`.
2. Added a fake-provider-only runtime with the exact staged/prepare/isolate/
   launch/bind/channel/output/handshake/adopt order. It never invokes terminal
   wait and fails typed for non-v2 output.
3. Added bounded host-row startup reconciliation; its fake recovery never
   launches.
4. Exact GREEN grew to 8/8 tests.

## Mandatory gap closure RED/GREEN evidence

- Durable checkpoint contract RED: `streaming-output-checkpoint.test.ts` failed
  because `parseOutputCheckpointRecord` did not exist. GREEN is 4/4, covering
  strict version/keys, recursive payload refusal, record/window capacity,
  accepted→intent→consumed, exact replay, HMAC/tamper/reopen and read-only.
- Durable controller ordering RED observed `missing` at delivery/ack checkpoints;
  retained-window recovery RED had no method. GREEN proves accepted commit,
  consuming intent, authorized delivery, consumed commit, then acknowledgement;
  exact consumed replay suppression and ambiguous delivery/ack become durable
  `outcome_unknown`.
- Queue terminal cleanup RED hung a blocked producer until the 30-second exact
  test timeout. GREEN rejects/wipes queued and waiting owned buffers and settles
  all producer/consumer waiters on oversize or cancellation.
- Host cleanup RED rejected `ownerExpiresAt` as unknown and had no cleanup
  transitions. GREEN covers pending/blocked/released, consecutive expired-owner
  takeover, immutable origin plus takeover provenance, stale fence, and forged
  provenance refusal.
- SQLite adoption fault RED ignored the injected boundary and initially exposed
  the test handle-cleanup defect; after fixing fixture cleanup, GREEN proves
  rollback after session insert and wholly post-adoption state after commit.
  Reopen evidence covers every prepared/isolation/launch/bind/handshake boundary.
- Runtime cancellation RED left the host `bound` and allowed an active abort to
  adopt. GREEN settles exact cleaned/blocked journal terminals, waits the active
  effect barrier, releases one lease, and refuses revocation at isolate, launch,
  channel, output, and handshake boundaries.
- Adopted recovery RED left the session active with missing retained bytes.
  GREEN reattaches without terminal wait/relaunch, validates the provider replay
  window against durable accepted metadata, and records `outcome_unknown` or
  `input_unavailable` through SessionAuthority.
- Runtime v2 composition now creates the checkpoint, queue, evidence tee and
  controller before output starts. A fake emitted protocol chunk proves one
  evidence write, one authorized delivery, one consumed checkpoint and one
  provider acknowledgement; the returned facade contains no channel/backend.
- Controlled mutations were reverted: disabling current output authorization
  made its exact test RED; acknowledging before consumed commit made ordering
  RED; ignoring the host fence made the fencing test RED. Each exact check was
  GREEN after revert.

## Current validation

- New B1 focused tests: 34/34 green in the final validation rerun.
- Exact 8.0A plus staged-kernel affected tests: 99/99 green.
- Exact Task 7 compatibility tests: 127/127 green.
- `npm run typecheck:runner-v2`: green.
- Targeted ESLint over every changed source/test: green after replacing an
  empty acknowledgement interface with an equivalent type alias.
- `git diff --check 6ade2e52`: green (Git emitted only expected LF/CRLF worktree
  notices).
- Static changed-source search found no spawn, kill, taskkill, shell flag,
  ambient `process.env`, or exact Node patch pin. The only `exec(` matches are
  existing/new SQLite transaction/schema calls in the durable kernel.

## Cleanup and residue

- Tests use only in-memory fake runtime state in the new packet; no real child,
  port, endpoint, supervisor, container, or timer is started.
- All byte queues clear owned references on cancellation/oversize. Runtime
  failure detaches the fake channel and releases the fake lease.
- No B1-named temporary directory or spill was created by the focused tests.
- One positively owned SQLite root left by the deliberately failing first
  adoption-fault test was validated as the exact Temp child containing only
  `sessions.sqlite`, removed non-recursively, and re-inspected. Final matching
  B1 temp-root residue count is zero.

## Self-review concerns for independent review

- No known mandatory implementation gap remains from the four controller-returned
  items. Independent review is still required and this report does not claim
  approval or unlock B2.
- B1 remains deliberately fake-provider-only. Native/POSIX/Windows/Job/OCI
  behavior remains owned by B2/B3 and was not inferred from these tests.
