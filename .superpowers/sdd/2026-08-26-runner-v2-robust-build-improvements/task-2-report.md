# Task 2 / Phase P2 execution report

## Execution metadata

- Worktree: `C:\Users\b_a_s\source\repos\ai-discussion-board\.worktrees\runner-v2-robust-build`
- Branch: `codex/runner-v2-robust-build`
- P2 entry revision: `000f54e1`
- P2.1 implementation revision: `3dcb0cc1`
- P2.2 implementation revision: `97f52add`
- P2.3A implementation revision: `b82a1a3a`
- P2.3B1a implementation revision: `8867112a`
- P2.3B1b implementation revision: `61ce8e6b`
- P2.3B2 implementation revision: `c2056116`
- P2.4A implementation revision: `16c2024f`
- P2.4B1a implementation revision: this packet commit (reported at handoff)
- Scope completed: P2.1, P2.2, P2.3A, P2.3B1a, P2.3B1b, P2.3B2, P2.4A, and P2.4B1a only. Final-verification execution/review, repair routing, P2.5, and P2.6 remain locked.
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

P2.4+ scheduler/completion/recovery work remains locked for the controller.

## P2.3B1a runtime-smoke verification

Extended `runner-v2/src/final-verification-runtime.ts` with a narrow
managed-process adapter over the existing Windows-supervised process service.
Required `runtime_smoke` checks now launch the exact executable/argument array
inside the pinned disposable workspace, require an explicit health/readiness
condition within a bounded deadline, capture endpoint/stdout/stderr/revision
facts and durable evidence, and stop the owned process tree in a `finally`
path. Optional port-release cleanup is also executed on success, failure,
timeout, and cancellation. A process that exits unhealthy, a timeout, or a
cancellation is mechanically non-green; readiness never grants semantic
completion authority.

### P2.3B1a TDD and prove-red evidence

The runtime-smoke test file was added against the existing command-only
runtime and initially ran red:

```text
npx tsx --test runner-v2/test/final-verification-runtime-b1.test.ts
4 tests, 0 passed, 4 failed
AssertionError: required runtime_smoke was unsupported / had no facts
```

After the managed-process/readiness implementation, the focused suite passed
4/4. Removing the readiness-success guard produced 3 pass/1 fail (the healthy
server result became non-green). Removing the owned-process cleanup guard
produced 1 pass/3 fail (the managed records remained `running` after success,
timeout, and cancellation). Each guard was restored and the focused suite
returned to 4/4 green.

The focused cases launch a small HTTP server from a path containing spaces,
wait for health, capture endpoint/stdout evidence, cover unhealthy exit,
deadline timeout, and cancellation, and assert the process tree is stopped and
the port is reusable.

### P2.3B1a validation evidence

```text
npx tsx --test runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/process-tools.test.ts runner-v2/test/managed-process.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/sqlite-evidence-store.test.ts runner-v2/test/verification-workspace.test.ts runner-v2/test/workspace-manager.test.ts
51/51 passed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/final-verification-runtime.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warning only)
```

### P2.3B1a requirement audit

| P2.3B1a requirement | Evidence | Result |
|---|---|---|
| Exact managed command in pinned workspace | Real ManagedProcessService adapter and path-with-spaces server test | Complete |
| Explicit readiness/health deadline | Health callback/HTTP endpoint and timeout test | Complete |
| Endpoint/stdout/stderr/revision evidence | Runtime-smoke command fact plus ArtifactStore/EvidenceStore assertions | Complete |
| Stop process tree and release port on every exit | Success, timeout, unhealthy exit, cancellation and port-reuse assertions | Complete |
| Non-green unhealthy/timeout/cancel outcomes | Focused result assertions and readiness guard fault proof | Complete |
| No canonical checkout mutation or ChangeSet | Shared P2.3A workspace/revision checks remain green; no ChangeSet surface added | Complete |

P2.4+ scheduler/completion/recovery work remains intentionally deferred.

## P2.3B1b browser verification

