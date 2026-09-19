# Task 8.0B2 Fix Round 6

## Scope and authority

Repair exactly the two Important findings in `task-8.0b2-fix-review-6.md`
while preserving every previously verified B2 behavior. Do not change Node
policy, portable-first/optional-Job selection, family routing, OCI/B3,
production command deadlines, retained-output limits, or cleanup ownership
authority.

## R6.1 — Bind every Job record and recovery path to the requested process

- Reject a durable record unless its embedded `processId` exactly equals the
  validated process ID used to select its filename and API operation.
- Derive record, coordination, and recovery paths only from that validated
  requested ID. Never follow an embedded ID to a different record or lock.
- Apply the same identity invariant during startup loading, normal reads,
  release retry, and the final in-transaction revocation assertion.
- A substituted record, path-escaping ID, wrong process/session/run/fence, or
  corrupt record must fail closed and preserve every unrelated record and
  coordination database.

## R6.2 — Close inaccessible and embedded-encoding inventory gaps

- Preserve explicit evidence that an executable or command-line property was
  inaccessible; do not silently coerce inaccessible metadata into proof of an
  empty string.
- Fail closed whenever inaccessible metadata could belong to a process capable
  of referencing the exact generated root. Any temporal exclusion must use an
  exact immutable process birth and an exact unpredictable-root creation lower
  bound; uncertain timing preserves the root.
- Inspect both executable path and complete command line for exact-root
  references.
- Detect standard-base64 and base64url encoded root payloads wherever they
  occur in a command-line argument, including `--payload=<encoded>` and quoted
  forms; do not require a standalone whitespace-delimited token.
- Keep one bounded complete inventory, completion/count validation, the single
  absolute cleanup budget, and the rule that unlisted/uncertain processes are
  never signalled.

## Mandatory RED / revert / GREEN proofs

1. Reproduce `requested-a.json` containing embedded `target-b`, with exact
   target owner/fence/status/lock. The request must reject and the target record,
   lock, DB sidecars, and effect count must remain unchanged. Removing the ID
   equality/path binding must make this guard RED; revert must be GREEN.
2. Reject path-separator/traversal process IDs before any filesystem access
   outside the exact Job host state directory.
3. Inject an otherwise-valid global row with inaccessible command line and/or
   executable metadata that could postdate the exact root. Cleanup must preserve
   the complete root. Removing the accessibility/temporal guard must be RED;
   revert must be GREEN.
4. Inject unlisted executable-path, `--payload=<base64url>`, standard-base64,
   and quoted embedded references. Cleanup must leave the process untouched and
   preserve the root until a current reference-free inventory permits deletion.
   Removing embedded reference scanning must be RED; revert must be GREEN.
5. Rerun the two reviewer reproductions, unchanged reviewer command, affected
   Job/semantic/concurrent groups, and verify zero new owned helpers or
   deletion-authorized residue after bounded settle.

## Validation and exit discipline

Run exact RED/GREEN cases first, then affected Job host/backend/channel,
semantic-probe, portable/residue, and concurrent tests; relevant B1/8.0A/Task
5/7/3 compatibility; Node 22.13 and current-Node lock checks if lock code is
affected; Runner typecheck, targeted lint, diff/static/raw-process/product-
branch/Node-pin audits; and one uninterrupted serial `npm run test:runner-v2`
only after bounded checks are green.

Append current evidence to `task-8.0b2-report.md` and `progress.md`, commit the
focused repair, and leave the worktree clean. B2 remains locked until another
fresh independent review reports zero Critical and Important findings. B3 may
not start.
