# PX-2c independent review, round 1

- Reviewer: independent fresh-context reviewer (did not write PX-2c)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Packet: PX-2c, commit `cd475d57` (parent `e8eb8720` = PX-2b), branch `codex/runner-v2-px1`. Reviewed at its own commit in a detached scratch worktree. Later commits (PX-2t text fix, the PX-2a repair `5d6e6540`) are not in scope.
- Inputs: brief `px2c-brief-muse.txt`; plan CD-21 and PX-2c contract; `PX-1-review-r1.md` (conditions 2, 3, 5, 6, 7); `PX-2c.md`; `PX-2t-review-r2.md` (follow-up N4); `PX-2a-review-r1.md`; code and tests at `cd475d57`.
- Repo effects of this review: none. No source or test file edited, staged, committed or stashed in any real checkout. One permission-classifier denial: I tried to remove the pre-claim POST guard in my scratch copy for a fault probe; the classifier refused ("Security Weaken") and I did not retry or work around it (see "What I could not do").
- Cleanup: scratch worktree and junction removed junction-first (see the last section). My probe temp dirs (`%TEMP%\px2cr1-*`) are deleted. No process of mine is left.

sha256 of the changed files, as git blobs at `cd475d57` (LF):

| File | sha256 |
|---|---|
| runner-v2/src/managed-process-supervisor.mjs | `1006fad3f1938f78724c9dc2a25cf34ca25e4aa280c5f84ee8c72fd22d59d93b` |
| runner-v2/src/windows-job-process-host.ts | `fff08d9ae55df31a2c2d11c37bcd66980e55850c87967bccb1e727560c5650a5` |
| runner-v2/src/execution-host.ts | `6e3d70d8612607386d9239de6dec74b932624d1c2a427420d92a3887d5b8c5c1` |
| runner-v2/scripts/measure-git-launch.mts | `ec0cf2b064a81bddf8a57affa6161272a4ce9e7c57f95a9df66ff3efa832c61a` |
| runner-v2/test/windows-job-spare-host.test.ts (new) | `65694bd85c64c01f8cb222cdf9897e261b813ddfecd62f4df918a53bbd089616` |
| runner-v2/test/fixtures/px2c-spare-parent.mts (new) | `0c42ab2145a0d7353dffa9c84c8f2d54a81cddf233c7f37cefed0a909f59058e` |
| evidence/PX-2c.md | `35ed3da88e946738aafd705295a741edfb7fb968fb8202c3418ae82da6d0ffda` |

Unchanged at this commit (same blob as before PX-2c): `windows-job-real-host-guarantees.test.ts` `147a16d7…` (same as PX-2t `cb567e62`), `windows-job-launch-speed.test.ts` `a2c078f8…` (same as PX-2a), `windows-job-fence-effects.test.ts` `d3137ecf…` (same as PX-2b `e8eb8720`), `managed-process-job-host.ps1` `bb31734b…` (the ps1 is untouched, so the Job is created by exactly the code that ran before). `PX-2c.md` quotes `382cf12a…` and `6de3187d…` for two files; those are CRLF working-tree hashes, not blob hashes (same nit as PX-2a N9).

**Verdict: REPAIR — 2 blocking**

The design is sound where it matters most. The spare holds no Job and no child until claimed; the claim goes over the private IPC channel; a pre-claim POST is refused; idle timeout, parent death and run end all clean up; and the measured gain reproduces (about 150-200 ms per git call). Two defects stop acceptance. B1: crash recovery and the run-end sweep SIGKILL a PID read from a disk record with no identity check (proved with a probe). B2: the Task 8 raw-launch closure suite is red at this commit, with 5 violations that come from PX-2c code; the evidence never ran it.

## How I checked

- Read every changed line of the supervisor, host, execution-host, ps1 call sites, the measure script, the new test file and the fixture. Read the PX-1 review conditions, the plan contract and the PX-2t follow-up N4.
- Ran the tests at `cd475d57` (numbers below). Ran 10 real-host probes of my own against the unmodified code. Ran an A/B/C timing comparison.
- Machine was shared: another worker ran Windows Job suites and compiles at the same time. I judge by ratios and by pass/fail, not by absolute times.

