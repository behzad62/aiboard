# Task 8.0B2 implementation evidence

## Scope and design

- Entry authority: `task-8.0b2-brief.md`; implementation began at clean head
  `14ceb00d`.
- Added four independent immutable semantic facts (`unavailable`, `partial`,
  `verified`) for portable duplex, Windows batch argv, exact tree/birth, and
  active Job containment. Job never gates the other facts.
- Extracted an actor-free `WindowsJobProcessHost` contract and frozen concrete
  host boundary. `ManagedProcessService` delegates its backend-private methods
  through that boundary; the Job backend imports only the low-level host.
- Extended the existing portable supervisor evidence directory with an
  authenticated file protocol for ordered input, close, stop, retained output,
  exact metadata acknowledgements, detach, and reattach. No second process
  owner, database, CLI selection, OCI path, or family routing was added.
- New launch identities bind the exact writer fence into their birth digest.
  Portable and Job effects reject stale fences before control, reconciliation,
  emptiness, or release. Historical identities remain readable without gaining
  new authority.
- The supervisor reads at most the declared aggregate retained byte/chunk
  window, leaving Node stream backpressure active until exact sink
  acknowledgement metadata is durably returned. Evidence logs remain separate.
- Current host: Windows. POSIX native execution is explicitly skipped, while
  platform-neutral contract tests prove negative-group signalling, independent
  birth checks, enumeration failure, escalation, and stable emptiness.

## Packet RED/GREEN evidence

### B2.1 semantic probes and boundary

- RED: `npx tsx --test runner-v2/test/process-host-semantic-probes.test.ts`
  failed because the semantic-probe module did not exist, then because the Job
  backend imported `managed-process.ts` and fabricated a worker actor.
- GREEN: 5/5 after independent facts, active-probe semantics, static dependency
  guard, and extracted frozen host boundary.

### B2.2 low-level Windows host

- Existing compatibility suite remained GREEN after delegation:
  native executable PATH resolution, PATHEXT `.cmd` argv boundaries, unsafe
  batch refusal, restart, authenticated signal/reconcile/release, absolute
  output offsets, and Job-unavailable baseline.
- Focused current evidence: managed/Windows/probe suite 45/45 GREEN.
- Public managed records, errors, snapshots, actor ownership, tool API, and
  ordinary managed-process behavior were not changed.

### B2.3 bounded duplex

- RED: first real portable test failed with
  `backpressuredChannelProvider is not a function`.
- Intermediate exact failures found and repaired: slow Windows membership scan
  delayed input acceptance; pipe write callback did not provide the required
  bounded acknowledgement; retained chunks were repeatedly delivered while
  awaiting supervisor deletion; a two-write fixture was legally coalesced into
  one stream chunk.
- GREEN: portable channel suite 4/4 covering identical sink acknowledgement
  ordering, real ordered writes, input close, partial stdout/stderr metadata,
  terminal wait, detach, bounded retained window, exact reattach/replay, and
  stale writer-fence refusal.

### B2.4 platform lifecycle

- Adapter/backend group: 40 pass, 0 fail, 1 explicit POSIX-host skip.
- Current-host real Windows portable supervisor and independently active-probed
  Job fixtures both ran. Tests cover surviving descendants, launcher exit,
  force escalation, recycled birth, unknown enumeration, output beyond tail,
  release serialization, restart, and verified emptiness.

### B2.5 repair and mutations

Each mutation was applied to production, proved RED, reverted, and the exact
test proved GREEN:

1. POSIX root PID instead of negative group: contract RED with `9001` versus
   `-9001`; reverted GREEN 1/1.
2. Writer-fence check bypass: real stale-fence fixture RED; reverted GREEN 1/1.
3. Job `verified` without active create/close result: strict selection RED;
   reverted GREEN 1/1.
4. Managed-facade import in Job backend: static dependency test RED; reverted
   GREEN 1/1. The same guard rejects agent contracts and actor construction.
5. Provider acknowledgement before sink acknowledgement: held-sink test RED
   because an ack file appeared early; reverted GREEN 1/1.
6. Removed aggregate byte bound: real retained-window fixture RED; reverted
   GREEN 1/1.
7. Stale output sequence/digest/offset acceptance remains guarded by the B1
   continuity suite included in the broad run; corrupt channel chunks now fail
   the private channel to `outcome_unknown` rather than disappearing.
8. Coupling portable/batch to Job remains guarded by the independent semantic
   combination test included in the probe suite.

Self-review additionally found two issues after broad validation: input-close
was not fail-closed across an unknown acknowledgement, and consumed input ack
files accumulated. The repair reserves closed state before the effect and
removes exact consumed ack files. Portable 4/4 plus typecheck reran GREEN.

## Broad validation

- Combined required compatibility command: 404 total, 403 pass, 0 fail, 1
  explicit POSIX-native Windows-host skip.
- Includes process backend contract, subprocess runtime, managed process,
  complete B1, complete 8.0A, Task 7/Task 3 durable process/isolation/tool
  broker/bounded spool, portable, POSIX, Windows, and semantic probes.
- Post-host-extraction affected reruns: 45/45 managed/Windows/probe; 18 pass,
  0 fail, 1 POSIX skip for portable/process-contract/POSIX; final portable 4/4.
- `npm run typecheck:runner-v2`: GREEN.
- Targeted ESLint over every changed TypeScript source/test: GREEN.
- `git diff --check`: GREEN (only repository line-ending notices).
- Static audit: Job backend/host contain no managed facade, agent/model
  contract, or actor dependency; raw spawn/signal/platform branches remain in
  the approved adapter/host/supervisor surfaces. No production family or CLI
  graph changed. No exact Node patch pin was added; maintained Node 22/24 policy
  is unchanged.

## Probe facts and cleanup

- Current real Job active create/close probe: verified by the real Job fixture.
- Portable duplex: verified by real roundtrip/replay fixtures.
- Windows batch argv: verified by existing real PATHEXT `.cmd` boundary and
  unsafe-metacharacter refusal fixtures independently of Job selection.
- Exact Windows tree/birth: verified by portable and Job lifecycle fixtures.
- POSIX native: skipped because the current host is Windows; contract/static
  proof remains green.
- Residue audit found one exact terminal test root left by an earlier interrupted
  test process. Its durable state was `stopped`, exit code 0, with no live owned
  process. The exact root was removed. Final named temp-root and portable
  supervisor/child process audit returned zero. Older default-state entries
  dated before this task were preserved.

## Residual concerns

- Windows portable tree discovery depends on CIM availability and intentionally
  becomes `outcome_unknown` when inspection cannot be proven.
- The file protocol is backend-private and intentionally not selected by the
  production CLI/family graph until later approved packets.
- Focused implementation commit: `7100c5de`.

## Governed fix round 1 — six Important review findings

Entry head was `1d57cf0d`. Authority was
`task-8.0b2-fix-round-1-brief.md`; this round is implementation evidence and
does not approve B2 or unlock B3.

### Concrete Job host and managed compatibility

- RED 0/2: the transitive guard proved that `windows-job-process-host.ts` was
  only an injected callback wrapper and `ManagedProcessService` still owned the
  backend mechanics and fabricated an internal worker actor.
- GREEN 2/2: `AuthenticatedWindowsJobProcessHost` now directly owns its durable
  records, authenticated supervisor bootstrap/control, exact output reads,
  reconciliation, active Job probe, and release. It imports no managed facade,
  agent/model/tool contract, or actor. The managed facade constructs and
  delegates to the concrete host and keeps low-level records outside its public
  record directory.
- Actor/import mutation: adding an `AgentActor` import made the transitive guard
  RED 0/1; reverting restored GREEN 2/2.
- Complete managed compatibility was GREEN 17/17. One broad run initially
  found that eager low-level state creation appeared inside an otherwise empty
  public facade state directory; isolating Job state as a sibling restored the
  exact refusal test GREEN without changing public records or behavior.

### Real Job duplex and durable fences

- RED 0/1: the real current-Windows fixture failed because the Job backend had
  no v2 channel provider.
- GREEN 1/1: the extracted host and authenticated supervisor now provide real
  Job-contained interactive stdin write/close, stdout/stderr observation,
  sink-before-ack output, durable input sequence/output offset/output sequence,
  detach, exact reattach, terminal wait, graceful stop, and Job-close tree
  termination. Removing `closeOwnedInput` mutation returned RED 0/1; reverted
  GREEN.
- Immutable Job birth no longer includes mutable writer authority. Launch
  persists a current fence; an exclusive atomic claim permits only idempotent
  current ownership or a strictly higher token. Effects and channel
  re-attestation revalidate the current owner/fence.
- Higher-fence fixture was initially RED because token 2 was permanently
  rejected. It is now GREEN: token 2 acquires and reattaches, and token 1 loses
  control immediately. A mutation accepting a lower token made the old writer
  remain active and the guard RED 0/1; reverting restored GREEN.
- Interactive stop initially timed out because the helper stdin belongs to the
  target, not the control protocol. The repair closes the authenticated Job
  host, relying on the already configured `KILL_ON_JOB_CLOSE`, and waits for the
  close proof. The TERM-ignoring descendant fixture is GREEN.

### Independent facts, fallback, and batch argv

