# Task 8.0B2 Fresh Re-review — Fix Round 10

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **3**
- Minor: **0**
- B2 unlock: **refused**

## Important findings

1. Provisional initialization decides that the lock path is missing before the
   exact pre-open identity check. A foreign file created in that interval can
   be mistaken for an attempt-created database and deleted after
   `assertAuthority` refuses.
2. Physical authority is captured before the final revocation assertion. That
   callback can rewrite the captured main database or a captured sidecar in
   place without changing device, inode/file index, or birth identity; cleanup
   then deletes the changed bytes.
3. Sidecar uncertainty is not durable across attempts. A first recovery can
   correctly preserve a late sidecar, while a later recovery snapshots the
   same uncertain file as trusted and deletes it. Partial cleanup can similarly
   launder a not-yet-removed uncertain path on retry.

## Required correction

- Exclusively create and pin a missing initialization file before SQLite opens
  it. Provisional cleanup may target only that proven attempt-created identity.
- Detect main and sidecar mutation across the final revocation boundary and
  revalidate the exact retired database after that assertion.
- Make sidecar uncertainty durable. A remaining sidecar may not become deletion
  authority merely because a later attempt observes it.

## Accepted scope and evidence

- R10.1 is closed. R10.2 and R10.3 remain open only for the three issues above.
- Single-attempt main disappearance/replacement and symbolic, hard-linked,
  newly appeared, and replaced sidecars otherwise failed closed.
- BigInt stat identity worked under Node 24.18 and Node 22.13.
- Owned-fence tests passed 20/20 on both Node lines; Windows backend
  compatibility passed 80/80; typecheck, lint, and diff integrity passed.
- No Node-range, deadline, routing, OCI, Job Object, output-limit, or B3 policy
  drift was found. Review cleanup left no roots or helper processes.

B2 stays locked; B3 has not started.
