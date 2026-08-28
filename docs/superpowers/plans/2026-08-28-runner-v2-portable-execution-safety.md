# Runner V2 Portable Execution Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to execute this plan task by task. Check every
> task box only after its current red/revert/green evidence is recorded.

**Goal:** Close every approved P6.4 execution-safety gap so Runner V2 owns child
processes and generated writes through one portable, capability-selected,
fail-closed architecture before P7 qualification.

**Canonical authority:**
`docs/superpowers/plans/2026-08-26-runner-v2-robust-build-improvements.md`,
Task 6, requirements HVI-6A.4 through HVI-6A.8. This file makes P6.4a–P6.4i
dispatchable; it does not replace, weaken, or extend the canonical requirements.

**Architecture:** Model-facing tools, durable schemas, permission semantics, and
recovery remain platform-neutral. A kernel-owned `SubprocessRuntime` composes a
scrubbed child environment, bounded private output spool, durable process store,
and a capability-attested `ProcessBackend`. Generated processes in Guarded and
Project modes additionally require an attested `ExecutionIsolationProvider`
whose exact invocation grant confines writes; Full mode is the only ordinary
unconfined bypass. POSIX process groups/sessions and a Windows backend provide
tree ownership, with Windows Job Objects retained only as an optional stronger
adapter. Docker-compatible OCI execution is the reference portable strict
provider; its executable and image identity are attested and it is never
silently substituted. The trusted filesystem seam independently re-canonicalizes
every mutation and enforces freshness/create-only guards. AI-authored operating
system commands are limited to validated exceptional recovery proposals.

**Tech stack:** Node.js maintained LTS 22 or 24, strict TypeScript ESM, Node test
runner, SQLite-backed Runner state where durable state is required, Git,
Docker-compatible OCI CLI for the optional reference isolation provider, GitHub
Actions Windows/Linux/macOS matrices.

## Non-negotiable execution doctrine

For every task below:

1. PREPARE: record base revision, clean/expected diff, exact assigned
   requirements, affected tests, cleanup targets, and the smallest safe gate.
2. Add or expose the focused regression test and run it to prove red for the
   intended missing behavior. A compilation failure counts only when the test is
   deliberately contract-first and asserts the exact new surface.
3. IMPLEMENT one small coherent packet.
4. Run the exact red check first, then affected tests and static analysis.
5. Audit every assigned requirement. Automatically repair technically
   determinable failures and repeat from the narrowest failed check.
6. Temporarily inject a controlled fault that disables or falsifies each new
   guard, prove the regression test red, revert the fault, and prove green.
7. Run the task's adversarial re-audit, confirm cleanup, record current evidence,
   and commit only the task-owned diff.

Do not rerun the full suite after every repair. Reuse a green result only when
the later diff cannot affect it. Unknown or global impact requires a broader
restart. Do not expand an active task for unrelated findings; record them under
their owning later task unless critical. Do not ask the owner about routine
technical problems. Escalate only for a genuine authority decision, destructive
action, unresolved requirement conflict, unavailable external dependency,
requested control weakening, or exhausted governed repair budget.

Every child-process fixture must close handles, trees, containers, leases,
grants, spill files, and temp roots in `finally`. Tests use external Runner state
and temp roots; they never write generated state into the project.

## Dependency and ownership table

| Task | Canonical packet | Sole owned requirement slice | Depends on |
|---|---|---|---|
| 1 | P6.4a | Threat model, execution-safety types/SPI, durable generic schemas, capability-contract subversion and active-run migration refusal | P6.3 approval |
| 2 | P6.4b | Central child-environment scrub and named credential grants | 1 |
| 3 | P6.4b | Per-stream 128 KiB tail, 64 MiB private spill, lossy continuation and artifact finalization | 1–2 |
| 4 | P6.4c | Durable process store and backend-neutral subprocess lifecycle/orchestration | 1–3 |
| 5 | P6.4c | POSIX and Windows ownership adapters, optional Job enhancement, escalation/quiescence/reconciliation | 4 |
| 6 | P6.4d | Capability discovery, exact call grants, Docker-compatible OCI provider, strict selection, Full disclosure, lease recovery/revocation | 1–5 |
| 7 | P6.4e | Route process.run, evidence commands, and final-verification commands through shared runtime | 6 |
| 8 | P6.4e | Route managed processes, LSP, MCP, Git, and any configured local-provider spawn; close raw-spawn escape routes | 7 |
| 9 | P6.4f | Git indirect-execution and ambient-configuration hardening | 8 |
| 10 | P6.4g | Trusted filesystem mutation fence, revision-required replacement, create-if-absent, alias/race handling | 1, 6 |
| 11 | P6.4h | Bounded AI exceptional recovery, validation/refusal, durable audit and client disclosure | 5–10 |
| 12 | P6.4i | Unified cleanup/recovery, docs, package parity, cross-platform CI and final P6 gate | 1–11 |

