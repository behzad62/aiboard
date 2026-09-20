# Task 8.0B1 implementation brief — staged launch kernel and lossless fake streaming runtime

## Authority and entry

- Governing authority is the approved `task-8.0b-brief.md`, the approved parent
  `task-8-brief.md`, and canonical Task 8 in
  `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md`.
- Entry HEAD is `6ade2e52`. Task 8.0A is independently approved and must remain
  compatible. Task 8.0B architecture review 2 is APPROVED with zero
  Critical/Important ambiguity.
- This packet owns contracts, durable state, output/checkpoint primitives, and a
  nonblocking runtime proven only with fake providers. It is the sole active
  shared-interface packet. Execute B1.1, B1.2, then B1.3 in order.
- Node policy is maintained Node 22 or 24. Never add an exact patch pin.

## Exact exclusions

- Do not implement or activate a native, POSIX, Windows, Windows Job, or OCI
  streaming/channel adapter.
- Do not modify CLI/control-server/native-factory construction and do not route
  Git, MCP, LSP, managed processes, or any provider family.
- Do not add a second database, global runtime, family-visible channel, raw
  spawn/kill/shell path, ambient environment read, OS-name product branch, or
  AI-selected cleanup command.
- Do not redesign the approved Task 7 terminal runtime/backend/store contracts,
  make an active session schema silently compatible, persist payload bytes, or
  weaken any Task 8.0A authorization/fencing/provenance rule.
- Task 8.0B2 owns real portable host adapters. B3 owns OCI and production graph
  construction. Tasks 8.1–8.5 own family migration and static closure.

## Frozen architecture decisions

1. `stageLaunch()` is mandatory. It consumes one opaque grant before the first
   isolation/provider effect, reserves exact call/session/launch identity, and
   returns a non-serializable, non-reconstructable, alias-safe one-shot private
   authorization backed by a `WeakMap`. Only frozen consumed claims may remain.
2. `finalizeLaunch()` validates current unrevoked/unexpired claims, the exact
   staged identity, lease, backend binding, envelope and handshake, consumes the
   staged authorization once, commits one exact session adoption, and seeds the
   existing first-launch-operation claims without consuming the grant again.
   `beginTransfer()` remains compatible through this same one-consumption state
   machine; it is not an alternate consume path.
3. The existing streaming-session kernel is the single durability boundary.
   Add a versioned host-launch state machine/table and output-checkpoint table to
   that kernel. In SQLite, adoption updates launch and session tables in one
   database transaction. In memory, the same state change is indivisible. A
   kernel without the hidden atomic writer is refused. A separate/best-effort
   handoff store is forbidden.
4. Host lifecycle is exactly
   `prepared → isolated → launching → bound → handshake_verified → handed_off`,
   with fenced cleanup-pending/blocked/released terminal branches from every
   pre-handoff state. The prepared record exists before isolation. Normative
   effects are `isolate:<launchId>`, `launch:<launchId>`, and
   `handoff:<launchId>`; bind and handshake are one-time fenced transitions.
5. Before atomic adoption, the host row is the sole cleanup authority and no
   SessionAuthority record exists. `commitAdoption()` validates identities,
   owner/fence/revisions and atomically creates the exact active version-3
   session with acknowledged transfer history/evidence while changing the host
   row to inert `handed_off`/owner `none`. Afterward SessionAuthority is the sole
   cleanup authority. Collision aborts the transaction and leaves host ownership
   unchanged. Exact replay is idempotent; impossible pairs are quarantined.
6. Output v2 uses per-stream sequence and cumulative end offset. Every chunk has
   stream, sequence, start/end offset, byte length and SHA-256 digest. The
   provider retains unacknowledged protocol chunks in a capacity-bounded replay
   window and backpressures its child when full. MCP/LSP stdout is the exemplar
   protocol stream; stderr is evidence-only. Selection is explicit, not inferred
   from an OS or executable.
