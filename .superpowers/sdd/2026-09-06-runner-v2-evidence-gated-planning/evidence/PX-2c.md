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
