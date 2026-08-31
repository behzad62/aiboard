# Task 8.0B2 Fix Round 3

## Scope and authority

Repair exactly the three Important residual gaps in
`task-8.0b2-fix-review-3.md` against the canonical Task 8.0B2 brief and the two
preceding repair briefs. Preserve every verified B1, 8.0A, Task 5/7/3, portable
fallback, actor-free Job-host, bounded duplex, fence-at-effect, fail-closed
evidence, Node 22/24, compatibility, and load-hardening behavior. Windows Job
Objects remain an optional enhancement only. Do not add OCI, activate or route a
new child family, begin B3, weaken recovery semantics, raise production
deadlines, or add time-based evidence deletion.

## Required repair packets

### R3.1 — Bound the optional active Job probe

- Give the real Job create/close child process an explicit watchdog. A hung
  PowerShell probe must be terminated and only the Job-containment fact must
  settle unavailable/unsupported.
- Independently verified portable duplex, batch argv, and exact-tree/birth facts
  must complete and remain usable without waiting forever for the optional Job
  fact. A Job probe failure must not suppress portable registration.
- Preserve the genuine active create/close attestation on the healthy path; do
  not replace it with module presence or platform inference.
- Make the hang deterministic through a test-only injected probe boundary or
  equivalent controllable process. Do not lengthen a product deadline to pass.

### R3.2 — Replace anonymous crash-stale fence locks with an exact, recoverable protocol

- The one shared fence-lock authority must cover native claim/effect, portable
  supervisor effect, and extracted Job-host claim/effect paths.
- Before a lock is authoritative, durably bind it to an immutable acquisition
  identity containing an unguessable acquisition ID, holder PID, and exact
  holder birth fingerprint. Partial/corrupt metadata must never be treated as a
  free lock or as evidence that a live holder is absent.
- Recovery must be race-safe: a legitimate higher-fence candidate may reclaim a
  lock only after proving the exact recorded holder absent or birth-mismatched,
  and concurrent reclaimers must elect at most one owner/effect. A stale check
  followed by an unconditional unlink/rename is not sufficient because it can
  remove a replacement live lock.
- An exact live holder must never be stolen, even when acquisition wait expires.
  Persistent or ambiguous inspection/finalization failures remain typed
  uncertainty and preserve evidence.
- Crash release and mutual exclusion must be portable across Windows, Linux,
  and macOS. Platform-specific helpers may optimize an implementation, but
  portable semantics and the portable baseline cannot depend on them.
- Keep takeover monotonicity and the already verified lowest-boundary recheck:
  equal current ownership remains idempotent, strictly higher ownership may
  take over under the governed protocol, and stale/divergent effects fail before
  side effects.

### R3.3 — Close fixture and historical B2 residue safely

- Audit every affected test fixture and ensure each successful/expected-failure
  path performs bounded authenticated terminal observation, release, and exact
  root cleanup in `finally`. Cleanup failure must fail the test rather than be
  silently ignored.
- Add a bounded, read-only residue inventory for the exact Task 8.0B2 prefix set
  and use it before and after focused, concurrent, and broad gates. A successful
  gate must return to its proven baseline; the final B2 gate requires zero
  task-owned roots and zero live owned helpers.
- Safely remove historical B2 roots only after resolving the absolute path under
  the OS Temp directory, matching a closed test-owned prefix, rejecting links or
  nested/escaped targets, validating any durable nonce/state/launch identities,
  and proving every recorded and command-line-referencing PID absent or exact
  birth-mismatched. Delete no uncertain evidence and no unrelated Temp entry.
- Cleanup is ownership-driven, never age-driven. Do not use a broad recursive
  deletion, glob-selected target, shell-policy workaround, or time threshold as
  authority.

## Mandatory RED / revert / GREEN proofs

1. A never-closing active Job create/close probe exceeds its explicit deadline,
   is terminated without a leaked child, and settles only the Job fact
   unavailable while verified portable/batch/tree results return and the native
   factory retains portable registration. Removing the watchdog must reproduce
   the bounded timeout/failure, then be reverted GREEN.
2. A healthy active Job create/close probe still verifies real Job semantics.
3. A real child process acquires a fence lock and is killed without finalizing;
   a legitimate higher-fence owner proves its exact birth absent, reclaims it,
   and performs exactly one effect. Removing stale recovery must be RED.
4. A real exact live holder remains protected through the full contention
   window. Any mutation that ignores birth identity or steals the live lock must
   be RED.
5. Two or more concurrent stale-lock reclaimers produce one authoritative
   acquisition/effect; corrupt, incomplete, replacement-raced, and persistent
   cleanup/inspection cases fail closed. Mutating the atomic election or final
   identity check must be RED.
6. The affected focused suite creates representative portable, semantic, Job,
   fencing, takeover, timeout, and crash fixtures and returns the exact prefix
   inventory to zero. Removing one fixture cleanup path must leave detectable
   residue RED; revert and prove GREEN.

Every new guard or regression test must be observed RED, the fault/mutation
reverted, and the unchanged guard rerun GREEN. Record the exact commands and
outcomes in `task-8.0b2-report.md`.

## Validation and exit discipline

Run the exact reproductions first, then the affected probe/fence/portable/Job/
semantic/recovery suites. Run real concurrent stress, complete B1 and 8.0A plus
Task 5/7/3 compatibility, Runner typecheck, targeted lint, diff/static
dependency/raw-process/product-branch/Node-pin audits, and one uninterrupted
serial `npm run test:runner-v2`. Audit exact owned processes and exact task-owned
Temp roots before and after every broad attempt. Start the final broad gate only
from a zero task-owned-root baseline, and accept it only if it exits green and
returns to zero.

Use exact failed checks first and expand only by proven impact. Reuse earlier
green evidence only when the changed dependency surface cannot affect it.
Automatically repair technically determinable failures within this scope; do
not expand into B3 or unrelated findings.

Append current design, RED/GREEN/mutation/concurrency/cleanup evidence to
`task-8.0b2-report.md`, commit the focused repair, and leave the worktree clean.
Implementation and a green suite are not approval. B2 remains locked until a
fresh independent scoped re-review and controller audit report zero Critical or
Important findings and current process/filesystem residue is zero.