Extended `FinalVerificationRuntime` with an owned browser-session seam that
uses the existing browser backend/session API. Required browser checks now
capture the exact requested/observed URL, bounded DOM snapshot, screenshot, and
console/network event artifacts, all tied to the disposable workspace's
target revision and immutable start/end repository facts. Console errors, page
errors, failed response/request events, and unallowlisted policy violations
remain mechanical non-green outcomes. The browser session is closed from a
`finally` path after success, missing evidence, policy failure, navigation
failure, timeout, and cancellation; no ChangeSet or semantic completion
decision is introduced.

### P2.3B1b TDD and prove-red evidence

The focused browser test was added before the browser runtime implementation
and first ran red against the existing command/runtime surface:

```text
npx tsx --test runner-v2/test/final-verification-browser.test.ts
4 tests, 0 passed, 4 failed
TypeError: this.runBrowserCheck is not a function / browser category unsupported
```

After the browser session/fact implementation, the focused suite passed 4/4.
Three fault-only injections were then performed independently. Removing the
missing-screenshot guard produced 3 pass/1 fail with the expected missing-
screenshot assertion. Disabling browser policy evaluation produced 3 pass/1
fail because the policy case became green. Removing the `finally` close call
produced 0 pass/4 fail because every close counter remained zero. Each guard
was restored immediately and the focused suite returned to 4/4 green.

### P2.3B1b validation evidence

```text
npx tsx --test runner-v2/test/final-verification-browser.test.ts
4 tests, 4 passed, 0 failed

npx tsx --test runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts
8 tests, 8 passed, 0 failed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/final-verification-runtime.ts runner-v2/src/browser-tools.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/final-verification-browser.test.ts
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warning only)
```

### P2.3B1b requirement audit

| P2.3B1b requirement | Evidence | Result |
|---|---|---|
| Exact URL, DOM, screenshot, and event facts | Complete-facts test and three dedicated ArtifactStore hashes | Complete |
| Target-revision binding and no canonical mutation | Browser facts carry target/start/end revision; shared workspace guard remains green | Complete |
| Console/page/network policy enforcement | Unallowed console and failed-network test; explicit allow/fail policy and bounded allowlists | Complete |
| Missing required evidence is non-green | Missing screenshot test and evidence-count guard | Complete |
| Close owned session on every exit | Thrown/cancelled navigation test plus `finally` close fault proof | Complete |
| No ChangeSet or semantic completion authority | Runtime only records facts/check status; no ChangeSet or completion surface added | Complete |

## P2.3B2 final-verification submission

Added `runner-v2/src/final-verification-submission.ts` and focused coverage in
`runner-v2/test/final-verification-submission.test.ts`. The dedicated
`submit_final_verification` function and lifecycle-tool surface accept only an
exact P2.1 plan plus a P2.3 run carrying its immutable generation, task,
attempt, and target revision. Submission revalidates all four categories,
preserves justified `not_applicable` rationale and inspection, rereads the
current integration revision, and resolves every cited ID from the current
task/attempt's EvidenceStore records. It compares each supplied fact with the
authoritative record and mechanically rejects stale/foreign/fabricated or
artifact-only citations, non-green outcomes, timeouts, cancellations, policy
violations, and missing command/runtime/browser evidence. The frozen output is
an audit structure only: it creates no ChangeSet and makes no completion
decision.

### P2.3B2 TDD and prove-red evidence

The focused submission tests were added before the production module and first
ran red:

```text
npx tsx --test runner-v2/test/final-verification-submission.test.ts
ERR_MODULE_NOT_FOUND: Cannot find module .../runner-v2/src/final-verification-submission.js
```

After implementation, the focused suite passed 6/6. Three fault-only
injections were then performed and reverted independently:

- Removing the exact run-category completeness/missing-category guards made
  the omitted-run case red: 5 passed, 1 failed (`Missing expected rejection`).
- Removing the current-integration revision comparison made the stale-target
  case red: 0 passed, 1 failed (`Missing expected rejection`).
- Removing authoritative record/fact equality made the fabricated-fact case
  red: 0 passed, 1 failed (`Missing expected rejection`).

Each guard was restored immediately; the final focused suite returned to 6/6
green.