- Native construction now consumes all four independent facts. Active Job
  create/close alone gates the optional Job registration; the Windows portable
  registration remains independent and later in the same trusted registry.
- Mutating away the independent portable registration made the construction
  guard RED 0/1; reverting restored GREEN.
- A real `.cmd` fixture ran through the portable backend with Job explicitly
  unavailable and preserved `"hello world"` and `"literal"` as two argv
  values. Unsafe batch metacharacters are refused in the held child before the
  target is created. Batch wrapping carries only Base64 JSON into an encoded
  PowerShell argv adapter; command and arguments are never concatenated into
  shell source.

### Immediate re-attestation and retained output

- Portable mutable fences are atomically claimed in `fence.json` and separated
  from immutable birth. B1 acquire/reattach receives the durable current fence.
  Legacy test identities claim their first durable fence rather than silently
  gaining control.
- Portable release validates supervisor birth and stable emptiness twice and
  refuses deletion with any retained output or output acknowledgement file.
  Job release performs a second authenticated supervisor/birth/status check and
  current-fence check immediately before persisting release.
- Corrupt retained filename, nonce, sequence, offset, digest, and payload were
  first RED 0/8 with higher-fence takeover; the strict parser and atomic fence
  repair made all 8/8 GREEN. Removing digest validation made digest and payload
  cases RED; reverting restored the full corruption group GREEN.
- Supervisor capacity is released only after the identical sink acknowledgement,
  verified retained-file deletion, and contiguous durable checkpoint update.
  Removing deletion made the release fixture RED; reverting restored GREEN.
- A real release fixture proves unsettled retained output blocks release and
  evidence deletion until sink acknowledgement and verified deletion.
- A proposed one-second "unclaimed" deletion was rejected by controller audit.
  The delayed-first-claim test proved it RED by losing output after 1.5 seconds.
  All timeout/unclaimed deletion was removed. `ProcessBackend.observe` is now an
  explicit authenticated v2 consumer: it invokes its output callback first and
  returns identical metadata only after success. A mutation that deleted
  unclaimed output immediately made the delayed guard RED; revert is GREEN.

### Fix-round mutation summary

All fix-round guards were RED, reverted, and GREEN: transitive actor/import,
missing Job duplex operation, Job token-2 rejection, token-1 continued control,
corrupt digest/payload acceptance, missing retained deletion, unsettled-output
release, active-Job coupling of portable fallback, and unclaimed timeout
deletion. The original B2 report retains the earlier root-only signal,
birth/release, aggregate backpressure, sink ordering, active-probe, and
managed-dependency mutations.

### Current validation and cleanup evidence

- Portable channel: 13/13 GREEN.
- Windows portable/native/Job: 25/25 GREEN.
- Managed/backend-contract/semantic/subprocess: 100 unaffected GREEN plus the
  repaired exact managed compatibility check GREEN.
- Complete B1/8.0A/Task compatibility: 234 total, 233 pass, zero fail, one
  explicit POSIX-native skip because the current host is Windows.
- `npm run typecheck:runner-v2`: GREEN.
- Targeted ESLint over every changed source/test: GREEN.
- `git diff --check`: GREEN except repository line-ending notices.
- Static dependency audit: no Job host/channel/backend dependency on the
  managed facade or agent/model/tool contracts; no actor construction. Raw
  process control remains in approved host/backend/supervisor/held-child
  surfaces. No OCI, CLI child-family activation, or exact Node patch pin was
  introduced.
- Residue audit identified four exact managed supervisors left by interrupted
  RED/mutation runs. Their exact PIDs and descendant trees were inspected, only
  those four supervisor roots were stopped, and nine explicitly enumerated
  task temp roots were removed. Final audit: `owned_processes=0`,
  `owned_roots=0`. The unrelated shared `aiboard-portable-processes` directory
  was preserved.

### Round 1 residual note

Windows portable inspection still intentionally fails closed when CIM cannot
prove birth/membership. POSIX native execution remains an explicit current-host
skip with contract/static coverage. This round does not declare B2 approved;
fresh scoped re-review and controller verification remain required.

### Broad-gate integration repair addendum

The first broad Runner gate exposed four Windows integration failures that the
focused channel fixtures did not exercise. Two final-verification cases stalled
or returned `verified_empty_failed`, the large-output production graph lost its
terminal suffix, and the worker failover fixture attempted evidence execution
without the shared executor dependency.

- The Job backend terminal observer now consumes through the authenticated v2
  channel. It calls the sink before returning the identical acknowledgement,
  drains every capacity-sized suffix after terminal, and then re-attests exact
  birth, current fence, stopped state, ownership release, exit code, and signal.
  Services that predate the optional duplex operations retain the established
  serialized observation compatibility path; the concrete production host is
  always duplex.
- The interactive Job helper can emit its control frame immediately after child
  stderr without a newline. The supervisor now separates the trailing helper
  marker while preserving all preceding child bytes. Restoring the old
  prefix-only parser made the exact build/test guard RED 0/1 with a leaked
  `root_exited` frame; reverting made it GREEN 1/1.
- Terminal drain now repeats capacity-bounded reads until offsets stop advancing.
  The production graph beyond spill capacity is GREEN 1/1, and the complete
  Windows backend group remains GREEN 25/25.
- `native-worker-driver.test.ts` now supplies the shared production-shaped
  one-shot executor to the evidence path. Before repair its durable ledger
  recorded `process_runtime_unavailable`, the scripted submit lacked evidence,
  and failover ended `all_worker_runtimes_unavailable`; the exact guard is now
  GREEN 1/1.
- The 100 ms timeout fixture could expire during a loaded Windows Job bootstrap
  before a durable binding existed. It now retains the same five-second child
  and timeout assertion with a one-second bound, avoiding a startup-scheduling
  race while still proving timeout cleanup. Five isolated repetitions were
  GREEN 5/5.

Interrupted integration RED runs left two exact supervisors whose durable
status proved the roots exited and whose process trees had no descendants. Only
PIDs `13928` and `52464` were stopped. Four explicitly enumerated August 30
final-verification/one-shot roots were removed after resolving and validating
them beneath the system temp directory. An unrelated July native-worker root
was preserved.

### Final broad-gate load hardening and closure evidence

Repeated full-run failures exposed a Windows-wide inspection load problem, not
a need to weaken process semantics or raise production deadlines. The portable
supervisor previously launched a fresh full `Get-CimInstance Win32_Process`
inventory on the next 10 ms tick whenever the preceding query closed. Under the
full parallel suite, multiple supervisors sustained a query storm: a portable
roundtrip reached its 60 second test boundary, process inspection intermittently
returned unknown, and unrelated cleanup could briefly retain SQLite handles.

- The portable supervisor now allows only one asynchronous tree inventory in
  flight and waits at least 250 ms after its completion before starting the
  next. Durable diagnostics publish the refresh count and observed minimum gap.
  The real channel fixture requires multiple refreshes and a minimum gap of
  250 ms. Mutating the cadence to zero made this live guard RED; reverting made
  it GREEN. The static guard also proves one unfiltered CIM inventory source,
  the in-flight gate, and the explicit cadence comparison.
- A transient inventory failure pauses conclusions and retries; three
  consecutive failures publish fail-closed `outcome_unknown`. Permanent unknown
  inspection remains a test failure. Destructive control still forces a fresh
  synchronous snapshot and exact per-PID birth re-attestation.
- The Job host now handles the terminal HTTP close race only when the durable
  status file independently proves the exact process/supervisor identity,
  `stopped`, and `ownershipReleased`. A focused guard was RED on `socket hang
  up`, then GREEN after the repair; the same guard verifies a durable `running`
  status still rejects the reset.
- The recovery smoke fixture uses bounded Windows-safe recursive cleanup retry
  after its child has exited. This is test cleanup only; no production timeout,
  process deadline, permission rule, or containment semantics changed.

Load and mutation evidence:

- Three isolated repetitions of each formerly failing portable roundtrip, Job
  absolute-offset observation, and CLI recovery smoke: 9/9 GREEN.
- Concurrent managed/process/channel/recovery/Windows/final-verification group:
  76/76 GREEN in 65.2 seconds; portable roundtrip 8.91 seconds, recovery smoke
  4.33 seconds, and Job absolute-offset observation 0.78 seconds.
- Cadence mutation `250 -> 0`: real portable channel RED on the measured gap;
  revert GREEN. Job terminal durable-proof guard RED before implementation,
  GREEN after implementation, and nonterminal durable proof remains rejected.
- Final complete `npm run test:runner-v2`: exit 0. Runner tests 1295 total,
  1294 pass, zero fail, zero cancelled, one explicit POSIX-native skip on the
  Windows host. Every chained client, policy, UI, cutover, pause, model usage,
  live-state, transcript, files, stats, steering, and observability script
  printed PASS.
- Post-broad `npm run typecheck:runner-v2`: GREEN. Targeted ESLint over every
  changed TypeScript source/test: GREEN. `git diff --check`: GREEN apart from
  repository line-ending notices.

The broad run immediately before this final repair was deliberately not used as
closure evidence: it reported 1294 total, 1290 pass, two fail, one cancelled,
and one skip, with a portable 60-second timeout, a recovery cleanup EPERM, and a
Job observation ECONNRESET. The failed recovery root was preserved for
inspection, shown to have no referencing process, then removed by exact
validated path. Final audit after the successful broad run:
`owned_processes=0`, `recent_aiboard_roots=0`.