Tasks execute strictly in numeric order. They deliberately share protected
interfaces; only one implementer may be active at a time.

### Task 1: P6.4a — Freeze portable execution-safety contracts

**Files:**

- Create `runner-v2/src/execution-safety-contracts.ts`.
- Create `runner-v2/test/execution-safety-contracts.test.ts`.
- Modify `runner-v2/src/runner-capability-contract.ts`.
- Modify `runner-v2/test/runner-capability-contract.test.ts`.
- Modify recovery-focused capability tests that construct historical contracts,
  principally `runner-v2/test/native-build-capabilities.test.ts`.

**Requirements and exact design:**

- [ ] Define closed semantic capability names for tree termination, crash
  cleanup, verified emptiness, and write confinement. Keep capability state
  (`enforced`, `partial`, `unavailable`, `unverified`) distinct from mechanism
  and platform labels.
- [ ] Define immutable/cloneable types for backend/provider attestations,
  invocation intent, exact path access, opaque one-call grants, process birth
  fingerprint, backend identity, generic durable process record, lifecycle and
  escalation history, per-stream output disposition, generic process result,
  isolation lease, cleanup status, and exceptional recovery proposal/outcome.
- [ ] A durable process record includes logical process id, run/task/session and
  invocation identity, root PID when launched locally, birth fingerprint,
  backend id and opaque backend identity, attested capabilities, lifecycle,
  escalation, log/spill artifact identities, and cleanup proof/failure.
- [ ] Values containing native handles, tokens, credential values, or live
  processes are forbidden from durable/model-visible contracts. Opaque grant
  material is Runner-created and call-bound, never accepted from model input.
- [ ] Add `EXECUTION_SAFETY_CONTRACT_VERSION = 1` and an optional historical
  `executionSafetyVersion` field to `RunnerCapabilityContract`. New snapshots
  include it in the digest. Historical clone/read validation accepts its
  absence, while active preparation/recovery rejects missing or unsupported
  execution-safety versions with the existing typed capability-contract pause.
- [ ] Do not key any availability decision to `process.platform` or the phrase
  “Windows Job Object”. Contract tests must prove semantic selection.

**TDD and validation:**

1. Add focused tests for strict parsing/closed keys, clone immutability, durable
   value safety, semantic capability comparison, current digest sensitivity,
   historical read compatibility, and active-run refusal.
2. Run the new test and capability tests red before implementation.
3. Implement only contracts/assertions/clones and capability-version wiring; do
   not spawn or change runtime behavior.
4. Run:
   `npx tsx --test runner-v2/test/execution-safety-contracts.test.ts runner-v2/test/runner-capability-contract.test.ts runner-v2/test/native-build-capabilities.test.ts`
   then `npm run typecheck:runner-v2`.
5. Prove red after implementation by temporarily omitting the new subversion
   from snapshot construction and by accepting an unsupported version; revert
   each fault and rerun the exact tests green.
6. Search the new contract module for `process.platform`, native handles, and
   credential value fields. Exit only with no platform-coupled product contract.

**Done/rollback:** Contract-only diff is current, tests and typecheck are green,
active legacy recovery demonstrably pauses, historical inspection still works,
and reverting this commit restores the pre-P6.4 schema without data migration.

### Task 2: P6.4b — Centralize child-environment scrubbing

**Files:**

- Create `runner-v2/src/child-environment.ts`.
- Create `runner-v2/test/child-environment.test.ts`.
- Modify `runner-v2/src/execution-safety-contracts.ts` only if the Task 1 type
  requires a proven compatibility correction.
- Reuse `runner-v2/src/sensitive-redaction.ts`; do not create a competing secret
  classifier.

**Requirements:**

- [ ] Build one environment constructor used later by every child family. It
  starts from an explicit ambient source, removes credential-shaped names using
  `isSensitiveKey`, removes Runner control/auth/internal names, and then applies
  safe explicit overrides.
- [ ] A named credential grant may restore only its named variables from a
  Runner-private resolver. Reject caller/model supplied values and mismatched,
  expired, wrong-run, wrong-call, or duplicate grants.
