# Task 8.0B2 Fresh Re-review — Fix Round 11

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **2**
- Minor: **0**
- B2 unlock: **refused**

## Important findings

1. Ordinary acquisition opens an existing SQLite path read-write and switches
   it to DELETE journal mode without first enforcing the no-sidecar boundary.
   This can consume or remove a foreign WAL, including a WAL deliberately
   preserved by a failed revoked-lock recovery, and can alter a foreign
   WAL-mode database before rejecting it.
2. A contender that loses the exclusive missing-path reservation immediately
   treats the winner's still-empty reservation as invalid SQLite metadata. It
   therefore fails in milliseconds instead of retaining the caller's original
   acquisition deadline while the winning process initializes the protocol.

## Required correction

- Apply a mutation-sensitive main/no-sidecar precondition before every SQLite
  open in ordinary acquisition. Existing databases must pass a read-only
  protocol preflight before any write-capable open or journal-mode change.
- Preserve a durable contended-reservation state after `EEXIST`. Inspect an
  incomplete winner without mutation and retry only within the original
  caller-supplied absolute deadline; never add a fixed task-duration limit.

## Accepted scope and evidence

- The final revocation snapshot and fresh retired-protocol validation are
  accepted. Same-size in-place main mutation is preserved and rejected.
- Authority-refusal mutation/replacement/linking and late sidecar injection
  fail closed. BigInt identity passed on Node 24 and Node 22.13.
- Owned-fence tests passed 25/25 on both Node lines; the focused release group
  passed 5/5; static checks and helper inventory were green.
- No Node-range, portability, process-lifecycle, routing, OCI, optional Job
  Object, output-limit, or B3 policy drift was found.

B2 stays locked; B3 has not started.