### P2.3B2 validation evidence

```text
npx tsx --test runner-v2/test/final-verification-submission.test.ts
6 tests, 6 passed, 0 failed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/final-verification-submission.ts runner-v2/src/final-verification-runtime.ts runner-v2/test/final-verification-submission.test.ts
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warning only)
```

### P2.3B2 requirement audit

| P2.3B2 requirement | Evidence | Result |
|---|---|---|
| One exact generation/task/attempt and target revision | Required run identity, attempt, plan, generation-prefixed EvidenceStore IDs, and current-revision reread | Complete |
| Exact four-category plan/result coverage | P2.1 plan validation, run duplicate/unknown/omission guards, focused cases | Complete |
| Required results and evidence are mechanically green/current | Fact-to-record equality, ownership/attempt/revision checks, non-green/timeout/cancel/policy/missing-evidence guards | Complete |
| Browser/runtime/command evidence is complete | Category-specific command/readiness and browser snapshot/screenshot/events validation | Complete |
| Justified not-applicable entries remain represented | Plan/result projection and rationale/inspection preservation test | Complete |
| Immutable audit output with no semantic completion or ChangeSet | Deep-frozen submission type and dedicated read-only lifecycle tool | Complete |

P2.4+ scheduler/completion/recovery work remains intentionally deferred.

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
(including integration and workspace-manager coverage); no P2.4 surface was
started in this packet.

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

P2.3A, P2.3B1a, P2.3B1b, and P2.3B2 are complete in the implementation commits
recorded above. P2.4A is complete in the implementation commit reported below;
P2.4B/P2.5/P2.6 remain intentionally deferred.

## P2.4A durable verification-generation scheduler contracts

Extended the append-only scheduler projection with a kernel-owned
`final_verification` task kind and explicit generation, target-revision, plan
version, submission, and review references. A generation is accepted only for
the current canonical integration revision and is represented once as the
current generation. Repeating the same generation is idempotent, while a
conflicting current generation, stale target, invalidated generation, or
foreign submission/review reference is rejected. Advancing the integration
revision moves the current generation, including its durable submission and
review references, into immutable invalidated history and clears the current
slot. Replay and SQLite reopen preserve the same projection. Final-verification
tasks are excluded from ordinary worker readiness/dispatch, cannot be revised
as implementation work, and cannot carry a ChangeSet. No automatic execution,
repair-task creation, or completion gate was added.

### P2.4A TDD and prove-red evidence

The focused scheduler test was added before the scheduler event/reducer
implementation and first ran red against the P2.3B2 head:

```text
npx tsx --test runner-v2/test/final-verification-scheduler.test.ts
4 tests, 0 passed, 4 failed
AssertionError: final task absent; duplicate generation was not idempotent;
current final-verification projection and integration revision were absent
```

After the scheduler projection, SQLite idempotency, task-graph, and dispatch
guards were implemented, the same focused suite passed 4/4. Three independent
fault-only injections were then performed and restored:

- Removing the current-generation singleton guard (and its duplicate-task
  fallback) made the conflicting-generation assertion red: 0 passed, 1
  failed with `Final verification task has mechanical issues: duplicate_task_id`.
- Removing target/history reactivation guards made the stale replay assertion
  red: 0 passed, 1 failed because the stale generation reached duplicate-task
  validation instead of being rejected as stale/history-bound.
- Removing integration invalidation made the revision-advance assertion red:
  0 passed, 1 failed because the old current generation remained current rather
  than moving to history.

Only the injected guards were restored after each proof; the final focused
suite returned to 4/4 green.

### P2.4A validation evidence

```text
npx tsx --test runner-v2/test/final-verification-scheduler.test.ts
4/4 passed

npx tsx --test runner-v2/test/final-verification-scheduler.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/task-scheduler.test.ts
29/29 passed

npx tsx --test runner-v2/test/*.test.ts
426/426 passed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/scheduler-store.ts runner-v2/src/sqlite-scheduler-store.ts runner-v2/src/task-contracts.ts runner-v2/src/task-graph.ts runner-v2/src/task-scheduler.ts runner-v2/test/final-verification-scheduler.test.ts
passed

git diff --check
passed (normal Git LF-to-CRLF warnings only)
```

