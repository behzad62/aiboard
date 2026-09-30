# PX-2e independent review, round 1

- Reviewer: fresh-context review agent (code-reviewer-sonnet), no part in writing PX-2e.
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort.
- Date: 2026-09-30 (runs continued past midnight into 2026-10-01 local time).
- Subject: commit `2dc7ad8c` (`wip(px-2e)`), branch `codex/runner-v2-px1`, the branch head. Worktree clean during review.
- Scope: packet brief `px2e-brief-muse.txt`, worker evidence `PX-2e.md`, background `PX-2c-review-r3.md` N14.

sha256 of the changed files at `2dc7ad8c` (`git show 2dc7ad8c:<path> | sha256sum`):

| File | sha256 |
|---|---|
| `runner-v2/test/support/windows-job-leftover-guard.ts` (new) | `97972b5e77e00dd552cd8f97b8041cdd15d5052f80b6c982e2e8f98d22df4f63` |
| `runner-v2/test/windows-job-fence-effects.test.ts` | `7e81ed7e65f49c8e329abdaaacab9947fb1cd9cb80edcf02db9f598a3d1a3c0e` |
| `runner-v2/test/windows-job-real-host-guarantees.test.ts` | `1a9af46bb64a51ea2d539e7db8db1ca406ad69f0a4c9c4a04483b5ff5dd55770` |
| `runner-v2/test/windows-job-launch-speed.test.ts` | `81c54ae0f01b2ca612cf55c2a9c3ef55ad87c53d1b2e53df1fe810f4baef432d` |
| `runner-v2/test/windows-job-spare-host.test.ts` | `37ea2b4a4d343d5a0d124c382c0e2cdc91908ff068dff40e3dd1e966b8fbbb9b` |
| `runner-v2/test/windows-job-supervisor-input.test.ts` | `e1a462c5a89a92f6f1e7bffe74bf17d7da38c0171f351a5146cc5ab68684ec4a` |
| `runner-v2/test/windows-job-output-replay.test.ts` | `43c9d4a0e460f648a900016df070ba53e0d02c1391d63f8261b503123ac3f841` |

The fence-effects hash equals the hash the worker gave as "restored byte-exact" after its prove-red. So the commit holds the restored file, with no fault left in.

**Verdict: REPAIR — 1 blocking**

The two real leaks are fixed at their cause and the leak table is honest. The shared end check detects real leaks well. One blocking defect: the end check in `windows-job-supervisor-input.test.ts` is worktree-wide, so it fails that file and kills supervisors that another run started.

## Judge results

| # | Question | Result |
|---|---|---|
| 1 | Leak table honest | Yes (measured before and after; see section 1) |
| 2 | Each leak fixed at its cause; product guarantees hold | Yes. No product line changed. |
| 3 | End check sees only its own file's processes; prove-red meaningful | Prove-red is meaningful. Scoping FAILS for one file (B1). |
| 4 | No assertion weakened; tsc, eslint, diff clean; task8 green | Yes |

## 1. Leak table (my own measurements)

Method: every run alone with `--test-concurrency=1`, `NODE_TEST_CONTEXT` unset. After each run I listed node.exe `managed-process-supervisor.mjs` and powershell.exe `managed-process-job-host.ps1` processes whose command line carries this worktree's path (`runner-v2-px1`). Baseline before my first run: 0 from this worktree. The concurrent `runner-v2-p6-6` pipeline had 5 to 17 of its own supervisors the whole time; none was touched or flagged.

Before (the parent version of the fence-effects test, `16648709`):
I copied it to a scratch folder with imports rewritten to this worktree's `src`, and ran it from the worktree root.

| File | Result | Supervisors left | Job hosts left |
|---|---|---|---|
| fence-effects at parent `16648709` (scratch copy) | 35/35 pass | **2** (pids 61416 and 52028, created 00:00:54 and 00:00:55, same parent) | 0 |

This matches N14 and the worker's table: 2 supervisors per run.

After (at `2dc7ad8c`):

