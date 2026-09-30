# PX-2c — Pre-started spare Job-host pair (lane C)

Outcome: at most one PowerShell Job host plus supervisor waits idle with NO
Job and NO child; the next call claims the pair and then runs its OWN Job
(suspended-create, assign, resume, kill-on-close) exactly as today. Measured
on this machine (n=20, same script as PX-2t/PX-2a/PX-2b): quiet median
661.5 ms -> 475.6 ms, p90 677.1 -> 499.6; large 793.5 -> 621.5; rev-parse
713.6 -> 542.4 (same command as PX-1). Fence effects unchanged at 11/13/13
per call. No commit, stage, stash or push. `git status` shows only the files
below. Earlier `wip(px-2t)`/`wip(px-2a)`/`wip(px-2b)` commits untouched.

Machine: Windows 10 Pro 10.0.19045, 16 CPUs, node v24.18.0, git
2.53.0.windows.1, PowerShell 5.1. Backend on this machine:
`runner-windows-job-v1` (every run re-verifies empirically). Unattended
pipeline; background OS load unknown, so wall-clock deltas carry machine
noise — the claim accounting (60 claims, 0 fallbacks over the 60 timed calls)
is the exact part.

Contract: plan CD-21 / PX-2c; PX-1-review-r1 conditions 2 (one Job per call,
new exact-empty proof in writing), 3 (concurrency), 4 (output bounds), 5
(spawn authority private), 6 (lifecycle), 7 (real-host tests), 8 (acceptance
number from measurement; 200 ms out of reach, see §5), 9 (suites green).

Changed files (writable set respected; the guarantee file, the speed file and
the fence-effects file are byte-unchanged):

- `runner-v2/src/managed-process-supervisor.mjs` (sha256 `382cf12a…`)
- `runner-v2/src/windows-job-process-host.ts` (sha256 `6de3187d…`)
- `runner-v2/src/execution-host.ts` (+5, retire at run-end cleanup)
- `runner-v2/scripts/measure-git-launch.mts` (additive `PX2C_SPARE=1` mode)
- `runner-v2/test/windows-job-spare-host.test.ts` (new, 9 tests)
- `runner-v2/test/fixtures/px2c-spare-parent.mts` (new, parent-death fixture)
- this file `PX-2c.md` (evidence)

## 1. Design

One Job per call always (condition 2): the spare pair never owns a Job. The
expensive boot (node supervisor bind ~66 ms plus PowerShell parse plus the
ps1 `ReadLine` gate) happens before the call; the call's Job is still
created suspended, assigned, and resumed for that call only, with
kill-on-close. Exact-empty proof unchanged: the per-call Job-host process
exit plus pipe EOF, exactly as today (no new proof needed — the proof was
never the boot). The ps1 needed no change: interactive mode blocks on
`[Console]::In.ReadLine()` (ps1:774) before `RunInteractive` creates the Job
(C#:338), so holding the supervisor's stdin write parks PowerShell with no
Job and no child by construction.

Spawn authority stays private (condition 5): the reservation travels over
the existing supervisor stdin pipe; the claim (which creates the Job)
travels over the existing runner↔supervisor IPC channel (`launcher.send` /
`process.on("message")`, token-checked with `timingSafeEqual`). HTTP can
only observe an unclaimed spare (`/status`, `/wait-status`); every POST
before the claim fails closed with `spare_unclaimed`. No new token: the
spare reuses the per-pair Bearer. [REDACTED] who can read it is unchanged (runner
memory + supervisor argv-excluded).

## 2. Lifecycle (condition 6)

- Prestart (`prestartSpare`, explicit or `spare.autoRefresh`): one
  supervisor + one Job host, record persisted durably with
  `spare:true, spareClaimed:false` (a crash leaves no untracked process).
  At most one per host instance; concurrent prestarts share one flight.
- Claim (`launchOwned` head): synchronous slot take (two concurrent calls
  can never take one spare), then liveness (launcher alive, record
  spare+unclaimed+owner match, status spare+unclaimed+ready+starting with
  matching pids and port), then IPC claim (supervisor re-checks token,
  single-claim flag, job shape, backend alive). Any miss → `null` → today's
  fresh-launch path. After a successful claim the host disconnects/unrefs
  exactly like a normal launch; with `autoRefresh` one replacement starts
  in the background (never awaited by the call).
- Single use: the supervisor clears its unclaimed flag before acking and
  persists `claimed:true`; the record flips to `spareClaimed:true`. A
  second claim is rejected supervisor-side; host-side the slot is already
  consumed.
- Idle timeout: supervisor-side timer (default 60 s, clamped 1–300 s, so it
  survives a runner crash), retires with reason `idle-timeout`.
- Parent death: the runner holds the spare's IPC open (normal launches
  disconnect after handoff), so a broken channel means the owner is gone:
  the supervisor kills the waiting Job host and exits with reason
  `parent-dead`. Claimed/normal launches keep survive-for-adoption.
