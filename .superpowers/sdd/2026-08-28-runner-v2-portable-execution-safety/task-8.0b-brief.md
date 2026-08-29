# Task 8.0B implementation brief — streaming kernel, portable channels, and host construction

## Position and authority

- This is the second architecture prerequisite of canonical Task 8 in
  `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md`.
- Entry head: `c4582700` after independently approved packet 8.0A.
- The approved parent architecture is `task-8-brief.md`; this focused brief is
  the complete execution authority for 8.0B.
- Execute the three internal packets strictly in order: 8.0B1 runtime/output,
  8.0B2 portable host adapters, then 8.0B3 OCI/construction/integration. Each
  gets its own implementer, RED/GREEN evidence, review, cleanup, and commit.
- Only one implementer may change shared execution interfaces at a time. No Git
  family packet, MCP protocol migration, LSP protocol migration, managed facade
  migration, or provider audit begins until all of 8.0B is independently green.
- Node policy remains maintained Node 22 or 24; never add an exact patch pin.

## Architecture-review closure

- Review 1 finding 1 is closed by mandatory `stageLaunch()`/`finalizeLaunch()`
  semantics and a compatibility wrapper over the same one-consumption path.
- Finding 2 is closed by a single storage kernel/durability boundary and one
  atomic adoption transaction; distributed/best-effort ownership handoff is
  explicitly rejected.
- Finding 3 is closed by per-stream retained replay windows, ordered accepted/
  consuming/consumed checkpoints, and acknowledgement only after consumed
  commit (or truthful evidence-only intake).
- Finding 4 is closed by making ephemeral internal MCP discovery a narrow B3
  prerequisite executor while leaving all public/live manager behavior to 8.2.
- Finding 5 is closed by independent portable, batch, tree/birth, and Job
  semantic probes; Job containment never gates separately attested portability
  or batch compatibility.

## Shared 8.0B requirements

1. Preserve Task 7 terminal `ProcessBackend`, `SubprocessRuntime`, and
   `OneShotCommandExecutor` behavior and preserve every approved 8.0A durable
   state, grant, SessionAuthority, and channel security invariant. Additive
   versioned contracts are allowed; active incompatible state fails typed and
   remains intact.
2. `StreamingProcessSessionRuntime.open()` is nonterminal. It returns only after
   authenticated launch, exact binding, private-channel acquisition, required
   launch handshake, and durable SessionAuthority adoption. It never waits for
   child exit and never passes a backend channel to a family.
3. ToolBroker owns the opaque grant for the whole call and revokes it exactly
   once on normal completion, cancellation, or timeout. The runtime may retain
   only immutable consumed claims. The first post-adoption operation uses the
   same launching call's claims; no second grant is minted. A later relaunch or
   request requires a new ToolBroker call and fresh grant.
4. Every effect before adoption has exactly one durable cleanup owner. Runtime
   state must bridge grant consumption, isolation acquisition, pre-effect host
   launch journaling, backend binding, channel/handshake, and SessionAuthority
   transfer without a window in which a host crash can leave an unenumerable or
   ownerless child. An in-process failure invokes the same journal-owned cleanup
   through the live ToolBroker revoker; the revoker is not a second owner. On
   host death, the durable host-control record identifies the exact launch and
   remains the sole recovery cleanup authority until the atomic adoption commit.
   Never fabricate an actor, binding, birth identity, or adoption.
5. Extend the existing streaming-session storage kernel with one versioned
   host-launch table/state machine in the same transactional durability boundary
   as session records. A separate database/store with a best-effort cross-store
   handoff is forbidden. Before isolation acquisition it records a deterministic
   invocation/launch identity, exact owner/fence and pending effect, but no
   command, argument, environment value, secret, payload, endpoint, token,
   writer, native handle, or live channel. The host/provider must reconcile that
   identity idempotently even when launch outcome is unknown and no backend
   binding was returned. Unknown outcome is cleaned or durably blocked and is
   never blindly relaunched.
