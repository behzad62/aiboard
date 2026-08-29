### Task 8: P6.4e — Route managed, LSP, MCP, Git, and local-provider processes

**Canonical authority:**

- `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md`,
  Task 8, remains authoritative.
- Entry base is `a0b3fb7a` (Task 7 final approval); Task 7 implementation ends at
  `30e8b8ff`.
- Task 8 executes one family at a time in the mandatory order Git → MCP → LSP
  → managed → configured local provider/static closure. Only one implementer
  may modify the shared execution interfaces.

**Entry conditions:**

- Task 7 is independently approved with zero Critical/Important findings.
- The worktree is clean; Runner state is outside the project.
- Node policy remains maintained Node 22 or 24, never an exact patch pin.
- Existing terminal `OneShotCommandExecutor`, `SubprocessRuntime`, grant,
  environment, output, backend, provider, and isolation contracts are current
  and must remain backwards compatible.

**Files and system surfaces:**

- Modify `runner-v2/src/git-command.ts`, `git-preflight.ts`, their callers, and
  focused repository/baseline/workspace/integration tests.
- Modify `runner-v2/src/mcp-tools.ts`, CLI/factory ownership, worker/architect/
  subagent wiring, and MCP tests/fixtures.
- Modify `runner-v2/src/lsp-client.ts`, executable discovery, language provider
  router/factory/capability construction, and LSP/provider tests.
- Modify `runner-v2/src/managed-process.ts`, native factory ownership,
  observability/recovery consumers, Windows adapter integration, and managed
  process/backend tests.
- Modify `execution-grants.ts`, `execution-isolation-provider.ts`,
  `process-backend.ts`, and `subprocess-runtime.ts` only through backwards-
  compatible additions required by the session-authority/streaming contracts.
- Add Runner-private versioned session-authority, streaming-session
  contract/store/runtime, and host/run-binding modules with focused tests.
- Modify native/POSIX/Windows backends, portable supervisor/channel hosts, and
  `oci-execution-isolation-provider.ts` for the optional interactive channel
  capability and exact recovery semantics.
- Mandatorily extract the authenticated low-level Windows Job host/service from
  `ManagedProcessService`. `WindowsJobObjectProcessBackend` depends only on
  that host; product `ManagedProcessService` becomes a portable shared-session
  facade and is unreachable from backend internals.
- Modify CLI, control server, native factory, capability construction,
  `code-intelligence-tools.ts`, `filesystem-tools.ts`, language-provider
  context/router surfaces, MCP configuration/capability snapshots, and
  executable-identity modules so exact authority reaches every launch/restart.
- Include `.ps1`/launcher hosts, package/entrypoint launch surfaces, and their
  tests in the inventory and static guard.
- Add a whole-Runner production child-launch static guard and exact allowlist.

**Required negative audit:**

- No configured local model/provider transport currently spawns a child.
  Provider transport kinds are account runner and HTTP-based OpenAI-compatible,
  Anthropic, and Google transports. Record and re-verify this negative audit;
  do not alter non-spawning account/network transports.

**Explicit exclusions:**

- Task 9 owns Git indirect-execution/config/hook/filter/helper hardening. Task 8
  only moves Git execution to shared primitives while preserving the typed Git
  runner interface.
- Task 10 filesystem mutation fencing, Task 11 exceptional AI recovery, Task 12
  packaging/docs/cross-platform CI, and the real-project P7 proof are excluded.
- No mandatory Windows-only semantic, no AI-selected OS commands, no shell-based
  ownership fallback, no exact Node patch pin, and no broad process kill.
- Do not redesign account/network providers that do not spawn.

## Architecture prerequisite 8.0A — Contract-only session authority and state

- Preserve terminal `ProcessBackend`, `SubprocessRuntime`, and
  `OneShotCommandExecutor.execute()` behavior and schemas. Streaming records use
  a separate versioned record kind/store and a nonterminal state machine so
  terminal `reconcileStartup()` can never wait for a durable session to exit.
- Add a Runner-private durable `SessionAuthority`. The ToolBroker-issued opaque
  grant remains lifecycle-owned by ToolBroker. The session runtime consumes it
  exactly once and retains only validated immutable claims. It launches, binds,
  handshakes, and durably transfers isolation-lease cleanup ownership plus the
  fixed access envelope to SessionAuthority through fenced, idempotent pending
  effects. The runtime never reissues, retains, or independently revokes the
  opaque grant; ToolBroker revokes it exactly once at normal call completion,
  cancellation, or timeout. Transfer ensures later grant revocation cannot
  orphan or accidentally destroy an adopted durable session.
