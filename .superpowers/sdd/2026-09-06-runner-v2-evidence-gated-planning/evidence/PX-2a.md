# PX-2a — Precompiled Job-host helper and supervisor keep-alive (lane C)

Outcome: each contained call still boots one PowerShell host and one Job per
call (suspended-create → assign → resume, kill-on-close, every proof, fence
and deadline unchanged), but the Job host now loads a precompiled,
digest-pinned helper assembly instead of `Add-Type`-compiling the same C# on
every call (PX-1-review F5), and the host's supervisor HTTP client no longer
keeps the connection alive, so the supervisor exits with the result (F7).

Machine: Windows 10 Pro, node v24.18.0, git 2.53.0.windows.1, PowerShell 5.1.
Backend on this machine: `runner-windows-job-v1` (every run re-verifies
empirically). No other test, script, or workload was started deliberately
during any measurement or test run below (background OS activity unknown).
No commit, stage, stash, or push. `git status` shows only the files below.

Changed files (writable set respected; the guarantee file is untouched):

- `runner-v2/src/managed-process-job-host.ps1` (sha256 `b88cd9bb…14e8`)
- `runner-v2/src/windows-job-process-host.ts` (sha256 `f27e515e…bd81e9`)
- `runner-v2/src/managed-process-supervisor.mjs` (sha256 `75711b50…e2a0f`)
- `runner-v2/test/windows-job-launch-speed.test.ts` (new, sha256 `a2c078f8…6bc`)
- this file `PX-2a.md` (evidence)

## 1. What changed (file:line)

Precompiled, digest-pinned helper:

- ps1:4 — the C# is no longer compiled at script load; it lives in
  `$jobHostCsSource` (byte-identical source, only the `Add-Type` wrapper
  moved).
- ps1:717 — `Initialize-JobHostType`: reads the assembly file into a byte
  array, hashes it (SHA256), compares against the digest from the stdin
  config, and loads FROM THOSE BYTES (ps1:743
  `[Reflection.Assembly]::Load($helperBytes)`), so the file cannot be
  swapped between check and load. Missing file → `missing-file` (ps1:730);
  bytes differ → `digest-mismatch` (ps1:740); `Load` throws → `load-error`
  (ps1:747); no helper fields → `no-helper-config` (ps1:720). Any
  non-precompiled outcome runs today's in-process `Add-Type` compile of the
  same source. The mode and reason are appended to the per-call Job event
  file as `{"type":"helper","mode","reason"}` (supervisor ignores unknown
  event types, so the handshake is unaffected).
- ps1:792 (LSP/`RunInteractive`) and ps1:817 (batch `Run`): both modes
  initialize identically before touching `[ManagedProcessJobHost]`.
- host ts:138 `ensureJobHostHelperAssembly`: extracts the C# between the
  `$jobHostCsSource` markers (ts:119-125), keys a runner-owned directory
  `<stateDir>/job-host-assemblies/<source-sha256>/` (ts:149), compiles once
  with `Add-Type -OutputAssembly` in a throwaway PowerShell when the dll or
  digest record is absent (ts:172-183), records the dll sha256 in
  `ManagedProcessJobHost.dll.sha256` at compile time, and otherwise passes
  the recorded digest through WITHOUT re-hashing — the Job host re-checks
  every call, so a tampered file or record fails closed instead of being
  silently rebuilt. Compile failure is cached per process (ts:111-152) and
  returns null: the call omits the helper fields and falls back.
- host ts:289-302 — per call, the digest travels in the existing supervisor
  stdin-config JSON (private channel; never argv, env, or HTTP).
- supervisor mjs:301-302 — forwards `helperAssemblyPath/Sha256` from its
  stdin config into the Job-host stdin line.

Keep-alive (F7):

- host ts:773 `supervisorRequest` — `agent: false` (no pooling) plus
  `Connection: close`. The supervisor's `server.close(() => process.exit(0))`
  no longer waits on an idle keep-alive socket.

Nothing else changes: one host per call, one Job per call, every status
shape, fence, proof, and deadline exactly as today.

## 2. Tests (`runner-v2/test/windows-job-launch-speed.test.ts`, 4 tests)

Real host (`createExecutionHost` + `bindRun`, production Job backend),
skip cleanly off Windows / when the backend is not selected. A compiler
watcher (powershell `Get-Process csc,cvtres` polling with a ready-handshake
so its boot cannot miss a fast compile) runs during calls; every fault is
restored byte-exact (sha256 before == after, asserted in-test).

