# Task 7 review round 5 supplemental 2: release-marker atomicity

Date: 2026-08-29

Scope was limited to atomic publication of the durable managed-process backend
release marker and its deterministic regression. No other runtime, OCI, command
family, public contract, portability policy, Task 8, or Node-version behavior changed.

## Finding and transactional repair

The prior `releaseOwnership()` mutated the live `ManagedProcessRecord` with
`backendOwnershipReleasedAt` and a new `updatedAt` before calling the atomic disk
persist operation. A persist exception could therefore expose an uncommitted release
marker to same-service callers.

The repaired order is:

1. re-attest the exact processId/run/session/startedAt and terminal supervisor state;
2. construct a new candidate record containing the release timestamp;
3. atomically persist the candidate;
4. only after persistence succeeds, publish the candidate in `records`;
5. return the snapshot from the published candidate.

The preexisting record is never mutated. A failed persist leaves its marker and
`updatedAt` unchanged, and the retry must persist again. If persistence succeeds but
publication is interrupted, disk hydration on retry/restart observes the committed
marker and remains fail-closed.

## RED and GREEN proof

The deterministic test holds the already authenticated terminal record in memory,
injects failure only for the first release-marker persist, and suppresses incidental
disk rehydration so it directly audits the publication boundary.

Natural RED on the pre-fix implementation:

```text
npx tsx --test --test-name-pattern "backend ownership release is exact" runner-v2/test/managed-process.test.ts
tests 1; pass 0; fail 1
actual backendOwnershipReleasedAt: 2026-08-29T17:04:10.644Z
expected: undefined
```

GREEN after candidate-first persistence:

```text
npx tsx --test --test-name-pattern "backend ownership release is exact" runner-v2/test/managed-process.test.ts
tests 1; pass 1; fail 0; skipped 0; duration 0.81s
```

The test proves the first release rejects, both live memory and durable JSON retain no
marker, the live `updatedAt` is unchanged, retry performs marker persist call 2 and
succeeds, a further release is idempotent, and a new service instance rejects stale
backend control from the durable marker. Existing Windows adapter tests retain the
concurrent-release and retry coverage.

## Focused compatibility gate

```text
npx tsx --test runner-v2/test/windows-process-backend.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/process-backend-contract.test.ts
tests 48; pass 48; fail 0; skipped 0; duration 21.72s

npx tsx --test --test-name-pattern "control lane advances|durable release authority|stale clone|active output delivery|callback and reconcile errors" runner-v2/test/windows-process-backend.test.ts
tests 7; pass 7; fail 0; skipped 0
```

Historical managed-process compatibility is included in the 48-test gate and remains
green. The optional persisted field and historical parser contract did not change.

## Exact nine-file aggregate x5

Command run five consecutive times after the final production edit:

```text
node --import tsx --test runner-v2/test/one-shot-command-executor.test.ts runner-v2/test/one-shot-command-family-production-matrix.test.ts runner-v2/test/one-shot-command-routing-static.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/windows-process-backend.test.ts
```

```text
run 1: tests 129; pass 129; fail 0; skipped 0; 59.53s
run 2: tests 129; pass 129; fail 0; skipped 0; 60.26s
run 3: tests 129; pass 129; fail 0; skipped 0; 60.33s
run 4: tests 129; pass 129; fail 0; skipped 0; 59.89s
run 5: tests 129; pass 129; fail 0; skipped 0; 60.04s
```

Each run included the real Docker OCI fixtures, command-family production matrix,
managed-process lifecycle/restart tests, Windows Job adapter, portable backend, and
static routing guard.

## Static, cleanup, rollback, and self-review

```text
npm run typecheck:runner-v2
exit 0

npx eslint runner-v2/src/managed-process.ts runner-v2/test/managed-process.test.ts
exit 0

git diff --check
exit 0 (Git emitted only existing LF-to-CRLF notices)

Get-ChildItem $env:TEMP -Directory -Filter 'aiboard-managed-release-authority-*'
owned_release_temp_count=0

docker ps -a --filter "label=ai-board.runner-v2.owned=true" --format "{{.ID}} {{.Names}}"
no output; owned container residue is zero
```

No cleanup action was required. Rollback is the focused commit revert. The complete
two-file source/test diff was inspected: candidate creation is shallow because the
only changed values are top-level immutable scalar fields; no nested record data is
mutated. Persistence remains the existing temporary-file plus atomic-rename path.
There are no residual risks or Task 8 changes in this packet.