## Governed fix round 2 — six residual Important findings

Entry authority was commit `5da8d273`, `task-8.0b2-fix-review-2.md`, and
`task-8.0b2-fix-round-2-brief.md`. This is implementation evidence; it does not
approve B2 or begin B3.

### R2.1 genuine Job producer backpressure

- RED: real stdout and stderr fixtures exceeded the retained window while an
  acknowledgement sink was held. The Job supervisor now caps each producer
  read and pauses both streams at the configured aggregate chunk and byte
  bounds, resuming only after the identical sink acknowledgement.
- GREEN: held stdout/stderr fixtures proved both limits, control-event
  independence, exact bytes, terminal and release. Coalesced reads accept only
  an exact later contiguous retained boundary and atomically settle every same-
  stream chunk through it.
- Sink/ack failures remain observable channel failures, preserve retained
  bytes, report durable unknown, and block release. Failed signal with retained
  output can recover and close after authenticated acknowledgement.
- Removing chunk/byte pause, contiguous coalesced acknowledgement, sink/ack
  propagation, or signal recovery made exact guards RED; each revert was GREEN.

### R2.2 active independent facts and bounded probes

- Portable duplex, Windows batch argv boundaries, exact birth-tagged tree, and
  active Job create/close are independently executed, cached, fault-isolated,
  deadline-aware, cleaned, and consumed. Timeout cancels polling, consumes late
  settlements, detaches channels, terminates owned processes, and removes only
  exact probe roots.
- Product construction registers Job only for verified Job containment and
  portable only for verified duplex. Missing facts default unavailable: tree is
  not hardcoded partial, batch is not implicitly verified, and service presence
  cannot select Job. A private probe-only bypass lets the harmless `.cmd`
  fixture measure argv, but the fact is trusted only after exact output matches.
- Probe environments contain only the minimal Windows launch allowlist plus
  explicit probe variables. The credential guard was RED before the allowlist
  and GREEN after; a live sentinel run sampled 32 supervisor command lines and
  decoded configs with zero exposure.
- Reintroducing ambient `process.env`, implicit verified batch, hardcoded tree,
  service-presence selection, or non-cancelling timeout behavior made the
  respective guards RED; all were reverted GREEN.

### R2.3/R2.4 lowest-boundary fences and release commits

- Every portable and Job attach/read/write/close/signal/output-ack/reconcile/
  release effect carries owner/token to the lowest boundary. The shared
  external lock serializes claims/effects; callbacks consume the freshly
  reloaded record. Channel/input/output state and final release/deletion remain
  inside the same final fenced commit.
- Held races prove token 1 produces zero effect after token 2 claims for
  portable signal/write/output-ack/release and Job write/output-ack/signal/
  release. Missing durable fence fails closed; deletion faults preserve state.
- Removing portable or Job final comparisons made every held guard RED; each
  was reverted GREEN.

### R2.5 strict retained evidence and recovery

- Portable acquire/reattach/terminal/release strictly validates output,
  checkpoint and all ack evidence. Malformed identity/metadata/digest/payload is
  unknown; valid input acks remain command evidence rather than unsettled
  output. Stale published input is rejected/advanced without child effect so
  token 2 can continue.
- Job read/terminal/release fail closed if stdout/stderr disappears or becomes
  unreadable, including deletion after attach immediately before read. Final
  output ack persists stopped proof before responding, closing the HTTP-reset
  race while the nonterminal-reset guard still rejects uncertainty.
- A 65 MiB production fixture exposed same-host fence-lock starvation: channel
  read/ack/reconcile exhausted the file-lock retry budget and left the exact Job
  tree live. Per-process host effects now serialize before taking the unchanged
  cross-host durable lock. Removing serialization reproduced RED/live residue;
  reverting completed in 8.7–9.1 seconds with zero supervisors.
- Missing-read/terminal, malformed-ack, stale-input, coalesced-ack, ack ordering,
  settlement, and serialization mutations all proved RED, reverted and GREEN.

### R2.6 bounded CIM and current focused evidence

- The one-in-flight CIM inventory has a watchdog, termination, 250 ms cadence,
  and shared consecutive-failure counter. Hung, failed, malformed and successful-
  empty inventory becomes durable unknown; stale membership cannot prove empty.
- Watchdog, empty-inventory and cadence mutations were RED and reverted GREEN.
  Test-only inspector/deadline seams do not change production defaults.
- Combined focused B2 group: 141/141 GREEN. The first loaded attempt (138 pass,
  one fail, one cancelled) exposed only a test outer-cap and release/emptiness
  fixture race; both repairs are test-support-only.
- Post-audit exact gates: Windows 17/17, durable reset 1/1, semantic/credential
  2/2, production load 1/1, typecheck and diff GREEN.
- Interrupted mutation trees were stopped only after exact supervisor/parent/
  descendant verification. Only resolved `aiboard-*` roots beneath system Temp
  were deleted. Pre-broad audit: zero fixture processes and zero recent roots.

### Controller-audit closure after R2.6

- A restarted Job backend now passes its currently claimed (including takeover)
  fence into activation reconciliation. The exact restart guard was RED when
  activation omitted the fence and GREEN after restoration. Job host signal now
  returns the freshly locked post-effect record; returning the stale pre-lock
  record made the stopped-snapshot guard RED, then GREEN after revert.
- Portable reconcile/release validates every acknowledgement filename and body;
  malformed arbitrary acknowledgement evidence is unknown and preserved while
  legitimate input acknowledgements remain command evidence. Removing the
  centralized validator made the corrupt-ack guard report a false clean exit.
- Portable empty proof issuance is a final fenced effect containing current
  identity, platform-specific terminal proof, emptiness and output settlement.
  A held token-1 proof cannot survive token-2 takeover. Release requires the
  same terminal proof before and at deletion; a live supervisor with empty
  membership is refused. Removing either gate made its exact guard RED.
- POSIX terminal proof remains portable: stopped POSIX state plus exact process-
  group emptiness does not require Windows root/known-process records. Removing
  the POSIX branch made the platform-neutral contract RED. POSIX launch rollback
  signals are also fence-committed; a simulated takeover immediately before the
  signal made the old writer reject with zero signal effect.
- Windows launch rollback publishes force termination with the launch identity's
  durable owner/token inside the final fence commit. A real live supervisor
  fixture was RED when those fields were removed and GREEN three consecutive
  times after restoration. The fixture uses state-backed test inspection only
  to avoid unrelated host-query contention; control handling is the real
  authenticated supervisor seam.
- Extensionless Windows commands are resolved and pinned before either launcher
  using normalized quoted PATH entries and normalized PATHEXT entries, with
  extension-outer/cwd-then-PATH order. Conflicting case-insensitive PATH/PATHEXT
  keys are refused. Removing resolution/canonicalization made both prelaunch
  guards RED; explicit lexical cmd/bat refusal remains intact.
- Portable and Job detach now settle in-flight output lanes and recheck detached
  state plus exact sink identity after sink success, before acknowledgement.
  Removing the post-sink checks made both guards acknowledge detached bytes.
  Final portable/Job terminal returns re-attest ownership after evidence reads.
- Loaded replay exposed a legitimate authenticated-ack deletion TOCTOU: a chunk
  already identically acknowledged can disappear between directory enumeration
  and read. Only ENOENT for a locally delivered/acknowledged name is retried;
  missing unacknowledged evidence remains fail-closed. Removing this exception
  deterministically reproduced RED; strict missing-output guards stayed GREEN.
- Test fixture environments now use only the Windows launch allowlist. A real
  decoded portable-supervisor argv guard proved an ambient credential sentinel
  absent; restoring inherited environment made it RED. Product argv-payload
  exposure for explicitly supplied workload environments is recorded as a
  future security-owner finding rather than broadened in B2.
- Final focused portable/POSIX/Windows group: 92 total, 91 pass, zero fail, one
  explicit POSIX-native skip on Windows. Typecheck and diff-check are GREEN.
  The loaded attempt's two transient failures were repaired impact-first and
  exact reruns were GREEN. Post-run live fixture supervisors and new roots were
  both zero. Seventeen older exact Temp roots remain as policy-blocked cleanup
  evidence; both implementer and controller independently verified them outside
  the repo with no live process references, and execution policy rejected each
  literal recursive removal before deletion began.

### Final controller findings before broad closure

- A stale Job release used to leave `releaseRequested` set and could block a
  higher-fence owner. The catch path now clears that latch only for a proven
  identity/fence loss; an ordinary same-fence durable-release failure remains
  pending and retryable under the existing contract. Removing the takeover
  reset made higher-fence reconcile return `outcome_unknown`; restoring it made
  both the stale-takeover and ordinary release-error guards GREEN (4/4).
- Job output polling now checks detach/exact-sink identity at the start of each
  stream and after an awaited host acknowledgement. Removing both checks made a
  held stdout acknowledgement deliver stderr to the old sink; restoration is
  GREEN and already acknowledged offsets remain consistent.
