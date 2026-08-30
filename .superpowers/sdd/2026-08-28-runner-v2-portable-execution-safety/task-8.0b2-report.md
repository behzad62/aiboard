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
