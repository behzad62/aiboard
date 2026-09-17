# Task 8.0B1 implementation report

## Scope and base

- Entry architecture commit: `6ade2e52`.
- Changed only the approved 8.0A contract/store/channel seams plus new fake-only
  launch/runtime/output modules and focused tests.
- No native/POSIX/Windows/Job/OCI adapter, CLI/factory, Git/MCP/LSP/managed/
  provider family, raw process launch, shell, ambient environment, or Node
  engine policy was changed.

## B1.1 RED/GREEN evidence

1. Added `staged-launch-kernel.test.ts` first. Exact RED:
   `npx tsx --test runner-v2/test/staged-launch-kernel.test.ts` failed because
   `HOST_LAUNCH_RECORD_VERSION` was absent.
2. Implemented strict v1 host-launch records in the existing streaming-session
   kernel, a hidden writer, in-memory and same-Database SQLite host tables,
   fenced prepared/isolation/launch/bind/handshake transitions, staged grant
   authority, and atomic adoption.
3. Added the atomic-finalization regression first; exact RED was
   `TypeError: authority.finalizeLaunch is not a function`. GREEN after the
   implementation: 4/4 tests.
4. Grant consumption was observed before any fake isolation effect; a reused
   call and a reused staged alias fail typed. The private staged object
   serializes as `{}` and its claims remain authenticated in the authority
   WeakMap.

## B1.2 RED/GREEN evidence

1. Added `streaming-output-v2.test.ts` first. Exact RED was
   `ERR_MODULE_NOT_FOUND` for `bounded-protocol-queue.js`.
2. Added owned-copy, byte/chunk-bounded queueing, producer backpressure,
   cancellation and oversized-frame cleanup; additive channel-v2 metadata;
   protocol/evidence tee; strict sequence/offset/length/digest checking; exact
   acknowledgement; and current delivery authorization.
3. Exact GREEN grew to 12/12 tests. The mutable caller buffer, saturation/release,
   cancellation, evidence-write failure, sequence gap, and authorization
   refusal cases are covered.

## B1.3 RED/GREEN evidence

1. Added `streaming-process-session-runtime.test.ts` first. Exact RED was
   `ERR_MODULE_NOT_FOUND` for `streaming-process-session-runtime.js`.
2. Added a fake-provider-only runtime with the exact staged/prepare/isolate/
   launch/bind/channel/output/handshake/adopt order. It never invokes terminal
   wait and fails typed for non-v2 output.
3. Added bounded host-row startup reconciliation; its fake recovery never
   launches.
4. Exact GREEN grew to 8/8 tests.

## Mandatory gap closure RED/GREEN evidence

- Durable checkpoint contract RED: `streaming-output-checkpoint.test.ts` failed
  because `parseOutputCheckpointRecord` did not exist. GREEN is 4/4, covering
  strict version/keys, recursive payload refusal, record/window capacity,
  accepted→intent→consumed, exact replay, HMAC/tamper/reopen and read-only.
- Durable controller ordering RED observed `missing` at delivery/ack checkpoints;
  retained-window recovery RED had no method. GREEN proves accepted commit,
  consuming intent, authorized delivery, consumed commit, then acknowledgement;
  exact consumed replay suppression and ambiguous delivery/ack become durable
  `outcome_unknown`.
- Queue terminal cleanup RED hung a blocked producer until the 30-second exact
  test timeout. GREEN rejects/wipes queued and waiting owned buffers and settles
  all producer/consumer waiters on oversize or cancellation.
- Host cleanup RED rejected `ownerExpiresAt` as unknown and had no cleanup
  transitions. GREEN covers pending/blocked/released, consecutive expired-owner
  takeover, immutable origin plus takeover provenance, stale fence, and forged
  provenance refusal.
- SQLite adoption fault RED ignored the injected boundary and initially exposed
  the test handle-cleanup defect; after fixing fixture cleanup, GREEN proves
  rollback after session insert and wholly post-adoption state after commit.
  Reopen evidence covers every prepared/isolation/launch/bind/handshake boundary.
- Runtime cancellation RED left the host `bound` and allowed an active abort to
  adopt. GREEN settles exact cleaned/blocked journal terminals, waits the active
  effect barrier, releases one lease, and refuses revocation at isolate, launch,
  channel, output, and handshake boundaries.
- Adopted recovery RED left the session active with missing retained bytes.
  GREEN reattaches without terminal wait/relaunch, validates the provider replay
  window against durable accepted metadata, and records `outcome_unknown` or
  `input_unavailable` through SessionAuthority.
- Runtime v2 composition now creates the checkpoint, queue, evidence tee and
  controller before output starts. A fake emitted protocol chunk proves one
  evidence write, one authorized delivery, one consumed checkpoint and one
  provider acknowledgement; the returned facade contains no channel/backend.
- Controlled mutations were reverted: disabling current output authorization
  made its exact test RED; acknowledging before consumed commit made ordering
  RED; ignoring the host fence made the fencing test RED. Each exact check was
  GREEN after revert.

## Historical pre-review validation (superseded below)

- New B1 focused tests: 34/34 green in the final validation rerun.
- Exact 8.0A plus staged-kernel affected tests: 99/99 green.
- Exact Task 7 compatibility tests: 127/127 green.
- `npm run typecheck:runner-v2`: green.
- Targeted ESLint over every changed source/test: green after replacing an
  empty acknowledgement interface with an equivalent type alias.
- `git diff --check 6ade2e52`: green (Git emitted only expected LF/CRLF worktree
  notices).
- Static changed-source search found no spawn, kill, taskkill, shell flag,
  ambient `process.env`, or exact Node patch pin. The only `exec(` matches are
  existing/new SQLite transaction/schema calls in the durable kernel.

## Cleanup and residue

- Tests use only in-memory fake runtime state in the new packet; no real child,
  port, endpoint, supervisor, container, or timer is started.
- All byte queues clear owned references on cancellation/oversize. Runtime
  failure detaches the fake channel and releases the fake lease.
- No B1-named temporary directory or spill was created by the focused tests.
- One positively owned SQLite root left by the deliberately failing first
  adoption-fault test was validated as the exact Temp child containing only
  `sessions.sqlite`, removed non-recursively, and re-inspected. Final matching
  B1 temp-root residue count is zero.

## Historical pre-review self-assessment (superseded by review round 1)

- The earlier self-assessment missed the Critical and Important findings in
  `task-8.0b1-review-1.md`; it is not completion or approval evidence.