6. Add a mandatory one-shot staged launch contract. `stageLaunch()` consumes the
   exact opaque grant once before the first isolation/provider effect, reserves
   the exact call key plus intended session/launch identity, retains only frozen
   immutable claims, and returns a non-serializable, non-reconstructable,
   alias-safe one-shot Runner-private authorization held in a `WeakMap`. Only
   the exact private isolation/host calls may validate it. `finalizeLaunch()`
   consumes that staged authorization exactly once and
   binds one exact lease, backend binding, envelope, handshake attestation, and
   session; it seeds the retained launching-call claims without calling grant
   `consume()` again. Reuse, a second session/finalization, finalization after
   grant revocation or claim expiry, or any binding/envelope mismatch fails
   typed before transfer. `beginTransfer()` remains a compatibility wrapper over
   this same state machine; it is never a second consumption path. Neither the
   opaque grant nor the staged authorization is persisted or returned to a
   family.
   The durable host lifecycle is closed and monotonic:
   `prepared → isolated → launching → bound → handshake_verified → handed_off`,
   with cleanup/block terminal branches from every pre-handoff state. The
   `prepared` row is committed before isolation and owns the deterministic
   `isolate:<launchId>`, `launch:<launchId>`, and `handoff:<launchId>` effects
   under one host-control owner/fence. The launch effect is made pending before
   calling the idempotent host launch keyed by `launchId`; the returned exact
   lease and backend binding are bound by fenced compare-and-swap transitions.
   After handshake, one storage-kernel `commitAdoption()` transaction validates
   the staged authorization, immutable identities, current owner/fence and
   revisions, creates the exact SessionAuthority record with its transfer
   history/effect acknowledged, and changes the host row to terminal
   `handed_off`/owner `none`. Before that commit the host row is authoritative
   and SessionAuthority is absent; after it the host row is inert and the exact
   active SessionAuthority record is authoritative. Session collision aborts
   the whole transaction and leaves host ownership unchanged. Exact replay is
   idempotent; any mismatched replay or impossible cross-record pair is typed
   storage corruption and quarantined without relaunch or guessed cleanup. A
   storage implementation that cannot provide this atomic boundary is refused
   at construction.
7. Startup recovery is bounded and nonblocking. It first settles unadopted host/
   provider launch claims, then reattaches adopted sessions only after exact
   backend and channel attestation. It returns typed input unavailable or
   outcome unknown while retaining cleanup authority when reattach cannot be
   proven. It observes/cleans an existing child but never relaunches without a
   new grant.
8. The private output path is lossless for protocol bytes and bounded in memory.
   Introduce an additive versioned backpressured output capability with exact
   stream, monotonically increasing per-stream sequence, cumulative byte offset,
   byte length/digest, and Runner-to-provider acknowledgement. The selected
   family declares which streams are protocol-bearing; MCP/LSP stdout is
   protocol-bearing and stderr is evidence-only. The provider retains every
   unacknowledged protocol chunk in a bounded replay window and stops reading the
   child when that window is full. It may discard a chunk only after the Runner
   issues the matching acknowledgement. No unbounded supervisor log or callback
   queue may sit between child and parser.
9. Output tees into two independent branches. The protocol branch receives an
   owned byte copy intact into a bounded backpressured parser queue. The evidence
   branch writes the same bytes to Task 3 tail/spill handling. Evidence spill
   failure records truthful lossiness but does not truncate, reorder, or fail
   already accepted protocol bytes. Oversized protocol frames fail the protocol
   session and trigger exact owned cleanup without leaking the process tree.
10. Kernel lifecycle code may drain raw bytes into private queues and observe
    terminal state without a model call. Every family subscription, parse/
    delivery, protocol response, request, write, input/control, graceful stop,
    or family-visible byte requires a current exact
    `SessionOperationAuthorization`. No durable payload or model-visible live
    capability is introduced.
11. Track delivery/checkpoint facts without persisting payloads. For each stream,
    durable metadata records the last consumed sequence/end-offset/digest, a
    capacity-bounded ordered window of accepted-but-unconsumed sequence/end-
    offset/digest entries, and at most one consuming intent. The durable metadata
    window and provider replay window have the same declared capacity. For a
    protocol chunk the Runner validates continuity, commits its accepted entry,
    then inserts an owned copy into the bounded queue; it does not acknowledge
    the provider yet. Before any parse result or family-visible effect it commits
    a consuming intent. After successful authorized parse/delivery it atomically
    advances consumed metadata, removes the accepted entry, and clears the
    intent, then and only then sends the provider acknowledgement. A replay at or
    below a committed consumed offset must match the retained checkpoint digest,
    is not delivered again, and is acknowledged. A crash with a consuming
    intent, a provider that cannot replay every accepted-but-not-consumed entry,
    or any sequence/offset/digest mismatch becomes protocol `outcome_unknown`;
    no external request or input write is replayed. Evidence-only streams may
    commit accepted and consumed after the evidence spool has truthfully accepted
    or recorded loss, then acknowledge without family delivery. Durable records
    never contain chunk bytes.
