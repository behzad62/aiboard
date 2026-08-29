# Task 7 review round 4 fix report

Date: 2026-08-29
Reviewed base: `1c9b0091`
Scope: all three round-4 Important findings only. Task 8 was not started.

## OCI journal-before-secret packet

OCI acquisition now computes and validates the exact handoff path, contents, container name, labels, and immutable image in Runner-private memory. It persists the `creating` record, including the closed handoff path but no values, before creating the handoff directory or file. Journal persistence failure therefore has no secret-bearing filesystem effect.

Two injected barriers prove restart behavior after the durable journal/before the file and after the file/before Docker create. A restarted provider removes an absent or present exact handoff, proves the exact named container absent, emits one cleanup transition, acknowledges it, and converges to `[]`. A separate dual fault writes a partial/complete secret handoff and throws, then injects cleanup failure; durable state retains the exact path without values, no create occurs, and restart removes/acknowledges it.

Successful create output is only a candidate ID. Before `bound` persistence, the provider inspects that ID's exact name, all Runner/provider/run/invocation/grant/image labels, and immutable image ID. Mismatch or inspection failure remains in `creating`; recovery discovers only the exact journalled name, re-attests it, and removes only that validated ID.

Ordering mutation: handoff write was temporarily moved before the durable journal barrier.

`npx tsx --test --test-name-pattern "create journal owns absent" runner-v2/test/oci-execution-isolation-provider.test.ts`

RED: 1 passed / 2 failed overall; `after_create_journal` found the secret file present before the journal boundary. The mutation was reverted.

Returned-ID mutation: exact returned-ID inspection/re-attestation was temporarily removed.

`npx tsx --test --test-name-pattern "re-attests returned" runner-v2/test/oci-execution-isolation-provider.test.ts`

RED: 0/3; both returned-ID mismatch and inspect-failure subcases reported `Missing expected rejection`. The mutation was reverted.

Current focused command:

`npx tsx --test --test-name-pattern "create journal owns absent|file-write plus cleanup|re-attests returned" runner-v2/test/oci-execution-isolation-provider.test.ts`

Result: 7/7 GREEN, 0 failed, 0.365s.

Full OCI/fake/real Docker:

`npx tsx --test runner-v2/test/oci-execution-isolation-provider.test.ts`

Result: 34/34 GREEN, 0 failed/skipped, 10.45s, including four real Docker fixtures and zero owned-container/handoff residue.

## Windows Job terminal control lane

The promise-tail snapshot map was replaced by one `JobControlLane` per exact process ID. A lane has a settled-on-error tail, a synchronous `releaseRequested` terminal flag, and one shared release promise. Release marks the lane terminal before awaiting prior controls. Concurrent/idempotent releases share the same tail. Controls arriving during release are rejected before enqueue; post-release controls are rejected through a bounded 4,096-entry released-ID tombstone. The lane/offset state is deleted only when that exact lane's release tail completes. Completed lanes do not accumulate, and operation errors do not poison later controls or release.

The reviewed implementation is the natural RED: release snapshotted tail 1, operation 2 could enqueue after the snapshot, release deleted the map, and operation 3 created a parallel lane. The deterministic regression holds operation 1, starts two releases, attempts late verify/signal, completes operation 1, proves both releases settle together, then rejects post-release control. A second regression injects an operation error and proves signal and release still run.

`npx tsx --test --test-name-pattern "Windows Job (serializes|release atomically|control lane advances)" runner-v2/test/windows-process-backend.test.ts`

Result: 3/3 GREEN, 0 failed, 0.269s. Generic SPI and POSIX behavior are unchanged.

## Portable Windows launch rollback and state publication

The real missing-executable fixture now starts four concurrent launches and retains error/state diagnostics until the zero-directory assertion. Before the terminal-proof fix, it naturally failed twice. The diagnostic RED left two exact `owned-*` directories. Both states were authenticated `started` then `stopped`, with exact supervisor/root births and ENOENT errors; cleanup discarded the supervisor's stable stopped/quiescent proof because overloaded CIM inspection of historical child PIDs returned unknown until deadline.