- B1 remains deliberately fake-provider-only. Native/POSIX/Windows/Job/OCI
  behavior remains owned by B2/B3 and was not inferred from these tests.

## Governed fix round 1 — response to independent review

Base: `b947aaeb`. The controller's review is preserved verbatim and committed
alongside this report. B2 remains locked pending independent re-review.

### Finding-to-change and evidence map

| Finding | Scoped correction | Focused proof |
| --- | --- | --- |
| Critical family bypass | Private intake never invokes family delivery. `deliverNext`/facade `deliverOutput` require the exact opaque SessionOperationAuthorization and assertion, validated through SessionAuthority before intent and immediately before effect. Missing/stale authorization retains bounded bytes and cancels a pre-effect intent rather than fabricating ambiguity. | `private pre-authorized output`, `durable accepted precedes`, `output authorization invalidated`; existing 8.0A current-call/run/session/actor/expiry/revocation/takeover guards remain green. |
| Important 1 output | Commit accepted before queue insertion; terminal unknown; bounded exact consumed history; same-runtime accepted duplicate coalescing; actual additive `subscribeBackpressuredOutput` acknowledgement contract; aggregate accepted capacity. Evidence-only acceptance/consumption is atomic after spool acceptance/loss. | Continuity/digest/offset/stream/zero-length matrix, aggregate capacity, duplicate accepted/consumed, persistent unauthorized output, SQLite eight-boundary crash matrix. |
| Important 2 staging | Issuer-local staged WeakMap; kernel-scoped session/launch reservations; beginTransfer uses the same stage/consume path; complete canonical lease/backend/actor/tool identity checked before atomic adoption. | Cross-issuer/same-session/compatibility reservation; exact binding mutation matrix; consumed grant/alias/revoked/expired checks; 8.0A first-call/fresh-call compatibility. |
| Important 3 host journal | Strict initial/transition history, normative unique effects, state/evidence timing and provenance, full lease binding, expired-owner refusal, in-memory adoption capacity, impossible host/session pair refusal. Repeated cleanup-pending history needs an exact takeover provenance entry. | Impossible history/effects, expired owner, capacity, consecutive pending takeovers, SQLite read-only/tamper/reopen and all six atomic adoption fault seams. |
| Important 4 recovery | Count/time/cancel-bound provider awaits; host rows before sessions; expired host takeover; exact backend/version/capacity/retained-window verification; retained private attachment, restarted private subscription and terminal observer; typed missing proof, no relaunch/wait. | Hung host bounded at 20 ms, exact retained-byte replay, missing retained-byte unknown, deterministic unknown unbound launch. |
| Important 5 cleanup/evidence | Injected spool write/finalize/cleanup lifecycle; truthful spool loss retained; close errors propagated; pre-adoption checkpoint deletion fenced; async frame failures settle session cleanup; authorized stop and private attachment ownership. Adopted cleanup creates a durable intent, verifies exact host cleanup and releases the exact lease before terminal settlement. | Real bounded spool tail overflow, tee write loss, active cancellation all five provider boundaries, stop/finalize/detach, oversized async output, unverified host cleanup blocked, stale checkpoint buffer wipe. |
| Important 6 evidence | Added direct regressions, real-failure TDD, reverted mutation guards, all-table durable scan, bounded persistent output, crash-boundary matrix and final affected gates below. | Exact RED/GREEN ledger and validation commands below. |

### Exact RED/GREEN ledger

All commands run from the shared worktree. Each mutation below was reverted
before the listed GREEN result. No mutation is present in the final diff.
Test pattern commands have the common prefix `npx tsx --test`.

1. Initial direct reviewer reproductions: staged/checkpoint focused run was
   14 pass / 3 fail (cross-issuer reservation, impossible host state, terminal
   checkpoint). The Critical runtime output regression separately failed with
   unauthorized deliveries `1 !== 0`. After repair, all are in the green gate.
2. `--test-name-pattern "issuer-scoped|expired host owner|session capacity is full"
   runner-v2/test/staged-launch-kernel.test.ts`: disabling reservation, expiry,
   and memory-capacity guards produced 0/3 RED (missing expected exception);
   restoring produced 3/3 GREEN.
3. `--test-name-pattern "active-phase cancellation|authorized stop|privately restarts"
   runner-v2/test/streaming-process-session-runtime.test.ts`: disabling failed
   pre-adoption checkpoint removal, spool finalization and reattach subscription
   produced 0/3 RED (checkpoint remains, finalize/evidence count zero); revert
   produced 3/3 GREEN.
4. `--test-name-pattern "aggregate across|invalidated by durable"
   runner-v2/test/streaming-output-checkpoint.test.ts
   runner-v2/test/streaming-process-session-runtime.test.ts`: disabled aggregate
   guards and runtime authorization assertion produced 0/2 RED; restored 2/2.
5. `--test-name-pattern "time bounded"
   runner-v2/test/streaming-process-session-runtime.test.ts`: disabled timeout
   produced a 1,000 ms test timeout; restored timer produced 1/1 GREEN.
6. `--test-name-pattern "continuity, digest|duplicate accepted"
   runner-v2/test/streaming-output-v2.test.ts`: disabling terminalization and
   duplicate coalescing produced 0/2 RED (active vs unknown, pending 2 vs 1);
   restoring produced 2/2 GREEN.
7. `--test-name-pattern "impossible history|finalizeLaunch atomically"
   runner-v2/test/staged-launch-kernel.test.ts`: disabled lifecycle assertion
   and weakened lease/backend comparison produced 0/2 RED; reverted 2/2 GREEN.
8. `--test-name-pattern "real bounded spool"
   runner-v2/test/streaming-output-v2.test.ts`: real spool loss initially yielded
   false vs true; inspect finalized loss flags fix produced 1/1 GREEN.
9. `--test-name-pattern "oversized asynchronous"
   runner-v2/test/streaming-process-session-runtime.test.ts`: initial run failed
   from an unhandled internal delivery rejection after the test. Observing the
   internal promise while preserving rejection propagation produced 1/1 GREEN.
10. `--test-name-pattern "evidence-only stream"
    runner-v2/test/streaming-output-v2.test.ts`: spool hook observed accepted
    count 1 instead of 0; moving the atomic evidence checkpoint after spool
    acceptance/loss produced 1/1 GREEN.
11. `--test-name-pattern "authorized stop"
    runner-v2/test/streaming-process-session-runtime.test.ts`: exact lease
    release count was 0 vs 1. Durable adopted cleanup intent, fenced host
    reconcile, lease release, then settlement produced GREEN. The paired
    oversized-output check was also GREEN (2/2).
