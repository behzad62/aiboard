# Task 7 Implementer Report — P6.4e one-shot command routing

Date: 2026-08-29
Base: `8eb593f0`
Scope boundary: canonical Task 7 only. Task 8 managed-process, LSP, MCP, Git, and filesystem family migrations were not started.

## Result

Task 7 routes `process-tools.ts`, `evidence-tools.ts`, and `final-verification-runtime.ts` through one native-factory-owned `OneShotCommandExecutor`, one `SubprocessRuntime`, and one `ExecutionGrantAuthority`. The three production command families contain no private process launch, ambient merge, output-volume kill, PID/tree signal, or lifecycle implementation. Strict profiles fail closed before launch unless the selected OCI provider produces an exact owned/re-attested launch plan; Full remains explicitly and truthfully unconfined.

## Packet audit

### Packet 7.1 — Shared call-scoped executor and native graph

- Added `one-shot-command-executor.ts` as the Runner-private facade over the Task 1–6 runtime, grant authority, Task 2 environment factory, output spool, and isolation selector.
- Exact ToolBroker grant claims bind run/session/actor/tool/call/profile. Final verification may issue only a Runner-internal exact grant; neither path accepts model-authored claims.
- The native factory constructs exactly one grant authority, SQLite subprocess kernel, bounded output factory, and executor per live Build and injects that executor/authority into workers, subagents, evidence tools, process tools, and final verification.
- Startup reconciles the subprocess runtime before drivers. Reverse cleanup revokes command grants, reconciles terminal runtime state, and closes the runtime store before isolation-provider cleanup.
- The subprocess state authentication key is durable, 32 bytes, created exclusively with mode `0600`, and retained for recovery.
- Windows uses the already-approved authenticated Job-backed adapter; POSIX uses the process-group adapter. No Windows-only semantic was added and no Node version pin was introduced.

### Packet 7.2 — Strict OCI launch-plan bridge and single original environment preparation

- Isolation acquire receives only an ephemeral, centrally scrubbed environment snapshot. It is never added to invocation intent, grant claims, durable lease/projection, output, or model-visible results.
- OCI `create` passes only authorized variable names as `--env NAME`; values exist only in the Docker CLI child environment. No `NAME=value` argv is used.
- `prepareExecution` re-attests the OCI CLI bytes, immutable image, durable active lease, provider/grant/invocation identity, labels, and exact owned container. It returns only `<attested CLI> start --attach <exact container ID>`.
- Strict profiles have no original-host-command fallback. Full runs the original invocation and reports `unconfined_explicit_full`.
- Isolation release occurs in `finally` after runtime terminal cleanup. A provider release blocker remains the final typed `isolation_revocation_failed` outcome.

### Packet 7.3 — Process tool migration

- Preserved the public command/input contract and semantic mappings for launch failure, timeout, cancellation, nonzero exit, benchmark policy, and workspace policy.
- Restored `ProcessToolsOptions.maxOutputBytes?` as a compatibility surface; the effective limit is now centrally owned by the shared output policy.
- Added truthful cleanup, lossy-output, enforcement, disclosure, and provider metadata. Output volume/loss alone does not make a command fail.

### Packet 7.4 — Evidence and final-verification migration

- Evidence and final verification reuse a complete runtime spill artifact after validating it exists; otherwise they persist the bounded tail.
- Added optional truthful cleanup/lossy/enforcement/disclosure/provider fields to command evidence facts without changing historical required fields.
- Final-verification command and provisioning call identities are unique by generation/category/ordinal, preventing durable idempotency collisions.
- Removed output truncation/volume as a semantic failure condition. Exit, timeout, cancellation, launch, and cleanup facts retain their established meanings.
- Runtime-smoke/managed-process behavior is not migrated here and remains the Task 8 boundary.

## TDD, prove-red, and fault-injection evidence

1. Process routing natural RED: the injected executor observed zero calls while the old local-spawn path ran. After migration, `process.run routes through the injected shared executor...` was GREEN and asserted one call, bounded/lossy output, verified cleanup, and Full disclosure.
2. Executor bridge natural RED: the shared executor export/API did not exist. GREEN ordering is exactly `isolation -> launch-plan -> runtime-grant -> runtime -> release`.
3. OCI bridge natural RED: `provider.prepareExecution is not a function`. GREEN fake and real tests prove the exact owned plan and re-attestation.
4. Evidence routing natural RED: injected execution observed zero calls. GREEN reuses the complete spill artifact and records lossy metadata without failing the command.
5. Final-verification routing natural RED: existing family tests failed because no injected executor existed. Tests now inject the test-only runtime fixture; production factory injects the shared executor.
6. Native integration RED/repairs:
   - overlong output ownership ID -> ownership IDs are hashed;
   - Windows `=C:` pseudo-environment entry -> the factory snapshot filters invalid variable names before Task 2 policy;
   - reused provisioning invocation ID -> generation/category/ordinal call identity;
   - expected native close order omitted the new `subprocess_runtime` stage -> assertion updated to the new reverse-safe order.