Cleanup now retries transient identity uncertainty without signalling. Once the exact supervisor identity is proven exited, an exact nonce/PID terminal `stopped` state with valid historical identities is accepted only after its revision remains stable for a quiescence interval. Directory removal uses bounded Windows retry options. Permanent unknown identity still produces the existing durable typed blocker; recycled/mismatched identity and live descendants remain fail-closed.

A later aggregate exposed the adjacent root cause behind a normal descendant launch failure. The retained `state.json` was revision 1 `prepared`, while `state.json.<supervisorPid>.tmp` was complete revision 2 `started/running` and `child-status.json` was `started`. Windows transient replacement failure crashed the supervisor between temp write and atomic rename. The portable supervisor now retries only `EPERM`, `EACCES`, or `EBUSY` for a bounded one second, retaining atomic temp+rename semantics on every platform.

Focused real Windows command after both fixes:

`npx tsx --test --test-name-pattern "portable launch failure|native supervisor owns" runner-v2/test/windows-process-backend.test.ts`

Result: 2/2 GREEN, 0 failed, 17.85s. Full Windows backend: 17/17 GREEN, 0 failed/skipped, 23.64s.

The exact round-4 retained directory `C:\Users\b_a_s\AppData\Local\Temp\aiboard-portable-processes\owned-30c7130e-14f2-443d-aec6-6e15c3c79930` was inspected, its supervisor/root PIDs were proven absent, then the exact path was removed and verified absent. The deletion is not recoverable and contained only owned test state/log files.

## Exact aggregate stability

Exact command:

`node --import tsx --test runner-v2/test/one-shot-command-executor.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/one-shot-command-routing-static.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/windows-process-backend.test.ts`

After the final portable state-publication change, five consecutive unchanged runs were:

1. 123/123 GREEN, 0 failed/skipped/cancelled, 59.514s.
2. 123/123 GREEN, 0 failed/skipped/cancelled, 59.761s.
3. 123/123 GREEN, 0 failed/skipped/cancelled, 59.508s.
4. 123/123 GREEN, 0 failed/skipped/cancelled, 59.801s.
5. 123/123 GREEN, 0 failed/skipped/cancelled, 59.931s.

No retained current `owned-*` directory, `state.json.*.tmp`, live fixture process, OCI container, or handoff remained.

## Compatibility and final gates

Task 6/runtime/provider/backend compatibility:

`npx tsx --test runner-v2/test/execution-grants.test.ts runner-v2/test/execution-isolation-provider.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/tool-broker.test.ts runner-v2/test/execution-safety-contracts.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/posix-process-backend.test.ts runner-v2/test/windows-process-backend.test.ts`

Result: 177 passed, 1 expected host-platform skip, 0 failed, 178 total, 24.33s.

Native factory lifecycle:

`npx tsx --test runner-v2/test/native-build-initialization.test.ts runner-v2/test/native-build-capabilities.test.ts runner-v2/test/native-final-verification-factory.test.ts`

Result: 39/39 GREEN, 0 failed/skipped, 32.42s.

`npm run typecheck:runner-v2`

Result: GREEN, zero diagnostics. An initial test-only RED found two concrete Job adapter calls with interface-only fence arguments; removing the ignored arguments preserved the focused behavior.

`npx eslint runner-v2/src/oci-execution-isolation-provider.ts runner-v2/src/windows-process-backend.ts runner-v2/src/native-process-backend.ts runner-v2/src/portable-process-supervisor.mjs runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/windows-process-backend.test.ts`

Result: GREEN, zero diagnostics.

`npx tsx --test runner-v2/test/one-shot-command-routing-static.test.ts`

Result: 2/2 GREEN, zero alternate one-shot launch paths.

`git diff --check`

Result: GREEN, zero whitespace errors.

Residue: zero `ai-board.runner-v2.owned=true` Docker containers, zero live Task 7 portable/family processes, zero current-round portable owned directories or temp state files. One older shared portable directory created before round 4 was preserved. Rollback is the focused round-4 commit. Recovery remains exact-name/path/identity scoped and typed. No Task 8 migration, Git/filesystem work, Node pin, or mandatory Windows-only semantic was introduced.
