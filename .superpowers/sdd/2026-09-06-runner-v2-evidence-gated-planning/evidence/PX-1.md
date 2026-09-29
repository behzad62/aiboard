# PX-1 — Contained-launch cost investigation (lane C, investigation only)

Question: every git call through the runner's audited execution host costs ~1 s on
Windows while plain git costs ~30 ms. Where does the time go, and what is the
smallest fix that keeps every containment and audit guarantee?

Verdict: the ~919 ms overhead per `git rev-parse HEAD` is fully attributed
(residual < 2%). The three sinks are (1) a fresh `powershell.exe` Job-host boot
per call (~385 ms), (2) the post-exit settle/verify/release/durable tail (~300 ms,
heavily SQLite fence-effect transactions), and (3) the polled output-drain/ack
handshake (~115 ms) plus 7 status reconciles (~185 ms, inside observe). No product
or test code was changed in this packet. No load other than the probe ran during
measurement.

## 0. Reproducibility

- Machine: Windows 10 Pro 10.0.19045, 16 CPUs, PowerShell 5.1.19041.6456,
  git 2.53.0.windows.1, node v24.18.0.
- Repo: worktree `runner-v2-px1`, branch `codex/runner-v2-px1` at 83f89cf5,
  `runner-v2/src` untouched (no product/test edits; nothing staged/committed).
- Backend selected on this machine: `runner-windows-job-v1`
  (`WindowsJobObjectProcessBackend`; `jobContainment === "verified"`, so
  `selectWindowsProcessBackendKinds` returns job first —
  `runner-v2/src/process-host-semantic-probes.ts:20`). The portable-supervisor
  path (`native-process-backend.ts`) is standby only here.
