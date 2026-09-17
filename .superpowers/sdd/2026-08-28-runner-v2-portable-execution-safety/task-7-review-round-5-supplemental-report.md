# Task 7 review round 5 supplemental fix report

Date: 2026-08-29

Scope: the final Windows Job adapter lane finding only. No OCI, public command-family,
Task 8, platform-mandatory, or Node-version behavior was changed.

## Requirement audit

- `observe()` now runs each durable output read, awaited output callback, offset
  advancement, and ownership reconciliation as one per-process lane operation.
  Polling sleep remains outside the lane.
- `release()` atomically marks the lane terminal, queues behind every prior lane
  operation (including a blocked output callback), and deletes the lane and offsets
  only after the durable service release succeeds. Concurrent release shares one
  attempt. A failed durable release remains fail-closed but may be retried.
- The former bounded 4,096-entry released-ID cache was removed. The managed-process
  record now has an optional durable `backendOwnershipReleasedAt` authority. The new
  exact `releaseOwnership(processId, context, expectedStartedAt)` operation verifies
  the record birth and terminal supervisor ownership, persists the terminal marker,
  and is idempotent. Backend output, signal, and ownership reconciliation reject the
  marker after service/adapter restart.
- Launch registers the exact processId/startedAt lane. Recovery creates a lane only
  after exact durable ownership re-attestation; concurrent activations share a
  bounded promise and are removed when settled. Released or mismatched identities
  cannot lazily reactivate. Active-lifecycle lanes remain bounded by live/recovering
  processes and are deleted on successful release.
- Historical records remain compatible because the durable release field is
  optional and structurally validated only when present. Ordinary records without
  the marker keep their prior behavior.

## RED, repair, GREEN evidence

### Output callback / release interleaving

Natural RED before moving output delivery into the lane:

```text
npx tsx --test --test-name-pattern "active output delivery|callback and reconcile errors" runner-v2/test/windows-process-backend.test.ts
tests 4; pass 1; fail 3
release resolved while the output callback barrier was still held (`true !== false`).
```

After repair:

```text
npx tsx --test --test-name-pattern "active output delivery|callback and reconcile errors|serializes ownership observation|control lane advances" runner-v2/test/windows-process-backend.test.ts
tests 6; pass 6; fail 0
```

The deterministic fixtures cover a held callback, release plus concurrent release,
late verify/signal rejection, callback failure, reconcile failure, offset removal,
and no deadlock.

### Permanent release authority

Natural RED against the bounded tombstone implementation:

```text
npx tsx --test --test-name-pattern "durable release authority|stale clone" runner-v2/test/windows-process-backend.test.ts
tests 2; pass 0; fail 2
both failures: Missing expected rejection
```

The first stale binding was accepted after 4,097 releases, and a cloned stale
binding was accepted by a restarted adapter. The bounded cache implementation was
removed, not enlarged.

Final focused GREEN:

```text
npx tsx --test --test-name-pattern "control lane advances|durable release authority|stale clone|active output delivery|callback and reconcile errors" runner-v2/test/windows-process-backend.test.ts
tests 7; pass 7; fail 0; skipped 0
```

This includes >4,096 churn, cloned stale binding, adapter restart, same-processId
different-startedAt rejection, concurrent/idempotent release, a first durable
release failure, fail-closed late control, and exact second-attempt recovery.

The real durable service proof was also GREEN:

```text
npx tsx --test --test-name-pattern "backend ownership release is exact" runner-v2/test/managed-process.test.ts
tests 1; pass 1; fail 0
```

It launches and terminates a real supervised process, rejects the wrong startedAt,
persists the exact marker, proves idempotency, restarts `ManagedProcessService`,
rejects stale reconciliation, and proves idempotent release after restart.

## Focused and compatibility gates

```text
npx tsx --test runner-v2/test/windows-process-backend.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/process-backend-contract.test.ts
tests 48; pass 48; fail 0; skipped 0; duration 23.66s

npm run typecheck:runner-v2
exit 0

npx eslint runner-v2/src/managed-process.ts runner-v2/src/windows-process-backend.ts runner-v2/test/managed-process.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/windows-process-backend.test.ts
exit 0

rg -n "releasedProcesses|4_096|rememberReleased" runner-v2/src/windows-process-backend.ts runner-v2/test/windows-process-backend.test.ts
exit 1 with no matches (required zero-match result)

git diff --check
exit 0 (only Git's existing LF-to-CRLF notices)
```

## Exact nine-file stability gate

Exact command, run five consecutive times after the final behavior change:

```text
node --import tsx --test runner-v2/test/one-shot-command-executor.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/one-shot-command-routing-static.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/windows-process-backend.test.ts
```

Results:

```text
run 1: tests 129; pass 129; fail 0; skipped 0; 60.10s
run 2: tests 129; pass 129; fail 0; skipped 0; 60.01s
run 3: tests 129; pass 129; fail 0; skipped 0; 60.18s
run 4: tests 129; pass 129; fail 0; skipped 0; 60.30s
run 5: tests 129; pass 129; fail 0; skipped 0; 60.12s
```

Every run included the real Docker OCI fixtures, production command-family matrix,
managed-process and portable/Job Windows backends, and the routing static guard.

## Cleanup, rollback, and recovery

- Successful durable release removes only the exact adapter lane and offsets after
  the persisted terminal marker is acknowledged.
- A durable release failure retains the exact terminal lane, rejects later control,
  and permits a subsequent exact release retry. No stale identity is re-enabled.
- Rollback is the focused commit revert. Existing optional record fields are
  backward-compatible; reverting leaves historical JSON readable.
- Residue evidence after the five-run aggregate:

```text
Get-ChildItem $env:TEMP -Directory -Filter 'aiboard-managed-release-authority-*'
owned_release_temp_count=0

docker ps -a --filter "label=ai-board.runner-v2.owned=true" --format "{{.ID}} {{.Names}}"
no output (zero owned containers)
```

No cleanup command was needed and no ambiguous path was removed.

## Self-review and boundary

The complete five-file source/test diff was inspected. Durable state contains only
the release timestamp, never output, environment, credentials, model-authored data,
or a new public contract. The release marker is exact to the already durable
processId/run/session/startedAt record and cannot authorize a new process birth.
Task 8 and all non-Windows-Job families remain outside this supplemental change.