- Never persist or reuse grant material. Adopted authority permits observation
  and exact-child cleanup, never relaunch or access expansion. Every
  family-facing write, close-input, request, stop, graceful-shutdown, and live-
  output operation requires a current non-forgeable
  `SessionOperationAuthorization` bound to the exact session owner, run, actor,
  agent session, tool, call, permitted operation, and access check. The backend
  channel object is never returned to a family. Only fenced Runner recovery,
  cleanup, terminal observation, and bounded raw-output draining into the
  private protocol/evidence queues may run without a model-call authorization.
  Those lifecycle operations may not write input, dispatch a protocol request,
  acknowledge a server-originated action, expose bytes to a family/model, or
  mutate family protocol state. Every family subscription, parse/delivery
  action, input/control operation, and protocol response still requires a
  current `SessionOperationAuthorization`.
- For the first MCP/LSP operation, the same launching ToolBroker call's
  validated claims authorize the protocol request after adoption; no second
  grant is issued. Subsequent operations require new ToolBroker calls and fresh
  grants. Managed `process.start` returns after adoption, after which ToolBroker
  performs its normal revocation.
- Access comparison is explicit rather than treating opaque grants as sets:
  `sessionEnvelope.access` must be a subset of `launchGrant.access`;
  `requestAccess` must be a subset of `sessionEnvelope.access`; and the current
  request grant must independently authorize `requestAccess`, external and
  destructive decisions, and the exact run/session/actor/tool/call identity.
  Credential names, network permission, and path modes are compared separately.
  If a call requires broader access, close the old session and launch a new one
  under that call; never broaden or union envelopes.
- A failure before transfer is cleaned through ToolBroker's live call revoker.
  If the Runner host dies and that revoker cannot run, the durable
  provider/lease claim remains the sole startup-recovery cleanup owner;
  reconciliation must identify the unadopted pending transfer, clean or durably
  block it, and never treat it as an adopted session. A crash after the durable
  transfer acknowledgement is recovered through SessionAuthority. Recovery of
  an ambiguous transfer is fenced and fail-closed: it may clean the exact owned
  child/lease but may not expose input, adopt broader authority, or relaunch.
  Replay must emit one exact transfer/cleanup transition and acknowledgement.
  A crash requiring relaunch ends the current call with typed unavailable or
  outcome-unknown. Relaunch occurs only on a later newly authorized call. No
  family mints or reuses another launch grant inside the same ToolBroker call.
  Internal MCP discovery retries use a new internal call identity and grant;
  restart-limit accounting spans these separately authorized attempts.
- Define strict closed state/version parsing, downgrade refusal for active
  unsupported session schemas, historical terminal compatibility, cloning,
  digest sensitivity, capacity bounds, and durable-value safety. No bearer
  token, control port, payload, writer, native handle, or live capability may be
  durable or model-visible.
- Add a versioned optional backend-private
  `InteractiveProcessChannelProvider`, distinct from tree ownership and write
  confinement. Acquisition/reattach is bound to exact backend binding and
  fencing token. The capability supports ordered bounded write, idempotent
  close-input, live output subscription, graceful stop, terminal wait,
  detach/release, and optional attested reattach.
- Each write carries an in-memory sequence, byte length/hash, timeout, and
  explicit backend acknowledgement. Payload bytes are never persisted. Crash
  while acknowledgement is unknown becomes typed `outcome_unknown` and is
  never replayed. Stale fences, released sessions, and writes after close are
  rejected.
- Live channel capabilities are backend-private/in-memory (for example via a
  non-enumerable capability registry or `WeakMap`). Reattach occurs only after
  exact backend attestation. If it cannot be proven without durable secrets,
  input becomes typed `input_unavailable`/`outcome_unknown` while cleanup
  ownership remains.

**8.0A RED/GREEN acceptance:** strict parsing/version/downgrade, grant transfer
before/after crash, stale fence/takeover, write before/after ack crash, private
payload/capability safety, subset enforcement, no access union, capacity,
idempotent replay/ack, unsupported active-session refusal, and terminal Task 7
contract compatibility. Fake claims/backends prove the closed pre-transfer,
ambiguous-transfer, adopted-session, and cleanup state transitions without
starting a production child. No production family migrates in 8.0A.

## Architecture prerequisite 8.0B — Kernel, adapters, output, and construction