## Test and suite results at cd475d57

| Check | Result |
|---|---|
| `windows-job-spare-host.test.ts` (9 tests, conc 1) | 9/9 pass, 68 s |
| `windows-job-real-host-guarantees.test.ts` (12, conc 1) | 12/12 pass |
| `windows-job-fence-effects.test.ts` (14, conc 1) | 14/14 pass |
| `windows-job-launch-speed.test.ts` (4, conc 1) | 4/4 pass twice on a quiet machine. On a loaded machine T1 ("no compiler may run") failed 5 of 5 runs with `saw csc:…` from another worker's compiles. That is the machine-global oracle defect PX-2a B2 already reported; it is not PX-2c. Control: at the parent `e8eb8720` it passes 2/2 on the quiet machine. |
| 13-file Windows Job batch, conc 4 (windows-process-backend, output-replay, supervisor-input, one-shot-command-family-production-matrix, execution-host, subprocess-runtime, durable-process-store, process-channel, terminal-observation, cleanup-bootstrap, owned-fence-lock, fence-effects, static-adapter-policy) | 311 tests, 310 pass, 0 fail, 1 skipped (pre-existing) |
| `task8-raw-launch-closure.test.ts` | **RED at cd475d57** (8 violations; 5 are PX-2c). See B2 and the section for the coordinator's extra item. |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| eslint on the six touched files | clean (only the sparse checkout's missing `pages` note) |
| `git diff --check e8eb8720 cd475d57` | clean |

## Findings

Blocking first. Line numbers are in `cd475d57`.