- Run end: `binding.close()` retires the spare (abort IPC, SIGKILL
  fallback, record+dir removal, disk sweep); zero leftover processes.
- Crash recovery: the host constructor reaps unclaimed spare records on
  its state directory (kill pids, drop records) instead of adopting them;
  a spare is never relaunched as a call. A second claim flag or stale
  status can never promote a spare into a second call.
- Default: spare disabled (no option → no spare ever started, claim path
  is one map lookup). Production enablement (opt-in flag vs default-on) is
  left as an owner decision (see §7).

## 3. Tests (`runner-v2/test/windows-job-spare-host.test.ts`, 9 tests)

Real host throughout (`createExecutionHost` + `bindRun`, production Job
backend; host-level `launchOwned` only where ownership must differ).
Conventions follow PX-2t/PX-2a (win32 + backend skip discipline, per-test
timeouts <= 55 s, 90 s self-exit trees, finally-kill of identified PIDs,
zero-leftover gates). The parent-death test spawns the committed fixture
through the repo tsx CLI (real parent death, not a simulated disconnect).

| Test | What it pins |
|---|---|
| S1 claim + proofs | Spare recorded spare/unclaimed with no command, no event file, status starting/childPid 0; token call runs on the spare processId with exited/0/`verified_empty`/byte-exact stdout; record flips claimed; claims==1 |
| S2 per-call kill | TERM-ignoring tree claimed through the spare: `timed_out` + `verified_empty` + grandchild dead (2 s grace) on the spare's processId |
| S3 never reused | Two explicit spares, two calls, two processIds; first record stays claimed; first pair's status shows the claim |
| S4 run end | Private world: prestart, binding+host close → supervisor + Job host dead, record dropped, no live supervisors |
| S5 parent death | Fixture prestarts then exits without retiring → orphan supervisor dead, `spareRetired: parent-dead` recorded, never had a child; restarted host sweeps the record and adopts nothing |
| S6 crash recovery | Second host on the same dir reaps the spare (dead pid, record gone, stats zero), then serves a fresh call on a different processId — never relaunched |
| S7a dead spare | Killed pair → call succeeds fresh, fallback counted |
| S7b identity | Tampered supervisorPid in the status file → rejected, call succeeds fresh, fallback counted, live pair retired |
| S7c owner | Another run's call falls back fresh; the spare stays reserved (same processId, still unclaimed) |

Prove-red: one single-site fault per test, each restored byte-exact
(backup in scratch, sha256 before == after asserted by the fault runner;
fault sources kept under `%TEMP%` for re-run, not committed):

| Test | Fault (file) | Red result |
|---|---|---|
| S1 | host: claim call replaced with `null` | call runs on a fresh pair, `processId` assert fails |
| S2 | supervisor: claim always replies false | fallback pair, `processId` assert fails |
| S3 | supervisor: `status.claimed` never persisted true | claims still work, `must record its claim` fails |
| S4 | host: `retireSpare` early return | supervisor stays alive, death-wait fails |
| S5 | supervisor: disconnect handler `if (false)` | orphan survives, death-wait fails |
| S6 | host: constructor reap `if (false && …)` | spare survives restart, death-wait fails |
| S7a | host: fallback counter not incremented | fallback still works (defense in depth), counter assert fails |
| S7b | host: supervisorPid check `false && …` | tampered spare IS claimed, `must not serve` fails |
| S7c | host: owner check `if (false)` | cross-owner adopt fails downstream `process_not_owned`, call errors |