- Implement a separate nonblocking `StreamingProcessSessionRuntime.open()` and
  bounded startup reconciliation. `open()` returns after authenticated
  launch/bind/handshake/adoption, not after process exit. Recovery re-attaches
  nonblockingly or returns a typed unavailable/outcome-unknown state while
  retaining exact cleanup ownership.
- The output path has two branches: lossless protocol bytes enter a bounded,
  backpressured parser queue intact; the same bytes separately enter Task 3
  tail/spill evidence. Spill failure records truthful lossiness but never
  truncates protocol input. No unbounded supervisor log may sit between child
  and parser. Oversized frames fail the protocol session without leaking its
  process tree. Recovery preserves delivery offsets against duplicates or marks
  protocol outcome unknown.
- Add native/POSIX/Windows interactive channel support behind semantic probe
  results. Product selection never branches on OS mechanism names.
- Extract an authenticated backend-private Windows Job host implementing backend
  launch/observe/signal/reconcile/release and optional channel operations. It
  never fabricates a model actor and never calls the public managed facade. Add
  a dependency-graph recursion test.
- Strict OCI positive duplex requires a separately attested
  `interactiveAttach` capability, `create --interactive`, and exact
  `start --attach --interactive` identity. If absent, strict MCP/LSP fails typed
  before container creation. Real Docker tests perform an echo/JSON-RPC
  roundtrip, cancellation, restart/unavailable, and residue audit when Docker is
  configured. Never mount a host executable or fall back to native while
  claiming confinement.
- Preserve Windows `.cmd`/`.bat` LSP compatibility through the extracted exact
  Job-host internal with argv-only handling and executable attestation; do not
  reintroduce shell evaluation or a product-level Windows branch.
- Construct execution in this exact order:
  1. validate paths/config and create state/artifact roots;
  2. construct one CLI-owned `ExecutionHost` kernel containing the filtered
     environment source, backend registry/low-level Job host, output factory,
     and host-control durable kernel;
  3. run bounded Git preflight through an explicit
     `RunnerInternalExecutionContext` (never a fabricated architect/worker);
  4. perform only non-spawning static MCP/LSP config/executable attestation;
  5. bind the host per run to permission profile, capability contract, grant
     authority, isolation selector, and SessionAuthority;
  6. recover that run's sessions and leases nonblockingly;
  7. construct MCP discovery/manager, LSP providers/router, and managed facade;
  8. construct architect/worker/subagent registries and models last.
- “One shared graph” means one CLI-owned host kernel with isolated per-run
  bindings, never one permission/grant context shared between runs. A
  two-concurrent-run test proves no cross-run grants, writers, outputs, sessions,
  leases, or cleanup effects.
- Pre-run Git preflight is the only pre-run Runner-internal execution context.
  Per-run MCP initialize/`tools/list` discovery is the only other internal
  child-execution purpose. Each uses a distinct closed principal, purpose, call
  identity, least envelope, timeout, and verified cleanup. MCP discovery cannot
  invoke MCP tools. No other internal execution principal may launch a child;
  no raw spawn or module-global mutable runtime exists.

**8.0B RED/GREEN acceptance:** bounded nonblocking recovery of a long-lived
session; input/output backpressure; protocol correctness during spill failure;
pre/post-bind cancellation; backend disappearance; reattach unavailable;
strict OCI fail-before-create and real interactive Docker roundtrip when
available; Job-host recursion refusal; concurrent-run separation; Task 7 exact
runtime/backend/one-shot gates green. A real host-crash fixture terminates
Runner between lease acquisition and transfer acknowledgement, restarts it, and
proves the 8.0A transition using the real streaming kernel with exactly one
cleanup transition and no residual lease, process, input endpoint, or
fabricated adopted session. A persistent-child fixture fills stdout beyond the
in-memory tail between ToolBroker calls and proves bounded kernel draining and
terminal observation continue while family delivery and every write remain
unauthorized. No family packet begins until 8.0A and 8.0B have current
independent evidence.

## Family packet 8.1 — Git

- Preserve `GitCommandOptions`, `GitCommandResult`, `GitBinaryCommandResult`,
  `GitBinaryRunner`, `GitCommandError` codes, binary output, `allowFailure`, and
  result/error semantics. Introduce an injected `GitCommandRunner` bound to the
  host or exact run context. Compatibility wrappers may exist only with an
  explicit runner parameter; no stateless production/global runtime or raw-
  spawn fallback is permitted.
