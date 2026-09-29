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
| G2 | Job membership + kill-on-close per call | `windows-process-backend.test.ts:1981` "optional Windows Job adapter terminates and verifies a TERM-ignoring descendant tree" — real Job backend+host, detached SIGTERM-ignoring grandchild, `force_terminate` → `exited` + `verifyEmpty empty:true`. Plus matrix family timeout/cancel tests (`one-shot-command-family-production-matrix.test.ts:33,46`) — real graph, `timed_out`/`cancelled` + `verified_empty` + grandchild PID dead. | PROVEN — no new test |
| G3 | Host (Job-host process) death kills the whole tree | None: F6 confirms no test kills the host/supervisor (only `static-adapter-policy.test.ts:116-117`, a static regex). | MISSING → NEW T3 |
| G4 | A surviving descendant is owned and killed | `:1981` (above): the grandchild outlives the root by construction and is killed by the Job. (`:1933` "owns a surviving descendant after launcher exit" is the portable backend — not cited as proof.) | PROVEN — no new test |
| G5 | Timeout kills ONE call's tree while a concurrent call in the same run finishes | None: matrix tests are single-call; concurrency is only claimed in a comment (`one-shot-command-executor.ts:63-66`). | MISSING → NEW T5 |
| G6 | Launch proof fails closed | `one-shot-command-family-production-matrix.test.ts:104` "queues timeout after workload start but before durable bind" — real graph, pre-bind failure → `timed_out` + `verified_empty`, never success. No real-host test for an unlaunchable executable (`launch_not_proven`). | MISSING (exe case) → NEW T6 |
| G7 | Process-birth identity against PID reuse | `:2782` "shared activation rejects a different exact birth" and `:2817` "release waits for active output delivery" use hand-built fake `service` objects (read: no spawn). `:557` "startup refuses to cache a filename…" is a constructor check over synthetic files, no host. | MISSING on real host → NEW T7 |
| G8 | Output bounds under a flood | `bounded-output-spool.test.ts:456,371` — spool unit tests, no host/backend. | MISSING on real host → NEW T8 |
| G9 | Correct output attribution between two concurrent calls | None. | MISSING → NEW T9 |
| G10 | Deadlines | `process-tools.test.ts:173` "process timeout is mechanical and terminates the child" — real production graph (→ real Job backend on win32) but asserts only `timedOut`. Matrix family timeout tests add `verified_empty` + dead grandchild on the real graph. The 5 s start/control and 30 s git deadlines have no fast real-host trigger (see limits). | Partially proven; promptness pinned → NEW T10 |
| G11 | Durable audit (tamper-evident records) | `durable-process-store.test.ts:795` "completed effect marker survives SQLite restart and tampering fails integrity" — real SQLite, store-level, no host. | MISSING end-to-end → NEW T11 |
| G12 | Crash recovery (fail closed, no relaunch) | `subprocess-runtime.test.ts:2765` "expired unbound launch is atomically orphaned…" and `:3251` use the file-local fake `Backend`. `execution-host.test.ts:30` "close conjunction retains a pre-adoption unknown launch" is streaming-level with a synthetic writer. | MISSING on real host → NEW T12 |

## 2. New tests (all in `windows-job-real-host-guarantees.test.ts`)

Shared harness: one real `createExecutionHost` + `bindRun` (full profile),
selection probe in `before()` (git call → Job records present, else skip),
per-test timeouts ≤ 55 s, every test ends with zero-leftover assertions
(marker PIDs dead; `assertNoLiveSupervisors` polls all run supervisors to
`ESRCH`). T7 drives the real backend + real Job host directly because the
executor never surfaces backend bindings (documented in the file).

- T1 "a git call outside its exact grant fails closed without launching" (G1):
  outside-grant cwd refused by `authorizeDirectory`, Job record count
  unchanged; inside-grant control succeeds.
- T3 "host-process death kills the whole tree and never reports success"
  (G3): powershell Job-host killed (CIM child lookup, `process.kill`), child +
  TERM-ignoring grandchild dead ≤ 10 s, never clean success, and explicitly no
  exit code is reported.
- T5 "timeout kills one call's tree while a concurrent call finishes" (G5):
  5 s sleeper-tree vs 30 s quick call in one `Promise.all`; `timed_out` +
  `verified_empty` + dead grandchild vs `exited` 0 + byte-exact stdout.
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
- T10 "a command deadline kills mechanically within its bound" (G10): 1.5 s
  deadline on a tree → `timed_out` + `verified_empty`, elapsed < 20 s, tree dead.
- T11 "a real call leaves tamper-evident durable audit records" (G11): new
  invocation row per call with `verified_empty` + exit; every row carries an
  HMAC tag; `integrity_check` ok; editing a row in a COPY fails on read
  ("…is corrupt", cause "integrity mismatch").
- T12 "crash recovery after host death fails closed without relaunch" (G12):
  no exit code live or durably; `recover()` reports no success; no new Job
  records or supervisors.

Final green run: 10/10, 50.3 s (`px2t-final.log`).

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
- Measurement is one run on a shared (not provably quiet) machine; the quiet
  command differs from PX-1's (`status` vs `rev-parse`), so the ~150–200 ms
  gap to PX-1's 934 ms is a different-command number, not a regression.
  Fence effects are host-seam counts (launch/reconcile/read/signal/release/
  attach/write/close/ack/claim), not SQLite `exec` counts.