| # | Sev | Finding | Location | Evidence | Expected | Actual | Fix |
|---|---|---|---|---|---|---|---|
| B1 | **Blocking** | Crash recovery and the run-end sweep SIGKILL a PID that they read from a disk record, with no identity check. A stale record (PID reused after a reboot or a long gap) or a record planted by a same-user command kills an unrelated process. | `windows-job-process-host.ts:307-321` (constructor reap, kill at `:314`); `:688-712` (`sweepRetiredSpareRecords`, kill at `:703`). Parent `e8eb8720` has 0 `process.kill` calls in this file. | Probe p4: I made a genuine spare record, let the spare retire by idle timeout (record stays on disk, as after a runner exit), started an unrelated probe process, and rewrote the record's `supervisorPid` to that process. Starting a host on the state directory printed `bystander alive after host start: false | record dropped: true`. Unclaimed-spare records outlive their process: the supervisor retires itself on idle timeout or parent death (probes p1, p2) and nobody deletes the record until the next host start or a run end. | Kill only what is proven to be this spare. Every other kill in this file uses an owned `ChildProcess` handle or an authenticated HTTP `/signal` with token and fence. | Blind `process.kill(pid, "SIGKILL")` on a number from disk. Same-user only, so not a privilege escalation, but the runner must not kill by an unauthenticated number, and PID reuse is an ordinary event on Windows. | Do not kill by bare PID. Options: (a) read the status file, do an authenticated `GET /status` with the record token, and kill only if processId, supervisorPid, port and spare flags match; if it does not answer, just drop the record (the supervisor already retires itself); (b) compare the process creation time with the record's start time (the fenced `inspectProcessBirth` in `owned-fence-lock.mjs` already does this). Put the kill in one audited helper (see B2). Add a real-host negative test: a planted record naming a bystander leaves the bystander alive. |
| B2 | **Blocking** | The Task 8 static policy suite `task8-raw-launch-closure` is red at this commit and the evidence never ran it. 5 of its 8 violations are PX-2c code. | `runner-v2/test/task8-raw-launch-closure.test.ts:223` (test), allowlist `:18-54`. PX-2c lines: `managed-process-supervisor.mjs:384`; `windows-job-process-host.ts:314, 439, 460, 703`. | Ran the test at `cd475d57`: FAIL, 8 violations (listed in the next section). At `e8eb8720` (PX-2b): FAIL with exactly 3 (all PX-2a: `:20`, `:198` x2). PX-2b adds none. PX-2t `cb567e62` was green (PX-2a review). `PX-2c.md` section 5 lists no static-policy suite. | Every raw process boundary is exactly allowlisted or absent (architecture rule quoted in PX-2a B1). | Five new raw boundaries, none allowlisted. Two of them (`:314`, `:703`) are destructive PID kills, a class the allowlist has never allowed (its only `process-kill` uses are signal-0 existence probes). | Controller decision, then a small edit. See the disposition table below: three of the five belong in an existing exact host (add the container, or better, remove the duplicate site); the two PID kills must not be allowlisted as they are (B1). Add `task8-raw-launch-closure` and `static-adapter-policy` to the PX-2c validation list. |
| M1 | Medium | The spare is doubly off, and it dies for good after the first idle expiry. No code in the product starts the first spare, and `autoRefresh` only starts a replacement after a successful claim. After an idle expiry (default 60 s) every call falls back and nothing re-provisions. | `execution-host.ts:208` and `native-build-factory.ts:797` build the host with no `spare` option. `refreshSpareInBackground` only runs after a claim (`windows-job-process-host.ts:335`, `:672`). | Probe p2: host with `spare: {idleTimeoutMs: 1000, autoRefresh: true}`, prestart, wait: spare retired (`idle-timeout`) after about 1.4 s. Two calls after that: `stats {"prestarts":1,"claims":0,"fallbacks":1}` both times; prestarts never rises. The measure script hides this: it awaits `prestartSpare` before every timed call. | A production switch would keep one spare ready. | Gain is available only to code that calls `prestartSpare` in a loop. | Before any enablement: bootstrap at `bindRun` (or on first call), and re-provision after a miss or expiry, with a small back-off. Test it. |
| M2 | Medium | After the supervisor has acknowledged a claim, any later failure falls back to a second launch instead of failing the call. The comment "the call never launched" is not guaranteed. | `windows-job-process-host.ts:596-625` (ack at `:596`, record persist at `:607`, inner `catch` at `:614-621`, outer `catch` at `:624-625`). | The normal path throws `process_start_failed`; the spare path aborts the first Job and starts the command again. Probe p7b: injected a transient EPERM on the record rename right after the ack (common under AV on Windows). Result: `call succeeded on a FRESH (fallback) pair`, `claims 0, fallbacks 1`. The first child never ran (the abort won the race in 3 of 3 runs, 1 execution each), so I did not reproduce a double run. The margin is timing only: config already written to the Job host, abort has to beat node start (about 100+ ms). | At-most-once for a call once the claim is acked. | Silent re-run is possible under load or a slow abort. | After an acked claim, surface the failure like the normal path, or fall back only after the supervisor's status proves no child ever started (`childPid` 0, no `started` event). |
| M3 | Medium | `retireSpare()` at any binding close is host-wide, and its sweep also takes a spare that another run is claiming. | `execution-host.ts:618-622` (called from each binding's cleanup; the Job host is shared by all runs); `windows-job-process-host.ts:430-446, :688-712`. | Static: the claim path takes the slot synchronously, so `retireSpare` does not see it, but the disk record still says `spareClaimed:false` until the host persists after the ack. The sweep then kills that supervisor (B1's kill). Also run A closing retires run B's idle spare. | A run end retires only its own spare. | Cross-run interference (perf loss for B; in a narrow window a launched call of B loses its supervisor). | Scope retire and sweep to `owner.runId === closing runId`. Mark the record `claiming` before the IPC claim so a sweep skips it. |
| M4 | Medium | Test gaps. There is no test for the idle timeout, no test that a pre-claim POST is refused, none for two concurrent claims, none for `autoRefresh`. S6 is not a crash: a second host in the same process reaps a live first host's spare. | `windows-job-spare-host.test.ts` (grep for `idle`, `409`, `spare_unclaimed`, `autoRefresh`, `Promise.all`: only a comment matches). | Probes p2 (idle timeout works), p5 (see below: POST refused) prove the behaviours today, but nothing guards them. The pre-claim POST refusal is the code that carries PX-1 condition 5; it is also backed by the fence check (an unclaimed spare's record has no `currentFence`, so `/write`, `/close-input`, `/ack-output`, `/signal` would fail closed anyway), so this is defence in depth, but it is unpinned. | Condition 7: every guarantee has a real-host test. | Four lifecycle/authority rules are unpinned. | Add: idle-timeout retire; token-holding POST to all routes before the claim gets 409 and the spare is still claimable; two concurrent calls, exactly one claim; `autoRefresh` re-provisions; reap never kills a bystander (B1). |
| M5 | Medium | PX-2t follow-up N4 is real: with the spare on, 8 of 12 PX-2t guarantee tests fail on the leftover gate. The guarantees themselves hold. | `windows-job-real-host-guarantees.test.ts:187-198` (`assertNoLiveSupervisors`, excludes only supervisors alive before the file). | I made a scratch copy of the guarantee file that builds its host with `spare: {autoRefresh: true}` and prestarts the spare for the run's session. Result 1: 4 pass, 8 fail, all 8 with `Job supervisors of this run did not settle within 20000ms` (a refresh spare idles between tests and reads as a leak). Result 2: same copy with the gate ignoring records that are `spare:true, spareClaimed:false`: **12/12 pass**, spare stats 8 claims, 1 fallback (so the claimed path holds every PX-2t guarantee: exact grant scope, host death kills tree, descendant, timeout kill with a concurrent call, flood, attribution, deadline, audit, recovery). | The gate checks the guarantee (no leaked call), not the mechanism (no supervisor). | Mechanism-coupled gate, as N4 said. PX-2t's claim "a PX-2c spare needs no net edit" holds only for a spare started before the file. | Separate approved edit (PX-2c may not touch the file): make the gate spare-aware, and run the PX-2t file with the spare on and off before any default-on. |
| L1 | Low | Comment is wrong about what the spare pre-pays. | `managed-process-supervisor.mjs:498` ("booted, parsed, and compiled its helper") | In the ps1 the type load (`Initialize-JobHostType`) runs after `ReadLine` (`.ps1:792, 817`). The spare pre-pays node and PowerShell boot (about 175 ms), not the helper load. The gain matches that. | Accurate comment. | Overstated. | Fix the comment. Possible later lever: load the assembly before blocking on stdin (needs the digest before the claim). |
| L2 | Low | Evidence hygiene. | `PX-2c.md` | Hashes in the evidence are CRLF hashes, not blob hashes. The fault sources "kept under %TEMP%" are not in `%TEMP%` (only `px2c-dbg-*` and `px2c-smoke-*` dirs). | Reproducible prove-reds. | Cannot re-run the worker's faults from the stated location. | Copy fault sources and restore hashes into the evidence folder (as PX-2t F2 asked). |
| L3 | Low | A crash inside the claim window kills the launched call (fail-closed, good) but the reap also deletes its record directory, so nothing durable says the call ran. | `windows-job-process-host.ts:307-321` | Probe p3b: runner frozen after the ack and killed. Record on disk still `spare:true, spareClaimed:false`; whole tree (supervisor, PowerShell, child) alive for 6 s; a restarted host reaped it: all gone within 0.5 s, record deleted, nothing adopted, nothing leaked. | Fail closed, and keep an audit trail. | Fail closed; audit trail lost. | Persist `claiming` before the claim; keep or archive the record for a claimed call. |
| L4 | Low | Owner rule is exact `(runId, sessionId)`. Hit rate depends on the session mix. | `windows-job-process-host.ts:581` | Measured only with one stable session (`run-git:integration`). `autoRefresh` re-arms for the last claimer's session. | Known limit. | A run with several worker sessions gets a spare for one of them at a time. | Measure on a real handoff run before enabling. |
| L5 | Low | Resource cost of an idle spare. | n/a | Probe p9: node supervisor 69.7 MB, PowerShell 61.6 MB, conhost 8.2 MB working set (about 140 MB) for up to the idle timeout, per host. | Known. | Acceptable for one spare. | Record in the enablement decision. |