12. Cancellation is phase-specific: pre-bind cancellation prevents or cleans
    launch; post-bind/pre-adoption cancellation cleans through the still-live
    call owner; post-adoption cancellation follows family semantics and current
    authorization. Backend disappearance, handshake refusal, channel attach
    refusal, output failure, and cleanup refusal are typed and retain the sole
    truthful owner/evidence.
13. Product selection branches only on semantic capability probes, never OS
    mechanism names. Windows Job Objects remain an optional enhancement; the
    portable baseline remains functional. No AI-selected OS command, shell
    ownership fallback, broad PID kill, or mandatory Windows semantic is added.
14. All new production child launch and channel primitives live only in exact
    host/provider internals that packet 8.5 can narrowly allowlist. No new raw
    spawn, taskkill, process.kill, shell flag, PowerShell launcher, or ambient
    environment read appears in a family or general runtime module.

## Internal packet 8.0B1 — nonblocking runtime, host-control contracts, and output tee

### Exact scope

- Add the staged launch/host-control journal contracts inside the same durable
  streaming storage kernel needed to consume authority before effects, bind a
  returned process exactly, and atomically commit adoption across both tables.
- Add `StreamingProcessSessionRuntime` and its call-scoped facade using fake
  isolation, fake host-control, fake backend/channel, and fake handshake
  providers only.
- Add the versioned backpressured private-output capability and bounded protocol
  queue/reader. Preserve 8.0A v1 channel compatibility, but the streaming runtime
  must fail typed if the selected host cannot attest the lossless backpressured
  capability it requires.
- Compose the Task 3 bounded output spool only through an injected output factory
  and implement the protocol/evidence tee. Evidence failure never corrupts the
  protocol branch.
- Add bounded, nonblocking startup recovery using fake exact reattach/cleanup
  providers. Do not implement a native, POSIX, Windows, Job, or OCI channel.

### Expected surfaces

- New focused runtime, host-control journal kernel extension, protocol byte
  queue, and output-tee modules under `runner-v2/src/` with focused tests.
- Backwards-compatible additions to `session-authority.ts`,
  `streaming-session-store.ts`, `interactive-process-channel.ts`,
  `process-backend.ts`, `execution-isolation-provider.ts`, and Task 3 output
  contracts only where required.
- No CLI/control-server/native-factory or production family behavior change.

### Mandatory RED/GREEN faults

- grant consumed before first effect; live revoker before and after isolation;
  host crash at every boundary from grant consume through transfer ack;
- exactly one consumer for each normative `isolate`, `launch`, and `handoff`
  effect; exactly one fenced `bound` and `handshake_verified` transition;
  unknown launch, duplicate bind/transition, session collision, stale owner/
  fence, lease expiry/takeover, cancellation before/after bind and adoption;
- crash/reopen before and after every `prepared`, isolation, `launching`, bind,
  handshake, and atomic adoption commit; prove the authoritative owner at each
  revision, idempotent same-identity replay, collision rollback, impossible-pair
  quarantine, and no distributed/best-effort store implementation;
- `open()` returns while a long-lived fake child remains active; startup recovery
  never waits for exit and never relaunches;
- partial/coalesced chunks, backpressure saturation/release, output sequence gap/
  duplicate/digest mismatch, protocol queue bound, frame-too-large disposition;
- crash/reopen before and after durable accepted commit, queue insertion,
  consuming-intent commit, authorized parse/delivery, consumed commit, and
  provider acknowledgement; prove retained replay, safe duplicate suppression,
  bounded window backpressure, and `outcome_unknown` at every ambiguous effect;
- evidence tail overflow/spill, injected spill failure with intact protocol
  bytes, protocol consumer cancellation, family delivery without current auth;
- reattach exact offset success, missing sequence/gap/duplicate/outcome unknown,
  stale writer after takeover, backend disappearance, cleanup refusal;
- durable scan proving no grant, command/argv/env, payload, channel, writer,
  token, endpoint, port, handle, or capability is stored/model-visible;
- exact 8.0A and Task 7 compatibility gates.

### 8.0B1 exit gate

Fake-provider state roots are empty, all mutations are RED/reverted/GREEN, an
independent reviewer reports zero Critical/Important findings, and no real
adapter/family/CLI surface changed. Only then may 8.0B2 begin.

## Internal packet 8.0B2 — portable native/POSIX/Windows channel hosts

### Exact scope