- T1 precompiled path: after one unwatched warmup, 3 watched calls see zero
  compiler processes and each call's `job-events.jsonl` records
  `mode=precompiled, reason=null`.
- T2 tampered file: flip one dll byte (digest record still pins the
  original) → call succeeds, `mode=fallback, reason=digest-mismatch`, and a
  compiler IS observed (positive proof the fallback compiled in-process).
- T3 digest mismatch: intact dll, digest record overwritten with zeros →
  call succeeds, `mode=fallback, reason=digest-mismatch`, compiler observed,
  dll untouched.
- T4 supervisor reap: after the result, the record's supervisor PID is dead
  within 1 s.

## 3. Prove-red records (fault → red → byte-exact restore)

Source-file sha256 before == after every red (host ts `f27e515e…bd81e9`,
ps1 `b88cd9bb…14e8`).

| Test | Fault | Red result |
|---|---|---|
| T1 | host `ensure…` forced to null (helper never offered) | `no compiler may run during call 0 (saw csc:48168)` |
| T2 | host vouches for live bytes instead of the record (pin defeated) | tampered bytes LOADED — `Unable to find an entry point named 'SetInformationJobO�ject'` (the flipped byte, proving execution came from the tampered file) → call fails closed, test red |
| T3 | ps1 digest compare forced false (load without verifying) | `mismatched digest must not load — actual precompiled, expected fallback` |
| T4 | keep-alive fix reverted (default agent, no `Connection: close`) | `supervisor to exit after the result did not settle within 1000ms` (≈4 s linger returns) |

Two watcher lessons found while proving red (kept in the test as comments):
`-ErrorAction Stop` with several process names aborts the pipeline on the
missing `cvtres.exe` before a present `csc.exe` is recorded — the watcher
uses `SilentlyContinue`; and the call starts only after the watcher signals
its first poll (ready-handshake), so a slow watcher boot cannot miss a fast
compile.

## 4. Measurement (`measure-git-launch.mts`, n=20, same script as PX-2t)

BEFORE (this base, no other load started): quiet median 840.7 ms / p90
871.4; large median 975.5 / p90 1001.3; rev-parse median 905.8 / p90 935.2;
fence effects 14 / 16 / 16 per call.
AFTER: quiet median **695.4** / p90 719.9 (−145 ms); large median **854.4** /
p90 888.7 (−121 ms); rev-parse median **772.4** / p90 854.0 (−133 ms); fence
effects unchanged at 14 / 16 / 16. The gain matches F5's precompile
expectation (~140 ms); the keep-alive fix removes the ~4 s post-result
supervisor linger (resource, off the critical path).

## 5. Validation suites and counts (`NODE_TEST_CONTEXT` cleared)

| Suite | Result |
|---|---|
| `windows-job-launch-speed.test.ts` (new, `--test-concurrency=1`) | 4/4 pass (final re-run after the lint fix) |
| `windows-job-real-host-guarantees.test.ts` (unchanged, `--test-concurrency=1`) | 12/12 pass |
| `windows-process-backend` + `windows-job-output-replay` + `windows-job-supervisor-input` + `one-shot-command-family-production-matrix` + `execution-host`(+credential-graph, +streaming-quiesce) + `subprocess-runtime` + `durable-process-store` (`--test-concurrency=4`) | 233 tests: 232 pass, 0 fail, 1 skipped (the pre-existing subprocess-runtime skip) |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| `eslint` on the three changed files + the new test | clean (one unused-import warning fixed, re-run green) |
| `git diff --check` | clean |

## 6. Not done / limits

- The digest record is the trust anchor: whoever can write both the dll and
  its record inside the runner-owned state dir can bless bytes. Same
  privilege as corrupting any other state; outside that, tamper fails
  closed. A persistently mismatched pair stays on fallback until removed —
  no automatic recompile (by design: the mismatch is the signal).
- Two concurrent first-calls in one state dir could race the one-time
  compile; the outcome is still fail-closed (fallback), never a mixed load.
- Compiler absence is sampled (~30 ms poll cadence with ready-handshake),
  backed by the deterministic per-call helper event.
- Supervisor bound is the brief's 1 s (F7 suggested ~500 ms; observed exit
  is immediate at call return).
