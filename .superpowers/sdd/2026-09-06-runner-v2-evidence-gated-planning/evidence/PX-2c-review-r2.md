# PX-2c independent review, round 2

- Reviewer: independent fresh-context reviewer (did not write PX-2c, did not do round 1)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Packet: PX-2c repair cycle 1, commit `54f15b17` ("wip(px-2c-r1)"), branch `codex/runner-v2-px1`. Reviewed in a detached scratch worktree at that commit (`%TEMP%\px2cr2\wt`).
- Inputs: round-1 review `PX-2c-review-r1.md`; brief `px2c-repair1-muse.txt`; evidence `PX-2c.md` ("Repair cycle 1", section 8); the full commit diff (`git show 54f15b17`); the code and tests at that commit.
- Repo effects of this review: none. No source or test file edited, staged, committed or stashed in any real checkout. In the scratch worktree I only added probe scripts under `px2cr2-probes\` (no tracked file changed). One permission-classifier denial: I tried to add a "leaking call supervisor" fault to the supervisor in the scratch worktree for the N4 leak-gate probe. It was denied ("Auto-Mode Bypass"). I did not retry it, did not use a `git archive` copy, and did not work around it. I judged the leak gate with a fault-free probe on real records instead (see N4 below).
- Cleanup: junction removed first with `cmd /c rmdir`; `Test-Path` confirmed the link gone and `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6\node_modules\eslint` still present; then `git worktree remove --force`. Probe temp dirs deleted. Every leftover supervisor from my host-level probes was killed by PID (all had my scratch path in their command line). No process of mine is left.

sha256 of the changed files, as git blobs at `54f15b17` (LF):

| File | sha256 |
|---|---|
| runner-v2/src/managed-process-supervisor.mjs | `f82a6f68bd5faaee402706ed9eb6483fb8cdac7afb65079f2a0b822d2bccffe2` |
| runner-v2/src/windows-job-process-host.ts | `722d1bbf31dff935bc4e2e99eae4f3f1bf006e7f7365bcdd85ae8c36aa6dc72e` |
| runner-v2/src/execution-host.ts | `1643ea8f3b6eb5e2d2e0775f1036e46582e8e89050fafd71aa0aa6dd72944d95` |
| runner-v2/test/task8-raw-launch-closure.test.ts | `3d46774ce74af21e525de3a170480e5c49309323cb72f6012be091684268fad1` |
| runner-v2/test/windows-job-real-host-guarantees.test.ts | `d1b0644d80b831177faa4a2e6b8f010defb0c2745addc0e3497ab3d8cedb9dc7` (matches the `d1b0644d…` restore hash in the evidence) |
| runner-v2/test/windows-job-spare-host.test.ts | `3b3a3d7298fc50bd6fb6085890ace799db431a5e3a4fc76e907680a9911053fc` |

Unchanged in the repair: `runner-v2/scripts/measure-git-launch.mts` (`ec0cf2b0…`), `runner-v2/test/fixtures/px2c-spare-parent.mts` (`0c42ab21…`).

**Verdict: REPAIR — 2 blocking**

The two round-1 blockers are fixed as reported. B1: a planted or PID-reuse record no longer kills anything, and the only PID kill is one audited helper. B2: the Task 8 suite is green. But the repair introduced one containment regression and left one round-1 fix as a false claim. N1: a runner crash inside the claim window now leaves the call's whole tree running with no owner (round 1 saw it killed). N2: the M2 "fix" is swallowed by two catch blocks, and a probe shows the command running twice.

## Test and suite results at 54f15b17

Machine was shared (the controller ran tests in the px1 worktree). I judge by pass/fail.

| Check | Result |
|---|---|
| `task8-raw-launch-closure.test.ts` (conc 1) | 2/2 pass. Fully green. |
| `windows-job-spare-host.test.ts` (16 tests, conc 1) | 16/16 pass, 126 s |
| `windows-job-real-host-guarantees.test.ts`, spare OFF (conc 1) | 12/12 pass |
| same file, spare ON (`PX2C_SPARE_ON=1`) | 12/12 pass |
| `windows-job-fence-effects.test.ts` (PX-2b) + `windows-job-launch-speed.test.ts`, conc 1 | 45/45 pass (speed T1 green on this run) |
| 11-file batch, conc 4 (windows-process-backend, output-replay, supervisor-input, one-shot-command-family-production-matrix, execution-host, subprocess-runtime, durable-process-store, static-adapter-policy, process-channel, terminal-observation, cleanup-bootstrap) | 261 tests, 259 pass, 1 skipped (pre-existing), 1 fail: `windows-process-backend.test.ts:1844` "launch rollback authenticates force termination at the real live supervisor seam" (`Cannot release ownership after supervisor birth changed`). It uses the portable backend, not the Job host, and PX-2c does not touch that file or path. Passes alone (1/1) and the whole file alone is 96/96. Load flake, same family as the one PX-2c evidence and PX-2b already recorded in that file. |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| eslint on the six touched src/test files | clean |
| `git diff --check 6a581f66 54f15b17` | clean |

I did not re-run `measure-git-launch.mts` (script untouched; the evidence's claim accounting of 60 claims and 0 fallbacks is not re-verified by me). The worker's prove-reds were not re-run (see "What I could not do").

## Round-1 findings: status

| r1 | Status at 54f15b17 | Notes |
|---|---|---|
| B1 blind PID kill | **Fixed** for the reported defect | One `process.kill` in the file, inside `killVerifiedSpareSupervisor` (`windows-job-process-host.ts:1509-1534`). It needs both a durable status file that names this pair AND an authenticated live `GET /status` with the record token whose identity matches. Otherwise it returns `skipped` and the caller only drops the record. Probes below. Two residuals: N1 (regression) and N4 (info). |
| B2 task8 raw launches | **Fixed** | 2/2 green. Homes follow round 1: supervisor `retireSpare` now goes through `stopOwnedTree` (no new site); the host's redundant `entry.launcher.kill` is deleted; one shared `spawnSupervisorProcess()` for `launchOwned` and `startSpare`; one audited kill helper. Allowlist diff: 1 rename (`launchOwned` to `spawnSupervisorProcess`, forced because the suite needs every entry exact) plus 1 new entry with a reason. The brief said at most one entry; the rename is disclosed in the evidence and is fair. The three PX-2a lines are already gone at this commit. |
| M1 no bootstrap / re-provision | Not done, recorded | Reason (opt-in, no production path, belongs with the enablement decision) is acceptable now. Still required before default-on. |
| M2 post-ack fallback can re-run | **NOT fixed. The evidence says "fixed".** | See N2. Reproduced: the command ran twice. |
| M3 run-scoped retire/sweep, claim mark | **Fixed** | `retireSpare({runId})` retires only its own spare. Probe: `retireSpare({runId:"runB"})` left run A's spare alive with its record; `retireSpare({runId:"runA"})` removed both. The claim window is marked `spareClaimInFlight` before the IPC claim; the sweep skips it. No test pins scoped retire (a small gap). |
| M4 test gaps | **Fixed** | New S8 (idle timeout), S9 (pre-claim POST refused on all six routes, then still claimable), S10 (concurrent claims), S11 (autoRefresh), B1 planted-record negative, B1 PID-reuse shape, L3 claim-marked planted record. All pass. Meaningfulness in "New tests" below. Gap: no test of a real claim-window crash (N1). |
| M5 / N4 spare-aware leak gate | **Fixed, narrow enough** | 12/12 off and on. Nits in "N4 answer". |
| L1 comment | Fixed | Now says node and PowerShell boot, helper load after the claim. |
| L2 evidence hygiene | Partly | Prove-red hashes are 8-character prefixes only; the fault sources are described, not kept. The guarantee-file hash matches the blob; the host hash `4defa319…` matches no blob I can compute (probably a CRLF working-tree hash). I cannot re-run the worker's faults from the record. |
| L3 audit trail after a claim-window crash | **Half fixed** | The record is kept (`spareClaimInFlight` plus `spareReapedAt`). But the call's tree is no longer retired. See N1. |
| L4 session mix | Recorded, unmeasured | Needed before default-on. |
| L5 memory (about 140 MB per idle pair) | Recorded | Needed in the enablement decision. |

## New findings

| # | Sev | Finding | Location | Evidence | Fix |
|---|---|---|---|---|---|
| N1 | **Blocking** | A runner crash inside the claim window leaves the launched call's whole tree running, with no owner. It is neither killed nor adopted. Round 1 (p3b) saw the same crash fail closed: the reap killed the tree within 0.5 s. The repair's own tests do not cover this case (they plant a record that names a bystander). | `killVerifiedSpareSupervisor` returns `skipped` when `durable.claimed === true` (`windows-job-process-host.ts:1513`, and again for `live.claimed` at `:1525`). The supervisor persists `claimed:true` before it acks the claim, so a crash after the ack always reads as `claimed`. The constructor reap (`:401-415`) has already removed the record from `this.records`, so the runner's normal recovery cannot reconcile or stop it either. | Probe p3 (real, unmodified code): a runner process was killed with SIGKILL right after the supervisor acked the claim and before the host persisted `spareClaimed:true`. On disk: `spare:true, spareClaimed:false, spareClaimInFlight:true`; durable status `claimed:true, status running, childPid 59620`. A new host was started on the same directory and given 4 s. Result: `AFTER recovery: supervisor alive true child alive true heartbeat growing true`. The record stays on disk with `spareReapedAt` and is re-"reaped" on every later host start. The command I used runs 120 s; a long build would run to the end, unowned. | In the reap, for a record with `spareClaimInFlight`, accept `claimed:true` in the durable and the live proof (the authenticated identity match is still required) and retire the tree. Keep the record as the audit trail, as now. Add a real test: a child runner process killed at the claimed persist (the probe's shape), then a new host retires the tree and keeps the record. |
| N2 | **Blocking** | The M2 fix does not work, and the evidence says it does ("fixed"). After the supervisor acks a claim, a later failure still falls back to a second launch, and the command runs twice. | `tryClaimSpareCall` (`:655-737`): the new `throw new WindowsJobHostError("process_start_failed", …)` at `:733` sits inside the outer `try`, so the outer `catch { return fail(); }` (`:736-738`) swallows it and returns `null`. The caller then swallows again: `launchOwned` does `await this.tryClaimSpareCall(input).catch(() => null)` (`:425`). The `persist(claimed)` call at `:711` is also inside the outer `try` but before the inner one, so it never reaches the `childPid === 0` proof at all. Only the `childPid === 0` sub-branch (return `null`) works as intended. | Probe p4 (real host, runtime monkeypatch in my script only): (a) `applyStatus` throws 900 ms after the ack (after the child started): `launchOwned` RETURNED ok, `claims 0, fallbacks 1`, **command executions = 2**. (b) `persist` of the claimed record throws after 900 ms: same, **executions = 2**. Control with no injection: 1 execution, claims 1. The evidence itself says "No existing test hits that path". | After an acked claim, make the failure reach the caller: mark `acked` before the outer catch and rethrow (unless `childPid === 0` is proven), and remove the `.catch(() => null)` swallow in `launchOwned` for that error (or let `tryClaimSpareCall` return a tagged failure). Add a test that injects the post-ack failure and asserts one execution and a surfaced `process_start_failed`. Correct the evidence line. |
| N3 | Low | New unguarded file read in the host constructor. A spare record whose status path cannot be read (a directory, a permission error) makes host construction throw. Round-1 code did the kill in a `try` and never read the file. (A corrupt record JSON already threw in the constructor before PX-2c, so this is the same class, not a new one.) | `windows-job-process-host.ts:405` (`readSupervisorStatus` is rethrown for anything but ENOENT). The sweep call site is inside a `try`. | Probe p6: spare-shaped record with `statusPath` set to a directory: `constructor ... THREW: EISDIR`. | Wrap the constructor read (treat a read error as "no proof", drop the record). |
| N4 | Low | The identity proof does not bind the answering listener to the recorded PID. Someone who can already write into the state directory and run a listener can make the helper kill a PID of their choice. Same-user only, so not an escalation, and the repair does what round 1 recommended (option a). | `killVerifiedSpareSupervisor`: the live check compares fields in the response, not the process behind the port. | Probe p1 variant C: planted record plus forged status file plus a fake HTTP listener that answers matching JSON: the bystander was killed. Variants A and B (r1's exact probe; a fully forged file with a dead port): bystander survived. | Optional hardening: also compare the process creation time with the record (`inspectProcessBirth`, round-1 option b). Not needed for acceptance. |
| N5 | Low | The spare-aware gate ignores every record with `spare && !spareClaimed`, not "exactly the one idle spare". Two leaked idle spares would pass it. It would also hide an N1 orphan (that record stays `spare:true, spareClaimed:false`). | `windows-job-real-host-guarantees.test.ts:206-210`. | Reading plus probe p5. | Optionally also require that at most one such record exists. Fine as is once N1 is fixed. |
| N6 | Info | `retireSpare` in the supervisor is now async and awaits `stopOwnedTree`. Verified: S8 records `spareRetired: idle-timeout`, S5 records `parent-dead`. No issue found. | `managed-process-supervisor.mjs:395-419` | S5, S8 green. | none |

## Judge items

**1. B1.** No process is killed by a recorded PID alone. There is exactly one `process.kill` in `windows-job-process-host.ts` (`:1527`, in the audited helper) and none in the supervisor. The constructor reap and the run-end sweep both go through it. Probes on the unmodified code:

| Probe | Shape | Result |
|---|---|---|
| p1 A | r1's exact probe: real spare retired by idle timeout, record's `supervisorPid` rewritten to a live bystander | bystander alive after host start, record dropped |
| p1 B | PID-reuse shape: record and status file both forged to the bystander PID, port dead | bystander alive, record dropped |
| p1 C | adversarial: forged record and file plus a fake listener answering matching status | bystander killed (N4, info) |
| S6 (test) | real orphan spare, verified live | killed (positive path works) |

**2. B2.** Green (2/2) at `54f15b17`. The fixes follow the round-1 homes. Remaining failures: none.

**3. M1-M5, L1-L5.** See the table. In particular: a runner kill inside the claim window now keeps the call's durable record, but leaves its tree running (N1). M2 is not fixed (N2).

**4. N4 answer (spare-aware gate).** With the spare on and off, the guarantee file is 12/12. The gate's clause ignores a record only by its own durable marks (`spare:true, spareClaimed:false`), so an idle spare is ignored by record, not by a pre-existing-PID set (the spare is started after the baseline). Probe p5 applied the gate's exact expression to real durable records with the spare on: 3 live supervisors, 2 claimed call supervisors (`spareClaimed:true`) flagged, the 1 idle refresh spare ignored. A fresh-launch call has no spare mark, so it is enforced too. I could not run a real "leaking call supervisor" fault through the gate function itself (classifier denial, see the header). The worker's prove-red (clause removed, spare on: 3/3 red with `Job supervisors of this run did not settle`) is not re-run by me. Nits: N5.

**5. Opt-in, scope, new tests.** Opt-in: yes. `execution-host.ts` only calls `retireSpare?.({runId})`; no `spare` option is passed anywhere in `runner-v2/src` outside the host. Retire and sweep scoped to the closing run: yes (probe p6). New tests, judged by reading each assertion against its fault:

- S8 idle timeout: 15 s wait for death plus `spareRetired: idle-timeout` and `childPid` always 0. It fails if the timer is removed.
- S9 pre-claim POST: asserts 409 and `spare_unclaimed` on six routes, GET `/status` 200, and that the spare still serves the call. It fails if the guard goes (the real routes would answer with a different error, `/claim` and `/spawn` with 404).
- S10 concurrent claims: exactly one call on the spare, claims delta 1. A host-side slot-take fault would also break the first call (the second `fail()` aborts the shared launcher), so it discriminates.
- S11 autoRefresh: waits for a second prestart and checks exactly one live waiting replacement.
- B1 planted/reuse: pin "no proof, no kill" and the live-status layer. Neither pins the durable-file layer alone (the live check covers it), which is fine. The planted test alone would not catch a fake-listener attack (N4).
- L3 claim-marked: pins "keep the record" and "no kill without proof". It does not pin a real claim-window crash, which is exactly where N1 sits.

**6. Suites.** PX-2b file, speed file and Windows Job batch green (one load flake in an untouched file that passes alone). See the results table.

## What I could not do

- I could not add a leaking-supervisor fault to the supervisor (permission classifier denial). I did not retry or use a `git archive` copy. I did not re-run the worker's prove-red faults (they edit production guard code, the same class as the denied edit). I checked behaviours with fault-free probes on unmodified code instead.
- I did not re-run the measurement script.

## Follow-ups

1. **Repair cycle 2 (blocking):** N1 and N2, each with a real test (child runner killed inside the claim window; injected post-ack failure asserts one execution and a surfaced error). Correct the M2 line in `PX-2c.md`.
2. Small, in the same cycle: N3 (guard the constructor read); optionally a test for scoped retire (M3) and copy the prove-red fault sources and full hashes into the evidence folder (L2).
3. **Still needed before default-on:** M1 (bootstrap at `bindRun` or first call, re-provision after a miss or expiry with back-off, nothing that keeps a spare alive beyond the idle timeout for an idle host); a mixed-session measurement on a real handoff or build run (L4); memory in the decision (about 140 MB per idle pair, L5); rerun the PX-2t file with the spare on and off at the final commit (done here at `54f15b17`: 12/12 both); carry forward PX-2a N1 (digest pin beside the assembly, slightly more important because the digest is captured at reservation time and lives up to the idle timeout). Keep the switch a code option owned by whoever builds the host (still true).
4. Optional hardening: creation-time check in the reap (N4), and a "at most one idle spare" clause in the gate (N5).

## My probes

Kept in the session scratchpad `scratchpad\px2cr2r2\` (`p1-planted.mts`, `p3-claimwindow.mts`, `p4-m2.mts`, `p5-gate.mts`, `p6-m3.mts`, `common.mts`, and the run logs). They run with `node ./node_modules/tsx/dist/cli.mjs` from a checkout of `54f15b17` (import paths `../runner-v2/src/...`).

**Verdict: REPAIR — 2 blocking**
