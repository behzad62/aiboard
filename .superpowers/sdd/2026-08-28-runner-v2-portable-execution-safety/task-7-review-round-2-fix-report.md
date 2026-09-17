# Task 7 review round 2 fix report

Date: 2026-08-29
Reviewed base: `9671af079e22c2397998a2967ae5d7ad303d35e5`
Scope: the two Important round-2 findings and their concurrency evidence only. Task 8 was not started.

## OCI deletion-fault ownership packet

The acquire sequence is now: create the exact labelled container; validate its returned identity; durably persist the lease, container identity, cleanup stage, and private handoff path (never the handoff values); delete the handoff; durably clear its path; then return the lease. A handoff deletion failure moves the durable record to `cleanup_started`, attempts compensating `rm --force`, records `cleaned_pending_ack` on success, and throws typed `oci_recovery_blocked`. If compensation also fails, `cleanup_started` plus the exact handoff/container identity remains recoverable. Recovery retries handoff deletion and container cleanup, emits exactly one transition, and acknowledgement removes the tombstone. No successfully created container crosses the failure boundary without durable ownership.

Durable handoff paths are closed to the exact provider-state `environment-handoffs` directory and UUID filename grammar before recovery may delete them. Forged external paths fail before any CLI or filesystem effect. Success and both injected failure modes end with lease state `[]`, no handoff directory, and no container. Secret values never enter durable state.

Executable vulnerable-ordering mutation command (the mutation removed durable ownership before cleanup):

`npx tsx --test --test-name-pattern "OCI deletion faults" runner-v2/test/oci-execution-isolation-provider.test.ts`

RED result: 0/3 with both subcases reporting `created effect is durably owned` as false. The mutation was reverted; GREEN was 3/3, 0 failed. During implementation, the first recovery run was 1 pass / 2 fail and exposed omitted-list blocking; the next was 0 pass / 3 fail and exposed stale-map duplicate transitions. Rebuilding recovery identity maps from the updated durable rows closed both issues. Final targeted command:

`npx tsx --test --test-name-pattern "OCI deletion faults|OCI durable lease ingestion" runner-v2/test/oci-execution-isolation-provider.test.ts`

Result: 4/4 GREEN, 0 failed, including the forged handoff-path regression.

Forged-path mutation proof used:

`npx tsx --test --test-name-pattern "OCI durable lease ingestion" runner-v2/test/oci-execution-isolation-provider.test.ts`

With the closed path predicate disabled, RED was 0/1 with `Missing expected rejection`; the forged external recovery path was accepted and could remove the UUID-named sentinel. The mutation was reverted. The combined ingestion/deletion command above returned GREEN 4/4; invalid durable state now fails before CLI/filesystem effects, its exact bytes remain unchanged, and the external sentinel remains `must-not-delete`.

## Actual family-entry production matrix packet

The former relabelled `internalExecution.execute` matrix was replaced:

- Process: `ToolBroker.invoke` -> `createProcessTools` / `process.run` -> exact broker grant -> shared production executor/runtime.
- Evidence: `ToolBroker.invoke` -> `createEvidenceTools` / `run_evidence_command` -> exact broker grant -> shared production executor/runtime -> persisted public evidence fact mapping.
- Final verification: `FinalVerificationRuntime.run` -> Runner-owned production executor boundary -> shared runtime -> public command fact mapping. Final verification has no model/public execution-grant API, so cancellation and restart faults are injected at the production runtime/backend seam after entry through `run`.

All adapters use UUID-unique run, session, worker, call, backend, repository, state, and temporary identities and explicitly close their family stores/workspaces before closing the shared runtime graph. Every family covers: timeout after proved launch, cancellation, surviving TERM-ignoring grandchild death, strict provider unavailable before launch, initial cleanup failure mapping, and restart `outcome_unknown` cleanup ownership.

Initial command:

`npx tsx --test runner-v2/test/one-shot-command-family-production-matrix.test.ts`

Natural RED progression: import/API correction 0/1; first adapters 4/12; corrected broker approval and final-plan contract 9/12; corrected public initial-cleanup mapping 12/12 GREEN. Final current result after timeout-bound repair: 12/12 GREEN, 0 failed, duration 31.02s.

The timeout deadline begins before the Windows supervisor's bounded 5-second launch handshake. A 350ms and then 1s fixture deadline raced identity binding under aggregate load. The final 6.5s deadline is above that handshake bound and still forces the TERM-ignoring command to time out. Each family asserts the public `timed_out` mapping, `verified_empty` cleanup, a readable descendant PID marker (launch identity proved), and that the descendant is dead.

## Concurrency/interference proof

Required exact command:

`node --import tsx --test runner-v2/test/one-shot-command-executor.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/one-shot-command-routing-static.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/windows-process-backend.test.ts`

The reviewed baseline was 96/98 with `read ECONNRESET` and native identity mismatch. UUID-scoped identities and deterministic graph closure eliminated shared name/state reuse. A 350ms diagnostic sequence produced two GREEN runs then one evidence timeout race; a 1s sequence produced one GREEN then the same pre-bind race. After setting the deadline above the documented supervisor handshake bound, three consecutive unchanged runs were:

1. 101/101 GREEN, 0 failed/skipped, 59.24s.
2. 101/101 GREEN, 0 failed/skipped, 59.77s.
3. 101/101 GREEN, 0 failed/skipped, 59.99s.

No internal-executor relabelling remains in the matrix. The only non-model execution seam is explicitly named `runnerOwnedExecution` and is reached only after entering `FinalVerificationRuntime.run`.

## Final gates and exact commands

`npx tsx --test runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/one-shot-command-routing-static.test.ts`

Result: 20/20 GREEN, 0 failed/skipped, 8.50s. This includes four live Docker fixtures, both deletion-fault cases, forged-state ingestion, and native-factory shared-graph guard.

`npm run typecheck:runner-v2`

Result: GREEN, zero diagnostics.

`npx eslint runner-v2/src/oci-execution-isolation-provider.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/support/one-shot-command-executor.ts`

Result: GREEN, zero diagnostics.

`rg -n 'node:child_process|child_process|\b(spawn|spawnSync|exec|execFile|execFileSync|fork)\s*\(|process\.env|\.kill\s*\(|taskkill' runner-v2/src/process-tools.ts runner-v2/src/evidence-tools.ts runner-v2/src/final-verification-runtime.ts`

Result: zero production escapes. Residue probes found zero `ai-board.runner-v2.owned=true` containers and zero live named matrix processes. OCI and matrix assertions prove their private handoff, workspace, DB, spill, artifact, process-handle, and temporary roots are removed in success/failure `finally` paths.

## Compatibility, recovery, rollback, and boundary

No public tool schema, grant claim, model-visible contract, environment policy, or platform requirement changed. The new OCI option is an injected private-file cleanup dependency used for deterministic faults; the default remains the portable exclusive-file implementation. Full disclosure and strict no-host-fallback behavior are unchanged. Rollback is the focused round-2 commit. Recovery stays reverse-safe and truthfully blocks until both handoff and container cleanup are proven. Task 8 remains untouched.
