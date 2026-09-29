# PX-2b — Fewer or cheaper fence effects and event-driven settlement (lane C)

Outcome: one quiet git call now costs 11 fence effects instead of 14
(large/output calls 13 instead of 16), with every fence predicate,
deadline, audit fact and crash-recovery boundary exactly as strong.
Measured on this machine (n=20, same script as PX-2t/PX-2a):
quiet median 733.0 ms -> 677.7 ms, p90 780.3 -> 718.1;
large 880.9 -> 804.0; rev-parse 806.6 -> 727.6 (same command as PX-1).
No commit, stage, stash or push. `git status` shows only the files below.

Machine: Windows 10 Pro 10.0.19045, 16 CPUs, node v24.18.0, git
2.53.0.windows.1, PowerShell 5.1. Backend on this machine:
`runner-windows-job-v1` (every run re-verifies empirically).
Unattended pipeline; background OS load unknown, so wall-clock deltas
carry machine noise — the effect counts are structural and exact.

Contract: plan CD-21 / PX-2b; PX-1 F4 (19 ms per effect, 14 per call);
PX-1-review-r1 conditions 1 (cheap steps, probe + effects per call),
8 (acceptance number from measurement; say so if 200 ms is out of
reach) and 9 (suites stay green).

Changed files (writable set respected; the two real-host gate files are
byte-unchanged):

- `runner-v2/src/managed-process-supervisor.mjs` (+49/-0)
- `runner-v2/src/windows-job-process-channel.ts` (+43/-9)
- `runner-v2/src/windows-job-process-host.ts` (+122/-11)
- `runner-v2/scripts/measure-git-launch.mts` (+2, additive effect counter)
- `runner-v2/test/windows-job-fence-effects.test.ts` (new, 659 lines,
  sha256 `d3137ecf2c3b1dfc471022d668a6168fa307d63e62fb8d130c97cf7fb7137729`)
- this file `PX-2b.md` (evidence)

## 1. STEP 1 — measure first (before any change)

Per-effect fence-lock floor: empty `withOwnedFenceLock` effect, n=30,
median **18.7 ms** (p90 19.8, min 18.0; first call 226.4 ms for protocol
init). Reproduces PX-1-review-r1's 19.0 ms. Micro-costs on the same
machine: JSON record tmp+rename persist ~0.6 ms, record read+parse
~0.3 ms — the ~19 ms floor is the SQLite lock open/protocol validation
(`owned-fence-lock.mjs`, fresh `DatabaseSync` + `synchronous=FULL` +
schema checks per effect), not the file writes. Consequence: skipping
persists would save ~4 ms/call at most and was NOT done (see §4).