### P2.4A requirement audit

| P2.4A requirement | Evidence | Result |
|---|---|---|
| Distinct kernel-owned final-verification task kind | `BuildTask.kind`, `FinalVerificationTask`, graph validation, and focused task projection test | Complete |
| Immutable generation identity, target revision, and plan version | Generation reducer, final-task revision/reconciliation rejection, and exact projection assertions | Complete |
| Exactly one current generation per integration revision | Current-slot reducer guard, SQLite semantic idempotency, and conflict test | Complete |
| Submission/review bind to current generation | Durable reference types and stale/foreign binding assertions | Complete |
| Integration revision invalidates current verification and preserves history | Revision event reducer, history shape assertion, and invalidation fault proof | Complete |
| Stale events cannot reactivate prior generation | Target/history guards and stale replay assertion/fault proof | Complete |
| Replay/restart determinism | SQLite close/reopen deep-equality assertion | Complete |
| No ordinary scheduling or ChangeSet masquerade | `readyTaskIds`, `TaskScheduler`, transition/graph guards, and no-driver-call test | Complete |
| P2.4B/P2.5 work remains out of scope | No auto-run, repair, or completion changes in diff | Complete |

## Packet status

P2.4A implementation/test commit is recorded in the execution metadata above
after the final clean-state verification. P2.4B, P2.5, and P2.6 remain
intentionally deferred for the controller.

## P2.4B1a Architect final-verification orchestration

Added the Architect planning/orchestration boundary for the current canonical
integration revision. Once every ordinary implementation task is integrated or
cancelled and the projection has an `integrationRevision`, `BuildRuntime`
requests the typed `final_verification_plan_required` Architect action instead
of offering completion. Only that reason exposes the lifecycle
`plan_final_verification` tool. The tool validates and canonicalizes the exact
P2.1 four-category plan, rechecks terminal implementation state and the current
revision, and appends the existing P2.4A runner-owned generation event.

Generation and task identities are deterministic revision hashes. The
revision-scoped idempotency key and P2.4A reducer make reordered but semantically
identical plans one durable generation while rejecting a conflicting plan for
the same current revision. Architect context now includes both the canonical
integration revision and explicit final-verification state, and the native
Architect prompt directs the model to inspect the repository and use the typed
tool. The new lifecycle action is represented in both agent protocol unions.

The orchestration boundary verifies that the expected current generation was
actually created; a model no-op, prose, or unrelated scheduler activity cannot
advance this action. The P2.4A final task remains `planned` and excluded from
ordinary worker scheduling. This packet does not execute
`FinalVerificationRuntime`, submit or review results, create repair tasks, or
change `complete_run` mechanics.

### P2.4B1a TDD and prove-red evidence

The adopted focused test seed was run before production changes at clean HEAD
`16c2024f` and failed 0/4 as expected:

```text
npx tsx --test runner-v2/test/final-verification-orchestration.test.ts
4 tests, 0 passed, 4 failed
completion_decision_required !== final_verification_plan_required
Tool plan_final_verification is not registered.
```

After minimal implementation and one context-state assertion, the focused file
passed 5/5. Three independent fault-only injections were then made and restored:

- Disabling the current-generation conflict reducer and making plan
  idempotency plan-specific caused the singleton/conflict test to fail with
  `false !== true` because a conflicting plan was accepted.
- Disabling both the generic Architect no-action sequence check and the
  final-verification-specific generation check caused the prose/no-op test to
  fail with `Missing expected rejection`.
- Removing final-verification filtering from `readyTaskIds` caused the worker
  exclusion test to fail when the scheduler attempted the forbidden kernel-task
  transition.

Only each injected fault was restored. Every same named test returned green,
and the final focused file passed 5/5.

### P2.4B1a validation evidence