- Authenticated POSIX graceful control invokes exact process-group termination
  under the current fence. A platform-neutral injected-signal contract was RED
  when the supervisor call was removed, then GREEN. Backend recovery also
  signals a nonempty POSIX group after the supervisor exits; Windows refuses to
  imply control if a dead supervisor leaves birth-attested descendants. Both
  supervisor/backend `ps` enumerations now have a 2 second bound and preserve
  unknown on timeout.
- Synchronous Windows destructive-control inspection now honors an independent
  injected inspector, uses the unchanged 2 second production bound, and latches
  durable uncertainty on timeout/error. Every `taskkill /PID ... /T` call is
  separately bounded; timeout/error never becomes a successful control proof.
  Real hung-inspector and hung-taskkill fixtures were RED without the timeout,
  GREEN with it, killed their helper, preserved the target, and left no live
  supervisor.
- Exact tree roots, not every known descendant, are passed to `taskkill /T`.
  Calling `/T` once per descendant caused a later already-removed PID to report
  failure and permanently blocked valid rollback/probe cleanup. The mutation
  reproduced the real rollback RED; root filtering restored the real semantic
  probe and live rollback fixtures GREEN.
- Job duplex input now carries an explicit 1 MiB limit to the supervisor. The
  HTTP JSON bound accounts for base64 plus bounded envelope overhead; decoded
  bytes are rechecked, and the host rejects oversize payloads before any owned
  effect. A real 64 KiB roundtrip was RED at the former 16 KiB generic body cap
  and GREEN after repair; removing host preflight made the oversize guard reach
  a record lookup instead of the required typed limit refusal.
- Portable Windows membership now validates state nonce and supervisor PID
  before any empty proof or rollback. Removing this check let a replaced,
  well-formed empty state pass cleanup; restoration refuses it and preserves
  evidence.
- Extensionless resolution now follows directory priority (cwd then PATH), with
  PATHEXT ordering inside each directory, and pins the selected exact path.
  The two-directory `.cmd`-before-`.exe` guard was RED under extension-first
  nesting and GREEN after restoration. Quoted PATH, dotless PATHEXT, and
  case-insensitive ambiguity guards remain GREEN.

### Final focused and compatibility evidence

- Latest exact controller group: 12/12 GREEN. Affected complete Windows group:
  62/62 GREEN. The earlier five-file loaded group found four issues: two
  load/cleanup races that passed exact rerun, the taskkill descendant-root bug,
  and the release-latch compatibility distinction. Exact repairs and the full
  Windows rerun are current and GREEN; unaffected portable/managed/POSIX/probe
  results remain reusable by impact analysis.
- Complete B1/8.0A/Task 5/7/3 compatibility command: 320/320 GREEN.
- `npm run typecheck:runner-v2`: GREEN. Targeted ESLint has zero errors; one
  unused test-only import was removed and the lint gate is rerun before broad.
  `git diff --check` reports only repository line-ending notices.
- The first interrupted 64 KiB mutation leaked one exact Job supervisor because
  failure happened before normal terminal retirement. PID 61240 and its Job-host
  descendants were authenticated to exact root
  `aiboard-windows-job-channel-Z3B2TB`, stopped as one owned tree, and the test
  gained explicit higher-fence cleanup. Two later interrupted diagnostic roots
  were also verified with no live references. Execution policy rejected literal
  recursive removal before it began, so these three roots join the 17 prior
  policy-blocked roots. A bounded post-test settle reports zero live supervisors
  and zero new roots; none of the 20 retained roots has a live reference.

### Broad-attempt repair and semantic-probe cleanup closure

- The first full `npm run test:runner-v2` attempt exited non-green. Its output
  was truncated before a trustworthy aggregate TAP total could be retained, so
  no aggregate count is asserted. Failures clustered around the legacy LSP Job
  host path plus loaded Windows fixture cleanup. Exact isolation proved the Job
  host had stopped emitting the legacy stderr-framed LSP response whenever the
  new managed event-file path was absent. Restoring that compatibility branch
  made the exact LSP/extension/router group GREEN 17/17; recovery is GREEN 1/1.
- The loaded semantic timeout guard then reproduced a retained-root failure
  (11/12 GREEN, one RED). Failed probe cleanup now removes its generated root
  only after an independent, single bounded CIM inventory proves every exact
  recorded supervisor/root/known PID+birth absent or replaced. Root containment,
  state nonce/supervisor identity, a closed launch-effect proof, valid known
  owners, and a 256-owner cap are mandatory; missing/malformed/unknown evidence
  preserves the root. Outside-root and missing-started-root mutations were RED,
  then reverted GREEN. A cleanup-helper removal mutation was RED and reverted
  GREEN. The current complete semantic group is GREEN 13/13.
- One supervisor from the original RED semantic attempt (PID 51968, exact root
  `aiboard-windows-semantic-duplex-9omEMo`) predated the hardened audit. Its
  decoded supervisor identity matched the durable directory, nonce, platform,
  PID, and birth and it had no descendants. Exact tree termination succeeded;
  a three-second bounded settle proves the PID absent and zero live managed or
  portable supervisors. Its evidence root remains with the other policy-blocked
  roots because deletion authorization was previously rejected; it has no live
  reference.
- Post-repair targeted gates are GREEN: semantic 13/13, LSP/extension/router
  17/17, recovery 1/1, Runner V2 typecheck, targeted ESLint, and diff check
  (line-ending notices only). A second uninterrupted full Runner gate remains
  required before commit; B3 remains locked.
- Cleanup hardening subsequently required every deletion target to be a real,
  non-link, immediate Temp child with the exact semantic-probe prefix. An
  unbound launch deletes its root only when the exact state directory is empty;
  any `owned-*` or pending evidence is retained. Nested-target and unbound-owned
  mutations were RED, reverted, and GREEN. The semantic group is now 15/15.
- Broad attempt 2 reached a complete TAP exit: 1,357 total, 1,350 pass, five
  fail, one cancelled, one explicit skip. Every failed case passed alone. The
  combined portable/semantic/Windows stress first reproduced fixture cleanup
  EPERM and then a transient stable-empty-to-release race. Product control and
  deadlines remained unchanged: fence-only fixtures now use state-backed exact
  identity and require bounded reconcile-to-exited plus authenticated release
  before deleting roots; semantic discovery retries a transient stable-release
  refusal only within its existing deadline and immediately rejects fence or
  identity loss. The deterministic single-attempt mutation was RED and reverted
  GREEN. The complete affected stress group is GREEN 106/106.
- Four supervisors retained by the failed broad attempt were decoded and
  authenticated to their exact durable directory and nonce before exact tree
  termination. Post-repair bounded settle reports zero live managed/portable
  supervisors. Current typecheck, targeted ESLint, and diff check are GREEN;
  diff check contains line-ending notices only. One final uninterrupted broad
  exit is required before commit.
- A subsequent unbounded-file-concurrency broad attempt completed 1,358 total,
  1,353 pass, four fail, zero cancelled, and one skip. All four failures were
  fail-closed Windows fixture/CIM contention and passed exact; the affected
  three-file concurrent stress remained GREEN 106/106. The package gate now
  bounds only Node test-file concurrency to three. This changes no production
  retry, timeout, control, or evidence semantics and still exercises real
  concurrent portable/semantic/Job behavior. The prior unbounded command is the
  prove-red mutation for this harness bound; the exact package script must now
  complete green before closure.
- The first cap of three still produced two load-only failures (1,358 total,
  1,355 pass, two fail, one skip); both passed exact after authenticated residue
  cleanup. The package gate therefore serializes test files. Concurrency is not
  removed from acceptance: the separately required three-file real process
  stress remains GREEN 106/106. The cap-of-three run is the RED mutation for the
  final harness bound; production remains unchanged.

### Final serial-gate lock finalization repair

- The first serial package run completed 1,358 tests with 1,356 pass, one
  fail, one explicit skip. The sole failure was the retained-window replay:
  terminal observation failed closed because a Windows fence lock could not be
  reclaimed. Exact stress reproduced three failures in five attempts before
  repair, including `EBUSY` during writer-fence claim.
- Fence lock finalization is now one shared bounded implementation used by
  native claim/effect, portable-supervisor effect, and Job-host claim/effect.
  `ENOENT` is success; only `EPERM`, `EACCES`, and `EBUSY` retry within the
  explicit two-second bound; persistent cleanup failure surfaces. When an
  effect and cleanup both fail, the original effect error is retained in an
  `AggregateError`. Acquisition recognizes the same Windows sharing-denial
  codes as bounded contention rather than immediately converting an active
  peer lock into durable unknown.
- Real Windows held-lock guards are GREEN 3/3. Removing transient retry was RED
  with `EBUSY`, then reverted GREEN; swallowing persistent cleanup failure was
  RED, then reverted GREEN. A source/contract guard covers all five production
  finalization call sites. The exact replay changed from RED 3/5 to GREEN 5/5.
  The affected concurrent portable/semantic/Windows group is GREEN 109/109.
- Refreshed Runner typecheck, targeted ESLint, and diff check are GREEN; diff
  check reports line-ending notices only. Bounded residue inspection reports
  zero live owned supervisors and zero replay/lock-test Temp roots. The final
  serial package gate is the remaining exit gate; B3 remains locked.

### Serial reset-race repair