- Replace ambient merge, local spawn, output-triggered kill, and private result
  lifecycle with a Runner-owned runtime-backed Git runner. Route every
  production Git owner, including startup preflight, baseline, repository,
  worktree, integration, cleanup/profile, intelligence, verification, worker,
  architect, and subagent tools.
- Preserve exact typed results while adding truthful lossiness/cleanup/
  enforcement metadata only where the public contract permits it.
- Startup `checkGit` uses the closed `RunnerInternalExecutionContext`; all other
  Git owners use the exact per-run binding. Git absence remains a pre-model
  fatal prerequisite with no fabricated run/actor identity.
- Do not implement Task 9 config/hook/filter hardening here.

**8.1 RED/GREEN faults:** environment secret, output beyond tail/spill, spill
fault, timeout, cancellation, launcher exit with descendant alive, PID reuse,
backend disappearance/outcome unknown, strict unavailable, Full disclosure,
Git absent before model call, and binary output.

## Family packet 8.2 — MCP

- Preserve `McpServerSpec`, `McpServerStatus`, manager start/status/tool/close
  behavior, JSON-RPC newline framing, request IDs, timers, tool schemas,
  artifacts, and approval semantics.
- MCP executable attestation, bounded framing/backpressure, restart limits, and
  graceful shutdown are new mandatory controls (the current implementation does
  not already possess them); do not describe them as preserved behavior.
- CLI owns only validated MCP configuration and starts no server. Per-run
  ephemeral discovery uses an explicit closed Runner-internal MCP discovery
  actor/tool/call authority, performs initialize + `tools/list`, records exact
  schema/config/executable digests, and closes with verified cleanup.
- Live servers start lazily on the first real MCP call and are scoped by exact
  run + actor + agent session + server + immutable access envelope. There is no
  global live manager. The first call uses that same call's validated launch
  claims for its post-adoption JSON-RPC request. Each later JSON-RPC request
  requires a fresh exact ToolBroker grant, explicit request access contained by
  the adopted envelope, and an exact `SessionOperationAuthorization`; it does
  not reuse or compare opaque grants as sets.
- A server config must declare a conservative fixed path/network/credential
  envelope. Legacy specs default to no additional paths/network. If required
  access cannot be expressed conservatively, use a per-call server or fail typed;
  never silently broaden or union permissions.
- Remove `shell: true`. Resolve an exact executable plus arguments through a
  portable, closed parser/config representation. Legacy command strings with
  shell operators or ambiguous quoting fail typed; values are never evaluated
  by a shell.
- Use the streaming-session seam for framed reads/writes, bounded stderr/output,
  backpressure, request timeout/cancel, crash/restart limits, graceful protocol
  shutdown then shared escalation, and restart recovery.
- Before each live launch/restart, re-attest the executable and compare the
  discovered schema/config digest. Restart consumes a fresh launch grant. A
  crash after request write/unknown acknowledgement produces outcome unknown;
  never replay an external MCP call.
- Close a server on owning agent-session or run termination, configuration,
  executable, schema, or envelope replacement, or invalid ownership
  authorization. On cancellation or unknown protocol quiescence, retain it only
  if protocol idleness is proven; otherwise stop it and verify exact emptiness.
  Startup recovery may observe or clean an existing child but never relaunch it
  without a fresh grant.
- Preserve public ready/tool/status semantics: `ready` means configured,
  attested, discovered, and available, not necessarily that an idle child runs.

**8.2 RED/GREEN faults:** partial/coalesced/malformed/oversized frames,
backpressure, request and write timeout, cancellation, shutdown refusal,
crash/restart exhaustion, launcher exit with child alive, PID reuse, executable
replacement, backend disappearance, inherited secrets, output loss/spill fault,
strict unavailable, Full disclosure, discovery cleanup, schema replacement,
grant-envelope subset/refusal, crash before/after authority transfer, and crash
before/after write acknowledgement.

## Family packet 8.3 — LSP

- Preserve all `LspClientError` codes and retryability, Content-Length framing,
  frame/output/pending bounds, write timeouts/backpressure, request cancellation,
  document version/reopen behavior, diagnostics/stats APIs, restart limits,
  executable byte attestation, graceful `shutdown`/`exit`, and provider-router
  availability semantics.
- Replace direct spawn, PowerShell bootstrap, taskkill, process-group signals,
  ambient environment lookup, and private process lifecycle with the shared
  streaming session. Protocol shutdown stays family-owned; OS escalation,
  identity, tree cleanup, output, and recovery are shared.
