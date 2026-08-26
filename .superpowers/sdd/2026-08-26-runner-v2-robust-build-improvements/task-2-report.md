# Task 2 / Phase P2 execution report

## Execution metadata

- Worktree: `C:\Users\b_a_s\source\repos\ai-discussion-board\.worktrees\runner-v2-robust-build`
- Branch: `codex/runner-v2-robust-build`
- P2 entry revision: `000f54e1`
- P2.1 implementation revision: `3dcb0cc1`
- P2.2 implementation revision: `97f52add`
- P2.3A implementation revision: packet commit (reported at handoff)
- Scope completed: P2.1, P2.2, and P2.3A only. P2.3B and later packets were not started.
- `progress.md` was read and not edited.

## Packet result

Added `runner-v2/src/final-verification-contracts.ts` and its focused test
module. The contract exposes the four canonical categories (`build`, `tests`,
`runtime_smoke`, and `browser`) and requires exactly one explicit
`required`/`not_applicable` status for each category. It mechanically rejects
omitted, duplicate, unknown, or unsupported entries; empty or missing
`not_applicable` rationale; missing or malformed supporting repository
inspection; and a `not_applicable` category with a detected repository or
preflight signal. The JSON schema exposes the same category/status contract.

The contract is deliberately plan-only: it does not execute commands, inspect
workspaces, create scheduler events, infer check success, or authorize
completion. Those responsibilities remain in later P2 packets and the kernel.

## TDD and prove-red evidence

### Pre-fix red

The new focused test was first run with the P2 entry source at `000f54e1`,
before the production module existed:

```text
npx tsx --test runner-v2/test/final-verification-contracts.test.ts
ERR_MODULE_NOT_FOUND: Cannot find module .../runner-v2/src/final-verification-contracts.js
```

This was the expected missing-contract failure.

### Green implementation

After the contract implementation and the inspection-signal regression fix,
the same focused test passed at implementation revision `3dcb0cc1`:

```text
npx tsx --test runner-v2/test/final-verification-contracts.test.ts
5 tests, 5 passed, 0 failed
```

### Fault-only red and restore

At revision `3dcb0cc1`, the exact completeness guard was temporarily fault-
removed by disabling the missing-category condition. The same named test went
red as expected:

```text
npx tsx --test runner-v2/test/final-verification-contracts.test.ts
5 tests, 4 passed, 1 failed
AssertionError: expected /missing.*browser/i, input was ""
```

Only that injected condition was restored. The detected-signal guard was then
temporarily fault-removed. The same named test again went red:

```text
npx tsx --test runner-v2/test/final-verification-contracts.test.ts
5 tests, 4 passed, 1 failed
AssertionError: true !== false
```

Only that injected condition was restored. The final focused test returned to
5/5 green; no test or production requirement was weakened.

## Validation evidence

```text
npx tsx --test runner-v2/test/final-verification-contracts.test.ts
5/5 passed

npm run test:runner-v2
399/399 Runner V2 tests passed; all chained client/policy/UI/
pause/model-usage/live-state/transcript/files/stats/observability checks passed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/final-verification-contracts.ts runner-v2/test/final-verification-contracts.test.ts
passed

git diff --cached --check
passed (only normal LF-to-CRLF warnings from Git)
```

## Requirement audit

| P2.1 requirement | Evidence | Result |
|---|---|---|
| Four categories are explicit | `FINAL_VERIFICATION_CATEGORIES` and exact-coverage test | Complete |
| Statuses are limited to `required`/`not_applicable` | runtime validator, schema, unsupported-status test | Complete |
| Omissions and duplicates reject | exact-coverage test and completeness fault proof | Complete |
| Unsupported categories reject | unknown-category test | Complete |
| `not_applicable` is justified | rationale/inspection test | Complete |
| Detected signals cannot be skipped | option and repository-inspection signal tests plus fault proof | Complete |
| Semantic completion remains outside the contract | pure plan validator; no execution/completion/scheduler changes | Complete |

## Packet status

Production/test commit: `3dcb0cc1 runner-v2: add final verification contracts`.

The report is the only remaining packet documentation change. P2.2+ remain
locked for the controller.

## P2.2 disposable verification workspace

Added `runner-v2/src/verification-workspace.ts` and focused tests in
`runner-v2/test/verification-workspace.test.ts`. The manager creates one
detached Git worktree below Runner state, pins it to the exact supplied
`IntegrationManager.revision`, and records run/path/repository/target and
canonical checkout revisions in ownership metadata. Git commands are passed as
argument arrays through the existing non-shell Git runner, so Windows paths,
spaces, punctuation, and long run IDs remain single arguments.

Creation and recovery mechanically validate state/worktree containment,
symlink/path escapes, exact Git worktree association, detached ownership,
target revision, clean verification state, and an unchanged clean canonical
checkout. Existing non-empty or partially recorded directories are refused;
valid metadata deterministically reopens the same workspace. Cleanup removes
only the exact owned verification worktree and metadata, prunes Git's stale
worktree record, and does not update or delete integration refs/history.

### P2.2 TDD and prove-red evidence

The focused tests were added before the production module and initially ran
red at the P2.1 head because the module was absent:

```text
npx tsx --test runner-v2/test/verification-workspace.test.ts
ERR_MODULE_NOT_FOUND: Cannot find module .../runner-v2/src/verification-workspace.js
```

After implementation and the small test-fixture correction, the focused suite
passed 5/5. The target-revision guard was then temporarily removed; the suite
went red 4 pass/1 fail with `Missing expected rejection` for the wrong-revision
case. The guard was restored and the suite returned to 5/5 green.