- The next serial gate completed 1,361 tests: 1,359 pass, one fail, zero
  cancelled, one explicit POSIX-host skip. The sole failure was a raw
  `ECONNRESET` in the Job missing-output fail-closed fixture. Exact isolation
  showed that both authenticated supervisor HTTP clients listened only on the
  `ClientRequest`; a reset after response headers was emitted on the
  `IncomingMessage` and could escape before durable stopped fallback ran.
- Managed and extracted-Job supervisor requests now settle exactly once across
  response `end`/`error`/`aborted` plus request error/timeout. A reset remains a
  failure unless `authenticatedStatus` independently reads exact durable stopped
  proof. The prior nonterminal-reset refusal remains GREEN. A deterministic
  partial-response reset guard timed out RED when both response listeners were
  removed, then reverted GREEN. The guard plus missing-output case are GREEN
  20/20 across ten fresh processes; the missing-output case alone is GREEN
  20/20.
- Concurrent affected verification is GREEN 110/110. Two prior non-green
  attempts were test cleanup only: the takeover fixture now uses the existing
  bounded authenticated terminal/release cleanup, and one semantic timeout
  correctly retained uncertain evidence. That semantic case passed exact. Its
  old supervisor was decoded to the exact directory/nonce/birth/fence, had no
  live descendants, and was stopped by exact PID+birth after authenticated
  control correctly refused durable `outcome_unknown`. The retained root remains
  cleanup evidence; bounded settle reports zero live owned supervisors.
- The final unchanged `npm run test:runner-v2` package gate is GREEN, exit 0:
  1,362 total, 1,361 pass, zero fail, zero cancelled, one explicit POSIX-host
  skip, 808.75 seconds. Every chained client, native-policy, policy-UI, cutover,
  pause-gate, model-usage, live-state, transcript, files, run-stats, steering,
  and observability check also passed.
- Fresh post-gate Runner typecheck, targeted ESLint, and `git diff --check` are
  GREEN; diff check reports line-ending notices only. A five-second bounded
  post-gate settle reports zero live managed/portable/Job-host supervisors.
  No production deadline, retry limit, Node support policy, product family
  routing, B3/OCI activation, or time-based output deletion was introduced.

## Fix round 3 — optional probe, recoverable fence authority, and zero residue

### R3.1 optional active Job probe

- The real Job create/close probe now has its own explicit 2 second watchdog;
  the injected real-child fixture uses a 100 ms bound, proves the child absent,
  and returns only `jobContainment: unavailable` while portable duplex and
  batch argv remain `verified` and exact tree/birth remains independently
  `partial`. Healthy real create/close remains verified.
- Watchdog mutation: multiplying the injected bound by 30 was RED in 3.01 s at
  the assertion that the optional fact must settle under 2 s. Reverted exact
  hung+healthy probes are GREEN 2/2. No factory registration, family routing,
  product deadline, or portable fallback changed.

### R3.2 shared crash-recoverable fence authority

- Native controller claim/effect, portable-supervisor effect, and extracted Job
  host claim/effect now use one SQLite DELETE-journal protocol. The durable
  immutable acquisition contains a random UUID, exact PID, and exact birth.
  `BEGIN IMMEDIATE` serializes election and spans the actual lowest-boundary
  effect; current protocol/acquisition identity is rechecked inside the final
  transaction. Busy handling is bounded by the existing 2 second fence bound.
- A dead or birth-mismatched exact holder can be atomically replaced; a live or
  uncertain holder is never stolen. Partial/zero-byte/corrupt schema, corrupt
  holder joins, replacement between claim and effect, persistent finalization,
  and immutable-acquisition mutation all fail closed. The declaration uses
  `node:sqlite`, available under the unchanged declared Node >=22.13 and Node 24
  support; no exact patch pin was added.
- Release retires the protocol in the same final transaction. It removes every
  queued proposal, and claim/effect both recheck `version` and `retired`.
  Waiting contenders therefore close without effect; the retired DB is removed
  only after close, with DELETE mode leaving no journal/WAL/SHM sidecar. The
  deterministic preinserted-contender race was RED before these checks (the
  retiring process failed and authority could resurrect). Removing proposal
  settlement plus active-protocol checks was RED again because the contender
  exited success instead of refusal; revert is GREEN 1/1 with one effect and
  zero DB/sidecars.
- Required mutation evidence: stale recovery removal made the real crash guard
  RED; replacement/final identity removal was RED before the final boundary;
  acquisition mutability was RED before the immutable trigger; ignoring exact
  birth made the retained-live-holder guard perform a second effect (RED) and
  reverted GREEN. Full lock group is GREEN 9/9, including real process crash,
  live contention window, two-process reclaim election, corrupt/uncertain
  evidence, birth mismatch, ambiguous finalization, replacement, immutability,
  and retirement race.
- Loaded portable replay exposed a same-process sync/async starvation: an
  unnecessary async wrapper yielded while the SQLite writer transaction was
  open, so synchronous re-attestation could not allow finalization to run.
  Exact replay was RED 0/1. Only genuine thenables are now awaited and local
  async acquisitions queue by resolved lock path; exact replay and full portable
  channel are GREEN 1/1 and 29/29.

### R3.3 exact fixture and historical residue closure

- The bounded inventory considers only real, non-link, immediate Temp children
  in the closed B2 prefix set and explicitly excludes the production default.
  It bounds recursive evidence, owner count/input size, and process inventory;
  validates nonce, launch state, PID/birth, and encoded/raw command-line
  references; and deletes only absent or exact birth-mismatched ownership.
- Controller-authorized temporal mismatch rules are narrow and guarded: an
  enumerated descendant born before its durable root is impossible ownership,
  and a birthless recorded PID whose current birth is later than the last
  durable record update is PID reuse. Those rules removed only the two exact
  named historical roots after all real root/supervisor/post-root references
  were absent; Edge and Python were not signalled. Historical inventory then
  reached zero.
- Empty coordination DB residue is retired atomically under `BEGIN IMMEDIATE`
  only after exact schema/version and zero holder/proposal validation; corrupt
  evidence remains. Passing Windows and POSIX fake-owner fixtures initially
  left one and then eight sibling DBs (the required cleanup-removal RED proof).
  Exact `finally` cleanup/assertions plus the retirement audit removed them;
  reruns are Windows exact 1/1 and POSIX 9 pass/one explicit host skip with
  inventory `[]`.
- Current concurrent affected gate is GREEN 125/125 across residue, real crash
  locks, semantic probes, portable channel, and Windows portable/Job tests.
  Complete Windows is GREEN 64/64. Required compatibility first showed one
  load-only 30 s process-tool timeout at concurrency three; it passed exact and
  its complete file 8/8. The required serial compatibility rerun is GREEN:
  388 total, 387 pass, zero fail/cancelled, one explicit POSIX-host skip.
  Post-gate exact B2 inventory and live owned-helper count are both zero.
- Runner typecheck, targeted ESLint, static actor/dependency/raw-lock/Node-pin/
  product-routing checks, and diff check are GREEN (line-ending notices only).
  The final uninterrupted serial package gate and post-gate report/commit are
  still required. B2 remains locked and B3 has not started.

### Round 3 final broad gate and cleanup evidence

- The first serial package gate completed 1,377 tests: 1,374 pass, two fail,
  zero cancelled, and one explicit POSIX-host skip. One failure was the
  evidence-family test-only broker wrapper expiring at 30 seconds after the
  command mechanics had completed; exact replay completed in about 44.3
  seconds. The wrapper-only 30-second bound is retained as the RED mutation.
  Its focused bound is now 60 seconds, while the test captures and explicitly
  asserts that the production command timeout remains exactly 25,000 ms. Exact
  replay is GREEN in about 44.2 seconds and the complete evidence file is GREEN
  16/16. No product timeout, retry, global suite timeout, or operation semantic
  changed.
- The other first-gate failure was a Windows fixture cleanup `EPERM` after the
  authenticated portable write-takeover behavior had passed. Removing the
  established authenticated cleanup helper reproduced the retained-root RED;
  reverting the helper is GREEN 1/1 in about 8.1 seconds with exact inventory
  `[]`. This changed fixture cleanup only and did not add time-based deletion.
- The final uninterrupted serial `npm run test:runner-v2` package gate is
  GREEN, exit 0: 1,377 total, 1,376 pass, zero fail, zero cancelled, and one
  explicit POSIX-host skip, in 974.37 seconds. Every chained Runner client,
  native-policy, policy-UI, cutover, pause-gate, model-usage, live-state,
  transcript, files, run-stats, steering, and observability check also passed.
- The immediate and three-second-settled post-gate helper inventories are both
  zero, and the closed-prefix B2 Temp inventory is exactly `[]`. Fresh Runner
  typecheck, targeted ESLint, static actor/dependency/raw-lock/Node-policy/
  product-routing checks, and `git diff --check` are GREEN; diff check reports
  line-ending notices only. No SQLite DB, journal, WAL, SHM, supervisor, Job
  host, or closed-prefix fixture root remains. B2 remains locked for independent
  review, and B3 has not started.

## Fix round 4 implementation evidence

