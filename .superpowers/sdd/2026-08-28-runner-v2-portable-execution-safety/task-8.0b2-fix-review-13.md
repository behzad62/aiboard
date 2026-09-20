# Task 8.0B2 Fresh Re-review — Fix Round 12

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **2**
- Minor: **1**
- B2 unlock: **refused**

## Important findings

1. Existing-protocol preflight authenticates required object and column names,
   but not the canonical table constraints, foreign key, column semantics, or
   trigger bodies. A foreign lookalike with the correct path-derived authority
   and no-op named triggers passed preflight, ran the external effect, and left
   its authority mutable.
2. The new publication-regression cleanup ignores unreadable state and treats
   an unknown birth inspection as absence. Passing review runs could therefore
   delete before exact absence, return green, and then leave recreated
   diagnostic roots. Unknown or unreadable evidence must preserve the root and
   fail the test; every authenticated recorded identity needs stable exact
   absence before one cleanup, followed by a bounded no-reappearance check.

## Minor finding

- The adaptive 15-second atomic replacement retry was placed in the helper
  shared by durable state, output chunks/checkpoints, control requests, and
  input acknowledgements. The loaded failure authorized the longer envelope
  only for durable supervisor state publication. Other channel/control writes
  must retain their prior bounded behavior unless separately authorized and
  validated.

## Accepted scope and evidence

- The round-11 sidecar laundering, active rollback-journal, foreign-WAL,
  same-inode rewrite, and real contended-initializer regressions are accepted.
- Lock suites passed 30/30 on current Node and Node 22.13; portable channel
  passed 32/32; the deterministic 1.5-second state-publication hold passed.
- Typecheck, targeted ESLint, diff/static checks, and the supported Node range
  are accepted. No B3, OCI, routing, Job requirement, or exact Node patch pin
  drift was found.
- Review left no live helper process. Newly observed uncertain roots are
  evidence and are not deletion-authorized.

B2 stays locked; B3 has not started.
