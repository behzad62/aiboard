# Owned Fence Lock: What It Must Guarantee, the Options, and a Recommendation — Design Note
Date: 2026-11-14
Status: Proposal for the owner's review. No product code changes until the owner approves (§9).
Audience: the owner, an independent reviewer, and whoever implements the packets.
Primary repository: D:\repos\ai-discussion-board, read at 6eeda977 (main, 2026-11-14), plus PR behzad62/aiboard#212 at 32dd8cfd (branch `claude/adaptive-timing-bounds`, open). Bare file names are under `runner-v2/src/`; `test/...` is `runner-v2/test/...`. Line numbers are at 6eeda977.
Measurements: the benchmark scripts and raw results are in the session notes folder `local_85dff7e4-37f3-4ed5-86b0-3ee0f0013d2f/fence-lock-bench/` (outside the repository, not committed).

## 0. TL;DR

- **The question.** Was a SQLite file the right cross-process lock for Runner V2's owned fence, and what is the best design on Windows, Linux and macOS?
- **The short answer.**
  - **SQLite is the right tool, but it is used the wrong way.** Node has no API for `LockFileEx`, `flock` or `fcntl`, so SQLite's own file locks are the only way to get an OS file lock from inside Node. The repository already uses SQLite exactly that way for the Runner's lifetime lock and the AIBoard home lock.
  - The owned fence uses SQLite as a **durable lock database** instead: holder rows, two flushed commits per claim, and a process-identity probe whenever it meets another holder. Every measured cost and both defects found below come from that layer, not from SQLite's locking.
- **What the lock has to do** (§3): it serializes the fence check and the effect against fence changes for one owned process or one state file, across the Runner, the portable supervisor and the POSIX child. A dead holder must never block forever, and a live one must never be displaced. Fencing tokens are compared by the callers, not by the lock.
- **Measured** (§4; Windows on this 16-CPU host, Linux in a 2-CPU container, macOS from CI logs only):

  | | Current protocol | SQLite as an OS lock only (Option 2) |
  |---|---|---|
  | One uncontended claim, idle | Windows 19 ms, Linux 26 ms, macOS CI about 22–48 ms (p50) | Windows 1.0 ms, Linux 0.19 ms (p50) |
  | The same, under load | Windows p95 330 ms (2× CPU), p50 57 ms (disk flushes); Linux p50 62–96 ms | Windows p95 40 ms, p50 1.1 ms; Linux p50 0.3–0.5 ms |
  | Next claim after the holder is killed | Windows 330 ms idle; **7.2–7.7 s** at 2× CPU (#212), **never** on main | Windows 12 ms idle, ≤ 203 ms at 2× CPU; Linux ≤ 66 ms |
  | Four processes contending | Windows 41 claims/s, p99 0.7 s; 9/s, p99 7.0 s at 2× CPU | 346 claims/s, p99 0.22 s; 114/s, p99 0.77 s at 2× CPU |

- **Two defects in today's design**, both fail-closed (no double holder) but both wedge:
  1. **A zombie holder looks alive on Linux** (§4.3). A killed holder stays a zombie until its parent's event loop reaps it. A sync claim in that parent therefore probes the zombie for its whole deadline and fails: 0 of 10 recovered, 2,704 probes in 15 s each. The Runner is the parent of every portable supervisor, and its POSIX claims are sync.
  2. **On main, a dead holder cannot be reclaimed at 2× CPU load on Windows.** The `powershell.exe` holder probe is cut off at 2 s, and an unknown result fails the claim at once. #212 fixes this by giving the probe the claim's time left, but recovery then takes 7.2–7.7 s.
- **Recommendation: Option 2.** The lock becomes SQLite's own file lock only: `BEGIN IMMEDIATE` to take it, `ROLLBACK` to release it, nothing written, no holder row, no probe. The kernel releases the lock when the holder dies.
  - Retirement moves into the authority records. The Windows Job host already keeps its tombstone there.
  - The main new risk is POSIX: any non-SQLite `close()` of the lock file in the holder's process drops the lock (measured). A static guard covers it (§6, §8).
  - Existing lock files keep working: old and new code exclude each other on the same file (measured, 0 lost updates).
- **Estimate:** 6–8 days in five packets (§7). FL2 is the fencing change and gets an independent review.

## 1. What the owner asked

- Was a SQLite file as the cross-process lock the right decision? Research it properly before anything changes.
- Evaluate at least four options on Windows, Linux and macOS:
  1. A single owner per process.
  2. SQLite as an OS lock only.
  3. The current design with #212's measured limits.
  4. OS primitives reachable without shipping an unsigned binary.
- For each option, cover the cost per claim, the worst case under load, what the OS releases on process death, PID reuse, network and synced folders, the event loop, migration, the size of the change, and the tests.
- Measure, don't guess. End with a recommendation, packets, risks and owner decisions.
- Rules: no unsigned binaries, process ownership stays fail-closed, any fencing change gets an independent review, PR CI stays at about 3 minutes per job, and targeted tests only.

## 2. What the lock is today

### 2.1 Who takes it

| Lock file | Taken by | API | How often |
|---|---|---|---|
| `<run root>/process-backend/<process dir>/.fence.lock`, portable backend (POSIX, and the Windows portable backend with `jobObjects: "unavailable"`; execution-host.ts:881-883, :904-907) | **Runner**: `claimOwnedFence` (native-process-backend.ts:1275, sync, from `assertFence` :678), `commitOwnedFenceEffect` (:1303, sync), `commitOwnedFenceEffectAsync` (:1318), the output snapshot (:399, :1365, sync) | `withOwnedFenceLockSync` / `withOwnedFenceLock` | Every signal, verify-empty, release, attach and output settlement |
| same file | **Portable supervisor**: `withCurrentFenceEffect` (portable-process-supervisor.mjs:793) through `runPortableFenceEffectSync` (portable-process-protocol.mjs:20); 9 call sites (output ACK batches, input, control, anchor release) | sync, in the supervisor's own process | **The hot path**: every batch of output ACKs, every stdin write |
| same file | **POSIX child (anchor)**: `consumeExactPosixAnchorRelease` (portable-process-child.mjs:138) | sync | Once, at release |
| `<host state>/<processId>.fence.lock`, Windows Job host | **Runner only**: `claimOwnedFence` (windows-job-process-host.ts:1238) and `withFenceEffect` (:1386). The Job supervisor never takes it; it compares the fence itself at its HTTP boundary (managed-process-supervisor.mjs:426) while the host holds the lock across the request | async | Every write, close, signal, output ACK and release |
| `<enforcement state>.lock` | Runner: `withProjectionLock` (execution-isolation-provider.ts:732) | async | Each enforcement record |
| `<OCI state>.lock` | Runner: `withStateLock` (oci-execution-isolation-provider.ts:1080) | async | Each OCI lease change |

Only one Runner uses a state directory at a time **when the launcher starts it**: the Runner itself holds the launcher's lifetime lock (runner-start.ts:200). Runners started without the launcher, and tests, do not take that lock.

### 2.2 One claim, step by step

`withOwnedFenceLockSync` (owned-fence-lock.mjs:125) and `withOwnedFenceLock` (:154) run `acquire` (:509):
1. **Self-birth.** It learns this process's own birth time (`currentProcessBirthFingerprint`, :275). On Windows the first time in each process this is a cold `powershell.exe`: 258–413 ms idle, 4.9–9.1 s at 2× load, 9.6–21.3 s at 4× load (#212's table). Hence the background preparation (:327, called at windows-job-process-host.ts:399).
2. **Open** (`openProtocol`, :605). It checks the path and three sidecar names (`-journal`, `-wal`, `-shm`) by `lstat`, opens read-only and validates the whole canonical schema (tables, indexes, foreign keys, triggers, the legacy migration), then opens read-write and validates again inside `BEGIN IMMEDIATE`. It sets `journal_mode=DELETE` and `synchronous=FULL` (:681).
3. **Claim.** The fast path (`tryProposeAndClaimFree`, :878) inserts the acquisition and holder rows in one commit. When another holder row exists, `tryClaim` (:784) probes the holder's PID and birth (`inspectHolder`, :815). Windows uses `powershell.exe Get-Process` through `execFileSync` (:1495), Linux reads `/proc/<pid>/stat` (:1502), and other POSIX systems use `kill(pid, 0)` plus `ps -o lstart=` twice (:1529-1578). A dead or different holder is replaced in one transaction (:855-866).
4. **Effect.** `beginEffect` (:908) opens `BEGIN IMMEDIATE` and checks the holder row is still its own. **The effect runs inside that write transaction**, so during the effect the exclusion is in fact SQLite's RESERVED file lock.
5. **Release.** `finalizeEffect` (:926) deletes the rows and commits. That is the second flushed commit. With `retireAfterEffect` it also sets `retired = 1` in the same commit, and the file is removed afterwards (`retireProtocol`, :1461).

