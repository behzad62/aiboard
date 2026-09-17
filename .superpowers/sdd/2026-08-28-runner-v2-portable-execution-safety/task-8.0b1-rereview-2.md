# Task 8.0B1 fix round 2 re-review

## Verdict

- **NOT APPROVED**
- Critical remaining: 0
- Important remaining: 2 implementation gaps plus direct-evidence closure
- Task 8.0B2 remains locked.

## Finding disposition

- Critical issuer-local operation authorization: **ADDRESSED**. Each
  SessionAuthority now owns its authorization WeakMap; copied durable state in a
  foreign kernel cannot validate the capability.
- I1 absolute recovery deadline/count: **PARTIALLY ADDRESSED**. One deadline and
  a shared inspected-record count exist, but a late reattach cleanup race leaks.
- I2 non-1 fence and atomic session/checkpoint re-fence: **ADDRESSED** in memory
  and SQLite, including rollback.
- I3 finalized spool result/loss/artifact/error: **ADDRESSED** and surfaced.
- I4 permanently hung provider cancellation: **PARTIALLY ADDRESSED**. Caller
  return is bounded, but already-known resources remain uncleaned.
- I5 direct evidence: **OPEN** for the two residual races and exact report command.

## Important findings

### 1. Late reattach cleanup can leak after durable state becomes blocked/released

The late callback creates an attachment, then attempts adopted settlement. If a
different recovery has already moved the session to `cleanup_blocked` or
`released`, settlement throws before detach. The fallback detach is skipped
because the attachment object exists, and the late cleanup rejection is
suppressed. Direct reproduction after a 10 ms timeout and a durable blocked
transition observed zero detaches and releases.

Evidence: `streaming-process-session-runtime.ts:253-255,305` at `fb3050a4`.

Required: resource ownership must transfer to the retained attachment only after
successful settlement. Every late result that cannot be adopted must detach and
perform exact cleanup in `finally`, even when durable state changed meanwhile;
cleanup rejection remains observable/durable.

### 2. Permanently hung effects defer cleanup of already-known resources forever

Cancellation marks the journal blocked and schedules `cleanupOpenResources()`
only after `activeEffect` settles. For a permanently hung launch/channel/
handshake, that callback never runs, so an already acquired channel, checkpoint,
lease and host child remain. A hung-handshake reproduction returned promptly but
observed zero detach/release/reconcile and a remaining checkpoint.

Evidence: `streaming-process-session-runtime.ts:156-165,199`.

Required: caller-bounded cancellation must immediately attempt bounded cleanup
of resources already known at cancellation, independently supervise any late
result from the still-running provider effect, and retain truthful durable
blocked/unknown ownership where the unresolved effect cannot be proven empty.
It must never wait indefinitely, double-clean, or treat a timeout as proof.

### 3. Direct evidence closure

Add RED/GREEN tests for late reattach racing blocked and released states and for
permanently hung launch/channel/handshake with assertions over known channel
detach, host reconcile, lease release, checkpoint settlement and durable owner.
The implementation report must include the exact covering GREEN command/result,
not only the aggregate count.

## Fresh verification

- Focused B1: 61/61 green.
- Task 8.0A: 89/89 green.
- Task 7 + Task 3 spool: 173/173 green.
- Typecheck, targeted ESLint, and diff check: green.

Route the three linked findings to the original implementer as governed fix
round 3/5, then independently re-review the fix-only diff.