- The reviewer command was first replayed unchanged at authority commit
  `0a310341`: 48/48 passed, while its previously captured physical RED remained
  authoritative (`aiboard-windows-semantic-duplex-QPXulx`, exact supervisor PID
  30336, recycled child PID 61496). The governed cleanup later stopped only PID
  30336 after exact current birth, command/config root, nonce, and durable-state
  checks; PID 61496 was absent/replaced and was never signalled. The exact root
  was removed and the closed inventory reached zero.
- R4.1 added an injectable generic-POSIX birth inspector. The initial missing
  export was RED. Injected `ESRCH` is the sole absence proof; exact-live refuses,
  exact birth mismatch remains reclaimable, and `EPERM`, timeout, malformed/empty
  birth output, generic tool failure, and unresolved exit/reuse races are unknown.
  Replacing the `ESRCH` result with unknown made the focused guard RED; revert is
  GREEN. Final self-review also added the missing bounded recheck after a second
  birth-inspection failure: its injected exit-after-failure case was RED, then
  GREEN in both Node 24 and Node 22.13 lock groups. Linux `/proc` and Windows inspection were not changed. No macOS host was
  available, so real macOS validation is explicitly unavailable rather than
  claimed.
- R4.2 moved native and portable SQLite coordination inside each durable identity
  directory. Retirement commits the protocol tombstone, rejects/removes queued
  proposals, closes SQLite, then removes the enclosing authority. Stale sync,
  async, and concurrent arrivals perform zero effects and cannot recreate a
  missing parent. Restoring sibling unlink/recreate behavior was RED; revert is
  GREEN. Job state keeps its durable `backendOwnershipReleasedAt` tombstone and
  permits first DB initialization only after an active durable-record check;
  stale post-release claims remain typed refusals with no DB/sidecars.
- A post-commit authority-removal fault is observable and recoverable. The first
  release surfaces `OwnedFenceAuthorityRetirementError` and leaves the retired
  protocol/evidence intact. A later release validates the retired schema/version,
  zero holders/proposals, exact durable fence, identity/birth, terminal/output/
  emptiness evidence, and current release authority, then removes the directory
  without reopening an effect. Removing this retry made the real portable guard
  RED; revert is GREEN. Corrupt, active, or foreign retired state remains.
- R4.3 cleanup now independently inventories bounded exact owners, distinguishes
  recycled births, validates the encoded supervisor config/root, and uses bounded
  exact supervisor tree termination before a second no-owner proof and deletion.
  Removing the authenticated supervisor fallback made the real replacement-PID
  guard RED (`false !== true`); revert is GREEN and leaves no process/root. Probe
  cleanup errors are aggregated rather than suppressed, and every affected test
  finally path removes only authenticated evidence.
- R4.4 keeps broad-prefix detection separate from deletion authority. Deletion
  has a closed exact fixture-prefix list and requires either a valid recognized
  Runner state document or a current-invocation root sentinel. Unrelated
  `keep.txt`, empty, malformed, unregistered, link/escape, oversized, and live or
  uncertain roots remain detected but preserved. Restoring zero-document/broad
  prefix authorization removed three protected fixtures and was RED; revert is
  GREEN 7/7. The production-default portable root remains excluded.
- The original focused command now contains five new guards and is GREEN 53/53.
  Complete portable plus Windows is GREEN 95/95. A three-file concurrent run
  first found one load-only portable cleanup `outcome_unknown`; the exact case
  was GREEN, its single authenticated residue was removed through the governed
  helper, and the current concurrent rerun is GREEN 113/113. Complete B1/8.0A/
  Task 5/7/3 compatibility is GREEN 357/357. Node 22.13.0 and Node 24 lock suites
  are both GREEN 12/12.
- Repeated exact diagnosis of the pre-existing 65 MiB evidence fixture produced
  five exact managed-supervisor roots. Each supervisor was matched to one durable
  Job-host record and exact script identity, stopped by literal PID/tree, observed
  absent, and its literal no-reference root removed. The evidence guard is GREEN
  in about 44 seconds under its unchanged 60-second test broker bound while still
  asserting the unchanged 25,000 ms production command timeout.
- Final pre-gates and post-gates are GREEN: Runner typecheck, targeted ESLint,
  static actor/dependency/coordination/Node-policy/product-routing audit, and
  `git diff --check` (line-ending notices only). The uninterrupted serial
  `npm run test:runner-v2` gate exited 0: 1,384 total, 1,383 pass, zero fail,
  zero cancelled, and one explicit POSIX-host skip in 973.16 seconds; every
  chained client/policy/UI/observability script passed. After a bounded settle,
  live managed/portable supervisors = 0 and exact B2-prefix roots = 0. No B3,
  OCI-family activation, production deadline change, or Node patch pin was made.
  B2 remains locked for fresh independent review.

## Fix round 5 implementation evidence

- R5.1 now treats an exact durable Job release record as a revocation tombstone
  that still requires coordination retirement. The injected post-record SQLite
  finalization failure remains observable on the first release; exact retry
  validates schema, ownership key, process identity, writer fence, and released
  state, revokes the otherwise-live holder, rejects/removes queued proposals,
  closes the database, and removes its DB/journal/WAL/SHM authority. Removing
  that recovery retained the holder and residue (RED); reverting it is GREEN.
  Two releases queued before the first commit persist exactly one release effect,
  while the second performs only governed cleanup. Calls queued behind release
  refuse at the final active-state transaction boundary. Corrupt, foreign,
  wrong-session/run/process/fence, and active-record cases preserve evidence and
  refuse forced retirement.
- R5.2 replaces recorded-PID-only closure with one bounded global Windows
  inventory containing PID, exact birth, parent, executable, and full command
  line. Literal and base64/base64url normalized-root references are detected,
  including unlisted processes. Only the exact PID/birth/nonce/encoded-root
  supervisor can be stopped; recycled recorded children and unlisted referrers
  are never signalled. A real unlisted-referrer fixture preserves the root while
  that process is live and removes it only after the referrer exits. Removing
  the global-reference check made the deletion guard RED; revert is GREEN.
  Timeout, malformed/truncated inventory, inaccessible command-line evidence,
  and unresolved references all fail closed and preserve the root.
- Windows birth inspection is batched, `ESRCH` remains the only fast absence
  proof, and temporal descendant decisions use current birth evidence. The
  cleanup operation uses one caller-configurable absolute budget, shared by
  inventory, authenticated stop, and recheck rather than resetting a timeout at
  each step. Its portable default is 15 seconds; a deterministic guard observes
  remaining budgets `100 -> 90 -> 80 -> 70 -> 60`, and an exhausted budget never
  invokes `taskkill`. No build-task limit, product command deadline, or retry cap
  was raised or introduced.
- Final adversarial review found a separate terminal/output race exposed by the
  existing 65 MiB evidence guard: the durable Job could be terminal while its
  output pipe was still draining. Durable `jobEmptyProof`,
  `terminationRequested`, and output-ack status now distinguish process-tree
  emptiness from completed output settlement. Status reattestation and the
  fenced evidence read are fused into one durable lock turn, while the host
  still reloads and compares the durable writer fence for every effect. This
  preserves the 256 KiB retained window and unchanged 25,000 ms production
  command timeout. Before the throughput repair the command reached
  67,174,407 of 68,157,454 expected stdout bytes at the deadline (RED). Diagnostic
  64 KiB and 256 KiB chunk-size mutations remained RED/worse and were reverted.
  The unchanged-cap/deadline implementation is GREEN in 18.25 seconds; its
  higher-fence takeover, missing-evidence, producer-backpressure, coalesced-ack,
  terminal-settlement, and sink-failure neighbours are GREEN 8/8, and the full
  evidence file is GREEN 16/16.
- The unchanged reviewer reproduction is GREEN 57/57. Node 24.18 and the policy
  floor Node 22.13 lock groups are GREEN 12/12 each. Affected concurrent process
  host/channel/backend coverage is GREEN 122/122. B1/8.0A/Task 5/7/3
  compatibility is GREEN: 378 total, 377 pass, zero fail, and one explicit
  POSIX-host skip. The Windows Runner group is GREEN 70/70, including an exact
  replay of one load-sensitive portable descendant cleanup case. Semantic
  cleanup targeting is GREEN 6/6.
- The final uninterrupted serial `npm run test:runner-v2` gate exited 0:
  1,393 total, 1,392 pass, zero fail, zero cancelled, and one explicit POSIX-host
  skip in 783.215 seconds. Every chained Runner client, native-policy, policy-UI,
  cutover, pause-gate, model-usage, live-discussion, transcript, native-files,
  run-stats, steering, and observability check passed. Fresh Runner typecheck,
  targeted ESLint, `git diff --check`, Node-policy/pin, actor/dependency, raw
  process, and product-routing/B3 static audits are GREEN. The Node policy
  remains exactly `>=22.13.0 <23 || >=24.0.0 <25`; no exact Node patch pin,
  family migration, OCI activation, or B3 change was added.
- No live managed, portable, or Job helper remains, and the gates created no new
  B2 roots. Governed cleanup removed the one historical deletion-authorized
  semantic fixture. Two older B2 roots remain intentionally preserved because
  their durable outcomes are fail-closed/uncertain: one portable write-effect
  root with `outcome_unknown`, and one Job root with `exited_unknown`. Every
  recorded PID is absent and a current global audit finds no literal or encoded
  reference, but the evidence does not meet deletion authority. A separate old
  failed production fixture is likewise outside B2 deletion authority. Manual
  exact-root removal attempts were blocked before execution by host policy; no
  alternate-shell bypass was attempted. Thus the bounded settle finishes with
  zero live helpers, zero new roots, and zero deletion-authorized B2 residue,
  while correctly retaining unrelated/uncertain evidence.
