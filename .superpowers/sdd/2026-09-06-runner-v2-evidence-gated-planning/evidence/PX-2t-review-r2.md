# PX-2t independent review, round 2

- Reviewer: independent fresh-context reviewer (did not write PX-2t, did not do round 1)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Reviewed at: commit `cb567e62` (PX-2t cycle 0 + repair cycle 1, parent `83f89cf5`), in a detached scratch worktree. Later commits `7a1703e2` (PX-2a), `e8eb8720` (PX-2b), `cd475d57` (PX-2c) were only diffed against the PX-2t test file, not reviewed here.
- Inputs: brief `px2t-brief-muse.txt`; repair brief `px2t-repair1-muse.txt`; plan `2026-09-27-runner-v2-p6-6-architecture-correction.md` (CD-21, PX-2t); round 1 review `PX-2t-review-r1.md`; worker evidence `PX-2t.md` ("Repair cycle 1"); worker red logs in `%TEMP%\px2t-red\` (R1-R9, FULL-green-1/2, SUITES-existing4, MEASURE-quiet-n20); the test file, the measurement script and the product files named below.
- sha256 (full):
  - `runner-v2/test/windows-job-real-host-guarantees.test.ts`, cb567e62: `147a16d71e5c66ff4da83fef0547cded654af28a35cd308835564baf5fdabf30`. HEAD (`cd475d57`): identical.
  - `runner-v2/scripts/measure-git-launch.mts`, cb567e62: `aa5d4f9c940215e1a547c85c028a966f11e93b995dc3ed26d0af0567db82e9b3`. HEAD: `ec0cf2b064a81bddf8a57affa6161272a4ce9e7c57f95a9df66ff3efa832c61a` (see "Later commits" below).
  - `PX-2t.md`, cb567e62 and HEAD: `9106d98b7a18cc04743a6a6bd9841e34be8948f42c6eb5c933551645c1f73196`.
  - `PX-2t-review-r1.md` (input): `bd7d2bee45e78164cae078fb4914382b9516464132df7403ec997d77276d9ab1`.
- Repo effects of this review: none in the px1 worktree except this report (untracked). I edited no source or test file, and I never staged, committed, stashed or pushed. Faults were applied only to a scratch copy. Full checkout of the scratch worktree failed on the long default scratch path (Windows "Filename too long"), so I used a short path under the system temp directory (`...\Temp\pxr2\wt`) with sparse checkout (`runner-v2`, `lib`, root config), `core.autocrlf=false` so bytes match the blobs, and a `node_modules` junction. Every fault run used `TEMP`/`TMP` pointed at my own folder, so any leftover process or directory was attributable to my probes. The scratch worktree is removed with `git worktree remove --force` (junction removed first) at the end.
- Runs of the guarantee file: two full runs on pristine cb567e62 (both 12/12: 102.6 s and 110.7 s, on a loaded machine). Plus single-test runs under faults with `--test-name-pattern` (probes P1-P10 below). These are probes, not full runs.

**Verdict: ACCEPT**

B1, B2 and B4 are resolved with my own fault probes. B3 is resolved in substance (recovery is no longer vacuous) but PARTIAL in labelling and coverage: I count that as a required text fix, not a blocker (N1). All minors are closed except items that were disclosed as not done. No new blocking finding.

## Round 1 findings, status

| # | r1 finding | Status | Evidence (this round) |
|---|---|---|---|
| B1 | T5 never had a live concurrent call when the timeout kill landed | RESOLVED | New T5 (`test.ts:570-608`): the survivor prints at about 9 s, the slow call is killed at 5 s. It asserts the survivor returned AFTER the killed call, `exited`, exit 0, `verified_empty`, stdout exactly `px2t-concurrent-ok\n`. My own fault P1 (different from the worker's): in `windows-job-process-host.ts` `signalOwned`, a kill of one call also POSTs `/signal` to every other unreleased record. Result: RED, "survivor must outlive the kill". Pristine: green in both full runs (T5 10.3 s and 14.1 s). |
| B2 | Empty proof unpinned; root-exits-first never tested on the production path | RESOLVED | (a) New T7b (`:892-1096`) backend-level control. P2, `verifyEmpty` always `{empty:true}`: RED at `test.ts:1002` ("verifyEmpty must report non-empty while the descendant lives", `true !== false`). (b) Release refusal pin: P8 neuters all three stopped-guards in `releaseOwned` (`windows-job-process-host.ts:247-253` and the two inner ones): RED "Missing expected rejection" at `:1016`. (c) New T4 (`:535-562`) production path, root exits at 300 ms, detached TERM-ignoring grandchild: asserts `timed_out`, `verified_empty`, elapsed at least 3.9 s, and the grandchild PID dead within a 2 s grace. P3, supervisor settles on `root_exited` (treats root exit as empty proof): RED (the call fails with `backend_unavailable`). P7, supervisor marks stopped without sending the kill: T4 stays green, because supervisor exit closes the Job host and kill-on-close kills the descendant. That is the second layer working; T4 asserts the guarantee (descendant dead at return), not the mechanism. |
| B3 | T12 did not exercise recovery; G12 overstated | PARTIAL (see N1) | Part A now gives `recover()` real work: a live launch on a second host object. Observed outcome (probe P5, not a fault): `{"subprocess":[{"invocationId":"inv-...","state":"effect_outcome_unresolved"}],...}`. P10, `reconcileStartup` returns `[]`: RED "recovery must report the orphaned live launch (it has work)". P9, the reached branch reports `cleaned` (the fault that stayed green in r1): RED at `:1257`. P5b, replace everything after the pending-effect short-circuit with `cleaned`: GREEN. So the lease/takeover/reconcile branches are not exercised. The labels "orphaned", "reconciled" and "its owner stopped driving it" are wrong (see N1). |
| B4 | Red runs leak infinite TERM-ignoring processes | RESOLVED | Both tree ends self-exit at 90 s (`:305-331`). Tree tests kill identified PIDs in `finally` (`:213-242`). P1, P2, P3, P6, P8, P9, P10 (all assertion or error red paths): zero processes left at run end (checked by path marker and by the tree-script signature). P6 (kill-on-close removed, so the tree really survives host death): red at "tree after Job-host death to die", `finally` killed the marker PID and Job-record PIDs, zero left. P4 (kill never lands, T10 hangs): the test times out at 55 s and cannot reach its `finally`; the run ended at 104 s when the trees self-exited; zero processes left. Residue: a `aiboard-px2t-*` temp root was left after P3, P4 and P6 (EPERM in `after()`); I removed them by hand (N3). |
| M1 | Stray blank CRLF at the end of the script | RESOLVED | Blob ends `;\n}\n`; 0 CR bytes in both new files; `git diff --no-index --check /dev/null <file>` prints no problem for either file. |

## Other r1 follow-ups, status

| # | r1 item | Status | Note |
|---|---|---|---|
| F1 | T7 pins only the first of three identity layers | OPEN, documented | Note added in the file (`:750-753`) and matrix G7. No stale in-flight record test. Acceptable. |
| F2 | Prove-red evidence cannot be re-checked | PARTIAL | Logs R1-R9 now exist in `%TEMP%\px2t-red\` and are cited. R1-R5 line numbers are 7 lines off the committed file (an earlier revision of the test file); R6-R9 match. `faults.cjs` and the backup dir are still in `%TEMP%`, not in the evidence folder. I re-ran T3, T5, T7b, T12 faults on the committed file myself, so the evidence holds. |
| F3 | Matrix rows for fence protocol, bearer token, C# host | RESOLVED | G13 (partial, cite `windows-process-backend.test.ts:2012-2013`, checked by me), G14 (MISSING), G15 (MISSING, unverified), G16 (env, exit code, cwd cited; argv/shims, suspend-resume, release linger MISSING). Cites `process-tools.test.ts:62`, `:115-126` checked. Label typo in G14 (N2). |
| F4 | Tests hard-code today's process model | PARTIAL | Done: record lookup by argv basename; supervisor gate excludes supervisors alive before the file. Still hard-coded, and not marked PX-2c-sensitive: see N4. |
| F5 | Measurement script and numbers | RESOLVED, (c) OPEN | Wrong "command explains the gap" note corrected (machine load). `rev-parse HEAD` sample added. Quantile rule stated in the script. Quiet n=20 log read (UTF-16): quiet 837.9 ms, large 975.0, rev-parse 910.9 (p90 936.9), effects 14/16/16 per call; the evidence says no other test was running; tight spread (829-911) fits that. My smoke run (n=3, loaded machine) printed the same structure: 14/16/16 effects, quiet median 1031.5 ms, repo untouched, temp root removed. Non-full profile still not measured (disclosed). |
| F6 | Assertions looser than claim | RESOLVED | T6 regex tightened (`:634`); T10 deadline 3 s (`:728`); T1 has `timeout: 55_000`. The worker's R8 log shows the tightened T6 rejects "node runs instead of the missing exe" (I did not re-run it). |
| F7 | Host death reported as `exited` | n/a | Product note, still for a later product packet. |
| F8 | 10 s grace after `verified_empty` | RESOLVED | 2 s in T4, T5, T10, T7b. T3 and T12 keep 10 s for kill propagation after host death, with a comment saying why. |
| F9 | Off-Windows | RESOLVED | Evidence states 12 skips and a Windows-only net. I could not run off Windows; the skip paths are `needsJob` (`:244-254`) and the platform check in T7 and T7b. |

## Probes I ran (scratch copy of cb567e62, single test each)

Logs: `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\px2tr2\` (`P1-...P10-...log`, `full1.log`, `full2.log`, `measure-smoke.log`). Each fault restored from a backup; sha256 before equals after for all five faulted source files (`windows-job-process-host.ts` f8f2d9ff9d0b..., `windows-process-backend.ts` a4e489f960de..., `managed-process-supervisor.mjs` 23065907d0cc..., `subprocess-runtime.ts` dbe47a9565e5..., `managed-process-job-host.ps1` 854ecd34f235...), re-checked before the second full run. `one-shot-command-executor.ts` was backed up but never faulted. Hashes are of LF blobs, so they differ from the worker's CRLF-working-copy hashes; that is expected.

| Probe | Fault | Test | Result |
|---|---|---|---|
| P1 | host `signalOwned` also signals every other live record | T5 | RED "survivor must outlive the kill", 19.0 s; no leftovers |
| P2 | backend `verifyEmpty` always empty | T7b | RED at `:1002`, 14.6 s; no leftovers |
| P3 | supervisor settles on `root_exited` | T4 | RED (`backend_unavailable`), 18.3 s; no processes left, temp root residue |
| P4 | backend `signal` never lands (env-gated) | T10 | RED by 55 s timeout; ended at 104 s when trees self-exited; no processes left, temp root residue |
| P5 | none (logging `recover()` output) | T12 | green; outcome `effect_outcome_unresolved` |
| P5b | `reconcileStartup` reports `cleaned` after the pending-effect branch | T12 | GREEN (hole, see N1) |
| P6 | Job created without kill-on-close | T3 | RED "tree after Job-host death to die did not settle"; `finally` cleaned; zero processes; temp root residue |
| P7 | supervisor marks stopped without sending the kill | T4 | green (host-death kill-on-close backstops it) |
| P8 | `releaseOwned`: all three stopped-guards neutered | T7b | RED "Missing expected rejection" at `:1016` |
| P9 | reached recovery branch reports `cleaned` | T12 | RED at `:1257` |
| P10 | `reconcileStartup` returns `[]` | T12 | RED "recovery must report ... (it has work)" |

Other checks: `tsc -p runner-v2/tsconfig.json --noEmit` rc=0 at cb567e62 (with `lib/` in the sparse set); `eslint` on both new files clean; both files LF-only with no whitespace problem. I did not re-run the four existing Windows Job suites (the worker's log shows 116/116; PX-2t changed no product code).

## Later commits (check at HEAD)

- `git diff cb567e62 HEAD -- runner-v2/test/windows-job-real-host-guarantees.test.ts` is empty. No PX-2t test was weakened or deleted by PX-2a, PX-2b or PX-2c. Their evidence files say the file was run unchanged and green (12/12) on their code.
- `measure-git-launch.mts` changed at HEAD only additively (an extra fence-effect counter `claimAndAttachOwnedChannel`, an opt-in `PX2C_SPARE=1` spare mode, and a `spare` field in the output). The default path measures as before.
- The spare is opt-in at HEAD (`spare` option absent by default), so the process model the tests assume is still today's.

## New findings (none blocking)

| # | Finding | Location | Expected | Actual | Fix |
|---|---|---|---|---|---|
| N1 | T12 title, comments and matrix G12 overclaim. The launch is not orphaned and not "reconciled": the same process still drives it, and `reconcileStartup` short-circuits on the in-flight `backend_observe` effect and reports `effect_outcome_unresolved` (`subprocess-runtime.ts:438-444`) without any reconcile or lease step. That is a true fail-closed pin for a crash mid-observe, because the pending-effect check comes before the lease check, so a real crash gives the same report. But everything after that check (lease expiry, takeover, reconcile, kill or report of an orphan) is unexercised (P5b). | `test.ts:1179-1187` (comment and title), `PX-2t.md` matrix G12 and section 7 | Label says what is proven; G12 marked PARTIAL/OPEN | "reconciles a live launch", "orphaned", "owner stopped driving it" | Text only. Rename to "recover() reports an in-flight launch as unresolved, never relaunches or disturbs it, and host death leaves no exit code". Mark G12 PARTIAL: crash takeover and reconcile of an orphan are OPEN on the real host (needs a `leaseDurationMs` seam on `createExecutionHost`, or a kernel-level test). Give the residual an owner (PX-2b/PX-2c lifecycle tests). |
| N2 | Evidence text nits | `PX-2t.md` | Accurate | G14 row reads "Supervisor Bearer [REDACTED]" (garbled label, should be "bearer token"). Section 7 gives 1326 lines for the test file and 217 for the script; the committed blobs are 1369 and 228 lines (the sha256 values are right). | Fix the words and counts. |
| N3 | Red-run noise and residue | T3, T7b, T4/T10 hang shape | Clean failure | An early assertion failure leaves the `observed` promise (T7b) or the pending call (T3) to reject after the test ended: node prints "generated asynchronous activity after the test ended" (unhandledRejection). Hang and no-kill-on-close shapes leave the `aiboard-px2t-*` temp root (EPERM in `after()` while the Job-host powershell still holds its cwd). No process is left. | Add a no-op `.catch` to the un-awaited promises; retry `rmSync` with `maxRetries` in `after()`. |
| N4 | Lines still tied to today's process model (not marked PX-2c-sensitive) | T1 `:473-475` (exact Job record count); T12 `:1262-1263` (record files and supervisor list `deepEqual`), `:1272-1273` (waits for the supervisor to die, 20 s); T3 and T12 Part B find the Job host as a child named `powershell.exe` (`:347-365`); `assertNoLiveSupervisors` only excludes supervisors alive BEFORE the file, so an `autoRefresh` spare started mid-file would look like a leak; T4 pins `timed_out` and elapsed at least the deadline (today's settle policy for a root that exits with descendants alive) | The guarantee, not the mechanism | Mechanism pinned in these places | Mark these lines PX-2c/PX-2b-sensitive in comments, or loosen them (for example, allow `spare`-marked records). The claim "a PX-2c pre-started spare needs no net edit" holds only for a spare started before the file. |
| N5 | Timing margin | T12 (25-37 s of a 55 s budget), T5 (5 s deadline includes launch and PowerShell compile) | Stable under load | Green in all my full and single runs under other reviewers' load; no flake seen. Margin is thinner in T12. | If load flakes appear, raise T12's timeout toward 80 s (the trees self-exit at 90 s) and give T5 an 8 s deadline with a 12 s survivor. |
| N6 | Cleanup kills recorded PIDs guarded only by `processAlive` | `killIdentifiedPids` `:202-211` | Verify identity before a kill | A recorded PID that died and was reused could be killed. Measured here: 80 sequential spawns never reused a PID, so the risk is low today. | Check image name or start time against the Job record before `process.kill`. |
| N7 | T9 prove-red is indirect (unchanged from r1 F2) | evidence section 3 | A call-swap fault | The fault swaps stdout and stderr inside one call | Add a two-call swap fault when PX-2c touches output routing. |

## Answers to the round 2 questions

1. **B1-B4 and minors resolved?** B1, B2, B4, M1 yes, with my own faults. B3 in substance (P9 and P10 red; the r1 "cleaned" fault is now red) but not in labelling or breadth (N1).
2. **T7b and T4 prove what they claim?** T7b: yes. It pins non-empty while a descendant lives, `observe` pending, refusal of `release` (message "not verified terminal") and exact-empty release after the kill, using a fresh backend instance for the refused launch (the refused lane closes by design). It is red under both faults (P2, P8). T4: yes for the guarantee (root exits, descendant killed, `verified_empty`, PID dead in 2 s). It also pins today's settle policy (N4).
3. **Matrix rows for fence protocol, bearer token, C# host?** Added as G13-G16 with cites or MISSING. Cites checked. Label typo in G14 (N2).
4. **Tests that hard-code today's process model?** Yes, several (N4). None is edited by PX-2a/b/c at HEAD, and the spare is opt-in at HEAD, so nothing broke yet.
5. **Measurement script LF and quiet numbers?** LF fixed. Quiet numbers recorded (837.9 / 975.0 / 910.9 ms, n=20, 14/16/16 effects). Script runs and writes nothing to the repo.

## Follow-up list (not blocking; the text items are cheap and should be done at merge)

1. Text fix for N1 (rename T12 title and comments, mark G12 PARTIAL with the reason and an owner) and N2 (G14 label, line counts).
2. N4: mark or loosen the PX-2c-sensitive lines; state in the file which asserts a spare-default change must revisit.
3. N3: add `.catch` guards and retry the temp-root removal, so a red run reports its own assertion and leaves no directory.
4. Copy `faults.cjs`, the backup sources and the R1-R9 logs from `%TEMP%\px2t-red\` into the evidence folder (F2), because `%TEMP%` is volatile.
5. N6: verify process identity before a cleanup kill.
6. A real crash-recovery test once `createExecutionHost` can take a short `leaseDurationMs` (or as a kernel-level test): lease expiry, takeover, reconcile of a live orphan, kill or report.
7. F1: a production-path test that edits `startedAt` in an in-flight Job record and expects a fail-closed call.
8. Non-full permission profile in the measurement script (F5c).
9. Product note (F7): report a distinct outcome for "Job host died before reporting an exit". Today it is `exited` + `verified_empty` with no exit code.

## What I did not do

- I did not re-run the four existing Windows Job suites or the other suites in the worker's table.
- I did not run off Windows, so the skip paths are read, not run.
- I did not build a real runner-crash test (N1 explains why the report would equal Part A's for a crash mid-observe, and why the later branches need a lease seam).
- I did not re-run the worker's R2, R5, R8, R9 faults. I re-ran the R1 shape (P1), R3/R4 (P2/P8), R6 (P10), R7 (P6) and R9-like (P4) with my own variants.

**Verdict: ACCEPT**

Summary: the safety net now catches the PX-2b and PX-2c hazards r1 named (kill of one call hitting another, an always-true empty proof, a root that exits first, a release while the Job is not empty). Red runs leave no process. One labelling problem remains on T12/G12 (text-only), plus non-blocking follow-ups above.