- Implement native/POSIX/Windows semantic host-control and backpressured channel
  capabilities behind the B1 interfaces. Reuse Task 5 ownership/birth/
  attestation primitives; do not duplicate process-tree ownership in a family.
- Mandatorily extract the authenticated low-level Windows Job host/service from
  `ManagedProcessService`. `WindowsJobObjectProcessBackend` and its interactive
  channel depend only on that host. The host never imports/calls the public
  managed facade and never fabricates a model actor. Product managed behavior is
  unchanged until 8.4.
- Portable Windows baseline remains available without Job support. Job support
  is selected only after an honest active capability probe. Expose independent
  semantic facts for portable exact launch/duplex channel, argv-only batch-file
  launch, exact tree ownership plus birth re-attestation, and Job-backed stronger
  containment. Product selection consumes those facts independently and never
  infers one from the host/module name. POSIX uses exact process-group ownership
  and birth validation. All host operations re-attest identity immediately
  before signal/control/release.
- Replace any supervisor tail-only path used by the new streaming capability
  with bounded backpressured stdout/stderr delivery. Preserve Task 5 observation
  behavior for terminal consumers.
- Preserve attested `.cmd`/`.bat` argv-only launch through the extracted exact
  low-level Windows host independently of whether active Job assignment is
  available. Job-unavailable must not disable portable or batch behavior when
  their own probes are verified. If the current host cannot attest the separate
  argv-only batch capability, a batch request fails typed before launch while
  other verified portable launches remain available. No shell evaluation or
  product-level Windows branch is introduced.
- No strict OCI implementation, CLI graph activation, or production family
  routing belongs here.

### Expected surfaces

- `native-process-backend.ts`, `posix-process-backend.ts`,
  `windows-process-backend.ts`, `portable-process-supervisor.mjs`,
  `portable-process-child.mjs`, extracted Job-host files, and focused fixtures.
- Minimal additive capability/probe changes in shared backend/channel contracts.
- `managed-process.ts` may lose only the extracted backend-private host code;
  its public facade/tool behavior remains compatible until packet 8.4.

### Mandatory RED/GREEN faults

- positive portable launch/channel roundtrip on the current host; partial output,
  bounded backpressure, input close, graceful stop, terminal wait, detach;
- launcher exit with descendant alive, TERM refusal then exact escalation, PID
  reuse/birth mismatch, process enumeration failure, backend disappearance,
  attach/reattach refusal, stale fence/writer, output sequence loss, host crash;
- launch failure after target creation cleans or durably blocks exact ownership;
  release requires verified emptiness and preserves evidence on uncertainty;
- independent portable/channel, batch argv, exact-tree/birth, and Job containment
  probes in every unavailable/partial/verified combination; portable and batch
  behavior remain usable without Job when independently attested; dependency-
  graph recursion refusal, no fabricated actor, `.cmd`/`.bat` argv compatibility,
  and no taskkill/process.kill outside exact host allowlist;
- affected Task 5/7 plus complete 8.0A/B1 gates and zero owned residue.

### 8.0B2 exit gate

Every current-host applicable adapter fault is green, non-current adapters have
static/contract proof, dependency recursion is impossible, Job remains optional,
cleanup is empty, and an independent reviewer reports zero Critical/Important
findings. Only then may 8.0B3 begin.

## Internal packet 8.0B3 — strict OCI, ExecutionHost construction, and real integration

### Exact scope

- Add a separately attested strict `interactiveAttach` OCI capability. Strict
  duplex launch requires `create --interactive` plus exact
  `start --attach --interactive` identity. If unavailable, strict MCP/LSP-class
  execution fails typed before container creation. Never mount a host executable
  or fall back to native while claiming confinement.
- Build one CLI-owned `ExecutionHost` kernel after validated paths/config and
  state/artifact roots. It contains the filtered environment source, backend and
  channel registries/low-level Job host, output factory, host-control durable
  kernel, and streaming runtime. Per-run binding adds only that run's permission
  profile, capability contract, grant authority, isolation selector, and
  SessionAuthority; no run shares grants, writers, queues, sessions, leases, or
  cleanup effects.
- Implement bounded `RunnerInternalExecutionContext` principals. Pre-run Git
  preflight is the only pre-run child purpose. B3 also owns one explicit narrow
  production exception: a separate per-run `McpDiscoveryExecutor` launches only
  under the internal discovery principal, performs initialize plus `tools/list`,
  records the exact schema/config/executable digests, performs protocol close and
  verified process cleanup, and cannot invoke tools, return a live manager, or
  expose its channel. Each internal purpose has a distinct closed principal,
  call identity, least envelope, timeout, and verified cleanup. No fabricated
  architect/worker identity exists.