- Inject the central prepared environment into executable discovery and reorder
  capability/router construction after the execution graph exists.
- Add an internal language invocation context carrying exact ToolBroker
  grant/run/session/actor/call identity through `code-intelligence-tools.ts`,
  filesystem post-write diagnostics, router, and configured LSP provider.
  Built-in/extension provider APIs remain backwards compatible; a configured
  LSP launches lazily only under authorized context.
- Restart requires a fresh launch grant and authority adoption. Pending protocol
  operations are never replayed after crash/restart unless family-level durable
  state proves an idempotent result; otherwise return outcome unknown.
- Close an LSP session on owning agent-session or run termination,
  configuration, executable, schema, or envelope replacement, or invalid
  ownership authorization. On cancellation or unknown protocol quiescence,
  retain it only if protocol idleness is proven; otherwise stop it and verify
  exact emptiness. Startup recovery may observe or clean an existing child but
  never relaunch it without a fresh grant.
- Preserve attested Windows `.cmd`/`.bat` launch through the extracted exact
  Job-host argv-only path. In strict OCI, a host executable not represented and
  re-attested inside the configured image is typed unavailable before create;
  never mount it or fall back to native execution.

**8.3 RED/GREEN faults:** all existing framing/write/restart/attestation faults
plus inherited secrets, spill fault/output loss, backend disappearance,
restart/outcome unknown, pre/post-bind cancellation, launcher exit with
TERM-ignoring descendant, PID reuse, strict unavailable, Full disclosure,
authority propagation from both code tools and filesystem diagnostics, Windows
batch compatibility, stale writer/fence, and crash before/after session adoption.

## Family packet 8.4 — Managed processes

- Preserve durable background observation, authenticated stop, output polling,
  historical no-write reads, restart/recovery, public snapshots/observations,
  tool schemas/error codes, and backend ownership/release authority.
- Product-facing managed processes must work through the shared session/runtime
  on Windows and POSIX. Ownership, birth identity, escalation, environment,
  output/spill, cancellation, verified cleanup, and recovery belong only to
  shared primitives.
- Remove the Windows-only product start refusal and raw launcher/ambient merge/
  kill/probe paths from `managed-process.ts`. The extracted optional authenticated
  Job host sits only behind the exact backend-internal allowlist. The Windows
  backend depends only on that host, never the managed facade, and no backend
  constructs a model actor. Dependency tests prove recursion is impossible.
- `process.start` returns only after an authenticated startup handshake and
  atomic SessionAuthority adoption. Managed close is asynchronous, performs
  protocol/facade shutdown, verifies exact owned cleanup, finalizes output, and
  acknowledges durable release.
- Close a managed session on owning agent-session or run termination,
  configuration/executable/schema/envelope replacement, invalid ownership
  authorization, or explicit authenticated stop. Cancellation is operation-
  specific: cancellation of `process.start` before its successful response
  stops the adopted child and verifies exact emptiness; once a stop intent is
  durably accepted, cleanup continues despite caller cancellation; cancellation
  of output polling or observation cancels only that read/observation and never
  terminates the managed child. Arbitrary managed children have no protocol-
  idleness exemption. Startup recovery may observe or clean an existing exact
  child but never relaunch it without a fresh grant.
- New active-session schema contains no bearer token, control port, native
  handle, writer, input payload, or live endpoint. Historical terminal v1
  records remain read-only. Active unsupported records fail typed before model
  calls and retain cleanup evidence; startup never silently downgrades them.
- Historical records remain readable; active incompatible recovery fails typed
  without model calls or unsafe cleanup.

**8.4 RED/GREEN faults:** portable positive launch on the current host,
partial output/backpressure, timeout/cancel, authenticated stop refusal,
launcher exit with descendant alive, crash/restart, PID reuse, backend
disappearance, output loss/spill failure, secret scrub, strict unavailable,
Full disclosure, historical read, active recovery refusal, authenticated startup
  handshake refusal, atomic adoption crash on both sides, asynchronous close,
  three distinct prove-RED/revert/GREEN cancellation tests: (1)
  `process.start` cancellation before successful response stops and verifies
  empty; (2) `process.stop` cancellation after durable stop intent does not
  interrupt cleanup; and (3) output-poll/observation cancellation cancels only
  the read and leaves the exact managed child running and owned; plus backend-
  facade recursion refusal.

## Packet 8.5 — Local-provider audit and raw-launch closure