The state/workspace containment guards were temporarily removed together; the
suite went red 4 pass/1 fail because the path-inside-checkout case received a
canonical-mutation failure instead of the required containment rejection. Both
guards were restored and the suite returned to 5/5 green. No bypass or weaker
assertion remains in the packet.

### P2.2 validation evidence

```text
npx tsx --test runner-v2/test/verification-workspace.test.ts
5 tests, 5 passed, 0 failed

npx tsx --test runner-v2/test/verification-workspace.test.ts runner-v2/test/integration-manager.test.ts runner-v2/test/workspace-manager.test.ts
51 tests, 51 passed, 0 failed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/verification-workspace.ts runner-v2/test/verification-workspace.test.ts
passed

git diff --check
passed
```

### P2.2 requirement audit

| P2.2 requirement | Evidence | Result |
|---|---|---|
| Exact IntegrationManager revision is recorded and validated | Detached-worktree HEAD and metadata target revision assertions; wrong-revision recovery test and fault proof | Complete |
| Workspace is runner-owned and outside project checkout | State/workspace containment checks; path-with-spaces fixture; symlink/path-escape test | Complete |
| Git argv is exact and shell-free | Existing `runGit` argv runner; command-capture assertion for `worktree add --detach` | Complete |
| Windows paths/spaces and long IDs are safe | Fixture uses `user checkout`, `runner state & data`, punctuation, and an 80-character run ID | Complete |
| Dirty or mutated canonical checkout is refused | Canonical dirty test and before/after revision/status guard | Complete |
| Unexpected existing directories and symlinks are refused | Existing-directory, symlink, and ownership metadata checks | Complete |
| Valid workspace reopens deterministically | Reopen and fresh-manager create deep-equality assertions | Complete |
| Cleanup is scoped to owned verification state | Cleanup test preserves integration path/revision/history and canonical checkout | Complete |

P2.3B runtime_smoke/browser and submit-tool work, plus P2.4+ scheduler/completion
work, remain locked for the controller.

## P2.3A command verification runtime

Added `runner-v2/src/final-verification-runtime.ts` and focused coverage in
`runner-v2/test/final-verification-runtime.test.ts`. The runtime validates the
P2.1 plan at its boundary, reopens/creates the P2.2 workspace, rejects a stale
current integration revision, and runs only build/test commands as exact
executable-plus-argument arrays with a fixed disposable-workspace cwd and no
shell interpolation. Each command captures immutable stdout/stderr artifacts,
timestamps, target/start/end revisions, exit/signal, timeout, cancellation, and
durable EvidenceStore IDs. It never creates a ChangeSet or writes to the
canonical integration checkout; verification-generated files remain confined
to the disposable worktree.

### P2.3A TDD and prove-red evidence

The focused runtime test was added before the production module and initially
ran red at `97f52add`:

```text
npx tsx --test runner-v2/test/final-verification-runtime.test.ts
ERR_MODULE_NOT_FOUND: Cannot find module .../runner-v2/src/final-verification-runtime.js
```

After implementation and fixture-race corrections (canonical checkout line
ending normalization and cancellation waiting for the descendant marker), the
focused suite passed 4/4:

```text
npx tsx --test runner-v2/test/final-verification-runtime.test.ts
4 tests, 4 passed, 0 failed
```

Three fault-only injections were then performed independently. Removing the
non-zero exit guard produced 3 pass/1 fail (`true !== false` on the required
non-zero result). Removing the current-integration-revision guard produced
3 pass/1 fail (`Missing expected rejection` for the stale-revision case).
Removing the cancellation-state assignment produced 3 pass/1 fail (`false !==
true` for the cancellation fact). Each guard was restored immediately, and the
focused suite returned to 4/4 green after every restoration. The process-tree
case also proved that cancellation terminates the descendant and leaves no
late marker output.

### P2.3A validation evidence

```text
npx tsx --test runner-v2/test/final-verification-runtime.test.ts
4/4 passed

npm run typecheck (from runner-v2)
passed

npx eslint runner-v2/src/final-verification-runtime.ts runner-v2/test/final-verification-runtime.test.ts
passed with no warnings

npx tsx --test runner-v2/test/final-verification-runtime.test.ts runner-v2/test/process-tools.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/sqlite-evidence-store.test.ts runner-v2/test/verification-workspace.test.ts runner-v2/test/workspace-manager.test.ts runner-v2/test/integration-manager.test.ts
83/83 passed
```

The affected process/evidence/workspace regression set passed 83/83 tests
(including integration and workspace-manager coverage); no P2.3B or P2.4
surface was started in this packet.

### P2.3A requirement audit

| P2.3A requirement | Evidence | Result |
|---|---|---|
| Exact executable/argv command execution with fixed cwd and no shell | Success test uses shell metacharacter arguments and checks captured argv/cwd | Complete |
| Pinned target and stale revision rejection | Target/start/end revision assertions and stale integration test | Complete |
| Immutable stdout/stderr artifacts and EvidenceStore IDs | Artifact byte assertions and SQLite record/ID assertions | Complete |
| Non-zero, timeout, and cancellation are non-green | Failure test plus non-zero/timeout/cancellation fault proofs | Complete |
| Process-tree cancellation cleanup | Descendant PID/late-output test and cancellation fault proof | Complete |
| No ChangeSet or canonical checkout mutation | Explicit `changeSet` absence and integration revision/status assertions | Complete |

## Packet status

P2.3A is complete in the implementation commit recorded above. P2.3B
runtime_smoke/browser and submit-tool work remains intentionally deferred.