```text
npx tsx --test runner-v2/test/final-verification-orchestration.test.ts runner-v2/test/final-verification-scheduler.test.ts runner-v2/test/build-runtime.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/task-scheduler.test.ts runner-v2/test/scheduler-store.test.ts
57 tests, 57 passed, 0 failed

npm run typecheck:runner-v2
passed

npx eslint runner-v2/src/agent-contracts.ts runner-v2/src/agent-loop.ts runner-v2/src/agent-prompts.ts runner-v2/src/architect-tools.ts runner-v2/src/build-runtime.ts runner-v2/src/native-architect-runtime.ts runner-v2/test/build-runtime.test.ts runner-v2/test/final-verification-orchestration.test.ts
passed with no warnings

npm run test:runner-v2
431 tests, 431 passed, 0 failed
all chained client, policy, UI, live-state, transcript, files, stats, and observability checks passed

git diff --check
passed (normal Git LF-to-CRLF warnings only)
```

The first broad Runner invocation produced one unchanged P2.3B1a managed-
process timing failure (`exited_unknown` versus `stopped`) after 430/431 tests.
The exact failed test then passed 1/1, its full file passed 4/4, and the complete
Runner/client gate was rerun from scratch and passed 431/431 plus every chained
script. No P2.3 code or test was changed.

### P2.4B1a requirement audit

| P2.4B1a requirement | Evidence | Result |
|---|---|---|
| Terminal ordinary work routes to typed planning | Build-runtime reason/tool test and restart integration test | Complete |
| Canonical integration revision is the target | Reason, tool recheck, deterministic payload, projection and context assertions | Complete |
| Exact P2.1 four-category plan validation | P2.1 validator/schema reuse and focused tool invocation | Complete |
| Exactly one P2.4A generation/task | Semantic reorder replay, one-event/one-task assertions, conflict fault proof | Complete |
| Prose/no-op cannot advance verification | Specific generation postcondition plus generic lifecycle sequence guard and fault proof | Complete |
| Same semantic call is idempotent; conflicts reject | Canonical category ordering, revision idempotency key, P2.4A reducer, focused conflict test | Complete |
| Final task stays out of ordinary workers | Scheduler no-driver-call assertion and `readyTaskIds` fault proof | Complete |
| Architect prompt/context exposes the planning state | Canonical revision, explicit generation state, and typed-tool prompt wiring | Complete |
| Later P2 work remains out of scope | No runtime execution, submission/review, repair, or completion-gate changes | Complete |

## Packet status

P2.4B1a implementation/test/report commit is recorded in the execution metadata
after the final clean-state verification. Final-verification execution/review,
repair routing, P2.5, and P2.6 remain intentionally deferred.

## P2.4B2a kernel execution and durable resume

Added the kernel-owned execution path for a current P2.4A generation. The
Build runtime now selects the first uncompleted category from the exact P2.1
plan, invokes a dedicated `FinalVerificationCheckDriver`, and checkpoints the
mechanical result before another category may start. Native construction wires
that driver to `FinalVerificationRuntime.runCategory` with the scheduler's
generation identity, final-verification task, attempt, canonical integration
revision, durable evidence store, managed-process service, browser backend, and
owned verification workspace. The final task never enters a worker runtime.

Each durable check event binds generation, task, revision, attempt, workspace,
timestamps, planned category metadata, facts, evidence IDs, and issues. Replay
rejects conflicts while exact event idempotency and category projection prevent
duplicate work. A reopened scheduler and fresh Build runtime reuse completed
facts and execute only pending categories. A factual non-green result (including
runtime timeout/cancellation facts) is retained and stops the generation.

After all four categories are durably green, Build runtime reconstructs the
exact P2.3 run, calls `submitFinalVerification`, and appends one validated
submission result/reference. Further pumps expose an awaiting-review state and
cannot duplicate checks or submission. The completed-check and submission
projection is automatically available in Architect context through the existing
final-verification projection. No Architect review, repair-task routing,
`complete_run` gate, or cleanup-policy work was added.

Revision currency is checked by the verification workspace/runtime, after each
driver call, inside P2.3 submission validation, and immediately before durable
submission append. Integration advancement invalidates the current generation;
the Build runtime discards the returned stale result and appends neither a check
nor a submission.