7. Durable output metadata contains no bytes. Per stream it stores a bounded
   ordered accepted-but-unconsumed metadata window, last-consumed checkpoint,
   and at most one consuming intent. The metadata and provider windows share the
   same declared capacity.
8. Protocol ordering is: validate continuity → durable accepted commit → insert
   an owned byte copy into the bounded parser queue without acknowledgement →
   durable consuming intent before parse/family effect → current authorized
   parse/delivery → atomic consumed advance/remove accepted/clear intent → exact
   Runner-to-provider acknowledgement. Evidence-only output commits accepted and
   consumed after the spool has accepted it or truthfully recorded loss, then
   acknowledges without family delivery.
9. A replay at/below consumed is suppressed and acknowledged only if its exact
   checkpoint metadata matches. Accepted/unconsumed data must be replayable. A
   consuming intent after crash, missing retained bytes, gap/duplicate mismatch,
   digest/offset mismatch, or ambiguous delivery becomes `outcome_unknown`; an
   external request or input write is never replayed.
10. Kernel lifecycle may privately drain bounded raw bytes and observe terminal
    state. Every family subscription, parse/delivery, protocol response, request,
    write/control, stop, graceful shutdown, or family-visible byte still needs a
    current exact `SessionOperationAuthorization` at the moment of effect.

## B1.1 — staged authority and single durable launch/adoption kernel

### Required implementation

- Add strict versioned host-launch record/parser/reducer types and hidden kernel
  reader/writer capability. Records contain only immutable identities, owner,
  fence, revision, safe timestamps, lease/backend bindings after attestation,
  handshake digest/fact, effect metadata, and state. Explicitly reject commands,
  argv, environment values, credentials/secrets, payloads, endpoints/ports,
  tokens, writers, handles and live capabilities recursively.
- Extend both in-memory and SQLite streaming kernels with bounded launch-record
  capacity, HMAC/integrity validation, strict keys/version/state/history/effect
  combinations, compare-and-swap revisions/fences, read-only refusal, cloning,
  deterministic lists, and safe close behavior.
- Add one hidden atomic `commitAdoption()` operation over the host-launch and
  existing streaming-session records. Reuse the approved session parser and
  reducer invariants; do not create a looser session parser. Preserve active-v2
  quarantine and historical terminal behavior from 8.0A.
- Add the mandatory staged SessionAuthority API and private authorization. The
  private validator may expose frozen claims only to injected Runner-private
  isolation/host code. Staging one call/session reserves it. Revoked or expired
  claims, an alias reused after success, second session/finalization, and any
  mismatch fail typed. Compatibility `beginTransfer()` consumes exactly once.
- Provide fenced, idempotent journal transitions for isolate intent/lease bind,
  launch intent/backend bind, handshake verification, adoption, cleanup intent,
  cleaned/blocked settlement, and startup takeover. Unknown unbound launch is
  always reconciled by deterministic launch identity; never guessed or relaunched.

### Mandatory tests and prove-red evidence

- Strict record kind/version/keys/state/history/effect parsing; unsupported active
  refusal; read-only behavior; capacity; identity/revision/fence collision;
  HMAC/tamper/reopen; clone/digest sensitivity; forbidden durable-value scan.
- Grant is consumed before a fake isolation effect. One call cannot stage or
  finalize twice, target two sessions, use an alias twice, or finalize after
  revocation/expiry. Exact claims/envelope/lease/binding/handshake mismatches fail.
- Crash/reopen before and after every prepared/isolate/isolated/launching/bind/
  handshake/adoption boundary. Prove one authoritative owner, one consumer per
  normative effect, one bind/handshake transition, idempotent exact replay,
  collision rollback, and impossible-pair quarantine.
- SQLite atomicity fault injection immediately before and after session insert,
  launch handoff update and commit. Observable state must be wholly pre-adoption
  or wholly post-adoption; never ownerless/double-owned.
