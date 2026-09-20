# Task 8.0B2 Fix Round 10 Brief

## Purpose

Close the one remaining Important physical-retirement authority gap from the
independent round-9 review without reopening the accepted birth-deadline work or
widening Task 8.0B2.

## Scope and requirements

### R10.1 — Preserve unowned sidecars when main authority is absent

- Add a physical regression with an absent coordination database and a
  sentinel sidecar at the exact `-wal` name.
- Revoked recovery must perform no physical mutation when the main database is
  absent. The sentinel sidecar and its bytes must remain unchanged.
- This idempotent absent-main path must not create a database or sidecar.

### R10.2 — Pin verified physical-retirement authority

- Capture a stable filesystem identity only from the exact regular,
  non-symbolic, single-link database whose protocol authority has been
  validated and durably retired.
- Carry that identity and exact-path authority across database close into the
  default physical cleanup path.
- Provisional initialization cleanup may remove only the exact filesystem
  identity created and captured by that attempt.

### R10.3 — Revalidate every physical removal boundary

- Before considering or removing each `-journal`, `-wal`, and `-shm` sidecar,
  revalidate that the main path is still the captured database identity.
- Reject symbolic, multi-link, replaced, or otherwise invalid sidecar paths.
- Revalidate the same captured main identity immediately before its unlink.
- Any main disappearance or replacement after capture must fail closed and
  preserve the replacement and every not-yet-removed uncertain path.
- Keep cleanup bounded and retry only the existing transient access/busy
  failures; never turn identity uncertainty into deletion authority.

## Explicit exclusions

- No changes to late-birth cleanup or POSIX/Windows birth deadlines accepted in
  round 9.
- No B3 implementation or activation.
- No OCI-family activation, product routing, or required Job Object feature.
- No task, command, model, startup, or retained-output limit changes.
- No exact Node patch pin; supported Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`.
- No deletion of uncertain or unrelated historical residue.

## Ordered work packets

1. Add and prove RED the absent-main foreign-sidecar reproduction.
2. Add and prove RED a captured-main replacement/removal boundary regression.
3. Implement stable identity capture and exact boundary revalidation.
4. Run the exact guards, the complete owned-fence module, Windows Job release
   regressions, and affected portable/process compatibility tests.
5. Run current Node and Node 22.13 lock groups, typecheck, targeted lint, diff
   and policy audits, the uninterrupted full package gate, and post-gate
   helper/residue inventory.
6. Record evidence, commit the bounded change, and obtain a fresh independent
   scoped review.

## Acceptance gate

- Every new guard is physically RED before implementation and GREEN after it.
- No foreign or uncertain sidecar/main path is removed.
- Existing successful retirement still leaves no owned coordination residue.
- All focused, compatibility, static, Node-line, full-package, and post-run
  hygiene gates are green.
- Independent review reports Critical 0 and Important 0.

Only then may Task 8.0B2 be declared verified and B3 become eligible.
