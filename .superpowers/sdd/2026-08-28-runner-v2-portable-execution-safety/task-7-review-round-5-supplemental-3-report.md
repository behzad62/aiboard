# Task 7 review round 5 supplemental 3: exact shared-activation identity

Date: 2026-08-29

Scope was limited to the Windows Job adapter's shared activation identity check. No
managed-process persistence, OCI, command-family, public schema, portability policy,
Task 8, or Node-version behavior changed.

## Finding and repair

`ensureLane()` keyed activation promises by processId. A caller with another
fingerprint-consistent birth for the same processId could await the first caller's
activation and receive its lane without a caller-specific identity assertion.

The repaired lane stores an immutable exact identity containing processId, runId,
sessionId, startedAt, and the verified birth discriminator. Identity is asserted:

- when an existing lane is found;
- after awaiting a shared activation;
- after awaiting a newly created activation;
- when registration encounters a concurrent existing lane.

The opaque identity remains backward compatible: the birth discriminator is derived
and checked from the existing processId/startedAt plus binding fingerprint rather
than adding a model-visible or durable field. No action is queued until the exact
caller assertion succeeds.

## RED and GREEN

The deterministic fixture holds birth A's activation, starts a signal through birth
B with the same processId and a different startedAt plus matching fingerprint, then
releases A.

Natural RED:

```text
npx tsx --test --test-name-pattern "shared activation rejects" runner-v2/test/windows-process-backend.test.ts
tests 1; pass 0; fail 1
Missing expected rejection
```

GREEN after exact post-await assertion:

```text
npx tsx --test --test-name-pattern "shared activation rejects|control lane advances|durable release authority|stale clone|active output delivery|callback and reconcile errors" runner-v2/test/windows-process-backend.test.ts
tests 8; pass 8; fail 0; skipped 0
```

Birth A verifies successfully. Birth B rejects with identity mismatch before its
service action (`signalCalls === 0`). A remains usable afterward, proving no lane
poisoning. The same focused gate includes activation rejection cleanup and successful
retry, callback/reconcile error recovery, release retry, >4,096 churn, and restart.

## Focused compatibility

```text
npx tsx --test runner-v2/test/windows-process-backend.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/process-backend-contract.test.ts
tests 49; pass 49; fail 0; skipped 0; duration 23.90s

npm run typecheck:runner-v2
exit 0

npx eslint runner-v2/src/windows-process-backend.ts runner-v2/test/windows-process-backend.test.ts
exit 0
```

## Exact nine-file aggregate x5

Command run five consecutive times after the final production edit:

```text
node --import tsx --test runner-v2/test/one-shot-command-executor.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/one-shot-command-routing-static.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/windows-process-backend.test.ts
```

```text
run 1: tests 130; pass 130; fail 0; skipped 0; 59.83s
run 2: tests 130; pass 130; fail 0; skipped 0; 60.21s
run 3: tests 130; pass 130; fail 0; skipped 0; 60.32s
run 4: tests 130; pass 130; fail 0; skipped 0; 60.35s
run 5: tests 130; pass 130; fail 0; skipped 0; 60.03s
```

Every run included real Docker OCI fixtures, production command-family routing,
managed-process restart/atomicity, Windows portable/Job backends, and static guards.

## Diff, cleanup, rollback, and boundary

```text
git diff --check
exit 0 (only existing LF-to-CRLF notices)

Get-ChildItem $env:TEMP -Directory -Filter 'aiboard-managed-release-authority-*'
owned_release_temp_count=0

docker ps -a --filter "label=ai-board.runner-v2.owned=true" --format "{{.ID}} {{.Names}}"
no output; owned container residue is zero
```

No cleanup action was needed. Rollback is the focused commit revert. The complete
two-file source/test diff was inspected: activation promises remain process-keyed for
serialization, but their results are now caller-authenticated before use; settled
activations retain the prior deterministic removal path. Task 8 remains untouched.