7. Routing guard mutation: temporarily inserted `// fault injection: spawn(` in `process-tools.ts`. Exact static guard RED: `process-tools.ts contains spawn` (exit 1). Reverted; `one-shot-command-routing-static.test.ts` GREEN 2/2.
8. Spill/loss mutation: temporarily forced final command fact `outputLossy: false`. Exact filtered test RED at line 74, `false !== true`, 0/1, exit 1. Reverted; exact filtered test GREEN 1/1 and verified the complete spill bytes plus green command status.
9. Spill lifecycle faults are inherited from the Task 4 bounded-spool prove-red matrix (`spill_open_failed`, `spill_write_failed`, `spill_close_failed`, artifact-ingestion and identity faults). Task 7 family fakes consume the resulting generic lossy disposition; they do not duplicate spill ownership or fault handling.

All temporary production mutations were reverted before final validation.

## Current validation evidence

- `npx tsx --test runner-v2/test/process-tools.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/one-shot-command-executor.test.ts runner-v2/test/one-shot-command-routing-static.test.ts` — 29/29 passed.
- `npx tsx --test runner-v2/test/execution-isolation-provider.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts` — 39/39 passed; all four real Docker tests ran, including the launch-plan environment bridge.
- `npx tsx --test runner-v2/test/native-build-initialization.test.ts runner-v2/test/native-build-capabilities.test.ts runner-v2/test/native-final-verification-factory.test.ts` — 39/39 passed.
- Inherited Task 6/runtime compatibility aggregate — 147/147 passed before the final test-only spill assertion; no production code changed after that gate except restoration of an unused compatibility property.
- `npm run typecheck:runner-v2` — GREEN after repairing the new test helper's `outputLossy` annotation.
- Targeted ESLint across all affected/new source and test files — GREEN.
- `git diff --check` — exit 0; only Git LF-to-CRLF working-copy notices.
- Production-family escape audit:
  `rg -n "\bspawn\s*\(|\bexec\s*\(|taskkill|process\.env|\.kill\s*\(" runner-v2/src/process-tools.ts runner-v2/src/evidence-tools.ts runner-v2/src/final-verification-runtime.ts`
  — no matches (rg exit 1).
- Executor/factory direct-launch audit for `node:child_process`, `spawn`, `exec`, `taskkill`, and direct `.kill` — no matches (rg exit 1). The factory's one central `process.env` snapshot is intentional input to Task 2's scrubber; it is not a family-local or launch-time merge.

## Compatibility decisions

- Tool schemas and existing required evidence fields are unchanged. New result/evidence fields are optional or additive.
- Existing nonzero exits remain factual successes for process/evidence tools; final verification continues to mark them mechanically non-green.
- Existing test-only direct-spawn helper is isolated under `runner-v2/test/support/`; production guards intentionally scope only production command families.
- Existing `maxOutputBytes` option surfaces remain accepted, while the central spool owns the effective 128 KiB tail and 64 MiB spill policy.
- Native execution is never described as confined. Strict enforcement metadata is provider-specific OCI; Full always discloses `unconfined_explicit_full`.

## Cleanup, rollback, and recovery

- Every fixture closes stores, output sessions, workspaces, spawned processes, OCI leases/containers, and temporary roots in `finally`/test cleanup.
- Current Docker query `docker ps -aq --filter label=ai-board.runner-v2.owned=true` returned no containers.
- Targeted temp scan for `aiboard-one-shot-*`, `aiboard-final-verification-*`, `runner-oci-*`, and routed process fixtures returned no entries.
- Rollback is the focused Task 7 commit revert. Durable runtime SQLite/key/output state is deliberately retained for recovery; startup reconciliation resolves owned live state before new work.
- A runtime or provider cleanup blocker is never silently discarded. It remains durable/typed for recovery.

## Residual risk and exclusions

- The OCI real test exercises the exact provider launch plan against Docker; the executor-to-runtime hop is separately covered with an injected runtime because the native backend integration is already covered by Task 1–6 and the native factory aggregate.
- Managed process/runtime-smoke, LSP, MCP, Git, filesystem, and other remaining execution families still use their prior paths and belong exclusively to Task 8 or later work.
- No universal sandbox claim is made: strict enforcement is only the attested provider-specific boundary.

## Literal exit gates

- Task 7 mandatory requirements audited: GREEN.
- Current targeted, integration, static, Docker, type, lint, diff, and residue evidence: GREEN.
- Task 8 boundary preserved: GREEN.
- `PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN` is a phase-owner decision; this report claims Task 7 completion only.
