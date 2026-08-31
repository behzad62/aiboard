# Task 8.0B2 Fix Round 5 Independent Review

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **2**
- Minor: **0**
- B2 unlock: **refused**

## Important findings

1. `ownedRecord(requestedId)` accepts a valid record whose embedded
   `processId` differs from `requestedId`. Released-tombstone recovery then
   derives its coordination path from the embedded ID. A reproduced
   `requested-a.json -> target-b` substitution returned the `target-b`
   snapshot and deleted `target-b.fence.lock`. Wrong-process evidence is
   therefore not fail-closed.
2. Global semantic cleanup remains fail-open in two related evidence paths.
   The production CIM serializer converts inaccessible/null executable and
   command-line properties to accepted empty strings, and encoded-root
   scanning misses a base64url payload embedded in a normal option such as
   `--payload=<encoded>`. Both reproductions deleted the root.

## Review evidence

- Unchanged reviewer reproduction: 57/57 GREEN.
- Focused release/fence/terminal-output group: 6/6 GREEN.
- Exact 65 MiB evidence guard: 1/1 GREEN in about 18.4 seconds.
- Node 22.13 lock group: 12/12 GREEN.
- Runner typecheck, targeted ESLint, diff check, and static scope checks:
  GREEN. Node range, production deadlines/output cap, B3, OCI, and routing were
  unchanged.
- Windows runtime validation was available. Linux/macOS host validation was
  not performed in this review.

B2 remains locked. Fix round 6 is limited to these two Important findings and
their direct regressions.