- Fix round 5 implementation and verification are complete. B2 remains locked
  until a fresh independent scoped review reports zero Critical and Important
  findings. B3 has not started.

## Fix round 6 implementation evidence

- R6.1 binds every durable Windows Job record to the validated requested
  process ID used for its filename and operation. Startup loading, normal reads,
  fence claims/effects, released-tombstone recovery, and the final revocation
  assertion reject an embedded ID mismatch. Record and coordination paths are
  derived only through one contained-path validator; separators, traversal,
  corrupt identity, wrong owner/fence, and substituted records fail closed
  without touching another process record or coordination database. The exact
  `requested-a.json -> target-b` reproduction was RED before the binding and is
  GREEN after it; removing the equality/path binding makes the guard RED and
  reverting restores GREEN.
- R6.2 preserves executable-path and command-line accessibility as independent
  global inventory facts. An inaccessible post-root field now makes deletion
  uncertain unless immutable birth proves the process predates the exact random
  root. Both fields are searched for literal, standard-base64, and base64url
  references, including quoted and option-embedded payloads. Candidate count,
  encoded size, decoded size, total inventory, completion marker, and the
  caller's single cleanup deadline remain bounded. Inaccessible-metadata and
  embedded-payload reproductions were RED before the guards; removal mutations
  were RED; the reverted exact guards and unchanged reviewer group are GREEN.
- Adversarial replay found and repaired related lifecycle truth gaps without
  expanding B2. Portable command/control publication and retained output use
  atomic same-directory publication. A durable acknowledgement that wins the
  same fence transaction as takeover is reported as committed even if the old
  owner can no longer consume its proof. Historical PID plus a different exact
  birth is treated as the owned process being absent, never as authority over
  the replacement. Corrupt descendant evidence permits only an independently
  authenticated exact supervisor stop and never authorizes root deletion.
  Semantic probes now share one absolute operation deadline, and unchanged
  terminal/output ordering is preserved.
- Loaded Windows execution proved the former fixed startup observation windows
  were too short: two full-suite fixtures failed before takeover because both
  the controller and supervisor happened to time out their one exact birth
  query under host load. Startup identity discovery now begins with a bounded
  2-second probe, retries at 4 seconds and then the remaining bounded allowance,
  permits at most three attempts and 15 seconds of birth discovery, and shares
  one 30-second maximum with supervisor readiness. The supervisor records the
  actual attempt count/deadline. Normal Windows tree inventory likewise adapts
  its next per-attempt watchdog from measured host latency, capped at 15
  seconds. These are process-startup and inspection envelopes only; no build
  task, production command, retained-output, or model deadline changed.
- RED/GREEN guards cover a deliberately 3-second birth inspector (the first
  2-second attempt times out, the second succeeds), rejection of the former
  one-second controller cap, a hung inventory watchdog, truthful write/takeover
  acknowledgement, exact supervisor fallback, atomic publication, replaced
  historical births, and whole-probe deadline exhaustion. The affected
  concurrent pressure gate is GREEN 145/145 in about 80.5 seconds.
- Two diagnostic full gates supplied load-bearing RED evidence. The first was
  1,407 total / 1,405 pass / one fail / one explicit POSIX-host skip and exposed
  a reset semantic-probe deadline. The next was 1,407 total / 1,404 pass / two
  fail / one skip and exposed the fixed startup-birth windows. After exact
  repairs, the uninterrupted serial `npm run test:runner-v2` gate is GREEN,
  exit 0: 1,409 total / 1,408 pass / zero fail or cancelled / one explicit
  POSIX-host skip in 829.999 seconds. Every chained Runner client, policy, UI,
  cutover, pause, model-usage, live-state, transcript, files, run-stats,
  steering, and observability check also passed.
- Fresh post-gate Runner typecheck, targeted ESLint over all ten changed
  source/test files, and `git diff --check` are GREEN. The current Node 24 and
  minimum Node 22.13 ownership-lock groups are both GREEN 12/12. Static scope
  audit confirms only the approved adapter/host/supervisor/test surfaces
  changed; Node remains exactly `>=22.13.0 <23 || >=24.0.0 <25`; B3, OCI,
  production family routing, the 25-second command deadline, and the 256 KiB
  retained-output cap remain unchanged.
- Post-gate process inventory reports zero portable/managed Node supervisors
  and zero Windows Job hosts. The successful final gate created no new B2 root.
  Thirteen historical broad-prefix roots remain detected: eleven pre-existing
  fail-closed/unrelated roots plus
  `aiboard-portable-write-effect-fence-AT9tXs` and
  `aiboard-portable-published-stale-input-SwC5Lv` from the earlier RED gate.
  Those two exact supervisors were independently identity-, nonce-, root-, and
  birth-authenticated, stopped with their exact trees, and proved absent. A
  current governed cleanup pass removed zero roots because global inaccessible
  metadata still withholds deletion authority. This is zero live helper and
  zero deletion-authorized residue; uncertain evidence is deliberately
  preserved rather than deleted.
- Fix round 6 implementation gates are complete. B2 remains locked until a new
  independent scoped review reports zero Critical and Important findings. B3
  has not started.

## Fix round 7 implementation evidence

- The fresh round-6 review reported zero Critical and three Important findings:
  a hard-link coordination alias could retire another process's database;
  alphabet prefixes/suffixes could hide encoded root references; and semantic
  probe prewarming/startup reset the advertised operation budget. The exact
  reproductions were RED: missing alias rejection, root deletion for
  `A<base64url(root)>`, and a 50 ms probe returning after about 3.27 seconds.
- R7.1 stores a SHA-256 exact-path authority in every new coordination database
  and protects it with immutable update/delete triggers. Acquisition, effect,
  revocation recovery, retired cleanup, and governed residue cleanup validate
  the same authority inside their transaction boundaries. Symbolic links and
  multi-link paths refuse before mutation. A hard-linked bound database remains
  foreign after its original name is removed. Empty single-link legacy state
  migrates transactionally; non-empty legacy ownership is unbound and remains
  untouched. Removing either production or cleanup authority validation made
  the exact regressions RED; restoration is GREEN.
- R7.2 scans bounded base64 and base64url start/end phases rather than trusting
  only the maximal alphabet run. Direct, JSON-escaped, and decoded structured
  references are detected with the existing encoded/decoded/candidate limits.
  Prefix, suffix, and longer alphabet-wrapped fixtures were RED before the
  repair and GREEN afterward in both semantic and residue cleanup paths.
- R7.3 propagates one absolute operation deadline through Windows inventory
  prewarm and the portable startup handshake. The backend refuses an expired
  absolute deadline before creating launch state and never resets it after
  spawning. The unchanged 50 ms reviewer reproduction is GREEN in about
  0.18 seconds; the expired-startup fixture is GREEN in about 0.004 seconds.
  Owned cleanup retains its separate bounded safety budget.
- Focused and impact gates are GREEN: affected concurrent pressure 162/162;
  compatibility 105 pass plus one explicit POSIX-on-Windows skip; current Node
  and Node 22.13 ownership-lock groups 14/14 each; Runner typecheck, targeted
  ESLint, and diff integrity all exit zero.
- The uninterrupted final `npm run test:runner-v2` gate exits zero: 1,414 total,
  1,413 pass, zero fail or cancelled, and one explicit POSIX-host skip in
  799.836 seconds. Every chained Runner client, policy, UI, cutover, pause,
  model-usage, live-state, transcript, files, run-stats, steering, and
  observability check also passed.
- Post-gate inventory reports zero portable/managed supervisors. Governed
  cleanup removed zero entries and the same thirteen historical
  fail-closed/unrelated roots remain; the successful gate created no new B2
  residue. Node remains `>=22.13.0 <23 || >=24.0.0 <25`. B3, OCI activation,
  product routing, production command limits, and the 256 KiB retained-output
  cap remain unchanged.
- Fix round 7 controller verification is complete. B2 remains locked until a
  fresh independent scoped review reports zero Critical and Important findings.
  B3 has not started.

## Fix round 8 implementation evidence

- The fresh round-7 review reported zero Critical and three Important findings:
  no exact-path recheck after a fence claim and before the external effect;
  mixed standard-base64/base64url wrapper characters that prevented either
  scanner from decoding the maximal token; and acceptance of a process-birth
  result after the absolute startup deadline followed by a fresh positive state
  allowance. The exact guards were RED before repair: the post-claim hard link
  reached the effect, both cleanup scanners deleted referenced roots, and the
  late-birth fixture reported an incidental supervisor timeout instead of the
  exhausted caller deadline.
- R8.1 carries the resolved coordination path through the live fence context
  and revalidates its exact single-link authority before proposal mutation,
  inside claim transactions and before their commits, at the external-effect
  boundary, and before finalization/retirement mutation and commit. The
  post-claim hard-link guard is GREEN and the effect count remains zero.