## Coordinator's extra item: `task8-raw-launch-closure` at cd475d57

Run at `cd475d57`: FAIL, 8 violations. Run at `e8eb8720` (PX-2b): FAIL, 3 violations, all from PX-2a. PX-2b is clean of its own. So PX-2c adds exactly 5.

| # | Violation | Origin | Belongs in | Recommendation |
|---|---|---|---|---|
| 1 | `windows-job-process-host.ts:20 <module> powershell-script-launcher managed-process-job-host.ps1` | PX-2a | PX-2a repair | Already in the PX-2a repair (its B1). |
| 2 | `windows-job-process-host.ts:231 compileJobHostHelperAssembly child-process-spawnSync spawnSync` | PX-2a | PX-2a repair | Same. |
| 3 | `windows-job-process-host.ts:231 compileJobHostHelperAssembly powershell-launcher powershell.exe` | PX-2a | PX-2a repair | Same. |
| 4 | `managed-process-supervisor.mjs:384 retireSpare member-kill backend?.kill` | PX-2c | Existing exact host (the supervisor) | Handle-bound kill of the supervisor's own Job host child, the same class as the allowed `stopOwnedTree` member-kill. Add one exact rule `retireSpare` / `member-kill` ("unclaimed spare retires only its own Job host handle"), or route `retireSpare` through `stopOwnedTree` and add nothing. |
| 5 | `windows-job-process-host.ts:439 retireSpare member-kill entry.launcher.kill` | PX-2c | Existing exact host (`abortStartingSupervisor` is already allowed for "pre-adoption owned supervisor rollback") | Redundant: `abortStartingSupervisor` already SIGKILLs the launcher when no ack arrives. Delete the extra kill and add nothing. |
| 6 | `windows-job-process-host.ts:460 startSpare child-process-spawn spawn` | PX-2c | Existing exact host (`launchOwned` is allowed for "authenticated Windows Job supervisor launch") | A second copy of the same `spawn` call. Factor one `spawnSupervisor(processId, statusPath)` helper used by both `launchOwned` and `startSpare`, so there is one raw spawn site, and allow that container under the existing reason. Do not add a second site. |
| 7 | `windows-job-process-host.ts:314 <module> process-kill process.kill` | PX-2c | **Not an existing host; do not allowlist as is** | Destructive kill by PID from disk. See B1. Replace with the identity-proved helper, in one audited container with its own exact rule and reason ("kill only after authenticated status or birth-time proof"), or remove the kill and only drop the record. |
| 8 | `windows-job-process-host.ts:703 sweepRetiredSpareRecords process-kill process.kill` | PX-2c | Same as 7 | Same helper as 7. |