- [ ] Persist/log only inherited names, removed names, explicit safe names,
  granted names, and decisions. Never return, hash, stringify, or durable-log
  secret values.
- [ ] Preserve platform necessities such as executable search and temp/home
  variables unless they are sensitive; use case-insensitive key comparison on
  Windows semantics without changing the public contract.

**TDD and validation:**

1. Prove red with fixtures containing fake API keys, tokens, auth headers,
   Runner auth/state variables, mixed-case names, safe PATH/TMP values, hostile
   explicit overrides, and valid/invalid named grants.
2. Implement the pure constructor and private resolver interface.
3. Run `npx tsx --test runner-v2/test/child-environment.test.ts` and
   `npm run typecheck:runner-v2`.
4. Fault-inject a credential-shaped allow-through and a value-bearing audit
   record; prove the focused tests red, revert, and prove green.
5. Search production spawn sites and record them for Tasks 7–8; this task does
   not partially rewire one family.

**Done/rollback:** Pure environment behavior is green, audits contain names only,
no existing spawn behavior changed, and no test leaves a real secret in output.

### Task 3: P6.4b — Add bounded private output tail and spill

**Files:**

- Create `runner-v2/src/bounded-output-spool.ts`.
- Create `runner-v2/test/bounded-output-spool.test.ts`.
- Modify `runner-v2/src/artifact-store.ts` only through its existing public
  artifact ingestion contract if spill finalization needs it.

**Requirements:**

- [ ] Maintain independent stdout/stderr rolling tails of exactly 128 KiB each
  by default, measured in bytes without splitting retained byte order.
- [ ] Privately spill each stream up to exactly 64 MiB by default, with
  create-exclusive files outside the project, restrictive permissions where
  supported, deterministic close/finalization, and optional artifact ingestion.
- [ ] After cap exhaustion or spill open/write/close failure, continue draining
  the child, retain a bounded marked tail, set `lossyOutput` and a typed reason,
  and never terminate or reclassify the command solely for output volume.
- [ ] Return/persist byte counts, tail truncation, spill state, artifact id, and
  loss reason—not spill filesystem paths. Cleanup is idempotent after success,
  error, cancellation, and restart.

**TDD and validation:**

1. Red tests cover multibyte chunks, interleaved streams, memory rollover,
   >64 MiB continuation, spill permission/open/write/close faults, artifact
   finalization, and repeated cleanup.
2. Implement the spool independently of process ownership.
3. Run `npx tsx --test runner-v2/test/bounded-output-spool.test.ts` and typecheck.
4. Temporarily restore “throw/kill on cap” and suppress `lossyOutput`; prove red,
   revert, and prove green.
5. Inspect temp roots after tests and prove no spill remains.

**Done/rollback:** Exact limits and lossy continuation are proven without a
child process, artifact integration is bounded, and all temp material is gone.

### Task 4: P6.4c — Implement backend-neutral durable subprocess runtime

**Files:**

- Create `runner-v2/src/process-backend.ts`.
- Create `runner-v2/src/subprocess-runtime.ts`.
- Create `runner-v2/src/durable-process-store.ts`.
- Create `runner-v2/test/process-backend-contract.test.ts`.
- Create `runner-v2/test/subprocess-runtime.test.ts`.
- Create `runner-v2/test/durable-process-store.test.ts`.
- Reuse existing Runner state/database conventions; do not persist into a
  project or worktree.

**Requirements:**

- [ ] `ProcessBackend` owns probe/attestation, launch, observe, signal/escalate,
  verify-empty, reconcile, and release. The runtime chooses by required semantic
  capabilities, never OS name alone, and refuses false/unverified claims.
- [ ] `SubprocessRuntime` is the only future orchestration seam: validate
  invocation/grant, construct the scrubbed environment, create durable intent
  before launch, bind returned birth/backend identity before reporting started,
  drain through the bounded spool, apply cancellation/timeout escalation, await
  verified quiescence, finalize output, and persist terminal cleanup.
- [ ] Lifecycle is deterministic: `prepared → launching → running → stopping →
  exited → verifying_empty → cleaned`, with typed `launch_not_proven`,
  `orphaned`, `identity_mismatch`, `backend_unavailable`, `outcome_unknown`, and
  cleanup-blocked paths. Illegal transitions fail closed.