12. `--test-name-pattern "unverified adopted"
    runner-v2/test/streaming-process-session-runtime.test.ts`: forcing cleaned
    replay produced released vs cleanup_blocked RED; reverted 1/1 GREEN.
13. `--test-name-pattern "active cancellation at every"
    runner-v2/test/streaming-process-session-runtime.test.ts`: isolation-phase
    abort lost its late-returned lease (release 0 vs 1). Capturing acquisition
    results inside the effect and waiting its cleanup barrier repaired it.
    This and the five-phase live revoker matrix were GREEN 2/2.
14. `--test-name-pattern "stale checkpoint failure"
    runner-v2/test/streaming-output-v2.test.ts`: stale durable settlement left
    pending count 1 vs 0. Local wipe now runs even when the old owner cannot
    mutate the replacement checkpoint; GREEN 1/1, replacement owner unchanged.
15. `--test-name-pattern "persistent unauthorized"
    runner-v2/test/streaming-output-v2.test.ts`: full protocol capacity made
    stderr fail with aggregate capacity exceeded. Atomic post-spool evidence
    acceptance/consumption repaired it; persistent/evidence/aggregate checks
    GREEN 3/3. Four protocol chunks remain bounded at 16 bytes while eight
    evidence chunks drain and no family effect occurs.
16. `--test-name-pattern "durable SQL tables"
    runner-v2/test/staged-launch-kernel.test.ts`: injected scan sentinel made
    the scan RED; removed sentinel produced GREEN 1/1. The initial fixture
    double-close failure was separately corrected and its exact owned temp
    SQLite file/root removed after inspection.
17. `--test-name-pattern "expired pending cleanup supports"
    runner-v2/test/staged-launch-kernel.test.ts`: consecutive takeover failed
    with impossible history; exact takeover-backed pending history repaired it.
    Pending-takeover/blocked-cleanup/impossible-history checks GREEN 3/3.
18. `--test-name-pattern "SQLite crash matrix"
    runner-v2/test/streaming-output-checkpoint.test.ts`: removing consuming-
    intent ambiguity refusal produced missing expected exception RED. Reverted
    GREEN 1/1 across before/after accepted, queue, intent, delivery, consumed,
    and acknowledgement crash snapshots. Each snapshot is reopened from SQLite;
    accepted data replays once, ambiguous intent refuses, consumed data suppresses.

### Final affected validation

Commands (all zero skips/cancellations/failures):

- `npx tsx --test runner-v2/test/staged-launch-kernel.test.ts runner-v2/test/streaming-output-checkpoint.test.ts runner-v2/test/streaming-output-v2.test.ts runner-v2/test/streaming-process-session-runtime.test.ts`
  — 52/52 GREEN after the last crash-matrix addition.
- `npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts runner-v2/test/execution-grants.test.ts`
  — 89/89 GREEN.
- `npx tsx --test runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/execution-isolation-provider.test.ts runner-v2/test/tool-broker.test.ts runner-v2/test/bounded-output-spool.test.ts`
  — 173/173 GREEN: Task 7 127 plus Task 3 spool 46. Includes spill open/write/
  close/artifact failures, bounded tails, cleanup and owned-file identity tests.
- `npm run typecheck:runner-v2` — GREEN.
- Targeted ESLint on the five changed source files and four changed test files
  — GREEN. `git diff --check 6ade2e52` — GREEN (LF/CRLF notices only).

### Scope, residue and recovery audit

- Reviewed the entire source diff and the focused tests. No production adapter,
  CLI/control server/factory, family, Node policy, or Task 7 source changed.
  A static scan of changed source seams found no spawn/execFile/execSync,
  process.kill/taskkill, shell setting, ambient process.env, or exact Node pin.
- Only existing streaming-kernel tables are used; the SQL scan inspects all
  streaming tables and recursively forbidden capability/payload categories.
- Runtime recovery never calls terminal wait or launch. Timeout/abort listeners
  and timers are removed on settlement. Queue cancellation clears owned buffers
  and waiters; subscribed channels are detached/unsubscribed on cleanup. Tests
  finish without dangling async-activity warnings after the oversize repair.
- Final inspected matching temp roots for host journal, adoption, output
  checkpoints/crash snapshots, durable scan and real tee spool: zero.
  No B1 real process, port, container, endpoint or supervisor was created.
- One exact `runner-v2-durable-scan-jkSODe` temp root from the deliberately failing
  fixture held only `sessions.sqlite`; both were inspected and removed with
  explicit nonrecursive paths. This is disposable test data, not user data.
- Recovery/cleanup failure retains durable blocked/unknown ownership instead of
  claiming a clean release. No active source mutation or test injection remains.

### Handoff limits

This is a fake-provider implementation and review-fix evidence, not independent
approval or a production portability claim. All real adapters/family wiring
remain excluded. The controller must independently re-review this fix before
unlocking B2; neither this report nor a green command substitutes for that gate.

## Governed fix round 2 — response to re-review 1

Base: `86304fdb`. Authority: `task-8.0b1-rereview-1.md`. This section supersedes
round-1 claims only for the five reopened findings. B2 remains locked.

### Exact initial RED reproductions

1. Cross-kernel capability: the finalization regression copied the same active
   durable record to a second kernel/SessionAuthority. The foreign authority
   accepted the original token, producing `Missing expected exception` RED.
2. One-deadline/count recovery: a terminal host row failed to consume the bound
   and a pending row was reconciled (`actual pending-a`, expected no outcomes).
3. Late reattach: after a 10 ms recovery timeout, resolving the provider channel
   left detach count 0 vs 1.
4. Non-1 fence: a valid active session/checkpoint at fence 2 failed controller
   construction with `Output controller capacity and ownership must exactly
   match` because the attachment used fence 1.
5. Final evidence: authorized stop returned no evidence (`Cannot read properties
   of undefined (reading 'result')`).
6. Never-settling isolation: caller timed out at 1,000 ms because failure cleanup
   unconditionally awaited the provider effect.

The combined exact command was:
`npx tsx --test --test-name-pattern "startup recovery spends|late reattach|non-one owner|authorized stop surfaces|abort returns promptly" runner-v2/test/streaming-process-session-runtime.test.ts`.
It reported 0/5 passing (four failed, one cancelled by timeout). The cross-kernel
test was separately RED 0/1.

### Corrections and GREEN evidence

- Operation authorizations now live in the issuing SessionAuthority's private
  WeakMap. Matching copied durable state in another kernel cannot validate or
  replay the capability. Existing forged, stale, revoked and expired checks are
  unchanged. Direct cross-kernel test GREEN 1/1.
