# Task 8.0B2 Fresh Re-review — Fix Round 2

Range reviewed: `5a970f51..9f2d52d1`

## Verdict

**CHANGES REQUIRED — B2 cannot close.**

Zero Critical findings. Three Important gaps remain. All six Important findings
from the preceding review are addressed, and the final serial package gate is
green, but the three independently reproduced gaps below prevent the required
portable recovery and zero-residue exit gate.

## Previously reported findings

1. **Addressed — genuine bounded Job producer backpressure and visible channel
   failure.** The extracted Job host now bounds retained output, couples producer
   progress to exact acknowledgement, refuses release with unsettled output, and
   surfaces sink/acknowledgement failures as uncertainty.
2. **Addressed — independent semantic facts with real consumers.** Portable
   duplex, batch argv, exact-tree/birth, and Job containment facts are active and
   independently govern their own selection or refusal paths.
3. **Addressed — lowest-boundary fencing.** Portable and Job write, control,
   acknowledgement, attach, and ownership-changing effects carry and check the
   durable candidate owner/token at the effect boundary.
4. **Addressed — final release fencing.** Verify-empty and release/deletion are
   fenced and re-attest identity, membership, terminal state, and output state.
5. **Addressed — fail-closed output evidence.** Missing, corrupt, unreadable, or
   unsettled output no longer becomes an empty retained window or clean release.
6. **Addressed — bounded Windows inventory/destructive control.** CIM inventory
   has an asynchronous watchdog, synchronous CIM/taskkill paths are bounded, and
   repeated inspection failure reaches durable `outcome_unknown`.

## Remaining Important findings

1. **Important — the optional active Windows Job probe is unbounded and can
   block verified portable fallback.**
   `AuthenticatedWindowsJobProcessHost.probeActiveJobCreateClose()` invokes a
   synchronous PowerShell create/close probe without a timeout in
   `windows-job-process-host.ts`. `probeProcessHostSemantics()` waits for all
   four facts and the native factory waits for that aggregate before registering
   the portable baseline. A never-settling Job probe reproduced
   `TIMED_OUT_WITH_VERIFIED_PORTABLE_BLOCKED`. The Job-only fact must have an
   explicit watchdog and settle unavailable without delaying independently
   verified portable, batch, or tree facts. No production deadline may be
   raised and no fallback fact may be fabricated.
2. **Important — a crash-orphaned anonymous fence lock permanently blocks
   recovery.** Native, portable-supervisor, and Job-host fences use anonymous
   `open(..., "wx")` files. Bounded acquisition/finalization handles transient
   sharing errors, but a host crash after acquisition leaves no durable holder
   PID, exact birth fingerprint, or acquisition identity that can be proven
   stale. A reproduced orphan returned
   `{"result":{"state":"identity_mismatch"},"elapsedMs":2014,"staleLockStillPresent":true}`.
   The shared protocol must record exact immutable holder identity before a lock
   can become authoritative, recover a proven-dead holder without racing a new
   owner, and never steal a lock from an exact live holder. It must work across
   native controller, portable supervisor, and extracted Job-host processes.
3. **Important — the mandatory zero-filesystem-residue exit gate is not met.**
   The report retains twenty policy-blocked B2 roots, and a fresh read-only Temp
   audit after review found 66 current-date Runner test roots, including 23
   `aiboard-windows-job-*`, 17 `aiboard-windows-semantic-*`, and portable
   fencing/takeover roots. Several were produced by fresh passing tests. The
   live-process audit is clean, but B2 requires both live owned processes and
   task-created filesystem residue to be empty. Successful fixtures must prove
   terminal/release and remove their own exact roots. Existing roots may be
   removed only after exact root containment, ownership, command-line/state,
   PID/birth, and no-live-reference proof; uncertain evidence must remain.

## Verification observed by review

- Fresh focused review verification: 80 pass, zero fail, one explicit
  POSIX-native Windows-host skip.
- Implementation package evidence: 1,362 total / 1,361 pass / zero fail / zero
  cancelled / one explicit POSIX-host skip, plus all chained Runner checks.
- Worktree was clean at `9f2d52d1`.
- Bounded live-process inspection found zero managed, portable, or Job-host
  supervisors; the filesystem residue audit was non-zero.
- No exact Node patch pin, Windows-only product requirement, OCI/family routing,
  production deadline increase, or time-based unclaimed-output deletion was
  introduced.

**B2 CANNOT CLOSE. B3 REMAINS LOCKED.**