- Measured with `permissionProfile: "full"` only (as PX-2t); interactive
  (LSP/streaming) mode gets the same helper path via ps1:792 but its
  wall-clock gain was not measured here.
- Inserted source lines use LF inside CRLF files (git autocrlf notice only;
  `diff --check`, eslint, tsc clean).

## Repair cycle 1 (2026-09-30, review PX-2a-review-r1: B1, B2, trust anchor, N2-N11)

Work on HEAD (`abeb6d7e`; PX-2a `7a1703e2` plus PX-2b `e8eb8720`, PX-2c
`cd475d57`, PX-2t text fix on top). No commit, stage, stash, or push. No
existing test weakened or deleted; the guarantee file untouched.

### What changed

`runner-v2/src/windows-job-process-host.ts` — the helper compile is now
once per RUNNER PROCESS, asynchronous, with the digest ONLY IN MEMORY:

- `compileJobHostHelperAssembly` (async, same module as the Job-host
  launch): reads the C# from the fixed `managed-process-job-host.ps1`
  literal, compiles with a throwaway `powershell.exe -File <fixed wrapper>
  <dll argv>` (B1: the one audited runner-internal launch beside the Job
  host launch), C# source base64 over the private stdin pipe, DLL path as a
  plain argv string (N6: nothing path-like is ever parsed as PowerShell; N7:
  no shared source file, private unpredictable dir). Output goes to a fresh
  per-process `tmpdir()/aiboard-job-host-assembly-<rand>/<sourceDigest>/`
  dir, hashed on read-back; digest kept in module memory, never written to
  or read from disk (trust anchor). N11: other digest dirs pruned after a
  successful compile, plus best-effort per-process dir removal on exit.
- `ensureJobHostHelperAssembly()` is now async and TOTAL (never throws;
  N2): one in-flight compile shared by concurrent calls, successes cached,
  failures NOT cached (next call retries: N3 self-heal), a vanished/emptied
  DLL recompiles (missing-file self-heal). `resetJobHostHelperAssemblyForTests`
  is the documented test-only cache reset.