## Answers to the five judge items

1. **Spare has no Job and no child until claimed; one call, never reused.** Yes. The ps1 is byte-identical to PX-2b: `RunInteractive` creates the Job, sets kill-on-close and starts the child only after `ReadLine` returns the config (`.ps1:774`, `:338`). Probe p1/p9: an idle spare's process tree is exactly `powershell.exe` plus `conhost.exe`, no child. The call's Job is created for the call (S1, S2 pin claim, per-call kill, `verified_empty`). Single use: the supervisor clears `spareUnclaimed` synchronously before acking (a second claim gets `not_spare_or_already_claimed`), the host takes the slot synchronously, and a refresh starts a new pair (S3, and 8 claims/1 fallback in my spare-on guarantee run).
2. **Spawn authority stays private.** Yes for other processes; token handling is unchanged. Claim path: the runner's `ChildProcess` IPC handle only. I listed the pipes: the IPC pipes are named `uv\<n>-<runner pid>`; a second client connecting to them just queues (busy), so a foreign process cannot inject a claim. The claim also carries the pair token, checked with `timingSafeEqual`. HTTP: probe p5 with the correct Bearer token on an unclaimed spare: `GET /status` 200, no token 401, and every POST (`/signal`, `/write`, `/close-input`, `/ack-output`, `/claim`, `/spawn`) returns 409 `spare_unclaimed`; the spare stayed unclaimed. Even without that guard the four real POST routes would fail: an unclaimed spare's record has no `currentFence`, so `assertCurrentRequestFence` throws. Who can read the token: same as any launch (it is in the durable record, plain JSON, same-user readable). A same-user command could observe the spare and kill it (a nuisance, and a fallback covers it) but cannot claim or steer it before the claim. One authority weakness is B1 (planted record steers a kill), not steering of the spare.
3. **Lifecycle.** Idle timeout: works (p2, retired in about 1.4 s for a 1 s timeout; but no test, M4). Parent death: works (p1: runner killed with TerminateProcess while idle; supervisor, PowerShell and conhost all gone in 113 ms; status `spareRetired: parent-dead`; record stays until a host starts, then removed). Run end: works (S4; `execution-host.ts:618-622`); scope problem in M3. Runner crash while idle: clean (p1). Runner crash mid-claim (p3, p3b): the claimed call's supervisor stays alive (claimed spares survive for adoption by design), a restarted host reaps it; the whole tree dies within 0.5 s of the supervisor's death (libuv puts non-detached children in a kill-on-close job), record deleted, nothing relaunched, zero leftover. Durable records: the spare has one from the start (`spare:true, spareClaimed:false`) and the tests read it. Problems: B1 (unauthenticated PID kill), L3 (audit trail deleted), M3 (host-wide retire). Zero leftover processes after all my probes and runs.
4. **Opt-in.** Yes: off by default, and no path enables it in the product. `spare` is a code-only option of `createWindowsJobProcessHost`; `execution-host.ts` and `native-build-factory.ts` do not pass it; there is no env var, CLI flag, config file or HTTP route. `PX2C_SPARE=1` only switches the measure script. Whoever writes the host construction can set it; a tool call or a contained command cannot. Safe. See the recommendation below.
5. **Tests.** 9/9 pass and mostly prove what they claim: S1/S2/S3 discriminate the claim, per-call kill, single use; S5 is a real parent death (fixture calls `process.exit`); S7a/b/c cover dead, tampered and other-run spares. Weak points: S6 is a same-process second host, not a crash; S4's Job-host death check is skipped if the CIM lookup returns nothing; S5 does not look at the PowerShell child; nothing pins idle timeout, pre-claim POST, concurrency or `autoRefresh` (M4); nothing pins B1's negative case. Guarantee, speed and PX-2b files unchanged; guarantee 12/12 and fence-effects 14/14 green; speed 4/4 on a quiet machine (5/5 red on a busy one, PX-2a B2). Prove-reds: see "What I could not do". N4: answered in M5.