- Construction order is: validate roots/config; create one host kernel; bounded
  Git preflight; nonspawning MCP/LSP config/executable attestation; per-run host
  binding; nonblocking run recovery; bounded ephemeral internal MCP discovery;
  per-run public MCP/LSP/managed facades; architect/worker/subagent registries
  and models last.
- To preserve family packet ownership, B3 may perform only behavior-neutral
  construction relocation for the public MCP manager, LSP, and managed surfaces,
  plus the closed Git-preflight prerequisite and the narrowly owned internal
  `McpDiscoveryExecutor` above. The discovery executor is prerequisite control-
  plane behavior, not the public/live MCP manager: it has no tool-call method,
  does not persist or reuse a session, and always closes after `tools/list`.
  Existing live/public family protocol and lifecycle behavior remains unchanged
  until 8.1–8.4 and may not receive a new fallback. Task 8.2 owns lazy live MCP
  servers, external requests, restart limits, public statuses/tools, and manager
  close semantics. The production graph must not create a second host kernel or
  share a run binding. Any current eager global family spawn that cannot be
  relocated without changing public protocol behavior is a blocking architecture
  defect for review, not permission to disable the family.
- Real fixtures: Runner host crash between isolation/host launch and transfer
  acknowledgement; persistent child fills stdout beyond memory tail between
  ToolBroker calls; two concurrent runs; strict OCI interactive Docker when
  configured. Every fixture owns and clears state outside the project.

### Expected surfaces

- `oci-execution-isolation-provider.ts`, new ExecutionHost/run-binding modules,
  `native-build-factory.ts`, CLI/control-server construction seams, and focused
  composition/integration tests.
- Minimal behavior-neutral constructor/context changes to `git-preflight.ts`,
  public MCP/LSP/managed factory surfaces, and capability/router construction,
  plus the closed internal discovery executor explicitly owned above. Full Git
  runner and live/public MCP, LSP, and managed lifecycle routing remains in
  8.1–8.4.

### Mandatory RED/GREEN faults

- strict OCI missing interactive capability fails before create; executable not
  in image fails before create; exact real Docker JSON/echo duplex, cancel,
  backend disappearance/restart-unavailable, cleanup and zero containers;
- real pre-transfer Runner crash yields exactly one cleanup transition and no
  process, lease, channel endpoint, or fabricated adopted session;
- real persistent child drains beyond memory tail while family delivery/writes
  remain unauthorized; spill failure leaves protocol bytes intact;
- two concurrent runs prove no cross-run grant, writer, output, session, lease,
  channel, cleanup, or actor/call identity effects;
- recovery is bounded/nonblocking with long-lived child; exact reattach or typed
  unavailable/unknown; startup never relaunches;
- construction-order and dependency-graph assertions, Git missing pre-model,
  MCP discovery cannot call tools, static attestation spawns nothing;
- Task 7, 8.0A, B1, B2, typecheck/lint/diff, process/port/supervisor/spill/state/
  endpoint/container residue gates.

### 8.0B final exit gate

All three internal packets have current evidence, every new guard/regression is
RED/reverted/GREEN, applicable real host and Docker fixtures are green or Docker
is truthfully reported unavailable without weakening strict production behavior,
the construction graph is single-host/per-run isolated, cleanup is empty, and an
independent reviewer reports zero Critical/Important findings.

Only then is this outcome valid:

**PACKET 8.0B VERIFIED 100% COMPLETE — FAMILY PACKET 8.1 GIT MAY BEGIN**

## Execution doctrine for each internal packet

PREPARE → implement one coherent packet → run its smallest failed/affected
validation → audit every assigned requirement → automatically repair technical
failures → rerun exact failed then affected gates → repeat until verified → run
an adversarial re-audit → close only with current evidence and a green review.

- Never rerun the full suite after every fix. Previously green evidence is reused
  only when the impact is proven disjoint.
- Every new guard/regression is proven RED, reverted when mutation-based, and
  GREEN. Capture commands, expected failures, outputs, cleanup, and commits.
- Do not expand an internal packet for unrelated findings. Record them for the
  correct later packet unless Critical.
- Escalate only for destructive/authority decisions, unresolved requirement
  conflicts, unavailable external dependencies, requested control weakening, or
  an exhausted five-round governed repair budget.