### P2.4B2a TDD and fault evidence

The focused execution suite was added first and failed 0/3 at HEAD `59207ac4`:

```text
npx tsx --test runner-v2/test/final-verification-execution.test.ts
3 tests, 0 passed, 3 failed
actual: { status: "idle", action: "no_mechanical_progress" }
expected actions: final_verification_check_completed,
final_verification_check_non_green, final_verification_invalidated
```

After the minimal runtime/store/factory implementation the suite passed 3/3.
Two independent fault-only injections were then made and restored:

- Replacing pending-category selection with the first planned category made the
  restart test fail 0/1: calls were `[build, build, build, build]` instead of
  `[build, tests, runtime_smoke, browser]`. This proves durable completed-check
  reuse/deduplication controls execution after restart.
- Removing the post-driver current-revision/generation guard made the stale
  revision test fail 0/1 with `Final verification event does not reference a
  current generation.` The restored guard stops before stale checkpoint or
  submission persistence.

The existing P2.4A/B1a worker-exclusion fault proof remains applicable to this
packet's driver boundary; the execution fixture additionally asserts zero
worker calls through interruption, restart, all four checks, submission, and a
repeated pump. The restored focused suite passed 3/3.

### P2.4B2a validation evidence

```text
npx tsx --test runner-v2/test/final-verification-execution.test.ts
3/3 passed

npx tsx --test runner-v2/test/final-verification-runtime.test.ts
5/5 passed (includes scheduler-selected single-category execution)

npx tsx --test runner-v2/test/final-verification-execution.test.ts runner-v2/test/final-verification-runtime.test.ts runner-v2/test/final-verification-submission.test.ts runner-v2/test/final-verification-orchestration.test.ts runner-v2/test/scheduler-store.test.ts
40/40 passed

npx tsx --test runner-v2/test/build-runtime.test.ts runner-v2/test/build-runtime-b1.test.ts runner-v2/test/native-build-manager.test.ts runner-v2/test/recovery.test.ts runner-v2/test/final-verification-runtime-b1.test.ts runner-v2/test/final-verification-browser.test.ts
53/53 passed

npm run test:runner-v2
435/435 Runner tests passed; every chained client, policy, UI, live-state,
transcript, files, stats, and observability check passed

npx tsc --noEmit -p runner-v2/tsconfig.json
passed

npx eslint runner-v2/src/build-runtime.ts runner-v2/src/final-verification-runtime.ts runner-v2/src/native-build-factory.ts runner-v2/src/scheduler-store.ts runner-v2/test/final-verification-execution.test.ts runner-v2/test/final-verification-runtime.test.ts
passed with no warnings

git diff --check
passed (normal Git LF-to-CRLF warnings only)
```

### P2.4B2a requirement audit

| P2.4B2a requirement | Evidence | Result |
|---|---|---|
| Execute current planned generation through FinalVerificationRuntime | Native factory driver plus direct `runCategory` test | Complete |
| Never route verification through a worker | Dedicated Build-runtime boundary and zero-worker-call execution/restart assertion | Complete |
| Persist each check before the next starts | One-step-per-check events and interruption/reopen fixture | Complete |
| Resume only pending categories | SQLite reopen assertion and completed-check fault proof | Complete |
| Persist non-green facts and stop | Focused non-green test and runtime timeout/cancel affected suites | Complete |
| Append exactly one validated P2.3 submission | Four-check execution, durable result/reference, repeated-pump assertion | Complete |
| Prevent duplicate evidence/check/submission | Generation/category idempotency, projection reuse, submission singleton | Complete |
| Invalidate on integration advancement | During-check revision test and restored stale guard fault proof | Complete |
| Expose execution/submission to Architect | Existing context includes cloned current generation projection | Complete |
| Later semantic lifecycle work remains out of scope | No review, repair, completion-gate, or cleanup changes | Complete |

## Packet status

P2.4B2a implementation, tests, and report are complete. Architect review,
repair-task creation, the completion gate, and P2.6 cleanup remain deferred.
