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
3. Exact GREEN: 5/5 tests. The mutable caller buffer, saturation/release,
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
4. Exact GREEN: 3/3 tests.

## Current validation

- New B1 focused tests plus exact 8.0A tests: 101/101 green.
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

## Self-review concerns for independent review

1. The output controller presently keeps accepted/consumed checkpoints in its
   bounded private map. The approved brief requires these metadata checkpoints,
   one consuming intent, reopen/replay, HMAC/tamper/read-only behavior, and
   provider-retention proof to live durably in the same SQLite kernel. This is
   not yet implemented and must be treated as an Important/Critical incomplete
   requirement, not inferred from the fake controller test.
2. The host journal currently implements the positive staged path and atomic
   handoff, but its cleanup-pending/blocked/released/takeover transitions and
   crash/fault injection at every boundary remain incomplete.
3. Startup recovery currently settles unhanded host rows only. Adopted-session
   exact reattach/output-window attestation and typed persistence of unavailable/
   unknown recovery outcomes remain incomplete.
4. The runtime failure path calls injected release/reconcile but does not yet
   settle the host journal into a fenced cleanup terminal branch.

The implementation is intentionally not represented as independently approved
or as packet-complete. The listed gaps require governed repair before B1 may
unlock B2.
