# Task 7 review — round 3

Verdict: **REJECTED**

No Critical findings. Two Important gaps remain after round 2.

## Important findings

1. The private OCI environment handoff is created before `docker create`, but
   a thrown CLI call, nonzero result, or invalid returned identity exits before
   deleting it. Authorized environment values can remain on disk before a
   container ID has been durably bound. The create effect needs a prepared
   durable ownership/cleanup intent before invocation, exact ID binding on
   success, and recoverable exact reconciliation/compensation for every
   pre-ID failure path.

2. The public-family matrix is structurally correct, but its cancellation
   result is still unstable in the exact required aggregate. A fresh run
   returned 100/101; `process public family cancellation cleans its
   TERM-ignoring grandchild` produced no `cancelled` outcome. Diagnose and fix
   the lifecycle race, then prove the exact aggregate repeatedly green after
   the final affected change.

## Confirmed addressed

- Post-ID handoff-deletion failure is durably owned and recoverable.
- Dual post-ID deletion/removal failure retains exact cleanup intent.
- Forged durable handoff paths are rejected before effects.
- The 12 matrix cases now enter the actual process, evidence, and final
  verification family boundaries.
- Typecheck, targeted ESLint, and static escape checks were green.

## Required repeat evidence

After the final concurrency change, run the exact nine-file aggregate at least
five consecutive times and record every command/result. The cancellation case
must prove a launched identity, public `cancelled` mapping, verified-empty
cleanup, and a dead descendant; do not resolve the issue by deadline tuning.