- Live ToolBroker revoker before isolation, after isolation, after bind and after
  handshake invokes the same journal-owned cleanup exactly once. Cleanup failure
  is durably blocked; stale owner/fence cannot signal or settle it.
- Every new regression/guard must first fail for the intended reason, then pass.
  Mutation-based guards are reverted before GREEN. Record exact commands/output.

## B1.2 — output v2, checkpoint kernel, bounded queue, and evidence tee

### Required implementation

- Add a separate additive v2 backpressured channel/output contract while keeping
  the approved v1 API and tests compatible. Streaming runtime selection requires
  an honestly attested v2 provider and fails typed for v1/unavailable/partial
  lossless support.
- The provider-to-Runner sink is asynchronous. It receives an owned chunk plus
  exact metadata and resolves only with the matching acknowledgement after the
  required checkpoint. It must not be possible to acknowledge another stream,
  sequence, offset or digest. Provider replay capacity and Runner metadata/queue
  bounds are explicit positive configuration.
- Add a byte-count- and chunk-count-bounded protocol queue/reader. It accepts
  owned copies, preserves partial/coalesced chunks exactly, blocks producers at
  capacity, releases in order, supports cancellation, and fails a session on an
  explicit frame limit without leaking queued references.
- Add strict versioned output-checkpoint records/readers/writers inside the same
  streaming storage kernel (including SQLite integrity/reopen and memory parity).
  Store metadata only. Enforce per-stream monotonicity, bounded accepted window,
  one consuming intent, exact replay matching, and fenced session ownership.
- Add a protocol/evidence tee. Protocol bytes go intact to the queue. The same
  bytes go independently to an injected Task 3 `BoundedOutputSpool` factory.
  Evidence write/spill/finalize/cleanup failure records truthful lossiness and
  never truncates/reorders/fails already accepted protocol bytes. Evidence-only
  streams can drain and acknowledge without family delivery.
- Add a private output controller that enforces the checkpoint ordering in the
  frozen decisions. It must re-check current authorization immediately before
  each parse/family delivery. No raw bytes or live sink enter durable/model data.

### Mandatory tests and prove-red evidence

- Partial and coalesced bytes, independent stdout/stderr sequences, zero/invalid
  lengths, gap, duplicate, offset/digest mismatch, cross-stream acknowledgement,
  mutable caller buffer, queue bytes/chunks bound, saturation/release/cancel.
- Crash/reopen before/after accepted commit, queue insertion, consuming intent,
  authorized parse/delivery, consumed commit, and provider acknowledgement.
  Prove retained replay, safe duplicate suppression and `outcome_unknown` for
  ambiguity or missing retained bytes.
- No authorization, wrong operation/call/session/run/actor, revoked/expired grant,
  stale fence and takeover during delivery all prevent family-visible bytes.
- Tail overflow and spill ingestion; injected spill open/write/close/artifact
  failure; protocol bytes remain exact and the evidence result is truthfully
  lossy. Oversized protocol frame triggers exact owned cleanup disposition.
- SQLite checkpoint HMAC/tamper/reopen/capacity/read-only/forbidden payload tests.
- Each new guard/regression has RED, revert where mutation-based, then GREEN
  evidence in the report.

## B1.3 — fake-provider StreamingProcessSessionRuntime and bounded recovery

### Required implementation

- Add `StreamingProcessSessionRuntime.open()` and a call-scoped facade using only
  injected fake isolation, fake host-control, fake backend/channel v2, fake
  handshake, output factory and clock/cancellation providers in this packet.
- Exact open order: validate/copy request; stage grant; durably prepare launch;
  register live revoker; journal/acquire/bind isolation; journal/launch idempotent
  host and bind exact backend; acquire exact private v2 channel; start bounded
  private output; complete and journal required handshake; atomically adopt;
  attach the private registry; return a family-safe session facade. Never return
  the backend/channel or await terminal exit.
- The first post-adoption operation uses the staged launching-call claims exactly
  once. Later operations use the existing fresh-grant SessionAuthority path.