- [ ] Exact invocation ids make restart/retry idempotent. Missing opaque identity
  or birth mismatch never authorizes a signal. Result precedence is start error,
  timeout/cancel, cleanup failure, then child exit; output volume never wins.
- [ ] Store writes are durable and atomic under existing Runner conventions;
  historical observation is read-only and startup reconciliation is explicit.

**TDD and validation:**

1. Build a deterministic fake backend and clock. Prove red for durable-before-
   launch ordering, crash points, duplicate invocation, cancellation, timeout,
   missing identity, PID reuse, false capability claim, backend disappearance,
   lossy output, quiescence failure, and restart reconciliation.
2. Implement only backend-neutral runtime/store; no production OS adapter yet.
3. Run the three focused tests and typecheck.
4. Fault-inject signal authorization by PID alone and terminal success before
   verify-empty; prove red, revert, and prove green.
5. Audit durable records for secrets, handles, and host spill paths.

**Done/rollback:** The fake-backend contract proves all lifecycle invariants,
state lives outside the project, and no existing process family is rewired yet.

### Task 5: P6.4c — Add portable local ownership adapters and reconciliation

**Files:**

- Create `runner-v2/src/posix-process-backend.ts`.
- Create `runner-v2/src/windows-process-backend.ts`.
- Refactor the reusable Windows supervisor/Job implementation from
  `runner-v2/src/managed-process.ts` and `runner-v2/src/windows-job-host.ts`
  behind the backend interface without making Job support mandatory.
- Create `runner-v2/test/posix-process-backend.test.ts`.
- Create `runner-v2/test/windows-process-backend.test.ts`.
- Extend `runner-v2/test/process-backend-contract.test.ts` and
  `runner-v2/test/subprocess-runtime.test.ts`.

**Requirements:**

- [ ] POSIX launches a new session/process group, records a birth fingerprint
  independent of PID, signals only the owned group after identity validation,
  escalates TERM then KILL on bounded deadlines, and verifies no owned members.
- [ ] Windows baseline uses deterministic supervisor ownership and birth
  fingerprinting. Job Object support is an optional capability enhancement for
  descendant/crash cleanup; its absence is reported honestly and never makes
  the model tool Windows-specific.
- [ ] Managed/LSP availability later depends on requested semantic capability,
  not `process.platform` or Job availability.
- [ ] Restart reconciliation distinguishes no launch, live owned tree, naturally
  exited tree, identity mismatch/recycled PID, missing backend, unknown outcome,
  and verified-empty cleanup. Routine recovery uses no model call.
- [ ] Host crash cleanup is attested only where the active adapter can guarantee
  it; otherwise the capability is partial/unavailable and strict selection must
  not overclaim.

**TDD and validation:**

1. Use contract fixtures plus host-specific fixtures. Mandatory faults: a
   surviving grandchild, TERM-ignoring tree, launcher exit before descendant,
   timeout, cancellation, restart, recycled PID/birth mismatch, missing opaque
   identity, unavailable Job enhancement, and failed quiescence verification.
2. Run platform-neutral contracts on every host; run only applicable native
   fixtures locally with explicit skip reasons for the other adapter.
3. Run focused tests, existing managed-process ownership tests, and typecheck.
4. Temporarily signal by root PID only and accept empty by launcher exit; prove
   the relevant fixtures red, revert, and prove green.
5. Inspect the host process list after tests; no fixture process/supervisor may
   remain.

**Done/rollback:** Current-host adapter is green, the non-current adapter passes
contract/static tests, capability claims are honest, and optional Job code is
isolated behind the same SPI.

### Task 6: P6.4d — Add attested isolation selection and exact invocation grants

**Files:**

- Create `runner-v2/src/execution-grants.ts`.
- Create `runner-v2/src/execution-isolation-provider.ts`.
- Create `runner-v2/src/oci-execution-isolation-provider.ts`.
- Create `runner-v2/test/execution-grants.test.ts`.
- Create `runner-v2/test/execution-isolation-provider.test.ts`.
- Create `runner-v2/test/oci-execution-isolation-provider.test.ts`.
- Modify `runner-v2/src/agent-contracts.ts` and
  `runner-v2/src/tool-broker.ts` to attach a Runner-created opaque grant after
  authorization.
- Modify `runner-v2/src/runner-capabilities-config.ts`, its tests, CLI/native
  factory wiring, and capability projection to support optional configured OCI
  providers without auto-installing or silently discovering unapproved tools.

**Requirements:**