## Measured gain, reproduced

`binding.git.lifecycle("integration").run(rev-parse HEAD)`, n=20, two rounds, interleaved, on a machine with other work running. Times in ms.

| Mode | Round 1 median / p90 | Round 2 median / p90 | Claims |
|---|---|---|---|
| off (today) | 740 / 779 | 794 / 892 | n/a |
| spare, prestart awaited before every call (how `measure-git-launch.mts` measures) | 579 / 644 | 593 / 640 | 20 of 20 |
| spare, one prestart, then back-to-back calls (autoRefresh only) | 590 / 654 | 595 / 638 | 20 of 20 |

Gain about 150-200 ms per call (20-25 percent), the same as the worker's 171-186 ms. Back-to-back calls keep getting a ready spare because the replacement starts at claim time and is up before the next call. So the gain needs the spare on, and once a spare exists it is real. It does not reach the 200 ms per call target (PX-1 review F4 predicted that).

## Default-on recommendation

**Do not make it default-on yet. Keep it opt-in until these are true:**

1. B1 and B2 fixed (no unauthenticated kill; the static policy suite green with exact rules).
2. A production bootstrap and re-provision policy exists (M1): first spare at `bindRun` or first call; a new spare after every claim and after every miss or expiry, with back-off; nothing that keeps a spare alive for an idle host beyond the idle timeout.
3. Retire and sweep are scoped to the closing run, and the record is marked before the claim (M3, L3).
4. After an acked claim, failures surface like the normal path (M2).
5. New tests: idle timeout, pre-claim POST refusal on every route, concurrent claims, autoRefresh, reap never kills a bystander, mixed sessions (M4, L4).
6. The PX-2t leak gate is spare-aware (M5), and the PX-2t file plus the Windows Job suites are run with the spare on as well as off (I did this once by hand: 12/12 with a spare-aware gate).
7. A measurement on a real handoff or build run, not the microbenchmark: hit rate across several sessions, and memory (about 140 MB per idle pair, L5).
8. The switch stays a code option owned by whoever builds the host (no env var, no HTTP, no on-disk switch). That is already true.

