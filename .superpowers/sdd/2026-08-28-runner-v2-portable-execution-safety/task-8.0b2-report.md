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
