# PX-2t — real-host guarantee tests for the Windows Job path (lane C, tests only)

Owner decision CD-21 ("Safe steps first"): before any launcher speed change
(PX-2a/b/c), pin every `runner-windows-job-v1` guarantee with tests on the
REAL Windows Job host. No product code changed in this packet: `git status`
shows only the two new files below; `runner-v2/src` is byte-identical
(sha256-verified after every prove-red restore).

New files (writable set respected; nothing else touched):

- `runner-v2/test/windows-job-real-host-guarantees.test.ts` (862 lines,
  sha256 `ad9c35cbe2d72edb62faf5b02861b8c563bff5384cdc78c0949292003ee0d960`)
- `runner-v2/scripts/measure-git-launch.mts` (213 lines,
  sha256 `2fce19baec3042ae88e180067e231f56ab1484bc449c92d4f2ac88b5a9a45f08`)
- this file `PX-2t.md` (evidence)

Machine: Windows 10 Pro 10.0.19045, 16 CPUs, node v24.18.0, git
2.53.0.windows.1. Backend on this machine: `runner-windows-job-v1`
(production probing selects it; every run re-verifies empirically — one git
call must leave `managed-processes-job-host/*.json` records, else the file
skips). All runs with `NODE_TEST_CONTEXT` cleared, per the packet.

## 1. Guarantee matrix (`runner-windows-job-v1` path)

"Real-host" means: real `createExecutionHost` + real Job backend + real
powershell/supervisor/git processes. Each cited test was opened and read this
packet; fakes and portable-backend tests are marked as such (confirms
PX-1-review-r1 F6).