- Startup reconciliation uses one absolute wall-clock deadline. Every inspected
  terminal/nonterminal host or session consumes the shared count; each await
  receives only remaining time. A late reattach value enters a supervised path
  that creates exact private ownership, detaches/finalizes, settles host+lease
  cleanup, and retains any blocked proof. Total deadline/count and late-channel
  tests are GREEN.
- Attachment construction receives the exact checkpoint owner/fence. Expired
  adopted recovery uses one hidden kernel transaction to re-fence both the
  session and output checkpoint or neither. In-memory exact stale-fence and
  SQLite rollback/reopen tests are GREEN; active fence 2 and expired fence 1→2
  recovery both reattach GREEN.
- Runtime retains the complete tee finalization result by session and authorized
  stop returns `{ record, evidence }`, including loss reasons and artifact ID.
  Finalize error is retained, cleanup still runs, the durable session becomes
  cleanup-blocked, and stop throws rather than claiming proof. GREEN covers a
  full BoundedOutputSpoolResult and injected finalize failure.
- Cancellation no longer awaits a noncooperative effect. It durably blocks the
  exact host owner, returns promptly, and supervises the eventual result; late
  lease/channel resources use the normal fenced cleanup path. Isolation, launch,
  channel and handshake promises that never settle all return within the caller
  bound and retain cleanup_blocked authority. A late isolation lease is released.
- The four-phase noncooperative guard was mutation-proven: disabling the bounded
  cancellation branch made the exact test RED by its 2,000 ms timeout; the
  mutation was reverted and the same test was GREEN in 73 ms.
- The atomic adopted takeover test was first RED with
  `takeoverAdoptedWithOutput is not a function`, then GREEN in memory and SQLite.

### Round-2 final validation

- B1 focused: 61/61 GREEN, zero skips/cancellations/failures.
- Task 8.0A: 89/89 GREEN.
- Task 7 plus Task 3 spool: 173/173 GREEN (127 + 46).
- `npm run typecheck:runner-v2`: GREEN after the final test typing repair.
- Targeted ESLint over all changed B1 source/tests: GREEN after the final repair.
- `git diff --check 86304fdb`: GREEN; scope/static/residue results recorded at
  commit handoff.

### Round-2 scope and handoff

Only SessionAuthority, the existing streaming-session kernel, fake streaming
runtime, focused tests and this evidence changed. No real adapter, CLI/factory,
family, raw process/shell/environment path, second database, OS branch, or Node
policy changed. This is ready only for independent re-review; it does not claim
approval or unlock B2.

## Governed fix round 3 — response to re-review 2

Base: `fb3050a4`. Authority: `task-8.0b1-rereview-2.md`. This section is
limited to the two linked cleanup races and their direct evidence. B2 remains
locked pending independent re-review.

### Exact RED and GREEN evidence

The direct command was:

`npx tsx --test --test-name-pattern="late reattach racing|failed late reattach cleanup|permanently noncooperative|late channel after immediate" runner-v2/test/streaming-process-session-runtime.test.ts`

Before the production repair it reported 0/4 passing. The intended failures
were: blocked late reattach detached 0 vs 1; no observable retained late-cleanup
failure; permanently hung isolation had host reconcile 0 vs 1; and cancelled
late channel cleanup had lease release 0 vs 1. With the scoped repair in place,
the exact same command reports 4/4 GREEN, zero skips/cancellations/failures, in
445 ms. These are real current-code regressions added before implementation;
no mutation guard remains in the tree.

### Corrections

- A late reattach channel is never treated as retained attachment ownership
  until adopted settlement succeeds. Its attachment cleanup now runs in
  `finally`, including when another recovery has already made the durable state
  `cleanup_blocked` or `released`. Attachment detach is idempotently tracked, so
  successful settlement plus the final guard cannot double-detach.
- A failed late detach is retained in a bounded runtime cleanup map, consumes a
  recovery record/count/deadline on retry, and is surfaced by the next recovery
  result with its exact nested failure message. The direct failure test proves
  one failed detach, one successful retry, and no extra successful detach.
- Cancellation first durably blocks the unresolved provider effect, then
  immediately starts independent cleanup for every resource already known:
  attachment/channel and checkpoint, host reconciliation, and the exact lease.
  Those families run concurrently so one noncooperative cleanup cannot prevent
  another known resource from being cleaned. The caller waits only a 100 ms
  bound; timeout is never treated as cleanup proof.
- The unresolved provider effect is supervised separately. A late channel is
  detached even after immediate host/lease cleanup, while exact shared promises
  prevent duplicate lease release or channel detach. A permanently unresolved
  isolate/launch/channel/handshake retains the exact host journal as
  `cleanup_blocked`; it is never claimed empty or released.

### Round-3 validation

- Direct race command above: 4/4 GREEN.
- Full B1 focused command (staged kernel, output checkpoint, output v2, runtime):
  64/64 GREEN, zero skips/cancellations/failures.
- Task 8.0A command (streaming store, SessionAuthority, channel, grants): 89/89
  GREEN, zero skips/cancellations/failures.
- Task 7 plus Task 3 spool command: 173/173 GREEN (127 + 46), zero
  skips/cancellations/failures.
- `npm run typecheck:runner-v2`, targeted ESLint, and `git diff --check
  fb3050a4`: GREEN (line-ending notices only).

### Scope, cleanup, and handoff

Only the fake streaming runtime, its focused test, this report, and the
controller-authored re-review evidence changed. No real adapter, CLI/factory,
family, raw process/shell/environment path, database, OS branch, or Node policy
changed. The full fix diff was self-reviewed; recovery remains count/time/cancel
bounded and no timer/listener/process/spill residue was created. Cleanup failures
retain blocked/observable truth rather than being suppressed. This report does
not claim independent approval or unlock B2.

## Governed fix round 4 — response to re-review 3

Base: `ac6b8035`. Authority: `task-8.0b1-rereview-3.md`. This round changes
only cleanup accounting for the two linked defects. B2 remains locked.

### Exact RED and GREEN evidence

The exact direct command was:

`npx tsx --test --test-name-pattern="late reattach racing|failed late channel detach|successful retry of failed cancelled" runner-v2/test/streaming-process-session-runtime.test.ts`

Before repair it reported 0/3 passing: the blocked reattach race detached twice
instead of once, and both failed late-cancellation detach tests falsely observed
the host journal as `released` instead of `cleanup_blocked`. After repair, the
same command reports 3/3 GREEN, zero skips/cancellations/failures, in 372 ms.
The tests were added before production changes; no mutation remains.