Two investigation notes kept honest: the first S3 fault candidate
(`spareUnclaimed` stuck true) reds through a different mechanism —
post-claim disconnect reads as parent death and the pair suicides, so the
first call falls back; the committed precise fault above is the one that
reds on the no-reuse evidence itself. The S7c red shows the owner check is
backed by a second layer (`ownedRecord` refuses cross-session use even if
a claim slipped through). The first S7a candidate (throw from the
fallback) stayed green because `fail()` is total and never throws — the
counter fault is the honest single-point red.

## 4. Before/after (`measure-git-launch.mts`, n=20, `PX2C_SPARE=1` for after)

| Sample | Before median / p90 | After median / p90 | Effects/call |
|---|---|---|---|
| quiet `status --porcelain=v1` | 661.5 / 677.1 | **475.6 / 499.6** (−186/−178) | 11 -> 11 |
| large `ls-files` (4000 files) | 793.5 / 825.3 | **621.5 / 653.9** (−172/−171) | 13 -> 13 |
| rev-parse HEAD (PX-1 cmd) | 713.6 / 727.0 | **542.4 / 553.4** (−171/−174) | 13 -> 13 |

Claim accounting (exact part): 60 timed calls, 60 claims, 0 fallbacks, 61
prestarts (one spare still live at binding close, retired there). Before
and after sit minutes apart on an unattended machine, so ms deltas carry
load noise; the 60/0 claim count is the structural proof the boot moved
off the critical path.

## 5. Validation suites and counts (`NODE_TEST_CONTEXT` cleared)

| Suite | Result |
|---|---|
| `windows-job-spare-host.test.ts` (new, conc 1) | 9/9 pass (final re-run after all fault restores) |
| `windows-job-real-host-guarantees.test.ts` + `windows-job-launch-speed.test.ts` (unchanged, conc 1) | 16/16 pass with the new file in one process |
| 9-file Windows Job batch + channel/terminal-observation/cleanup-bootstrap/owned-fence-lock/fence-effects (conc 4) | 310 tests: 309 pass, 0 fail, 1 skipped (pre-existing subprocess-runtime skip) |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| `eslint` on all six touched/added files | clean |
| `git diff --check` | clean |

Two findings while validating (both closed, no test touched): the E3
refactor (shared `currentJobConfiguration()` inside `launchWindowsJob`)
broke `windows-job-supervisor-input.test.ts`, which slices that function
into a VM — the literal is restored byte-identical with a keep-in-sync
note, and the builder stays for the claim path (2/2 green). One batch run
showed `windows-process-backend.test.ts:2621` fail with `control was
requested while release is pending` — same signature as PX-2b's documented
pre-existing load flake in an untouched file; the file alone is 96/96
green and the full batch re-run is green.

Condition 8 acceptance number: 200 ms/call stays out of reach on this
path without weakening the protocol. 11 effects x ~19 ms floor = ~210 ms
of fence floor alone, plus per-call Job create/spawn (~330 ms of the
remaining ~475 ms) plus ~100 ms runtime durable work. Honest remaining
levers: a lock-core cost reduction (needs its own review; PX-2b declined
it) — not a weaker fence, not Job reuse.

## 6. PX-1-review-r1 conditions 2, 3, 5, 6, 7, traced

- 2 (no Job reuse; new empty proof in writing): the spare never owns a
  Job; proof unchanged (per-call host-process exit + pipe EOF). S1/S2 pin
  per-call Job + kill; S3 pins single use.
- 3 (concurrency): slot take is synchronous; two concurrent calls cannot
  take one spare. PX-2t T5 (kill-one-while-other-finishes) and T9
  (attribution) stay green unchanged — the spare adds no shared mutable
  call state.
- 5 (spawn authority): stdin reservation + IPC claim, both token-bound;
  HTTP POST refused pre-claim (S5's supervisor serves no call; S7b's
  tamper rejected).
- 6 (lifecycle): idle timeout, parent-death retire, run-end retire with
  zero leftovers, crash reap without relaunch, old-record compatibility
  (non-spare records untouched by every new branch). S4/S5/S6.
- 7 (real-host tests): S1–S7c above, each red-proven.
- Guarantee/speed files green unchanged (§5 table).

## 7. Not done / limits

- Spare is opt-in (`spare: { idleTimeoutMs, autoRefresh }` or explicit
  `prestartSpare`); default behavior is byte-identical to today. Wiring it
  on by default (execution-host or script) is an owner call — the
  measurement shows what it buys (~175 ms/call).