- Failure/cancellation before bind prevents or reconciles launch; after bind and
  before adoption it cleans through the same host journal owner; after adoption
  it follows the authorized session operation semantics. A grant revocation after
  adoption does not destroy adopted ownership, but invalidates unused launch-call
  operation authority.
- Add bounded/nonblocking `reconcileStartup()`: settle every non-handoff host row
  first through fake exact reconcile/cleanup; then reattach adopted sessions only
  after exact backend/channel/output-window attestation. It never waits for child
  exit and never relaunches. Missing channel/retention proof becomes typed
  `input_unavailable`/`outcome_unknown` while preserving exact cleanup authority.
- Runtime cleanup finalizes/detaches output/channel, verifies fake host cleanup,
  settles journal/session effects once, and leaves no fake state root, timer,
  listener, writer, queue or payload reference.

### Mandatory tests and prove-red evidence

- `open()` resolves while a long-lived fake child remains active, only after
  binding/channel/handshake/adoption. It never calls terminal wait.
- Host crash at each stage, unknown unbound launch, launch called once despite
  retry, duplicate bind, handshake refusal, channel v1/partial/unavailable,
  backend disappearance, output failure, cleanup refusal and cancellation at
  every phase.
- First operation works from the same launching claims once; second launch-call
  use fails; a later fresh-grant call works only within both session and current
  grant envelopes.
- Recovery with a long-lived child is time/count bounded and nonblocking; exact
  reattach/checkpoint replay succeeds, stale writer/fence fails, accepted bytes
  missing become unknown, and startup never launches.
- Durable scan across SQLite tables and serialized evidence proves no opaque
  grant, staged authorization, command/argv/env, secret/credential value,
  payload, endpoint/port, channel, writer, handle or capability.
- A fake persistent child produces protocol bytes beyond the evidence memory
  tail while no family delivery/write is authorized. Kernel/evidence intake stays
  bounded; evidence-only output drains, protocol output backpressures at its
  declared replay/queue window without loss, and terminal observation remains
  available.

## Validation and evidence gates

Run the smallest exact RED test first, then the changed file/test set. Broaden
only after impact cannot be safely bounded. Required final gates are:

1. All new B1 focused tests green with zero skips except an explicitly
   inapplicable external fixture (none is expected for fake-only B1).
2. Exact Task 8.0A tests green:
   `streaming-session-store.test.ts`, `session-authority.test.ts`,
   `interactive-process-channel.test.ts`, `execution-grants.test.ts`.
3. Exact Task 7 compatibility tests green:
   `process-backend-contract.test.ts`, `durable-process-store.test.ts`,
   `subprocess-runtime.test.ts`, `execution-isolation-provider.test.ts`, and
   `tool-broker.test.ts`.
4. `npm run typecheck:runner-v2` and targeted ESLint for every changed source/
   test file; `git diff --check` from `6ade2e52`.
5. Static scope audit proves no production adapter, CLI/factory, family, raw
   spawn/kill/shell, ambient environment, or exact Node pin change.
6. Inspect and record fake state roots, SQLite files/handles, output spills,
   timers/listeners and any process/port/container surfaces. Cleanup is empty.

Write implementation/RED-GREEN/validation/cleanup evidence to
`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0b1-report.md`.
Commit coherent implementation and report checkpoints. Do not claim completion;
an independent reviewer must report zero Critical/Important findings.

## Definition of Done and exit

- Every B1.1–B1.3 requirement and fault has current evidence; all approved 8.0A
  and affected Task 7 behavior remains green; no real production child path has
  changed; and cleanup is empty.
- Automatically repair technically determinable failures, rerun exact failed and
  affected checks, and perform a final adversarial self-audit before handoff.
- Only after independent approval may the controller declare:

**PACKET 8.0B1 VERIFIED 100% COMPLETE — PACKET 8.0B2 MAY BEGIN**