Per-kind cost on live quiet calls (n=6, timed at the host seam):
`launchOwned` 1 x 333.9 ms (PowerShell boot, not this packet's target),
`reconcileOwned` 7 x 21.6 = 151.5, `readOwnedOutput` 3 x 21.2 = 63.7,
`releaseOwned` 1 x 30.3, `attachOwnedChannel` 1 x 21.8,
`claimOwnedFence` 1 x 22.5. Fence total ~290 ms/call excl. launch.

The 14 effects of one quiet call (stack-attributed, one instrumented
call; runtime path `git-runtime-runner.ts:46` -> `one-shot-command-
executor.ts:224` -> `subprocess-runtime.ts:1923`):

| # | Effect (host method) | Issued from | Durable fact / ordering guaranteed | Mean cost |
|---|---|---|---|---|
| 1 | claim | `windows-job-process-channel.ts:35` acquire | Writer-fence compare-and-set: a stale writer can never observe or mutate (rejects lower token, same-token foreign owner) | 22.5 ms |
| 2 | reconcile | `windows-process-backend.ts:276` reattest <- channel acquire | Birth attestation at attach: binding `startedAt` equals the live record | 21.6 |
| 3 | attach | `channel.ts:37` acquire | Fenced attachment: fence equality, supervisor identity, output-evidence files, retained-window snapshot | 21.8 |
| 4 | read | channel `startPolling` immediate poll | Output drain (bytes are served from local files only after fence+identity checks) | 21.2 |
| 5 | read | `channel.ts:122` waitForTerminal loop poll | Same, iterative drain | 21.2 |
| 6 | reconcile | `channel.ts:124` loop reattest | Live->exited transition detection with birth re-check | 21.6 |
| 7 | read | `channel.ts:130` settle poll | No-growth proof: output quiesced before terminal certification | 21.2 |
| 8 | reconcile | `channel.ts:133` settle reattest | Still-exited after the no-growth poll (carried the `startedAt` check) | 21.6 |
| 9 | reconcile | `channel.ts:135` terminal `control(reconcileOwned)` | Terminal snapshot under the backend lane (checked processId/stopped/released) | 21.6 |
| 10 | reconcile | `channel.ts:139` post-terminal reattest | Still-exited after the terminal read | 21.6 |
| 11 | reconcile | `windows-process-backend.ts:168` observe-final | Observe-return re-attestation (`startedAt`, stopped, released) | 21.6 |
| 12 | reconcile | `windows-process-backend.ts:198` verifyEmpty | The exact-empty proof (T7b pins `empty:false` while a descendant lives) | 21.6 |
| 13 | release | `windows-process-backend.ts:230` <- `:238` <- `subprocess-runtime.ts:1088` | Release tombstone: stopped+released verified in-effect before the write, then fence protocol retired | 30.3 |
| 14 | (launch) | `windows-process-backend.ts:107` -> host `launchOwned` | One Job per call, suspended-create -> assign -> resume, kill-on-close, launch proof (no fence lock; counted at the seam) | 333.9 |

(Effect 9's stack reads `channel.ts:135` directly: the `control()` delegate
runs the service call inline.)

## 2. STEP 2 — what changed (only where no guarantee weakens)

C1 — fused terminal proof (`windows-job-process-channel.ts:141-160`).
Effects 8+9+10 (three back-to-back reconciles, no intervening host
action) become ONE `control(reconcileOwned)` carrying every predicate:
`processId` (as before), `startedAt` against the attach-time snapshot
(new; the snapshot is taken after the acquire reattest proved the
binding birth), `stopped`, `ownershipReleased` (as before). Why it keeps
its guarantee: the three reads observed the same fence-attested facts
milliseconds apart with nothing written between; supervisor terminal
state is monotonic (stopped+released never reverses; supervisor death
falls back to the same durable file facts in `authenticatedStatus`);
the backend observe-level reconcile (`windows-process-backend.ts:168`,
untouched — that file is outside the writable set) still re-attests
after return; `verifyEmpty` + `release` keep their own reconciles.
Saves 2 effects (~43 ms).

C2 — fused claim+attach (`windows-job-process-host.ts:494-523` new
`claimAndAttachOwnedChannel`, interface `:67`; channel acquire
`windows-job-process-channel.ts:33-52`). Effects 1+3 become ONE fence
effect running byte-identical claim predicates (shape, stale-writer
rejection, CAS persist on upgrade) followed by byte-identical attach
predicates (equality, interactive, authenticated status, retained
frames) in the same order, under one lock hold with one
`retireAfterEffect: false`. This is exactly the brief's blessed combine
(one atomic transaction, same facts, same order). The stale-writer
rejection still runs before any attachment observation. A new
`allowFenceUpgrade` flag on `withFenceEffect` (`:711-727`, default
absent = byte-identical behavior for all 8 other effects) lets the
fused body perform the CAS; without it the wrapper's holder-equality
pre-check would reject fence upgrades before the CAS runs (found by the
new E1 test failing pre-flag). Callers without the method (fakes, older
hosts) run the unchanged split path. Saves 1 effect (~22 ms).

C3 — release drops its second pre-lock re-read
(`windows-job-process-host.ts:376-379`, old lines 359-361). The removed
read ran back-to-back with the first pre-check with no intervening host
action; the same stopped+ownershipReleased predicate is still enforced
authoritatively inside the release fence effect before the tombstone
write (plus the release-refusal pin of T7b, still green). Saves one
HTTP+read+persist (~6 ms), not a full effect.

C4 — event-driven settlement waits (supervisor + host + channel). New
authenticated `GET /wait-status?timeoutMs=` endpoint
(`managed-process-supervisor.mjs:161-175`): Bearer-checked like
`/status`; returns immediately when already terminal (terminal state is
final, so no lost wakeup); otherwise parks until the next
`persistStatus()` (every durable state change persists, via
`settleStatusWaiters`, `:66-94`) or the bounded server timeout
(1-5000 ms). Host `waitOwnedStatusChange` (`:445-451`, read-only,
deliberately outside the fence lock so parked waits never block
retained-output ACKs) and exported `waitForSupervisorStatusChange`
(`:866-869`). Channel `waitForChange` (`:233-247`) replaces the two
fixed `delay(25)` sleeps (waitForTerminal `:167`, settle `:217`) with
the long-poll; any absence/transport/auth failure falls back to the old
delay, every existing deadline stays armed (settle keeps its expiry
race; the call-level stop/timeout path is untouched), and every wakeup
is followed by the same poll+reattest as before. The 25 ms
`startPolling` drain interval is untouched (drain behavior identical).
Saves poll-granularity wall time (~25-75 ms), zero effects.

C5 — event-driven supervisor-startup wait
(`windows-job-process-host.ts:814-869`). `waitForSupervisor` re-reads
the status file on directory events (`waitForFileActivity`, `fs.watch`
on the parent dir since the file may not exist yet) instead of every
25 ms; the start deadline still bounds the loop, watcher failure
resolves via the bounded timer, and the `/status` fast-path once
running is unchanged. Exported for tests. Saves ~12 ms average.

Ordering correction during this packet (kept honest): the first
acquire cut ran reattest before claim; five existing
`windows-job-cleanup-bootstrap.test.ts` tests pin the historical
`claim,reattest,attach` sequence and went red. Per the no-rewrite rule
the product was fixed instead: the split fallback path is now
byte-identical to the old order (claim, reattest, attach), and the
fused path claims first inside the combined effect with birth
re-attested immediately after, before the channel is returned or used
(an attach snapshot therefore never escapes with an unverified birth:
stale birth throws in acquire; the attach persist writes only live-true
cache data). All six bootstrap tests are green unchanged.

## 3. Owner decisions (cuts NOT made — would need a weaker protocol)

- Runtime SQLite combines (`subprocess-runtime.ts` claim / prepare /
  environment / launching / bind / journaled observe / record_exit /
  finalize / begin_verify / verify / release): NOT combined. Each
  revision is a crash-recovery resume point (restart reconciles by
  state); merging would lose resume granularity. Measured cost is small
  anyway (PX-1: ~8.6 ms/call over ~8 execs). Owner call if ever wanted.
- Cheaper per-effect SQLite (keep the `.fence.lock` connection open,
  relax `synchronous=FULL`, cache schema validation): NOT done. This is
  the guarantee-bearing lock core (`owned-fence-lock.mjs`, 1132 lines);
  the floor math below shows what it would buy (~19 ms -> small single
  digits x 11 effects). Owner call; needs its own review.
- Skipping `authenticatedStatus` HTTP/file reads inside read/reconcile
  effects: NOT done. The HTTP GET is the supervisor-liveness proof and
  the file read carries freshness; skipping either weakens exactly what
  PX-2t pinned (T3/T4/T10/T12 kill and death detection).
- Skipping record persists when "nothing changed": NOT done. The only
  ever-changing field is `updatedAt`, and persisting it is what keeps
  the on-disk record equal to the in-memory one (`ownedRecord`
  re-reads disk on every call); persist itself costs ~0.6 ms.
- Fusing the backend observe-final reconcile (`windows-process-backend.
  ts:168`): NOT done — that file is outside this packet's writable set.
  It re-attests milliseconds after the fused terminal read with no
  intervening host action; a future packet owning that file could fuse
  it for ~1 more effect (~20 ms).

## 4. Tests (new file `runner-v2/test/windows-job-fence-effects.test.ts`)

14 tests, all real-host except the pure-wait units (which run against
stub servers / temp dirs). Conventions follow PX-2t (win32 + backend
skip discipline, per-test timeouts <= 55 s, 90 s self-exit trees,
finally-kill of identified PIDs, zero-leftover asserts where live
trees are used):

| Test | What it pins |
|---|---|
| A2 fused claim+attach rejects stale writers | Invalid shape, lower token, same-token foreign owner rejected; current fence attaches (C2 ordering) |
| E1 fused upgrade durable across host instances | Higher-token fused acquire persists; a NEW host instance honors the new fence, rejects the old, settles and releases (the only new write-transaction boundary; terminal fusion is read-only) |
| B1 fused terminal proof, backend-level | Quick call: exited/0, byte-exact stdout, empty, released (C1 predicates) |
| B2 production call end to end | Same through `commandExecution.execute`: exited/0/`verified_empty`/byte-exact (C1+C2+C4 through the production graph) |
| C1 release refuses live, succeeds empty | Live release refused `not verified terminal` (remaining pre-check); kill via fresh backend instance (refused lane stays closed by design, T7b precedent); settle, verify empty, release (in-fence check) |
| D1a file-activity wait resolves on change | Event (~150 ms), not the 5 s timer |
| D1b file-activity wait resolves via timer | Bounded (~200 ms), never rejects (caller owns deadline) |
| D2a startup wait resolves on terminal persist | Event-driven (~150 ms) |
| D2b startup wait rejects at its deadline | 300 ms deadline fires |
| D2c startup wait never misses landed status | Pre-present terminal resolves immediately (lost wakeup) |
| D3a status-change wait returns landed terminal | Immediate return + wrong Bearer rejected (helper level) |
| D3b status-change wait wakes on change | ~300 ms wake beats the 2 s timeout |
| D3c status-change wait throws at its deadline | Hung supervisor trips the client timeout (`timed out`) |
| D4 live supervisor authenticates /wait-status | Forged Bearer -> 401, real Bearer -> 200 with identity+status on the REAL supervisor (first real-host Bearer pin on this path; G14 stays MISSING for the other endpoints) |

Prove-red: one controlled fault per test (13 faults; B1+B2 share the
channel fault), each restored byte-exact — sha256 of all three product
files before == after every fault
(host `1fb66878a4062efa989ffb6c1a6c6e0681c2fe598f5ae04152cd8d1218e017b3`,
channel `25aa94f5…` pre-reorder / `2b24d0fe…` final,
supervisor `50304430356be75ce9e2d840cfb51a802702ccdedd135e5bd8b634a5723dddc4`;
backups under `%TEMP%\px2b-backup\`):

| Test | Fault (file) | Red result |
|---|---|---|
| D1a | host: never register the change listener | resolves at the 5 s timer, `>= 2000 ms` assert fires |
| D1b | host: timer forced to 0 ms | resolves in ~2 ms, `>= 100 ms` assert fires |
| D2a | host: event wait replaced with a hanging promise | hits the armed deadline (test timeout) |
| D2b | host: deadline `throw` replaced with `return null` | "Missing expected rejection" |
| D2c | host: ready-check `port > 0` -> `> 999999` | deadline rejection on landed status |
| D3a | host helper: `/wait-status` -> `/status` (stub 404s) | `HTTP 404` throw |
| D3b | host helper: timeout forced to 1 ms | client timeout before the 300 ms change |
| D3c | host helper: swallow errors, return null | "Missing expected rejection" (deadline backstop defeated) |
| D4 | supervisor: `if (false && !authorized(...))` | forged Bearer returns 200, `200 !== 401` |
| A2 | host fused: remove CAS + equality checks | stale foreign owner attaches, "Missing expected rejection" (a CAS-only cut stays green via the equality check — recorded, then the full cut reds) |
| E1 | host fused: drop the CAS upgrade assignment | upgrade throws stale |
| B1+B2 | channel: invert the `startedAt` predicate | valid terminal rejected: "not currently authenticated" (B1 direct; B2 via its probe call) |
| C1 | host release: remove pre-lock AND in-fence terminal guards | live release succeeds, "Missing expected rejection" (removing only the in-fence guard stays green via the remaining pre-check — recorded; the packet's actual cut keeps both remaining guards) |

## 5. Before/after (`runner-v2/scripts/measure-git-launch.mts`, n=20)

Script change (additive, keeps the count honest): `EFFECT_METHODS` +
`zeroCounts` gain `claimAndAttachOwnedChannel` (2 lines). Script sha256
`aa5d4f9c…` (PX-2t committed) -> `bd8b7a0a…` (this packet). Before was
measured with the committed script (14/16/16); after with the extended
one (11/13/13).

| Sample | Before median / p90 | After median / p90 | Effects/call |
|---|---|---|---|
| quiet `status --porcelain=v1` | 733.0 / 780.3 | **677.7 / 718.1** | 14 -> **11** (reconcile 7->5, claim+attach 2->1 fused) |
| large `ls-files` (4000 files) | 880.9 / 908.2 | **804.0 / 857.0** | 16 -> **13** |
| rev-parse HEAD (PX-1 cmd) | 806.6 / 844.3 | **727.6 / 751.3** | 16 -> **13** |

(An intermediate after-run before the claim-first reorder measured
647.5/701.8 quiet; the reorder costs nothing structurally — same
effects, adjacent order — and the final-code rerun above is the
reported number. Before/after runs sit hours apart on an unattended
machine, so ms deltas carry load noise; the -3-effects accounting at
~20 ms each is the exact part.)

Condition 8 acceptance number: the measured floor says 200 ms/call is
out of reach on this path without weakening the protocol or removing
the per-call PowerShell boot (already PX-2a'd as far as safe).
11 effects x ~19 ms floor = ~210 ms of fence floor alone, plus ~330 ms
launch (PS boot + supervisor bind) plus ~100 ms runtime durable work.
Remaining honest levers are PX-2c (pre-started spare) and/or a
lock-core cost reduction (owner decision above) — not a weaker fence.

## 6. Validation suites and counts (`NODE_TEST_CONTEXT` cleared)

| Suite | Result |
|---|---|
| `windows-job-fence-effects.test.ts` (new, `--test-concurrency=1`) | 14/14 pass (re-run green after the reorder) |
| `windows-job-real-host-guarantees.test.ts` + `windows-job-launch-speed.test.ts` (unchanged, `--test-concurrency=1`) | 16/16 pass, re-run green on the final code |
| `windows-process-backend` + `windows-job-output-replay` + `windows-job-supervisor-input` + `one-shot-command-family-production-matrix` + `execution-host`(+credential-graph, +streaming-quiesce) + `subprocess-runtime` + `durable-process-store` (`--test-concurrency=4`) | 232 pass, 0 fail, 1 skipped (pre-existing skip, same as PX-2a) on re-run |
| `windows-job-process-channel` + `windows-job-terminal-observation` + `windows-job-cleanup-bootstrap` + `owned-fence-lock` (r1 F3f extras, conc 1) | all pass (bootstrap 6/6 caught the reorder mid-packet, then green) |
| `tsc --noEmit -p runner-v2/tsconfig.json` | clean |
| `eslint` on all five touched/added files | clean |
| `git diff --check` | clean |

Flake note (pre-existing, outside this packet's diff): the batch's
first post-reorder run failed `windows-process-backend.test.ts:2579`
"sink failure leaves a durable unknown terminal" with `control was
requested while release is pending`. Mechanism: step-3's refused
release resets the backend `releaseRequested` flag only for three error
codes; if the supervisor's `exit` event (which sets `jobEmptyProof`)
has not yet fired when refusal lands, refusal throws
`process_control_unavailable` instead of
`process_output_unsettled_terminal`, the flag stays set, and the
recovery observe's first ACK throws. All of that logic lives in
`windows-process-backend.ts` (untouchable here) and supervisor event
timing; this packet's release cut cannot alter step 3 (its status is
`exited_unknown`, refused before the removed read). The test passes in
isolation and the full batch is green on re-run (232/0/1). No code was
changed for it.

## 7. Not done / limits

- The shared per-run broker is NOT built (CD-21: one Job per call
  always; broker only if the owner asks again). This packet is the
  "fewer effects + event settle" step: 14->11 effects, polls->events.
- `waitForSupervisor`'s first read often already sees the port (fast
  boot); the watch only pays on slow boots. `fs.watch` Windows delivery
  is relied upon with the start deadline as the backstop plus a timer
  fallback on watcher error.
- Long-poll waits park one HTTP connection per waiter (server-bounded
  5 s, self-cleaning); the supervisor exits with the call (PX-2a), so
  no waiter outlives its call except across the ~4 s pre-PX-2a linger,
  which is gone.
- Measured with `permissionProfile: "full"` only (as PX-2t/PX-2a);
  interactive streaming paths get the same fused/event code but their
  wall-clock was not measured here.
- `authenticatedStatus` still re-reads + HTTP GETs + persists per
  effect; only the duplicated release pre-read was cut.
- Inserted source lines use LF inside CRLF files (same as PX-2a; `git
  diff --check`, eslint, tsc clean; autocrlf notice only).
- No commit/stage/stash/push performed; earlier `wip(px-2t)`/`wip(px-2a)`
  commits untouched; this work is uncommitted for independent review.