The preservation guard command was
`npx tsx --test --test-name-pattern="noncooperative host reconciliation" runner-v2/test/streaming-process-session-runtime.test.ts`.
Making late cleanup wait for the already-hung immediate reconciliation produced
0/1 RED (detach 0 vs 1). Reverting that mutation and starting the late cleanup
families concurrently produced 1/1 GREEN. The combined final direct run is 4/4
GREEN; the mutation was reverted before broader validation.

### Corrections and accounting proof

- Late reattach settlement failure and resource-cleanup failure are tracked
  separately. A blocked/released durable settlement race followed by successful
  detach creates no retry entry. Both race variants run a later recovery and
  prove detach count remains exactly one with an empty retry result.
- A retry entry now represents only an actually failed channel detach. It owns
  explicit detached/in-flight state: a timed-out cleanup promise is reused, a
  completed detach is never repeated, and an actual rejection permits one later
  bounded retry.
- Cancellation establishes a supervised resource-cleanup barrier before final
  journal settlement. Channel/attachment detach, checkpoint deletion, host
  reconciliation, and lease release all contribute their exact outcomes. Any
  failure forces `cleanup_blocked` and cannot be overwritten by an earlier
  `cleaned` host result or lost when no attachment existed at cancellation.
- Failed cancelled-channel detaches enter the bounded retry queue with their
  launch identity. A failed recovery retry remains blocked and observable. A
  successful retry lets the same recovery re-open the exact blocked journal,
  reconcile it, and release it; a later recovery proves no double detach.

### Round-4 validation

- Direct accounting command: 3/3 GREEN.
- Full B1 focused command: 67/67 GREEN, zero skips/cancellations/failures.
- Task 8.0A: 89/89 GREEN, zero skips/cancellations/failures.
- Task 7 plus Task 3 spool: 173/173 GREEN, zero
  skips/cancellations/failures.
- `npm run typecheck:runner-v2`, targeted ESLint, and `git diff --check
  ac6b8035`: GREEN (line-ending notices only).

### Scope and handoff

Only the fake streaming runtime, its focused test, this report, and the supplied
re-review evidence changed. No adapter, CLI/factory, family, process/shell/env
path, database, OS branch, or Node policy changed. The complete fix diff was
self-reviewed; no timer/listener/process/spill or mutation residue remains.
This is evidence for independent re-review, not approval or a B2 unlock.

## Governed fix round 5 — resource-complete cleanup ownership

Base: `55892af3`. Authority: `task-8.0b1-rereview-4.md`. This final governed
repair is limited to the remaining cleanup-owner/retry defect. B2 remains
locked pending independent approval.

### Root cause and correction

The prior retry queue retained only a late channel capability. Checkpoint
deletion, host reconciliation and isolation release were one-shot local
promises, while a successful channel retry could bypass the durable blocked
guard. Consequently checkpoint-only, lease-only and combined failures could be
falsely released.

The host cleanup effect now contains a strict bounded resource ledger for
`channel`, `output_checkpoint`, `host` and `isolation_lease`. Each fact stores a
digest-safe exact identity, authenticated cleanup owner/fence, attempt count and
`pending`/`succeeded`/`failed` result. Begin, blocked settlement, takeover and
clean settlement validate and preserve these facts. Release is structurally
refused until every required fact is succeeded. Takeover re-fences only
unresolved duties; successful facts retain their original proof and are never
re-executed.

The fake runtime now derives recoverable duties from the durable host lease,
backend binding and output checkpoint. It retries only unresolved facts and
keeps idempotent in-memory channel/resource operations private. A missing
channel capability after restart fails closed while the journal remains owned.
Late isolation acquisition is journaled through an authenticated cleanup-only
binding transition before release. Concurrent revoker, cancellation and
recovery attempts share exact per-launch/per-resource promises, preventing
double detach, release or host cleanup. Durable failure text is bounded and
contains no payload or capability.

### Direct RED/GREEN and mutation proof

The direct command was:

`npx tsx --test --test-name-pattern="checkpoint-only|lease-only|combined cleanup" runner-v2/test/streaming-process-session-runtime.test.ts`

Before production repair it was RED 0/3: checkpoint deletion and lease release
were each called once instead of being retried, and the combined case was
falsely `released` instead of `cleanup_blocked`. After repair it is GREEN 3/3.
The combined case proves a failed channel/checkpoint/lease attempt, a partial
retry that remains blocked, an expired-owner second recovery in a newly created
runtime, final release only after the checkpoint succeeds, and no repeated
successful channel or lease cleanup. The checkpoint-only and lease-only cases
prove their exact durable failed fact is surfaced and retried.

The prior late-cleanup preservation command is GREEN:

`npx tsx --test --test-name-pattern="late channel after|failed late channel|successful retry of failed|noncooperative host" runner-v2/test/streaming-process-session-runtime.test.ts`

The new release guard was mutation-proven by inverting failed-resource
classification. The exact combined test became RED 0/1 because durable cleanup
failure evidence was no longer surfaced. The mutation was reverted; the exact
same command returned GREEN 1/1. No mutation remains.

### Round-5 final validation

- B1 focused (`staged-launch-kernel`, `streaming-output-checkpoint`,
  `streaming-output-v2`, `streaming-process-session-runtime`): 70/70 GREEN,
  zero skips/cancellations/failures.
- Runtime-only final rerun after the last typing repair: 32/32 GREEN.
- Task 8.0A: 89/89 GREEN, zero skips/cancellations/failures.
- Task 7 plus Task 3 spool: 173/173 GREEN, zero
  skips/cancellations/failures.
- `npm run typecheck:runner-v2`: GREEN.
- Targeted ESLint over both changed source files and the changed test: GREEN.
- `git diff --check 55892af3`: GREEN (line-ending notices only).

### Scope, residue and handoff

The production diff is limited to the fake streaming runtime and its existing
single durable streaming kernel; tests are limited to the focused runtime file.
No adapter, CLI/factory, family, raw spawn/kill/shell/environment path, second
database, OS branch or Node policy changed. Static scanning found no spawn,
exec, process kill, taskkill, shell, ambient environment or exact Node pin in
the changed surfaces.

No B1 host-journal, adoption, output-checkpoint, crash-snapshot or tee-spool
temporary root remains. The global temp directory contains older Task 7
fault-fixture roots last written before this round; they were not created,
modified or deleted by this repair. This report and the supplied re-review-4
file are force-added with the implementation commit. This is implementation
evidence only; independent final re-review remains mandatory and B2 is not
unlocked here.