## Follow-up list

1. Repair for B1 and B2 (one repair cycle; the controller decides the allowlist edit, since the task8 test is outside the packet's writable set).
2. M1-M4 in the same repair or a PX-2c2 packet before any enablement.
3. M5: spare-aware `assertNoLiveSupervisors` (separate approved edit), then a spare-on run of the PX-2t file.
4. L1: fix the comment; consider loading the assembly before the ReadLine as a later perf lever.
5. L2: copy the fault sources and the restore hashes into the evidence folder; fix the hashes.
6. Re-check PX-2c at the repaired commit for the static policy suite (B2) and the spare-on PX-2t run.
7. Carry forward from PX-2a: N1 (digest pin beside the file) matters slightly more with a spare, because the digest is captured at reservation time and lives up to the idle timeout before the call.

## What I could not do

- I could not re-run the worker's nine prove-red faults. To do so I would have had to edit production guard code in my scratch copy (for example, remove the pre-claim POST guard). The permission classifier denied that edit as "Security Weaken". I did not retry it or route around it. I judged the prove-reds by reading each test's assertions against its named fault instead (S1, S2, S3, S5, S7a, S7b, S7c discriminate; S4 and S6 as noted above), and I checked the behaviours with my own probes on unmodified code.
- The wall-clock numbers are from a shared machine and are not absolute.

## My probes (all on unmodified code, in `%TEMP%\px2cr1-*`, now deleted)

| Probe | Result |
|---|---|
| p1 idle spare, runner TerminateProcess | all spare processes gone in 113 ms; `parent-dead` recorded; record swept on next host start |
| p2 idle timeout and autoRefresh after expiry | retire works; no re-provision (M1) |
| p3, p3b runner killed inside the claim window | tree survives until reap, reap kills it in under 0.5 s, record deleted, no leak (L3) |
| p4 planted record names a bystander pid | bystander killed (B1) |
| p5 token-holding POSTs on an unclaimed spare | 409 `spare_unclaimed` on every route |
| p6 IPC pipes of the runner | second client queues (busy), no injection |
| p7, p7b post-ack failure fallback | falls back to a fresh launch; 1 execution in 3 of 3 runs (M2) |
| p8 A/B/C timing | table above |
| p9 leftover check and idle memory | no leftover; about 140 MB per idle pair |
| spare-on copy of the PX-2t file (scratch worktree only) | 8/12 red on the leak gate; 12/12 with a spare-aware gate (M5) |

## Cleanup

Junction removed first with `cmd /c rmdir`. `Test-Path` confirmed the junction was gone and `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6\node_modules\eslint` (and `tsx`) still existed (474 top-level entries). Only then `git worktree remove --force` on the scratch worktree. The scratch folder (probes, logs) held no reparse point and was removed. `%TEMP%\px2cr1-*` removed. No process of mine is left (checked by command-line marker). The PX-2a repair worker's files in this worktree were not touched; the only file I added here is this one.

**Verdict: REPAIR — 2 blocking**
