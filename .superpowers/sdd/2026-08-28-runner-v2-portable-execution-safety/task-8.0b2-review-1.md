# Task 8.0B2 Independent Review 1

## Verdict

**CHANGES REQUIRED** — zero Critical and six Important findings. Packet 8.0B2
is not approved and Packet 8.0B3 remains locked.

## Important findings

### 1. The Windows Job host was not actually extracted

`windows-job-process-host.ts` only freezes injected callbacks. The concrete
mechanics remain in `ManagedProcessService`, route back through its public
methods, and `internalOwnershipContext()` constructs a synthetic worker actor.
This violates the mandatory actor-free low-level host and leaves the forbidden
dependency path in place. Move authentication, records, supervisor/control,
output, reconciliation, and release mechanics into a concrete actor-free host;
the managed facade must delegate to it. Guard the transitive path, not only the
Job backend source file.

### 2. The Job backend has no interactive/backpressured channel

Only `NativeOwnedProcessBackend` exposes a channel provider. The Job backend and
low-level host have no write, input-close, retained-output acknowledgement,
detach, reattach, or terminal channel contract. The reviewer reproduced
`hasChannel: "undefined"`. Implement the required authenticated Job-backed
bounded duplex channel behind the extracted low-level host.

### 3. Semantic facts are not consumed and Job absence has no fallback

The four facts are currently dead data. `createWindowsProcessBackend()` selects
Job from object presence before an active probe; the live construction graph
registers only that Job backend. Job-unavailable therefore removes the portable
path, and batch execution still depends on the Job helper. Consume independent
facts in the existing construction/selection seam without routing a new family;
retain a portable fallback and prove argv-only batch behavior independently of
active Job containment.

### 4. Legitimate higher-fence recovery is permanently rejected

Both portable and Job identities bind the launch fence into the birth digest
and accept only exact equality forever. Channel acquire/reattach accepts no
current recovery fence. A valid token-2 recovery of a token-1 launch reproduced
`Owned process writer fence is stale.` Add an authenticated monotonic,
atomically persisted writer-fence handoff. A new current fence must take over
while the old writer immediately loses control; process birth identity must not
be conflated with mutable ownership authority.

### 5. Re-attestation is missing before attach, terminal, and release

Portable acquire/reattach returns state before re-attesting; terminal reads do
not re-attest; native release checks membership but not supervisor birth before
deleting evidence. A recycled-birth reproduction released successfully,
deleted the evidence directory, and performed zero supervisor inspections.
Re-attest exact binding, supervisor birth, current fence, membership, and stable
empty proof immediately before each affected operation. Preserve evidence on
mismatch or uncertainty.

### 6. Corrupt output is hidden and retained deletion is fail-open

Wrong nonce or invalid metadata/digest is silently skipped; retained files do
not enforce per-stream continuity; supervisor unlink failures are ignored while
capacity is freed; release can remove evidence with unsettled retained output.
A corrupt digest reproduced `retained: 0` with zero re-attestations. Strictly
validate filename, nonce, metadata, sequence, offsets, digest, and payload;
surface `outcome_unknown`/blocker on corruption; free capacity only after
verified deletion; and refuse release while output ownership is unsettled.

## Reviewer validation

- Focused backend/channel/probe suite: 41/41 GREEN.
- Missing coverage: transitive actor construction, real Job channel, higher-
  fence takeover, corrupt chunks, deletion failure, recycled-supervisor release,
  and batch execution without Job.
- Worktree remained unmodified.

All six findings are within B2's approved requirements and are technically
determinable. They enter governed repair round 1; no user authority decision is
required.
