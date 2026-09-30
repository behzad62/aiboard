# PX-2e — No leftover processes from the Windows Job test files (lane C)

Outcome: the PX-2b `windows-job-fence-effects` file leaked exactly the 2
supervisors per run reported in PX-2c-review-r3 N14; the other five files
leaked nothing. The two leaks are fixed at their cause (test teardown), and
every one of the six files now ends with a shared guard that fails the file
when a supervisor or Job host it started is still alive. No commit, stage,
stash or push. No product code changed: the refusal that caused the leak is
a deliberate B4 guarantee (kept byte-identical).

Machine: Windows 10 Pro 10.0.19045, node v24.18.0, PowerShell 5.1. Backend on
this machine: `runner-windows-job-v1` (re-verified empirically: every file
ran its real-host tests). The machine is shared: a second pipeline
(worktree `runner-v2-p6-6`) ran concurrently throughout; its supervisors and
Job hosts appear in every scan below and were never touched (identified by
command line + creation time; attribution is by this worktree's
`runner-v2/src` path plus each file's own temp-root markers).

Contract: packet PX-2e (controller 2026-09-29, lane C). Writable set
respected: the six test files, one new helper under `runner-v2/test/
support/`, this evidence file. Product files (`windows-job-process-host.ts`,
`managed-process-supervisor.mjs`, `windows-job-process-channel.ts`)
unchanged — `git diff --stat` shows only the six test files (the helper is
untracked). No assertion weakened or deleted (only `finally` teardowns and
added `after` hooks).

## 1. Measure first (before any change)

Each file run ONCE alone (`npx tsx --test --test-concurrency=1
runner-v2/test/<file>`); after the file's process ended, leftover
`node.exe` running `managed-process-supervisor.mjs` from THIS worktree and
`powershell.exe` Job hosts it left alive (command line + creation time).

| File | Supervisors left | Job hosts left |
|---|---|---|
| `windows-job-supervisor-input.test.ts` (2 tests) | 0 | 0 |
| `windows-job-output-replay.test.ts` (4 tests) | 0 | 0 |
| `windows-job-launch-speed.test.ts` (11 tests) | 0 | 0 |
| `windows-job-real-host-guarantees.test.ts` (12 tests) | 0 | 0 |
| `windows-job-spare-host.test.ts` (19 tests) | 0 | 0 |
| `windows-job-fence-effects.test.ts` (35 tests) | **2** | 0 |

The 2 fence-effects leftovers (this worktree, N14 reproduced exactly):

- `aiboard-px2b-unknown-*` — test "supervisor wait parks while the outcome
  is unknown" (`windows-job-fence-effects.test.ts:1243`).
- `aiboard-px2b-cursor-*` — test "supervisor wait returns at once on a
  stale change cursor" (`:1306`).

(The scan also lists the concurrent p6-6 pipeline's supervisors every time;
they are excluded by the worktree marker and were never touched. My own two
measurement leftovers, pids 41340/51564, were killed by PID after recording
and confirmed dead; no other process was signalled.)

## 2. Cause and fix (test-side; product guarantees kept)

Root cause (one cause for both leaks): each test asserts on a call that ends
with **unacknowledged retained output** — `unknown` (child
`process.stderr.write('held')` exits at once, status `exited_unknown` +
empty proof + 4 retained bytes) and `cursor` (ticking child, killed while
output is retained) — and then tears down with a bare
`signalOwned(SIGKILL)` + `releaseOwned`, both half-swallowed. Both calls are
**refused by design** while retained output is unacknowledged:
`signalOwned` throws `process_output_unsettled_terminal` before (`:862`) or
after (`:867`) the kill via `throwIfTerminalOutputPending` (`:1239-1243`),
and `releaseOwned` throws the same at `:898`. The supervisor parks in
`exited_unknown` with `ownershipReleased:false`
(`managed-process-supervisor.mjs:590-599`) and only ever leaves it through
`/ack-output` → `tryMarkStopped` (`:257-282`, `:587-601`); a kill alone
(`POST /signal`, `stopOwnedTree`) does NOT retire it. Nothing ever ACKs, so
the supervisor lives forever (hours, per N14). This refusal is the PX-2b B4
pin — the product behavior is correct, so the fix is in the test teardown,
which must drain through the designed path.

Fix — new shared helper `runner-v2/test/support/
windows-job-leftover-guard.ts` (225 lines), `retireOwnedTreeForTests`
(`:179`): best-effort `signalOwned(SIGKILL)`, then drain retained output
with exact per-stream ACKs (`readOwnedOutput` + `acknowledgeOwnedOutput`,
bounded to 10 rounds), then best-effort `releaseOwned`. ACKed output lets
the supervisor reach `stopped` and exit itself; the release writes the
tombstone. Never throws (failures are for the end-of-file guard to report).
Uses only designed product paths; no bypass, no new privilege (same owner,
same fence, same user). Callers:

- `windows-job-fence-effects.test.ts:1293` (unknown `finally`) and `:1362`
  (cursor `finally`) — replaced the swallow-everything signal+release with
  the helper (import at `:55`). The other 33 tests needed no change: every
  other raw-host child in the file is output-free (`process.exit(0)` or a
  silent sleep) or tears down through the backend observe path, and none
  leaked in measurement.

Self-caught during repair: the first helper version detached
`acknowledgeOwnedOutput` (`const acknowledge =
service.acknowledgeOwnedOutput`), losing `this`, so every ACK threw inside
the swallowed block and both shapes still leaked (the file end-check caught
it: 2 supervisors, recorded/killed/reported). Fixed by binding
(`acknowledge.bind(service)`); a two-shape probe then retired both trees.

Guarantees kept (product untouched): B4 refusal codes
(`process_output_unsettled_terminal` for unsettled signal/release),
`throwIfTerminalOutputPending`, the `/ack-output` exact-frame match, the
`stopped`+`ownershipReleased` release predicate, spare opt-in. Said plainly:
no product guarantee was available to weaken — the diff adds zero product
lines.

## 3. End-check helper (one shared helper, an `after` hook in each file)

`checkNoWindowsJobProcessesLeft` (`windows-job-leftover-guard.ts:140`),
wired as a top-level `after()` at the end of each of the six files:

- fence-effects `:1494` (`["aiboard-px2b-"]`), guarantees `:1428`
  (`["aiboard-px2t-"]`), launch-speed `:854` (`["aiboard-px2a-"]`),
  spare-host `:1349` (`["aiboard-px2c-"]`), output-replay `:124`
  (`["p683-job-replay-"]`), supervisor-input `:45` (`[]`, worktree-scoped:
  the file drives the supervisor source in-VM and spawns nothing real).

Attribution (`findOwned`, `:81`): a supervisor matches only when its command
line contains `managed-process-supervisor.mjs` AND this worktree's
`runner-v2/src` path (derived from the helper's own `import.meta.url`, so
other worktrees/checkouts never match) AND one of the file's temp-root
markers (or, for the fixture-only file, no marker). A Job host
(`powershell.exe`, whose command line carries no temp root) matches only as
a descendant of a matched supervisor (parent-PID walk) or by its own marker.
Matched processes get a 10 s grace to exit on their own (stopped supervisors
self-exit; `after` hooks may run in either order); survivors are recorded,
killed (children first, `process.kill` with a `taskkill` fallback),
re-verified, and reported by throwing. The existing per-test record gates in
the guarantees (`assertNoLiveSupervisors`) and spare-host files are
untouched and stay authoritative; the new guard additionally covers
supervisors without a record.

Two observations recorded while building it: (a) port-dead is not
process-dead — `server.close(() => process.exit(0))` waits for open HTTP
connections, so an unconsumed `fetch` body keeps a stopped supervisor's
process alive with a dead port; the guard therefore enumerates processes,
never ports. (b) On a red run the test's own `t.after` `rmSync` fails with
EPERM first (the live Job host holds the cwd lock) — the guard still finds
the tree by command line and retires it.

## 4. Prove red

Fault: replaced the unknown test's drain with a no-op (`await
Promise.resolve()`). Full file run: 34/35 pass, the file end-check failed
red — `PX-2e leftover guard: 1 supervisor(s) and 0 Job host(s) ... pid=48740
... aiboard-px2b-unknown-qJIZRR ... kill: pid=48740:SIGKILL-sent / all
leftovers confirmed dead after kill`, exit 1. Restored byte-exact: sha256
`7e81ed7e65f49c8e329abdaaacab9947fb1cd9cb80edcf02db9f598a3d1a3c0e` before ==
after (UTF-16LE BOM stripped before compare). (An earlier fault attempt on
the cursor test also reddened the file but through the test's own EPERM
`rmSync` plus guard timing; the unknown-shape fault is the clean
demonstration and is the one recorded here.)

## 5. Validation scope (owner 2026-09-30 impact policy)

Ran (each once alone, `--test-concurrency=1`): all six changed files plus
`task8-raw-launch-closure.test.ts` (unchanged, required by the packet).
`tsc --noEmit -p runner-v2/tsconfig.json` clean; `eslint` on all seven
changed/added files clean; `git diff --check` clean.

| File | Result | Leftovers from this worktree after |
|---|---|---|
| fence-effects (35) | 35/35 pass | 0 |
| guarantees (12) | 12/12 pass | 0 |
| launch-speed (11) | 11/11 pass | 0 |
| spare-host (19) | 19/19 pass | 0 |
| supervisor-input (2) | 2/2 pass | 0 |
| output-replay (4) | 4/4 pass | 0 |
| task8-raw-launch-closure (2) | 2/2 pass | n/a (spawns nothing) |

Total test time ~9 minutes, within the ~15-minute budget. Did NOT run:
every other suite (per the policy: only files this packet changed, plus
task8). In particular the 11-file Windows Job batch, the backend/channel/
execution-host suites, and any full `test:runner-v2` run were deliberately
not re-run — no product file changed, so their contracts are unaffected;
the per-test gates inside the run files (guarantees/spare record gates, B4
refusal pins, E1 upgrade pin) all passed in place.

## 6. Not done / follow-ups

- The p6-6 pipeline's supervisors/Job hosts seen in every scan belong to a
  concurrent lane; untouched. If the controller's 50-process pileup
  recurs, the per-file guard now fails the offending file at once instead
  of slowing the whole machine silently.
- `retireOwnedTreeForTests` is used by the two leaking tests only; other
  files' teardowns already retire (measured zero). If a future test asserts
  on an unsettled-output state with a raw-host teardown, the guard will
  catch it the same way.
- No commit/stage/stash/push performed; earlier `wip(...)` commits
  untouched.

## Repair cycle 1 (review r1: B1 blocking, N1, N2)

Fixes, all in tests + test helper; no product line touched, no assertion
weakened or deleted:

- B1: `runner-v2/test/support/windows-job-leftover-guard.ts` —
  `checkNoWindowsJobProcessesLeft` now throws at registration on an empty
  marker list (was: `[]` matched any supervisor from this worktree, so
  `windows-job-supervisor-input.test.ts:45` failed on other runs' live
  supervisors and killed them). `windows-job-supervisor-input.test.ts`
  now scopes to a per-run unique marker
  (`aiboard-px2e-sivin-<8 hex>-`, planted as its own temp root) instead
  of `[]`.
- N1: `findOwned` additionally requires the candidate's parent-PID chain
  to reach the calling test process (`isInOwnProcessTree`). Same-prefix
  supervisors from a concurrent or earlier run of the same file live in a
  different process tree and are excluded. This is the reviewer's
  suggested own-run filter; it subsumes the per-run-prefix alternative
  with no `mkdtemp` churn, so no temp-root prefixes were renamed.
- N2: `listNodeAndPowershell` fails closed — exec failure, empty output,
  unparseable JSON, or a listing missing the calling test process itself
  now throws "could not enumerate processes" instead of returning `[]`
  (which passed vacuously).
- Negative control (new test in `windows-job-supervisor-input.test.ts`):
  a live supervisor under `aiboard-px2e-outside-*` (outside the file's
  markers) is held while the file's own end check runs; the check passes
  and the supervisor is verified alive afterwards (`process.kill(pid, 0)`)
  before orderly `retireOwnedTreeForTests` cleanup.

Prove-red (temp edits, restored byte-exact — sha256 after restore equals
the pre-prove-red baseline: helper
`1e05fe2b8b7761cf845517724143bc4808ed2101bba64355d5ea64cde97722d8`,
test
`f36d8b872c2cbdceef3f068b8d465d6d8eea09d39e67b435cf5fcca597e0cd26`;
a mid-restore hash mismatch caught a duplicated comment, fixed and
re-verified):

- Positive control (new code, supervisor leaked under the file's OWN
  marker): red as required —
  `PX-2e leftover guard: 1 supervisor(s) and 1 Job host(s) ...`,
  recorded, killed, "all leftovers confirmed dead". Confirms the
  parent-PID filter does not blind detection (supervisor ppid chain
  reached the test process).
- B1 repro (helper temp-restored to the old `[]`-matches-worktree
  behaviour, outside supervisor left alive at file end): red as in r1 —
  the guard named the `aiboard-px2e-outside-*` supervisor it does not own
  and killed it (own probe process, allowed). Confirms the old code was
  at fault and the new code removes it.
- Cross-process control (new code): file run 3/3 green while a foreign
  supervisor (pid 18536, `aiboard-px2e-probe-*`, separate tsx process)
  was held alive in the same worktree; verified alive after the run;
  the probe self-retired (`retired`, temp dir gone). Scratch probe lived
  under `%TEMP%` only, removed afterwards.

Validation (impact-based policy): `windows-job-supervisor-input` green
3/3 after restore; `task8-raw-launch-closure` 2/2; `tsc --noEmit` exit 0;
`eslint` on both changed files exit 0; `git diff --check` exit 0. Other
five PX-2e files not re-run (unchanged; their guards only gain a
narrowing conjunction, and the spawn path was validated by the positive
control above).

Notes: `docs/plans/runner-v2-p6-6-EXECUTION.md` named by the controller
does not exist in this worktree, so no entry was made there and no new
ledger was created; the r1 review's two orphan supervisors (pids 61416,
52028, started by the reviewer) were not touched — killing processes
this run did not start is forbidden. Nothing committed, staged, stashed
or pushed.
