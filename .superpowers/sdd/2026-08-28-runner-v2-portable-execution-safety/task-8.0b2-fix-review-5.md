# Task 8.0B2 Fresh Re-review — Fix Round 4

Range reviewed: `e5f0c59c..0fcf491b`

## Verdict

**CHANGES REQUIRED — B2 remains locked.**

Zero Critical findings. Two Important gaps remain. Every preceding B2 finding,
including portable/macOS absence classification, native/portable retirement,
PID-reuse cleanup, and positive residue ownership, is addressed.

## Remaining Important findings

1. **Important — Job release-finalization failure is unrecoverable and leaves
   live coordination residue.** `releaseOwned()` persists
   `backendOwnershipReleasedAt` inside the fenced effect. If SQLite finalization
   then fails, the external Job record says released while the committed lock
   holder remains. A retry returns success immediately from the durable released
   record and never cleans the lock. Review injected a `BEFORE DELETE` failure
   and observed `releasedDurable true`, one holder, a successful second release,
   and the same holder/residue afterward. A release queued before the first
   commit can also bypass active-record gating because `release` is explicitly
   excluded from `assertActive()` inside `withFenceEffect()`.
2. **Important — semantic cleanup does not inspect the closed global set of
   command-line-referencing processes.** `inspectProbeOwnership()` inventories
   only PIDs already present in stale identity/state evidence and checks root
   references only in that subset. Review added a live, unlisted process whose
   command line referenced the exact root. Cleanup stopped the authenticated
   supervisor and deleted the root while the unlisted referring process remained
   live. Required no-live-reference proof must come from a bounded global process
   inventory, not the stale recorded-owner subset.

## Addressed matrix and fresh evidence

- Generic POSIX/macOS ESRCH/live/birth/EPERM/tool/race handling: addressed;
  deterministic contract proof is honest and no macOS runtime claim is made.
- Portable/native authority-local retirement, stale-call refusal, sidecar cleanup,
  and authenticated retired cleanup retry: addressed.
- Original timed-out supervisor/PID-reuse leak: addressed; the global reference
  closure is the remaining semantic-cleanup gap above.
- Closed registered residue prefixes and positive ownership proof: addressed.
- Optional Job, portable-first semantics, earlier six B2 fixes, Node 22.13/24
  range, unchanged production deadlines, and no B3/OCI/family activation:
  addressed.
- Fresh reviewer command: 53/53 pass in 94.17 seconds; B2 inventory empty; live
  owned helpers zero; worktree and diff check clean.

**B2 CANNOT CLOSE. B3 REMAINS LOCKED.**