- Probe commands (cwd = worktree, scratch only in `%TEMP%\px1\`, repo never written):
  `node_modules\.bin\tsx.cmd C:\Users\b_a_s\AppData\Local\Temp\px1\px1-probe.mts`
  (n=20 end-to-end + baselines),
  `... \px1-probe2.mts` (n=20 prototype-wrap phase split + SQLite exec accounting),
  `... \px1-probe3.mts` (n=20 `supervisor.jsonl` timeline mining),
  `... \px1-probe4.mts` (n=1 supervisor lifetime poll).
  Probes build a real `createExecutionHost` (production platform/facts path, no
  overrides), `bindRun`, per-call `executionGrants.issue`, and
  `binding.git.withCall(ctx, () => binding.git.current().run(...))` — the same
  audited path production git uses. Interception is in-probe only (CJS
  `child_process`/`node:sqlite` wrappers installed before repo import;
  prototype wraps; `supervisor.jsonl` timeline reads).

## 1. Call path: `IntegrationManager.git` → git process

`integration-manager.ts:2977` (`git` → `this.execute`, a `GitCommandRunner.run`)
→ `git-runtime-runner.ts:37` (`runBytes`: policy `prepareGitExecutionPolicy`,
grant `authorize`, 30 000 ms per-command limit from `git-run-context.ts:63`,
`input.execution.execute`, output shape/maximum checks `:62-75`)
→ grant scope + directory authorization (`git-run-context.ts:82-93`)
→ `one-shot-command-executor.ts:131` (`execute`: grant issue/consume,
isolation acquire, `runtime.invoke`, `timeoutMs` deadline `:235`)
→ `subprocess-runtime.ts:292,595` (`invoke` → `runClaimed`: `writer.claim` `:333`,
output prepare, `mark_output_prepared`, `record_environment`, `mark_launching`,
`selectProcessBackend`, `backend.launch`, journaled `backend_observe`, `record_exit`,
`finish` `:937`: `output_finalize`, `begin_verify`, `verifyEmpty`, `release`,
result persist)
→ `windows-process-backend.ts:107` (`WindowsJobObjectProcessBackend.launch`)
→ `windows-job-process-host.ts:151` (`launchOwned`).

Processes started per git call (measured: exactly one of each, zero blocking
sync spawns in the host):

1. `node.exe runner-v2/src/managed-process-supervisor.mjs <processId> <statusPath>`
   (`windows-job-process-host.ts:160`, `detached`, IPC pipe). Boot to first
   status persist ≈ 50 ms (measured §2).
2. `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
   -File runner-v2/src/managed-process-job-host.ps1 --aiboard-lsp-pipe`
   (spawned by the supervisor, `managed-process-supervisor.mjs:250`). Creates the
   Windows Job Object, resolves `git` on the child PATH (`.ps1:559` throws
   `process_start_failed` otherwise), spawns git inside the Job.
3. The `git` child itself, inside the Job (kill-on-close).

No per-call `powershell.exe` birth/membership inspections occur on this path
(measured blocking `execFileSync`/`spawnSync` per call = 0). Those inspections
(`native-process-backend.ts:1067,1112`, inspectors at `:1188-1196`) belong to the
portable-supervisor path, which this machine does not select.

File-based handshakes / durable writes per call:

- `subprocess-runtime.sqlite` (WAL, `durable-process-store.ts:673`): claim,
  output-prepared, environment, launching, bind-launch, journaled observe effect,
  exit, output-finalize, begin-verify, release/result transactions
  (`subprocess-runtime.ts:333,606,667,674,787,794,855,948,970` …).
- `owned-fence-lock` SQLite effects for every fenced step (launch, observe,
  verify, release; `owned-fence-lock.mjs:191,260`).
- Job-host record `state/managed-processes-job-host/<processId>.json`, tmp+rename
  on every persist (`windows-job-process-host.ts:470-473`), plus `.fence.lock`
  (`:414`).
- Supervisor `supervisor.jsonl`: ~10 appended status lines per call
  (`managed-process-supervisor.mjs:63`), the launch handshake the host polls.
- `stdout.log` / `stderr.log` appends, `job-events.jsonl` (ps1), bounded-output
  spill under `runRoot/subprocess-output-<digest>/`
  (`one-shot-command-executor.ts:53`); IPC stdin carries the launch config
  (`windows-job-process-host.ts:678-681`), not a file.

Waits, polls, sleeps (constant + site):

- `waitForSupervisor` polls `supervisor.jsonl` every 25 ms
  (`windows-job-process-host.ts:648`); start deadline 5 000 ms (`:127`).
- Channel terminal/output-settlement poll 25 ms
  (`windows-process-backend.ts:264`; `windows-job-process-channel.ts:146,196,214`).
- Supervisor Job-event poll 10 ms (`managed-process-supervisor.mjs:266`).
- `supervisorRequest` HTTP timeout = control deadline (5 000 ms `:128`) + 250
  (`:652`); stop waits capped 250/1 000 ms (`managed-process-supervisor.mjs:476,487`).
- Durable `synchronousBackoff(25 * (attempt+1))` only on SQLITE_BUSY
  (`durable-process-store.ts:703`).
- Git per-command limit 30 000 ms (`git-run-context.ts:63`).
- Not on this path: native-backend 25 ms poll / 2 000–30 000 ms birth deadlines
  (`native-process-backend.ts:22-26,151`), legacy 25 ms observe loop
  (`windows-process-backend.ts:157`), semantic-probe deadlines (bind-time only).

## 2. Measured breakdown (`git rev-parse HEAD`, quiet machine)

End-to-end through the real host (n=20, 2 warmup dropped):
median **934 ms**, p90 **980 ms** (min 897, max 982; second run: 929/960 —
reproduces the controller's ~1 014 ms).

| Step (median / p90, n=20 throughout) | ms | Share |
|---|---|---|
| Host pre-spawn: grant scope, durable claim/prepare/env/backend-select (spawn-lag) | 37 / 42 | 4% |
| Node supervisor boot → first status persist (timeline) | 48 / 51 | 5% |
| Supervisor HTTP bind (timeline) | 18 / 19 | 2% |
| PowerShell boot + ps1 + Add-Type + Job create + git spawn (port→running) | 384 / 400 | 41% |
| Git run + exit detection (plain-git baseline below: git itself ~15) | 30 / 32 | 3% |
| Output drain/ack handshake (4× `readOwnedOutput` ≈ 94 + acks; exit→stopped gap) | 110 / 122 | 12% |
| Observe reconciles (7× `reconcileOwned` ≈ 185: status-file read + HTTP GET + record persist each) | (in observe) | — |
| Terminal settle: `waitForTerminal` tail + `record_exit` + `output_finalize` + `verifyEmpty` 24 + `release` 34 + result/grant release (stopped→return gap) | 294 / 298 | 32% |
| SQLite `exec` total: **173 ms / 166 execs** (n=20; inside the phases above, not additional) | (in phases) | ~18% |
| Grant issue (n=20) | 0.7 | ~0% |
| Overhead vs plain git (934 − 15) | ~919 | 100% |

Method-method cross-check (n=20 prototype wraps): `launchOwned` 483 (p90 497) ≈ 37 + 48 + 18 + 384;
`observe` 306 (p90 327) ≈ 23 (attach) + 185 (reconcile×7) + 94 (read×4);
`verifyEmpty` 24 + `release` 34; sum + grant/policy ≈ total.
**Unexplained remainder: < 20 ms (< 2%)**, within phase-boundary noise.
(Timeline deltas carry 1 ms ISO-timestamp quantization.)

Baselines (n=20 each, same machine): plain `git rev-parse HEAD` median
**15.2 ms** (p90 16.3); `powershell.exe -NoProfile -NonInteractive -Command exit`
median **146 ms** (p90 152). So one cold PowerShell ≈ 10× git, and the per-call
Job-host PowerShell costs ~2.6× a bare one (script parse + C# compile + Job setup).

Hygiene (resource, off the critical path): the per-call supervisor does not exit
with the result — observed self-reap ≈ 3.7 s post-result (n=1; still alive at
+6 s in another run), i.e. several node+powershell pairs linger during a run;
**0 lingering after host close**. Mechanism not pinned; flagged, not a finding.

## 3. What each step guarantees, and the test that proves it

- Exact run/call ToolBroker grant, directory confinement, no ambient authority
  (grant issue/consume, `authorizeDirectory`, per-call scope):
  `runner-v2/test/execution-grants.test.ts:192`
  ("denies forged, mismatched, escalated, expired, revoked, and restarted grants").
- Job membership + kill-on-close (git cannot escape the Job; dead host ⇒ dead tree):
  `runner-v2/test/windows-process-backend.test.ts:1981`
  ("optional Windows Job adapter terminates and verifies a TERM-ignoring
  descendant tree"); `:1933` ("Windows native supervisor owns a surviving
  descendant after launcher exit").
- Launch proof (no success without proven identity; `launch_not_proven` /
  `backend_unavailable` fail closed):
  `runner-v2/test/one-shot-command-family-production-matrix.test.ts:104`
  ("process public family queues timeout after workload start but before durable
  bind"); `windows-process-backend.test.ts:633`
  ("Windows portable launch consumes the caller's shared absolute startup deadline").
- Process-birth identity against PID reuse (startedAt/birth discriminator, fence
  re-attestation on every effect):
  `windows-process-backend.test.ts:2782`
  ("Windows Job shared activation rejects a different exact birth before service
  action"); `:557` ("Windows Job startup refuses to cache a filename and embedded
  process identity mismatch").
- Output bounds (4 MB default git cap `git-runtime-runner.ts:96`, 128 MB capture
  cap `:48`, spool tails + artifact hash checks `:106-129`):
  `runner-v2/test/bounded-output-spool.test.ts:456`
  ("keeps independent default 128 KiB byte tails across multibyte and interleaved
  chunks"); `:371` ("finalize seals synchronously, drains accepted writes, and
  rejects later writes before queueing").
- Deadlines (30 s git limit; 5 s start/control; stop grace; timeout kills):
  `runner-v2/test/process-tools.test.ts:173`
  ("process timeout is mechanical and terminates the child").
- Audit/durable records (every state change journaled in WAL SQLite; tamper-evident):
  `runner-v2/test/durable-process-store.test.ts:795`
  ("completed effect marker survives SQLite restart and tampering fails integrity").
- Crash recovery (orphaned launch leased/orphaned, never double-run; restart
  reconciles to a fail-closed state):
  `runner-v2/test/subprocess-runtime.test.ts:2765`
  ("expired unbound launch is atomically orphaned without takeover cleanup or
  relaunch"); `:3251` ("exhaustive durable-state by reconcile-outcome matrix is
  fail-closed"); `runner-v2/test/execution-host.test.ts:30`
  ("close conjunction retains a pre-adoption unknown launch and exact retry
  authority").

## 4. Ranked options (expected per-call time; guarantee at risk; proving test)

1. **Persistent per-run Job-host broker** — one `powershell.exe` + supervisor per
   run binding; each git call spawns inside the existing Job over the existing
   IPC/HTTP channel. Expected ≈ 934 − 385 (PS boot) − 50 (node boot) ≈ **~500 ms**
   alone. At risk: cross-call Job reuse (a previous child mistaken for the new
   one; output mixup) and kill-on-close scope creep. Proves with
   `windows-process-backend.test.ts:1981` (empty/tree-kill),
   `:2782`/`:557` (exact birth/identity per child), `:2817` ("release waits for
   active output delivery and closes later observation").
2. **Event-driven settle instead of fixed polls** — supervisor pushes
   stopped+settled (or the host long-polls `/status`) replacing the 25 ms
   `waitForSupervisor`/channel cadence, the ~100 ms unsettled gap, and most of
   the 7×26 ms reconciles. Expected saves ≈ 150–200 ms (≈ 300–350 with option 1).
   At risk: a lost wakeup hangs the call — the existing deadlines
   (`process-tools.test.ts:173`; start/control deadlines) stay as backstops and
   must be proven still armed.
3. **Batch/shrink durable writes** — fewer fence-effect transactions per call
   (combine exit+finalize+verify records; skip record persist when status
   unchanged; fewer `supervisor.jsonl`/`.json` writes on the hot path). Expected
   saves ≈ 100–130 of the 171 ms SQLite share. At risk: crash-recovery audit
   gaps. Proves with `durable-process-store.test.ts:795` and
   `subprocess-runtime.test.ts:3251` (`:2765`, `:1037`).
4. **Shorter polls only (25 ms → 5 ms)** — saves ≈ 50–80 ms of detection latency,
   touches neither the 385 ms boot nor the 300 ms tail; burns host CPU on every
   wait. Ranked low; same proving tests as option 2.
5. **Native Windows API path without PowerShell** (C#/C++ helper or N-API Job
   control) — could remove most of the 385 ms, but it is the largest new trusted
   surface (argv handling, Job security attributes, teardown) and re-proves all
   of §3 from scratch. Ranked last.
6. **Fewer/batched birth inspections** — measured saving: **0 ms**. The selected
   job path performs no per-call PowerShell inspections (blocking sync = 0);
   that cost exists only on the unselected portable path. Kills the hypothesis.
7. **Test-only cost?** — No. The SQLite WAL store, fence effects, and Job host
   are the production path (`execution-host.ts:460-484,540-549`); handoff tests
   pay exactly what production pays per git call.

## 5. Recommendation (keeps every §3 guarantee; targets ≤ 200 ms)

Combine options 1 + 2 + 3 as one change: a **persistent per-run broker**
(warm PowerShell Job host + supervisor, per-call child spawn by command),
**event-driven terminal/output settlement** over the existing authenticated
channel, and **batched durable effects** (one transaction covering exit →
finalize → verify intent; persist-on-change for status/record files).
Deadlines (30 s git, 5 s start/control), grant scoping, birth discriminators,
output bounds, and WAL journaling are unchanged — only boot redundancy, poll
latency, and transaction count shrink.

Budget: 15 (git) + ~20 (spawn-in-warm-Job + 1 status roundtrip) + ~30
(event-driven drain/ack) + ~40 (batched SQLite) + ~30 (verify+release, 2 HTTP) +
~40 (grant scope/policy/result) ≈ **~175 ms**.

Size: 4–5 files — `runner-v2/src/windows-job-process-host.ts`,
`runner-v2/src/managed-process-supervisor.mjs`,
`runner-v2/src/managed-process-job-host.ps1`,
`runner-v2/src/windows-job-process-channel.ts`, and
`runner-v2/src/subprocess-runtime.ts` and/or `runner-v2/src/owned-fence-lock.mjs`
(durable batching only). Risk: medium. The sensitive move is Job reuse across
calls; it is contained by keeping per-child birth discriminators, per-call
fences, and the empty-proof-before-release rule exactly as-is, with
`windows-process-backend.test.ts:1981,2782,557,2817` plus a new broker-reuse test
(empty proof and output attribution across two sequential children in one Job)
as the gate. Phase it: broker first (~500 ms), then event-driven settle, then
durable batching — each phase re-runs §3's tests plus this packet's probe
(§0 commands, n=20, same machine) before proceeding.
