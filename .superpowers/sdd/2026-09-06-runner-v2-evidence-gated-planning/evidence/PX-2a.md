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
