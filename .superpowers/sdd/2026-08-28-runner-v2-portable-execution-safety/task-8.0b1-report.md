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
