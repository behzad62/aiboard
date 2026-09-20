# Task 7 review — round 1

Verdict: **REJECTED**

Specification compliance: rejected. Code quality: rejected. No Critical findings;
five Important findings require focused repair.

## Important findings

1. Strict OCI supplied the original child environment to the Docker CLI control
   plane. Docker-reserved variables could redirect `create` away from the daemon
   used for attestation, re-attestation, and cleanup. Child values must reach only
   the original container command, remain absent from CLI arguments, durable
   state, logs, and model-visible data, and be cleaned without residue.

2. Evidence and final-verification spill reads did not recover from missing,
   unreadable, or hash-corrupt spill artifacts. Both families must fall back to
   the bounded tail, preserve lossy metadata, and retain the command's mechanical
   outcome.

3. A runtime grant could remain live when `runtime.invoke` failed before consuming
   it. The executor must revoke exactly once on that path and then release
   isolation, without double revocation on success or outcome-unknown paths.

4. Evidence and final verification erased typed isolation/runtime failures.
   Stable codes for strict capability unavailability, isolation revocation
   failure, and outcome unknown must survive public/result mapping.

5. The mandatory per-family production-runtime fault matrix was not demonstrated.
   Most affected tests used a test-only direct-spawn executor, the static RED
   mutation was only a comment matching a lexical regex, and inherited runtime
   tests were substituted for family-level spill-fault proof. Each process,
   evidence, and final-verification family needs production shared-runtime graph
   fixtures covering inherited secrets, tail/spill limits, spill faults,
   descendant cleanup including TERM-ignore, timeout, cancellation,
   restart/outcome unknown, strict unavailability, and Full disclosure. The
   static guard must be proven red with a genuine alternate-launch bypass,
   reverted, and proven green.

## Reviewer verification

- Task 7 focused suite: 29/29 passed.
- Isolation/OCI suite: 39/39 passed, including four real Docker tests.
- Runner V2 typecheck: passed.

Those gates were genuine but did not cover the five findings above.
