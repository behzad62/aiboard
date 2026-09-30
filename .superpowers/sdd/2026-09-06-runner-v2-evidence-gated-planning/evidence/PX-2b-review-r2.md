# PX-2b independent review, round 2

- Reviewer: independent fresh-context reviewer (did not write PX-2b, did not do round 1).
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort.
- Date: 2026-09-30.
- Reviewed at: commit `6a581f66` ("wip(px-2b-r1)", parent `1daf1b89`) in a detached scratch worktree. PX-2b itself is `e8eb8720`; PX-2c (`cd475d57`) and the PX-2a repairs sit between them and were not reviewed here.
- Inputs: round-1 review `PX-2b-review-r1.md`; repair brief `px2b-repair1-muse.txt`; worker evidence `PX-2b.md` ("Repair cycle 1"); the product diff `git show 6a581f66`; the three changed source files and the two changed test files read in full; round-1 probes (`px2br1\probes`) re-run against the repaired code.
- sha256 of the changed files at `6a581f66` (git blob bytes, LF; the working-copy hashes in `PX-2b.md` are CRLF and will not match):
  - `runner-v2/src/managed-process-supervisor.mjs`: `34af3800f505899f7ffc287690d1abc6e85ab4ac2cc755528f2ae8e99cc2eea9`
  - `runner-v2/src/windows-job-process-channel.ts`: `c0e3721a3198f0008ce0d32e92d38a27885e93db4f8982385d10010deadcbd03`
  - `runner-v2/src/windows-job-process-host.ts`: `1a17ecebbcd8ff0c4e8488eb8c664dda02e5e0d25b0501913e6b14f32c210dc0`
  - `runner-v2/test/windows-job-fence-effects.test.ts`: `d32760646355ad41a2c87065ce1dc20beaf58337e4b72081c00222a9976b730c`
  - `runner-v2/test/windows-process-backend.test.ts`: `24d4a05279a1cbfc8e70a668c294fccc1180c33df20566a3ab9eb737bf8710a7`
  - `PX-2b.md`: `f188b512d59fc70dc2d99b473bf71a360aab4364ff62b3ee051526ced4dfd325`
  - Files this repair did not touch (`git diff 1daf1b89 6a581f66` is empty for each): `windows-job-real-host-guarantees.test.ts` `03c904af6dfab5bf10ee12f5412a31c09432e2af2bf7a55484877c4c9763402f`; `windows-job-launch-speed.test.ts` `97277e9118f9ab98258c352cf94197e5f7515e20911c7b6a8585ed0bd8f53c01`; also `managed-process-job-host.ps1`, `windows-job-spare-host.test.ts`, `task8-raw-launch-closure.test.ts`, `measure-git-launch.mts`.