| # | Guarantee | Existing real-host proof (file:line + name, verified by reading) | Verdict |
|---|---|---|---|
| G1 | Exact grant scoping | `execution-command-grant-scope.test.ts` "command scope authorizes only canonical directories within its original grant access" — real grant authority, synthetic fixture, no host. `one-shot-command-family-production-matrix.test.ts:61` "maps strict capability failure before launch" — real graph incl. real Job backend on win32, but refuses before launch on capability grounds, not directory grounds. | MISSING end-to-end → NEW T1 |
| G2 | Job membership + kill-on-close per call | `windows-process-backend.test.ts:1981` "optional Windows Job adapter terminates and verifies a TERM-ignoring descendant tree" — real Job backend+host, detached SIGTERM-ignoring grandchild, `force_terminate` → `exited` + `verifyEmpty empty:true`. Plus matrix family timeout/cancel tests (`one-shot-command-family-production-matrix.test.ts:33,46`) — real graph, `timed_out`/`cancelled` + `verified_empty` + grandchild PID dead. Repair 1 adds the T7b release-refusal pin below (release refused while non-empty, `windows-job-process-host.ts:247-253`; the same binding releases once empty). | PROVEN (+ T7b refusal pin) |
| G3 | Host (Job-host process) death kills the whole tree | None: F6 confirms no test kills the host/supervisor (only `static-adapter-policy.test.ts:116-117`, a static regex). | MISSING → NEW T3 |
| G4 | A surviving descendant is owned and killed | `:1981` (above): the grandchild outlives the root by construction and is killed by the Job — but that test checks status only, never the grandchild PID (r1 B2). Repair 1: NEW T4 production-path test (root exits at 300 ms, detached descendant survives; `timed_out` + `verified_empty`, deadline waited out, grandchild PID asserted dead with a 2 s grace) + NEW T7b backend-level control (`:1981` tree shape: `reconcile` = running, `verifyEmpty.empty === false`, `observe` pending; then kill → `exited`, exactly empty, release). | PROVEN (T4 + T7b; `:1981` alone was status-only) |
| G5 | Timeout kills ONE call's tree while a concurrent call in the same run finishes | None: matrix tests are single-call; concurrency is only claimed in a comment (`one-shot-command-executor.ts:63-66`). | MISSING → NEW T5 (repair 1 rewrote it: the survivor now prints at ~9 s, outliving the ~5 s timeout kill, and the test asserts it returned AFTER the killed call with `exited`/0/`verified_empty`/byte-exact stdout — the original quick-call version could not see a kill hitting other calls, r1 B1) |
| G6 | Launch proof fails closed | `one-shot-command-family-production-matrix.test.ts:104` "queues timeout after workload start but before durable bind" — real graph, pre-bind failure → `timed_out` + `verified_empty`, never success. No real-host test for an unlaunchable executable (`launch_not_proven`). | MISSING (exe case) → NEW T6 |
| G7 | Process-birth identity against PID reuse | `:2782` "shared activation rejects a different exact birth" and `:2817` "release waits for active output delivery" use hand-built fake `service` objects (read: no spawn). `:557` "startup refuses to cache a filename…" is a constructor check over synthetic files, no host. | MISSING on real host → NEW T7 (repair 1 scope note, r1 F1: T7 pins only the FIRST of three identity layers — the `jobIdentity` discriminator compare. The lane-identity and `startedAt` re-attestation layers refuse the same stale binding further down, but no test drives a stale *in-flight* record through the production path) |
| G8 | Output bounds under a flood | `bounded-output-spool.test.ts:456,371` — spool unit tests, no host/backend. | MISSING on real host → NEW T8 |
| G9 | Correct output attribution between two concurrent calls | None. | MISSING → NEW T9 |
| G10 | Deadlines | `process-tools.test.ts:173` "process timeout is mechanical and terminates the child" — real production graph (→ real Job backend on win32) but asserts only `timedOut`. Matrix family timeout tests add `verified_empty` + dead grandchild on the real graph. The 5 s start/control and 30 s git deadlines have no fast real-host trigger (see limits). | Partially proven; promptness pinned → NEW T10 (repair 1: deadline 1.5 s → 3 s — the tree needs ~1 s to appear, so 1.5 s left ~0.4 s margin under load — and post-`verified_empty` grace 10 s → 2 s so a premature empty proof cannot pass) |
| G11 | Durable audit (tamper-evident records) | `durable-process-store.test.ts:795` "completed effect marker survives SQLite restart and tampering fails integrity" — real SQLite, store-level, no host. | MISSING end-to-end → NEW T11 |
| G12 | Crash recovery (fail closed, no relaunch) | `subprocess-runtime.test.ts:2765` "expired unbound launch is atomically orphaned…" and `:3251` use the file-local fake `Backend`. `execution-host.test.ts:30` "close conjunction retains a pre-adoption unknown launch" is streaming-level with a synthetic writer. | PARTIAL (review r2: recover() reports an in-flight launch as effect_outcome_unresolved; no runner crash is simulated; takeover, lease expiry and reconcile of an orphan stay OPEN on the real host) → NEW T12 (repair 1 reworked it, r1 B3: Part A gives `recover()` real work on the real host — a live orphaned launch on a second host is reconciled, reported by invocationId with a non-success state, never relaunched, no new supervisors, and the launch itself is undisturbed; Part B keeps the host-death no-exit-code pins live + durably. Residual: lease-expiry takeover needs a >5 min wait with no product seam, so it stays untested) |
| G13 | Writer fence protocol (stale writer rejected; takeover) | `windows-process-backend.test.ts:2012-2013` inside `:1981` (takeover fence reconciles, stale-fence `signal` rejected) — r1 spot-check, not re-read this cycle. `owned-fence-lock.test.ts` is unit-level. | Partially proven (r1 F3a; PX-2b's most-needed row) |
| G14 | Supervisor bearer-token authentication + authenticated abort | None found on the real host (r1 F3b). | MISSING |
| G15 | Release tombstone / no double release | `windows-process-backend.test.ts:2851-2980` look like the same fake-`service` style as `:2817` (r1 did not open each one). | MISSING on real host (unverified) |
| G16 | C# Job-host surface that PX-2a rewrites (env block, argv, exit code, cwd, suspended-create→assign→resume) | Env block: `process-tools.test.ts:62` (real graph). Exit code: `process-tools.test.ts:115-126` (asserts exit 2). Cwd: inside-grant control of NEW T1. Argv/batch shims: no real-host test verified. Suspended-create then assign then resume: no test (T3/T12 trees spawning a descendant immediately are the only indirect cover). Supervisor exits ~4 s after release: no test; current ~4 s linger recorded as the PX-2a baseline (§6). Per r1 F3d spot-checks. | Partially proven; argv/shims + suspend/resume + release-linger MISSING |

## 2. New tests (all in `windows-job-real-host-guarantees.test.ts`)

Shared harness: one real `createExecutionHost` + `bindRun` (full profile),
selection probe in `before()` (git call → Job records present, else skip),
per-test timeouts ≤ 55 s, every test ends with zero-leftover assertions
(marker PIDs dead; `assertNoLiveSupervisors` polls run supervisors to
`ESRCH`). T7/T7b drive the real backend + real Job host directly because the
executor never surfaces backend bindings (documented in the file). Repair 1
net rules (r1 B4/F4/F8): every spawned tree self-exits after 90 s; every tree
test kills its own identified PIDs (marker PID + Job-record PIDs incl. the
Job-host powershell, never guessed) in a `finally`; post-`verified_empty`
graces are 2 s (kill-propagation waits stay 10 s); record lookup matches argv
basename (never a record-set diff); the supervisor gate excludes supervisors
already alive before the file started, so a PX-2c pre-started spare needs no
net edit.

- T1 "a git call outside its exact grant fails closed without launching" (G1):
  outside-grant cwd refused by `authorizeDirectory`, Job record count
  unchanged; inside-grant control succeeds.
- T3 "host-process death kills the whole tree and never reports success"
  (G3): powershell Job-host killed (CIM child lookup, `process.kill`), child +
  TERM-ignoring grandchild dead ≤ 10 s, never clean success, and explicitly no
  exit code is reported.
- T4 "a root that exits first still leaves no surviving descendant" (G4, repair 1):
  root exits at 300 ms leaving a detached TERM-ignoring grandchild,
  `timeoutMs: 4_000` → `timed_out` + `verified_empty`, elapsed ≥ deadline,
  grandchild PID asserted dead with a 2 s grace (a premature `verified_empty`
  of the kind PX-2b's event-driven settle could produce would pass a 10 s grace).
- T5 "timeout kills one call's tree while a concurrent call finishes" (G5,
  repair 1 rewrite): 5 s sleeper-tree vs a survivor that prints at ~9 s in one
  `Promise.all`; `timed_out` + `verified_empty` + dead grandchild (2 s grace)
  vs survivor returned AFTER the killed call with `exited` 0 +
  `verified_empty` + byte-exact stdout. A kill hitting every running call of
  the run (the PX-2c spare-pair risk) turns this red.
- T6 "an unlaunchable executable fails closed" (G6): missing exe →
  `launch_failed` or throw (`launch_not_proven`), never `verified_empty`.
- T7 "process-birth identity rejects a reused birth on the real Job backend"
  (G7): sequential launches get distinct processIds; stale `startedAt` for a
  live process → `identity_mismatch`; valid birth → `exited`, then exactly
  empty + release.
- T8 "an 8 MiB output flood stays bounded with exact totals" (G8):
  `totalBytes` exact, `truncated`, tail ≤ 128 KiB + 1 KiB, spill ≤ cap, run
  spill ≤ 12 MiB.
- T9 "two concurrent calls keep byte-exact output attribution" (G9): 300
  distinct lines each, captured outputs byte-equal to expectations.
- T10 "a command deadline kills mechanically within its bound" (G10, repair 1):
  3 s deadline on a tree → `timed_out` + `verified_empty`, elapsed < 20 s,
  grandchild PID dead with a 2 s grace.
- T11 "a real call leaves tamper-evident durable audit records" (G11): new
  invocation row per call with `verified_empty` + exit; every row carries an
  HMAC tag; `integrity_check` ok; editing a row in a COPY fails on read
  ("…is corrupt", cause "integrity mismatch").
- T7b "verifyEmpty stays non-empty while a descendant lives and release is
  refused until empty" (G2/G4, repair 1, backend-level like T7): `:1981`-shape
  tree, `observe` pending; after 1.5 s `reconcile` = running,
  `verifyEmpty.empty === false`, `observe` still pending; a second live tree's
  `release` is refused with "not verified terminal"
  (`windows-job-process-host.ts:247-253`); that launch is then settled through
  a fresh backend instance (the first instance's lane stays closed by design)
  and the same binding releases once empty; main flow ends `exited`, exactly
  empty, released, grandchild PID dead (2 s grace).
- T12 "recovery reconciles a live launch fail-closed and host death leaves no
  exit code" (G12, repair 1 rework): Part A — a live orphaned launch on a
  second host; `recover()` reports it by invocationId with a non-success
  state, no relaunch, no new supervisors; the launch is undisturbed (still
  `timed_out` + `verified_empty`). Part B — host death: no clean success, no
  exit code live or durably.

Final green run (original packet): 10/10, 50.3 s (`px2t-final.log`).
Repair 1 green runs: 12/12, 97.3 s and 12/12, 100.9 s
(`%TEMP%\px2t-red\FULL-green-1.log`, `FULL-green-2.log`). No temp roots or
processes left behind after either run (checked: no `aiboard-px2t-*` dirs).

## 3. Prove-red records

One controlled fault per new test, each restored byte-exact (backup copy in
`%TEMP%`-adjacent sandbox dir, sha256 before == sha256 after). `runner-v2/src`
is untouched at the end (`git status` shows only the two new files).
Single-line faults via `faults.cjs` (throwaway, in the sandbox backup dir);
the G1 bypass via the file editor; CRLF anchors matched byte-exact.

| Test | Fault (file) | Red result | sha256 before → after |
|---|---|---|---|
| T1 | `git-run-context.ts`: skip `authorizeDirectory`, use raw cwd | outside call proceeds to git → "not a git repository", regex misses → fail 1 (`red1.log`) | `59872d16…dd24` == |
| T3 | `managed-process-job-host.ps1`: `LimitFlags = 0` (no kill-on-close) | tree survives host death (`waitForDeath` fails) → fail (`red2.log`); 3 leaked procs (11580/45904/19560, proven mine via record+marker) killed, tmp root removed | `21ea2c9e…db5db2` == |
| T3/T12 | `windows-process-backend.ts`: `exitCode: terminal.exitCode ?? 0` (fabricate unobserved exit) | "must report no exit code" fails → fail 1 each (`red11.log`, `red11b.log`) | `603ff2e8…5c865f6` == |
| T5 | `windows-process-backend.ts`: `signal()` returns `running` without signaling | timeout never kills; test exceeds 55 s timeout → fail (`red3.log`); 3 leaked procs killed via marker/records, tmp root removed | `603ff2e8…5c865f6` == |
| T6 | `windows-process-backend.ts`: unresolvable exe → `process.execPath` | missing exe runs node → `timed_out`, not `launch_failed`/throw → fail (`red4c.log`) | `603ff2e8…5c865f6` == |
| T7 | `windows-process-backend.ts`: skip birth-fingerprint comparison | stale birth → `outcome_unknown`, not `identity_mismatch` → fail (`red5.log`) | `603ff2e8…5c865f6` == |
| T8 | `bounded-output-spool.ts`: `DEFAULT_TAIL_BYTES` 128 KiB → 64 MiB | 8 MiB tail breaks the bound → fail (`red6.log`) | `e499088c…12711e0` == |
| T9 | `windows-process-backend.ts`: channel sink swaps stdout/stderr | "A attribution" byte-equality fails → fail (`red7.log`) | `603ff2e8…5c865f6` == |
| T10 | `one-shot-command-executor.ts`: deadline +3 600 000 | sleeper never times out; 55 s test timeout → fail (`red8.log`); 3 leaked procs killed via marker/records, tmp root removed | `104e9cd7…0d14752e` == |
| T11 | `durable-process-store.ts`: integrity tag constant | fresh row unreadable ("…is corrupt", cause "integrity mismatch") → fail (`red9.log`) | `7ae7cda0…f1705` == |
| T12 | same fabrication fault as T3/T12 row | durable "no exit code" fails → fail (`red10b.log`) | `603ff2e8…5c865f6` == |

Non-discriminating attempts (kept honest, not claimed): removing the
`process_start_failed` throw alone (G6 still fails closed downstream);
`verifyEmpty`-always-true (G12 still fails closed — the empty proof is not the
load-bearing check after host death); `recoverclean` reporting "cleaned"
(G12's `recover()` legitimately returns `[]` — the killed call is already
terminal). The last finding strengthened T12: it now pins the unknown exit
code live and durably instead of asserting over an empty recovery list.
Repair 1 update: always-true `verifyEmpty` is now DISCRIMINATING at the new
T7b backend control (red, R3) — while still staying green on the production
path after host death, where the release layer catches it (r1 "three faults"
item 2 stands for that path). A `verifyEmpty` fault on the wrong settle
branch (polling-loop return instead of the channel-path `terminal` return)
stays green — the test tells the branches apart (R5 first attempt).

## 4. Measurement script and one run's numbers

`runner-v2/scripts/measure-git-launch.mts` (packet's `scripts/` path;
created): production entry point `lifecycle("integration")`, `n` from argv
(default 20), 2 warmup dropped, quiet command `git status --porcelain=v1`
(empty output, 1-file repo) and large command `git ls-files` (4000 files,
64 000 stdout bytes, sibling repo so the quiet scan stays cheap), median/p90/
min/max plus mean Job-host fence effects per call (counted by wrapping the
real host at the `windowsJobHost` seam). Writes nothing into the repo
(scratch under `os.tmpdir`, removed; `git -c core.autocrlf=false` so setup is
silent). Self-verifies the backend: reports `jobBackend` from the run's
`managed-processes-job-host` records.

Recorded run (`n=20`, this machine, not provably quiet — see limits):

- `jobBackend: true` (45 records)
- quiet: median **1139.7 ms**, p90 1298.6, min 986.0, max 1299.8;
  effects/call: launch 1, reconcile 7, read 3, release 1, attach 1, claimFence
  1, signal/write/close/ack 0 → **14 total**
- large: median **1284.8 ms**, p90 1456.0, min 1155.6, max 1571.4;
  effects/call: as quiet + read 4.3, output_ack 1 → **16.3 total**

The 14/call count reproduces the PX-1-review measurement exactly.

CORRECTION (repair 1, r1 F5a): the old note below ("a different-command
number, not a regression") was wrong. The gap to PX-1's 934 ms is machine
load, not the command: r1's interleaved probe measured `status` median
1249 ms vs `rev-parse HEAD` median 1309 ms in one host — the command explains
~0 ms. The script now includes a `rev-parse HEAD` sample (same command as
PX-1) so the comparison is direct, and states its quantile rule (upper-middle
element for even n).

Quiet-machine re-run, repair 1 (`n=20`, no other test running — stated, per
r1 F5e; log `%TEMP%\px2t-red\MEASURE-quiet-n20.log`):

- `jobBackend: true` (67 records)
- quiet (`status --porcelain=v1`): median **837.9 ms**, p90 896.5, min 829.2,
  max 911.2; effects/call 14 total (as above)
- large (`ls-files`, 4000 files, 64000 stdout bytes): median **975.0 ms**,
  p90 995.0, min 953.5, max 1050.0; effects/call 16.05
- rev-parse (`rev-parse HEAD`, same command as PX-1): median **910.9 ms**,
  p90 936.9, min 874.4, max 943.7; effects/call 16 — within noise of PX-1's
  934 ms. No regression; the old 1139.7 ms was a loaded machine.

## 5. Validation suites and counts

All with `NODE_TEST_CONTEXT` cleared; new file `--test-concurrency=1`,
existing suites `--test-concurrency=4` (per packet). The
`windows-job-output-replay*` and `windows-job-supervisor-input*` wildcards
each expand to exactly one file (`windows-job-output-replay.test.ts`,
`windows-job-supervisor-input.test.ts`), both covered in the 20/20 row.

| Suite | Result | Time |
|---|---|---|
| `windows-job-real-host-guarantees.test.ts` (new) | 10/10 pass | 50.3 s |
| `windows-job-output-replay` + `windows-job-supervisor-input` + `one-shot-command-family-production-matrix` | 20/20 pass | 36.6 s |
| `execution-host` + `durable-process-store` | 38/38 pass | 22.7 s |
| `execution-grants` + `process-tools` | 16/16 pass | 52.0 s |
| `subprocess-runtime` | 73 pass, 0 fail, 1 skipped | 13.4 s |
| `windows-process-backend` | 96/96 pass | 135.9 s |
| `tsc -p runner-v2/tsconfig.json --noEmit` | clean | — |
| `eslint` on both new files | clean | — |
| `git diff --check` | clean | — |

Repair 1 validation (all with `NODE_TEST_CONTEXT` cleared; new file
`--test-concurrency=1`, existing suites `--test-concurrency=4`):

| Suite | Result | Time |
|---|---|---|
| `windows-job-real-host-guarantees.test.ts` (12 tests) run 1 | 12/12 pass | 97.3 s |
| `windows-job-real-host-guarantees.test.ts` (12 tests) run 2 (stability) | 12/12 pass | 100.9 s |
| `windows-process-backend` + `one-shot-command-family-production-matrix` + `windows-job-output-replay` + `windows-job-supervisor-input` | 116/116 pass | 110.4 s |
| `tsc -p runner-v2/tsconfig.json --noEmit` | clean | — |
| `eslint` on both changed files | clean | — |
| `git diff --no-index --check /dev/null <file>` per new file (untracked files need the no-index form; plain `git diff --check` cannot see them) | clean | — |

No product/test/package file modified; no commit/stage/stash/push (tree shows
only the two new untracked paths).

## 6. Not done / limits

- Start/control deadlines (5 s) and the 30 s git limit have no fast real-host
  trigger through the production entry point; only the command-timeout
  mechanism is pinned (T5/T10). Pinning the fixed deadlines needs product
  seams (not added — tests only) or minute-long tests.
- T7 is backend-level, not through `createExecutionHost`: the executor never
  surfaces backend bindings, so exact-birth rejection cannot be driven one
  level up without product changes.
- Off Windows (or if probing ever stops selecting the Job backend) the file
  skips cleanly — no coverage there. Non-Windows CI sees 10 skips.
- The per-run supervisor keep-alive linger (~4 s, PX-1-review F7, still
  present) sets the file's ~50 s floor; leftover polling returns early and
  each test stays well under a minute.
- Prove-red faults for G5/G10 leak TERM-ignoring trees by design (the point of
  the fault); each was identified by marker PID + Job record (never by
  guessing) and killed with its tmp root removed. One fault run (G3) needed a
  session terminate after the red was recorded because `binding.close()` hangs
  on the leaked tree; unrelated processes (incl. a VS Code node, PID 30440)
  were explicitly left alone.
- Measurement: the original run's gap to PX-1 was machine load, not the
  command — corrected in §4 with a quiet `n=20` re-run incl. a `rev-parse`
  sample (910.9 ms vs PX-1's 934 ms). Not yet measured: a non-full profile
  (r1 F5c; the script only drives `permissionProfile: "full"`). Fence effects
  are host-seam counts (launch/reconcile/read/signal/release/
  attach/write/close/ack/claim), not SQLite `exec` counts.

## 7. Repair cycle 1 (2026-09-29, r1 verdict REPAIR — 4 blocking)

Tests only; `runner-v2/src` untouched (`git diff --stat -- runner-v2/src`
empty at the end; all five fault targets restored byte-exact, sha256
before == after — table below). Deliverables: test file 1369 lines (corrected after review r2)
(sha256 `147a16d71e5c66ff4da83fef0547cded654af28a35cd308835564baf5fdabf30`),
script 228 lines (sha256
`aa5d4f9c940215e1a547c85c028a966f11e93b995dc3ed26d0af0567db82e9b3`).
No commit/stage/stash/push. Red logs in `%TEMP%\px2t-red\` (R1–R9 +
`FULL-green-1/2.log`, `SUITES-existing4.log`, `MEASURE-quiet-n20.log`,
`backup/` with the five pristine sources).

- B1 (T5 isolation): survivor prints at ~9 s, outlives the ~5 s kill;
  asserts return-ordering + `exited`/0/`verified_empty`/byte-exact stdout.
  Prove-red R1 with r1's fault shape (one call's timeout kills every running
  call of the run): red on "survivor must outlive the kill".
- B2 (empty proof): new T7b backend control (red under always-true
  `verifyEmpty`, R3) + release-refusal pin on the 247-253 layer (red under a
  release-guard cut, R4; the refused launch is settled through a fresh
  backend instance because a refused release closes that lane by design) +
  new T4 production path with root-exits-first and the grandchild PID
  asserted (red when the kill never lands, R2).
- B3 (real recovery): T12 Part A reconciles a live orphaned launch on a
  second host (red when recovery returns nothing, R6 — the old vacuous shape
  would stay green under that fault); Part B keeps the no-exit-code pins
  (red under exit-code fabrication, R5). Lease-expiry takeover still
  untested (needs a >5 min wait with no product seam).
- B4 (no red-run leaks): 90 s self-exit in both tree ends; `finally` kills
  identified PIDs (marker + record PIDs incl. the Job-host powershell, which
  holds the cwd lock — without it red runs fail temp-root removal with
  EPERM). Every red run below was checked for leftovers by record; all PIDs
  verified dead, stale temp dirs removed by hand where a hung call blocked
  the `after()` hook (R2, R9). A hung call (kill itself broken) cannot reach
  its `finally` while awaiting the unsettled call — the 90 s self-exit is
  what bounds that shape.
- Found while repairing: Job records store the `-e` script *source*, where
  the marker path sits JSON-escaped — a raw-path argv `includes` never
  matches on Windows. Record lookup matches the uuid basename instead
  (documented in the file).

Prove-red (faults applied by byte-exact temporary edits, restored from
`backup/` copies; sha256 before == after in every row):

| Test | Fault (file) | Red result | sha256 before → fault → after |
|---|---|---|---|
| T5 | `windows-process-backend.ts` signal: also SIGKILL every other lane of the run | "survivor must outlive the kill" (`R1-t5-broadcast.log`, 17.3 s) | `603ff2e8…5c865f6` → `6bec5228…bed1bd` → == |
| T4 | same file signal: pretend stopped without signaling | "test timed out after 55000ms" (`R2-t4-signalfake.log`); hung-tree EPERM collateral, all PIDs dead, dir removed | `603ff2e8…5c865f6` → `2d979c61…511d` → == |
| T7b | same file `verifyEmpty`: always `{empty:true}` (r1 probe shape) | `empty` strictEqual true vs false (`R3-t7b-alwaystrue.log`, 12.9 s), no leftovers | `603ff2e8…5c865f6` → `7417c448…4cba0` → == |
| T7b | `windows-job-process-host.ts` release: neuter all three stopped guards | "Missing expected rejection" at the refusal assert (`R4-t7b-releasecut.log`, 13.6 s), no leftovers | `0a41738b…49a8b7` → `b34d43ab…5a411a5c6` → == |
| T12 | `windows-process-backend.ts` observe: `exitCode ?? 0` | first attempt on the polling-loop branch stayed GREEN (branch discriminator, kept honest); corrected to the channel-path `terminal` return → "crashed call must never report clean success (got exited)" (`R5-t12-exitfab.log`, 33.7 s), no leftovers | `603ff2e8…5c865f6` → `4532594c…fd1b8545` → == |
| T12 | `subprocess-runtime.ts` `reconcileStartup`: `return []` | "recovery must report the orphaned live launch (it has work)" (`R6-t12-norecover.log`, 21.2 s), no leftovers | `06e08cef…99c861` → `9184ee78…9502f` → == |
| T3 | `managed-process-job-host.ps1`: `LimitFlags = 0` | "tree after Job-host death to die did not settle within 10000ms" (`R7-t3-nokillonclose.log`, 22.4 s), no leftovers | `21ea2c9e…db5db2` → `1629f55d…88f54a055c8` → == |
| T6 | `windows-process-backend.ts`: unresolvable exe → `process.execPath` | "launch must fail closed, got: timed_out/verified_empty" — the tightened regex rejects it (`R8-t6-exeswap.log`, 31.3 s) | `603ff2e8…5c865f6` → `7a731df3…765e0270a` → == |
| T10 | `one-shot-command-executor.ts`: deadline +3 600 000 | "test timed out after 55000ms" (`R9-t10-nodeadline.log`, 65.6 s); hung-tree EPERM collateral, all PIDs dead, dir removed | `104e9cd7…0d14752e` → `b5273603…2c93441` → == |
| T1 | timeout-only change; original authorize-directory-skip proof stands (fault orthogonal to the change) | — (see §3) | — |

Minors closed: M1 stray blank CRLF removed (last bytes now `3b 0a 7d 0a`,
no-index check clean); F5 claim corrected + rev-parse sample + quantile rule
stated + quiet `n=20` numbers (§4); F3 rows G13–G16 (matrix); T7 first-layer
note (matrix G7 + file comment); F4 argv-basename lookup + spare-tolerant
supervisor gate (file + §2); F6 T6 regex + T10 3 s + T1 timeout; F8 2 s
post-empty graces (kill-propagation waits stay 10 s with the reason in-file).
Residual (not done): lease-expiry takeover; stale in-flight record through
the production path (deeper T7 layers); G16 argv/shims + suspend/resume +
release-linger tests; non-full-profile measurement; off-Windows CI sees
12 skips (Windows-only net, stated).

## Controller acceptance (2026-09-30)

Independent review r2 (`PX-2t-review-r2.md`, Sonnet xhigh): **ACCEPT**. B1, B2, B4 and M1 resolved with the reviewer's own faults; B3 PARTIAL, so T12's title and comment and row G12 are relabelled PARTIAL/OPEN (controller text fix, no assertion changed); the G14 label and the line counts are corrected. Follow-ups: N4 (tests still tied to today's process model: T1 exact Job record count, T12 record and supervisor deepEqual, the powershell.exe child lookup in T3 and T12, the supervisor gate) goes to the PX-2c review; red runs still leave an `aiboard-px2t-*` temp root (EPERM in `after()`); the non-full profile is unmeasured.

**PX-2t ACCEPTED 2026-09-30.**