## Exceptional repair round 6 — kernel-complete cleanup and closed failures

Base: `c6a5c5be`; authorized by
`task-8.0b1-exceptional-round-6-brief.md`. Entry controller HEAD was
`a213317c`. This section owns only the two remaining Important findings and
does not claim approval or unlock B2.

### Root cause and correction

R6.1 root cause was split durability authority: the fake runtime assembled a
caller-provided cleanup subset while the host reducer accepted that subset as
the whole ledger. The parser authenticated unresolved facts against any owner
in takeover history. Therefore the kernel could neither prove complete cleanup
membership nor require the current owner/fence for every unresolved duty.

The existing streaming kernel now derives the exact ledger from authenticated
host facts. Every non-handoff host owns `host`; a durable lease owns
`isolation_lease`; a durable pre-effect channel marker owns `channel`; and an
atomically linked host/checkpoint marker owns `output_checkpoint`. Identities
are computed inside the kernel from immutable launch/session/lease/backend
facts. `begin_cleanup` no longer needs caller definitions; if compatibility
definitions are supplied, their kind/identity set must equal the derived set.
The generic checkpoint claim refuses a pre-adoption host, while the hidden
host-checkpoint claim atomically writes the checkpoint and marker in memory or
one SQLite transaction. A valid-HMAC pre-marker checkpoint from unsafe older
active data is refused on read and transition without mutation.

Parser and reducer validation require the exact derived facts. Pending and
failed facts must carry the exact current cleanup owner/fence; succeeded facts
retain authenticated historical proof. Takeover changes host/effect ownership
and re-fences every and only unresolved duty in one parsed row update.
Settlement outcomes carry their exact owner/fence and must name every and only
unresolved duty. Missing, extra, duplicate, wrong-kind, wrong-identity,
wrong-owner, stale-fence, and already-completed results fail before write.
Release is impossible until the exact derived ledger is entirely succeeded.

R6.2 root cause was `durableFailureMessage()`: truncation bounded arbitrary
provider text but did not make it safe. Resource failures and blockers now use
a closed `HostCleanupFailureCode` plus the one fixed Runner-owned message for
that code. The closed set distinguishes channel detach, checkpoint deletion,
host reconciliation, host outcome unknown, lease release,
timeout/cancellation, and unknown internal cleanup. Parser keys and exact
code/message pairing are strict. Runtime control flow uses
`host_outcome_unknown` rather than regex inspection. Aggregate children,
causes, stack/message text, arbitrary thrown values, path/env/argv/payload/
endpoint data are discarded at classification; late cleanup results and
caller-facing cleanup errors expose only fixed Runner-owned typed data.

### Direct RED/GREEN evidence

Initial exact command:

`npx tsx --test --test-name-pattern="channel-only cleanup|historical owner|provider-controlled credential" runner-v2/test/staged-launch-kernel.test.ts runner-v2/test/streaming-process-session-runtime.test.ts`

Before production changes it was RED 0/3: the channel-only assertion wrote
instead of throwing; an `o1/1` unresolved fact parsed in an `o2/2` cleanup; and
the serialized host row contained
`payload=credential=B1_R6_PRIVATE_SENTINEL`. After repair the same command was
GREEN 3/3.

The valid-HMAC reopen regression was added before its link guard. Exact command
`--test-name-pattern="pre-marker output checkpoint"` was RED 0/1 because
`readHostLaunch` accepted the unsafe active pair. After the cross-table kernel
guard it was GREEN 1/1 and the SQLite host row remained `bound` after refused
read and transition attempts.

The adopted caller sentinel was also test-first. Exact command
`--test-name-pattern="adopted cleanup never exposes"` was RED 0/1 with the
nested AggregateError graph containing credential, payload and argv sentinels;
the fixed typed boundary made it GREEN 1/1.

The cleanup matrix proves four hand-derived literal identities, exact fact
membership, partial then final settlement, preservation/no-repeat of three
successes, two consecutive takeovers, current result fencing, and final release
only after the last duty succeeds. Memory and SQLite sentinel tests scan
serialized host/session/output state and every `streaming_%` table cell;
credential, token, env, argv, absolute-path, endpoint, payload, aggregate,
cause, and arbitrary-value sentinels are absent after failure and after reopen.
The SQLite test recomputes a valid HMAC over a mismatched fixed message and
proves parser refusal.

### Mutation evidence

All mutations used `apply_patch`, were reverted, and their exact checks were
rerun GREEN before final gates:

1. Weakening exact-set length comparison made channel-only/matrix checks RED
   0/2 (`Missing expected exception`); revert was GREEN 2/2.
2. Disabling current-owner fencing made the historical-owner parser check RED
   0/1; revert was GREEN 1/1.
3. Removing exact code-to-message validation made parser plus valid-HMAC reopen
   RED 0/2; revert was GREEN 2/2.
4. Forcing every classifier result to `unknown_internal_cleanup_failure` made
   the four-resource sentinel/classifier check RED 0/1; revert was GREEN 1/1.

No mutation marker or injected sentinel remains in production or durable test
state.

### Final validation

All final commands completed with zero failures, skips, or cancellations:

- B1 focused (`staged-launch-kernel`, `streaming-output-checkpoint`,
  `streaming-output-v2`, `streaming-process-session-runtime`): 79/79 GREEN.
- Task 8.0A (`streaming-session-store`, `session-authority`,
  `interactive-process-channel`, `execution-grants`): 89/89 GREEN.
- Task 7 plus Task 3 spool (`process-backend-contract`,
  `durable-process-store`, `subprocess-runtime`,
  `execution-isolation-provider`, `tool-broker`, `bounded-output-spool`):
  173/173 GREEN.
- `npm run typecheck:runner-v2`: GREEN.
- Targeted ESLint over both changed source and both changed test files: GREEN.
- `git diff --check c6a5c5be`: GREEN (line-ending notices only).

The first broad B1 attempt exposed one stale assertion that expected raw
grant-revocation wording after the fixed caller boundary. Its exact test was
updated to require the typed runtime code, rerun GREEN 1/1, then the complete
B1 gate above was rerun GREEN 79/79.

### Scope, rollback, and residue audit

The production diff is limited to the fake streaming runtime and the sole
existing streaming-session kernel. No adapter, CLI/control server/factory,
child family, native/POSIX/Windows/Job/OCI path, raw spawn/kill/shell/
environment seam, OS product branch, second database, or Node policy changed.
Static added-line scanning found no `spawn`, `execFile`, `execSync`, process
kill, taskkill, shell option, ambient `process.env`, child-process import, or
exact Node pin.