Each claim and effect therefore makes two durable commits. In DELETE-journal mode with FULL sync, each commit creates a journal file, writes it, flushes it, writes the database, flushes it and deletes the journal. On Linux SQLite also flushes the directory the first time it syncs a new journal. The waits in between are `Atomics.wait` (11 places), which block the thread.

### 2.3 Why SQLite (the history)

There is no design document, but the history is clear:
- The first lock (9f2d52d1, 2026-08-31) was an anonymous `O_EXCL` lock file (`isOwnedFenceLockContention` checked `EEXIST`).
- The Task 8.0B2 re-review then found that "anonymous fence lock files cannot safely recover after their holder crashes".
- Fix round 3 (e5f0c59c, the same day) replaced it with "one SQLite exact PID/birth/acquisition protocol" (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/progress.md` in that commit).

The brief for that round (`task-8.0b2-fix-round-3-brief.md`, R3.2, commit e6088571) asked for three things:
- a lock bound to "an unguessable acquisition ID, holder PID, and exact holder birth fingerprint";
- that "an exact live holder must never be stolen";
- that "crash release and mutual exclusion must be portable across Windows, Linux, and macOS".

The durable holder row met those requirements on top of a lock file that the kernel never releases. `node:sqlite` needed no dependency.

Meanwhile the launcher's lifetime and discovery locks, and later the AIBoard home lock, were built the other way. They hold `BEGIN IMMEDIATE` and release with `ROLLBACK`, and write nothing (launcher-instance.ts:276-293, aiboard-home-store.ts:1187-1230). That code already knows the POSIX close hazard (launcher-instance.ts:328-329, aiboard-home-store.ts:1187-1193). **Option 2 is that existing, shipped pattern, applied to the fence.**

## 3. What the lock has to guarantee

| Id | Guarantee | Where it holds today |
|---|---|---|
| G1 | **Mutual exclusion per lock file**, across processes (Runner, portable supervisor, POSIX child; §2.1) and inside one process (async turns, a sync claim inside an async effect) | SQLite RESERVED lock during the effect (:908); holder row between the claim and the effect; in-process `asynchronousTails` (:62, :156) |
| G2 | **Check and effect are atomic against fence changes.** A claim raises the fencing token under the lock. Every effect re-reads the fence under the lock and refuses a stale one. The lock never compares tokens itself. | Callers: `claimOwnedFence` CAS (native-process-backend.ts:1275-1301), `commitOwnedFenceEffect` (:1303-1316), `runPortableFenceEffectSync` (portable-process-protocol.mjs:24-38), Windows Job `withFenceEffect` → `assertCurrentFence` (windows-job-process-host.ts:1396-1402) |
| G3 | **A dead holder never blocks forever; a live holder is never displaced**, even at the deadline; uncertainty fails closed | PID+birth probe and one-transaction replacement (:784-871); `OwnedFenceIdentityInspectionError` (:817, :823) |
| G4 | **An unprovable release keeps the lock held by this process until it exits** ("ambiguous finalization") | `finalizeEffect` keeps the row and records it in `retainedHolders` (:948) |
| G5 | **An acquisition whose effect never started releases itself**, so the process does not wedge itself (the T8 factory wedge) | `releaseUnstartedAcquisition` (:958) |
| G6 | **Retirement.** The last effect of an authority makes every later claim fail, atomically with that effect, and nothing can bring the authority back after it is removed | `retired = 1` in the release commit (:934-937), `assertActiveProtocol` on every step, `recoverRevokedOwnedFenceLock` (:202), `retryRetiredOwnedFenceCleanup` (:459) |
| G7 | **Path integrity.** The lock is a regular, single-link file whose identity does not change during a claim; foreign or corrupt content fails closed | `lstat` snapshots (:1079-1144), canonical schema checks (:1231-1375), sidecar checks (:1389) |
| G8 | **Bounded waits.** A claim gives up at its deadline and fails closed | 2 s on main; 15 s measured ceiling in #212 |

What the pieces of the durable protocol are for:
- **The holder row** (`owned_fence_holder`: PID, birth, acquisition id) is the lock *between* the claim commit and the effect transaction. It is also the only evidence a later claimant has that the holder may be dead. It exists because the original lock file could not be recovered after a crash.
- **The acquisition table** with its immutability trigger stops a row from being rewritten to look like another acquisition.
- **Ambiguous finalization (G4).** The effect ran but the commit that deletes the row failed. The row stays, every other claimant sees a live holder, and nobody, this process included, replaces it until the process exits.
- **Retained unstarted holders (G5).** The claim committed but the effect never started and its release failed. This process may later replace that exact row, by its random acquisition id.

On crash and restart:
- When a holder dies, the OS drops SQLite's RESERVED lock but the holder row stays. The next claimant probes the PID and birth and replaces the row when the holder is absent or different.
- After a reboot the row survives, and the probe looks at a PID from the previous boot. The Linux fingerprint (`proc-start:<ticks since boot>`, :1505) carries no boot id.
- The effects' own durable intents settle half-done work (for example `output-retirement.json`, portable-process-protocol.mjs:79-112). The lock never replays an effect. **No guarantee in G1–G8 needs the holder row after the holder is dead:** recovery today is "prove it dead, then take the lock".

## 4. Measurements

### 4.1 Method

- Throwaway scripts in the session scratchpad, copied to the notes folder:
  - `bench.mjs` (claim, contend and crash modes);
  - `load.mjs` (CPU busy threads; a disk-flush load that writes 1 MiB, calls `fsync` and unlinks in a loop);
  - `suite.sh`, `mixed.mjs`, `rpc.mjs`, `close-drops-lock.mjs`, `exlock-probe.mjs`, `sidecar-probe.mjs`.
- **Windows:** this host (Windows 10 19045, 16 CPUs, Defender on), Node 24.18.0, SQLite 3.53.1, files under `%LOCALAPPDATA%\Temp`. Conditions: idle, 2× CPU (32 busy threads), and disk-flush load (4 threads).
- **Linux:** a throwaway `node:24-bookworm-slim` container with `--cpus=2`, Node 24.22.0, SQLite 3.53.4, overlay filesystem. Conditions: idle, 2× CPU (4 threads), 4× CPU (8 threads), and disk-flush load (2 threads). The container is removed.
- **macOS:** no Mac is available. The figures are from the `Portable contract (macos-latest)` CI job (§4.5).
- Modes:
  - **current**: the real `owned-fence-lock.mjs` from main, with a fixed holder birth so self-birth is excluded; `current #212` is #212's copy.
  - **durable**: only the two flushed commits, without validation.
  - **os-open**: Option 2, opening the file per claim (`lstat`, open, `BEGIN IMMEDIATE`, `lstat`, `ROLLBACK`, close).
  - **os-held**: Option 2 with one long-lived connection.
  - **exlock**: a Windows exclusive-share open.
  - **oexcl**: an `O_EXCL` lock file.
  - **mkdir**: a lock directory.
- The waits in every non-current mode are 5 ms, growing by half up to 50 ms (#212's schedule). The current mode uses the module's own loop with a 15 s deadline.

### 4.2 Claim cost (uncontended; ms; p50 / p95 / p99 / max)

| Host, condition | current | durable commits only | **os-open (Option 2)** | os-held | exlock (Windows) | oexcl | mkdir |
|---|---|---|---|---|---|---|---|
| Windows idle, n=300 | 19.3 / 26.7 / 32.3 / 75.5 (#212: 24.3 / 29.2 / 54.7 / 90.4) | 11.4 / 14.0 / 18.6 / 155 | **1.0 / 1.4 / 1.8 / 2.1** | 0.59 / 0.78 / 0.94 / 2.0 | 0.10 / 0.15 / 0.19 / 0.26 | 0.53 / 0.76 / 1.5 / 2.2 | 0.38 / 0.58 / 0.78 / 0.98 |
| Windows 2× CPU, n=200 | 16.9 / 330 / 507 / 518 | 10.6 / 245 / 364 / 394 | **0.72 / 39.5 / 66.0 / 69.4** | 0.51 / 0.92 / 89.5 / 135 | 0.08 / 0.14 / 0.31 / 40.8 | 0.34 / 0.71 / 62.3 / 165 | 0.24 / 0.42 / 91.5 / 134 |
| Windows disk flushes, n=200 | 57.0 / 90.4 / 117 / 119 | 76.0 / 91.3 / 100 / 105 | **1.1 / 3.3 / 5.7 / 8.4** | 0.62 / 3.0 / 5.9 / 5.9 | 0.09 / 0.18 / 0.32 / 0.35 | 0.49 / 2.4 / 5.6 / 6.8 | — |
| Linux idle, n=300 | 26.1 / 33.4 / 43.8 / 133 | 23.8 / 32.3 / 47.3 / 52.7 | **0.19 / 0.36 / 0.60 / 0.86** | 0.12 / 0.17 / 0.20 / 0.35 | n/a | 0.10 / 0.20 / 0.43 / 0.66 | 0.36 / 0.47 / 0.55 / 0.78 |
| Linux 2× CPU, n=200 | 61.7 / 102 / 159 / 514 | 56.2 / 144 / 381 / 407 | **0.33 / 2.5 / 13.2 / 21.3** | 0.15 / 1.9 / 13.1 / 27.4 | n/a | 0.11 / 0.41 / 16.3 / 17.6 | 0.35 / 0.64 / 25.1 / 41.2 |
| Linux 4× CPU, n=200 | 96.4 / 184 / 208 / 284 | 88.6 / 185 / 212 / 277 | **0.53 / 8.5 / 47.2 / 47.8** | 0.26 / 3.5 / 21.7 / 41.9 | n/a | 0.14 / 2.2 / 17.1 / 22.0 | 0.50 / 5.9 / 27.0 / 33.0 |
| Linux disk flushes, n=200 | 82.8 / 124 / 287 / 500 | 78.5 / 125 / 260 / 542 | **0.23 / 0.61 / 1.0 / 2.7** | 0.15 / 0.30 / 0.64 / 1.2 | n/a | 0.12 / 0.30 / 1.1 / 2.5 | — |

- The two flushed commits are most of today's claim: 11 of 19 ms on Windows and 24 of 26 ms on Linux when idle. Under disk-flush load they are the whole claim, which triples on Windows and grows to about 80 ms on Linux. Option 2 is unaffected by disk load.
- Real records from #212 and CI:
  - SQLite open plus write took 1,750 ms once in 32 claims (#205).
  - The Windows CI trace (run 43585047943) reads `open 2783 ms, 0 claim attempts, 0 busy, 0 holder inspections`.
- That 2,783 ms is not explained. I tested one hypothesis: a `-journal` sidecar still visible after a release while antivirus holds it. It **did not reproduce**: 0 in 500 claims on this host. Option 2 never creates a journal, so the whole sidecar class goes away either way. The OS-lock files stayed at 0 bytes with no sidecars on both systems.

### 4.3 Crash release: the holder is killed inside its effect; time from the kill to the next successful claim (ms; p50 / max)

| Host, condition | current | os-open (Option 2) | os-held | exlock | oexcl |
|---|---|---|---|---|---|
| Windows idle, 10 trials | main 330 / 407 (the `powershell.exe` holder probe) | **11.9 / 20.6** | 9.1 / 18.2 | 14.2 / 17.4 | never (0 of 1 within 15 s) |
| Windows 2× CPU | **main: never.** The claim fails "Owned fence holder inspection is unavailable or uncertain." because the probe is cut at 2 s. **#212: 7,248 / 7,688** (6 trials) | **70 / 203** | 69 / 195 | 68 / 169 | never |
| Windows disk flushes | — | 5.8 / 17.7 | — | — | — |
| Linux idle | **A sync claim by the holder's parent before it reaps the child: never** (0 of 10; each fails after 15 s and 2,704 probes of the zombie, on main and #212). After the child is reaped: 43.8 / 74.6. #212's async claim, which lets the event loop reap: 54 / 75 | **1.7 / 4.0** | 1.7 / 3.7 | n/a | never |
| Linux 2× CPU (current: reaped first) | 113 / 142 | 9.1 / 49 | 6.9 / 14 | n/a | never |
| Linux 4× CPU (current: reaped first) | 214 / 395 | 16 / 66 | 20 / 59 | n/a | never |

**The zombie defect.**
- A killed POSIX process stays a zombie until its parent reaps it. Node reaps children on its event loop.
- A sync claim (`Atomics.wait` plus `readFileSync('/proc/<pid>/stat')`) therefore keeps finding the same PID with the same start time, and decides the holder is alive.
- In production the Runner is the parent of every portable supervisor (native-process-backend.ts:246-251), and its POSIX claims are sync (§2.1). If a supervisor dies while holding the lock, the Runner's next sync claim blocks its event loop for the whole deadline and then fails: 2 s on main, 15 s with #212. A later claim succeeds once the loop has reaped the zombie.
- macOS has the same issue: `kill(pid, 0)` succeeds on a zombie, and `ps` lists it.
- The kernel locks of Option 2 are released at exit, before the zombie stage, which is why os-open recovered in 1.7 ms with the zombie still unreaped.

### 4.4 Contention: 4 processes × 50 claims on one lock, each effect a 1 ms read-modify-write of a counter

| Host, condition | current | os-open (Option 2) | os-held | exlock |
|---|---|---|---|---|
| Windows idle | 41 claims/s; p95 / p99 / max 441 / 703 / 757 ms (#212: 36/s; 633 / 1,480 / 2,198) | **346/s; 9.8 / 222 / 338** | 387/s; 2.5 / 278 / 405 | 467/s; 1.9 / 216 / 342 |
| Windows 2× CPU | 9/s; 2,688 / 6,975 / 8,162 | **114/s; 68 / 772 / 1,131** | 152/s; 47 / 570 / 823 | 139/s; 57 / 557 / 930 |
| Linux idle | 32/s; 767 / 1,213 / 1,913 | **496/s; 2.7 / 218 / 318** | 518/s; 2.5 / 216 / 316 | n/a |
| Linux 2× CPU | 14/s; 1,092 / 1,881 / 2,739 | **134/s; 50 / 257 / 654** | 187/s; 33 / 602 / 875 | n/a |
| Linux 4× CPU | 11/s; 1,392 / 1,942 / 4,619 | **122/s; 54 / 588 / 1,076** | 83/s; 70 / 1,671 / 2,067 | n/a |

- Every run lost **0 updates**. The negative control (no lock) lost 316 of 400 on Windows, where workers also crashed with `EBUSY`, and 380 of 400 on Linux.
- The current protocol's numbers were the same with its default holder probe and with a cheap `kill(pid, 0)` probe (Windows 41 vs 40 claims/s, Linux 32 vs 34). Its contention cost is its own I/O.
- The high p99 of the polling modes is barging: a process that just released polls again first. Real locks have 2 or 3 contenders, not 4 busy ones.

### 4.5 Other measured facts

- **POSIX `close()` drops the lock (Linux, SQLite 3.53.4).** The holder process holds `BEGIN IMMEDIATE`; another process gets "database is locked".
  - After a single `fs.readFileSync(lock)` in the holder process, the other process **acquires**. `fs.openSync` plus `closeSync` does the same.
  - A second SQLite connection in the same process gets "database is locked", and closing it keeps the lock.
  - The same script on Windows: the lock survives both fs reads, because `LockFileEx` locks belong to the handle.
  - SQLite documents this ("will cancel all POSIX advisory locks on the same file", sqlite.org/howtocorrupt.html §2.2). It added defenses in 3.51.0, which "are not a cure-all", and the measurement shows they do not cover a plain fs read.
- **Old and new code on one existing lock file.**
  - Setup: the main module created the file with its schema. Then 2 processes ran the current protocol and 2 ran os-open, 100 claims each, against the same counter.
  - Result: **0 lost updates** on Windows and on Linux. The lock bytes sit at fixed offsets whatever the file holds, so both versions use the same lock.
- **Locks across a shared folder.** The test folder was on Windows, bind-mounted into a Linux container (9p/drvfs).
  - With a Windows process holding `BEGIN IMMEDIATE` on the file, the Linux process **acquired** the same file.
  - Locks stop at the machine or VM boundary.
- **Windows exclusive open.** `fs.openSync(path, O_RDWR | O_CREAT | 0x10000000)` (libuv's `UV_FS_O_EXLOCK`, not exported in Node's `fs.constants`) opens with no sharing. A second open fails with `EBUSY`, and so does a plain read.
- **Option 1's per-request cost.** A localhost HTTP request shaped like `supervisorRequest` (no pooled agent, `Connection: close`, a JSON fence compared in memory) took 0.48 / 0.80 / 1.4 / 2.3 ms idle and 0.50 / 0.72 / 1.18 / 1.26 ms at 2× CPU (p50 / p95 / p99 / max, Windows). That is about the cost of an Option 2 claim. The portable channel is file-based and polled, so its round trip is at least one poll interval (not measured).
- **macOS, from CI** (`Portable contract (macos-latest)` vs `(ubuntu-latest)`, 8 runs on 2026-11-14).
  - The test "portable snapshot and ACK retirement share the real owned lock…" makes 3 real claims plus one claim that fails after 25 ms. It took **90–170 ms on macOS** and 38–43 ms on Ubuntu (one Ubuntu outlier at 122 ms).
  - That puts a current-protocol claim at about 22–48 ms on macOS and 4–6 ms on Ubuntu, file work included. There is no macOS data for crash release or load.
- **CI failure history.** The last 40 failed runs of `runner-v2-portable-execution.yml` (2026-10-30 to 11-14) contain four fence failures, **all on Windows**:
  - three "Current owned fence holder birth identity is unavailable" (runs 41686457079, 43317398746 and 43517983388);
  - one "open 2783 ms" (run 43585047943).
  - None were on macOS or Linux.

## 5. The options

### 5.1 Option 1: a single owner per process

**Idea.** The supervisor owns the fence while it lives. The Runner's claim and every Runner-side effect become requests to it, and the supervisor compares the fence in memory before applying. There is no cross-process lock.

**Fit by lock.**
- **The Windows Job host is already most of the way there.** Its supervisor compares the fence at its HTTP boundary (managed-process-supervisor.mjs:426), and only the Runner writes the record.
- **The portable backend is far from it.** Its channel is file-based (input, ACK and control files, portable-process-supervisor.mjs:560-750). The Runner also performs effects itself: signal, verify-empty, release, attach and the output snapshot (native-process-backend.ts:396-404, :512, :567, :607, :650, :683, :934). The POSIX child performs one too (portable-process-child.mjs:138).
- **When the supervisor is dead**, or not yet started, Runner-side cleanup still needs exclusion. Only the Runner acts then, so an in-process queue is enough, but only if one Runner uses the state directory. The launcher's lifetime lock guarantees that only for launcher-started Runners (runner-start.ts:200).
- **Switching** between "send it to the supervisor" and "do it here" needs a liveness decision about the supervisor. That is the same PID+birth probe, moved to the release path.

| Criterion | Option 1 |
|---|---|
| Cost per effect | One localhost request: 0.48 ms p50, 1.4 ms p99 (measured); the file channel is at least one poll interval |
| Worst case under load | 1.18 ms p99 at 2× CPU (request only); unmeasured for the file channel |
| Released on death | The supervisor's death ends its authority, but the Runner has to detect it (a probe) |
| PID reuse | The probe stays on the mode switch, with the same weaknesses as Option 3, used less often |
| Network or synced folders | No file lock on the hot path, but the records still live in the state directory |
| Event loop | Free: the Runner awaits a request |
| Migration | A protocol change between Runner and supervisor. A supervisor of the old version keeps running after an update, so the new Runner must speak the old protocol until it exits |
| Size | Largest: a rewrite of the B2-era portable channel protocol and of every Runner-side fenced effect; about 8–12 days plus review, in the most-reviewed process-ownership code |
| Tests | A new protocol suite: portable-process-channel, portable-process-protocol, posix-process-backend, windows-process-backend, and new supervisor-death mode-switch tests |

**Verdict: not now.** It removes a lock whose cost Option 2 already brings to about 1 ms, and it costs the most and carries the most risk.

### 5.2 Option 2: SQLite as an OS lock only

**Idea.** The lock is SQLite's RESERVED file lock: `BEGIN IMMEDIATE` to take it, `ROLLBACK` to release it. Nothing is written, so there are no rows, no schema, no journal and no flush. This is the pattern of `tryAcquireLockFile` (launcher-instance.ts:276-293).

**How SQLite locks on each OS** (primary sources):
- **Windows.** `LockFileEx` on SQLite's lock bytes (os_win.c `winLockFile`). The lock belongs to the handle. Microsoft's `LockFileEx` page: when a process exits or closes the handle, "the locks are unlocked by the operating system"; the time this takes "depends upon available system resources". Measured: 9–21 ms idle, ≤ 203 ms at 2× CPU.
  - SQLite opens with `FILE_SHARE_READ | FILE_SHARE_WRITE`, without `FILE_SHARE_DELETE` (os_win.c `winOpen`). An open connection therefore blocks deleting the file or its directory, so the lock should be opened per claim, not held open.
  - SQLite retries transient Windows I/O errors (sharing violations included) 10 times with a linearly growing delay: 25 ms, 50 ms … 250 ms, about 1.4 s in all (os_win.c `winRetryIoerr`, `SQLITE_WIN32_IOERR_RETRY` and `_DELAY`). This may explain part of the slow CI opens; it is not measured.
- **POSIX.** Classic `fcntl(F_SETLK)` record locks (os_unix.c; no `F_OFD_SETLK`). They are per process and released at exit, before the zombie stage. Measured: 1.7–4 ms idle on Linux, ≤ 66 ms at 4× CPU, with the holder unreaped.
  - SQLite keeps its own connections safe: it tracks locks per inode (`unixInodeInfo`) and defers a connection's `close()` while the process holds locks on the file (`setPendingFd`). Any **non-SQLite** close in the holder's process drops every lock it holds on that file (measured, §4.5).
- **macOS.** `SQLITE_ENABLE_LOCKING_STYLE` defaults to 1 on Apple builds, and Node's `deps/sqlite/sqlite.gyp` sets no locking define. The style is chosen per filesystem (os_unix.c `autolockIoFinderImpl`):
  - `hfs` and `ufs` use POSIX locks; `afpfs` and `smbfs` use AFP-style locks;
  - `webdav` and read-only mounts get **no lock**;
  - other types use POSIX locks when an `F_GETLK` test works (`nfs` gets its NFS variant), and dot-file locks otherwise.
  - On a local APFS disk this means POSIX `fcntl`, with the same close hazard.
  - Not measured on a Mac.

| Criterion | Option 2 |
|---|---|
| Cost per claim | Windows 1.0 ms p50, 1.8 ms p99 idle; Linux 0.19 / 0.60 ms (measured) |
| Worst case under load | Windows p99 66 ms at 2× CPU, 5.7 ms with disk flushes; Linux p99 47 ms at 4× CPU. Contended: max 1.1 s (Windows 2×, 4 processes), 1.1 s (Linux 4×) |
| Released on death | By the kernel: Windows ≤ 203 ms, Linux ≤ 66 ms under load; zombie-proof |
| PID reuse | Not involved: no PID or birth is used to decide anything |
| Network or synced folders | Local only (measured over 9p). SMB byte-range locks are enforced by the server (not measured); NFS depends on its lock service ("especially true of network filesystems and NFS in particular", SQLite); macOS WebDAV has no lock at all; cloud-synced folders never lock across machines. Today's design is worse there: a holder on another machine has a PID this machine cannot see, so the probe says "absent" and a live holder's row is replaced |
| Event loop | One attempt is a non-blocking open plus lock, about 1 ms or less; the async driver waits with timers (#212); no process is ever spawned. Sync callers block only while another holder's effect runs |
| Migration | Same lock bytes, so mixed versions exclude each other (measured). New code never writes the file, so an old-format file stays valid for an old supervisor that outlives a Runner update. Old code refuses an empty file (fail closed), but old code only meets files its own version created. An old-format file's `retired = 1` must be honored for one release |
| Size | `owned-fence-lock.mjs` shrinks from about 1,600 lines to a few hundred; the callers' retirement moves to their records (§6); about 6–8 days in all (§7) |
| Tests | Most of owned-fence-lock.test.ts's 48 tests pin the durable protocol (schema forgery, sidecars, legacy migration, holder election) and are rewritten; owned-fence-self-birth.test.ts's 10 tests go with self-birth; new crash, mixed-version and close-guard tests (§7) |

### 5.3 Option 3: the current design with #212's measured limits

| Criterion | Option 3 |
|---|---|
| Cost per claim | Windows 19–24 ms p50 idle, 57 ms with disk flushes; Linux 26 ms idle, 62–96 ms under CPU load, 83 ms with disk flushes; macOS CI about 22–48 ms. Plus the first claim of each Windows process: a cold `powershell.exe`, 0.26–21 s (#212) |
| Worst case under load | Windows p95 330 ms, p99 507 ms (2× CPU); contended p99 7.0 s, max 8.2 s; Linux contended max 4.6 s (4× CPU) |
| Released on death | Not by the OS. The next claimant must probe: Windows 330 ms idle, 7.2–7.7 s at 2× CPU with #212 (never on main); Linux 44–214 ms once reaped, **never** while a sync claimant is the zombie's parent |
| PID reuse | Windows: `Get-Process StartTime` at 100 ns, normalized to µs: strong. Linux: start time in clock ticks since boot (proc_pid_stat(5) field 22), with no boot id. macOS: `ps -o lstart=` uses strftime `%c`, which shows whole seconds. A PID reused within that resolution, or a zombie, looks like the live holder. The effect is a wedge while that process lives (liveness), never two holders. Across machines the effect is a real double holder (above) |
| Network or synced folders | Unsafe: a remote live holder is "absent" here, and its row is replaced |
| Event loop | #212's async driver frees async callers. Sync callers remain: the supervisor (all of its claims) and the Runner's POSIX claims, up to 15 s (#212's reviewer finding 1) |
| Migration | None |
| Size | None beyond #212. Fixing the zombie defect (FL0) is about 0.5–1 day |
| Tests | Unchanged, plus FL0's zombie test |

### 5.4 Option 4: other OS primitives (no unsigned binary)

| Primitive | Reachable from Node without an unsigned binary? | Released on death | Measured | Verdict |
|---|---|---|---|---|
| **Windows exclusive open** (libuv `UV_FS_O_EXLOCK`, value `0x10000000`) | Yes, but undocumented: Node does not export the constant, and `fs.openSync` honors it | Yes: the kernel closes the handle | Claim 0.10 ms; crash release 14 / 17 ms idle, 68 / 169 ms at 2× CPU | No. Windows only, so Linux would still need SQLite. Any other open handle (Defender, the indexer, backup, a reader of ours) makes a claim fail with `EBUSY`, and ours makes theirs fail. It relies on an unexported flag value |
| **macOS `O_EXLOCK`** (the same libuv flag; `flock` per open file description, not dropped by other closes) | In principle (libuv: "only supported on macOS and Windows") | Yes | Not measured (no Mac) | No. macOS only; worth knowing because it avoids the POSIX close hazard there |
| **Linux `flock` / OFD locks** | No Node API. Only through `flock(1)` (util-linux) holding the lock in a child process; macOS has no `flock(1)` | When the helper exits, after our pipe closes | Not measured | No. A spawn per claim or per process, and the lock belongs to the helper, not to us |
| **Windows named mutex** | No Node API. Through a PowerShell helper (`[System.Threading.Mutex]`), which then owns the mutex | Abandoned-mutex semantics, good, but for the helper | Cold `powershell.exe` 0.26–21 s per process (#212) | No. A slow start per process, IPC per claim, and the owner is the helper |
| **`LockFileEx` / `fcntl` directly** | Only through SQLite (Option 2) or a native addon (an unsigned binary, ruled out) | Yes | = Option 2 | Through SQLite: this is Option 2 |
| **`O_EXCL` lock file**, **`mkdir`** lock directory, holder file | Yes | **No**: 0 of 1 recovered in 15 s on both OSes | Claim 0.1–0.5 ms | No. It needs holder identity and probes, which is today's problem; it is what the lock was before 2026-08-31 |

### 5.5 Side by side

| | Option 1 | **Option 2** | Option 3 | Option 4 (best: Windows exclusive open) |
|---|---|---|---|---|
| Claim, idle | ~0.5 ms request | **0.2–1.0 ms** | 19–26 ms (+ cold self-birth on Windows) | 0.1 ms, Windows only |
| Recovery after a crash | Needs a probe | **Kernel, ≤ 203 ms loaded** | Probe: up to 7.7 s, or never | Kernel |
| PID reuse matters | At the mode switch | **No** | Yes (liveness) | No |
| Shared folders | Records still shared | Local only (fails open across machines) | Steals across machines | Local only |
| Blocks the event loop | No | **No (async); briefly (sync)** | Yes (sync, probes) | No |
| New hazard | Mode switch | **POSIX foreign close** | — | AV and indexer handles |
| Size | Largest | **Medium** | None | Medium, three code paths |

## 6. Recommendation and design: Option 2

Keep the API (`withOwnedFenceLock`, `withOwnedFenceLockSync`, the error classes, `isOwnedFenceLockContention`, #212's deadlines and waits), and replace what is under it.

1. **The lock file** keeps its path.
   - It is created empty with `O_EXCL` (mode 0600) only when the caller's authority check passes (`assertAuthority`, as today's provisional path, :635-639).
   - SQLite never creates it: it is opened through a URI with `mode=rw`. Through `sqliteDatabaseLocation`, long Windows paths still work.
2. **A claim:**
   - the in-process FIFO queue per resolved path (today's `asynchronousTails`) and #212's same-thread sync refusal;
   - `lstat`: a regular file, one link, not a link;
   - open read-write without creating, busy timeout 0, then `BEGIN IMMEDIATE`;
   - `lstat` again: the same device, inode and birth time as before the open. SQLite's own handle is never `fstat`ed: on POSIX that would need a second descriptor, whose close drops the lock;
   - A foreign WAL database is refused, as today. Opening one would make SQLite create `-wal` and `-shm` files. FL2 chooses how to check: for example, the header's journal-mode bytes, read before the first SQLite open while this process holds no lock on the file (an fs read is harmless then).
3. **Busy:** close, wait (#212's schedule: 5 ms growing by half up to 50 ms, with timers in the async driver), and retry until the deadline, then fail with `OwnedFenceContentionError` (fail closed).
4. **The effect** runs while the lock is held. Callers keep comparing fencing tokens inside it (G2 unchanged).
5. **Release:** `ROLLBACK`, then close. If either throws, the connection is kept referenced and never closed, so the lock stays held until the process exits. That is G4's outcome today, with no durable row, and it is recorded and reported. An acquisition whose effect never started is just a `ROLLBACK`, so G5's bookkeeping disappears.
6. **Retirement (G6) moves into the authority records:**
   - The Windows Job host already writes `backendOwnershipReleasedAt` inside its release effect (windows-job-process-host.ts:1028), and every effect checks it under the lock (`assertActive`).
   - The portable release writes a released tombstone into `fence.json` inside its release effect. Every fence reader under the lock refuses it: `readOwnedFence` in native-process-backend.ts, `readCurrentFence` (portable-process-supervisor.mjs:752) and `readCurrentPosixFence` (portable-process-child.mjs:118).
   - The lock file or the directory is removed after the lock is released. On Windows that removal retries `EBUSY` while a contender holds the file open for a probe, as `removeProtocolPath` does now (:1435-1459).
   - A late contender sees the tombstone, or no authority at all, and fails closed.
   - Lock files are only ever deleted together with the authority they guard, after its tombstone. Deleting a POSIX lock file that someone still holds would split the lock across two inodes (sqlite.org/howtocorrupt.html §2.5); the `lstat` re-check and the tombstone both catch that.
   - For one release, an old-format file with `retired = 1` is still read (read-only) as retired.
7. **Removed:**
   - the holder and acquisition tables, the schema validation and the legacy migration;
   - the sidecar checks: nothing writes, so the checks become "refuse WAL";
   - self-birth (`currentProcessBirthFingerprint`, `prepareCurrentProcessBirthFingerprint` and the Job host's prestart, windows-job-process-host.ts:399);
   - the holder probes (`inspectProcessBirth`, the `powershell.exe` and `ps` probes), stale-holder election, and the retained and unstarted holder bookkeeping;
   - the lock fields of `inspectionFenceOptions`.
   - The supervisor's `lock-holder.json` check stays. It authenticates the supervisor (portable-process-supervisor.mjs:780-813), it does not feed the lock.
8. **The POSIX close guard:**
   - Lock files are touched only by `lstat`, the one `O_EXCL` create and SQLite.
   - A static test refuses any fs read, open, copy or stream API on a fence or state `.lock` path in `runner-v2/src` outside `owned-fence-lock.mjs` and `launcher-instance.ts`.
   - A static check keeps `node:sqlite` the only SQLite library in the Runner. A second library copy would not share SQLite's in-process lock tracking.
   - On Linux, the tests also confirm in `/proc/locks` that this PID holds the lock after a claim.
9. **Diagnostics.** A contention error says "held by another process". On Linux it can name the PID from `/proc/locks`; on Windows there is no cheap way to name it.

How each guarantee is kept:

| Guarantee | Option 2 mechanism |
|---|---|
| G1 | RESERVED file lock for the whole claim-to-release span; in-process queue; same-thread refusal |
| G2 | Unchanged: callers compare tokens under the lock |
| G3 | The kernel releases a dead holder's lock; a live holder's lock cannot be taken; there is no probe to be uncertain |
| G4 | A failed release keeps the connection open until the process exits |
| G5 | `ROLLBACK`: nothing durable to clean |
| G6 | Tombstones in the authority records, checked under the lock; removal after the tombstone |
| G7 | `lstat` before and after; `mode=rw`; WAL refused |
| G8 | #212's deadlines and waits |

## 7. Packets

Verification rules for every packet:
- The targeted tests named below, plus `npm run typecheck:runner-v2`. Packets that change imports in runner-v2/src also run `npx tsx scripts/release/test-bundle-closure.mts`.
- The full `test:runner-v2` runs only in CI or by the owner.
- A module that newly imports a mutation-capable `node:fs` API updates test/filesystem-mutation-routing.test.ts and adds a filesystem-owner review record (AGENTS.md).
- Tests that pin the durable protocol are rewritten to the new design, never bent around it.
- New crash tests must stay fast. One kill and recovery measured at most 0.2 s on a loaded Windows host. Each PR reports its CI job times, and no job grows past about 3 minutes.
- Each packet is a pull request against main, reviewed and merged before the packets that depend on it start. FL2 also gets an independent review (Runner V2 standing rule).

| Id | Title | Depends on | Days | Targeted tests | Acceptance |
|---|---|---|---|---|---|
| FL0 | **Only if Option 2 is not approved, or as a stopgap.** A zombie holder is absent (Linux `/proc/<pid>/stat` state `Z`; macOS `ps -o stat=`); the Linux fingerprint gains the boot id | #212 | 0.5–1 | test/owned-fence-lock.test.ts | • a sync claim by the parent of a killed, unreaped holder reclaims it within its deadline<br>• a live holder is never displaced<br>• no other behavior change |
| FL1 | Authority tombstones outside the lock: the portable release writes a released tombstone into `fence.json` inside its release effect, and every fence reader under the lock refuses it (native backend, supervisor, POSIX child); tests prove the Windows Job host's existing `backendOwnershipReleasedAt` check covers every effect. The lock itself is unchanged | #212 merged | 1–1.5 | test/posix-process-backend.test.ts, test/portable-process-protocol.test.ts, test/portable-process-channel.test.ts, test/windows-job-fence-effects.test.ts, test/windows-job-status-fencing.test.ts, test/b2-residue.test.ts | • with the lock database's `retired` flag forced off in a test, a contender that claims after a release still refuses, with no effect<br>• releases of authorities launched before the change still complete |
| FL2 | **The OS-lock core** (§6, items 1–9) in `owned-fence-lock.mjs`, the POSIX close guard, and the read-only handling of old-format `retired` files. This is the fencing change | FL1 | 2.5–3.5 | test/owned-fence-lock.test.ts (rewritten), test/portable-process-protocol.test.ts, test/portable-process-channel.test.ts, test/posix-process-backend.test.ts, test/windows-process-backend.test.ts, test/windows-job-fence-effects.test.ts, test/windows-job-status-fencing.test.ts, test/execution-isolation-provider.test.ts, test/oci-execution-isolation-provider.test.ts, test/isolation-coordination-locks.test.ts, test/windows-long-paths.test.ts, test/filesystem-mutation-routing.test.ts, test/static-adapter-policy.test.ts, test/task8-raw-launch-closure.test.ts, test/b2-residue.test.ts | • a claim never spawns a process, never probes a PID and never writes the lock file (SQLite may still roll back a hot journal that a crashed old-version commit left)<br>• a killed holder's lock is reclaimed on Windows and Linux, including an unreaped zombie<br>• old and new code on one existing file lose 0 updates<br>• an old-format retired file stays retired<br>• a foreign WAL file is refused<br>• a failed release keeps the lock until the process exits<br>• the static close guard fails on a planted `readFileSync` of a lock path<br>• uncontended claim p95 is measured and reported on all three CI OSes<br>• the independent review finds no mutual-exclusion or retirement regression |
| FL3 | The Runner's sync claims move to async: `assertFence` → `claimOwnedFence` (native-process-backend.ts:678-684, :1275), `commitOwnedFenceEffect` and `cleanupFenceEffect` (:1303, :932), the snapshot (:399) and `assertPortableOutputSettledAtFence` (:1365). The supervisor and the POSIX child keep sync claims in their own processes | FL2 | 1.5–2 | test/posix-process-backend.test.ts, test/windows-process-backend.test.ts, test/portable-process-channel.test.ts, test/portable-process-protocol.test.ts | • a static test finds no `withOwnedFenceLockSync` call reachable from the Runner process<br>• behavior and ordering of fenced effects are unchanged |
| FL4 | Remove what the lock no longer needs: self-birth and its Windows prestart, the holder probes, the lock fields of `OwnedFenceLockOptions` and `inspectionFenceOptions`; delete owned-fence-self-birth.test.ts | FL2 (after FL3: both touch native-process-backend.ts) | 1 | test/owned-fence-lock.test.ts, test/windows-process-backend.test.ts, test/windows-job-status-fencing.test.ts, test/static-adapter-policy.test.ts | • no `powershell.exe` or `ps` start remains in `owned-fence-lock.mjs`<br>• the architecture doc's list of raw process boundaries drops `owned-fence-lock.mjs` (docs/runner-v2/architecture.md) |
| FL5 | After one Runner release with FL2: stop reading the old-format `retired` flag | FL2 released | 0.5 | test/owned-fence-lock.test.ts | • an old-format file is just a lock file |

**Order:** FL1 → FL2 (independent review) → FL3 → FL4; FL5 after a release. Total 6.5–8.5 days, with FL0 only on the owner's word. FL1 can start once #212 is merged; nothing here conflicts with #212's waits, which FL2 keeps.

## 8. Risks

- **POSIX foreign close drops the lock** (measured). A future in-process reader of the state directory (a diagnostics bundle, a copy, a backup) would silently end mutual exclusion on Linux and macOS. Today's holder row would have hidden that mistake; Option 2 would not.
  - Mitigations: the static guard and the single-SQLite check (FL2), lock files touched only by `lstat`, the in-process queue, and state kept outside projects (runner-start.ts:207-211).
- **Network and synced state directories.** OS locks are local only (measured over 9p), and macOS WebDAV has no lock at all.
  - The default state roots are local (`%LOCALAPPDATA%\AIBoard`, `~/Library/Application Support/AIBoard`, `$XDG_DATA_HOME/aiboard`; launcher-instance.ts:45-60). But a Linux home on NFS, or `--state-dir`, can put them on a network filesystem.
  - Today's design is no better there: it replaces live remote holders. Decision FD-4.
- **Windows releases a dead holder's lock asynchronously** ("depends upon available system resources"). The slowest measured release was 203 ms at 2× CPU. A slower one costs only claim time, bounded by the deadline, then fails closed.
- **The unexplained 2,783 ms CI open** (§4.2). If its cause was SQLite's own retry of a Windows sharing violation on open (up to about 1.4 s, §5.2), Option 2 could still meet it, because it opens the file per claim. It never writes the file, though, so antivirus gets no new content to scan. FL2 reports CI claim times on all three OSes.
- **Fairness.** Polling lets a returning claimant barge. With 4 contenders, p99 was 216–772 ms, and 1.7 s for the long-lived variant on Linux at 4× CPU. Production locks have 2 or 3 contenders. The in-process queue is FIFO.
- **Error messages lose the holder's identity** on Windows ("held by another process").
- **macOS is measured only through CI.** FL2's tests run in the macOS portable job, which already exercises the real lock.
- **This is the most-reviewed part of the Runner** (B2 review rounds 8–13, Gate C). FL1 lands first, so retirement no longer depends on the lock file's content when FL2 changes it. FL2 gets an independent review.
- **Mixed versions during an update.** Measured compatible (§4.5). An old supervisor keeps using its old-format file, and the new Runner only takes the lock bytes.

## 9. Owner decisions

| Id | Question | Recommendation | Why |
|---|---|---|---|
| FD-1 | Direction | **Option 2**, in packets FL1–FL5 | §4 and §5: it removes the probes, the flushes and both wedges at medium size, with a known, guardable risk |
| FD-2 | FL0 (zombie fix) now? | **No, unless FL2 slips by more than about a week** | #212's async driver already lets the event loop reap for async callers; the remaining exposure is a supervisor crash in the middle of a sync Runner claim, and it fails closed |
| FD-3 | Claim ceiling with Option 2 | **Keep #212's 15 s** | The slowest Option 2 waits measured were 1.1 s (contended, loaded) and 203 ms (crash release). The ceiling bounds waiting for a *live* holder's effect, and the Windows Job signal effect holds the lock across a supervisor request of up to 60.25 s (`AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS` + 250), so a waiting claim can still give up and fail closed. The portable channel retries contention (portable-process-channel.ts:695) |
| FD-4 | Network or synced state directories | **Document it, and have `aiboard doctor` warn when the state directory is on a network filesystem; do not refuse** | No data on how often it happens; every option is unsafe there |
| FD-5 | Windows exclusive open as a Windows fast path | **No** | 1.0 ms → 0.1 ms is not worth a second code path, an unexported flag, and claims failing whenever antivirus holds the file |
| FD-6 | The existing unsigned `windows-birth/native/win-x64/helper.exe` | **A separate session**, outside this plan | It is tracked under runner-v2/src, so the release bundle includes it (scripts/release/bundle-contents.mts:52). It is launched for Windows birth inspection (windows-birth/session.mjs:89, through `WindowsBirthInspectionOwner`, native-process-backend.ts:160 and portable-process-supervisor.mjs:129). It predates the 2026-11-09 no-unsigned-binaries rule. Option 2 removes the lock's use of it (`inspectHolder`), but supervisor validation still uses it |
| FD-7 | Option 1 later | **Not now** | Revisit only if profiles show Option 2's claim of about 1 ms on the output-ACK path |
| FD-8 | Open per claim or a long-lived connection | **Per claim** | 1.0 vs 0.6 ms on Windows idle, and an open SQLite handle blocks deleting the file or directory on Windows (no `FILE_SHARE_DELETE`) |

## 10. Status

As of 2026-11-14: this note is waiting for the owner's review. No packet has started. #212 is open and is a dependency of FL1.
