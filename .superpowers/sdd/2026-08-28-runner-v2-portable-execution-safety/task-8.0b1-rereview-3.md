# Task 8.0B1 fix round 3 re-review

## Verdict

- **NOT APPROVED**
- Critical remaining: 0
- Important remaining: 2 linked cleanup-accounting defects
- Task 8.0B2 remains locked.

## Important findings

### 1. Successfully detached late channel is scheduled for a second detach

When durable settlement fails because another recovery already blocked/released
the session, that settlement error is combined with cleanup errors even if the
`finally` detach succeeds. The code then stores the raw channel in the late
cleanup queue, and the next recovery detaches it again. The regression waits only
for the first detach and does not run another recovery to prove the queue empty.

Evidence: `streaming-process-session-runtime.ts:244,282,288` and
`streaming-process-session-runtime.test.ts:210` at `ac6b8035`.

Required: separate durable settlement failure from resource-cleanup failure.
Successful detach transfers no cleanup work to a retry queue. A retry entry must
represent only a resource whose cleanup actually failed and must carry enough
idempotent state to avoid double-clean. Test a subsequent recovery and exact
detach count one for both blocked and released races.

### 2. Failed late detach can be suppressed while journal becomes released

During cancellation in channel acquisition, late cleanup rejection can be
discarded because no attachment existed at cancellation time. Cleanup records
the detach failure but still settles using an earlier host `cleaned`
disposition, allowing the durable launch journal to transition to released even
though the late channel remains live. Existing tests cover only successful late
detach.

Evidence: `streaming-process-session-runtime.ts:153,182,219` and
`streaming-process-session-runtime.test.ts:304`.

Required: final durable settlement must combine every exact resource cleanup
outcome. Any channel/checkpoint/host/lease cleanup failure produces durable
blocked ownership/evidence and cannot be overwritten by an earlier host-cleaned
result. The supervised late path may report via durable state rather than throw,
but it cannot suppress or falsely release. Add RED/GREEN failed-late-detach and
retry/idempotency tests.

## Evidence disposition

Round-3 exact RED/GREEN command evidence is present and the supplied 4/4 race,
64/64 B1, typecheck, and diff checks pass. Those tests do not cover the two
remaining paths. Route these linked defects to the original implementer as
governed fix round 4/5, then independently re-review.