- Readiness means "supervisor bound, Job host spawned, claim buffered":
  a claim landing mid-PowerShell-boot still pays the residual boot (pipe
  buffering makes it correct, not free). First-call-after-idle pays most;
  steady state (autoRefresh during the previous call) pays least.
- One spare per host instance (shared across runs of that host); a spare
  serves only its owner's run/session, others fall back (S7c).
- The `currentJobConfiguration()` builder duplicates the inline launch
  literal by VM-seam necessity; the two must stay identical (noted in
  code; S1/S2 exercise the claim copy, the VM test the launch copy).
- Measured with `permissionProfile: "full"` only (as PX-2t/PX-2a/PX-2b).
- The shared per-run broker is NOT built (CD-21: one Job per call always).
- Inserted source lines use LF inside CRLF files (same as PX-2a/PX-2b;
  `diff --check`, eslint, tsc clean; autocrlf notice only).
- No commit/stage/stash/push performed; earlier `wip(...)` commits
  untouched; this work is uncommitted for independent review.

## 8. Repair cycle 1 (answers PX-2c-review-r1: B1, B2 blocking; M1-M5; L1-L5; N4)

Worked on HEAD (descendant of `6a581f66`, above `cd475d57`; PX-2a/PX-2b repairs on
top, all their tests kept green). No commit/stage/stash/push; no amend,
reset, revert or rewrite of any commit. Spare stays OPT-IN (no default-on).

### B1 — no more blind PID kills (fixed)

- `killVerifiedSpareSupervisor(record, durable, timeoutMs)` in
  `windows-job-process-host.ts` is now the ONLY PID-kill site in the file
  (one `process.kill`, one allowlist container). It kills only after BOTH
  proofs: the durable status file already names this pair (protocol,
  processId, supervisorPid, unclaimed spare) AND the live supervisor answers
  authenticated `GET /status` with the record's token and the same identity
  (processId, supervisorPid, port, spare, unclaimed). Anything else returns
  `skipped` and the caller only drops the record. Never throws; bounded
  2 s proof timeout (`SPARE_REAP_VERIFY_TIMEOUT_MS`).
- Constructor reap and the run-end sweep both route through it. The record
  is still dropped synchronously (S5/S6 pin that); the durable status is
  snapshotted before the drop because the async proof still needs it (found
  by debugging S6: deleting first starved the proof and the spare survived).
- New tests (all in `windows-job-spare-host.test.ts`, win32-only, no backend
  needed): a planted spare-shaped record naming a live bystander drops the
  record and the bystander survives (incl. 2.5 s past the proof window); a
  PID-reuse-shaped record (live PID, fully matching file, dead port, silent
  token) is dropped without a kill.
- Prove-red (sha256 before/after, byte-exact restore): fault = blind kill +
  early `return "killed"` in the helper. `host 5599afe5…` → fault → negative
  test RED (bystander dead) → restore → `5599afe5…` again; same fault →
  reuse test RED → restore → `5599afe5…`. Repeated post-fix against the
  final shape: `host 4defa319…` → fault → negative test RED → restore →
  `4defa319…`, then the negative + claim-window tests re-run GREEN.

### B2 — task8-raw-launch-closure fully green (fixed)

- `managed-process-supervisor.mjs retireSpare`: `backend?.kill` deleted;
  routes through the already-allowlisted `stopOwnedTree` (same owned-handle
  kill, no new site). `+0` allowlist entries.
- Host `retireSpare`: redundant `entry.launcher.kill` deleted
  (`abortStartingSupervisor` already kills). `+0` entries.
- Host spawns (`launchOwned` + `startSpare`): one shared
  `spawnSupervisorProcess()` helper — one raw spawn site. The existing
  allowlist entry was RENAMED `launchOwned` → `spawnSupervisorProcess`
  (forced: the suite requires every entry to stay live/exact).
- The two `process.kill` sites became the one audited helper: `+1`
  allowlist entry with its reason (kill only after authenticated live-status
  proof, otherwise only the record is dropped).
- At HEAD: `task8-raw-launch-closure` 2/2 GREEN (was 8 violations at
  `cd475d57`, 5 from PX-2c). Allowlist diff: 1 rename + 1 addition; the
  supervisor needed none. Scope note: the brief allowed at most one
  addition; the rename is exactness maintenance the suite itself demands.