| File | Tests | Result | Supervisors left | Job hosts left |
|---|---|---|---|---|
| windows-job-fence-effects | 35 | 35/35 pass, 35 s | 0 | 0 |
| windows-job-supervisor-input | 2 | 2/2 pass | 0 | 0 |
| windows-job-output-replay | 4 | 4/4 pass | 0 | 0 |
| windows-job-launch-speed | 11 | 11/11 pass | 0 | 0 |
| windows-job-real-host-guarantees | 12 | 12/12 pass | 0 | 0 |
| windows-job-spare-host | 19 | 19/19 pass | 0 | 0 |
| task8-raw-launch-closure | 2 | 2/2 pass | n/a (spawns nothing) | n/a |

The other five files' "before = 0" is corroborated: their teardowns are unchanged, and they still leave 0 at head.

## 2. Cause and fix

Probe `probe-leak.mts` (scratch, removed) drives the real host with the exact "unknown" shape (child writes `held` to stderr and exits; interactive; wait for `exited_unknown` with the empty proof):

- Old teardown (plain `signalOwned(SIGKILL)` then `releaseOwned`): both calls throw `Windows Job is exactly empty while retained output remains unsettled.` The supervisor stays alive. The end check found it: `1 supervisor(s) and 0 Job host(s)`, with pid, ppid and the full command line recorded before the kill.
- New teardown (`retireOwnedTreeForTests`: signal, drain with exact ACKs, release): `GUARD: PASS after 561ms`, nothing left.

So the cause is what the worker says: a B4 refusal by design, with nothing ever sending the ACK. The fix follows the designed path (read, exact per-stream ACK, release). It does not kill anything in cleanup and gives the test no new privilege. `git show 2dc7ad8c -- runner-v2/src` is empty, so every product guarantee is byte-identical.

## 3. End check: detection and scoping

Detection works (probes, real host, real supervisor):

- Leak with no teardown, silent child that stays alive: end check found `1 supervisor(s) and 1 Job host(s)`. It recorded both, killed the Job host then the supervisor, and confirmed "all leftovers confirmed dead".
- Supervisor killed by hand: the Job host exits with it (stdin EOF). So there is no orphan-Job-host hole that the parent-PID walk would miss.
- Worktree marker: other worktrees' supervisors (p6-6) were never matched.
- Markers cover every `mkdtemp` prefix in each file and are file-exclusive (`grep` over `runner-v2` and `scripts`: each marker appears in one file only).
- The worker's real-file prove-red (drain replaced by a no-op, file goes red with the record and the kill) is consistent with what my probes show. I could not re-run it on the real file (see section 7).

### B1 (BLOCKING): the `[]` marker makes the supervisor-input check worktree-wide, and it kills other runs' processes

Where:
- `runner-v2/test/windows-job-supervisor-input.test.ts:45` calls `checkNoWindowsJobProcessesLeft([])`.
- `runner-v2/test/support/windows-job-leftover-guard.ts:92`: `if (normalizedMarkers.length === 0) return true;` (any supervisor from this worktree matches).

The brief asks for "tracked by the file's own temp roots or markers, so it never sees other runs". This file spawns nothing real, so it has no root of its own. With no marker it sees every supervisor from the worktree.

Evidence (real, not synthetic): I held a real supervisor plus Job host alive in this worktree (started by my probe, temp root `aiboard-px2e-probe-none-F0oNOs`), then ran the real file:

```
✔ Windows Job supervisor retains exact ownership ... (interactive=true)
✔ Windows Job supervisor retains exact ownership ... (interactive=false)
✖ ...\windows-job-supervisor-input.test.ts (14065ms)
ℹ tests 3  pass 2  fail 1
Error: PX-2e leftover guard: 1 supervisor(s) and 1 Job host(s) started by this file were still alive at file end:
  pid=11440 ... powershell.exe ... managed-process-job-host.ps1
  pid=18992 ... node.exe ... managed-process-supervisor.mjs process_61ed0a0a-... \aiboard-px2e-probe-none-F0oNOs\...
  kill: pid=11440:SIGKILL-sent, pid=18992:SIGKILL-sent
```

The holder's own check then found its supervisor already gone (`pre-guard px1=0`). So this file failed red, and it killed another run's live processes. The same file run alone is green, which is why the worker missed it.

Why it matters: `npm test` in `runner-v2` (`tsx --test test/*.test.ts`, default concurrency), or any handoff or other suite running in the same worktree at the same time, triggers it. The message also says "started by this file", which is false here.