- R8.2 attempts every existing bounded start/end phase with both base64 decoders
  independently. Strict standard-base64 wrapped in base64url-only characters
  and strict base64url wrapped in standard-only characters are detected by both
  the production semantic cleanup and governed B2 cleanup paths. Existing
  candidate, encoded, decoded, inventory, and deadline bounds are unchanged.
- R8.3 passes one absolute startup deadline through process-birth inspection
  and supervisor-state readiness, rechecks it after blocking inspection and
  state reads, and never resets an expired budget to one millisecond. The 150 ms
  birth inspection under a 50 ms caller deadline now rejects specifically for
  the exhausted startup deadline. The existing adaptive Windows inspection
  attempts and separate owned-cleanup safety budget remain unchanged.
- Exact reviewer regressions are GREEN. The four directly affected modules are
  GREEN 132/132. The portable compatibility group is GREEN 137 pass plus one
  explicit POSIX-on-Windows skip. The current Node 24.18 runtime and Node 22.13
  capability floor ownership-lock groups are GREEN 15/15 each. This records
  tested runtimes only; the supported range remains the maintained-line policy
  `>=22.13.0 <23 || >=24.0.0 <25`, not either exact patch.
- The first full gate supplied useful loaded RED evidence after 1,414 tests had
  passed: one pre-existing portable-channel test inferred durable process
  termination solely from retained-output deletion and raced the independent
  stopped-state publication. It ended at 1,416 total / 1,414 pass / one fail /
  one expected skip in 877.715 seconds. The exact check immediately passed in
  isolation, proving load sensitivity. The test-only repair now awaits the
  channel's public terminal contract before release; no production process or
  timeout behavior changed. The exact check and its complete module are GREEN
  1/1 and 32/32.
- The required uninterrupted final `npm run test:runner-v2` gate exits zero:
  1,416 total, 1,415 pass, zero fail or cancelled, and one explicit POSIX-host
  skip in 851.691 seconds. Every chained Runner client, native policy, policy
  UI, cutover, pause-gate, model-usage, live-state, transcript, native-files,
  run-stats, steering, and observability contract also passed.
- Fresh post-gate Runner typecheck, targeted ESLint over all nine changed
  source/test files, `git diff --check`, changed-file scope, and Node-range
  audits are GREEN. Post-gate process inventory reports zero live portable,
  managed, or Job helpers. Governed cleanup removed zero entries; the same
  thirteen historical fail-closed/unrelated roots remain and the successful
  gate created no new B2 residue. No uncertain evidence was deleted.
- Fix round 8 controller verification is complete. B2 remains locked until a
  fresh independent scoped review reports zero Critical and Important findings.
  B3 has not started.

## Fix round 9 implementation evidence

- The fresh round-8 review reported zero Critical, two Important, and one Minor
  finding: revoked recovery could commit and remove a coordination name after
  an in-transaction hard-link injection; a late exact birth was discarded
  before it could authorize failure cleanup; and generic POSIX birth discovery
  had inherited the full startup window instead of its prior one-second cap.
  Each exact reproduction was physically RED before repair: the recovery guard
  failed with `Missing expected rejection`, the deadline fixture reported a
  live recorded owned process after rejection, and POSIX discovery consumed
  about 4,003 ms instead of the required sub-1,750 ms envelope.
- R9.1 revalidates the exact regular, non-symbolic, single-link coordination
  path after the in-transaction revocation assertion, before recovery commit,
  inside retired-cleanup transactions, before their commit and callback, and
  immediately before default physical protocol removal. The injected hard-link
  guard is GREEN in about 0.37 seconds: recovery rejects, retirement rolls back,
  the active holder remains, and neither path name is removed.
- R9.2 distinguishes exact birth discovery from timely birth discovery. A late
  exact fingerprint creates only the minimum internal identity and holder proof
  needed by the existing fenced failure-cleanup path; it is rejected before
  state readiness and can never be returned as launch success. The strengthened
  Windows regression is GREEN in about 2.2 seconds and proves, before emergency
  fixture cleanup, that no binding was returned, every recorded supervisor and
  target PID is absent, and the owned state directory is empty.
- R9.3 derives a platform-specific absolute discovery deadline bounded by the
  earlier overall startup deadline. POSIX keeps a one-second total discovery
  envelope; Windows keeps the existing adaptive 15-second maximum and
  three-attempt cap. The POSIX guard is GREEN in about 1.005 seconds. No build
  task, production command, model, retained-output, or overall startup policy
  was changed.
- The complete affected group is GREEN: 139 total, 138 pass, zero fail, and one
  explicit POSIX-live-fixture skip on Windows in 116.101 seconds. Managed
  process, backend-contract, and subprocess-runtime compatibility is GREEN
  96/96 in 20.019 seconds. The current Node ownership-lock group is GREEN 16/16
  within the affected run, and the minimum Node 22.13 group is independently
  GREEN 16/16 in 5.273 seconds.
- The required uninterrupted `npm run test:runner-v2` gate exits zero: 1,418
  total, 1,417 pass, zero fail or cancelled, and one explicit POSIX-host skip in
  820.803 seconds. Every chained Runner client, native policy, policy UI,
  cutover, pause-gate, model-usage, live-state, transcript, native-files,
  run-stats, steering, and observability contract also passed.
- Fresh post-gate Runner typecheck, targeted ESLint over all five changed
  source/test files, `git diff --check`, changed-file scope, and Node-range
  audits are GREEN. Node remains `>=22.13.0 <23 || >=24.0.0 <25`; it is not
  pinned to an exact patch. Post-gate process inventory reports zero live
  portable, managed, Job-host, or TERM-ignore helpers. Governed cleanup removed
  zero entries; the same thirteen historical fail-closed/unrelated roots remain
  and the successful gate created no new B2 residue. No uncertain evidence was
  deleted.
- Fix round 9 controller verification is complete. B2 remains locked until a
  fresh independent scoped review reports zero Critical and Important findings.
  B3 has not started.

## Fix round 10 implementation evidence

- The fresh round-9 review reported zero Critical, one Important, and zero
  Minor findings. Revoked recovery treated an absent main database as authority
  to delete sidecar-named files, while present-main cleanup retained only a
  shape check and could not distinguish its verified database from a later
  regular single-link replacement. The three prior round-9 fixes were accepted.
- Three physical regressions were RED before repair. With only `<lock>-wal`
  present, recovery deleted the sentinel and the assertion failed with `ENOENT`.
  Both a captured-main replacement and a linked sidecar incorrectly completed
  without the expected rejection. The separated post-capture-sidecar guard was
  additionally proven RED by moving revocation ahead of authority capture, then
  reverting the mutation. Removing each of the absent-main, stable-main, and
  single-link guards likewise made only its exact check RED. After every
  mutation was reverted, the exact group is GREEN 4/4 in 0.535 seconds and
  preserves every foreign byte and path.
- R10.1 returns without physical mutation when the main coordination database
  is absent. It neither creates a database nor interprets sidecar names as
  deletion authority.
- R10.2 captures a portable stable filesystem identity from BigInt stat facts
  (device, inode/file index, and birth time) immediately around the exact
  database open. That identity follows proposal, claim, effect, finalization,
  recovery, and retirement. Physical retirement additionally reopens and
  validates the exact retired protocol authority after close, then snapshots
  only regular, non-symbolic, single-link sidecars while the same main identity
  remains present.
- R10.3 repeats external revocation validation immediately before physical
  mutation. Cleanup revalidates the captured main before inspecting each
  sidecar, requires an exact captured sidecar identity before unlink, confirms
  no sidecar appeared or changed, and revalidates the main immediately before
  its unlink. Main disappearance/replacement, new or replaced sidecars,
  symbolic links, and multiple links fail closed. Only the pre-existing bounded
  transient access/busy failures are retried.
- The exact-current ownership-lock module is GREEN 20/20 in 4.753 seconds.
  Targeted backend/Windows Job release contracts are GREEN 19/19. The affected
  cross-platform matrix is GREEN: 152 total, 151 pass, zero fail, and one
  explicit POSIX-live-fixture skip on Windows in 131.844 seconds. Managed
  process and subprocess-runtime compatibility is GREEN 87/87 in 23.838
  seconds. The minimum Node 22.13 lock group is independently GREEN 20/20 in
  5.559 seconds; current Node is covered by the complete and affected groups.
- The final exact-current uninterrupted `npm run test:runner-v2` gate exits
  zero: 1,422 total, 1,421 pass, zero fail or cancelled, and one explicit
  POSIX-host skip in 882.610 seconds. Every chained Runner client, native
  policy, policy UI, cutover, pause-gate, model-usage, live-state, transcript,
  native-files, run-stats, steering, and observability contract also passed.
- Fresh post-gate Runner typecheck, targeted ESLint, `git diff --check`, scope,
  and Node-range audits are GREEN. Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`; it is not pinned to an exact patch. Process
  inventory reports zero live portable, managed, Job-host, or TERM-ignore
  helpers. Governed cleanup removed zero entries; the same thirteen historical
  fail-closed/unrelated roots remain and the successful gate created no new B2
  residue. No uncertain evidence was deleted.
- Fix round 10 controller verification is complete. B2 remains locked until a
  fresh independent scoped review reports zero Critical and Important findings.
  B3 has not started.