- Re-run the configured-provider inventory. If still negative, record exact
  files/config/transport kinds and do not change them. If a real configured
  local-provider child is found, route it through the same session/runtime and
  apply the full environment/output/ownership/cancel/cleanup requirements.
- Whole-tree static audit covers production `.ts`, `.mts`, `.js`, `.mjs`,
  `.cjs`, `.ps1`, relevant package scripts, and launcher entries. It resolves
  namespace, destructured, aliased, and dynamic `node:child_process`/
  `child_process` imports and rejects `spawn*`, `exec*`, `fork`, direct member
  `.kill`, `process.kill`, `taskkill`, shell flags/launch, PowerShell launchers,
  and ambient `process.env` in migrated families.
- Exact adapter/provider-host allowlist initially permits only:
  `native-process-backend.ts`, `portable-process-supervisor.mjs`,
  `portable-process-child.mjs`, `oci-execution-isolation-provider.ts`, and any
  newly extracted authenticated Windows Job host files. Each allowed symbol or
  range has a narrow reason; a whole file is not silently exempted.
- `native-build-factory.ts` retains only its central filtered ambient snapshot.
  No Task 8 family reads ambient environment directly.
- Temporarily add a real aliased `execFile`/spawn call to a migrated production
  family and prove the guard red; revert and prove green. Also mutate an
  ambient-env read and taskkill literal red/revert/green. Additional genuine
  bypass mutations cover namespace aliases, dynamic import, `fork`, member
  `.kill`, a shell flag, and a `.ps1` launcher.

## Execution doctrine for every packet

PREPARE → implement one coherent packet → run the smallest failed/affected
validation → audit every assigned requirement → automatically repair
determinable failures → rerun exact failed then affected gates → repeat until
verified → perform adversarial re-audit → close only with current evidence.

- Never run the full suite after every fix. Exact failed checks come first;
  broaden only when impact cannot be bounded.
- Every new guard/regression is proven RED, reverted, and GREEN.
- Do not expand the active packet for unrelated findings; record later work.
- Escalate only for authority/destructive decisions, unresolved requirement
  conflict, unavailable external dependency, requested control weakening, or
  exhausted governed repair budget.

## Final Task 8 acceptance and evidence

- Each family has exact RED/revert/GREEN evidence, focused tests, affected
  integration tests, Runner typecheck, targeted lint, and public compatibility
  assertions before the next family starts.
- Final mandatory faults across applicable families include partial frames and
  backpressure, timeout, cancellation, protocol shutdown refusal, crash/restart,
  launcher exit with child alive, PID reuse, backend disappearance, output
  loss, and spill failure.
- Cross-cutting prove-RED/revert/GREEN faults also include: crash immediately
  before/after SessionAuthority transfer; crash during input write before/after
  acknowledgement; stale writer/fence after takeover; recovered long-lived
  session not blocking startup; launch grant revoked while adopted confinement
  remains and later run/session cleanup releases it; strict OCI unavailable
  before container creation; real Docker interactive roundtrip when configured;
  lossless protocol parsing during spill failure; MCP discovery/executable/schema
  replacement; two concurrent runs with no cross-authority/data effects; LSP
  context propagation from code and filesystem tools; Windows batch launch; and
  managed authenticated startup-handshake refusal.
- Static raw-launch guard is green with the minimal exact adapter/provider-host
  allowlist and genuine bypass mutation evidence.
- Inspect and record processes, ports, supervisors, spills, durable state,
  temporary session endpoints, and configured OCI containers. Nothing owned by
  Task 8 remains.
- Every fixture cleanup executes in `finally` and verifies processes, ports,
  supervisors, input endpoints, spills, authority records, leases, and
  containers are empty.
- Rollback first stops every Task 8 session, closes input, finalizes output,
  verifies exact owned emptiness, releases SessionAuthority/isolation, and keeps
  terminal evidence. Task 7 binaries must not be restored while active Task 8
  session records exist. Startup refuses unsupported active session schemas.
  Only then may a packet restore its prior injected family seam; protected
  terminal contracts remain backwards compatible.
- Definition of Done: every local child family is routed through shared portable
  primitives, framing/protocol/public semantics remain green, negative provider
  audit is current, static guard has no escape, cleanup is empty, and an
  independent reviewer reports zero Critical/Important findings.

Only valid outcome:

**PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN**

or

**PHASE BLOCKED — GENUINE USER DECISION REQUIRED**
