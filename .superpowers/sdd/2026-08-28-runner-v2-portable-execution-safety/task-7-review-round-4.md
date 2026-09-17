# Task 7 review — round 4

Verdict: **REJECTED**

No Critical findings. This opens the penultimate governed repair round; the
next independent review is round 5.

## Important findings

1. The secret-bearing OCI handoff file is written before the durable `creating`
   record. A crash between those effects leaves an unjournaled secret file.
   Persist the closed path/name/label intent before file creation. Also inspect
   and re-attest a successful returned container ID against exact name, labels,
   and image before binding it durably.

2. Windows Job release is not part of the per-process serialized lane. It
   snapshots the current tail and later deletes the map; a control enqueued
   after the snapshot can overlap a third control after deletion. Release must
   atomically close and drain the lane, reject or serialize later controls,
   and remove only the exact completed lane.

3. A fresh exact aggregate failed 112/113. The Windows portable
   missing-executable launch-failure fixture left an `owned-<UUID>` directory
   although the same test passed alone. Diagnose the supervisor
   identity/quiescence race and require zero owned process/directory residue;
   do not weaken or skip the assertion.

## Confirmed addressed

- Public pre-bind cancellation and timeout pass through ProcessTools with
  typed outcomes, verified-empty cleanup, and dead descendants.
- The public-family matrix enters actual process, evidence, and final runtime
  boundaries.
- Post-journal OCI failure settlement is exact-name scoped and restart-safe.
- Task 8 boundary, portability policy, and non-pinned Node policy remain intact.

## Final-repeat requirement

After the last affected change, run the exact nine-file aggregate at least five
consecutive times. Record exact commands and results, plus focused OCI/recovery,
Windows/portable backend, compatibility, type, lint, static, diff, and residue
evidence.