- [ ] ToolBroker canonicalizes the authorized workspace and requested path
  accesses at call time and issues one non-forgeable grant bound to run,
  session, actor, tool, call, permission profile, exact roots/access modes,
  external/destructive decisions, expiry, and nonce. The grant is consumed once
  and revoked/fails closed on completion, cancellation, timeout, restart, or
  mismatch.
- [ ] Guarded/Project generated processes require a provider attested as
  enforcing write confinement for the exact grant. An unavailable, partial,
  broken, dishonest, or expired provider fails before launch with a typed pause;
  local native execution is never called confined.
- [ ] Full is the only ordinary unconfined bypass. Its durable result explicitly
  says `unconfined_explicit_full`; environment scrubbing, output bounds,
  ownership, and cleanup still apply.
- [ ] Reference OCI provider supports an explicitly configured absolute Docker-
  compatible CLI and image. Attest canonical executable identity and immutable
  image id/digest before use; create a unique labelled container/lease; mount
  only the task workspace and exact approved roots with correct read/write mode;
  use no privileged mode, host PID namespace, host Docker socket, or implicit
  host credentials; translate cwd and exact path arguments conservatively; and
  reject unrepresentable grants before launch.
- [ ] Network defaults to disabled unless the authorized access request and
  configured provider policy explicitly grant it. Provider absence remains a
  normal typed capability-unavailable state, not an installation attempt.
- [ ] Startup lists labelled owned leases, validates identity/scope, cleans or
  reports them, and revokes grants. Provider/container claims and enforcement
  state are durable and user-visible without claiming a universal container or
  security boundary.

**TDD and validation:**

1. Fake-provider tests prove selection by semantic capability, one-call
   consumption, path escalation denial, wrong-call/run denial, expiry,
   unavailable/broken/partial/false claims, Full disclosure, revocation failure,
   and restart cleanup.
2. OCI tests use a fake CLI for exact argv/mount/label assertions and, when a
   Docker daemon is available, one real fixture that attempts an outside write,
   symlink escape, grant escalation, network access without grant, and surviving
   child/container cleanup.
3. Run focused tests, ToolBroker/CLI/capability tests, and typecheck.
4. Fault-inject a broad parent mount and label native execution “confined”;
   prove red, revert, and prove green.
5. List owned containers and grant/lease state after tests; nothing may remain.

**Done/rollback:** Strict profiles fail closed or run through a truthful attested
provider, Full is explicit, Docker integration is real when available, and all
leases/grants clean up. Provider config is optional and backwards-readable.

### Task 7: P6.4e — Route one-shot, evidence, and verification commands

**Files:**

- Modify `runner-v2/src/process-tools.ts` and its tests.
- Modify `runner-v2/src/evidence-tools.ts` and its tests.
- Modify `runner-v2/src/final-verification-runtime.ts` and focused runtime tests.
- Modify native factory/runtime construction to inject one shared
  `SubprocessRuntime` and call-scoped grant/provider context.

**Requirements:**

- [ ] Remove local spawn, ambient environment merge, output-kill, direct PID
  signal, and private lifecycle logic from these three families. Retain only
  input validation, protocol/result mapping, evidence/artifact framing, and
  family-specific policy.
- [ ] Every invocation uses the generic durable identity/result/output schema,
  exact authorization grant, scrubbed environment, bounded tail/spill,
  deterministic tree cancellation/timeout, verified cleanup, and isolation
  selection appropriate to the permission profile.
- [ ] Preserve public tool schemas and established semantic exit/error mapping
  except for new truthful cleanup/lossy/enforcement metadata and typed
  capability-unavailable outcomes.
- [ ] Evidence/final-verification artifacts ingest complete spill output when
  available and bounded tails otherwise; log volume alone never fails the
  command.

**TDD and validation:**

1. Adapt existing tests through injected fake runtime; first prove old direct
   spawn behavior fails new environment/output/ownership assertions.
2. Add per-family real fixtures for fake inherited secrets, >tail output,
   >spill output, spill fault, surviving/TERM-ignoring grandchild, timeout,
   cancellation, restart/outcome unknown, strict provider unavailable, and Full
   disclosure.
3. Run exact affected tests and typecheck; run final-verification integration
   tests only after focused runtime tests pass.
4. Temporarily bypass the runtime in one family and prove its routing assertion
   red; revert and prove green.
5. Search these modules for `spawn(`, `exec(`, `taskkill`, ambient `process.env`,
   and direct `.kill(`; no production escape remains.

