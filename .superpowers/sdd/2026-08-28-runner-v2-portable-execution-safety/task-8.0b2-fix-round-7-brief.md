# Task 8.0B2 Fix Round 7 Brief

## Purpose

Close the three Important findings from the fresh fix-round-6 review without
changing Runner V2's portable baseline, enabling B3, or broadening production
execution policy.

## Scope and requirements

### R7.1 — Immutable exact coordination authority

- Bind every new owned-fence coordination database to an immutable identity
  derived from its exact resolved coordination path (therefore the requested
  state root and process identity).
- Validate that identity in acquisition, effect, release recovery, retired-state
  cleanup, and residue cleanup transactions.
- Reject symbolic links and multi-link coordination paths before mutation and
  recheck the path inside mutation boundaries.
- A bound database moved through a hard link must remain foreign after its
  original name disappears.
- An empty, single-link legacy database may migrate transactionally. A non-empty
  legacy database has unbound ownership and must be preserved fail-closed.
- The governed B2 cleanup helper may delete only a single-link, exact-path-bound,
  empty coordination database.

### R7.2 — Bounded encoded-reference phase scanning

- Search both standard base64 and base64url candidates through bounded start and
  end phases so alphabet prefixes and suffixes cannot hide an encoded root.
- Detect direct root text, JSON-escaped root text, and bounded decoded JSON
  payloads.
- Preserve the existing candidate-count, encoded-size, decoded-size, inventory,
  and cleanup-deadline bounds.
- Apply the same fail-closed rule to semantic cleanup and governed B2 residue
  cleanup.

### R7.3 — One absolute semantic operation deadline

- Use one absolute operation deadline across global-inventory prewarm, fixture
  preparation, and portable-backend startup.
- Refuse an already-expired deadline before creating launch state.
- Do not reset the caller's remaining time after process spawn or during startup
  identity discovery.
- Keep separately bounded owned cleanup after a started effect; safety cleanup
  must not be weakened to meet the semantic result deadline.

## Explicit exclusions

- No B3 implementation or activation.
- No OCI-family activation or product routing change.
- No Windows Job Object requirement; it remains an optional enhancement.
- No platform-specific agent-command replacement for process ownership.
- No production command-deadline or retained-output-cap change.
- No exact Node patch pin. Supported Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`.
- No deletion of uncertain or unrelated historical residue.

## Ordered work packets

1. Prove the hard-link/symbolic-link alias regression RED; implement immutable
   coordination authority and prove GREEN.
2. Prove legacy non-empty and cleanup-alias uncertainty RED; preserve it and
   prove GREEN while retaining safe empty migration.
3. Prove prefixed/suffixed/wrapped base64url references RED in both scanners;
   add bounded phase scanning and prove GREEN.
4. Prove a positive semantic deadline and an already-expired startup deadline
   RED; propagate the absolute deadline and prove GREEN.
5. Run exact failures first, then affected concurrent pressure, compatibility,
   Node-floor, static, full-package, and post-gate residue/helper validation.
6. Obtain a fresh independent scoped review. B2 unlock requires zero Critical
   and zero Important findings.

## Acceptance gate

- Every guard has physical RED evidence, is restored, and is GREEN.
- Affected pressure and cross-platform contract suites are green.
- Current Node and Node 22.13 floor ownership-lock suites are green.
- Runner typecheck, targeted lint, diff integrity, Node policy, and scope audits
  are green.
- The uninterrupted `npm run test:runner-v2` command exits zero, including every
  chained product contract check.
- Post-gate inventory has zero live Runner helpers and no new or
  deletion-authorized B2 residue.
- Independent review reports Critical 0 and Important 0.

Only then may Task 8.0B2 be declared verified and B3 become eligible.
