# Task 8.0B2 Fix Round 9 Brief

## Purpose

Close the two Important and one Minor findings from the independent round-8
review without changing portable-first product behavior or widening Task 8.0B2.

## Scope and requirements

### R9.1 — Complete exact-path checks for recovery and physical retirement

- Revalidate the exact regular, non-symbolic, single-link coordination path
  after the in-transaction revocation assertion and before recovery mutations.
- Revalidate again before recovery commit.
- Revalidate retired cleanup inside its transaction, before commit, and
  immediately before invoking physical cleanup.
- Revalidate inside default final protocol removal before unlinking sidecars or
  the coordination database.
- A hard link injected at the revocation callback must cause rollback, preserve
  active coordination, refuse physical removal, and leave both names untouched.

### R9.2 — Use late exact birth only for authenticated failure cleanup

- Distinguish an exact birth fingerprint from whether it arrived within its
  platform-specific discovery deadline.
- A late exact fingerprint must never permit successful launch or running-state
  acceptance.
- Preserve that exact fingerprint solely to create cleanup identity and the
  minimum internal holder evidence required by the existing fenced cleanup
  path.
- After rejection, the production launch path must stop and prove absence of
  the exact supervisor and target, then remove its owned state root.
- The regression must assert rejection, no returned binding, no live recorded
  PIDs, and an empty state directory before any emergency test cleanup.

### R9.3 — Restore platform-specific birth-discovery envelopes

- Derive an absolute birth-discovery deadline that is never later than the
  overall startup deadline.
- Keep generic POSIX birth discovery capped at its prior one-second total.
- Keep Windows birth discovery within its existing 15-second adaptive envelope
  and three-attempt maximum.
- Do not change task, command, model, retained-output, or overall process-startup
  limits.

## Explicit exclusions

- No B3 implementation or activation.
- No OCI-family activation or product routing change.
- No required Windows Job Object feature.
- No agent-selected platform command ownership.
- No production command deadline, build-task deadline, model deadline, or
  retained-output-cap change.
- No exact Node patch pin; supported Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`.
- No deletion of uncertain or unrelated historical residue.
- No reopening of the round-8 mixed-alphabet scanner repair.

## Ordered work packets

1. Add and prove RED the in-transaction revocation hard-link reproduction.
2. Add and prove RED late-birth rejection with zero live processes and no
   retained state before emergency cleanup.
3. Add and prove RED a generic POSIX one-second absolute discovery-cap guard.
4. Implement R9.1, run exact and full owned-fence tests, and prove GREEN.
5. Implement R9.2-R9.3, run exact and affected backend/process tests, and prove
   GREEN.
6. Run compatibility, current Node and Node 22.13 lock groups, typecheck,
   targeted lint, diff/static audits, the uninterrupted full package gate, and
   post-gate helper/residue inventory.
7. Record evidence, commit the bounded change, and obtain a fresh independent
   scoped review.

## Acceptance gate

- Every new guard has physical RED and restored GREEN evidence.
- Exact and affected suites pass with no live helper or owned-root leak.
- Cross-platform compatibility remains green, with only the explicit POSIX
  live fixture skip permitted on Windows.
- Current Node and Node 22.13 ownership-lock suites pass.
- Typecheck, targeted lint, diff integrity, Node policy, and scope audits pass.
- One uninterrupted `npm run test:runner-v2` exits zero with all chained product
  contracts green.
- Post-gate inventory reports zero live helpers and no new or
  deletion-authorized B2 residue.
- Independent review reports Critical 0 and Important 0.

Only then may Task 8.0B2 be declared verified and B3 become eligible.