**Done/rollback:** All three families retain behavior through shared primitives,
their targeted regressions are green, and no fixture process/spill remains.

### Task 8: P6.4e — Route managed, LSP, MCP, Git, and local-provider processes

**Files:**

- Modify `runner-v2/src/managed-process.ts` and tests.
- Modify `runner-v2/src/lsp-client.ts` and tests.
- Modify `runner-v2/src/mcp-tools.ts` and tests.
- Modify `runner-v2/src/git-command.ts` and repository tests.
- Modify any configured local-provider transport found by the required spawn
  inventory; if none exists, record the negative audit in the execution ledger.
- Delete duplicated lifecycle/environment/output code only after each family is
  green through the shared runtime.

**Requirements:**

- [ ] Managed processes retain durable background observation, handshakes,
  authenticated stop, and restart behavior while delegating all ownership,
  identity, escalation, environment, output, and cleanup to shared primitives.
- [ ] LSP and MCP retain JSON-RPC/stdio framing, backpressure, protocol timeouts,
  restart limits, executable attestation, and graceful protocol shutdown; their
  OS process lifecycle is shared. Availability follows semantic capabilities.
- [ ] Git retains its typed runner interface; execution moves to the shared
  runtime now, with indirect-execution hardening owned by Task 9.
- [ ] Configured local provider children, if any, use the same environment,
  bounds, ownership, cancellation, and cleanup. Account/network transports that
  do not spawn are not altered.
- [ ] No production child launch remains outside approved adapter/provider host
  internals. A static audit allowlist names those internals exactly.

**TDD and validation:**

1. Migrate one family at a time in this order: Git, MCP, LSP, managed, then any
   local provider. Run its exact failed checks before the next family.
2. Mandatory faults across families: partial frames/backpressure, timeout,
   cancellation, protocol shutdown refusal, crash/restart, launcher exit with
   child alive, PID reuse, backend disappearance, output loss, and spill failure.
3. Run all affected family tests and typecheck.
4. Temporarily reintroduce one raw spawn outside the allowlist; prove the static
   guard red, revert, and prove green.
5. Inspect processes, ports, supervisors, spills, and state after tests.

**Done/rollback:** Every local child family is routed, framing semantics remain
green, static raw-spawn audit has a minimal adapter-only allowlist, and cleanup
is empty.

### Task 9: P6.4f — Harden the Git indirect-execution boundary

**Files:**

- Create `runner-v2/src/git-execution-policy.ts`.
- Create `runner-v2/test/git-execution-policy.test.ts`.
- Modify `runner-v2/src/git-command.ts`, `git-preflight.ts`,
  `git-repository.ts`, and affected worktree/integration/recovery Git tests.

**Requirements:**

- [ ] Every Runner Git invocation uses the central runner and an explicit safe
  environment/config baseline. Disable system/global/repository configuration
  where safe, hooks, credential helpers/prompts, fsmonitor, external diff,
  textconv, filters, pager/editor, SSH command overrides, and other indirect
  program execution. Allow only narrowly enumerated Runner-required config.
- [ ] Repository-controlled hooks, attributes, config includes, submodule/custom
  update commands, aliases, diff drivers, filters, and helpers cannot cause an
  out-of-bound process or outside write during Runner operations.
- [ ] Commands that inherently require an unsafe repository-controlled feature
  fail typed before side effects; do not silently run unconfined.
- [ ] Git subprocesses still use shared environment/output/ownership/isolation
  and exact grant semantics. Git absence remains a pre-model fatal prerequisite.

**TDD and validation:**

1. Create isolated malicious repositories with hook, clean/smudge/process
   filter, credential helper, fsmonitor, external diff/textconv, include.path,
   pager/editor, alias and submodule/update attempts. Each writes a sentinel or
   launches a helper; prove old behavior red where reachable and new behavior
   leaves all sentinels absent.
2. Run focused Git policy/repository/worktree/integration tests and typecheck.
3. Fault-inject removal of one hardening config/env setting; prove the matching
   sentinel test red, revert, and prove green.
4. Audit all Git call sites for central runner use and all temp repos/processes.

**Done/rollback:** Required Runner Git workflows pass, every hostile fixture is
inert, Git still fails early when missing, and no outside sentinel/helper remains.

### Task 10: P6.4g — Add the trusted filesystem mutation fence

**Files:**