Required repair (any of these; the first two together are the cleanest):
1. Make the helper reject an empty marker list, so no caller can ask for worktree-wide scope.
2. For the fixture-only file, scope to processes that descend from `process.pid` (walk the parent-PID chain to the test process), or to a marker that cannot match another run. Do not match by worktree alone.
3. Prove-red for the repair: with a supervisor from another prefix alive in the same worktree, this file stays green and that supervisor stays alive.

## 4. Assertions, tsc, eslint, diff

- All removed lines in `git show 2dc7ad8c -- runner-v2/test` are the two swallow-everything teardown blocks (replaced by the helper call) and two `import test` lines (replaced by versions that also import `after`). No `assert` line removed or changed.
- `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0 (9 s).
- `eslint` on all 7 changed/added files: exit 0.
- `git diff --check 2dc7ad8c~1 2dc7ad8c`: exit 0.
- task8-raw-launch-closure: 2/2.

## 5. Non-blocking findings

- **N1 (scoping by prefix, not by run).** Markers are prefixes, so the check also matches (a) a concurrent run of the same file in the same worktree, and (b) live leftovers from an earlier run. Effect today: the two supervisors my parent-version measurement left (section 7) will make the next `windows-job-fence-effects` run in this worktree fail red and be killed by its check. Suggest an own-run filter (parent-PID chain to `process.pid` or creation time at or after file start) so the message "started by this file" is true. This also fixes B1.
- **N2 (fail-open enumeration).** `listNodeAndPowershell` returns `[]` on any error (`catch { return []; }`, line 62). Probe: with PATH broken, `checkNoWindowsJobProcessesLeft` returned PASS in 2 ms. A timeout or failure under load (the very condition of the 50-supervisor pile-up) makes the check vacuous. Suggest: throw when enumeration fails or returns no node.exe row (the test process itself is one).
- **N3 (prove-red coverage).** The worker's real-file prove-red covers the "unknown" shape only; the "cursor" attempt went red through an EPERM cleanup failure first. I covered both causes at the shape level with probes, and the whole file is green and leak-free at head. Info only.
- **N4 (product observation, not PX-2e).** By design (B4) a supervisor parks in `exited_unknown` until an exact ACK arrives. If an owner vanishes it has no retire timeout. Outside this packet; worth a separate look at restart recovery.
- **N5 (vacuous guards).** `output-replay` (in-process fake supervisor) and `supervisor-input` (in-VM) start no real processes, so their checks can only act as regression nets. Fine, but B1 shows the danger of widening their scope.

## 6. Follow-ups

1. Repair B1; add the N1 own-run filter and the N2 fail-closed rule in the same pass (small).
2. Re-run `windows-job-supervisor-input` and `windows-job-fence-effects`, each once alone, after the repair. Include the B1 negative control (an other-prefix supervisor alive in the same worktree) as the prove-red.

## 7. What I could not do, and leftovers I left

- My parent-version measurement (scratch copy of `16648709`, section 1) left **2 supervisors alive in this worktree: pids 61416 and 52028** (created 00:00:54 and 00:00:55, parent 33880). I started them, so they are mine. The permission layer refused both my kill and a targeted re-read of them, so I did not retry by another route. **The caller should stop these two pids.** Until then, running `windows-job-fence-effects` or `windows-job-supervisor-input` in this worktree will fail red and have the check kill them (see N1).
- For the same reason I did not re-run the worker's real-file prove-red: that run's check would also have matched and killed those two supervisors. Shape-level probes cover it instead.
- Probe and scratch files (under the session scratchpad `px2e-review`, and one probe temp root) were removed after writing this report. No source or test file was edited, and nothing was committed, staged, stashed or pushed.

## 8. Validation scope and time

Ran, each once alone: all six changed test files (plus a parent-version scratch copy for the "before" number), task8-raw-launch-closure, tsc, eslint on 7 files, `git diff --check`. Probes: old teardown, new teardown (unknown), no teardown (live child with Job host), supervisor-killed, parallel-run false positive, enumeration fail-open. About 25 minutes in total. Did not run: any other suite (per the impact-based policy, since no product file changed).