- Repo effects: none, except this report. I edited no source or test file in the px1 worktree and ran nothing there (only `git show` and `git diff`). All faults and probes ran in detached scratch worktrees under `C:\Users\b_a_s\AppData\Local\Temp\px2br2\` (short `TEMP` = `px2br2t`). Every fault was applied by a script that saved the original bytes and restored them; the sha256 of the restored file equalled the original after every one of the 19 fault runs (`faults-all.log`). Cleanup: the four `node_modules` junctions were removed with `cmd /c rmdir` first, the links were confirmed gone and the shared `runner-v2-p6-6\node_modules\eslint` and `tsx` were confirmed present, then the worktrees were removed and the temp folders deleted (no reparse points inside, checked). My runs leaked 63 `managed-process-supervisor.mjs` processes (from faulted or aborted tests); I stopped exactly those whose command line pointed into my scratch worktree. One unrelated `node -e process.on('SIGTERM'...)` process from 15:06 is not mine and was left alone.
- Machine note: the machine was loaded (the Muse worker and other reviewers were running). I do not judge absolute timings.

**Verdict: ACCEPT**

All four blocking findings of round 1 are resolved with evidence. Nothing weakens the fence protocol, the re-attestation, the audit facts or crash recovery, and the repair adds no fence effect. Seven non-blocking follow-ups remain. The two closest to blocking are: the B4 product fix has no test that fails without it (N-r2-2), and the wait cursor is not plumbed into the only production caller (N-r2-1).

## Round-1 findings status

| # | Round-1 finding | Status | Evidence |
|---|---|---|---|
| B1 | Startup wait loses a status write between read and `fs.watch` | Resolved | Round-1 probe A re-run 3 times against the repaired code: 0 stalls in 242 trials each (round 1: 24 of 242). The watch is now armed before the read, each park is capped at 250 ms, and a `watch()` failure falls back to the same short tick. The new sweep test (`keeps no lost wakeup under a write sweep`) turns red under the full pre-fix shape (fault B1full: 5116 ms). Caveats in N-r2-4. |
| B2 | New tests blind to F1-F7 | Resolved | Each of F1-F7 now turns a test red (table below). Two limits: F7 is a source-text pin (N-r2-3), and the in-fence release guard cannot be pinned (N-r2-5). |
| B3 | `detach()` does not cancel the in-flight wait | Resolved | Round-1 probe B re-run twice (8 samples each): detach to settled 11-34 ms (round 1: PX-2b 452-1006 ms; PX-2a 19-64 ms). Fault B3 (drop the detach notify): the real-supervisor test goes red at 2178 ms (bound 250 ms) and the fake test hangs until the 60 s `--test-timeout` I set in the harness (the file itself sets no per-test timeout there). |
| B4 | Backend batch red; refused release latches the control lane | Resolved | Product fix: `releaseOwned` now throws `process_output_unsettled_terminal` when the status is `exited_unknown`, not released, with retained output, before the empty proof lands. The backend already unlatches the lane for that code, so a too-early release no longer latches it. Test side: only the two wait conditions changed (they now also wait for `jobEmptyProof === true`); the diff of `windows-process-backend.test.ts` is 8 lines and touches no assertion. Batch (`--test-concurrency=4`, 10 files) 3 runs: 233 pass, 1 fail, 1 skip each; the one fail is `task8-raw-launch-closure` on the 5 PX-2c lines. The two tests: 0 failures in 37 isolated runs (both tests together per run, so 37 each). Deterministic probe below. |
| N1 | Terminal birth check compares with the snapshot, not the binding | Resolved | The check now compares with both the attach snapshot and `binding.startedAt` (`bindingStartedAt`). Faults F1a (drop the snapshot leg) and F1b (drop the binding leg) each turn a test red; the two tests are built so that only the leg under test can reject. The binding-compare count change (5 to 3, plus one snapshot compare) is recorded in `PX-2b.md`. The original section 2 C1 text still says the snapshot is taken after the acquire reattest (see N-r2-6). |
| N2 | `/wait-status` has no change cursor | Partly | The endpoint accepts `since=<updatedAt>` and returns at once on any change (fault N2 turns a test red; a fresh cursor parks). The only production caller (the channel) never passes the caller's last-seen state; the host defaults the cursor to the file state at wait start. So round-1 probe G still parks at host level (N-r2-1). Non-blocking, as in round 1. |
| N3 | `exited_unknown` is not final | Resolved | Only `stopped` returns at once. Fault N3 (restore `exited_unknown` to the immediate branch) turns two tests red. Probe C (3 s lingering descendant): 42 and 46 effects at the repaired commit, 45 and 43 at the parent, 46 and 46 at PX-2a. No spin regression, no gain either. |
| N4 | No crash-between test for the fused claim+attach | Resolved | New test `fused claim+attach failure between halves keeps the fence upgrade` (non-interactive record, token 2, attach half throws, a new host instance rejects token 1 and accepts token 2). Same shape as round-1 probe H. |
| N5 | Test-quality details | Mostly | A2 now upgrades first so token 1 is a real stale token; E1 checks the old fence through the fused method; channel-fallback tests added (no `waitOwnedStatusChange`, old-supervisor 404). Still no committed old-record replay test; I ran probe E instead (passes, below). |
| N6 | Hygiene | Partly | Stray indents fixed; a missing `timeoutMs` now means 1 s (fault N6 turns a test red at 614 ms). `PX-2b.md` still ends with a blank line, although the evidence says it was removed: `git diff --check 7a1703e2 6a581f66` reports `PX-2b.md:488: new blank line at EOF`. Against the parent commit the check is clean. |
| N7 | One speed-file failure | Note only | No 4-test speed failure recurred. A different speed-file test flaked (N-r2-7); it does not depend on this repair. |
| flaky | `px2b: fused fence upgrade is durable across host instances` fails in whole-file runs | Resolved at cause | The recorded failure (`PX-2a-review-r2.md` N-r2-7) is `process_control_unavailable ... not verified terminal` at `releaseOwned`: the old test released right after launching `process.exit(0)` without waiting for terminal, and release requires terminal by design. E1 now polls `reconcileOwned` to stopped+released (bounded, 20 s) before it releases. Whole file: 8 of 8 green (1 + 7 runs). See the limit on what I could reproduce below. |

### F1-F7 (fault campaign on the pristine `6a581f66` tree)

Each fault edits one construct, runs the whole new test file (35 tests), then restores. Restore sha equalled the original every time.

| Fault | Edit | Test that turns red |
|---|---|---|
| F1a | delete `terminal.startedAt !== this.attachedStartedAt` | `rejects a birth the attach snapshot never saw` |
| F1b | delete the `bindingStartedAt` leg | `rejects a birth outside the binding` |
| F2 | delete the `processId` predicate | `rejects a foreign processId` |
| F3 | delete `status !== "stopped"` | `rejects a non-stopped terminal` |
| F4 | delete `!ownershipReleased` | `rejects an unreleased terminal` |
| F5 | delete `await authority.reattest()` in the fused acquire | `fused acquire withholds the channel when reattest fails` |
| F6 | delete the `settleStatusWaiters()` call | `supervisor wait wakes on a persist before its timeout` (5523 ms against a 4 s bound) |
| F7 | `if (status.status === "stopped")` to `if (false)` | `supervisor wait returns landed stopped immediately` (source-text pin) |
| N3 | restore `exited_unknown` to the immediate branch | the F7 pin and `parks while the outcome is unknown` |
| N2 | disable the `since` branch | `returns at once on a stale change cursor` |
| N6 | disable the missing-timeout default | `defaults a missing timeout` |
| B3 | delete the detach notify | `detach settles a live terminal wait promptly` and `detach cancels a parked terminal wait` (the second one hangs until the harness `--test-timeout`) |
| B1full | pre-fix shape: read then arm, park the whole remaining deadline | `keeps no lost wakeup under a write sweep` |
| Bwatchfail | `waitForFileActivity` falls back to the whole timeout when `watch()` throws | `falls back to a short tick when unwatchable` |

Faults that stay green (each is a limit, not a regression; see the findings): F7hollow (keep the `if` header, delete its body), B1tick (uncap only the park), B1noarmfirst (read before arming only), B4prod (revert the release branch), F8releaseguard (delete the in-fence `final` status check).

### B4: deterministic evidence for the product fix

Round 1 named the state exactly: root exited, empty proof not yet set, retained output held. I reproduced that state on purpose with a probe (a root that writes to stdout and exits while a descendant stays alive), then called `backend.release` and then `backend.signal` on the same backend:

- Repaired code: release rejects with `process_output_unsettled_terminal` ("terminal outcome is pending while retained output remains unsettled"); the lane is usable (`signal` accepted).
- Same code with the new release branch reverted (fault B4prod): in the run that hit the non-empty state, release rejects with `process_control_unavailable` ("not verified terminal") and the next control call fails with "Windows Job control was requested while release is pending". That is exactly the round-1 failure.
- The descendant did not always survive in my probe (the job emptied by itself in about 4 of 6 no-observe runs; that variant lands on the older `throwIfTerminalOutputPending` branch instead, with the empty proof set). So this probe shows the mechanism and the fix, but it is not stable enough to commit as a test.
- The fix is a refusal made before any release effect ran, so unlatching the lane cannot skip a step: a later release re-verifies every predicate. The choice (refused release no longer latches) is sound. The alternative in the brief (release waits for the proof) would change release's contract, so I agree with the worker's reasoning.

Controls that could not discriminate: with the round-1 test wait conditions and the product branch reverted (the round-1 state), the pair passed 40 of 40 isolated runs and the batch passed 3 of 3. The race did not fire on my machine today (round 1 saw 4/37 isolated and 3/3 red batches). So my stability numbers show the final code is stable; they do not by themselves show the product fix removes the race. The probe above does.

## Answers to the review questions

**1. B1-B4.** Resolved, with the evidence above. No assertion in `windows-process-backend.test.ts` was removed or weakened; both wait conditions are stricter (they wait for the state the release needs).

**2. N1-N7 and the flaky test.** See the table. N2 is partly done and N6 has one leftover; both are non-blocking.

**3. No weakening.** Checked one by one:

- The terminal proof gained a comparison (snapshot and binding) and lost none.
- The acquire order is unchanged from round 1 (fused effect, then reattest, channel withheld if reattest throws); fault F5 now proves the withhold.
- Release: every predicate still refuses; only the error code and the lane state change for one refused state. No tombstone is written on a refusal.
- `/wait-status`: same Bearer gate, per call, read-only, outside the fence lock, clamped 1-5000 ms. `since` is only compared as a string.
- `exited_unknown` now parks instead of returning at once (less eager, not less strict).
- No durable schema, host record field or supervisor status field changed.
- Old records: probe E. Records launched by the PX-2a code (supervisor without `/wait-status`) and by the PX-2b-before-repair code were both taken over at fence token 2 by the repaired code. Observe returned `exited`/0 with `old-ok\n`, verifyEmpty was empty, release succeeded. For the PX-2a supervisor the wait threw `HTTP 404` and the channel fell back to its timed delay.
- The repair also edited `waitForSpareReadyStatus` (PX-2c code) with the same arm-then-read shape. The spare-host tests are green.

**4. Guarantee, speed and spare files, and task8.** Second full run: `windows-job-real-host-guarantees` + `windows-job-launch-speed` + `windows-job-spare-host` 31 of 31 pass. First run: 30 of 31 (the failure is N-r2-7, unrelated). `task8-raw-launch-closure` fails on exactly the 5 PX-2c lines (`retireSpare` x2, `startSpare`, `sweepRetiredSpareRecords`, and the `process.kill` at `windows-job-process-host.ts:396`, inside the PX-2c crash-recovery block), in all 3 batch runs; nothing else, and the repair adds no spawn or kill. Same status as before the repair.

**5. Fence effects per call.** The repair adds none. `measure-git-launch.mts` n=5 (effect counts only): quiet 11 at `e8eb8720`, `1daf1b89` and `6a581f66` alike (launch 1, reconcile 5, read 3, release 1, fused claim+attach 1, plain attach 0). Large output and rev-parse: 14 at all three commits on this machine (one more drain read than in round 1, which saw 13 at `e8eb8720`). The 13 to 14 difference is read-count timing, identical before and after the repair, so I do not count it as a change. I did not re-run the n=20 timing.

## New findings (all non-blocking)

| # | Finding | Evidence | Fix |
|---|---|---|---|
| N-r2-1 | The change cursor is not plumbed into the production caller. The channel calls `waitOwnedStatusChange` with no cursor, so the host uses the file state at wait start. A non-final change that lands between the caller's last read and the wait start is still not reported. | Probe G2 (real host, output persisted at about 1.0 s, wait started at 1.6 s): `hostWaitNoCursorMs` 1506; with an explicit caller cursor 2 ms. Impact stays bounded: 1 s per wait, capped by the settle deadline; the 25 ms drain timer still delivers output; `stopped` returns at once. | Let `reattest`/`reconcileOwned` results carry `updatedAt` and pass it as `sinceUpdatedAt` from the channel. |
| N-r2-2 | The B4 product branch has no test that fails without it. | Fault B4prod (revert the branch): whole new file 35/35 green; the two backend tests 2/2 green (they wait for the empty proof now, so they never reach the branch). The behavior is shown only by my probe. | Add a host-level pin for `exited_unknown` + not released + retained output + no proof: release must throw `process_output_unsettled_terminal` and the lane must stay usable. A stub status file or a stub supervisor can hold that state without a live descendant. |
| N-r2-3 | The F7 pin reads the supervisor source text. It goes red on the round-1 fault (delete or disable the branch, restore `exited_unknown`), but a fault that keeps the `if` header and hollows the body stays green. | Fault F7hollow: 35/35 green. The worker's argument that the branch is not reachable from a live request is sound (a stopped supervisor closes its server in the same tick), so a behavioral test may not exist. | Keep the pin; consider tightening it to check the `json(...)`/`return` inside the block. |
| N-r2-4 | B1 tests pin the original defect, not each part of the fix. The `watch()`-failure test drives `waitForFileActivity`, which no production code calls any more (production waits use `armFileWatch`). Reverting only the arm order, or only the 250 ms cap, stays green (each alone is bounded to about 250 ms or needs a dropped event). | Faults B1tick and B1noarmfirst: 35/35 green each. `grep waitForFileActivity runner-v2/src`: definition only. | Delete `waitForFileActivity` (and its three tests) or make production use it; add a test for the production wait with a failing `watch()`. |
| N-r2-5 | The in-fence release `final` status check is not pinned by any test and cannot be. `authenticatedStatus` already refuses every state that check would catch (live supervisor: live `/status` wins; dead supervisor: transport error unless the durable line is stopped+released). The worker disclosed this. | Fault F8releaseguard: 35/35 green. The release-guard test still pins the system property (a newer fence or a flipped status after the pre-checks is refused, no tombstone). | Keep as defense in depth. Say so in the code comment. |
| N-r2-6 | Stale statements remain in the body of `PX-2b.md`: section 2 C1 ("the snapshot is taken after the acquire reattest"), the section 6 flake note ("no code changed") and the 14/14 row. The appended "Repair cycle 1" is correct and supersedes them. The EOF blank line is still there (N6). | `git show 6a581f66:...PX-2b.md`, lines 80 and about 260-300; file ends `\n\n`. | Correct or strike the stale lines; drop the blank line. |
| N-r2-7 | A speed-file test flakes and is outside this repair: `launch-speed: direct Job host falls back on missing type, load error, and missing file` (the direct PowerShell Job host wrote no stdout). Failures: 1 of 15 at `6a581f66`, 3 of 15 at the parent `1daf1b89`, and once in my first guard run. The test, `managed-process-job-host.ps1` and the speed file are byte-identical between the two commits. | Loops of that test alone, 15 runs each. | Forward to the PX-2a lane. |

## Not reproduced

- The whole-file flake of `fused fence upgrade is durable` did not fire for me at `e8eb8720` (4 of 4 whole-file runs green) or with the old E1 shape (12 of 12 in a probe, 40 of 40 under 8-way parallel load). The cause rests on the failure message recorded by the PX-2a round-2 reviewer plus the mechanism (release requires terminal). I could not see the failure again.

## Probes run

Scripts and key logs: `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\px2br2\` (`probes\`, `logs\`). The scratch worktrees and system-temp fixtures are removed.

| Probe | What | Result |
|---|---|---|
| Suite 1 | New test file, `--test-concurrency=1`, short TEMP | 35/35 (35 s) |
| Whole file x7 | Same, 7 more runs | 35/35 each; `e1 stopped-settle polls: 1` each |
| A | Round-1 startup sweep, 242 trials, 3 runs | 0 stalls each |
| B | Round-1 detach probe, 2 x 8 samples | 11-34 ms |
| B4 branch | Root exited, descendant alive, retained output; release then signal | repaired: unsettled code, lane usable; branch reverted: `process_control_unavailable`, lane latched |
| Faults | 14 faults + 5 controls listed above | see table; every restore sha equal |
| Batch x3 | 10 files, `--test-concurrency=4` | 235 tests: 233 pass, 1 fail (task8, PX-2c lines), 1 skip, each run |
| B4 pair | Both B4 tests, 37 isolated runs | 0 failures |
| Controls | Round-1 test waits, repaired product and reverted product; 40 isolated + 3 batch each | 0 failures in all (race did not fire) |
| Guards | real-host-guarantees + launch-speed + spare-host, twice | 30/31 (N-r2-7), then 31/31 |
| E | Old PX-2a and pre-repair records, repaired code takes over | works both ways; 404 falls back |
| G2 | Host wait after a non-terminal change | 1506 ms no cursor; 2 ms with cursor |
| C | Lingering descendant, effect counts | 42/46 (repaired), 45/43 (parent), 46/46 (PX-2a) |
| Measure | `measure-git-launch.mts` n=5, three commits | 11 / 14 / 14 at all three |
| tsc, eslint, diff check | changed files | tsc clean; eslint clean; `git diff --check` clean against the parent, one EOF blank line in `PX-2b.md` against `7a1703e2` |

## Follow-up list

1. N-r2-2: add the pin for the B4 product branch.
2. N-r2-1: plumb the caller cursor from the channel.
3. N-r2-4: remove or use `waitForFileActivity`; test the production watch-failure path.
4. N-r2-6: fix the stale statements and the EOF blank line in `PX-2b.md`.
5. N-r2-3 and N-r2-5: leave as documented limits; tighten the F7 pin if cheap.
6. N-r2-7: send the direct-host speed-test flake to the PX-2a lane.
7. Still open from round 1: measure the interactive streaming path once (`interactive: true`), and commit an old-record replay test.

## What I did not do

- I did not re-run the n=20 timing measurement (loaded machine).
- I did not review PX-2c, PX-2t or the PX-2a repairs beyond checking that the files this repair did not touch stayed byte-identical.
- I did not test off Windows.
- I could not reproduce the round-1 batch failure or the whole-file flake in my environment (see "Not reproduced"); acceptance of B4 and the flake fix rests on the deterministic state probe, the recorded failure messages and the stability runs of the final code.

**Verdict: ACCEPT**

Summary: The repair resolves B1-B4. Startup wait: 0 stalls in 242 trials three times. Detach: 11-34 ms. Each of F1-F7 now turns a test red (F7 through a source-text pin). B4: the product fix is real (a refused early release no longer latches the lane, shown by a deterministic probe), and the two tests only changed their wait conditions; the batch is green 3 of 3 apart from task8's PX-2c lines and the pair had 0 failures in 37 runs. The flaky whole-file test is fixed at its cause (release before terminal). No protocol weakening, no new fence effects (11 quiet; 14 large and rev-parse at all three commits on this machine). Seven non-blocking follow-ups, chiefly a missing pin for the B4 product branch and the wait cursor not reaching the channel.
