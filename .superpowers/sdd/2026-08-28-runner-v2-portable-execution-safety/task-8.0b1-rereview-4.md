# Task 8.0B1 fix round 4 re-review

## Verdict

- **NOT APPROVED**
- Critical remaining: 0
- Important remaining: 1 cleanup-owner/retry defect
- Task 8.0B2 remains locked.

## Addressed

Settlement and cleanup failures are now separated. A successful late detach
after a blocked/released settlement race is not queued or detached twice, and
the second-recovery tests pass.

## Important — retry ownership tracks only the channel

`cleanupKnownResources()` gathers channel detach, checkpoint deletion, host
reconcile and lease release results, but `PendingLateCleanup` stores only a
channel plus launch ID. Only detach failure creates retry state and recovery
retries only detach. After channel retry, `resolvedLateLaunches` bypasses the
blocked guard and can mark the journal released after host reconcile without
retrying a failed checkpoint deletion or lease release.

This permits false release for combined failures and lost cleanup ownership for
checkpoint-only or lease-only failure after expiry. The new tests cannot inject
checkpoint deletion or lease release failure, so the required matrix is absent.

Evidence: `streaming-process-session-runtime.ts:165-186,258-278` and
`streaming-process-session-runtime.test.ts:331-357` at `55892af3`.

## Final governed repair requirement

Fix round 5/5 must use a resource-complete cleanup ledger/bundle. It must retain
and retry every failed exact resource (channel, checkpoint, host reconciliation,
lease) independently and must permit durable released settlement only when all
required cleanup facts are proven. No channel-only resolved marker may bypass
another resource failure. Add direct RED/GREEN tests for checkpoint-only,
lease-only and combined failures, partial retry, final retry, expiry/restart, no
double cleanup and no false release. Preserve durable blocked ownership between
attempts. An independent final re-review is mandatory.

Fresh verification before this ruling: direct race tests 4/4, full B1 67/67,
typecheck, targeted ESLint and diff check green; worktree clean.
