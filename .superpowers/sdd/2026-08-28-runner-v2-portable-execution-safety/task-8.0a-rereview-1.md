# Task 8.0A fix round 1 re-review

## Verdict

**Open finding remains.** Findings 1, 2, 3, 4, 5, 7, and 8 are addressed. Finding 6 is **NOT ADDRESSED** because the new lease rules strand an adopted `cleanup_pending` effect after its owner lease expires. This is one Important correctness/durability regression in the fix diff, so Task 8.0A still needs fixes and packet 8.0B may not begin.

## Original findings in order

1. **ADDRESSED — grant expiry outside ToolBroker skips revokers.** `assertCurrentConsumedExecutionGrantClaims()` now reports `grant_expired` without mutating grant lifecycle state (`runner-v2/src/execution-grants.ts:304-314`), leaving `revoke()`/`revokeAll()` as the revocation paths. The regression registers a real revoker, observes expiry, and proves ToolBroker revocation runs it exactly once (`runner-v2/test/execution-grants.test.ts:158-186`).

2. **ADDRESSED — interactive registry lacks exact call/access authorization facts.** Interactive write/control/family requests now carry both the opaque `SessionOperationAuthorization` and complete `OperationAuthorizationAssertion`, and the registry callback accepts those exact facts (`runner-v2/src/interactive-process-channel.ts:80-129`). Every gate checks request session/operation before delegating the complete assertion (`runner-v2/src/interactive-process-channel.ts:597-614`). The regression wires the registry to the real `SessionAuthority.assertOperationAuthorization()` and completes an exact bound write (`runner-v2/test/interactive-process-channel.test.ts:64-115`).

3. **ADDRESSED — family output delivery is authorized only once.** The subscription rechecks current attachment, release state, fence, and full operation authorization for every backend callback, then stops and unsubscribes fail-closed on rejection (`runner-v2/src/interactive-process-channel.ts:359-378`, `runner-v2/src/interactive-process-channel.ts:616-635`). Regressions cover ToolBroker revocation, source-grant expiry, fenced takeover, and lifecycle release (`runner-v2/test/interactive-process-channel.test.ts:393-468`).

4. **ADDRESSED — concurrent writes and mutable payload break ordered/digest-bound input.** The registry snapshots payload bytes at API entry and serializes each attachment's writes through a settled tail (`runner-v2/src/interactive-process-channel.ts:262-315`, `runner-v2/src/interactive-process-channel.ts:478-500`). Sequence is reserved before backend acknowledgement. The blocking-channel regression proves one in-flight write, rejection of a concurrent duplicate sequence, and delivery of the original copied bytes after caller mutation (`runner-v2/test/interactive-process-channel.test.ts:540-578`).

5. **ADDRESSED — mutable/stale attachment fencing can replace or leak a newer channel.** Attach/reattach clone binding and fence evidence, serialize attachment changes, accept only a strictly newer replacement fence, detach the displaced capability, and detach rejected stale returned capabilities (`runner-v2/src/interactive-process-channel.ts:197-260`, `runner-v2/src/interactive-process-channel.ts:503-595`). The regression mutates caller evidence, replaces with a newer fence, rejects stale attach and reattach, and verifies both rejected capabilities were detached while the newer channel remains current (`runner-v2/test/interactive-process-channel.test.ts:207-280`).

6. **NOT ADDRESSED — durable ownership lease enforcement strands pending cleanup recovery.** The new reducer permits takeover only from adopted states without pending cleanup and explicitly rejects `cleanup_pending` (`runner-v2/src/streaming-session-store.ts:867-883`). At the same time, every non-takeover SessionAuthority mutation at or after lease expiry is rejected (`runner-v2/src/streaming-session-store.ts:884-886`). `recoverAdopted()` supports `cleanup_pending`, replays its exact effect, and must then call `mark_cleanup_blocked` or `acknowledge_cleanup` (`runner-v2/src/session-authority.ts:468-523`); after expiry, both mutations now fail and takeover is unavailable. A host crash after `begin_cleanup` therefore leaves the sole pending cleanup effect permanently unrecoverable, violating durable SessionAuthority cleanup ownership and exact effect replay/ack. The new test positively asserts cleanup-state takeover refusal but never attempts recovery of that pending effect after expiry (`runner-v2/test/streaming-session-store.test.ts:654-698`). This is an **Important** durability/cleanup regression.

7. **ADDRESSED — strict parser accepts forged effect owner/fence combinations.** State validation now requires ToolBroker-owned transfer evidence, exact pending/ambiguous fences, transfer fences no newer than the adopted owner, exact cleanup owner/fence in pending/blocked states, and release evidence matching the pre-release cleanup owner (`runner-v2/src/streaming-session-store.ts:684-774`). The regression covers forged transfer and cleanup evidence plus a valid provider-lease release path (`runner-v2/test/streaming-session-store.test.ts:90-156`).

8. **ADDRESSED — session-ID collision consumes a grant and aliases an unrelated record.** Memory and SQLite claims compare complete immutable session identity and throw typed `identity_conflict` rather than returning an unrelated record (`runner-v2/src/streaming-session-store.ts:201-227`, `runner-v2/src/streaming-session-store.ts:305-332`). SessionAuthority performs its immutable transfer-identity check before call-key checking and grant consumption, returning typed `session_collision` on mismatch (`runner-v2/src/session-authority.ts:204-261`, `runner-v2/src/session-authority.ts:790-813`). Regressions cover both stores and prove different-call and same-call/different-lease collision grants remain consumable (`runner-v2/test/streaming-session-store.test.ts:278-301`, `runner-v2/test/session-authority.test.ts:78-130`).

## New Critical/Important breakage in the fix diff

- **Important:** the unrecoverable expired `cleanup_pending` state described under finding 6. No other new Critical/Important issue was found in the scoped fix diff.

## Evidence review

The appended Fix Round 1 report contains a named regression, RED failure, minimum fix, and focused GREEN result for each of the eight findings. It also records fresh results for the four focused files (`82` tests), affected Task 7 compatibility files (`107` tests), Runner V2 typecheck, targeted lint, `git diff --check`, and fix-round temp-root cleanup. I did not rerun those suites because the open finding is established directly by the new reducer and recovery control flow.

## Out-of-scope observations

None recorded.

## Assessment

**Specification compliance: Needs fixes.** Seven original findings are addressed; finding 6 remains open as one Important issue.

**Task code quality: Needs fixes.** The fix round materially improves authorization, write ordering, attachment fencing, parser closure, collision safety, and ToolBroker lifecycle ownership, but cleanup recovery after lease expiry must be made durable before approval.