- Create `runner-v2/src/filesystem-mutation-fence.ts`.
- Create `runner-v2/test/filesystem-mutation-fence.test.ts`.
- Modify `runner-v2/src/filesystem-tools.ts` and its tests.
- Modify `runner-v2/src/tool-broker.ts`/grant integration only if required to
  pass the already-authorized exact path/access to the trusted seam.

**Requirements:**

- [ ] Immediately before every write, patch, create, move, and delete, resolve
  the actual parent/target through platform-appropriate handle/canonical-path
  checks, revalidate workspace/grant containment, reject symlink/junction/reparse
  escapes and path substitution, and refuse hard-link residual risk where
  confinement cannot be proven.
- [ ] Existing-file text replacement requires the SHA-256 observed by the
  caller’s prior read/inspection. Missing or stale revisions fail typed. Patch
  keeps the same rule.
- [ ] New file creation is atomic create-if-absent (`wx`/equivalent); it never
  overwrites. Move destinations are create-only and source/destination are both
  fenced. Delete acts only on the exact revalidated identity.
- [ ] Preserve atomic temp-write/rename only when target identity, parent
  identity, grant, and replacement revision remain valid at the final seam.
- [ ] State honestly that user/external writers outside Runner control can race
  between validation and the OS mutation; do not call the implementation atomic
  CAS. Detect and reject every race the available primitives expose.

**TDD and validation:**

1. Red fixtures cover missing/stale expected hash, create race, overwrite
   attempt, parent swap, target symlink, directory junction/reparse alias,
   symlink retarget, hard link outside workspace, move/delete alias, one-call
   grant escalation, and a controlled external writer race demonstrating the
   documented non-CAS limitation.
2. Implement the fence as the sole last-mile mutation seam and route every
   mutator through it.
3. Run focused filesystem/fence/ToolBroker tests and typecheck on the current
   host; retain portable contract tests for other hosts.
4. Temporarily replace re-canonicalization with lexical `resolve` and allow
   create overwrite; prove fixtures red, revert, and prove green.
5. Inspect temp roots and outside sentinels; cleanup only owned fixture paths.

**Done/rollback:** All mutations are fenced, replacement/create semantics are
strict and documented honestly, no alias fixture escapes, and reads remain
backward compatible while mutation callers receive typed migration errors.

### Task 11: P6.4h — Bound exceptional AI recovery and disclose enforcement

**Files:**

- Create `runner-v2/src/process-recovery.ts`.
- Create `runner-v2/test/process-recovery.test.ts`.
- Modify scheduler/native runtime event contracts and SQLite persistence for
  durable recovery proposals, validation outcomes, and user-decision pauses.
- Modify `runner-v2/src/build-observability.ts`,
  `runner-v2/src/control-server.ts`, their tests, `lib/client/runner-v2.ts`, and
  `scripts/test-runner-v2-observability.mts`.

**Requirements:**

- [ ] Routine launch, stop, timeout, cancellation, crash cleanup, lease
  revocation, and restart reconciliation are deterministic and never invoke a
  model.
- [ ] AI-authored commands are accepted only as exceptional proposals for
  `orphaned`, `identity_mismatch`, `backend_unavailable`, or `outcome_unknown`.
  Reject proposals for routine states before any model/command execution.
- [ ] Runner independently validates the recorded process birth fingerprint,
  opaque backend identity, run/task/invocation scope, current ownership,
  requested targets, exact authority, command bounds, expiry, and capability
  need. A recycled PID, broadened target, stale proposal, ambiguous outcome, or
  destructive/authority-expanding action is denied or becomes an exact
  user-decision pause.
- [ ] Proposals and validation/audit persist command/argument fingerprints and
  redacted summaries, never credentials. Executing an approved proposal still
  uses the shared runtime and applicable isolation/grant policy.
- [ ] Observability/API/client expose active backend/provider, semantic
  capabilities and enforcement states, Full bypass, output loss, cleanup proof
  or blocker, isolation lease/grant state, and exceptional recovery status.
  Partial/unavailable/unverified is never described as confined.

**TDD and validation:**

1. Red tests cover attempted routine AI cleanup, each eligible exceptional
   state, recycled PID, missing identity, wrong run/task/call, broadened scope,
   expired proposal, destructive authority requirement, model failure, backend
   recovery during proposal, idempotent replay, and secret redaction.
2. Add observability/control/client projection tests for every enforcement and
   cleanup state, including restart persistence.
3. Run focused recovery/scheduler/SQLite/API/client tests and typecheck.
4. Fault-inject routine-state acceptance and PID-only validation; prove red,
   revert, and prove green.
