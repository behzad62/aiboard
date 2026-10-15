# PX-2c independent review, round 3 (targeted)

- Reviewer: independent fresh-context reviewer (did not write PX-2c, did not do rounds 1 or 2)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Packet: PX-2c repair cycle 2, commit `31bf1957` ("wip(px-2c-r2)"), branch `codex/runner-v2-px1`. Reviewed in a detached scratch worktree at that commit (`%TEMP%\px2cr3\wt`, node_modules junction to the p6-6 checkout).
- Inputs: round-2 review `PX-2c-review-r2.md`; brief `px2c-repair2-muse.txt`; evidence `PX-2c.md` section 9 ("Repair cycle 2"); the full commit diff (`git show 31bf1957`); the code and tests at that commit; round-2 probes (`scratchpad\px2cr2r2\`).
- Repo effects of this review: none. No source or test file was edited, staged, committed or stashed in any real checkout. In the scratch worktree I added probe scripts under `px2cr3-probes\` (untracked) and applied three single-site prove-red faults to `windows-job-process-host.ts`, each restored byte-exact from a backup (hash checked, `git diff` empty after). The permission classifier did not block the fault edits this round.
- Cleanup: junction removed first with `cmd /c rmdir`; `Test-Path` confirmed the link gone and `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6\node_modules\eslint` still present; then `git worktree remove --force`. Scratch temp folder deleted (files only). Two supervisors left alive by my own PX-2b test run (scratch script path in their command line) were killed by PID. No process of mine is left (checked by marker `px2cr3` in the command line).
- Probes and logs kept in the session scratchpad `scratchpad\px2cr3r3\` (`p3b.mts`, `p7-claimproof.mts`, `p8-n2-more.mts`, `p9-gate.mts`, `p10-n3.mts`, `common.mts`, and the suite logs). They run with `node ./node_modules/tsx/dist/cli.mjs` from a checkout of `31bf1957` (import paths `../runner-v2/src/...`).

sha256 of the changed files, as git blobs at `31bf1957` (LF):

| File | sha256 |
|---|---|
| runner-v2/src/windows-job-process-host.ts | `7f25bb9ad773741dca0474abacc0775f793c303c28df91343605e315867b269b` |
| runner-v2/test/windows-job-spare-host.test.ts | `8267e537e6fac2b8a238df5bec6db2e68fa54561c230c5c1051e6508c19fd214` (matches the evidence) |
| runner-v2/test/windows-job-real-host-guarantees.test.ts | `9960de5b45e92b5ab07eac29eae632a57bef9e6f68c7d83783cace3b841d89a1` (matches the evidence) |

Unchanged in this repair (same blobs as in round 2): `managed-process-supervisor.mjs` `f82a6f68bd5faaee402706ed9eb6483fb8cdac7afb65079f2a0b822d2bccffe2`, `execution-host.ts` `1643ea8f3b6eb5e2d2e0775f1036e46582e8e89050fafd71aa0aa6dd72944d95`, `task8-raw-launch-closure.test.ts` `3d46774ce74af21e525de3a170480e5c49309323cb72f6012be091684268fad1`.

The evidence gives `332657e1cd09264fbd69ac605cb9b0faaaf37c9d511907f3922325b43ae16b6f` for the host file. That does not match the committed blob (`7f25bb9a...`). It is a working-tree hash of a file with mixed line endings (see N11). The test-file hashes do match.

**Verdict: ACCEPT**

Both round-2 blockers are fixed and I could not break them. N1: a runner killed inside the claim window now has its whole tree (supervisor and child) retired by the next host, and the call's durable record is kept. The kill still needs the same authenticated identity proof as B1. N2: a failure after an acked claim reaches the caller as `process_start_failed`, the command runs once, also with a failing record persist. The new tests go red with the fixes removed. B1, B2, M3-M5 are not weakened. The spare is still opt-in. One new medium finding (N7, a lost claim ack can still cause a double run) does not block an opt-in packet but must be closed before default-on.

## Test and suite results at 31bf1957

Machine was shared and loaded. Judged by pass/fail.

| Check | Result |
|---|---|
| `windows-job-spare-host.test.ts` (19 tests, conc 1) | 19/19 pass |
| `windows-job-real-host-guarantees.test.ts`, spare OFF (conc 1) | 12/12 pass |
| same file, spare ON (`PX2C_SPARE_ON=1`) | 12/12 pass |
| `windows-job-fence-effects.test.ts` (PX-2b) + `windows-job-launch-speed.test.ts` (conc 1) | 46/46 pass |
| `task8-raw-launch-closure.test.ts` (conc 1) | 2/2 pass, test file unchanged |
| 11-file batch, conc 4 (windows-process-backend, windows-job-output-replay, windows-job-supervisor-input, one-shot-command-family-production-matrix, execution-host, subprocess-runtime, durable-process-store, windows-job-process-channel, windows-job-terminal-observation, windows-job-cleanup-bootstrap, portable-supervisor-input) | 260 tests, 259 pass, 0 fail, 1 skipped (pre-existing) |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| eslint on the three changed files | clean |
| `git diff --check` (parent of the repair to `31bf1957`, runner-v2) | clean |

I did not re-run `measure-git-launch.mts` (script untouched).

## Round-2 findings: status

| r2 | Status at 31bf1957 | Notes |
|---|---|---|
| N1 claim-window crash leaves the tree unowned | **Fixed** | Real crash probe: with the call's fence (production always passes one) supervisor and child were both dead 264 ms after the new host started, heartbeat stopped, record kept with `spareReapedAt`. Without a fence (round 2's exact probe shape) the tree is retired after 10.5 s (see N8). New crash test passes and goes red without the fix. |
| N2 post-ack errors swallowed twice, command ran twice | **Fixed** | Round 2's probe p4: `apply` and `persist` injections now throw `process_start_failed` from `launchOwned`, executions 1, fallbacks 0. Control: 1 execution, claims 1. Both swallows were restored one at a time; both N2 tests go red each time. |
| N3 constructor status read EISDIR | **Fixed** | Probe p10: plain-idle and claim-window shapes with `statusPath` a directory: constructor OK, bystander alive. |
| N4 (r2) listener not bound to the PID | Recorded, not implemented | Evidence gives a reason (needs a birth identity the record does not carry; same-user only). The brief allowed "or record why not". Probe (p7 `fake`): planted claim-window record plus forged status file plus a fake listener that answers matching claimed JSON gets the bystander killed. Same class as round 2 N4 (state-dir write plus a listener holding the record's token). Info. |
| N5 gate ignores every idle-spare record | **Fixed** | Probe p9 (gate predicate copied verbatim, applied to real records): one idle spare passes; two idle spares, a live claimed call, an idle spare plus a live call (autoRefresh), a fresh-launch call, and a real claim-window orphan are all flagged. |
| N6 supervisor `retireSpare` async | no issue | unchanged |
| Truncated hashes | Partly fixed | Full 64-hex hashes now. The two test-file hashes match the blobs. The host hash does not (N11). |
| r1 M1 bootstrap / re-provision | Not done, recorded | Still needed before default-on. |
| r1 L4, L5 (session mix, memory) | Unmeasured, recorded | Still needed before default-on. |

## Judge items

**1. N1 (real runner-crash probe, identity proof).**

Real crash, unmodified code (`p3b.mts`, a runner process SIGKILLed inside the claimed persist):

| Shape | Result |
|---|---|
| fence given | before recovery: supervisor alive, child heartbeat growing. After the new host started: supervisor dead and child dead at 264 ms, heartbeat stopped, record on disk with `spareReapedAt` and `spareClaimInFlight`, `spareClaimed` false |
| no fence (round 2's probe as written) | tree retired at 10.5 s (the `/signal` is refused for lack of a fence, the helper waits its 10 s budget, then the audited fallback kills the supervisor and the Job closes with it). Round 2's probe waits only 4 s, so run as written it still reports "alive". It is not a hole: it is the slow path (N8). Production always carries a fence (`windows-process-backend.ts:110-120`). |

Identity proof for the claimed kill (`p7-claimproof.mts`, all on unmodified code):

| Probe | Shape | Result |
|---|---|---|
| planted | in-flight record naming a live bystander, forged status file (claimed, matching), dead port | bystander alive, record kept |
| nostatus | in-flight record naming a bystander, no status file | bystander alive, record kept |
| wrongtoken | real claim-window pair, record token corrupted | live proof fails: supervisor and child both still alive, nothing killed, record kept |
| reuse | real pair retired, then record and status forged to a bystander PID (PID reuse shape), third host | bystander alive |
| liveclaim | a fully claimed live call (`spareClaimed:true`) with a new host started | supervisor and child alive (not reaped) |
| fake | planted record, forged file, fake listener answering matching claimed status | bystander killed (N4 class, info; needs state-dir write plus a live listener with the record's token) |

Reading confirms it: `retireVerifiedClaimWindowTree` needs `spareClaimInFlight` on the record, a durable status that names this processId, supervisorPid, spare, and claimed, and a live token-authed `GET /status` with the same identity. The retire goes through the supervisor's own `POST /signal` (fence from the pre-ack record). The only PID kill is still `killVerifiedSpareSupervisor` (one `process.kill` in the file), and it is reached with `acceptClaimed:true` only from the retire helper after the same proofs. `killVerifiedSpareSupervisor` is now stricter by default: it also skips any in-flight record.

**2. N2 (double-run probe).** Results in the table above. In addition (`p8-n2-more.mts child`): after a post-ack failure with a long-lived child, the supervisor is dead and the child heartbeat stops, so the failed call's tree is not left running. Pre-ack failures still fall back (S7a/S7b in the suite, green). I found one distinct path that still double-runs: a claim the supervisor processed but whose ack the host never saw (N7).

**3. New tests.**
- N1 crash test ("a runner crash inside the claim window retires the tree and keeps the record"): a real doomed runner process (tsx script) is SIGKILLed at the claimed persist. A new host on the same directory must leave neither supervisor nor child alive and keep the record. Prove-red: I removed the constructor's call to the retire helper only; the test failed with `claim-window supervisor to die did not settle within 20000ms`. Restored, green.
- N2a / N2b tests: inject a throw after the child started (applyStatus) and in the claimed persist. They assert `process_start_failed`, exactly one execution, and no fallback counted. Prove-red, two separate single-site faults: (a) outer catch `if (false && claimAcked)`: both tests red (`actual: undefined, expected: 'process_start_failed'`); (b) `launchOwned`'s `.catch(() => null)` restored: both tests red. (My first attempt at fault (b) matched four lines by sed; I discarded that result and redid it as one exact multi-line replacement.)
- Leaks: after the full 19-test run, and after all the red runs, no process with my scratch path or the tests' temp-dir markers was left. Failed N1 runs are cleaned by the test's `finally` (`killIdentifiedPids`).
- Observation: the N1 test uses a fence, so it pins the `/signal` path, not the fenceless audited fallback. Removing the fence from the claim-window record would not fail it (the fallback still kills within its 20 s window). That is fine, since production is always fenced.

**4. N3, N5, listener, hashes.** N3 and N5 fixed (probes above). Listener not bound to the PID: recorded with a reason (see table). Hashes: see N11.

**5. B1, B2, M3-M5, opt-in.**
- B1: not weakened. One `process.kill` in the host file. Probes p1 A and B from round 2 (planted record, forged file with dead port): bystander survives. The new claimed-kill path is gated as above.
- B2: `task8-raw-launch-closure` 2/2 with no test or allowlist edit.
- M3: probe p6 (run-scoped retire): `retireSpare({runId:"runB"})` left run A's spare alive with its record; `retireSpare({runId:"runA"})` removed both.
- M4: S8-S11 and the B1 negatives are in the 19/19 run.
- M5: gate and spare-on run, 12/12 both ways.
- Opt-in: the only `retireSpare` call outside the host is `execution-host.ts:622` (retire scope, unchanged). No production site passes a `spare` option or calls `prestartSpare`. Default behavior of `launchOwned` is unchanged: `tryClaimSpareCall` returns null when there is no spare, and the narrowed `.catch` only sees post-ack errors.

**6. Suites.** All green (table above), including `windows-job-spare-host`, the guarantee file off and on, the speed and PX-2b files, `task8-raw-launch-closure`, and the Windows Job batch.

## New findings

| # | Sev | Finding | Location | Evidence | Fix |
|---|---|---|---|---|---|
| N7 | Medium, not blocking (opt-in). Blocking for default-on | A claim the supervisor processed, but whose `claim_ack` the host never saw (ack timeout, launcher exit mid-claim), takes the pre-ack `fail()` path and falls back to a fresh launch. The command can then run twice. The `childPid === 0` proof in the post-ack branch has the same shape: it is one read at one instant, and the child can start right after it. r1 M2 and r2 N2 were about acked claims, so this is a distinct gap, not a regression. | `tryClaimSpareCall`: `if (!acknowledged) return fail();` and the `proof.childPid === 0` branch | Probe `p8-n2-more.mts lostack` (real host; the claim is delivered, then `sendSpareClaim` reports false after 1.5 s): `launchOwned RETURNED ok, command executions=2, claims 0, fallbacks 1`. Needs a stalled or dying supervisor (ack timeout is 1-10 s), so it is rare. | Before any fallback after a sent claim, read the durable status: fall back only if `claimed` is false (or abort and confirm `childPid === 0` and no `started` event under the abort). Otherwise surface `process_start_failed`. Add a lost-ack test. |
| N8 | Info | Without a fence the claim-window retire waits its full 10 s budget before the fallback kill. Production always passes a fence, so this is the slow path only. The recovery is fire-and-forget, so nothing blocks on it. | `retireVerifiedClaimWindowTree` wait loop | p3b without fence: dead at 10.5 s | Optional: skip the wait when `/signal` fails outright. |
| N9 | Low | Kept claim-window audit records are never pruned. Each later host start re-reaps them (re-persists `spareReapedAt`, re-runs both proofs). One record per crash accumulates. | constructor reap | reading | A retention rule once the record is proven stopped. |
| N10 | Low | Comment and format damage in the host file: the constructor comment says "previous idle spares through killVerifiedSpareSupervisor — never by a" then repeats "never by a recorded PID alone"; `readSupervisorStatusQuiet` ends with `}/**` on one line; two doc comments are stacked above it (one orphaned). No behavior effect; lint and tsc are clean. | `windows-job-process-host.ts` about `:403-408` and `:1573-1583` | diff | Tidy at the next touch. |
| N11 | Low | The host-file hash in the evidence (`332657e1...`) is a working-tree hash of a file with LF lines inserted into CRLF text. It cannot be reproduced from the blob. The prove-red restore claims cannot be re-verified from git. | evidence section 9 | `git show 31bf1957:...host.ts | sha256sum` gives `7f25bb9a...` | Record blob hashes (`git hash-object` or LF-normalized sha256) in future evidence. |
| N12 | Info | The fake-listener attack (N4 class) now also reaches claim-window records, as expected: the same proof, the same same-user precondition. No new privilege. | see item 1 | p7 `fake` | Optional: creation-time binding (round-1 option b) with the default-on work. |
| N13 | Info | The constructor reaps any in-flight claim-window record, including one owned by a live sibling runner on the same state directory (its call would be retired). Sharing a state directory between two live runners is not a supported shape, and round 1 already accepted the same for idle spares. | constructor reap | reading | Record in the enablement decision. |
| N14 | Info, not PX-2c | The PX-2b `windows-job-fence-effects` file leaves two supervisors alive per run (`aiboard-px2b-unknown-*` and `-cursor-*` state dirs). Dozens from earlier runs are alive on this machine. The file is unchanged by PX-2c. Leak checks on this machine must filter by script path or state-dir marker. | PX-2b tests | I killed the two my run left | Owner or controller call; outside this packet. |

## Follow-ups

1. **Before default-on (all carried, now with N7):**
   - N7: no double run on a lost ack or a slow child start (durable `claimed` check before any fallback).
   - M1: bootstrap at `bindRun` or first call, and re-provision after a miss or expiry with back-off. Nothing may keep a spare alive past its idle timeout on an idle host.
   - L4: a mixed-session measurement on a real handoff or build run.
   - L5: memory in the decision (about 140 MB per idle pair).
   - Re-run the guarantee file with the spare off and on at the final commit (done at `31bf1957`: 12/12 both).
   - Carry forward PX-2a N1 (digest pin beside the assembly).
   - Consider the creation-time check (N4/N12) and a retention rule for kept records (N9).
   - Keep the switch a code option owned by whoever builds the host (still true).
2. Small, any time: N10 comment and format tidy; N11 blob hashes in evidence; optional N8 fast path.
3. Owner call, outside PX-2c: N14.

**Verdict: ACCEPT**