### M2 — no silent re-run after an acked claim (repair-1 claim CORRECTED in §9: r2 proved this was not fixed)

`tryClaimSpareCall`'s post-ack failure now falls back only on positive proof
no child ever started (`childPid === 0` in the durable status); otherwise it
aborts the launcher and throws `process_start_failed` exactly like the
normal path, keeping the record. No existing test hits that path (all
fallbacks in S7a/S7b happen pre-ack); S1/S2/S3/S10 green.

### M3 — retire/sweep scoped to the closing run; claim window marked (fixed)

- `retireSpare(closingRun?: { runId })`: the in-memory spare is retired only
  when its owner matches the closing run; the disk sweep skips other runs'
  records and skips `spareClaimInFlight` records (a concurrent claim).
  No-arg calls (tests, fakes) keep today's behavior. `execution-host.ts`
  passes `{ runId: input.runId }` (retire-scope-only edit).
- The claim window is persisted (`spareClaimInFlight: true`) BEFORE the IPC
  claim lands and cleared on the ack persist.

### L3 — claim-window crash keeps the audit trail (fixed)

Constructor reap keeps `spareClaimInFlight` records on disk (persisting
`spareReapedAt`) while still retiring the tree on identity proof; unclaimed
records are dropped as before. New test: claim-marked planted record is
kept with its reap note, bystander survives. `spareClaimed` records were
already (and still are) left alone — they are live calls.

### M5/N4 — spare-aware leak gate + spare-on run (fixed, narrowest)

`windows-job-real-host-guarantees.test.ts` only: `JobRecordView` carries
`spare/spareClaimed`; `assertNoLiveSupervisors` additionally ignores exactly
records with `spare:true, spareClaimed:false`. A claimed spare is a call and
is still enforced. `PX2C_SPARE_ON=1` injects a host with
`spare:{autoRefresh:true}` and prestarts AFTER the pre-existing baseline, so
the spare is ignored only through its durable record. No other assertion
changed.
- Prove-red: gate fault (clause removed) + spare on → 3/3 RED with
  `Job supervisors of this run did not settle within 20000ms`; restore →
  hash `d1b0644d…` again. Gate discrimination probe (`/tmp`, kept out of
  the repo): leaking call record fails the predicate, idle spare passes, a
  claimed spare still fails.
- Validation: guarantees 12/12 with the spare OFF and 12/12 with it ON.

### M4 — lifecycle/authority pins (added: S8, S9, S10, S11)

Idle-timeout retire (`spareRetired: idle-timeout`, never had a child);
token-holding POST to all six routes → 409 `spare_unclaimed` while GET
`/status` stays 200, then the refused spare still serves the call; two
concurrent calls take one spare exactly once (claims +1, both succeed);
`autoRefresh` provisions exactly one live replacement after a claim.
Spare file now 16/16 (was 9/9).

### M1 — not implemented (recorded)

No bootstrap at `bindRun`, no re-provision after miss/expiry: that would
start spare processes on every run even though the spare is deliberately
opt-in with no production path enabling it (review §"Default-on
recommendation" item 2 belongs to the enablement decision, with M2/M3/L3 now
done, M1 still open). `autoRefresh` re-provision after a claim is pinned by
S11. Revisit only together with default-on.

### L1, L2, L4, L5

- L1 fixed: the supervisor comment no longer claims the helper is
  pre-compiled (it says node + PowerShell boot; helper load stays
  post-claim).
- L2: prove-red faults above are single-site with sha256 before/after and
  byte-exact restores recorded here (fault sources are the two-line
  insertions quoted above, not loose files under `%TEMP%`).
- L4 (session mix): unmeasured — owner run is single-session; flag for the
  enablement measurement.
- L5 (memory): not re-measured; reviewer's ~140 MB per idle pair stands.

### Validation (this repair, `NODE_TEST_CONTEXT` cleared where the repo clears it)

- `windows-job-spare-host.test.ts` (conc 1): 16/16.
- `windows-job-real-host-guarantees.test.ts` (conc 1): 12/12 off, 12/12 on.
- 9-file batch (conc 4: backend, output-replay, supervisor-input,
  one-shot-command-family-production-matrix, execution-host,
  subprocess-runtime, durable-process-store, launch-speed, fence-effects):
  273 tests: 272 pass, 0 fail, 1 skipped (pre-existing).
