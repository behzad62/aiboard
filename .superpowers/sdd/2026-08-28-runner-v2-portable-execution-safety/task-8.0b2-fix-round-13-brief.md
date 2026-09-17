# Task 8.0B2 Fix Round 13 Brief

## Purpose

Close the two remaining Important authentication/test-cleanup gaps and the
bounded retry-scope Minor from the independent round-12 review without widening
Task 8.0B2.

## Scope and requirements

### R13.1 — Authenticate complete canonical protocol semantics

- Add separate current-protocol regressions for forged trigger bodies and
  forged table constraints/foreign-key semantics. Both must remain
  byte-identical, run no effect, and fail before any write-capable open.
- Add a forged empty legacy regression so the legacy migration path accepts
  only the canonical historical schema, not merely matching names/columns.
- Authenticate canonical `sqlite_master` definitions or equivalent complete
  semantics for every required table and trigger, including table constraints,
  the holder foreign key, column types/nullability/key roles, trigger timing,
  target columns/tables, and bodies.
- Accept the canonical current schema, the exact known current schema produced
  by canonical legacy migration, and the canonical empty active legacy schema.
  Reject extra or forged ordinary-acquisition schema objects read-only.
- Preserve recovery of an explicitly recognized extra holder-delete fault
  trigger only on the already-authorized revoked-recovery path; it must not
  weaken ordinary acquisition authentication.
- Keep the canonical legacy migration positive test and exact current
  acquisition/recovery/retirement behavior green on both supported Node lines.

### R13.2 — Make publication-test cleanup fail closed

- Add deterministic helper regressions proving unknown birth inspection,
  unreadable/unauthenticated state, and post-removal root reappearance all
  preserve evidence and fail the test.
- Authenticate the launched directory, nonce, supervisor identity, durable
  state, and every recorded process identity before cleanup.
- Unknown identity, unreadable state, malformed identity, or identity mismatch
  is never absence authority and never permits recursive deletion.
- Require all authenticated exact identities to be absent or demonstrably
  reused for a stable bounded interval. Remove the exact test root once, then
  require it to remain absent for a bounded settle interval; reappearance fails
  and is preserved.
- Do not delete any existing diagnostic or historical root. Inventory changes
  caused by review/fault injection remain preserved unless separate exact
  deletion authority is established.

### R13.3 — Restrict adaptive replacement to durable state

- Add a regression proving channel/output/control atomic writes retain the
  prior one-second transient replacement ceiling while durable `state.json`
  publication alone uses the adaptive 1/2/4/8/15-second ceiling.
- Split or parameterize the atomic replacement path so `publish()` selects the
  adaptive state ceiling explicitly and generic `writeAtomic()` keeps the
  original ceiling.
- Preserve immediate failure for permanent or unknown filesystem errors.
- Change no build-task, command, model, startup, process-discovery, output
  retention, or user-request duration.

## Explicit exclusions

- No B3 implementation or activation.
- No OCI-family activation, product routing, or required Job Object feature.
- No exact Node patch pin; supported Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`.
- No deletion of uncertain or unrelated residue.
- No broader timeout tuning beyond selecting the already-defined state-only
  adaptive envelope and restoring the prior generic atomic-write ceiling.

## Ordered work packets

1. Add the current/legacy schema-forgery, uncertain-cleanup, reappearance, and
   retry-scope regressions; prove each focused guard RED against round 12.
2. Implement canonical schema authentication, exact fail-closed test cleanup,
   and state-only adaptive atomic replacement.
3. Disable each new guard independently, prove its exact regression RED,
   revert, and restore the focused group GREEN.
4. Run the complete lock and portable-channel modules, affected portable/OS
   matrix, managed-runtime compatibility, both Node lines, static/policy gates,
   one uninterrupted full package gate, and post-gate helper/residue inventory.
5. Record current evidence, commit the bounded fix, and obtain a fresh
   independent scoped review.

## Acceptance gate

- Every new guard is physically RED before implementation and GREEN afterward.
- No name-only or column-only current/legacy lookalike reaches a write-capable
  open or external effect.
- Test cleanup never converts unknown/unreadable evidence into deletion
  authority and cannot report green before stable no-reappearance proof.
- Only durable supervisor state publication has the adaptive 15-second maximum;
  channel/control writes retain their prior ceiling.
- All focused, compatibility, static, Node-line, full-package, and hygiene gates
  are green.
- Independent review reports Critical 0 and Important 0.

Only then may Task 8.0B2 be declared verified and B3 become eligible.
