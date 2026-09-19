# Task 7 review round 3 fix report

Date: 2026-08-29
Reviewed base: `0a404c20`
Scope: the two Important round-3 findings only. Task 8 was not started.

## Two-phase OCI create journal

OCI acquisition now persists a `creating` record before invoking `docker create`. The record owns the exact UUID-derived container name, exact Runner/provider/run/invocation/grant/image labels, cleanup state, and private environment-handoff path; it contains no container ID and no secret values. A successful create validates the returned ID and advances that exact row to `bound` before private-handoff deletion or lease return.

Every throw, nonzero result, invalid ID, or transport error after a daemon effect enters the same settlement path. Settlement first attempts the exact private-handoff deletion, then discovers only the journalled exact container name with `inspect --format {{.Id}} <exact-name>`, revalidates the complete owned labels and immutable image, durably binds the discovered ID, and compensating-removes that exact ID. It never invents an ID, scans by a broad label, or removes an identity that fails exact revalidation. Any uncertain handoff deletion, discovery, identity validation, or removal remains a typed `oci_recovery_blocked` durable cleanup intent. Restart repeats the same exact settlement and produces one cleanup transition/acknowledgement.

The fault cross-product covers CLI throw, nonzero, invalid ID, and daemon-effect-then-transport-throw, each with handoff deletion success and failure. Every case restarts the provider, proves exact-name ownership before create, proves no secret in durable state, converges to state `[]`, removes any exact daemon effect, removes the handoff, and emits/acknowledges exactly one transition.

Prove-red mutation: the pre-effect durable journal write was temporarily moved after `create`.

`npx tsx --test --test-name-pattern "OCI pre-effect create journal" runner-v2/test/oci-execution-isolation-provider.test.ts`

RED: 0/9, all eight fault subcases failed `exact owned name is journaled before create`. The mutation was reverted. GREEN: 9/9, 0 failed.

Current complete OCI command:

`npx tsx --test runner-v2/test/oci-execution-isolation-provider.test.ts`

Result: 27/27 GREEN, 0 failed/skipped, 8.92s. This includes four live-Docker fixtures. Owned-label container residue after the full gate was zero.

## Pre-bind cancellation and timeout

The reviewed aggregate failure was not safely addressable by waiting for durable binding. A workload marker may be emitted after the supervisor launches the owned tree but before the runtime has persisted its authenticated backend binding. `SubprocessRuntime` correctly retains cancellation/timeout intent during that launch interval and acts after binding; a controlled production-backend barrier now proves both public ProcessTools outcomes:

- marker observed, cancellation requested before binding, binding released: public `cancelled`, cleanup `verified_empty`, TERM-ignoring descendant dead;
- marker observed, timeout expires before binding, binding released: public `timed_out`, cleanup `verified_empty`, TERM-ignoring descendant dead.

`npx tsx --test --test-name-pattern "before durable bind" runner-v2/test/one-shot-command-family-production-matrix.test.ts`

Result: 2/2 GREEN, 0 failed, 3.39s. The existing post-bind process/evidence/final cancellation and timeout cases remain in the same production-family matrix.

The earlier aggregate `backend_unavailable` / `read ECONNRESET` was traced to concurrent authenticated supervisor requests in the optional Windows Job adapter: the observe loop could call ownership reconciliation while runtime escalation called signal on the same managed-process supervisor channel. `WindowsJobObjectProcessBackend` now serializes reconcile, signal, empty verification, and recovery control per exact process ID; release waits for that queue. The portable Windows supervisor, POSIX backend, generic backend SPI, and shared runtime contracts are unchanged.

Prove-red mutation: signal was temporarily removed from the per-process control queue.

`npx tsx --test --test-name-pattern "serializes ownership observation" runner-v2/test/windows-process-backend.test.ts`

RED: 0/1 with injected `Error: read ECONNRESET`. The mutation was reverted. GREEN: 1/1, 0 failed. The deterministic regression holds reconciliation behind a barrier, requests cancellation, proves signal has not entered concurrently, releases reconciliation, and then proves exited reconciliation.

Full family matrix:

`npx tsx --test runner-v2/test/one-shot-command-family-production-matrix.test.ts`

Result: 14/14 GREEN, 0 failed/skipped, 34.22s. All family entrypoints use their actual public/production adapters; no matrix call invokes or relabels `internalExecution`.

## Aggregate diagnosis and stability

Required exact command:

`node --import tsx --test runner-v2/test/one-shot-command-executor.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/one-shot-command-routing-static.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/windows-process-backend.test.ts`