- `task8-raw-launch-closure`: 2/2. `tsc` clean. `eslint` on all six touched
  files clean. `git diff --check` clean.
- Measure (`measure-git-launch.mts`, n=20, loaded machine): off quiet
  1565.9/1875.3, large 2064.2/2271.2, rev-parse 1836.4/2030.9 (median/p90);
  on: quiet 1322.2/1506.8, large 1556.4/1709.3, rev-parse 1446.8/1608.5;
  spare stats 61 prestarts / 60 claims / 0 fallbacks. Gain holds
  (~240-510 ms/call here; absolutes carry load noise, the 60/0 claim count
  is the structural proof).

Changed files: `runner-v2/src/windows-job-process-host.ts`,
`managed-process-supervisor.mjs`, `execution-host.ts` (retire scope only);
`runner-v2/test/windows-job-spare-host.test.ts` (+7 tests +2 helpers),
`task8-raw-launch-closure.test.ts` (1 rename + 1 entry),
`windows-job-real-host-guarantees.test.ts` (gate + spare-on switch only);
`runner-v2/scripts/measure-git-launch.mts` untouched; this file.

## 9. Repair cycle 2 (answers PX-2c-review-r2: N1, N2 blocking; N3, N5 + listener lows)

Worked on HEAD `f1ed5d2b` (above `54f15b17` plus the controller PX-2a fix
`241d5f64`). No commit/stage/stash/push; no amend, reset, revert or rewrite of
any commit. Spare stays OPT-IN. `execution-host.ts`, the supervisor, the
channel and the fixture are untouched in this cycle.

CORRECTION: §8's M2 subsection ("fixed") was a false claim. The r2 reviewer
reproduced the double run (command executed twice) through two swallows: the
post-ack `throw` sat inside the outer `try` whose `catch` returned `fail()`,
and `launchOwned` added `.catch(() => null)`. The real fix is below.

### N1 — claim-window crash retires the whole tree, keeps the record (fixed)

- New `retireVerifiedClaimWindowTree(record, durable, verifyMs, retireMs,
  stopMs)` in `windows-job-process-host.ts`. For a disk record with
  `spareClaimInFlight` it accepts `claimed:true` in the durable status AND in
  a live token-authed `GET /status` (same identity proof as B1: protocol,
  processId, supervisorPid, port, spare) as the EXPECTED state, then retires
  the whole tree through the supervisor's own authenticated `POST /signal`
  (`stopOwnedTree` keeps the single backend-kill site) and confirms through
  the supervisor channel (durable `stopped` plus a refused port — no PID is
  ever probed or killed in this helper). The call's durable record is never
  deleted; the constructor persists `spareReapedAt` before calling it.
- `killVerifiedSpareSupervisor` keeps B1 semantics by default and gains
  `acceptClaimed = false`: the claim-window retire calls it as the fallback
  (e.g. a fenceless call the signal cannot retire) with `acceptClaimed: true`.
  It remains the file's ONLY `process.kill` site — `task8-raw-launch-closure`
  is 2/2 with no test edit and no new allowlist entry.
- `tryClaimSpareCall` now persists the call's fence in the pre-ack
  `spareClaimInFlight` record, so a restarted runner's `/signal` satisfies the
  supervisor's fence check. Production calls always carry a fence; a fenceless
  claim-window orphan gets best-effort treatment (signal attempt, then the
  audited fallback) and its record is still kept.
- Constructor reap routes `spareClaimInFlight` records to the retire helper
  and every other unclaimed spare to the kill helper (each self-gates); a
  pre-ack crash (durable not yet claimed) is skipped by both and left to the
  supervisor's surviving idle-timeout retire, with the record kept.

### N2 — acked-claim failures surface, never re-run (fixed)

- `tryClaimSpareCall` sets `claimAcked = true` once the IPC claim is acked.
  The outer `catch` rethrows when acked (best-effort abort, record kept —
  `fail()` cleanup and its fallback count are pre-ack only); the proven
  `childPid === 0` inner path still returns `null` for a genuine fresh
  fallback. `launchOwned` narrows `.catch(() => null)` to rethrow
  `WindowsJobHostError` (unexpected non-host errors still fall back).

### Lows

- N3: the constructor's durable-status read is guarded — an unreadable status
  path (e.g. EISDIR) reads as "no proof" (record dropped, no kill) instead of
  throwing out of the constructor. A shared `readSupervisorStatusQuiet`
  covers the retire fallback the same way.