5. Audit that no ordinary lifecycle path references the model runtime.

**Done/rollback:** Exceptional recovery is narrow, independently validated and
audited; genuine destructive ambiguity pauses for the user; ordinary recovery
remains model-free; client disclosure is truthful and backwards-readable.

### Task 12: P6.4i — Finish cleanup, packaging, CI, and the P6 exit gate

**Files:**

- Modify startup/shutdown composition in `runner-v2/src/cli.ts`, native factory,
  and manager/runtime cleanup surfaces.
- Update Runner guide and architecture/security documentation that describes
  process ownership, confinement, Full bypass, filesystem freshness, OCI
  configuration, cleanup, and limitations.
- Modify `runner-v2/package.json`, root package/archive scripts and package tests
  only as required to ship every new runtime/helper artifact on both maintained
  Node LTS lines; retain `>=22.13.0 <23 || >=24.0.0 <25` and never pin 24.18.0.
- Create `.github/workflows/runner-v2-portable-execution.yml` with Windows,
  Linux, and macOS contract/native-adapter jobs and maintained Node 22/24 package
  gates; include one Linux Docker OCI integration job.
- Add/modify cleanup, recovery smoke, package parity, and static spawn-audit
  tests.

**Requirements:**

- [ ] Startup reconciles processes, backends, OCI leases/containers, grants,
  spills, and temp roots before accepting new work. Shutdown closes/revokes in
  reverse ownership order and reports typed blockers; it never falls back to an
  ambient spawn or model-authored routine cleanup.
- [ ] Repeated cleanup is idempotent. A phase requiring proven cleanup closes
  only after selected backends/providers verify empty or persist a typed
  blocking failure/user pause.
- [ ] Archives contain all required platform-neutral modules and only the
  intended optional platform helpers; installed-package smoke matches source.
- [ ] CI runs portable contract tests on Windows/Linux/macOS, current native
  adapter tests on each host, maintained Node 22 and 24 gates, and a real
  attested Docker provider integration. Node patch 24.18.0 is evidence only,
  never a requirement.
- [ ] Documentation describes capability selection, exact grants, strict
  fail-closed behavior, explicit Full bypass, optional Job enhancement,
  configured OCI dependency, bounded output/loss, exceptional AI recovery, and
  filesystem external-TOCTOU limitation without overclaiming containment.

**Final verification and prove-red gate:**

1. Add cleanup/package/CI/static tests red, implement the final wiring, and run
   exact failed checks first.
2. Prove red by temporarily excluding one required archive file, allowing one
   raw spawn, falsifying one capability, leaking one spill/container, and
   accepting a legacy active contract; revert each fault and prove its exact
   guard green.
3. Run targeted ESLint for changed source/client files and
   `npm run typecheck:runner-v2`.
4. Run the complete `npm run test:runner-v2` gate only after all targeted checks
   are current and green.
5. Build reproducible Runner archives twice and compare their manifests/hashes;
   run installed-package smoke under available maintained Node LTS runtimes.
6. Run current-host Git preflight, external Runner-state/temp-root validation,
   native tree/cleanup inspection, and real Docker isolation inspection. Confirm
   no residual process, supervisor, helper, port, container, lease, grant,
   spill, temp file, outside sentinel, or modified project state.
7. Review CI workflow syntax and ensure the matrix will exercise both other
   platforms. Local evidence cannot be mislabeled as remote CI evidence; P6 may
   close only when required CI results are actually available and green.
8. Perform a final adversarial requirement-to-diff audit of HVI-6A.4–HVI-6A.8,
   inspect `git diff`/status, and obtain an independent final code review. Repair
   determinable findings through exact affected gates before one final broad
   rerun if impact is global.

**Rollback/recovery:** Roll back only to the last verified packet commit; retain
the DeepSeek capability audit and canonical plan. Clean only positively owned
P6.4 state. If a required external CI/OCI dependency is unavailable after local
implementation and fixture verification, persist the exact blocker and keep P7
locked rather than weakening the gate.

**Definition of Done:** Every task requirement and canonical P6 acceptance
criterion has current evidence; maintained Node 22/24, package parity,
Windows/Linux/macOS CI, real isolated-executor integration, full Runner/client
gate, cleanup inspection, prove-red/revert/green injections, and independent
adversarial review are green. The only valid successful outcome is:

`PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN`

Otherwise stop only with:

`PHASE BLOCKED — GENUINE USER DECISION REQUIRED`
