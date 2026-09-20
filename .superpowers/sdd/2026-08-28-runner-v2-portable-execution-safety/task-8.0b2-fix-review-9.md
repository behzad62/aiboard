# Task 8.0B2 Fresh Re-review — Fix Round 8

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **2**
- Minor: **1**
- B2 unlock: **refused**

## Important findings

1. Revoked-lock recovery and retired cleanup still lack single-link path
   revalidation at all mutation, commit, callback, and removal boundaries. The
   second in-transaction `assertRevoked` callback can add a hard link; recovery
   then commits `retired=1`, removes the requested path, and leaves the alias.
2. A birth fingerprint returned after the absolute startup deadline is
   discarded before cleanup identity is created. Launch rejects correctly, but
   the no-identity path retains evidence without stopping the detached
   supervisor or its target. The exact 150 ms inspection under a 50 ms deadline
   left a running supervisor, running root, three known live processes, and a
   retained owned directory after one second. The regression test's emergency
   PID cleanup hid this production leak.

## Minor finding

1. Passing the full startup deadline to birth discovery expanded the generic
   POSIX discovery window from its prior one-second total cap to the full
   six-second startup window. Keep a platform-specific absolute birth deadline
   bounded by the earlier overall startup deadline.

## Review evidence

- Direct round-8 regressions passed 4/4; the owned-fence, semantic-probe, and
  governed-residue modules passed 52/52.
- The repaired portable terminal-wait check passed 1/1.
- Runner typecheck, diff integrity, Node policy, and clean-worktree checks
  passed.
- Independent adversarial checks reproduced both Important findings. Review
  cleanup left zero live helpers and zero review residue.

R8.2 is closed. R8.1 and R8.3 remain incomplete. B2 stays locked; fix round 9
is limited to these findings and their direct regressions. B3 has not started.