SQLite marker creation rolls back both rows on any pre-commit failure; all
takeover facts live in one parsed/HMAC-protected host row, so a failed parse or
CAS writes no partial re-fence. Tests close every SQLite handle and remove only
their owned temporary root in `finally`. Final inspection found no matching R6
sentinel/host/adoption temp root, spill, timer, listener, process, port,
endpoint, container, or active mutation. The complete fix diff was reviewed
for caller-defined membership, unsafe text copies, and false release paths.

This is implementation and self-verification evidence only. The controller
must dispatch the required fresh independent scoped re-review and rerun current
gates before any B2 unlock decision.

## Repair round 7 — active-schema boundary and unforgeable errors

Base: `2643cf75`; entry implementation head: `ac7d837f`; authorized entry HEAD:
`014bda7b`. Authority: `task-8.0b1-round-7-brief.md` and
`task-8.0b1-exceptional-round-6-review.md`. This repair is limited to the two
reproduced residual paths and does not claim approval or unlock B2.

### Root cause and correction

R7.1 root cause was a generation ambiguity. Round 6 added optional marker
fields to host-launch schema 1, so a valid-HMAC schema-1 `bound` row with a
lease/backend and no markers could represent either a real pre-channel crash or
an older post-acquisition crash. The reducer treated absence as proof that no
channel duty existed and could release the row after only host and lease facts.

Host-launch schema 2 is now the explicit marker-aware generation. Every new
runtime launch and fixture uses the exported current generation. Schema-1
active rows are rejected as `unsupported_active_version` before parsing,
cleanup derivation, transition, adoption, or recovery. SQLite list validates
each row through the same HMAC/version reader; read, list, transition and reopen
therefore share the refusal boundary. No legacy contents are copied or upgraded.
The exact raw JSON, revision, HMAC, owner and backend binding remain unchanged
after every refused operation, including databases with before- and after-write
fault triggers.

Within schema 2, a pre-channel `bound` row remains valid and owns exactly host
plus any durable lease. `begin_channel` remains the pre-effect marker. Marker
history must contain channel then checkpoint repeats in that order; swapped or
backdated marker identities are rejected. Handshake/later history requires both
markers, so no later state can omit them. The existing checkpoint/host atomic
link, HMAC, cleanup ledger and adoption transaction remain the sole durable
authority.

R7.2 root cause was treating the public exported error class as provenance.
Providers could construct or subclass it with arbitrary message/cause data and
both normal and cancellation catches rethrew it unchanged. The class remains
exported for API compatibility, but only a module-private factory enrolls an
error in a module-private `WeakSet`. Every internal creation site uses that
factory; trust checks and cleanup timeout classification require membership.
Public instances, subclasses, lookalikes, cross-realm errors, aggregates and
arbitrary thrown values are foreign regardless of their name/code/prototype.

Isolation, launch, channel, handshake, output-start, cleanup, recovery and
cancellation edges now retain only fixed Runner-owned code/message data.
Injected output delivery is classified before it reaches the output controller;
the public facade unwraps only the privately minted fixed error, with no foreign
cause. Genuine private cancellation, bounded-timeout/launch, handshake,
lossless-output and cleanup errors retain their prior safe distinctions. The
round-6 closed durable cleanup code/message mapping is unchanged.

### Exact RED/GREEN evidence

The first exact command was:

`npx tsx --test --test-name-pattern="ambiguous legacy bound host|provider-created exported runtime errors" runner-v2/test/staged-launch-kernel.test.ts runner-v2/test/streaming-process-session-runtime.test.ts`

Before production edits it was RED 0/2. The host reproduction printed exactly
`{"state":"released","ownerId":"none","backendRetained":true}`. The provider
reproduction returned message
`credential=B1_R7_TYPED_PROVIDER_SENTINEL` with its payload-bearing cause.
After repair, the exact two regressions are GREEN 2/2.

The expanded R7.1 command matched `ambiguous legacy bound host`,
`marker-relevant active legacy`, `new host generation`, `marker history`, and
`valid-HMAC legacy rows`. It was RED 0/5: all six marker-relevant old active
boundaries parsed, markerless handshake advanced, marker order was swappable,
and HMAC read/list accepted the old row. It is GREEN 5/5. The full staged kernel
is GREEN 28/28. Coverage includes old bound/no-marker, bound/channel,
checkpoint-linked, handshake-verified, cleanup-pending and cleanup-blocked rows;
new pre-channel exact duty derivation; ordered channel/checkpoint progress;
SQLite valid-HMAC read/list/transition/reopen refusal; byte/HMAC/revision/owner
preservation; before/after write triggers; adoption faults; and crash/reopen.

The expanded R7.2 command matched `provider-created exported runtime errors`,
`foreign error shapes`, and `internally minted runtime errors`. Before repair it
reported 1/4 GREEN: the two foreign-boundary tests and exact exported-instance
test were RED, while the internal fixed-distinction test was already GREEN.
After repair it is GREEN 4/4. The matrix injects exported instances, subclasses,
lookalikes, aggregates, arbitrary objects and cross-realm errors at isolation,
host launch, channel acquisition, handshake, output start, output delivery,
cleanup and cancellation. Recursive caller/durable scans contain no credential,
token, environment, argv, absolute-path, payload, aggregate-child or foreign
cause sentinel. The full runtime is GREEN 40/40. A follow-up output-boundary
assertion was RED because the fixed Runner error was nested under
`StreamingOutputError`; the facade boundary correction made the same exact
check GREEN with a top-level fixed `launch_failed` error and no cause.

### Mutation evidence

All mutations were made with `apply_patch`, run against the exact guard, reverted,
and rerun GREEN before broad validation:

1. Allowing schema 1 through the active-version condition made the exact legacy
   test RED 0/1 and again reached `released`/`none` with the backend retained.
   Revert was GREEN 1/1.
2. Removing both the transition and parser later-marker guards made the exact
   new-generation marker test RED 0/1 (`Missing expected exception`). Revert was
   GREEN 1/1.
3. Restoring the normal-catch `instanceof StreamingProcessSessionError` bypass
   made the exact provider-created test RED 0/1 with its credential message.
   Revert was GREEN 1/1.
4. Removing the private `WeakSet.has()` validation guard produced the same exact
   sentinel RED 0/1. Revert was GREEN 1/1.

No mutation, schema-1 exception, or production sentinel remains.

