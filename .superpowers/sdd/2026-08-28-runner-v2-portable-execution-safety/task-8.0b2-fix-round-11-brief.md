# Task 8.0B2 Fix Round 11 Brief

## Purpose

Close the three remaining Important deletion-authority races from the
independent round-10 review without widening Task 8.0B2.

## Scope and requirements

### R11.1 — Atomically own provisional initialization

- Add a deterministic regression that inserts a foreign regular single-link
  file after the missing-path observation and before SQLite initialization.
- A missing lock path must be reserved with an exclusive filesystem create.
- Capture and pin the exact identity created by this attempt before SQLite opens
  it. Never initialize or remove a file won by another actor.
- Authority refusal and initialization failure may remove only the exact
  attempt-created identity; a foreign or replaced path must remain untouched.

### R11.2 — Make final revocation mutation-sensitive

- Add independent main and sidecar in-place rewrite regressions across the final
  `assertRevoked` boundary.
- Capture mutation-sensitive facts after SQLite is closed, repeat revocation,
  then require the same unmodified main and revalidate the exact retired
  protocol before physical removal.
- Any main disappearance, replacement, or in-place mutation must preserve the
  current path and every not-yet-removed path.

### R11.3 — Make sidecar uncertainty durable

- Add a two-attempt regression: a late sidecar rejected by the first recovery
  must remain rejected and byte-identical on every later recovery.
- After the retired SQLite connection closes, any remaining `-journal`, `-wal`,
  or `-shm` path is uncertain. Physical lock cleanup must preserve it, preserve
  the main database, and fail closed rather than snapshot or unlink it.
- Symbolic, hard-linked, regular, rewritten, replaced, and newly appeared
  sidecars all follow the same durable fail-closed rule.
- A normal successful retirement with no remaining sidecar must still remove
  the exact retired main database and leave no owned coordination residue.

## Explicit exclusions

- No change to process discovery, process birth deadlines, build-task or
  command duration, model limits, startup budgets, or retained-output policy.
- No B3 implementation or activation.
- No OCI-family activation, product routing, or required Job Object feature.
- No exact Node patch pin; supported Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`.
- No deletion of uncertain or unrelated historical residue.

## Ordered work packets

1. Add the provisional-create race and prove it RED.
2. Add separated main-rewrite and sidecar-rewrite cases and prove both RED.
3. Add the two-attempt uncertainty case and prove it RED.
4. Implement exclusive provisional creation, mutation-sensitive final
   validation, and the no-sidecar physical-cleanup invariant.
5. Prove each new guard RED by disabling only that guard, revert, and prove the
   exact group GREEN.
6. Run the complete lock module, process-backend compatibility, supported Node
   lines, targeted static/policy checks, uninterrupted full package gate, and
   post-gate helper/residue inventory.
7. Record evidence, commit the bounded change, and obtain a fresh independent
   scoped review.

## Acceptance gate

- Every new guard is physically RED before implementation and GREEN afterward.
- No foreign, changed, or uncertain main/sidecar path is removed on any attempt.
- Provisional cleanup is limited to an atomically proven attempt-created file.
- Existing clean retirement remains residue-free.
- All focused, compatibility, static, Node-line, full-package, and post-run
  hygiene gates are green.
- Independent review reports Critical 0 and Important 0.

Only then may Task 8.0B2 be declared verified and B3 become eligible.