- `launchOwned`/`startSpare` resolve the helper BEFORE spawning the
  supervisor (N2: a helper failure can no longer strand a supervisor behind
  a persisted `running` record) and warn once per state dir when calls run
  without the helper (N10 runner-level log; per-call tamper reasons stay in
  that call's `job-events.jsonl`, see limits).
- `extractJobHostHelperSource` strips the CRLF trailing `\r` (N8):
  extracted source is 30082 chars, no stray `\r`; the C# body is
  byte-identical to the PX-2a blob (sha `0f78e002…` before and after).

`runner-v2/src/managed-process-job-host.ps1` (`Initialize-JobHostType`
only, C# untouched): after `Assembly.Load`, a missing
`ManagedProcessJobHost` type falls back with reason `missing-type` (N5)
instead of exiting 1.

`runner-v2/test/task8-raw-launch-closure.test.ts`: exactly ONE added
allowlist entry — `windows-job-process-host.ts` /
`compileJobHostHelperAssembly` / `powershell-script-launcher,
powershell-launcher, child-process-spawn` ("runner-internal one-time
helper compile beside the Job host launch"). The module-level `.ps1`
constant is gone (literal moved into the compile function), `spawnSync` is
gone from the compile path (B1+N4).

`runner-v2/test/windows-job-launch-speed.test.ts`: 9 tests. T1 rewritten
(B2: no machine-wide compiler watch; the per-call helper event
`mode=precompiled, reason=null` is the deterministic proof). T2 adapted
(DLL located via the `ensure` export). T3 rewritten (a legacy
`ManagedProcessJobHost.dll.sha256` record beside an intact DLL is ignored:
still precompiled). New: T5 evil-DLL-plus-matching-record replacement
never loads (fallback `digest-mismatch`); T6 unusable-TEMP `ensure`
returns null, persists nothing, next call self-heals to precompiled (N2);
T7 direct-ps1 missing-type / load-error / missing-file all fall back,
exit 0, reason recorded (N5 + reason pins); T8 deleted DLL recompiles to
precompiled (N3 self-heal); T9 truncated DLL falls back `digest-mismatch`.
N9: the watcher removes its stop dir even when the watched work throws.

### Prove-red records (fault -> red -> byte-exact restore)

Pristine sha256 (working tree): host `c931ef2e…`, ps1 `3ab114c2…`,
speed test `81d67faf…`, closure test `52448e10…`. After every fault the
same sha256 was verified back.

| Test | Fault | Red result |
|---|---|---|
| T1 (changed) | ps1 C# start marker broken (`@'` -> `@"`) | fail 1: calls fall back, `precompiled` assert fails |
| T2 (changed) | host vouches for live disk bytes (pin defeated) | fail: tampered bytes LOADED — `Unable to find an entry point named 'SetInformationJobO…ject'` |
| T9 (new) | same pin defeat | fail: truncated bytes vouched (`load-error`, not `digest-mismatch`) |
| T5 (new) | same pin defeat | fail: replacement loads — reason `missing-type`, expected `digest-mismatch` |
| T3 (new) | host prefers on-disk `.sha256` (record trust) | fail: stray zeros record diverts the call to `fallback`, expected `precompiled` |
| T6 (new) | `ensure`/compile rethrow (N2 reintroduced) | fail: `ENOENT … mkdtemp '…aiboard-px2a-badtemp-…'` (the review's exact signature) |
| T7 (new) | ps1 type check reverted (`if ($false)`) | fail: `valid assembly without the type must fall back, not exit 1` |
| T8 (new) | self-heal existence check removed | fail 1: deleted DLL pins a fallback, expected `precompiled` |

A first T6 fault (rethrow at `ensure` level only) stayed green and was
discarded: the compile-level catch already contained the mkdtemp throw.
The corrected fault (rethrow at both levels) goes red as above.

### Validation suites and counts (`NODE_TEST_CONTEXT` cleared)

| Suite | Result |
|---|---|
| `windows-job-launch-speed.test.ts` (`--test-concurrency=1`) | 9/9 pass |
| same at `--test-concurrency=4` with `windows-job-supervisor-input` + `windows-job-output-replay`, twice | 15/15 pass both runs |
| `windows-job-real-host-guarantees.test.ts` (unchanged) | 12/12 pass |
| `windows-job-fence-effects.test.ts` (PX-2b) | 14/14 pass |
| `windows-job-spare-host.test.ts` (PX-2c) | 9/9 pass |
| `windows-process-backend` + `one-shot-command-family-production-matrix` + `execution-host` + `subprocess-runtime` + `durable-process-store` (`--test-concurrency=4`) | 222 tests: 221 pass, 0 fail, 1 skipped (pre-existing subprocess-runtime skip) |
| `task8-raw-launch-closure.test.ts` | PX-2a findings GONE (all 3 allowlisted); still red on 5 PX-2c findings (see limits) |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| `eslint` on the three changed TS files | clean (ps1 has no matching config, as before) |
| `git diff --check` | clean |

### Measurement (`measure-git-launch.mts`, n=20, quiet machine stated but not verifiable)

BEFORE (repair base, this HEAD): quiet median 1714.4 / p90 1968.4;
large median 2215.8 / p90 2364.4; rev-parse median 1998.9 / p90 2265.4.
The machine was heavily loaded (quiet min 1629.2 vs 634.4 after), so the
before numbers are load-dominated, not a clean baseline.
AFTER: quiet median **701.7** / p90 731.9; large median **804.0** / p90
901.4; rev-parse median **768.9** / p90 894.9 — matching the original
PX-2a after-numbers (695.4 / 854.4 / 772.4). Fence effects per call:
quiet 11/11, large 13/14, revparse ~13/14 (per-call variance across
attach/claim paths exists in both runs; no fence code touched).

### Not done / limits (repair 1)

- `task8-raw-launch-closure` stays red at HEAD on 5 findings, ALL in
  PX-2c code (`cd475d57`, verified via `git log -S`): supervisor
  `retireSpare backend?.kill`, host `<module> process.kill` (spare crash
  recovery), `retireSpare entry.launcher.kill`, `startSpare spawn`,
  `sweepRetiredSpareRecords process.kill`. Out of this lane (one allowlist
  entry only); PX-2c's repair owns them.
- N10 is partial by design: helper-unavailable warns once per state dir
  at launch. Single-call tamper fallbacks keep their reason ONLY in that
  call's `job-events.jsonl`: launch resolves at supervisor startup, before
  the Job host boots and writes its event, so the runner has no later
  observation point without extra I/O on every call.
- A deleted/emptied DLL recompiles (fail-open to a fresh trusted
  compile); a tampered/non-empty DLL never recompiles (fail-closed
  fallback) — the mismatch itself stays the tamper signal.
- No on-disk state from the old design is read; stale
  `job-host-assemblies/` dirs and `.sha256` files from PX-2a processes are
  inert and left in place.
- Old per-process temp dirs are removed best-effort on process exit; a
  killed runner can leave ~150 KB until the OS cleans temp.
- Measured with `permissionProfile: "full"` only; interactive wall-clock
  gain still unmeasured (same helper path via ps1 LSP branch).

## Repair cycle 2 (2026-09-30, review PX-2a-review-r2: R2-B1 blocking, N-r2-1..N-r2-4 minors)

Work on HEAD (`5d6e6540` = PX-2a repair 1). No commit, stage, stash, or
push. No existing test weakened or deleted; the guarantee file untouched.

### What changed

`runner-v2/src/windows-job-process-host.ts` — the self-heal is REMOVED
(R2-B1). `ensureJobHostHelperAssembly` now does `return jobHostHelperReady;`
in place of the whole heal block (the reviewer's validated fix, applied
verbatim in effect): once this runner process has compiled and pinned its
helper, the pin is never refreshed from disk. A missing, emptied or changed
file makes that call fall back to in-process Add-Type (the Job host
re-hashes the bytes and reports `missing-file` / `digest-mismatch`); the
runner never recompiles into the same place during its lifetime, so a
contained command that deletes the DLL can no longer choose the moment of a
recompile and get its own bytes blessed. Failed compiles (no pin yet) still
retry via the shared in-flight promise — that path is not
attacker-triggerable. Doc comments updated to say the pin is never
refreshed and nothing on disk is trusted after it.

`runner-v2/test/windows-job-launch-speed.test.ts` — T8 INVERTED (it pinned
the vulnerable behavior): a deleted DLL now asserts `fallback` /
`missing-file`, the call still succeeding, and the file NOT recreated. Its
`finally` no longer calls `locateHelperAssembly()` (N-r2-1): restore is
best-effort with no assertions inside `finally`, so a failure reports its
own message; the byte-exact-restore assert sits after the block. New T10
replays the delete-and-race shape from the round-2 exploit: a contained
`node -e` (full profile, via the production call path) deletes the DLL,
then overwrites it the moment it reappears, while a second call launches
meanwhile (victim starts only after the delete is observed, racer still
spinning). The evil bytes are a clone of the real helper plus a static
constructor that appends `EVIL-LOADED` to a marker file, so any load is
directly observable. Asserts: attacker exits 0 and reports `wrote=no`,
victim succeeds via `fallback` / `missing-file`, no marker ever appears,
assembly restored byte-exact. N-r2-4: every `aiboard-px2a-evil-*` scratch
dir this file creates is tracked and removed in `after` (the 14 such dirs
currently in `%TEMP%` predate this cycle — reviewer-era litter, left in
place).

### Prove-red (self-heal back -> new tests red -> byte-exact restore)

Pristine sha256 (working tree, CRLF): host
`3afe993901565a3f7acc6dc846dfa970091d5f692ed24c141765a6153e62ac3e`,
speed test
`97277e9118f9ab98258c352cf94197e5f7515e20911c7b6a8585ed0bd8f53c01`.
With the repair-1 heal block put back verbatim, the T8+T10 subset run goes
red twice over: T8 `mode` is `precompiled`, expected `fallback` (and the
visible message is now the real mode assertion, not the `finally` mask —
N-r2-1 fix confirmed); T10 attacker reports `wrote:yes` (the recompile
reappeared and the attacker's overwrite landed mid-race). After restoring
the fix both file hashes verified back byte-exact to the values above.

### Validation suites and counts

| Suite | Result |
|---|---|
| `windows-job-launch-speed.test.ts` (`--test-concurrency=1`) | 10/10 pass |
| same at `--test-concurrency=4` with `windows-job-supervisor-input` + `windows-job-output-replay`, twice | 16/16 pass both runs |
| `windows-job-real-host-guarantees.test.ts` (unchanged) | 12/12 pass |
| `task8-raw-launch-closure.test.ts` | red on the same 5 PX-2c lines only (line numbers shifted by 1 from the heal-block removal: host `:396/:527/:555/:797`, supervisor `:384`); none from PX-2a |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| `eslint` on the two changed files | clean |
| `git diff --check` | clean |

### Notes for the reviewer (minors)

- N-r2-2 (bracket TEMP): not changed in this cycle. A TEMP path
  containing `[`/`]` makes `Add-Type -OutputAssembly` treat the path as a
  wildcard: the wrapper errors, exits 0, no DLL appears, `ensure` returns
  null and calls run the in-process fallback with the once-per-state-dir
  warn. Safe by construction (never loads); documented here instead of
  fixed. Non-Latin TEMP behaves the same as the pre-PX-2a baseline
  (csc temp files, not the output path).
- N-r2-3 (compile timeout): not changed. The 120 s compile timeout sits on
  the first call's critical path (concurrent first calls share the one
  in-flight compile, so they wait together, then fall back). Before PX-2a
  the same wait blocked the event loop; now it only parks the call.
  Lowering to 30 s is a one-constant change left to the controller.
- N-r2-6 (untested N8/N10/N11 corners): unchanged this cycle; the
  round-2 probe results (30082-char source, once-per-dir log, prune plus
  exit cleanup with no `aiboard-job-host-assembly-*` left) still stand.
- Residual (review item 5): a same-user process that outlives a previous
  runner can still race a runner's FIRST compile, and the `.ps1` in the
  source dir is same-user writable. The pin cannot fix either; Job
  containment remains lifecycle containment, not confinement.

## Repair cycle 3 (controller, 2026-09-30)

Input: `PX-2a-review-r3.md` REPAIR — 1 blocking (R3-B1). Owner rule: a third repair round is done by the controller. Commit 241d5f64.

| Finding | Change | Test |
|---|---|---|
| R3-B1: a failed compile left no pin, and the next call recompiled into the same per-process directory, so a contained process alive during the retry could get its bytes pinned (reviewer probes D 3/3 and D2 2/2) | `windows-job-process-host.ts` `ensureJobHostHelperAssembly`: the result of the one compile attempt (assembly OR null) is kept for the runner's lifetime (`jobHostHelperReady !== undefined`); a throw also records null. After a failed compile every later call falls back to in-process Add-Type; only a new runner process compiles again. | T6 ("helper resolution never throws and falls back cleanly"): after the failed compile, with a good TEMP again, `ensureJobHostHelperAssembly()` stays null twice and a real call falls back with reason `no-helper-config`; after the test-only reset (a runner restart) the call runs precompiled. |
| N-r2-2 (bracket TEMP) | Measured on this machine: Windows PowerShell 5.1 Add-Type resolves `-OutputAssembly` as a wildcard path (an unescaped `[1]` gives "did not resolve") and passes an escaped path on to csc ("Error generating Win32 resource" on the backtick-escaped path), so escaping cannot work. The runner now skips the compile when the per-process directory holds a wildcard character (`[`, `]`, `*`, `?` or a backtick) and falls back for that runner process (remembered). | New "a TEMP path with brackets skips the helper compile and falls back": null at once, no compile wrapper written, remembered. |

Evidence correction: earlier notes called a failed compile "not attacker-triggerable" and a bracket TEMP "safe by construction (never loads)". Both were wrong in the way R3-B1 shows: a failed compile followed by an in-place retry was raceable. Both paths now fall back for the runner's lifetime and never retry in place.

Validation (NODE_TEST_CONTEXT cleared; controller): windows-job-launch-speed 11/11; the same file with windows-job-supervisor-input and windows-job-output-replay at --test-concurrency=4 17/17; windows-job-real-host-guarantees 12/12; task8-raw-launch-closure 2/2 (fully green at HEAD after the PX-2c repair); tsc exit 0; eslint on both changed files exit 0.

Prove-red (sha256 before/after, byte-exact restore of `windows-job-process-host.ts` d3bce3b4…74c1): (1) `if (jobHostHelperReady !== undefined)` changed to `if (jobHostHelperReady)` (failures not cached) → T6 red; restored. (2) the wildcard-path skip disabled → the bracket test red; restored.

Changed-file sha256: `windows-job-process-host.ts` d3bce3b48fa723b8439a9a4d803fc6c7eb76cedf88b4500ccfe3d2c7180074c1; `windows-job-launch-speed.test.ts` 0e19e083495da79c9eaf4cda97fed4fa1cb185df695c6ce723b03ecb81ba224b.

Limit: a machine whose TEMP holds wildcard characters runs every call on the in-process Add-Type path (no speed gain from PX-2a there). Logs: session scratchpad `px2ar3fix/`.