### Validation, scope, and residue

Required commands completed with zero failures, skips, or cancellations:

- B1 focused (`staged-launch-kernel`, `streaming-output-checkpoint`,
  `streaming-output-v2`, `streaming-process-session-runtime`): 88/88 GREEN.
- Task 8.0A (`streaming-session-store`, `session-authority`,
  `interactive-process-channel`, `execution-grants`): 89/89 GREEN.
- Task 7 plus Task 3 spool (`process-backend-contract`,
  `durable-process-store`, `subprocess-runtime`,
  `execution-isolation-provider`, `tool-broker`, `bounded-output-spool`):
  173/173 GREEN.
- `npm run typecheck:runner-v2`: GREEN.
- Targeted ESLint over both changed source and both changed test files: GREEN
  after one exact test-only `prefer-const` correction.
- `git diff --check 2643cf75`: GREEN (line-ending notices only).

The production diff is limited to the existing streaming-session kernel and
fake streaming runtime. Tests are limited to their two focused files. Static
added-line scanning found no adapter/CLI/factory/family, child-process import,
spawn/kill/exec, shell/environment access, OS product branch, second database,
or exact Node patch pin. The existing SQLite tables remain the only durability
surface.

All SQLite handles close in `finally`; each test removes only its owned temporary
root. Final inspection found zero R7 legacy-bound/refusal, host-boundary,
host-launch or adoption temp roots. The fake-only tests create no real child,
port, endpoint, container or supervisor. Existing bounded timers/listeners,
queues, channel detach and output-spool cleanup checks remain green; no active
mutation, spill or retained provider sentinel remains. The complete fix-only
source/test diff was self-reviewed before commit.

This is implementation evidence for the controller's required fresh independent
scoped re-review. It is not approval and does not unlock Packet 8.0B2.

## Repair round 7 follow-up — immutable error replay claims

Entry HEAD: `6f1ed963`; reviewed implementation: `392804c4`. Authority:
`task-8.0b1-round-7-review.md`. This follow-up addresses only the remaining
same-object replay finding. The independently approved schema-generation
boundary is unchanged.

### Root cause and correction

The round-7 private `WeakSet` established where an error object was first
created, but did not preserve what Runner originally claimed. The public
`StreamingProcessSessionError` object remained mutable after reaching a caller.
A caller could retain a genuinely enrolled object, replace its public `code`,
`message`, and `cause`, and return that same object through a provider. Set
membership survived, so normal and cancellation catches rethrew the object;
the delivery facade also unwrapped an enrolled cause without changing identity,
and cleanup classification read the mutated public code.

The exported class remains unchanged as API shape. Module-private provenance is
now a `WeakMap` from each Runner-minted error to a frozen private claim containing
its original closed code and fixed message. No trust decision reads public
fields. A single private remint operation looks up those claims and creates a
new cause-free Runner error. Normal, cancellation, bounded-provider, output
facade, channel callback, late-resource, and cleanup retry boundaries remint
enrolled errors instead of rethrowing or unwrapping their identity. Cleanup
classification uses only the private claim. Foreign instances and shapes still
fail membership and retain the existing phase-owned fixed mappings.

### Exact RED/GREEN evidence

The exact real regression was added before production changes and run with:

`npx tsx --test --test-name-pattern="replayed Runner errors" runner-v2/test/streaming-process-session-runtime.test.ts`

It was RED 0/1 at the first normal-launch assertion: the returned value was the
same retained object and its rendered graph contained
`credential=B1_R7_REPLAY` plus the injected payload cause. After correction the
exact command is GREEN 1/1. The test obtains real Runner-minted errors through a
public recovery-bound failure, mutates all three public fields, and replays them
through normal launch, cancellation, output delivery, and host-cleanup
classification. Normal and cancellation return new objects with the original
`launch_failed` / `Recovery count bound is invalid.` private claim and no cause.
Delivery returns a new phase-owned `launch_failed` /
`Streaming output delivery failed.` error. Cleanup retains the original private
`launch_failed` classification as the fixed durable
`cleanup_timeout_or_cancelled` fact. Recursive caller and durable graphs contain
no replay sentinel.

The affected provenance command matching `replayed Runner errors`,
`provider-created exported runtime errors`, `foreign error shapes`, and
`internally minted runtime errors` is GREEN 5/5. The complete streaming runtime
is GREEN 41/41.

### Mutation evidence

Both mutations were made with `apply_patch`, exercised against the exact replay
test, reverted, and rerun GREEN:

1. Returning the enrolled object itself from the remint helper was RED 0/1 at
   `normal must not return the replayed object`. Revert was GREEN 1/1.
2. Retaining membership but reconstructing claims from the public `code` and
   `message` fields was RED 0/1: the caller received mutated `cleanup_blocked`
   and `credential=B1_R7_REPLAY` values instead of the original private claim.
   Revert was GREEN 1/1.

No mutation branch, old `WeakSet`, public-field authority check, or mutation
marker remains.

### Validation, scope, and residue

All final commands completed with zero failures, skips, or cancellations:

- B1 focused (`staged-launch-kernel`, `streaming-output-checkpoint`,
  `streaming-output-v2`, `streaming-process-session-runtime`): 89/89 GREEN.
- Task 8.0A (`streaming-session-store`, `session-authority`,
  `interactive-process-channel`, `execution-grants`): 89/89 GREEN.
- Task 7 plus Task 3 spool (`process-backend-contract`,
  `durable-process-store`, `subprocess-runtime`,
  `execution-isolation-provider`, `tool-broker`,
  `bounded-output-spool`): 173/173 GREEN.
- `npm run typecheck:runner-v2`: GREEN.
- Targeted ESLint over the changed source and test: GREEN.
- `git diff --check 6f1ed963`: GREEN (line-ending notices only).

The production and test diff is confined to the existing fake streaming
runtime and its focused test. The schema store and its approved generation-2
boundary have no diff in this follow-up. Static added-line scanning found no
adapter/CLI/factory/family, child-process import, spawn/kill/exec, shell or
environment access, OS product branch, second database, exact Node patch pin,
or mutation marker. The replay test uses fake providers only and creates no
process, port, endpoint, container, database, or temporary root. The broad B1
tests closed their SQLite stores and final residue scanning found zero matching
Runner B1 temporary roots. Final diff inspection found no foreign cause/detail
copy, public-field trust, same-object Runner error return, or schema-boundary
change.

This is implementation evidence for the controller's required fresh scoped
re-review. It is not approval and does not unlock Packet 8.0B2.
