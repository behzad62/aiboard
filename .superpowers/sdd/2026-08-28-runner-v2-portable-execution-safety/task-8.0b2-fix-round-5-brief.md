# Task 8.0B2 Fix Round 5

## Scope and authority

Repair exactly the two Important gaps in `task-8.0b2-fix-review-5.md` while
preserving every verified B2 behavior. Do not alter Node policy, production
deadlines, portable-first/optional-Job selection, family routing, OCI/B3, output
retention, or evidence-deletion controls.

## R5.1 — Recover Job release after external-state / lock-finalization ambiguity

- Treat the durable exact released Job record as a revocation tombstone, not as
  permission to return before coordination cleanup. If the release effect
  persisted `backendOwnershipReleasedAt` but lock finalization failed or the
  process crashed, the next exact release/recovery must atomically validate the
  released record, ownership key, writer fence, protocol/schema, and process ID;
  retire the coordination protocol; remove all now-revoked holders/proposals;
  close it; delete DB/journal/WAL/SHM; and then return idempotent released state.
- Durable released state may revoke an otherwise exact-live recorded lock holder
  because no further effect is authorized. Corrupt/foreign/mismatched record or
  fence remains fail-closed and preserves coordination evidence.
- Gate `release` as well as every other effect on active state inside the final
  transaction boundary. A second release queued before the first commits must
  observe the released tombstone, perform no second release effect, run only the
  governed coordination cleanup if needed, and leave no residue.
- The first finalization failure remains observable; do not falsely report its
  effect as clean. A later exact recovery is the idempotent repair path.

## R5.2 — Close semantic cleanup over a bounded global process inventory

- Before root deletion, perform one bounded global Windows process inventory
  that includes PID, exact birth, parent, executable, and complete command line.
  Do not infer closure from only recorded PIDs.
- Match literal and encoded/base64url references to the normalized exact root.
  The authenticated supervisor may be stopped only after exact PID/birth/nonce/
  encoded-root proof. Replaced recorded children are never signalled. Any other
  live process referencing the root is unowned/uncertain: do not signal it and do
  not delete the root.
- After supervisor termination, repeat or otherwise obtain a current bounded
  global reference proof before deletion. Inventory timeout, truncation,
  malformed entries, inaccessible command lines, or unresolved references
  preserves the complete root and makes cleanup failure observable.
- Keep root containment, launch/state/nonce, owner cap, terminal/output, and
  positive residue-ownership checks already verified.

## Mandatory RED / revert / GREEN proofs

1. Inject Job `BEFORE DELETE`/finalization failure after the durable released
   record is persisted. First release rejects; record is released with a holder
   retained. Second exact release retires/removes coordination and succeeds.
   Mutation removing recovery must reproduce retained holder/residue.
2. Start two releases before the first commits. Exactly one release effect is
   persisted; the second performs only idempotent cleanup/observation; no DB or
   sidecars remain. Active non-release calls queued before release must refuse
   after the tombstone.
3. Corrupt/foreign record, wrong session/run/process/fence, active (not released)
   holder, and ambiguous protocol refuse forced retirement and preserve evidence.
4. Run a real semantic cleanup fixture with an exact supervisor, a replaced
   recorded child, and an additional unlisted live process whose literal or
   encoded command line references the root. Cleanup may stop the supervisor but
   must preserve the root and leave the unlisted process untouched. After the
   unlisted process exits, exact retry removes the root.
5. Remove the global-inventory/reference check and prove the root-deletion guard
   RED; revert and prove GREEN. Inject inventory timeout/malformed/truncation and
   prove fail-closed preservation.
6. Rerun the reviewer focused command, affected Job/semantic/concurrent groups,
   and require zero owned helpers/authorized residue after bounded settle.

Every new guard must be observed RED, reverted, and observed GREEN. Record exact
commands, identities, mutations, and residues in the B2 report.

## Validation and exit discipline

Run exact reproductions first, then affected Job host/backend/channel, semantic
probe, portable/residue, and real concurrent suites; B1/8.0A/Task 5/7/3
compatibility; Node 22.13 and Node 24 lock checks when affected; typecheck,
targeted lint, diff/static/raw-process/product-branch/Node-pin audits; and one
uninterrupted serial `npm run test:runner-v2`. Start and finish from zero owned
helpers and zero deletion-authorized B2 roots while leaving unrelated/uncertain
entries untouched.

Append evidence to `task-8.0b2-report.md` and `progress.md`, commit the focused
repair, and leave the worktree clean. B2 remains locked until another fresh
independent review reports zero Critical/Important findings. B3 may not start.