- N5: the guarantee gate now ignores exactly one live idle spare by its own
  record (a single live `spare:true, spareClaimed:false` record with no claim
  mark). Two leaked idle spares, a claimed spare, a `spareClaimInFlight`
  orphan (now also carried in the record view), and any outliving call
  supervisor still fail the gate.
- Listener binding (r2 N4): not bound to the PID. The live proof stays
  token + port + identity fields. A creation-time check would need a birth
  identity captured at spawn (the record carries none — `startedAt` is a
  wall-clock string, not a boot id) plus new inspection plumbing in the reap
  path; the forged-listener attack stays same-user-only (state-dir write plus
  a listener with the record's token). Recorded as enablement-time hardening,
  as r2 allows.

### Tests (spare file 16 → 19)

- N1: "a runner crash inside the claim window retires the tree and keeps the
  record" — a real doomed runner (tmp `.mts` through the repo tsx CLI,
  q.v. S5) prestarts, is SIGKILLed inside the claimed persist, and a new host
  on the same directory must leave neither supervisor nor child alive while
  the record survives with `spareReapedAt` and the claim mark.
- N2a: injected post-ack `applyStatus` failure (thrown only after the child
  appended once) asserts `process_start_failed`, exactly one execution, and no
  fallback. N2b: same shape for a throwing claimed-record persist (the throw
  waits for the single execution first, so the count is deterministic).

### Prove-red (sha256 working-tree hashes before/after, byte-exact restore)

Final file hashes (also the restore targets):
`windows-job-process-host.ts`
`332657e1cd09264fbd69ac605cb9b0faaaf37c9d511907f3922325b43ae16b6f`;
`windows-job-spare-host.test.ts`
`8267e537e6fac2b8a238df5bec6db2e68fa54561c230c5c1051e6508c19fd214`;
`windows-job-real-host-guarantees.test.ts`
`9960de5b45e92b5ab07eac29eae632a57bef9e6f68c7d83783cace3b841d89a1`.

| Test | Fault (single-line insertion, file) | Red result |
|---|---|---|
| N1 crash | retire helper opens with `return "skipped";` (claim-window retire disabled) | N1 test RED: `claim-window supervisor to die did not settle within 20000ms` (tree survives); 18/19 pass → restore → hash `332657e1…` again |
| N2a + N2b | outer catch opens with `if (false)` (acked-claim failure swallowed again) | both N2 tests RED: no surfaced error (`undefined` vs `process_start_failed`); 17/19 pass → restore → hash `332657e1…` again |

Fault backups lived under `%TEMP%` (`D:\tmp\px2cr2-host-backup.ts`) and were
copied back byte-exact (hash-verified); no fault is committed. The N1 red was
re-run on the final channel-poll retire shape after the task8-driven rework.

### Validation (`NODE_TEST_CONTEXT` cleared where the repo clears it)

- `windows-job-spare-host.test.ts` (conc 1): 19/19 (final shape, post-restore hash verified).
- `windows-job-real-host-guarantees.test.ts` (conc 1): 12/12 spare OFF, 12/12 spare ON (`PX2C_SPARE_ON=1`, N5 gate).
- `windows-job-launch-speed.test.ts` + `windows-job-fence-effects.test.ts` (PX-2b, conc 1): 46/46.
- `task8-raw-launch-closure.test.ts` (conc 1): 2/2, test file untouched.
- 7-file batch (conc 4: process-backend, output-replay, supervisor-input,
  one-shot-command-family-production-matrix, execution-host,
  subprocess-runtime, durable-process-store): 228 tests, 227 pass, 0 fail,
  1 skipped (pre-existing subprocess-runtime skip). The r2 load flake in
  `windows-process-backend.test.ts:1844` passed in this run.
- `tsc --noEmit -p runner-v2/tsconfig.json` clean; `eslint` on the three
  touched files clean; `git diff --check` clean; `git status` shows only the
  three intended files.

Changed files: `runner-v2/src/windows-job-process-host.ts` (N1/N2/N3);
`runner-v2/test/windows-job-spare-host.test.ts` (+3 tests, +1 import);
`runner-v2/test/windows-job-real-host-guarantees.test.ts` (N5 gate +
`spareClaimInFlight` view field only); this file.
