# Task 8.0B2 Fix Round 12 Brief

## Purpose

Close the two remaining Important ordinary-open and contended-initialization
races from the independent round-11 review without widening Task 8.0B2.

## Scope and requirements

### R12.1 — Enforce the no-sidecar boundary on ordinary acquisition

- Add an alternate-entry laundering regression: a sidecar preserved after a
  revoked-recovery failure must remain byte-identical and must block every
  later ordinary acquisition without running the external effect.
- Add an active-protocol regression with a foreign rollback-journal sidecar,
  while the alternate-entry laundering regression retains WAL coverage.
  Ordinary acquisition must preserve the sidecar and main database and perform
  no effect.
- Check the exact main snapshot and absence of `-journal`, `-wal`, and `-shm`
  before every SQLite open in `openProtocol` and immediately after opening.
- A transient legitimate sidecar may be retried only inside the existing lock
  acquisition deadline. A persistent or uncertain sidecar fails closed and is
  never deleted, consumed, or promoted into ownership.

### R12.2 — Preflight existing protocols read-only

- Add a foreign WAL-mode SQLite regression proving the main database remains
  byte-identical and no effect runs when it is rejected.
- Validate every existing protocol through a read-only connection before any
  read-write connection, write PRAGMA, schema change, or transaction.
- Pin and recheck exact path identity/snapshot and sidecar absence around the
  read-only preflight and the later read-write open.
- Accept only the current exact protocol or a safe empty active legacy
  protocol. Preserve the existing bounded legacy migration path.
- Foreign, incomplete, retired, authority-mismatched, or otherwise invalid
  databases fail closed without mutation.

### R12.3 — Retain the original deadline after `EEXIST`

- Add a real two-process regression in which the winner exclusively reserves
  an empty path, waits, then initializes a valid protocol while a contender
  waits and subsequently succeeds exactly once.
- Record contended provisional creation when exclusive create reports
  `EEXIST`. An empty regular single-link winner is inspected without SQLite and
  retried until it becomes nonempty, disappears, or the caller's original
  absolute deadline expires.
- If a contended winner is temporarily incomplete, keep inspecting it
  read-only and retry within that same deadline. Without observed contention,
  existing invalid metadata fails normally.
- On expiry, preserve the winner and any sidecars byte-for-byte. Do not add a
  fixed two-second task limit or any hardware/OS-specific duration.

## Explicit exclusions

- No change to build-task or command duration, process discovery, process
  birth envelopes, model limits, startup budgets, or retained-output policy.
- No B3 implementation or activation.
- No OCI-family activation, product routing, or required Job Object feature.
- No exact Node patch pin; supported Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`.
- No deletion of uncertain or unrelated historical residue.

## Ordered work packets

1. Add laundering, active-sidecar, foreign-WAL, and real contended-winner
   regressions and prove the focused group RED against round 11.
2. Implement a side-effect-free existing-protocol preflight, durable
   contended-reservation state, and deadline-bounded no-sidecar/open checks.
3. Prove every new guard RED by disabling only that guard, revert, and prove
   the exact group GREEN.
4. Run the complete lock module, affected portable/process matrix, managed
   runtime compatibility, supported Node lines, static/policy checks, one
   uninterrupted full package gate, and post-gate helper/residue inventory.
5. Record evidence, commit the bounded change, and obtain a fresh independent
   scoped review.

## Acceptance gate

- Every new guard is physically RED before implementation and GREEN afterward.
- Ordinary acquisition never consumes or changes a pre-existing sidecar or a
  foreign database before validating exact protocol authority read-only.
- A legitimate concurrent initializer receives the caller's adaptive deadline
  and can complete without an artificial task timeout.
- Existing clean initialization, acquisition, safe legacy migration, and
  retirement remain green and portable.
- All focused, compatibility, static, Node-line, full-package, and post-run
  hygiene gates are green.
- Independent review reports Critical 0 and Important 0.

Only then may Task 8.0B2 be declared verified and B3 become eligible.