The first diagnostic run was 112/113: `evidence inspection is factual, read-only, and task scoped` inspected an empty list and the old test discarded the preceding command result. The test now asserts the command result first, so any recurrence exposes the exact stable execution error. It also owns an explicit production graph and awaits `graph.close()` before closing its store and deleting artifact/temp state; no supervisor/runtime graph outlives the fixture. The next diagnostic run was 113/113 GREEN in 60.09s.

After the final behavior/lifecycle changes, five consecutive executions of the exact command were:

1. 113/113 GREEN, 0 failed/skipped/cancelled, 62.665s.
2. 113/113 GREEN, 0 failed/skipped/cancelled, 61.928s.
3. 113/113 GREEN, 0 failed/skipped/cancelled, 61.649s.
4. 113/113 GREEN, 0 failed/skipped/cancelled, 60.455s.
5. 113/113 GREEN, 0 failed/skipped/cancelled, 60.294s.

There was no recurrence of undefined cancellation, `ECONNRESET`, identity mismatch, backend-unavailable mapping, empty evidence inspection, hang, or leaked process.

## Compatibility and final gates

Task 6 grant/provider/runtime compatibility:

`npx tsx --test runner-v2/test/execution-grants.test.ts runner-v2/test/execution-isolation-provider.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/tool-broker.test.ts runner-v2/test/execution-safety-contracts.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/posix-process-backend.test.ts runner-v2/test/windows-process-backend.test.ts`

Result: 167 passed, 1 expected host-platform skip, 0 failed, 168 total, 20.80s.

Native factory lifecycle/final factory:

`npx tsx --test runner-v2/test/native-build-initialization.test.ts runner-v2/test/native-build-capabilities.test.ts runner-v2/test/native-final-verification-factory.test.ts`

Result: 39/39 GREEN, 0 failed/skipped, 32.81s. The single ToolAuthority/SubprocessRuntime/executor graph and reverse-safe factory lifecycle remain intact.

`npm run typecheck:runner-v2`

Initial RED: one new test called the concrete two-argument Job adapter `signal` method with the interface-only fence argument. The ignored third argument was removed. The exact backend regression remained GREEN 1/1; current typecheck is GREEN with zero diagnostics.

`npx eslint runner-v2/src/oci-execution-isolation-provider.ts runner-v2/src/windows-process-backend.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/support/one-shot-command-executor.ts runner-v2/test/windows-process-backend.test.ts`

Result: GREEN, zero diagnostics.

`git diff --check`

Result: GREEN, zero whitespace errors.

Static audit command:

`rg -n '\b(spawn|spawnSync|exec|execFile|execFileSync|taskkill|process\.env|\.kill\s*\()' runner-v2/src/process-tools.ts runner-v2/src/evidence-tools.ts runner-v2/src/final-verification-runtime.ts runner-v2/src/native-build-factory.ts`

Result: the three migrated command families contain only injected executor calls and policy/result fields; no alternate launch, signal, ambient-environment merge, or private lifecycle escape exists. Native factory contains the one expected central ambient-environment snapshot passed to the shared executor graph. The executable-bypass static guard also passed inside every 113-test aggregate.

## Cleanup, rollback, recovery, and boundary

Docker probe: zero containers with `com.aiboard.runner.owned=true`. Process probe: zero live Task 7 family/production-one-shot/managed fixture processes. The temp audit used exact prefixes, timestamps, and contents. One directory, `C:\Users\b_a_s\AppData\Local\Temp\aiboard-evidence-ZZ8Ofn`, was created at the timestamp of the first failed 112/113 aggregate and contained only that failed evidence fixture's empty-output artifact. Its resolved absolute path was removed exactly and verified absent. This deletion is not recoverable; no user/project data was present. Older managed-process roots and the shared `aiboard-portable-processes` root were left untouched.

Rollback is the focused Task 7 round-3 commit. Recovery safety does not depend on in-memory state: OCI `creating`/`bound` rows and exact name/ID ownership survive restart; Windows control serialization is in-process only and the durable managed-process supervisor remains authoritative after restart. No Node version pin, Windows-only mandatory semantic, model-authored grant/environment data, public schema change, historical/browser contract change, Task 8 family migration, Git hardening, or filesystem work was introduced.

Residual risk: the first empty evidence inspection could not expose its discarded command error retroactively. The new pre-inspection assertion plus explicit graph closure and five unchanged combined runs make any future recurrence observable and demonstrate stable current behavior.
